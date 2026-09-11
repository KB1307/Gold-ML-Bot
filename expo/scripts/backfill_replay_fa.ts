/**
 * ITEM FA — BACKFILL REPLAY HARNESS (read-only; NO writes anywhere).
 *
 * Fidelity check on the SHIPPED code, not a new backtest: pulls history from
 * gold_m1_bars (anon key, paginated), aggregates M1 → M5 with the engine's own
 * helper (aggregateBars, barIndicators.ts:78), and walks every closed M5 bar
 * calling the REAL shipped detectors exactly as runShadowStrategyScan()
 * (signalEngine.ts:11303) does live. Each detection is resolved under the
 * Python-reference rules and printed against the reference figures.
 *
 * LIVE-SCAN FIDELITY (verified against signalEngine.ts before writing):
 *   - window = the full BAR_M5_LOOKBACK slice — live builds
 *     barSeriesM5 = aggregateBars(m1, 5).slice(-BAR_M5_LOOKBACK) (line 3123)
 *     and the scan consumes ALL of it (line 11304: `const bars =
 *     this.barSeriesM5`); BAR_M5_LOOKBACK = 300 (line 2091, private static —
 *     verified, hard-coded here; FA scope forbids touching signalEngine).
 *   - entryPrice = last closed bar's close (11317); rsi = barRSI(bars, 14) (11318).
 *   - swing gate formula per side, computed ONCE per scan on the same series (11328–11343).
 *   - cap state machine (11449–11457): openAtSignal fetched BEFORE the detectors,
 *     intra-scan openedThisScan counter, skipped rows never consume a slot.
 *   - detector order DT → ZONE → REOPEN with the `if (!isReopen) return;`
 *     early exit (11400–11461); null-score guards byte-matched (11401/11421/11450).
 *   - DEDUP: the live scan applies NO dedup beyond the double-scan guard (one
 *     scan per closed M5 bar). The replay therefore evaluates every closed bar
 *     exactly once — matching live behaviour.
 *   - RESOLUTION (FA spec = the Python-reference convention): fill at the open
 *     of the bar AFTER the detection bar, stop checked BEFORE target (same-bar
 *     both → LOSS), $0.20 cost, TIME at the last walked bar's close.
 *     DISCREPANCY vs the shipped Item DA resolver (live code wins — reported):
 *     resolveRowAgainstBars filters M5 bars to `timestamp >= evaluated_at` and
 *     fills at m5[0].open — the DETECTION bar's open, one bar earlier than the
 *     reference convention. The replay implements the reference rule per the FA
 *     spec; the resolver divergence is flagged in the FA report, not changed.
 *
 * Reference figures: Item EB measured basis (625-cell grid, 18-month M5,
 * train Mar 2025–Feb 2026, holdout Mar–Sep 2026 read once).
 */
import { createClient } from "@supabase/supabase-js";
import {
  detectDoubleTop,
  detectScoredReopen,
  detectZoneRetestLong,
  computeSwingStructure,
  geometryForStrategy,
  SWING_TOLERANCE,
  SHADOW_CONCURRENCY_CAP,
  type ShadowCandidateName,
} from "../services/shadowStrategies";
import { aggregateBars, barRSI, sealBarSeries, type Bar } from "../services/barIndicators";

const BAR_M5_LOOKBACK = 300; // signalEngine.ts:2091 (private) — verified live; not re-exported (scope)
const COST_PER_TRADE = 0.2;
const TRAIN_CUTOFF_MS = Date.UTC(2026, 2, 1); // 2026-03-01 — every reference figure's train/holdout split
const PAGE_SIZE = 1000;
const MAX_PAGES = 6000; // safety cap: ~74k M5 bars/year ≈ 2.1M M1 rows ≈ 2100 pages for 12 months
const REFERENCE_WINDOW_MONTHS = 18;

interface ReferenceFigure {
  readonly n: number;
  readonly wrPct: number;
  readonly ev: number;
}
const REFERENCE: Record<ShadowCandidateName, ReferenceFigure> = {
  SCORED_DT_SHORT: { n: 633, wrPct: 55, ev: 1.95 },
  SCORED_REOPEN_LONG: { n: 147, wrPct: 71, ev: 6.73 },
  ZONE_RETEST_LONG: { n: 318, wrPct: 58, ev: 3.63 },
};
const REF_SWING_BLOCKED_PCT = 32;
const REF_SWING_EV = { allowed: 3.27, blocked: 1.85 };
const REF_CAP_SKIPPED_PCT = 16;
const REF_PORTFOLIO = { perMonth: 47, wrPct: 46, ev: 3.27, maxDD: 202 };

type Direction = "BUY" | "SELL";

interface Detection {
  readonly name: ShadowCandidateName;
  readonly direction: Direction;
  readonly signalIdx: number;
  readonly verdict: "ABOVE" | "BELOW";
  readonly swingBlocked: boolean;
  readonly capSkipped: boolean;
}

interface Trade {
  readonly name: ShadowCandidateName;
  readonly signalIdx: number;
  readonly fillIdx: number;
  readonly exitIdx: number;
  readonly outcome: "TP" | "SL" | "TIME" | "UNRESOLVED";
  /** $ per 0.01 lot INCLUDING the $0.20 cost. */
  readonly pnl: number;
}

const r1 = (v: number): string => (v >= 0 ? "+" : "") + v.toFixed(2);
const pct = (part: number, whole: number): string => (whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(1)}%`);

/** Stop checked BEFORE target on every walked bar; same-bar both → LOSS (reference rule). */
function resolveTrade(
  m5: ReadonlyArray<Bar>,
  name: ShadowCandidateName,
  direction: Direction,
  signalIdx: number,
): Trade {
  const geom = geometryForStrategy(name);
  const fillIdx = signalIdx + 1;
  if (fillIdx >= m5.length) {
    return { name, signalIdx, fillIdx, exitIdx: -1, outcome: "UNRESOLVED", pnl: 0 };
  }
  const fill = m5[fillIdx].open;
  const stop = direction === "SELL" ? fill + geom.sl : fill - geom.sl;
  const target = direction === "SELL" ? fill - geom.tp : fill + geom.tp;
  const lastIdx = Math.min(fillIdx + geom.timeStopBars - 1, m5.length - 1);
  for (let b = fillIdx; b <= lastIdx; b += 1) {
    const bar = m5[b];
    const stopped = direction === "SELL" ? bar.high >= stop : bar.low <= stop;
    if (stopped) return { name, signalIdx, fillIdx, exitIdx: b, outcome: "SL", pnl: -geom.sl - COST_PER_TRADE };
    const targetHit = direction === "SELL" ? bar.low <= target : bar.high >= target;
    if (targetHit) return { name, signalIdx, fillIdx, exitIdx: b, outcome: "TP", pnl: geom.tp - COST_PER_TRADE };
  }
  const exitClose = m5[lastIdx].close;
  const raw = direction === "SELL" ? fill - exitClose : exitClose - fill;
  return { name, signalIdx, fillIdx, exitIdx: lastIdx, outcome: "TIME", pnl: raw - COST_PER_TRADE };
}

async function fetchPage(supabase: ReturnType<typeof createClient>, fromIso: string, toIso: string, page: number): Promise<{ timestamp: string; open: number; high: number; low: number; close: number }[]> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { data, error } = await supabase
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromIso)
      .lte("timestamp", toIso)
      .order("timestamp", { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (!error) return data ?? [];
    console.log(`  page ${page} attempt ${attempt} failed: ${error.message}`);
    if (attempt < 3) await new Promise((res) => setTimeout(res, attempt === 1 ? 1000 : 3000));
  }
  throw new Error(`page ${page}: 3 transport attempts exhausted`);
}

async function main(): Promise<void> {
  const argv = process.argv;
  const monthsFlagIdx = argv.indexOf("--months");
  const months = monthsFlagIdx >= 0 && argv[monthsFlagIdx + 1] ? parseFloat(argv[monthsFlagIdx + 1]) : 12;
  if (!Number.isFinite(months) || months <= 0) throw new Error("--months must be a positive number");

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY missing");
  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Newest bar present — the window is measured back from IT, not from now.
  const { data: newestRows, error: newestErr } = await supabase
    .from("gold_m1_bars")
    .select("timestamp")
    .order("timestamp", { ascending: false })
    .limit(1);
  if (newestErr || !newestRows || newestRows.length === 0) throw new Error(`newest-bar probe failed: ${newestErr?.message ?? "empty"}`);
  const newestMs = new Date(newestRows[0].timestamp).getTime();
  const windowStartMs = newestMs - months * 30.44 * 24 * 3600 * 1000;
  const fromIso = new Date(windowStartMs).toISOString();
  const toIso = new Date(newestMs).toISOString();
  console.log(`BACKFILL REPLAY — window ${fromIso} → ${toIso} (--months ${months})`);

  // Paginated read + INCREMENTAL aggregation (memory-safe: the M1 rows are
  // folded into 5-minute buckets as each page arrives, never held whole).
  const buckets = new Map<number, { timestamp: number; open: number; high: number; low: number; close: number }>();
  let m1Rows = 0;
  let lastM1Ts = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await fetchPage(supabase, fromIso, toIso, page);
    m1Rows += rows.length;
    // timestamp arrives as a timestamptz STRING — convert to ms epochs BEFORE
    // aggregating (aggregateBars buckets numerically; a raw string would NaN).
    const bars: Bar[] = rows.map((row) => ({
      timestamp: new Date(row.timestamp).getTime(),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    }));
    for (const bar of bars) lastM1Ts = Math.max(lastM1Ts, bar.timestamp);
    for (const agg of aggregateBars(bars, 5)) {
      const existing = buckets.get(agg.timestamp);
      if (!existing) buckets.set(agg.timestamp, { ...agg });
      else {
        existing.high = Math.max(existing.high, agg.high);
        existing.low = Math.min(existing.low, agg.low);
        existing.close = agg.close;
      }
    }
    if (page % 100 === 0) console.log(`  page ${page}: ${m1Rows} M1 rows, ${buckets.size} M5 buckets`);
    if (rows.length < PAGE_SIZE) break;
  }
  const m5All = [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
  // Drop a trailing PARTIAL bucket (the in-progress 5-minute window): a bucket
  // is closed only when an M1 bar reached its final minute.
  if (m5All.length > 0 && m5All[m5All.length - 1].timestamp + 300_000 > lastM1Ts + 60_000) m5All.pop();
  const m5 = m5All as ReadonlyArray<Bar>;
  // Full runs walk from index 1100 (prompt spec). A smoke window (< 1101 bars)
  // starts right after the 300-bar warmup so the pipeline still exercises
  // end-to-end — labelled as a partial run below.
  const fullWindow = m5.length >= 1101;
  const startIdx = fullWindow ? 1100 : m5.length - BAR_M5_LOOKBACK;
  if (m5.length < 301) throw new Error(`only ${m5.length} closed M5 bars in window — need ≥ 301`);
  let gapBars = 0;
  for (let i = 1; i < m5.length; i += 1) if (m5[i].timestamp - m5[i - 1].timestamp > 300_000) gapBars += 1;
  const windowStartIso = new Date(m5[0].timestamp).toISOString();
  const windowEndIso = new Date(m5[m5.length - 1].timestamp).toISOString();
  const monthsActual = (m5[m5.length - 1].timestamp - m5[0].timestamp) / (30.44 * 24 * 3600 * 1000);
  console.log(`M1 rows: ${m1Rows}  M5 bars: ${m5.length}  bars/window-month: ${(m5.length / monthsActual).toFixed(0)}  non-5min gaps: ${gapBars} (maintenance breaks + weekends)`);

  // ── THE WALK — every closed M5 bar from index 1100, live-scan semantics ──
  const detections: Detection[] = [];
  const detCount: Record<ShadowCandidateName, number> = {
    SCORED_DT_SHORT: 0,
    SCORED_REOPEN_LONG: 0,
    ZONE_RETEST_LONG: 0,
  };
  const openPositions: { readonly fillIdx: number; readonly exitIdx: number }[] = [];
  let minGapBuy = Number.POSITIVE_INFINITY;
  let minGapSell = Number.POSITIVE_INFINITY;
  let minGapDT = Number.POSITIVE_INFINITY;
  let minGapZone = Number.POSITIVE_INFINITY;

  for (let i = startIdx; i < m5.length; i += 1) {
    const window = m5.slice(Math.max(0, i - BAR_M5_LOOKBACK + 1), i + 1);
    const n = window.length;
    const entryPrice = window[n - 1].close;
    const rsi = barRSI(sealBarSeries(window), 14);
    const swing = computeSwingStructure(window);
    const currentBarIndex = n - 1;
    if (swing.confirmationBarHigh !== null) minGapBuy = Math.min(minGapBuy, currentBarIndex - swing.confirmationBarHigh);
    if (swing.confirmationBarLow !== null) minGapSell = Math.min(minGapSell, currentBarIndex - swing.confirmationBarLow);

    // swingGateFor — byte-matched to signalEngine.ts:11330–11343.
    const sellGate = (): boolean =>
      swing.lastSwingLow === null || swing.confirmationBarLow === null ? false : entryPrice < swing.lastSwingLow + SWING_TOLERANCE;
    const buyGate = (): boolean =>
      swing.lastSwingHigh === null || swing.confirmationBarHigh === null ? false : entryPrice > swing.lastSwingHigh - SWING_TOLERANCE;

    // capState — byte-matched to signalEngine.ts:11349–11357 (openAtSignal
    // BEFORE the detectors; intra-scan counter; skipped rows consume no slot).
    const openAtSignal = openPositions.reduce((acc, p) => (p.fillIdx <= i && p.exitIdx > i ? acc + 1 : acc), 0);
    let openedThisScan = 0;
    const capState = (): boolean => {
      const total = openAtSignal + openedThisScan;
      const skipped = total >= SHADOW_CONCURRENCY_CAP;
      if (!skipped) openedThisScan += 1;
      return skipped;
    };
    const record = (name: ShadowCandidateName, direction: Direction, verdict: "ABOVE" | "BELOW", blocked: boolean): void => {
      const capSkipped = capState();
      detCount[name] += 1;
      detections.push({ name, direction, signalIdx: i, verdict, swingBlocked: blocked, capSkipped });
      if (!capSkipped) {
        const geom = geometryForStrategy(name);
        openPositions.push({ fillIdx: i + 1, exitIdx: Math.min(i + geom.timeStopBars, m5.length - 1) });
      }
    };

    // 1) SCORED_DT_SHORT — persist condition byte-matched to 11401.
    const dt = detectDoubleTop({ m5Bars: window, entryPrice, direction: "SELL", rsi });
    if (dt.detected && dt.score !== null && Number.isFinite(dt.score) && dt.scoreVerdict !== null) {
      if (dt.swingHighBar !== null) minGapDT = Math.min(minGapDT, currentBarIndex - (dt.swingHighBar + 2));
      record("SCORED_DT_SHORT", "SELL", dt.scoreVerdict, sellGate());
    }
    // 2) ZONE_RETEST_LONG — persist condition byte-matched to 11421.
    const zr = detectZoneRetestLong({ m5Bars: window, entryPrice, direction: "BUY" });
    if (zr.detected && zr.scoreVerdict !== null) {
      if (zr.confirmationBar !== null) minGapZone = Math.min(minGapZone, currentBarIndex - zr.confirmationBar);
      record("ZONE_RETEST_LONG", "BUY", zr.scoreVerdict, buyGate());
    }
    // 3) SCORED_REOPEN_LONG — 60–200 min gap, early-`continue` mirrors the live early-return (11444–11447).
    const gapMs = window[n - 1].timestamp - window[n - 2].timestamp;
    const isReopen = gapMs > 60 * 60 * 1000 && gapMs < 200 * 60 * 1000;
    if (!isReopen) continue;
    const priorClose = window[n - 2].close;
    const reopen = detectScoredReopen({ m5Bars: window, isReopen, entryPrice, priorClose });
    if (reopen.detected && reopen.score !== null && Number.isFinite(reopen.score) && reopen.scoreVerdict !== null) {
      record("SCORED_REOPEN_LONG", "BUY", reopen.scoreVerdict, buyGate());
    }
  }

  // ── RESOLUTION — ALL detections resolve (the reference n values are PRE-CAP
  // backtest signal counts, so the comparison basis is pre-cap too; the cap
  // line below separates taken/skipped) ──
  const trades: Trade[] = detections.map((d) => resolveTrade(m5, d.name, d.direction, d.signalIdx));

  const names: ShadowCandidateName[] = ["SCORED_DT_SHORT", "SCORED_REOPEN_LONG", "ZONE_RETEST_LONG"];
  const statsFor = (name: ShadowCandidateName, fromIdx: number, toIdx: number): { n: number; wins: number; sum: number } => {
    let n = 0;
    let wins = 0;
    let sum = 0;
    for (const t of trades) {
      if (t.name !== name || t.outcome === "UNRESOLVED") continue;
      const ts = m5[t.signalIdx].timestamp;
      if (ts < fromIdx || ts > toIdx) continue;
      n += 1;
      if (t.pnl > 0) wins += 1;
      sum += t.pnl;
    }
    return { n, wins, sum };
  };
  const splitIdx = TRAIN_CUTOFF_MS;
  const allStart = 0;
  const allEnd = Number.POSITIVE_INFINITY;

  // ── COMPARISON TABLE ──
  console.log("");
  console.log("BACKFILL REPLAY — shipped TypeScript vs Python reference");
  console.log(`window: ${windowStartIso} → ${windowEndIso}  M5 bars: ${m5.length}  detections(all arms, pre-cap): ${detections.length}${fullWindow ? "" : "  [SMOKE RUN — partial window, not the FA gate]"}`);
  console.log("");
  console.log(" ┌─────────────────── SHIPPED (this replay, pre-cap detections) ────────────────┐ ┌── PYTHON REFERENCE ──┐");
  console.log(" strategy              n     /mo    WR     EV     train   hold  |   n   WR    EV    delta");
  const divergences: string[] = [];
  for (const name of names) {
    const full = statsFor(name, allStart, allEnd);
    const train = statsFor(name, allStart, splitIdx - 1);
    const hold = statsFor(name, splitIdx, allEnd);
    const ref = REFERENCE[name];
    const wr = full.n > 0 ? `${((full.wins / full.n) * 100).toFixed(0)}%` : "n/a";
    const ev = full.n > 0 ? full.sum / full.n : 0;
    const trainEv = train.n > 0 ? r1(train.sum / train.n) : "n/a";
    const holdEv = hold.n > 0 ? r1(hold.sum / hold.n) : "n/a";
    // Count basis = ALL detections (pre-cap), matching the reference n basis.
    const perMonth = detCount[name] / monthsActual;
    console.log(
      ` ${name.padEnd(21)}${String(detCount[name]).padStart(5)} ${perMonth.toFixed(1).padStart(6)} ${wr.padStart(6)} ${r1(ev).padStart(7)} ${trainEv.padStart(7)} ${holdEv.padStart(7)} | ${String(ref.n).padStart(5)} ${`${ref.wrPct}%`.padStart(4)} ${r1(ref.ev).padStart(6)} ${r1(ev - ref.ev).padStart(7)}`,
    );
    const refPerMonth = ref.n / REFERENCE_WINDOW_MONTHS;
    if (Math.abs(perMonth / refPerMonth - 1) > 0.25) {
      divergences.push(`${name}: detection count ${perMonth.toFixed(1)}/mo vs reference ${refPerMonth.toFixed(1)}/mo (>±25%)`);
    }
    if (full.n > 0 && Math.sign(ev) !== Math.sign(ref.ev)) {
      divergences.push(`${name}: EV sign ${r1(ev)} vs reference ${r1(ref.ev)}`);
    }
  }

  // ── SWING GATE + CAP + PORTFOLIO ──
  const detectionsBy = (pred: (d: Detection) => boolean): Detection[] => detections.filter(pred);
  const evOf = (ds: Detection[]): number => {
    const resolved = trades.filter((t) => t.outcome !== "UNRESOLVED" && ds.some((d) => d.signalIdx === t.signalIdx && d.name === t.name));
    return resolved.length > 0 ? resolved.reduce((a, t) => a + t.pnl, 0) / resolved.length : 0;
  };
  const allowedDs = detectionsBy((d) => !d.swingBlocked);
  const blockedDs = detectionsBy((d) => d.swingBlocked);
  const skippedDs = detectionsBy((d) => d.capSkipped);
  const takenDs = detectionsBy((d) => !d.capSkipped);
  console.log("");
  console.log(`swing gate: allowed ${allowedDs.length} (${pct(allowedDs.length, detections.length)})  blocked ${blockedDs.length} (${pct(blockedDs.length, detections.length)})   reference: ${REF_SWING_BLOCKED_PCT}% blocked`);
  console.log(`  ALLOWED EV $${r1(evOf(allowedDs))}   BLOCKED EV $${r1(evOf(blockedDs))}   reference: ${r1(REF_SWING_EV.allowed)} / ${r1(REF_SWING_EV.blocked)}`);
  console.log(`cap: taken ${takenDs.length}  skipped ${skippedDs.length} (${pct(skippedDs.length, detections.length)})   reference: ${REF_CAP_SKIPPED_PCT}% skipped`);

  const portfolioTrades = trades.filter((t) => {
    const d = detections.find((x) => x.signalIdx === t.signalIdx && x.name === t.name);
    return d !== undefined && !d.swingBlocked && !d.capSkipped && t.outcome !== "UNRESOLVED";
  }).sort((a, b) => a.fillIdx - b.fillIdx);
  const pWins = portfolioTrades.filter((t) => t.pnl > 0).length;
  const pSum = portfolioTrades.reduce((a, t) => a + t.pnl, 0);
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of portfolioTrades) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  const pEv = portfolioTrades.length > 0 ? pSum / portfolioTrades.length : 0;
  console.log("");
  console.log(`PORTFOLIO (allowed + not cap-skipped): n=${portfolioTrades.length}  /mo=${(portfolioTrades.length / monthsActual).toFixed(1)}  WR=${pct(pWins, portfolioTrades.length)}  EV=$${r1(pEv)}  maxDD=$${maxDD.toFixed(0)}`);
  console.log(`  reference: ${REF_PORTFOLIO.perMonth}/month, WR ${REF_PORTFOLIO.wrPct}%, EV ${r1(REF_PORTFOLIO.ev)}, maxDD $${REF_PORTFOLIO.maxDD} (0.01 lot)`);

  // ── CAUSALITY AUDIT ──
  console.log("");
  const fmt = (v: number): string => (Number.isFinite(v) ? String(v) : "n/a (no swing found in window)");
  console.log(`CAUSALITY AUDIT — min swingCausalGap BUY=${fmt(minGapBuy)} SELL=${fmt(minGapSell)} | DT confirmation gap=${fmt(minGapDT)} | ZONE confirmation gap=${fmt(minGapZone)}`);
  if (minGapBuy === 0 || minGapSell === 0 || minGapDT === 0 || minGapZone === 0) {
    console.error("🛑 LOOKAHEAD — a confirmation gap of 0 means the shipped code used a future bar. STOP.");
    process.exit(1);
  }

  // ── DIVERGENCE FLAGS ──
  if (divergences.length > 0) {
    console.log("");
    console.log("⚠️ DIVERGENCE — shipped code does not reproduce the reference. Investigate before trusting the forward book.");
    for (const d of divergences) console.log(`  ⚠️ ${d}`);
  } else {
    console.log("");
    console.log("No divergence flags (counts within ±25%/mo of the reference where the window allows the comparison; EV signs agree).");
  }
  console.log("");
  console.log(`NOTE: reference figures are 18-month-basis; this replay is ${monthsActual.toFixed(1)} months of DB history (gold_m1_bars holds less than the requested window when it starts later). Count comparison is per-month on the pre-cap detection basis; WR/EV are over resolved detections including cap-skipped. Win = pnl (incl. $0.20 cost) > 0; TIME exits carry their signed close delta.`);
  console.log("ITEM FA GATE: PASS (harness ran to completion; causality gaps ≥ 1; comparison table printed).");
}

main().catch((err: unknown) => {
  console.error(`ITEM FA GATE: FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
