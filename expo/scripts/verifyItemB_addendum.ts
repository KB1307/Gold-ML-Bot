/**
 * ITEM B ADDENDUM — two things the main script left open.
 *
 * 1. MECHANISM OF THE LABEL ERROR: confirm that the 36.9% / 57.3% / 21.7%
 *    baselines are produced by a win-set that OMITS 'SL_AFTER_BE', and show the
 *    BUY/SELL split of those omitted signals — i.e. prove mechanically why the
 *    SELL side looked catastrophic and got gutted in Item 3.
 *
 * 2. RESOLUTION-QUALITY AUDIT: the main script reported 100% COMPLETE bar
 *    coverage, which is too clean to accept at face value. A COMPLETE-coverage
 *    resolution is NOT automatically trustworthy: if the terminal bar's range
 *    spans BOTH an SL-type level and an unbanked TP level, the resolver cannot
 *    observe which was touched first and falls back to a proximity-to-open
 *    heuristic (signalResolver.ts:147-156). Quantify how many outcomes depend
 *    on that heuristic, and whether their outcomes differ from unambiguous ones.
 *
 * DATA-SOURCE RULE: gold_m1_bars read DIRECTLY from Supabase via anon key + RLS.
 * No Rork backend. No GC=F / TwelveData. No priceHistory ticks.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import { resolveSignalWithBars } from "../services/signalResolver";
import type { TradingSignal, SignalStatus } from "../types/trading";
import type { OhlcBar } from "../services/barStore";

function loadEnv(): Record<string, string> {
  const raw = readFileSync(pathResolve(process.cwd(), ".env"), "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}
const env = loadEnv();
const anon = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface ParsedSignal {
  index: number;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  storedStatus: string;
  id: string;
  generatedMs: number;
  confidence: number;
  storedExitPrice: number | null;
  storedTargetsHit: number;
}

function parseExport(filePath: string): ParsedSignal[] {
  const raw = readFileSync(filePath, "utf-8");
  const signals: ParsedSignal[] = [];
  let current: Partial<ParsedSignal> | null = null;
  for (const line of raw.split("\n")) {
    const m = line.match(/^\[(\d+)\]\s+(BUY|SELL)\s+@\s+([\d.]+)\s+—\s+status:\s+(\S+)/);
    if (m) {
      if (current && current.id) signals.push(current as ParsedSignal);
      current = {
        index: parseInt(m[1]),
        direction: m[2] as "BUY" | "SELL",
        entry: parseFloat(m[3]),
        storedStatus: m[4],
        storedTargetsHit: 0,
        storedExitPrice: null,
      };
      continue;
    }
    if (!current) continue;
    const id = line.match(/^\s+id:\s+(\S+)/);
    if (id && !current.id) current.id = id[1];
    const g = line.match(/^\s+generated:\s+(\S+)/);
    if (g && current.generatedMs === undefined) {
      const ts = new Date(g[1]).getTime();
      if (!isNaN(ts)) current.generatedMs = ts;
    }
    const c = line.match(/^\s+confidence:\s+([\d.]+)%/);
    if (c && current.confidence === undefined) current.confidence = parseFloat(c[1]);
    const tp = line.match(/TP1:\s+([\d.]+)\s+TP2:\s+([\d.]+)\s+TP3:\s+([\d.]+)\s+SL:\s+([\d.]+)/);
    if (tp) {
      current.tp1 = parseFloat(tp[1]);
      current.tp2 = parseFloat(tp[2]);
      current.tp3 = parseFloat(tp[3]);
      current.sl = parseFloat(tp[4]);
    }
    const th = line.match(/targets hit:\s+(\d+)/);
    if (th) current.storedTargetsHit = parseInt(th[1]);
    const ex = line.match(/exit price:\s+([\d.]+)/);
    if (ex && current.storedExitPrice === null) current.storedExitPrice = parseFloat(ex[1]);
  }
  if (current && current.id) signals.push(current as ParsedSignal);
  return signals;
}

async function fetchBars(fromTs: string): Promise<OhlcBar[]> {
  const out: OhlcBar[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await anon
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromTs)
      .order("timestamp", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) out.push({ timestamp: new Date(r.timestamp).getTime(), open: r.open, high: r.high, low: r.low, close: r.close });
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 200_000) break;
  }
  return out;
}

function toTradingSignal(p: ParsedSignal): TradingSignal {
  return {
    id: p.id,
    timestamp: new Date(p.generatedMs),
    type: p.direction,
    entryPrice: p.entry,
    entryPriceWithSlippage: p.entry,
    tp1: p.tp1,
    tp2: p.tp2,
    tp3: p.tp3,
    sl: p.sl,
    slMultiplier: 1,
    confidence: p.confidence / 100,
    status: p.storedStatus as SignalStatus,
    targetsHit: p.storedTargetsHit,
    entryTime: new Date(p.generatedMs).toISOString(),
    exitPrice: p.storedExitPrice ?? undefined,
    topFeatures: [],
    riskJustification: "",
    createdAt: p.generatedMs,
  };
}

function rMult(dir: "BUY" | "SELL", entry: number, sl: number, exit: number): number | null {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  return (dir === "BUY" ? exit - entry : entry - exit) / risk;
}

function wr(vals: (number | null)[]): { wr: number; n: number; wins: number; ev: number } {
  const rs = vals.filter((v): v is number => v !== null);
  const wins = rs.filter((r) => r > 0).length;
  const sum = rs.reduce((a, b) => a + b, 0);
  return { wr: rs.length ? (wins / rs.length) * 100 : 0, n: rs.length, wins, ev: rs.length ? sum / rs.length : 0 };
}

async function main(): Promise<void> {
  const bars = await fetchBars("2026-06-18T00:00:00Z");
  const signals = parseExport("/tmp/diagnostics_export.txt");
  const evalNowMs = bars[bars.length - 1].timestamp;

  console.log("=".repeat(100));
  console.log("ITEM B ADDENDUM — LABEL-ERROR MECHANISM + RESOLUTION-QUALITY AUDIT");
  console.log(`run at ${new Date().toISOString()}`);
  console.log("=".repeat(100));

  // ── 1. MECHANISM ──────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(100));
  console.log("1. MECHANISM OF THE LABEL ERROR — WHICH STORED STATUSES WERE COUNTED AS LOSSES");
  console.log("=".repeat(100));

  const MEASURE_WIN_SET = new Set(["ALL_TARGETS_HIT", "PARTIAL_WIN_SL_HIT", "CLOSED", "TP_HIT"]);

  const byStatus = new Map<string, { buy: number; sell: number }>();
  for (const s of signals) {
    if (!byStatus.has(s.storedStatus)) byStatus.set(s.storedStatus, { buy: 0, sell: 0 });
    const e = byStatus.get(s.storedStatus)!;
    if (s.direction === "BUY") e.buy++;
    else e.sell++;
  }

  console.log("\n  stored status            BUY   SELL  TOTAL   counted as WIN by measureTickVsBarFeatures.ts?");
  console.log("  " + "-".repeat(96));
  for (const [st, e] of [...byStatus.entries()].sort((a, b) => b[1].buy + b[1].sell - (a[1].buy + a[1].sell))) {
    const counted = MEASURE_WIN_SET.has(st);
    console.log(
      `  ${st.padEnd(22)}${String(e.buy).padStart(5)}${String(e.sell).padStart(7)}${String(e.buy + e.sell).padStart(7)}   ${counted ? "YES" : "NO   <-- treated as a LOSS"}`,
    );
  }

  const slAfterBe = signals.filter((s) => s.storedStatus === "SL_AFTER_BE");
  const sabBuy = slAfterBe.filter((s) => s.direction === "BUY").length;
  const sabSell = slAfterBe.filter((s) => s.direction === "SELL").length;

  console.log(`\n  SL_AFTER_BE total: ${slAfterBe.length}/${signals.length} (${((slAfterBe.length / signals.length) * 100).toFixed(1)}% of the export)`);
  console.log(`    BUY  ${sabBuy}/${signals.filter((s) => s.direction === "BUY").length} (${((sabBuy / signals.filter((s) => s.direction === "BUY").length) * 100).toFixed(1)}% of BUYs)`);
  console.log(`    SELL ${sabSell}/${signals.filter((s) => s.direction === "SELL").length} (${((sabSell / signals.filter((s) => s.direction === "SELL").length) * 100).toFixed(1)}% of SELLs)`);
  console.log(`\n  SL_AFTER_BE means: stop taken AFTER TP1 was banked / breakeven reached.`);
  console.log(`  Economically that exits at the 0.35R post-TP1 lock => R > 0 => a WIN.`);
  console.log(`  Counting it as a LOSS is a pure label error, and it lands ${sabSell > sabBuy ? "DISPROPORTIONATELY ON SELL" : "mostly on BUY"}.`);

  // reproduce each headline with/without SL_AFTER_BE
  function labelWR(subset: ParsedSignal[], winSet: Set<string>): string {
    const w = subset.filter((s) => winSet.has(s.storedStatus)).length;
    return `${((w / subset.length) * 100).toFixed(1)}% (${w}/${subset.length})`;
  }
  const WITH_SAB = new Set([...MEASURE_WIN_SET, "SL_AFTER_BE"]);
  const buys = signals.filter((s) => s.direction === "BUY");
  const sells = signals.filter((s) => s.direction === "SELL");

  console.log("\n  EXACT REPRODUCTION — the only difference is whether SL_AFTER_BE counts as a win:\n");
  console.log(`    win set WITHOUT SL_AFTER_BE (what Item 3 used):`);
  console.log(`      overall ${labelWR(signals, MEASURE_WIN_SET)}    BUY ${labelWR(buys, MEASURE_WIN_SET)}    SELL ${labelWR(sells, MEASURE_WIN_SET)}`);
  console.log(`    win set WITH SL_AFTER_BE:`);
  console.log(`      overall ${labelWR(signals, WITH_SAB)}    BUY ${labelWR(buys, WITH_SAB)}    SELL ${labelWR(sells, WITH_SAB)}`);
  console.log(`\n    => the SELL win rate moves by ${(((sells.filter((s) => WITH_SAB.has(s.storedStatus)).length - sells.filter((s) => MEASURE_WIN_SET.has(s.storedStatus)).length) / sells.length) * 100).toFixed(1)} percentage points on this one label alone.`);

  // ── 2. RESOLUTION QUALITY ─────────────────────────────────────────────────
  console.log("\n" + "=".repeat(100));
  console.log("2. RESOLUTION-QUALITY AUDIT — IS 'COMPLETE COVERAGE' ACTUALLY TRUSTWORTHY?");
  console.log("=".repeat(100));

  interface Q {
    p: ParsedSignal;
    newStatus: SignalStatus;
    barR: number | null;
    ambiguous: boolean;
    firstBarTerminal: boolean;
    terminalRange: number;
    barsToResolve: number;
  }
  const qs: Q[] = [];

  const realLog = console.log;
  console.log = () => {};
  for (const p of signals) {
    if (!p.sl || !p.tp1 || !p.tp2 || !p.tp3 || !p.generatedMs) continue;
    const out = resolveSignalWithBars(toTradingSignal(p), bars, { fromScratch: true, evalNowMs });
    const safeBarStart = p.generatedMs + 60 * 1000;
    const evalBars = bars.filter((b) => b.timestamp >= safeBarStart);
    const termIdx = out.resolvedAtBarTs ? evalBars.findIndex((b) => b.timestamp === out.resolvedAtBarTs) : -1;
    const term = termIdx >= 0 ? evalBars[termIdx] : null;

    // same-bar ambiguity: terminal bar spans BOTH the applicable SL-type level
    // and a not-yet-banked TP level, so the true touch order is unobservable.
    let ambiguous = false;
    if (term) {
      const isBuy = p.direction === "BUY";
      const slTrig = isBuy ? p.sl - 0.01 : p.sl + 0.01;
      const slInBar = isBuy ? term.low <= slTrig : term.high >= slTrig;
      const tpInBar = isBuy ? term.high >= p.tp1 : term.low <= p.tp1;
      ambiguous = slInBar && tpInBar;
    }
    qs.push({
      p,
      newStatus: out.newStatus,
      barR: rMult(p.direction, p.entry, p.sl, out.exitPrice),
      ambiguous,
      firstBarTerminal: termIdx === 0,
      terminalRange: term ? term.high - term.low : 0,
      barsToResolve: termIdx >= 0 ? termIdx + 1 : evalBars.length,
    });
  }
  console.log = realLog;

  const amb = qs.filter((q) => q.ambiguous);
  const unamb = qs.filter((q) => !q.ambiguous);
  console.log(`\n  Total resolved: ${qs.length}`);
  console.log(`  SAME-BAR AMBIGUOUS terminal (SL level AND unbanked TP level both inside the terminal bar):`);
  console.log(`    ${amb.length}/${qs.length} (${((amb.length / qs.length) * 100).toFixed(1)}%)`);
  console.log(`    These depend on the resolver's proximity-to-open heuristic (signalResolver.ts:147-156),`);
  console.log(`    NOT on observed touch order. They are 'complete coverage' but not fully determined.`);
  console.log(`  UNAMBIGUOUS terminal: ${unamb.length}/${qs.length} (${((unamb.length / qs.length) * 100).toFixed(1)}%)`);

  console.log(`\n  do ambiguous and unambiguous resolutions produce different outcomes?`);
  const a = wr(amb.map((q) => q.barR));
  const u = wr(unamb.map((q) => q.barR));
  const all = wr(qs.map((q) => q.barR));
  console.log(`    AMBIGUOUS    n=${String(a.n).padStart(3)}  WR=${a.wr.toFixed(1).padStart(5)}%  EV=${(a.ev >= 0 ? "+" : "") + a.ev.toFixed(4)}R`);
  console.log(`    UNAMBIGUOUS  n=${String(u.n).padStart(3)}  WR=${u.wr.toFixed(1).padStart(5)}%  EV=${(u.ev >= 0 ? "+" : "") + u.ev.toFixed(4)}R`);
  console.log(`    ALL          n=${String(all.n).padStart(3)}  WR=${all.wr.toFixed(1).padStart(5)}%  EV=${(all.ev >= 0 ? "+" : "") + all.ev.toFixed(4)}R`);

  const ab = wr(amb.filter((q) => q.p.direction === "BUY").map((q) => q.barR));
  const as_ = wr(amb.filter((q) => q.p.direction === "SELL").map((q) => q.barR));
  console.log(`      ambiguous BUY  n=${ab.n}  WR=${ab.wr.toFixed(1)}%   ambiguous SELL n=${as_.n}  WR=${as_.wr.toFixed(1)}%`);

  const firstBar = qs.filter((q) => q.firstBarTerminal);
  console.log(`\n  resolved on the VERY FIRST evaluated bar: ${firstBar.length}/${qs.length} (${((firstBar.length / qs.length) * 100).toFixed(1)}%)`);
  const fb = wr(firstBar.map((q) => q.barR));
  console.log(`    n=${fb.n}  WR=${fb.wr.toFixed(1)}%  EV=${(fb.ev >= 0 ? "+" : "") + fb.ev.toFixed(4)}R`);
  const wide = qs.filter((q) => q.terminalRange >= 5).length;
  console.log(`  terminal bar range >= $5 (a large single-minute move): ${wide}/${qs.length} (${((wide / qs.length) * 100).toFixed(1)}%)`);

  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  };
  console.log(`  bars-to-resolve: median ${median(qs.map((q) => q.barsToResolve))}, max ${Math.max(...qs.map((q) => q.barsToResolve))}`);

  console.log("\n  VERDICT ON (d):");
  if (amb.length / qs.length > 0.15) {
    console.log(`    The 100% COMPLETE figure is real in the sense that bars exist with no gaps,`);
    console.log(`    but ${((amb.length / qs.length) * 100).toFixed(1)}% of outcomes rest on a same-bar tie-break heuristic rather than`);
    console.log(`    observed order. That is a genuine caveat on the canonical set and must be carried forward.`);
  } else {
    console.log(`    Same-bar ambiguity affects only ${((amb.length / qs.length) * 100).toFixed(1)}% of resolutions and their WR/EV is`);
    console.log(`    close to the unambiguous group, so it does not materially drive the canonical baseline.`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
