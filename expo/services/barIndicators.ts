/**
 * BAR-BASED DIRECTIONAL INDICATORS  (ITEM F)
 * ==========================================
 *
 * F0 — MEASUREMENT POSITION, STATED UP FRONT AND IN CODE
 * ------------------------------------------------------
 * The tick stream (`priceHistory` / Capital.com / Swissquote) is **NOT STORED**.
 * There is no historical record of what the 5/15/20/30-tick windows contained at
 * each of the 369 exported signals' generation instants. Therefore a historical
 * signal-level A/B of "tick-sourced indicator" vs "bar-sourced indicator" is
 * **IMPOSSIBLE — not underpowered, impossible**. No sample size fixes it; the
 * counterfactual input series does not exist.
 *
 * This module is consequently a **DESIGN DECISION taken on FIRST-PRINCIPLES
 * grounds**, to be validated on FORWARD data only:
 *
 *   RSI(14) over `priceHistory.slice(-15)` is not RSI(14). A tick window has no
 *   fixed time base — 15 ticks may span 8 seconds during a news burst or 6
 *   minutes in a dead Asian hour. The same is true of EMA-9/21/50 over ticks
 *   (`calculateRealEMACrossover`), MACD-12/26/9 over ticks
 *   (`calculateRealMACD`), and the 5-tick momentum classifier
 *   (`detectLTFTrend`). These are sound indicators fed a fundamentally wrong
 *   input series: their period parameter is denominated in *observations* while
 *   every published interpretation of them is denominated in *time*.
 *
 * WHAT IS VERIFIABLE NOW: **correctness**. Every function below is checked
 * against an independent reference (Wilder's published RSI series, analytically
 * derivable EMA/MACD steady-state lag, hand-computed Bollinger/VWAP/ADX cases)
 * in `scripts/test_bar_indicators.ts`, with expected-vs-actual pasted.
 *
 * WHAT IS NOT VERIFIABLE NOW: **performance**. Nothing in this module may ever
 * be cited as an evidence-backed improvement in win rate, EV or profit factor.
 * See F6 in the accompanying report for the pre-registered forward test.
 *
 * DATA-SOURCE RULE
 * ----------------
 * Every function here accepts a `BarSeries`, a NOMINALLY BRANDED array type that
 * can only be produced by `sealBarSeries()`. `sealBarSeries` is called in
 * exactly one place — the Supabase `gold_m1_bars` aggregation path in
 * signalEngine. A plain `number[]` (i.e. `priceHistory`) or a plain bar array
 * from any other venue is a COMPILE ERROR at every call site in this module.
 * That is the F1/F4 structural guarantee: no GC=F, no TwelveData, no ticks.
 */

/** A single OHLC bar on a fixed time base. */
export interface Bar {
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

declare const barSeriesBrand: unique symbol;

/**
 * A bar series that has been PROVEN to originate from Supabase `gold_m1_bars`.
 * The brand is unforgeable outside `sealBarSeries`, so no tick array and no
 * foreign-venue array can reach any indicator in this module.
 */
export type BarSeries = readonly Bar[] & { readonly [barSeriesBrand]: true };

/** The timeframe a `BarSeries` is denominated in. Carried for logging/tests. */
export type BarTimeframe = 'M1' | 'M5' | 'M15';

/**
 * THE ONLY producer of a `BarSeries`. Call sites must be auditable by grep:
 * `grep -n "sealBarSeries(" services/`. It must appear only in the
 * gold_m1_bars aggregation path.
 *
 * @param bars ascending-by-timestamp OHLC bars aggregated from gold_m1_bars
 */
export function sealBarSeries(bars: readonly Bar[]): BarSeries {
  return bars as BarSeries;
}

/** Aggregate ascending M1 bars into a coarser timeframe. Pure. */
export function aggregateBars(m1: readonly Bar[], minutes: number): Bar[] {
  const bucketMs = minutes * 60 * 1000;
  const grouped = new Map<number, { timestamp: number; open: number; high: number; low: number; close: number }>();
  for (const bar of m1) {
    const bucket = Math.floor(bar.timestamp / bucketMs) * bucketMs;
    const existing = grouped.get(bucket);
    if (!existing) {
      grouped.set(bucket, { timestamp: bucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
    }
  }
  return [...grouped.values()].sort((a, b) => a.timestamp - b.timestamp);
}

const closesOf = (bars: BarSeries): number[] => bars.map(b => b.close);

// ── RSI ─────────────────────────────────────────────────────────────────────

/**
 * Wilder's RSI. The previous tick implementation used a SIMPLE average of gains
 * and losses over the window, which is not Wilder's RSI even setting the input
 * series aside — Wilder smooths recursively:
 *   avgGain_t = (avgGain_{t-1} * (period - 1) + gain_t) / period
 *
 * Reference: J. Welles Wilder, *New Concepts in Technical Trading Systems*,
 * the 33-close worked example reproduced by StockCharts. Verified in
 * `scripts/test_bar_indicators.ts`.
 *
 * @returns 0-100, or `null` when there are fewer than `period + 1` closes.
 */
export function rsiWilder(closes: readonly number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** RSI on the series truncated `barsBack` bars from the end. Used for divergence. */
export function rsiWilderAt(closes: readonly number[], barsBack: number, period: number = 14): number | null {
  if (barsBack <= 0) return rsiWilder(closes, period);
  if (closes.length <= barsBack) return null;
  return rsiWilder(closes.slice(0, closes.length - barsBack), period);
}

/** RSI(14) on a sealed bar series. */
export function barRSI(bars: BarSeries, period: number = 14): number | null {
  return rsiWilder(closesOf(bars), period);
}

// ── EMA / MACD ──────────────────────────────────────────────────────────────

/**
 * Standard EMA: SMA of the first `period` values as the seed, then
 * `ema = value * k + ema * (1 - k)` with `k = 2 / (period + 1)`.
 *
 * @returns `null` when there are fewer than `period` values (the previous tick
 *          implementation silently returned the last raw value here, which made
 *          a cold EMA-50 indistinguishable from spot price).
 */
export function ema(values: readonly number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const k = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i++) acc += values[i];
  let e = acc / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

/** Full EMA series (aligned so index 0 corresponds to input index `period - 1`). */
export function emaSeries(values: readonly number[], period: number): number[] {
  if (period <= 0 || values.length < period) return [];
  const k = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i++) acc += values[i];
  let e = acc / period;
  const out: number[] = [e];
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

export interface MacdResult {
  readonly macd: number;
  readonly signal: number;
  readonly histogram: number;
}

/**
 * MACD(12, 26, 9). The previous tick implementation rebuilt only NINE MACD
 * points and then took an EMA-9 of that nine-length array seeded on all nine —
 * i.e. an SMA in disguise, and computed over a tick series whose 26 "periods"
 * had no fixed duration. This version builds the full MACD line series and
 * takes a true EMA-9 signal line.
 */
export function macd(
  closes: readonly number[],
  fast: number = 12,
  slow: number = 26,
  signalPeriod: number = 9,
): MacdResult | null {
  if (closes.length < slow + signalPeriod) return null;
  const fastSeries = emaSeries(closes, fast);
  const slowSeries = emaSeries(closes, slow);
  // Align: fastSeries[i] maps to close index i + fast - 1.
  const offset = slow - fast;
  const macdLine: number[] = [];
  for (let i = 0; i < slowSeries.length; i++) {
    macdLine.push(fastSeries[i + offset] - slowSeries[i]);
  }
  const signal = ema(macdLine, signalPeriod);
  if (signal === null) return null;
  const line = macdLine[macdLine.length - 1];
  return { macd: line, signal, histogram: line - signal };
}

/** MACD histogram on a sealed bar series. */
export function barMACDHistogram(bars: BarSeries): number | null {
  const r = macd(closesOf(bars));
  return r === null ? null : r.histogram;
}

/**
 * EMA 9/21/50 crossover strength, normalised to a price-relative scale
 * (identical formula to the tick version so the downstream ±0.5 thresholds keep
 * their meaning) — only the input series changes from ticks to bars.
 */
export function barEMACrossover(bars: BarSeries): number | null {
  const closes = closesOf(bars);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  if (e9 === null || e21 === null || e50 === null) return null;
  const last = closes[closes.length - 1];
  if (!(last > 0)) return null;
  return ((e9 - e21) * 0.6 + (e21 - e50) * 0.4) / last * 1000;
}

// ── LTF trend ───────────────────────────────────────────────────────────────

export type TrendVerdict = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

/**
 * Bar-based LTF trend. Replaces the 5-TICK momentum classifier.
 *
 * Design: EMA-9 vs EMA-21 on the bar series, with a hysteresis band scaled by
 * the series' own ATR so it adapts to the volatility regime instead of the
 * previous hand-tuned price-relative floor/cap that investigation showed was
 * structurally unreachable. Requires the separation to exceed
 * `bandAtrFraction * ATR(14)`; otherwise NEUTRAL.
 */
export function barLTFTrend(bars: BarSeries, bandAtrFraction: number = 0.25): TrendVerdict {
  const closes = closesOf(bars);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const atrValue = barATR(bars, 14);
  if (e9 === null || e21 === null || atrValue === null || atrValue <= 0) return 'NEUTRAL';
  const band = atrValue * bandAtrFraction;
  const separation = e9 - e21;
  if (separation > band) return 'BULLISH';
  if (separation < -band) return 'BEARISH';
  return 'NEUTRAL';
}

// ── ATR / ADX ───────────────────────────────────────────────────────────────

/** Wilder ATR over a sealed bar series. */
export function barATR(bars: BarSeries, period: number = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    ));
  }
  let atrValue = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atrValue = (atrValue * (period - 1) + trs[i]) / period;
  }
  return atrValue;
}

export interface AdxResult {
  readonly adx: number;
  readonly plusDI: number;
  readonly minusDI: number;
}

/**
 * Wilder ADX with directional indicators. The previous implementation returned
 * a single-window DX (not a smoothed ADX) and paired bar highs/lows with TICK
 * closes by shared array index across two independently-populated arrays.
 */
export function barADX(bars: BarSeries, period: number = 14): AdxResult | null {
  if (bars.length < period * 2 + 1) return null;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const prevClose = bars[i - 1].close;
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    ));
  }

  const wilderSmooth = (series: readonly number[]): number[] => {
    let acc = series.slice(0, period).reduce((a, b) => a + b, 0);
    const out: number[] = [acc];
    for (let i = period; i < series.length; i++) {
      acc = acc - acc / period + series[i];
      out.push(acc);
    }
    return out;
  };

  const trS = wilderSmooth(trs);
  const pdmS = wilderSmooth(plusDM);
  const mdmS = wilderSmooth(minusDM);

  const dxs: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    if (trS[i] === 0) { dxs.push(0); continue; }
    const pdi = 100 * (pdmS[i] / trS[i]);
    const mdi = 100 * (mdmS[i] / trS[i]);
    const sum = pdi + mdi;
    dxs.push(sum === 0 ? 0 : 100 * Math.abs(pdi - mdi) / sum);
  }
  if (dxs.length < period) return null;

  let adxValue = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    adxValue = (adxValue * (period - 1) + dxs[i]) / period;
  }

  const lastTR = trS[trS.length - 1];
  const plusDI = lastTR === 0 ? 0 : 100 * (pdmS[pdmS.length - 1] / lastTR);
  const minusDI = lastTR === 0 ? 0 : 100 * (mdmS[mdmS.length - 1] / lastTR);
  return { adx: adxValue, plusDI, minusDI };
}

// ── VWAP ────────────────────────────────────────────────────────────────────

/**
 * Session-anchored VWAP over the last `lookback` bars, weighted by each bar's
 * true range as a volume proxy (`gold_m1_bars` carries tick_volume but the M5
 * aggregation path does not currently select it; range-weighting is the same
 * proxy the previous implementation used, so only the input series changes).
 */
export function barVWAP(bars: BarSeries, lookback: number = 30): number | null {
  if (bars.length < 10) return null;
  const window = bars.slice(-Math.min(lookback, bars.length));
  let num = 0;
  let den = 0;
  for (const bar of window) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    const weight = Math.max(0.1, bar.high - bar.low);
    num += typical * weight;
    den += weight;
  }
  if (den === 0) return null;
  return num / den;
}

// ── Bollinger ───────────────────────────────────────────────────────────────

export interface BollingerResult {
  readonly middle: number;
  readonly upper: number;
  readonly lower: number;
  readonly bandwidth: number;
  readonly squeeze: boolean;
  readonly expansion: boolean;
}

export function barBollinger(
  bars: BarSeries,
  period: number = 20,
  stdDevMultiplier: number = 2,
): BollingerResult | null {
  const closes = closesOf(bars);
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const mean = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + stdDevMultiplier * sd;
  const lower = mean - stdDevMultiplier * sd;
  const bandwidth = mean === 0 ? 0 : (upper - lower) / mean * 100;
  return {
    middle: mean,
    upper,
    lower,
    bandwidth,
    squeeze: bandwidth < 0.35,
    expansion: bandwidth > 1.2,
  };
}

/**
 * Bollinger breakout direction on BARS. Replaces `detectPriceDirection()`,
 * which was `priceHistory.slice(-5)` — five ticks.
 * @returns +1 bullish break, -1 bearish break, 0 inside the bands.
 */
export function barBollingerBreakout(bars: BarSeries, period: number = 20): number {
  const bb = barBollinger(bars, period);
  if (bb === null || bars.length === 0) return 0;
  const last = bars[bars.length - 1].close;
  if (last > bb.upper) return 1;
  if (last < bb.lower) return -1;
  return 0;
}

// ── Trend strength / regime / price action ──────────────────────────────────

/** Efficiency ratio: |net move| / sum(|bar-to-bar move|) over `lookback` bars. */
export function barTrendStrength(bars: BarSeries, lookback: number = 20): number | null {
  const closes = closesOf(bars);
  if (closes.length < lookback) return null;
  const window = closes.slice(-lookback);
  const net = Math.abs(window[window.length - 1] - window[0]);
  let total = 0;
  for (let i = 1; i < window.length; i++) total += Math.abs(window[i] - window[i - 1]);
  if (total === 0) return 0;
  return Math.min(1, net / total);
}

export type RegimeType = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET';

export interface RegimeResult {
  readonly type: RegimeType;
  readonly strength: number;
}

/**
 * Bar-based regime. Thresholds are expressed RELATIVE to the series' own median
 * true range rather than the previous absolute $8.5/$11 constants, which were
 * calibrated against a tick-derived pseudo-ATR and do not transfer to a genuine
 * M5 ATR.
 */
export function barRegime(bars: BarSeries): RegimeResult | null {
  if (bars.length < 60) return null;
  const atrShort = barATR(sealBarSeries(bars.slice(-15)), 14);
  const atrLong = barATR(bars, 14);
  const strengthRaw = barTrendStrength(bars, 20);
  if (atrShort === null || atrLong === null || strengthRaw === null || atrLong <= 0) return null;

  const volRatio = atrShort / atrLong;
  if (volRatio > 1.3) {
    return { type: 'VOLATILE', strength: Math.min(1, 0.8 + (volRatio - 1.3) * 0.4) };
  }
  if (volRatio < 0.7) {
    return { type: 'QUIET', strength: Math.min(1, 0.6 + (0.7 - volRatio) * 0.4) };
  }
  if (strengthRaw > 0.6) {
    return { type: 'TRENDING', strength: Math.min(1, 0.7 + strengthRaw * 0.2) };
  }
  return { type: 'RANGING', strength: Math.max(0.3, 0.5 + (1 - strengthRaw) * 0.3) };
}

export type PriceActionPattern =
  | 'STRONG_UPTREND'
  | 'STRONG_DOWNTREND'
  | 'CONSOLIDATION'
  | 'HIGH_VOLATILITY_BREAKOUT'
  | 'BULLISH_REVERSAL'
  | 'BEARISH_REVERSAL'
  | 'NEUTRAL';

/**
 * Bar-based price-action classifier. Replaces `priceHistory.slice(-5)`.
 *
 * Two changes from the original beyond the input series:
 *
 * 1. Thresholds are ATR-relative, not absolute dollars, so the classifier means
 *    the same thing in a $6-ATR session as in a $16-ATR one.
 *
 * 2. "Cleanliness" is measured by the EFFICIENCY RATIO, not by absolute range.
 *    The original tested `trend > 10 && volatility < 20` — net move against
 *    total range with a fixed 2:1 ratio. That test is self-defeating: in a
 *    genuinely clean directional advance the range IS approximately the net
 *    move, so any move larger than ~2.5 ATR necessarily fails the range test
 *    and falls through to HIGH_VOLATILITY_BREAKOUT. The strongest, cleanest
 *    trends were therefore systematically misclassified as volatility events.
 *    Caught by the correctness suite; see test 10.
 */
export function barPriceActionPattern(bars: BarSeries, lookback: number = 5): PriceActionPattern | null {
  if (bars.length < lookback + 15) return null;
  const atrValue = barATR(bars, 14);
  if (atrValue === null || atrValue <= 0) return null;
  const recent = bars.slice(-lookback);
  const netMove = recent[recent.length - 1].close - recent[0].open;
  const range = Math.max(...recent.map(b => b.high)) - Math.min(...recent.map(b => b.low));

  let traversed = 0;
  for (let i = 1; i < recent.length; i++) traversed += Math.abs(recent[i].close - recent[i - 1].close);
  const efficiency = traversed === 0 ? 0 : Math.abs(netMove) / traversed;
  const CLEAN = 0.6;

  if (Math.abs(netMove) < atrValue * 0.35 && range < atrValue * 1.2) return 'CONSOLIDATION';
  if (netMove > atrValue && efficiency > CLEAN) return 'STRONG_UPTREND';
  if (netMove < -atrValue && efficiency > CLEAN) return 'STRONG_DOWNTREND';
  if (range > atrValue * 3.0) return 'HIGH_VOLATILITY_BREAKOUT';
  const n = recent.length;
  if (recent[n - 1].close > recent[n - 2].close && recent[n - 2].close < recent[n - 3].close) return 'BULLISH_REVERSAL';
  if (recent[n - 1].close < recent[n - 2].close && recent[n - 2].close > recent[n - 3].close) return 'BEARISH_REVERSAL';
  return 'NEUTRAL';
}

// ── Divergence ──────────────────────────────────────────────────────────────

export interface DivergenceResult {
  readonly bullish: boolean;
  readonly bearish: boolean;
  readonly detail: string;
}

/**
 * RSI divergence on bars. The previous version compared `highHistory[4]` with
 * `highHistory[9]` — arbitrary fixed offsets into a 10-element array, paired
 * with an RSI computed on a DIFFERENT (tick) series. This version compares the
 * current swing extreme with the extreme `pivotSeparation` bars earlier and
 * evaluates RSI at the same two points on the SAME bar series.
 */
export function barDivergence(
  bars: BarSeries,
  pivotSeparation: number = 5,
  period: number = 14,
): DivergenceResult {
  const none: DivergenceResult = { bullish: false, bearish: false, detail: 'insufficient bars' };
  if (bars.length < period + pivotSeparation + 2) return none;

  const closes = closesOf(bars);
  const rsiNow = rsiWilder(closes, period);
  const rsiPrev = rsiWilderAt(closes, pivotSeparation, period);
  if (rsiNow === null || rsiPrev === null) return none;

  const recentHigh = Math.max(...bars.slice(-pivotSeparation).map(b => b.high));
  const priorHigh = Math.max(...bars.slice(-(pivotSeparation * 2), -pivotSeparation).map(b => b.high));
  const recentLow = Math.min(...bars.slice(-pivotSeparation).map(b => b.low));
  const priorLow = Math.min(...bars.slice(-(pivotSeparation * 2), -pivotSeparation).map(b => b.low));

  const bearish = recentHigh > priorHigh && rsiNow < rsiPrev && rsiNow > 60;
  const bullish = recentLow < priorLow && rsiNow > rsiPrev && rsiNow < 40;

  return {
    bullish,
    bearish,
    detail: `H ${priorHigh.toFixed(2)}→${recentHigh.toFixed(2)} L ${priorLow.toFixed(2)}→${recentLow.toFixed(2)} RSI ${rsiPrev.toFixed(1)}→${rsiNow.toFixed(1)}`,
  };
}

// ── Staleness ───────────────────────────────────────────────────────────────

/**
 * Bars are only usable if the most recent one is recent enough. F1 requires
 * standing aside rather than serving stale structure.
 *
 * @param maxAgeMs maximum permitted age of the newest bar's OPEN timestamp
 */
export function isBarSeriesFresh(bars: BarSeries, now: number, maxAgeMs: number): boolean {
  if (bars.length === 0) return false;
  return now - bars[bars.length - 1].timestamp <= maxAgeMs;
}
