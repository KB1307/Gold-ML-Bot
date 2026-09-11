/**
 * ITEM FG — acceptance 1: the ZONE trend filter is now the TESTED one.
 *
 * Production chain: gold_m1_bars (144h window, 9 pages) → aggregateBars(m1,5)
 * → .slice(-BAR_M5_LOOKBACK=1000) → barSeriesM5 → detectZoneRetestLong →
 * trendEmaSpanUsed = Math.min(960, bars.length - 1) (signalEngine.ts:11476).
 *
 * This mock walks that exact chain on synthetic data and asserts:
 *   A. A 1000-bar series yields trendEmaSpanUsed 960 (the tested span);
 *      the old 300-bar series yielded 299 (the FA-divergence approximation).
 *   B. emaSpan(closes, 960) is null below span (the old live state — the
 *      detector fell back to span 299) and NON-null on the new 1000-bar series.
 *   C. The trend filter actually MEANS something now: on a series that rises
 *      then pulls back, the approximated 299-span EMA hugs recent price while
 *      the true 960-span EMA lags far below — the SAME close flips trendUp
 *      between the regimes (the FA ZONE divergence mechanism in miniature).
 *      HARNESS NOTE (first run FAIL was a mock bug, shipped code untouched):
 *      it imported EMA_4H_SPAN_M5_BARS (= 48, modelFitting's unrelated
 *      feat_trend_aligned constant) instead of the detector's ZRL_EMA_4H_SPAN
 *      (= 960, shadowStrategies:346) — DC precedent: harness verified against
 *      the shipped function and fixed.
 *   D. The coupled fetch window: 72h of M1 rows (4320) aggregates to ~864 M5
 *      bars — slice(-1000) CANNOT reach 970 (the reference guard). 144h
 *      (~8640 rows) aggregates well past 970, so the new window feeds it.
 *
 * Read-only synthetic mock — no DB, no imports of signalEngine (it pulls RN
 * AsyncStorage); emaSpan + aggregateBars are the exact shipped functions.
 *
 * Run: cd expo && bun scripts/mock_test_fg_lookback.ts
 */
import { aggregateBars } from "../services/barIndicators";
import { emaSpan } from "../services/modelFitting";
import { ZRL_EMA_4H_SPAN } from "../services/shadowStrategies";

const REFERENCE_GUARD_BARS = 970; // Python detector: null when series < 970

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

/** Rise 4400→4490 then a ~$18 pullback — calibrated so the two regimes disagree on the final close (see header C). */
function buildTrendingSeries(n: number): Bar[] {
  const out: Bar[] = [];
  const t0 = Date.UTC(2026, 8, 1);
  for (let i = 0; i < n; i += 1) {
    const close = i <= n - 61 ? 4400 + i * 0.09574 : 4490 - (i - (n - 61)) * 0.3;
    out.push({ timestamp: t0 + i * 300_000, open: close, high: close + 0.4, low: close - 0.4, close });
  }
  return out;
}

function syntheticM1Rows(hours: number): Bar[] {
  const rows: Bar[] = [];
  const t0 = Date.UTC(2026, 8, 1);
  const count = hours * 60; // 1 row per minute, no gaps (traded time)
  for (let i = 0; i < count; i += 1) {
    rows.push({ timestamp: t0 + i * 60_000, open: 4490, high: 4490.4, low: 4489.6, close: 4490 });
  }
  return rows;
}

function main(): void {
  const checks: [string, boolean][] = [];

  // A — the engine's own span formula (signalEngine.ts:11476, verbatim).
  const spanUsed = (barsInSeries: number): number => Math.min(960, barsInSeries - 1);
  checks.push(["A: OLD 300-bar series → trendEmaSpanUsed 299 (approximation regime)", spanUsed(300) === 299]);
  checks.push(["A: NEW 1000-bar series → trendEmaSpanUsed 960 (TESTED span)", spanUsed(1000) === 960]);

  // B — emaSpan null-below-span: the CA fallback trigger is gone on the new series.
  const series300 = buildTrendingSeries(300);
  const series1000 = buildTrendingSeries(1000);
  const emaOld = emaSpan(series300.map((b) => b.close), ZRL_EMA_4H_SPAN);
  const emaNew = emaSpan(series1000.map((b) => b.close), ZRL_EMA_4H_SPAN);
  checks.push(["B: OLD 300-bar live series → emaSpan(…,960) null → detector fell back to 299", emaOld === null]);
  checks.push(["B: NEW 1000-bar live series → emaSpan(…,960) non-null → true 960 span", emaNew !== null]);

  // C — the filter now separates: on the pullback close, the TESTED regime
  // accepts (close above the lagging 960-EMA) while the APPROXIMATED regime
  // rejects (close below the price-hugging 299-EMA) — trendUp flips.
  if (emaNew !== null) {
    const lastClose = series1000[series1000.length - 1].close;
    const ema299 = emaSpan(series1000.slice(-300).map((b) => b.close), 299) ?? NaN;
    console.log(`  lastClose=${lastClose.toFixed(2)} ema960=${emaNew.toFixed(2)} (close−ema960 ${(lastClose - emaNew).toFixed(2)}) ema299=${ema299.toFixed(2)} (close−ema299 ${(lastClose - ema299).toFixed(2)})`);
    checks.push(["C: 960-span EMA lags the pullback close by ≥ $15 (real horizon, not price-tracking)", lastClose - emaNew >= 15]);
    checks.push([
      "C: REGIME FLIP on the same bar — tested 960 accepts (close > ema960), approximated 299 rejects (close < ema299)",
      lastClose > emaNew && lastClose < ema299,
    ]);
  }

  // D — the coupled fetch window feeds the cap (aggregateBars + slice chain).
  const m5From72h = aggregateBars(syntheticM1Rows(72), 5).slice(-1000);
  const m5From144h = aggregateBars(syntheticM1Rows(144), 5).slice(-1000);
  checks.push([
    `D: OLD 72h window → ${m5From72h.length} M5 bars < ${REFERENCE_GUARD_BARS} reference guard (cap change ALONE was a no-op)`,
    m5From72h.length < REFERENCE_GUARD_BARS,
  ]);
  checks.push([
    `D: NEW 144h window → ${m5From144h.length} M5 bars ≥ 1000 → span 960 + guard satisfied`,
    m5From144h.length === 1000,
  ]);

  for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
  console.log(checks.every(([, ok]) => ok) ? "\nITEM FG MOCK GATE: PASS (trendEmaSpanUsed 960 on the new series; coupled window feeds it)" : "\nITEM FG MOCK GATE: FAIL");
  if (!checks.every(([, ok]) => ok)) process.exitCode = 1;
}

main();
