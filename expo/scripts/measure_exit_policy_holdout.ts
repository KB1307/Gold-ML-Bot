/**
 * EXIT-POLICY SWEEP WITH CHRONOLOGICAL HOLDOUT (read-only, anon key, no writes).
 *
 * WHY THIS AND NOT ANOTHER LOCK SWEEP. Item 202/203 already measured lock
 * 0.35 / 0.50 / 0.70 and TRAIL_TO_TP2 (paired, n=422): all null (CIs include
 * zero). Item 204's continuation replay then showed that after the +0.35R lock
 * exits a trade, 57.6% go on to TP3 and 11.9% to TP2, while only 29.8% reverse
 * to the ORIGINAL stop. That counterfactual was never measured as a complete
 * paired POLICY with a holdout. The live resolver natively supports it
 * (breakevenPolicy=false = hold with the original SL to TP3; LadderOverride can
 * move the post-TP1 lock to entry or BELOW entry), so every arm here is a
 * configuration the product can already run — no new exit code is proposed.
 *
 * INSTRUMENT: the REAL resolveSignalWithBars (fromScratch, 8h window, bars from
 * emitted_at + 60s — identical to item249) + lib/evCompute computeRNet. The
 * LIVE arm is the STORED trade_outcomes_v1.realized_r (what the book actually
 * booked); a harness check prints agreement between the stored R and a BE-ON
 * replay so any resolver/tape drift is visible before the arms are read.
 *
 * ARMS (pre-registered; five, no more, to limit multiple-comparison risk):
 *   LIVE          stored realized_r (reference)
 *   HOLD_TP3      breakevenPolicy=false — original SL all the way, exit TP3 or SL
 *   HOLD_TP2      as HOLD_TP3 but the terminal target is TP2 (tp3 := tp2)
 *   LOCK_ENTRY    BE on, post-TP1 lock at entry exactly (0R, no floor), post-TP2 stop as live
 *   LOCK_MINUS_05 BE on, post-TP1 "lock" at entry − 0.5R (half the risk off), post-TP2 stop as live
 *
 * SPLIT: chronological. TRAIN = first 60% of decided signals, HOLDOUT = last
 * 40%. The best arm is chosen on TRAIN ONLY (highest mean paired ΔR_net vs
 * LIVE). The holdout is read ONCE for that arm.
 *
 * SHIP GATE (pre-registered, all three must hold for the TRAIN-chosen arm):
 *   G1  TRAIN  mean ΔR_net > 0
 *   G2  HOLDOUT mean ΔR_net > 0 (same sign — direction reproduces)
 *   G3  FULL-SAMPLE paired bootstrap 95% CI lower bound of ΔR_net > 0
 * Any failure → NOTHING SHIPS; numbers are reported and that is the result.
 * MDE (80% power) is printed BEFORE every point estimate (mindset rule 7).
 *
 * $/day translation uses each trade's own risk (|entry−sl|, 1 oz = $1/$1).
 *
 * Run: cd expo && nohup bun scripts/measure_exit_policy_holdout.ts > artifacts/exit_policy_holdout_run.txt 2>&1 &
 */
import { resolveSignalWithBars, type LadderOverride } from "../services/signalResolver";
import { computeRNet } from "../lib/evCompute";
import type { TradingSignal, SignalStatus } from "../types/trading";
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number }
interface Out { signal_id: string; realized_r: number | null }

const WINDOW_MS = 8 * 3600_000;
const BARS_CACHE = "/tmp/gold_m1_cache_exit_policy.json";

const lb = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const sd = (v: number[]) => { const m = mean(v); return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, v.length - 1)); };
function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }
function bootCI(d: number[], seed = 20261026, B = 20000): [number, number] {
  const rnd = mulberry32(seed); const ms: number[] = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[(rnd() * d.length) | 0]; ms.push(s / d.length); }
  ms.sort((a, b) => a - b); return [ms[Math.floor(B * 0.025)], ms[Math.floor(B * 0.975)]];
}

type ArmName = "HOLD_TP3" | "HOLD_TP2" | "LOCK_ENTRY" | "LOCK_MINUS_05";
const ARMS: { name: ArmName; policy: boolean; tp3FromTp2: boolean; ladder?: LadderOverride }[] = [
  { name: "HOLD_TP3", policy: false, tp3FromTp2: false },
  { name: "HOLD_TP2", policy: false, tp3FromTp2: true },
  { name: "LOCK_ENTRY", policy: true, tp3FromTp2: false, ladder: { lockFractionOfR: 0, applyLockFloor: false } },
  { name: "LOCK_MINUS_05", policy: true, tp3FromTp2: false, ladder: { lockFractionOfR: -0.5, applyLockFloor: false, applyLockCap: false } },
];

interface Res { id: string; ems: number; risk: number; live: number; arms: Partial<Record<ArmName, number>>; beOnReplay: number | null; liveStatusReplay: string }

async function main() {
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!);
  const rows: Row[] = []; const outs: Out[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from("emitted_signals_v1").select("signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence").order("emitted_at", { ascending: true }).range(o, o + 999);
    if (error) throw error; rows.push(...((data ?? []) as Row[])); if ((data?.length ?? 0) < 1000) break;
  }
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from("trade_outcomes_v1").select("signal_id,realized_r").range(o, o + 999);
    if (error) throw error; outs.push(...((data ?? []) as Out[])); if ((data?.length ?? 0) < 1000) break;
  }
  const rById = new Map(outs.map((o) => [o.signal_id, o.realized_r]));
  const decided = rows.filter((r) => { const x = rById.get(r.signal_id); return typeof x === "number" && Number.isFinite(x); });
  console.log(`emitted=${rows.length} outcomes=${outs.length} decided=${decided.length}`);

  // bars (cached outside the repo)
  let bars: Bar[];
  const minEms = Date.parse(decided[0].emitted_at) - 60_000;
  const maxEnd = Date.parse(decided[decided.length - 1].emitted_at) + WINDOW_MS;
  if (existsSync(BARS_CACHE)) { bars = JSON.parse(readFileSync(BARS_CACHE, "utf-8")); console.log(`bars from cache: ${bars.length}`); }
  else {
    bars = [];
    for (let o = 0; ; o += 1000) {
      const { data, error } = await client.from("gold_m1_bars").select("timestamp,open,high,low,close").gte("timestamp", new Date(minEms).toISOString()).lte("timestamp", new Date(maxEnd).toISOString()).order("timestamp", { ascending: true }).range(o, o + 999);
      if (error) throw error;
      for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[]) bars.push({ timestamp: Date.parse(r.timestamp), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
      if ((data?.length ?? 0) < 1000) break;
      if (o % 20000 === 0) console.log(`  bars fetched: ${bars.length}`);
    }
    writeFileSync(BARS_CACHE, JSON.stringify(bars));
    console.log(`bars fetched: ${bars.length} (${new Date(bars[0].timestamp).toISOString()} → ${new Date(bars[bars.length - 1].timestamp).toISOString()})`);
  }
  const barsEnd = bars[bars.length - 1].timestamp;

  const realLog = console.log; console.log = () => {};
  const results: Res[] = []; let undecidedArms = 0; let lowCoverage = 0;
  for (const s of decided) {
    const ems = Date.parse(s.emitted_at);
    const dir = (s.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
    const windowEnd = Math.min(ems + WINDOW_MS, barsEnd);
    const wb = bars.slice(lb(bars, ems - 60_000), lb(bars, windowEnd));
    const cov = wb.filter((b) => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
    if (cov < 100 || wb.length === 0) { lowCoverage++; continue; }
    const risk = Math.abs(+s.entry - +s.sl);
    const mk = (policy: boolean, tp3FromTp2: boolean): TradingSignal => ({
      id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: dir, entryPrice: +s.entry, entryPriceWithSlippage: +s.entry,
      tp1: +s.tp1, tp2: +s.tp2, tp3: tp3FromTp2 ? +s.tp2 : +s.tp3, sl: +s.sl, confidence: +s.confidence,
      status: "ACTIVE" as SignalStatus, targetsHit: 0, breakevenReached: false, breakevenPolicy: policy,
    } as unknown as TradingSignal);
    const be = resolveSignalWithBars(mk(true, false), wb, { fromScratch: true, evalNowMs: windowEnd });
    const res: Res = { id: s.signal_id, ems, risk, live: rById.get(s.signal_id)!, arms: {}, beOnReplay: be.outcomeResult !== null ? computeRNet(dir, +s.entry, be.exitPrice, risk) : null, liveStatusReplay: be.newStatus };
    let allDecided = true;
    for (const a of ARMS) {
      const r = resolveSignalWithBars(mk(a.policy, a.tp3FromTp2), wb, { fromScratch: true, evalNowMs: windowEnd, ladder: a.ladder });
      if (r.outcomeResult === null) { allDecided = false; break; }
      res.arms[a.name] = computeRNet(dir, +s.entry, r.exitPrice, risk);
    }
    if (!allDecided) { undecidedArms++; continue; }
    results.push(res);
  }
  console.log = realLog;
  console.log(`paired population (all arms decided): n=${results.length}  excluded: low coverage ${lowCoverage}, undecided-in-some-arm ${undecidedArms}`);

  // harness check
  const hc = results.filter((r) => r.beOnReplay !== null);
  const agree = hc.filter((r) => Math.abs(r.beOnReplay! - r.live) < 0.02).length;
  const sameSign = hc.filter((r) => Math.sign(r.beOnReplay!) === Math.sign(r.live)).length;
  console.log(`HARNESS: BE-ON replay vs stored realized_r — exact (±0.02R) ${agree}/${hc.length} (${(100 * agree / hc.length).toFixed(1)}%), same sign ${sameSign}/${hc.length} (${(100 * sameSign / hc.length).toFixed(1)}%); mean stored ${mean(hc.map((r) => r.live)).toFixed(4)}R vs replay ${mean(hc.map((r) => r.beOnReplay!)).toFixed(4)}R`);
  console.log(`  (disagreements = tape/resolver drift since booking, e.g. tick-path exits, Item 1 same-bar fix, P-1 corrections; the ARMS below are all replayed on the same tape so paired deltas vs the BE-ON replay are also printed)`);

  const nTrain = Math.floor(results.length * 0.6);
  const train = results.slice(0, nTrain), hold = results.slice(nTrain);
  console.log(`\nSPLIT: TRAIN n=${train.length} (${new Date(train[0].ems).toISOString().slice(0, 10)} → ${new Date(train[train.length - 1].ems).toISOString().slice(0, 10)})  HOLDOUT n=${hold.length} (${new Date(hold[0].ems).toISOString().slice(0, 10)} → ${new Date(hold[hold.length - 1].ems).toISOString().slice(0, 10)})`);

  const book = (set: Res[], pick: (r: Res) => number) => {
    const v = set.map(pick); const usd = set.map((r) => pick(r) * r.risk);
    const days = new Set(set.map((r) => new Date(r.ems).toISOString().slice(0, 10))).size;
    return `n=${v.length} WR=${(100 * v.filter((x) => x > 0).length / v.length).toFixed(1)}% EV=${mean(v).toFixed(4)}R  $${mean(usd).toFixed(2)}/trade  $${(usd.reduce((a, b) => a + b, 0) / days).toFixed(2)}/day over ${days}d`;
  };
  const delta = (set: Res[], a: ArmName, ref: (r: Res) => number) => set.map((r) => r.arms[a]! - ref(r));
  const mde = (d: number[]) => 2.8 * sd(d) / Math.sqrt(d.length);

  console.log(`\nTRAIN BOOKS:`);
  console.log(`  LIVE (stored)   ${book(train, (r) => r.live)}`);
  for (const a of ARMS) console.log(`  ${a.name.padEnd(15)} ${book(train, (r) => r.arms[a.name]!)}`);
  console.log(`\nTRAIN PAIRED Δ vs LIVE (MDE first):`);
  let best: ArmName | null = null; let bestD = -Infinity;
  for (const a of ARMS) {
    const d = delta(train, a.name, (r) => r.live); const m = mean(d);
    const dr = delta(train, a.name, (r) => r.beOnReplay ?? r.live);
    console.log(`  ${a.name.padEnd(15)} MDE ±${mde(d).toFixed(4)}R  ΔEV=${m >= 0 ? "+" : ""}${m.toFixed(4)}R  improved ${d.filter((x) => x > 0.01).length} degraded ${d.filter((x) => x < -0.01).length} unchanged ${d.filter((x) => Math.abs(x) <= 0.01).length}   | vs BE-ON replay Δ=${mean(dr) >= 0 ? "+" : ""}${mean(dr).toFixed(4)}R`);
    if (m > bestD) { bestD = m; best = a.name; }
  }
  console.log(`\nTRAIN-CHOSEN ARM: ${best}  (G1 ${bestD > 0 ? "PASS" : "FAIL"}: train ΔEV ${bestD >= 0 ? "+" : ""}${bestD.toFixed(4)}R)`);

  const dh = delta(hold, best!, (r) => r.live); const mh = mean(dh);
  console.log(`\nHOLDOUT (read once, chosen arm only):`);
  console.log(`  LIVE (stored)   ${book(hold, (r) => r.live)}`);
  console.log(`  ${best!.padEnd(15)} ${book(hold, (r) => r.arms[best!]!)}`);
  console.log(`  MDE ±${mde(dh).toFixed(4)}R  ΔEV=${mh >= 0 ? "+" : ""}${mh.toFixed(4)}R  → G2 ${mh > 0 ? "PASS" : "FAIL"}`);

  const df = delta(results, best!, (r) => r.live); const [lo, hi] = bootCI(df);
  console.log(`\nFULL SAMPLE paired bootstrap (n=${df.length}, 20k, seed 20261026): ΔEV=${mean(df) >= 0 ? "+" : ""}${mean(df).toFixed(4)}R  95% CI [${lo.toFixed(4)}, ${hi.toFixed(4)}]  → G3 ${lo > 0 ? "PASS" : "FAIL"}`);
  console.log(`  LIVE full       ${book(results, (r) => r.live)}`);
  console.log(`  ${best!.padEnd(15)} ${book(results, (r) => r.arms[best!]!)}`);
  const dUsd = results.map((r) => (r.arms[best!]! - r.live) * r.risk);
  const daysAll = new Set(results.map((r) => new Date(r.ems).toISOString().slice(0, 10))).size;
  const streak = (v: number[]) => { let s = 0, mx = 0; for (const x of v) { s = x < 0 ? s + 1 : 0; mx = Math.max(mx, s); } return mx; };
  const maxDD = (v: number[]) => { let p = 0, c = 0, dd = 0; for (const x of v) { c += x; p = Math.max(p, c); dd = Math.max(dd, p - c); } return dd; };
  console.log(`  Δ$ = ${dUsd.reduce((a, b) => a + b, 0) >= 0 ? "+" : ""}$${(dUsd.reduce((a, b) => a + b, 0) / daysAll).toFixed(2)}/day over ${daysAll} trading days`);
  console.log(`  RISK SHAPE: LIVE loss streak ${streak(results.map((r) => r.live))} / maxDD ${maxDD(results.map((r) => r.live)).toFixed(2)}R   ${best}: loss streak ${streak(results.map((r) => r.arms[best!]!))} / maxDD ${maxDD(results.map((r) => r.arms[best!]!)).toFixed(2)}R`);
  console.log(`\nALL-ARM FULL-SAMPLE BOOKS (context only — not used for selection):`);
  for (const a of ARMS) { const d = delta(results, a.name, (r) => r.live); const [l, h] = bootCI(d); console.log(`  ${a.name.padEnd(15)} ${book(results, (r) => r.arms[a.name]!)}  Δ=${mean(d) >= 0 ? "+" : ""}${mean(d).toFixed(4)}R CI [${l.toFixed(4)}, ${h.toFixed(4)}]`); }

  const ship = bestD > 0 && mh > 0 && lo > 0;
  console.log(`\nSHIP GATE for ${best}: G1 ${bestD > 0 ? "PASS" : "FAIL"} · G2 ${mh > 0 ? "PASS" : "FAIL"} · G3 ${lo > 0 ? "PASS" : "FAIL"}  →  ${ship ? "SHIP" : "DO NOT SHIP"}`);
}

main().catch((e) => { console.error("FAILED", e instanceof Error ? e.stack : e); process.exit(1); });
