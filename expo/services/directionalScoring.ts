/**
 * DIRECTIONAL SCORING BOUNDARY
 * ============================
 *
 * Structural enforcement for the rule: *a tick-window-derived value may not
 * contribute to `buySignalStrength` / `sellSignalStrength`.*
 *
 * This is the same mechanism used for the B1 cascade — the accumulator's
 * signature simply cannot express a forbidden contribution, so a regression is
 * a COMPILE error rather than a code-review miss.
 *
 * How it works:
 *  - `DirectionalFeatureKey` is a CLOSED allowlist of the feature keys that may
 *    move the directional accumulators.
 *  - `TICK_DERIVED_DIRECTIONAL_KEYS` lists the keys that were removed on
 *    2026-08-02 because their value is computed from a 5/14/20/30-TICK window
 *    of `priceHistory` / `highHistory` / `lowHistory` (Capital.com / Swissquote
 *    ticks, or TwelveData/Yahoo H-L paired with tick closes).
 *  - `assertNoTickKeysInAllowlist` below is a type-level assertion: if anyone
 *    ever adds one of the forbidden keys back into `DirectionalFeatureKey`,
 *    the file stops compiling.
 *  - The tick features are STILL computed, STILL attached to the signal, and
 *    STILL logged — via `noteTelemetry`, which writes to a namespaced
 *    `tick_telemetry:*` key that can never collide with a scoring-key lookup
 *    (e.g. the confluence/alignment bonus, or the microstructure redundancy
 *    check). They remain measurable as the sample grows; they just cannot
 *    score.
 *
 * ITEM F UPDATE (2026-08-02) — RE-SOURCING, NOT RE-ADMITTING
 * ----------------------------------------------------------
 * The allowlist below now includes BAR-derived versions of the features that
 * were removed. This is NOT a reversal. The forbidden list is unchanged and
 * still enforced: a TICK-derived key can never score. What changed is that the
 * same market concepts are now computed from a sealed `BarSeries` (Supabase
 * `gold_m1_bars`, M5) in `services/barIndicators.ts`, whose branded input type
 * makes it impossible to feed them a tick array.
 *
 * The two barriers are complementary and both are compile-time:
 *   1. THIS module gates which KEYS may move the accumulators.
 *   2. `barIndicators.ts` gates which DATA may reach the indicators, via the
 *      unforgeable `BarSeries` brand produced only by `sealBarSeries()`.
 * A regression needs to defeat both, and each is a build break.
 *
 * F0 POSITION, restated so it can never be mis-cited: the tick stream is NOT
 * STORED, so a historical tick-vs-bar A/B at signal level is IMPOSSIBLE — not
 * underpowered. The bar re-sourcing is a DESIGN decision on first-principles
 * grounds (an indicator whose period is denominated in tick observations has no
 * fixed time base and is therefore not that indicator), verified for
 * CORRECTNESS against reference series and to be validated for PERFORMANCE on
 * forward data only.
 *
 * WHY THE TICK REMOVAL EXISTS (record it plainly so it is never mis-cited):
 * This removal is a DESIGN decision taken on FIRST-PRINCIPLES grounds, not an
 * evidence-backed measurement result. Item C established that at n=369 the
 * comparison is UNDERPOWERED — several of these features fire ~16 times in the
 * whole export, and neither the tick basis nor the bar basis could be
 * distinguished from the book baseline. The decision is: an input that cannot
 * be validated, and whose construction (direction inferred from five ticks)
 * is indefensible on first principles, must not carry directional weight in a
 * live system. The BAR-based replacements were deliberately NOT wired in, for
 * the mirror-image reason: they are equally unvalidated at this sample size,
 * and adding new unvalidated weight is the Item 3 mistake repeated.
 */

/** Keys whose value derives from a tick window. May NEVER score. */
export const TICK_DERIVED_DIRECTIONAL_KEYS = [
  'strong_uptrend',
  'strong_downtrend',
  'strong_uptrend_pattern',
  'strong_downtrend_pattern',
  'bullish_reversal',
  'bearish_reversal',
  'above_vwap',
  'below_vwap',
  'adx_trend_strength',
  'bollinger_squeeze_bull_breakout',
  'bollinger_squeeze_bear_breakout',
] as const;

export type TickDerivedDirectionalKey = typeof TICK_DERIVED_DIRECTIONAL_KEYS[number];

/**
 * CLOSED allowlist of keys permitted to move the directional accumulators.
 * Every member is derived from daily bars, 5-min candles, S/R zones, session
 * structure, or intermarket data — never from a tick window.
 */
export type DirectionalFeatureKey =
  // HTF/LTF x RSI setup family (routed through the learned rsi_weight)
  | 'rsi_learned_modulation'
  // Candlestick patterns (5-min OHLC candles)
  | 'bullish_engulfing'
  | 'bearish_engulfing'
  | 'bullish_pin_bar'
  | 'bearish_pin_bar'
  // S/R structure
  | 'strong_support_proximity'
  | 'strong_resistance_proximity'
  | 'multi_touch_sr_confirmation'
  | `sr_zone_${string}`
  // Levels
  | 'fibonacci_alignment'
  | 'bullish_quasimodo'
  | 'bearish_quasimodo'
  // Momentum on bar closes
  | 'bullish_ema_crossover'
  | 'bearish_ema_crossover'
  | 'bullish_macd_momentum'
  | 'bearish_macd_momentum'
  // Divergence (M5 bar swing extremes vs M5-bar RSI — same series for both)
  | 'bullish_divergence'
  | 'bearish_divergence'
  // Session structure
  | 'session_low_sweep'
  | 'session_high_sweep'
  // Intermarket penalty
  | 'dxy_headwind'
  // ── ITEM F: bar-sourced replacements for the six removed tick features ──
  // Each is computed by barIndicators.ts from a sealed M5 BarSeries. The `bar_`
  // prefix is load-bearing: it makes the data provenance of a scoring key
  // readable at the call site and keeps these keys textually distinct from the
  // forbidden tick keys in every log, export and attention map.
  | 'bar_strong_uptrend'
  | 'bar_strong_downtrend'
  | 'bar_strong_uptrend_pattern'
  | 'bar_strong_downtrend_pattern'
  | 'bar_bullish_reversal'
  | 'bar_bearish_reversal'
  | 'bar_above_vwap'
  | 'bar_below_vwap'
  | 'bar_adx_trend_strength'
  | 'bar_bollinger_squeeze_bull_breakout'
  | 'bar_bollinger_squeeze_bear_breakout';

/**
 * Type-level guard. If a forbidden key is ever added back to the allowlist,
 * `Extract<...>` stops being `never` and this alias fails to resolve, breaking
 * the build. Do not delete.
 */
type AssertNoTickKeysInAllowlist =
  Extract<DirectionalFeatureKey, TickDerivedDirectionalKey> extends never ? true : never;
export const assertNoTickKeysInAllowlist: AssertNoTickKeysInAllowlist = true;

/** Namespace applied to non-scoring telemetry so it can never be read as a scoring key. */
export const TICK_TELEMETRY_PREFIX = 'tick_telemetry:' as const;

/**
 * Accumulates directional strength. The only way to move `buy` / `sell` is
 * through `addBuy` / `addSell` / `penalizeBuy` / `penalizeSell`, all of which
 * demand a key from the bar-derived allowlist.
 */
export class DirectionalScoreAccumulator {
  private buyStrength: number = 0;
  private sellStrength: number = 0;

  /**
   * @param attention shared attention-score map (also carries pure telemetry
   *                  entries written directly by the caller).
   */
  constructor(private readonly attention: Map<string, number>) {}

  get buy(): number {
    return this.buyStrength;
  }

  get sell(): number {
    return this.sellStrength;
  }

  addBuy(key: DirectionalFeatureKey, weight: number, recordAttention: boolean = true): void {
    this.buyStrength += weight;
    if (recordAttention) this.attention.set(key, weight);
  }

  addSell(key: DirectionalFeatureKey, weight: number, recordAttention: boolean = true): void {
    this.sellStrength += weight;
    if (recordAttention) this.attention.set(key, weight);
  }

  /**
   * Add an already-capped aggregate whose individual components were each
   * recorded in `attention` at their own key. `contributingKeys` is unused at
   * runtime — it exists purely so the allowlist type still gates what may be
   * folded into the aggregate.
   */
  addCappedBuy(contributingKeys: readonly DirectionalFeatureKey[], weight: number): void {
    void contributingKeys;
    this.buyStrength += weight;
  }

  addCappedSell(contributingKeys: readonly DirectionalFeatureKey[], weight: number): void {
    void contributingKeys;
    this.sellStrength += weight;
  }

  penalizeBuy(key: DirectionalFeatureKey, penalty: number): void {
    this.buyStrength = Math.max(0, this.buyStrength - penalty);
    this.attention.set(key, -penalty);
  }

  penalizeSell(key: DirectionalFeatureKey, penalty: number): void {
    this.sellStrength = Math.max(0, this.sellStrength - penalty);
    this.attention.set(key, -penalty);
  }

  /**
   * Record a feature for measurement WITHOUT any scoring effect. Used for the
   * removed tick-window features so they remain observable as the sample grows.
   * The `tick_telemetry:` prefix guarantees no scoring-key lookup can match.
   */
  noteTelemetry(key: TickDerivedDirectionalKey, value: number): void {
    this.attention.set(`${TICK_TELEMETRY_PREFIX}${key}`, value);
  }
}
