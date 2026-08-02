/**
 * ITEM F2 — CORRECTNESS TESTS FOR THE BAR-BASED DIRECTIONAL LAYER
 * ===============================================================
 *
 * F0 POSITION (repeated here so the test can never be mis-cited):
 * The tick stream is NOT STORED, so a historical tick-vs-bar A/B at signal
 * level is IMPOSSIBLE, not underpowered. This file therefore tests the ONE
 * thing that IS verifiable now — that each indicator computes the textbook
 * quantity it claims to compute. It says NOTHING about profitability.
 *
 * Every case below has an INDEPENDENT reference:
 *  - RSI: Wilder's published 33-close worked example (New Concepts in
 *    Technical Trading Systems; the series reproduced by StockCharts).
 *  - EMA: hand-computable closed form.
 *  - MACD: analytic steady-state lag of an EMA over a linear ramp —
 *    EMA(n) lags a ramp of slope s by s*(n-1)/2, so MACD = s*((slow-1)-(fast-1))/2.
 *  - ADX: a strictly non-overlapping monotonic uptrend has -DM == 0 for every
 *    bar, hence -DI == 0 and DX == 100 by definition.
 *  - ATR / VWAP / Bollinger / trend strength: hand-computed closed forms.
 *  - Divergence / LTF / regime / price action: constructed cases with the
 *    expected classification derived from the definition, not from the code.
 */

import {
  aggregateBars,
  barADX,
  barATR,
  barBollinger,
  barBollingerBreakout,
  barDivergence,
  barEMACrossover,
  barLTFTrend,
  barMACDHistogram,
  barPriceActionPattern,
  barRSI,
  barRegime,
  barTrendStrength,
  barVWAP,
  ema,
  isBarSeriesFresh,
  macd,
  rsiWilder,
  sealBarSeries,
  type Bar,
} from '../services/barIndicators';

let passed = 0;
let failed = 0;

function check(name: string, expected: string, actual: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}\n       expected: ${expected}\n       actual:   ${actual}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       expected: ${expected}\n       actual:   ${actual}`);
  }
}

function near(name: string, expected: number, actual: number | null, tol: number): void {
  const ok = actual !== null && Math.abs(actual - expected) <= tol;
  check(name, `${expected} (±${tol})`, actual === null ? 'null' : actual.toFixed(6), ok);
}

function eq<T>(name: string, expected: T, actual: T): void {
  check(name, String(expected), String(actual), expected === actual);
}

/** Build a sealed series from OHLC tuples on a 5-minute base. */
// Aligned to a 15-minute boundary so M5 and M15 aggregation buckets start on
// bar 0. (An earlier draft used an unaligned epoch, which split the first
// bucket -- again a TEST error, not a code error: aggregateBars floors to
// absolute wall-clock buckets, which is the correct behaviour.)
const ALIGNED_START_MS = Math.floor(1_750_000_000_000 / 900_000) * 900_000;

function series(ohlc: readonly (readonly [number, number, number, number])[], startMs = ALIGNED_START_MS) {
  const bars: Bar[] = ohlc.map((v, i) => ({
    timestamp: startMs + i * 300_000,
    open: v[0],
    high: v[1],
    low: v[2],
    close: v[3],
  }));
  return sealBarSeries(bars);
}

/** Build a sealed series from closes only (flat OHLC), for close-only indicators. */
function closeSeries(closes: readonly number[]) {
  return series(closes.map(c => [c, c, c, c] as const));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 1. RSI(14) — Wilder\'s published worked example ═══');
// ═══════════════════════════════════════════════════════════════════════════

const WILDER_CLOSES = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
  45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028,
  46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
  45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628,
  43.1314,
];

/** Published RSI(14) values, one per close from index 14 onward. */
const WILDER_RSI_EXPECTED = [
  70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38,
  54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77,
];

let rsiAllOk = true;
for (let i = 0; i < WILDER_RSI_EXPECTED.length; i++) {
  const prefix = WILDER_CLOSES.slice(0, 15 + i);
  const actual = rsiWilder(prefix, 14);
  const expected = WILDER_RSI_EXPECTED[i];
  const ok = actual !== null && Math.abs(actual - expected) <= 0.01;
  if (!ok) rsiAllOk = false;
  console.log(
    `  ${ok ? '✅' : '❌'} close[${(14 + i).toString().padStart(2)}]=${prefix[prefix.length - 1].toFixed(4)}` +
    `  expected RSI ${expected.toFixed(2)}  actual ${actual === null ? 'null' : actual.toFixed(2)}`,
  );
}
check('RSI(14) matches all 19 published values (±0.01)', 'all 19 match', rsiAllOk ? 'all 19 match' : 'MISMATCH', rsiAllOk);

eq('RSI returns null below period+1 closes', 'null', String(rsiWilder(WILDER_CLOSES.slice(0, 14), 14)));
near('RSI of a monotonically rising series = 100', 100, rsiWilder(Array.from({ length: 40 }, (_, i) => 100 + i), 14), 1e-9);
near('RSI of a flat series = 50 (no gains, no losses)', 50, rsiWilder(Array.from({ length: 40 }, () => 100), 14), 1e-9);
near('barRSI() on a sealed series equals rsiWilder() on its closes',
  rsiWilder(WILDER_CLOSES, 14) ?? -1, barRSI(closeSeries(WILDER_CLOSES), 14), 1e-12);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 2. EMA — hand-computable closed form ═══');
// ═══════════════════════════════════════════════════════════════════════════

// EMA(3) of [1,2,3,4,5]: seed = SMA(1,2,3) = 2; k = 2/4 = 0.5
//   i=3: 4*0.5 + 2*0.5   = 3
//   i=4: 5*0.5 + 3*0.5   = 4
near('EMA(3) of [1,2,3,4,5] = 4 (hand-computed)', 4, ema([1, 2, 3, 4, 5], 3), 1e-12);
// EMA(2) of [10,20,30]: seed = 15; k = 2/3;  30*(2/3) + 15*(1/3) = 25
near('EMA(2) of [10,20,30] = 25 (hand-computed)', 25, ema([10, 20, 30], 2), 1e-12);
near('EMA(period) with exactly `period` values = SMA', 2, ema([1, 2, 3], 3), 1e-12);
eq('EMA returns null below `period` values (tick version returned raw spot here)', 'null', String(ema([1, 2], 3)));
near('EMA of a constant series = that constant', 42, ema(Array.from({ length: 100 }, () => 42), 21), 1e-12);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 3. MACD(12,26,9) — analytic steady-state lag on a ramp ═══');
// ═══════════════════════════════════════════════════════════════════════════

// For a linear ramp of slope s, an EMA(n) converges to lagging the true value
// by s*(n-1)/2. So MACD line -> s*((26-1)/2 - (12-1)/2) = s*7, and because the
// MACD line is then CONSTANT, its EMA(9) signal equals it and histogram -> 0.
const ramp = Array.from({ length: 600 }, (_, i) => 1000 + i * 1); // s = 1
const rampMacd = macd(ramp);
near('MACD line on slope-1 ramp = 7.0 (analytic)', 7, rampMacd?.macd ?? null, 0.001);
near('MACD signal on slope-1 ramp = 7.0 (analytic)', 7, rampMacd?.signal ?? null, 0.001);
near('MACD histogram on slope-1 ramp = 0.0 (analytic)', 0, rampMacd?.histogram ?? null, 0.001);

const ramp2 = Array.from({ length: 600 }, (_, i) => 1000 + i * 2.5); // s = 2.5
near('MACD line on slope-2.5 ramp = 17.5 (analytic)', 17.5, macd(ramp2)?.macd ?? null, 0.005);

const downRamp = Array.from({ length: 600 }, (_, i) => 3000 - i * 1);
near('MACD line on slope-(-1) ramp = -7.0 (analytic)', -7, macd(downRamp)?.macd ?? null, 0.001);

near('MACD on a constant series = 0', 0, macd(Array.from({ length: 200 }, () => 2000))?.macd ?? null, 1e-9);
eq('MACD returns null below slow+signal closes', 'null', String(macd(Array.from({ length: 34 }, (_, i) => i))));
near('barMACDHistogram() on a sealed ramp series = 0 (analytic)', 0, barMACDHistogram(closeSeries(ramp)), 0.001);

// EMA crossover sign check on the same ramps (9 > 21 > 50 on a rising ramp).
const upCross = barEMACrossover(closeSeries(ramp));
const downCross = barEMACrossover(closeSeries(downRamp));
check('EMA 9/21/50 crossover is POSITIVE on a rising ramp', '> 0',
  upCross === null ? 'null' : upCross.toFixed(4), upCross !== null && upCross > 0);
check('EMA 9/21/50 crossover is NEGATIVE on a falling ramp', '< 0',
  downCross === null ? 'null' : downCross.toFixed(4), downCross !== null && downCross < 0);
near('EMA crossover on a flat series = 0', 0, barEMACrossover(closeSeries(Array.from({ length: 200 }, () => 2000))), 1e-9);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 4. ATR(14) — hand-computed closed form ═══');
// ═══════════════════════════════════════════════════════════════════════════

// Every bar: high = c+1, low = c-1 (range 2), close = c, consecutive closes equal
// -> TR = max(2, |c+1-c|, |c-1-c|) = 2 for every bar, so ATR = 2 exactly.
const flatRangeBars = series(Array.from({ length: 60 }, () => [2000, 2001, 1999, 2000] as const));
near('ATR(14) of constant-range-2, no-gap bars = 2.0 (hand-computed)', 2, barATR(flatRangeBars, 14), 1e-12);
eq('ATR returns null below period+1 bars', 'null', String(barATR(series(Array.from({ length: 10 }, () => [1, 2, 0, 1] as const)), 14)));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 5. ADX(14) — definitional extreme cases ═══');
// ═══════════════════════════════════════════════════════════════════════════

// Strictly non-overlapping monotonic uptrend: low[i] > high[i-1] is not needed,
// only that down-move (low[i-1]-low[i]) <= 0 for every bar, which makes -DM = 0
// for every bar, hence -DI = 0 and DX = 100*|+DI - 0|/(+DI) = 100 by definition.
const upBars = series(Array.from({ length: 80 }, (_, i) => {
  const base = 2000 + i * 3;
  return [base, base + 2, base - 1, base + 1] as const;
}));
const upAdx = barADX(upBars, 14);
near('ADX(14) of a strictly monotonic uptrend = 100 (definitional)', 100, upAdx?.adx ?? null, 1e-9);
near('  ...and -DI = 0 (no down-moves exist)', 0, upAdx?.minusDI ?? null, 1e-9);
check('  ...and +DI > 0', '> 0', upAdx === null ? 'null' : upAdx.plusDI.toFixed(4), (upAdx?.plusDI ?? 0) > 0);

const downBars = series(Array.from({ length: 80 }, (_, i) => {
  const base = 3000 - i * 3;
  return [base, base + 1, base - 2, base - 1] as const;
}));
const downAdx = barADX(downBars, 14);
near('ADX(14) of a strictly monotonic downtrend = 100 (definitional)', 100, downAdx?.adx ?? null, 1e-9);
near('  ...and +DI = 0 (no up-moves exist)', 0, downAdx?.plusDI ?? null, 1e-9);

// Perfectly repeating bars: no directional movement at all -> +DM = -DM = 0 -> DX = 0.
const noMoveBars = series(Array.from({ length: 80 }, () => [2000, 2001, 1999, 2000] as const));
near('ADX(14) of identical repeating bars = 0 (no directional movement)', 0, barADX(noMoveBars, 14)?.adx ?? null, 1e-9);
eq('ADX returns null below 2*period+1 bars', 'null', String(barADX(series(Array.from({ length: 20 }, () => [1, 2, 0, 1] as const)), 14)));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 6. VWAP — hand-computed closed form ═══');
// ═══════════════════════════════════════════════════════════════════════════

// Bar i: high = 101+i, low = 99+i, close = 100+i -> typical = 100+i, weight = 2 (equal).
// Equal weights => VWAP = mean(typical) = mean(100..109) = 104.5
const vwapBars = series(Array.from({ length: 10 }, (_, i) => [100 + i, 101 + i, 99 + i, 100 + i] as const));
near('VWAP of 10 equal-weight bars, typicals 100..109 = 104.5 (hand-computed)', 104.5, barVWAP(vwapBars, 30), 1e-12);
eq('VWAP returns null below 10 bars', 'null', String(barVWAP(series(Array.from({ length: 9 }, () => [1, 2, 0, 1] as const)), 30)));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 7. Bollinger(20,2) — hand-computed closed form ═══');
// ═══════════════════════════════════════════════════════════════════════════

// 20 closes alternating 100 / 102 -> mean = 101, population variance = 1, sd = 1.
// upper = 103, lower = 99, bandwidth = (103-99)/101*100 = 3.960396...%
const bbCloses = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 100 : 102));
const bb = barBollinger(closeSeries(bbCloses), 20, 2);
near('Bollinger middle of alternating 100/102 = 101 (hand-computed)', 101, bb?.middle ?? null, 1e-12);
near('Bollinger upper = 103 (mean + 2*sd, sd = 1)', 103, bb?.upper ?? null, 1e-12);
near('Bollinger lower = 99  (mean - 2*sd, sd = 1)', 99, bb?.lower ?? null, 1e-12);
near('Bollinger bandwidth = 3.960396% (hand-computed)', 3.9603960396, bb?.bandwidth ?? null, 1e-8);

const flatBB = barBollinger(closeSeries(Array.from({ length: 40 }, () => 2000)), 20, 2);
near('Bollinger bandwidth of a flat series = 0', 0, flatBB?.bandwidth ?? null, 1e-12);
eq('  ...and it is classified as a SQUEEZE', 'true', String(flatBB?.squeeze));

// Breakout direction: last close pushed above the upper band -> +1.
const breakoutUp = closeSeries([...Array.from({ length: 20 }, () => 2000), 2050]);
eq('Bollinger breakout direction above upper band = +1', 1, barBollingerBreakout(breakoutUp, 20));
const breakoutDown = closeSeries([...Array.from({ length: 20 }, () => 2000), 1950]);
eq('Bollinger breakout direction below lower band = -1', -1, barBollingerBreakout(breakoutDown, 20));
eq('Bollinger breakout direction inside the bands = 0', 0, barBollingerBreakout(closeSeries(bbCloses), 20));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 8. Trend strength (efficiency ratio) — closed form ═══');
// ═══════════════════════════════════════════════════════════════════════════

near('Efficiency ratio of a monotonic ramp = 1.0', 1,
  barTrendStrength(closeSeries(Array.from({ length: 40 }, (_, i) => 100 + i)), 20), 1e-12);
// Perfect zig-zag, 41 closes alternating 100/102. The 20-bar window is closes
// [21..40] = 102 ... 100, so net move = 2 and traversed = 19 * 2 = 38.
// Closed form = 2/38 = 1/19 = 0.052631578947...  (An earlier draft of this test
// asserted 0.0, which was the TEST's arithmetic error, not the code's: a
// 20-element window of a 2-cycle alternation always ends one step off its start.)
near('Efficiency ratio of a perfect zig-zag = 1/19 (closed form)', 1 / 19,
  barTrendStrength(closeSeries(Array.from({ length: 41 }, (_, i) => (i % 2 === 0 ? 100 : 102))), 20), 1e-12);
near('Efficiency ratio of a flat series = 0 (no movement at all)', 0,
  barTrendStrength(closeSeries(Array.from({ length: 40 }, () => 100)), 20), 1e-12);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 9. LTF trend (EMA 9/21 with ATR hysteresis) ═══');
// ═══════════════════════════════════════════════════════════════════════════

const ltfUp = series(Array.from({ length: 80 }, (_, i) => {
  const c = 2000 + i * 2;
  return [c, c + 1, c - 1, c] as const;
}));
eq('LTF trend of a steady uptrend = BULLISH', 'BULLISH', barLTFTrend(ltfUp));

const ltfDown = series(Array.from({ length: 80 }, (_, i) => {
  const c = 3000 - i * 2;
  return [c, c + 1, c - 1, c] as const;
}));
eq('LTF trend of a steady downtrend = BEARISH', 'BEARISH', barLTFTrend(ltfDown));

// Flat market with real range: EMA9 == EMA21, separation 0 < band -> NEUTRAL.
const ltfFlat = series(Array.from({ length: 80 }, (_, i) => {
  const c = 2000 + (i % 2 === 0 ? 0.2 : -0.2);
  return [c, c + 1, c - 1, c] as const;
}));
eq('LTF trend of a flat/chopping market = NEUTRAL', 'NEUTRAL', barLTFTrend(ltfFlat));
eq('LTF trend with too few bars = NEUTRAL (stand aside)', 'NEUTRAL',
  barLTFTrend(series(Array.from({ length: 5 }, () => [2000, 2001, 1999, 2000] as const))));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 10. Regime + price action (ATR-relative, not absolute $) ═══');
// ═══════════════════════════════════════════════════════════════════════════

const regimeTrend = barRegime(ltfUp);
eq('Regime of a steady uptrend = TRENDING', 'TRENDING', regimeTrend?.type ?? 'null');

// Same trend shape but the last 15 bars have 4x the range -> short ATR / long ATR > 1.3.
const volBars = series(Array.from({ length: 80 }, (_, i) => {
  const c = 2000 + i * 0.05;
  const r = i >= 65 ? 8 : 1;
  return [c, c + r, c - r, c] as const;
}));
eq('Regime with a 8x range expansion in the last 15 bars = VOLATILE', 'VOLATILE', barRegime(volBars)?.type ?? 'null');

const quietBars = series(Array.from({ length: 80 }, (_, i) => {
  const c = 2000 + i * 0.05;
  const r = i >= 65 ? 0.2 : 4;
  return [c, c + r, c - r, c] as const;
}));
eq('Regime with a 20x range contraction in the last 15 bars = QUIET', 'QUIET', barRegime(quietBars)?.type ?? 'null');
eq('Regime returns null below 60 bars (stand aside)', 'null',
  String(barRegime(series(Array.from({ length: 30 }, () => [2000, 2001, 1999, 2000] as const)))));

// Price action: base ATR is ~2; append 5 bars advancing ~3 ATR in a clean line.
// A clean advance has range ~= net move, so the ORIGINAL formulation
// (`netMove > ATR && range < 2.5*ATR`) could never fire for a move this size --
// it fell through to HIGH_VOLATILITY_BREAKOUT. That defect was found by this
// test and fixed by switching the cleanliness test to the efficiency ratio.
const paUp = series([
  ...Array.from({ length: 40 }, () => [2000, 2001, 1999, 2000] as const),
  ...Array.from({ length: 5 }, (_, i) => {
    const c = 2000 + (i + 1) * 1.2;
    return [c - 1.2, c + 0.3, c - 1.5, c] as const;
  }),
]);
eq('Price action of a clean 3-ATR advance in 5 bars = STRONG_UPTREND', 'STRONG_UPTREND', barPriceActionPattern(paUp) ?? 'null');

const paFlat = series(Array.from({ length: 45 }, () => [2000, 2000.05, 1999.95, 2000] as const));
eq('Price action of a dead-flat tape = CONSOLIDATION', 'CONSOLIDATION', barPriceActionPattern(paFlat) ?? 'null');
eq('Price action returns null below lookback+15 bars (stand aside)', 'null',
  String(barPriceActionPattern(series(Array.from({ length: 12 }, () => [2000, 2001, 1999, 2000] as const)))));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 11. RSI divergence (same bar series for BOTH price and RSI) ═══');
// ═══════════════════════════════════════════════════════════════════════════

// Bearish: build a strong advance (RSI high, >60), then a marginal higher high
// achieved with weakening momentum so RSI(now) < RSI(5 bars ago).
const bearishDiv = series([
  ...Array.from({ length: 30 }, (_, i) => {
    const c = 2000 + i * 3;
    return [c, c + 1, c - 1, c] as const;
  }),
  // stall: barely-higher highs, closes flat/down -> RSI rolls over
  ...Array.from({ length: 5 }, (_, i) => {
    const c = 2087 - i * 0.4;
    return [c, 2090 + i * 0.2, c - 1, c] as const;
  }),
]);
const bd = barDivergence(bearishDiv);
check('Bearish divergence: higher high + falling RSI + RSI>60 -> detected', 'bearish=true',
  `bearish=${bd.bearish} (${bd.detail})`, bd.bearish);

const bullishDiv = series([
  ...Array.from({ length: 30 }, (_, i) => {
    const c = 2100 - i * 3;
    return [c, c + 1, c - 1, c] as const;
  }),
  ...Array.from({ length: 5 }, (_, i) => {
    const c = 2013 + i * 0.4;
    return [c, c + 1, 2010 - i * 0.2, c] as const;
  }),
]);
const bud = barDivergence(bullishDiv);
check('Bullish divergence: lower low + rising RSI + RSI<40 -> detected', 'bullish=true',
  `bullish=${bud.bullish} (${bud.detail})`, bud.bullish);

const noDiv = barDivergence(closeSeries(Array.from({ length: 60 }, (_, i) => 2000 + i)));
check('Clean trend with confirming momentum -> NO divergence', 'bullish=false bearish=false',
  `bullish=${noDiv.bullish} bearish=${noDiv.bearish}`, !noDiv.bullish && !noDiv.bearish);

const shortDiv = barDivergence(closeSeries([2000, 2001, 2002]));
check('Divergence on too few bars -> false/false, no throw', 'bullish=false bearish=false',
  `bullish=${shortDiv.bullish} bearish=${shortDiv.bearish}`, !shortDiv.bullish && !shortDiv.bearish);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ 12. Aggregation + staleness (F1 plumbing) ═══');
// ═══════════════════════════════════════════════════════════════════════════

const m1: Bar[] = Array.from({ length: 15 }, (_, i) => ({
  timestamp: ALIGNED_START_MS + i * 60_000,
  open: 2000 + i,
  high: 2000 + i + 0.5,
  low: 2000 + i - 0.5,
  close: 2000 + i + 0.2,
}));
const m5 = aggregateBars(m1, 5);
eq('15 M1 bars aggregate to 3 M5 bars', 3, m5.length);
eq('  M5[0].open = M1[0].open', m1[0].open, m5[0].open);
eq('  M5[0].close = M1[4].close', m1[4].close, m5[0].close);
eq('  M5[0].high = max(M1[0..4].high)', Math.max(...m1.slice(0, 5).map(b => b.high)), m5[0].high);
eq('  M5[0].low  = min(M1[0..4].low)', Math.min(...m1.slice(0, 5).map(b => b.low)), m5[0].low);
const m15 = aggregateBars(m1, 15);
eq('15 M1 bars aggregate to 1 M15 bar', 1, m15.length);
eq('  M15[0].close = M1[14].close', m1[14].close, m15[0].close);

const freshBars = sealBarSeries(m1);
const lastTs = m1[m1.length - 1].timestamp;
eq('isBarSeriesFresh: newest bar 5min old, limit 15min -> true', true, isBarSeriesFresh(freshBars, lastTs + 5 * 60_000, 15 * 60_000));
eq('isBarSeriesFresh: newest bar 30min old, limit 15min -> false', false, isBarSeriesFresh(freshBars, lastTs + 30 * 60_000, 15 * 60_000));
eq('isBarSeriesFresh: empty series -> false', false, isBarSeriesFresh(sealBarSeries([]), Date.now(), 15 * 60_000));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(70));
console.log(`BAR INDICATOR CORRECTNESS: ${passed} passed, ${failed} failed`);
console.log('='.repeat(70));
if (failed > 0) process.exit(1);
