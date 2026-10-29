/**
 * EDGE-DECAY DIAGNOSIS (read-only, anon key, no writes).
 *
 * The exit-policy holdout showed the SAME rules earned $3.63/day on
 * 2026-06-29→07-29 and $0.57/day on 07-29→09-25. This script asks WHAT changed,
 * in a form where each candidate cause is measured rather than assumed:
 *
 *   A. Is either period's EV distinguishable from zero? (bootstrap CIs — if the
 *      early edge's CI includes zero, "decay" may be noise, not a cause.)
 *   B. Decompose EV = WR·avgWin − (1−WR)·avgLoss per period: which term moved.
 *   C. Outcome-label mix per period (resolver replay on the same tape so labels
 *      are comparable: ALL_TARGETS_HIT / TP2 partial / SL_AFTER_BE / SL_HIT …).
 *   D. Composition: direction, UTC session, risk$ bucket, trades/day.
 *   E. Market regime from gold_m1_bars: daily range, M5 ATR, net drift, and
 *      WR of BUY/SELL conditioned on the day's drift sign (did the book fight the tape?).
 *   F. Weekly EV series with a two-sample split at every week (max-|t| change
 *      point) so the break date is estimated, not eyeballed.
 *   G. Engine churn: commits touching the engine/resolver per period (the
 *      system itself was not held constant — stated, not blamed).
 *
 * Run: cd expo && bun scripts/measure_edge_decay.ts
 */
import { resolveSignalWithBars } from "../services/signalResolver";
import { aggregateBars, barATR, type Bar } from "../services/barIndicators";
import type { TradingSignal, SignalStatus } from "../types/trading";
import { createClient } from "@supabase/supabase-js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; htf_trend: string | null; rsi: number | null }
interface Out { signal_id: string; realized_r: number | null }
interface T { id: string; ems: number; day: string; week: string; dir: "BUY" | "SELL"; risk: number; r: number; usd: number; status: string; hour: number; htf: string | null }

const SPLIT_MS = Date.parse("2026-07-29T00:00:00Z");
const BARS_CACHE = "/tmp/gold_m1_cache_exit_policy.json";
const WINDOW_MS = 8 * 3600_000;

const lb = (bars: Bar[], t: number) => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const sd = (v: number[]) => { const m = mean(v); return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, v.length - 1)); };
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const sg = (x: number, d = 4) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
function mulberry32(seed: number) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }
function bootCI(v: number[], seed = 20261029, B = 20000): [number, number] { const rnd = mulberry32(seed); const ms: number[] = []; for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < v.length; i++) s += v[(rnd() * v.length) | 0]; ms.push(s / v.length); } ms.sort((a, b) => a - b); return [ms[Math.floor(B * 0.025)], ms[Math.floor(B * 0.975)]]; }
const isoWeek = (ms: number) => { const d = new Date(ms); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };

function describe(label: string, set: T[]) {
  const r = set.map((t) => t.r); const wins = set.filter((t) => t.r > 0), losses = set.filter((t) => t.r <= 0);
  const days = new Set(set.map((t) => t.day)).size; const usd = set.reduce((a, t) => a + t.usd, 0);
  const [lo, hi] = bootCI(r);
  const wr = wins.length / set.length, aw = mean(wins.map((t) => t.r)), al = mean(losses.map((t) => t.r));
  console.log(`  ${label.padEnd(22)} n=${set.length} days=${days} trades/day=${(set.length / days).toFixed(1)}  WR=${pct(wr)}  avgWin=${sg(aw)}R avgLoss=${sg(al)}R  EV=${sg(mean(r))}R  CI[${sg(lo)}, ${sg(hi)}]  $${(usd / days).toFixed(2)}/day  avgRisk=$${mean(set.map((t) => t.risk)).toFixed(2)}`);
  return { wr, aw, al, ev: mean(r) };
}

async function main() {
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!);
  const rows: Row[] = []; const outs: Out[] = [];
  for (let o = 0; ; o += 1000) { const { data, error } = await client.from("emitted_signals_v1").select("signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,htf_trend,rsi").order("emitted_at", { ascending: true }).range(o, o + 999); if (error) throw error; rows.push(...((data ?? []) as Row[])); if ((data?.length ?? 0) < 1000) break; }
  for (let o = 0; ; o += 1000) { const { data, error } = await client.from("trade_outcomes_v1").select("signal_id,realized_r").range(o, o + 999); if (error) throw error; outs.push(...((data ?? []) as Out[])); if ((data?.length ?? 0) < 1000) break; }
  const rById = new Map(outs.map((o) => [o.signal_id, o.realized_r]));
  const decided = rows.filter((r) => Number.isFinite(rById.get(r.signal_id) as number));

  let bars: Bar[];
  if (existsSync(BARS_CACHE)) { bars = JSON.parse(readFileSync(BARS_CACHE, "utf-8")); }
  else {
    bars = []; const minEms = Date.parse(decided[0].emitted_at) - 60_000; const maxEnd = Date.parse(decided[decided.length - 1].emitted_at) + WINDOW_MS;
    for (let o = 0; ; o += 1000) { const { data, error } = await client.from("gold_m1_bars").select("timestamp,open,high,low,close").gte("timestamp", new Date(minEms).toISOString()).lte("timestamp", new Date(maxEnd).toISOString()).order("timestamp", { ascending: true }).range(o, o + 999); if (error) throw error; for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[]) bars.push({ timestamp: Date.parse(r.timestamp), open: +r.open, high: +r.high, low: +r.low, close: +r.close }); if ((data?.length ?? 0) < 1000) break; }
    writeFileSync(BARS_CACHE, JSON.stringify(bars));
  }
  console.log(`decided=${decided.length}  bars=${bars.length} (${new Date(bars[0].timestamp).toISOString().slice(0, 10)} → ${new Date(bars[bars.length - 1].timestamp).toISOString().slice(0, 10)})`);

  // replay for comparable status labels
  const realLog = console.log; console.log = () => {};
  const trades: T[] = [];
  for (const s of decided) {
    const ems = Date.parse(s.emitted_at); const dir = (s.direction === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL";
    const windowEnd = Math.min(ems + WINDOW_MS, bars[bars.length - 1].timestamp);
    const wb = bars.slice(lb(bars, ems - 60_000), lb(bars, windowEnd));
    const sig = { id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: dir, entryPrice: +s.entry, entryPriceWithSlippage: +s.entry, tp1: +s.tp1, tp2: +s.tp2, tp3: +s.tp3, sl: +s.sl, confidence: +s.confidence, status: "ACTIVE" as SignalStatus, targetsHit: 0, breakevenReached: false } as unknown as TradingSignal;
    const res = wb.length ? resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd }) : null;
    const r = rById.get(s.signal_id) as number; const risk = Math.abs(+s.entry - +s.sl);
    trades.push({ id: s.signal_id, ems, day: s.emitted_at.slice(0, 10), week: isoWeek(ems), dir, risk, r, usd: r * risk, status: res?.outcomeResult ? res.newStatus : "UNRESOLVED_IN_8H", hour: new Date(ems).getUTCHours(), htf: s.htf_trend });
  }
  console.log = realLog;
  const early = trades.filter((t) => t.ems < SPLIT_MS), late = trades.filter((t) => t.ems >= SPLIT_MS);

  console.log(`\nA. IS EITHER PERIOD'S EDGE REAL? (paired-free bootstrap CIs, 20k)`);
  const E = describe("EARLY 06-29→07-28", early); const L = describe("LATE  07-29→09-25", late);
  const dEV = E.ev - L.ev; const se = Math.sqrt(sd(early.map((t) => t.r)) ** 2 / early.length + sd(late.map((t) => t.r)) ** 2 / late.length);
  console.log(`  EARLY−LATE ΔEV = ${sg(dEV)}R  (Welch SE ±${se.toFixed(4)}, t=${(dEV / se).toFixed(2)})  — MDE at 80% power ≈ ±${(2.8 * se).toFixed(4)}R`);

  console.log(`\nB. EV DECOMPOSITION  EV = WR·avgWin − (1−WR)·|avgLoss|`);
  const term = (x: { wr: number; aw: number; al: number }) => ({ winTerm: x.wr * x.aw, lossTerm: (1 - x.wr) * x.al });
  const tE = term(E), tL = term(L);
  console.log(`  EARLY: win-term ${sg(tE.winTerm)}R  loss-term ${sg(tE.lossTerm)}R`);
  console.log(`  LATE : win-term ${sg(tL.winTerm)}R  loss-term ${sg(tL.lossTerm)}R`);
  console.log(`  counterfactuals: LATE with EARLY's WR → EV ${sg(E.wr * L.aw + (1 - E.wr) * L.al)}R | LATE with EARLY's avgWin → ${sg(L.wr * E.aw + (1 - L.wr) * L.al)}R | LATE with EARLY's avgLoss → ${sg(L.wr * L.aw + (1 - L.wr) * E.al)}R`);

  console.log(`\nC. OUTCOME-LABEL MIX (resolver replay, same tape)`);
  const labels = [...new Set(trades.map((t) => t.status))].sort();
  for (const l of labels) { const e = early.filter((t) => t.status === l), la = late.filter((t) => t.status === l); console.log(`  ${l.padEnd(22)} early ${String(e.length).padStart(3)} (${pct(e.length / early.length).padStart(5)}) EV ${sg(mean(e.map((t) => t.r)) || 0)}R   late ${String(la.length).padStart(3)} (${pct(la.length / late.length).padStart(5)}) EV ${sg(mean(la.map((t) => t.r)) || 0)}R`); }

  console.log(`\nD. COMPOSITION`);
  const split = (name: string, f: (t: T) => boolean) => { const e = early.filter(f), la = late.filter(f); console.log(`  ${name.padEnd(18)} early n=${String(e.length).padStart(3)} (${pct(e.length / early.length).padStart(5)}) WR ${pct(e.length ? e.filter((t) => t.r > 0).length / e.length : 0).padStart(5)} EV ${sg(mean(e.map((t) => t.r)) || 0)}R | late n=${String(la.length).padStart(3)} (${pct(la.length / late.length).padStart(5)}) WR ${pct(la.length ? la.filter((t) => t.r > 0).length / la.length : 0).padStart(5)} EV ${sg(mean(la.map((t) => t.r)) || 0)}R`); };
  split("BUY", (t) => t.dir === "BUY"); split("SELL", (t) => t.dir === "SELL");
  split("00-07 UTC", (t) => t.hour < 7); split("07-12 UTC", (t) => t.hour >= 7 && t.hour < 12); split("12-17 UTC", (t) => t.hour >= 12 && t.hour < 17); split("17-24 UTC", (t) => t.hour >= 17);
  split("risk<$6", (t) => t.risk < 6); split("risk $6-9", (t) => t.risk >= 6 && t.risk < 9); split("risk>=$9", (t) => t.risk >= 9);
  split("htf NEUTRAL", (t) => !t.htf || t.htf === "NEUTRAL"); split("htf aligned", (t) => (t.htf === "BULLISH" && t.dir === "BUY") || (t.htf === "BEARISH" && t.dir === "SELL")); split("htf counter", (t) => (t.htf === "BULLISH" && t.dir === "SELL") || (t.htf === "BEARISH" && t.dir === "BUY"));

  console.log(`\nE. MARKET REGIME (gold_m1_bars)`);
  const byDay = new Map<string, Bar[]>(); for (const b of bars) { const d = new Date(b.timestamp).toISOString().slice(0, 10); byDay.set(d, [...(byDay.get(d) ?? []), b]); }
  const dayStats = [...byDay].map(([d, bs]) => ({ d, ms: Date.parse(d), range: Math.max(...bs.map((b) => b.high)) - Math.min(...bs.map((b) => b.low)), drift: bs[bs.length - 1].close - bs[0].open, close: bs[bs.length - 1].close, n: bs.length })).filter((x) => x.n > 300);
  const m5 = aggregateBars(bars, 5);
  // barATR returns ONE value for the tail of the series → compute a rolling ATR14 at every 12th M5 bar (hourly samples) inside the window.
  const atrBy = (lo: number, hi: number) => { const v: number[] = []; for (let i = 14; i < m5.length; i += 12) { if (m5[i].timestamp >= lo && m5[i].timestamp < hi) { const a = barATR(m5.slice(i - 14, i + 1), 14); if (a !== null && Number.isFinite(a)) v.push(a); } } return v; };
  const t0 = bars[0].timestamp, t1 = bars[bars.length - 1].timestamp + 1;
  for (const [name, lo, hi] of [["EARLY", t0, SPLIT_MS], ["LATE", SPLIT_MS, t1]] as const) {
    const ds = dayStats.filter((x) => x.ms >= lo && x.ms < hi); const a = atrBy(lo, hi);
    const up = ds.filter((x) => x.drift > 0).length;
    console.log(`  ${name}: days=${ds.length} avgDailyRange=$${mean(ds.map((x) => x.range)).toFixed(1)} medianRange=$${[...ds.map((x) => x.range)].sort((p, q) => p - q)[Math.floor(ds.length / 2)].toFixed(1)}  M5 ATR14 mean=$${mean(a).toFixed(2)}  up-days ${up}/${ds.length}  net move ${sg(ds[ds.length - 1].close - (ds[0].close - ds[0].drift), 1)}  mean|drift|=$${mean(ds.map((x) => Math.abs(x.drift))).toFixed(1)}`);
  }
  const driftOf = new Map(dayStats.map((x) => [x.d, x.drift]));
  console.log(`  BOOK vs TAPE — WR conditioned on the day's net drift sign (does the book fight the day?):`);
  for (const [name, set] of [["EARLY", early], ["LATE", late]] as const) {
    const with_ = set.filter((t) => { const d = driftOf.get(t.day); return d !== undefined && ((t.dir === "BUY" && d > 0) || (t.dir === "SELL" && d < 0)); });
    const against = set.filter((t) => { const d = driftOf.get(t.day); return d !== undefined && ((t.dir === "BUY" && d < 0) || (t.dir === "SELL" && d > 0)); });
    console.log(`    ${name}: WITH day-drift n=${with_.length} WR ${pct(with_.filter((t) => t.r > 0).length / with_.length)} EV ${sg(mean(with_.map((t) => t.r)))}R | AGAINST n=${against.length} WR ${pct(against.filter((t) => t.r > 0).length / against.length)} EV ${sg(mean(against.map((t) => t.r)))}R  (share against: ${pct(against.length / (with_.length + against.length))})`);
  }

  console.log(`\nF. WEEKLY EV SERIES + CHANGE POINT (max |t| over all week splits, n≥40 each side)`);
  const weeks = [...new Set(trades.map((t) => t.week))].sort();
  for (const w of weeks) { const s = trades.filter((t) => t.week === w); const days = new Set(s.map((t) => t.day)).size; console.log(`  ${w}  n=${String(s.length).padStart(3)}  WR ${pct(s.filter((t) => t.r > 0).length / s.length).padStart(5)}  EV ${sg(mean(s.map((t) => t.r)))}R  $${(s.reduce((a, t) => a + t.usd, 0) / days).toFixed(2)}/day`); }
  let bestW = "", bestT = 0;
  for (const w of weeks) { const a = trades.filter((t) => t.week < w).map((t) => t.r), b = trades.filter((t) => t.week >= w).map((t) => t.r); if (a.length < 40 || b.length < 40) continue; const tt = (mean(a) - mean(b)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length); if (Math.abs(tt) > Math.abs(bestT)) { bestT = tt; bestW = w; } }
  console.log(`  change point: week of ${bestW}  t=${bestT.toFixed(2)}  (|t|>~2.8 would be needed after scanning ${weeks.length} candidate splits — multiple-comparison inflated)`);

  console.log(`\nG. ENGINE CHURN (commits touching signalEngine/signalResolver/TradingContext per period — the rules were NOT constant)`);
  for (const [name, since, until] of [["EARLY", "2026-06-29", "2026-07-29"], ["LATE", "2026-07-29", "2026-09-26"]] as const) {
    try { const n = execSync(`git -C .. log --since=${since} --until=${until} --format=%h -- expo/services/signalEngine.ts expo/services/signalResolver.ts expo/contexts/TradingContext.tsx | wc -l`).toString().trim(); console.log(`  ${name}: ${n} commits`); } catch { console.log(`  ${name}: git unavailable`); }
  }
}
main().catch((e) => { console.error("FAILED", e instanceof Error ? e.stack : e); process.exit(1); });
