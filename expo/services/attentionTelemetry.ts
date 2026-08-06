/**
 * ATTENTION-SIDE + COUNTER-TREND GATE TELEMETRY (ITEMS 28 & 29)
 * =============================================================
 *
 * This module exists to make two previously-unanswerable questions answerable
 * from a stored record, WITHOUT touching a single scoring input.
 *
 * ITEM 29 — the rendering defect it fixes.
 * `signalEngine` records every scored feature into one flat
 * `Map<string, number>` and the export printed `Math.abs(value) * 100`. Two
 * different things therefore rendered identically:
 *   - a +0.35 bullish contribution, and
 *   - a -0.12 penalty against the signal's own side.
 * And a bullish-family key (e.g. `counter_trend_bounce_setup`) printed on a
 * SELL row looked like evidence FOR that SELL, when it was recorded because
 * the BUY side of the accumulator moved. Every "SELL justified by bullish
 * features" reading of an export was an artefact of that rendering.
 *
 * The fix is deliberately NOT "guess the side from the key name". The side is
 * captured at the CALL SITE, by the accumulator that actually moved
 * (`DirectionalScoreAccumulator` writes into a parallel side map), so the
 * record states what happened rather than what a name suggests. The static
 * `ATTENTION_SIDE_BY_KEY` table below is only a fallback for entries written
 * straight into the attention map (never through the accumulator), and any key
 * that is not in it renders as `UNCLASSIFIED` — never as a guess.
 *
 * ITEM 28 — the instrumentation gap it fills.
 * The counter-trend classifier and the intraday drift veto decided outcomes
 * from four values that were only ever printed to a console log: the drift, the
 * ATR-scaled threshold, the sweep-reclaim flag and the resulting predicate. Log
 * retention is not a record, so "did the veto see what we think it saw" was not
 * answerable for any historical signal. `buildCounterTrendGateTelemetry` below
 * recomputes those four values as a pure, side-effect-free record that is
 * attached to the signal (and therefore persisted with it).
 *
 * WHY THIS CANNOT AFFECT SCORING (structural, not a promise):
 *  1. Nothing here imports the engine, and the engine only ever *writes* to
 *     these types — the builder takes primitives and returns a `Readonly<>`
 *     record of primitives.
 *  2. `AssertTelemetryKeysAreNotScoringKeys` is a compile-time assertion that
 *     no telemetry field name collides with a `DirectionalFeatureKey`. A
 *     telemetry field can therefore never be picked up by the engine's
 *     `attentionScores.get('<scoring key>')` lookups (the mechanism that
 *     *would* be the regression path), because such a lookup cannot name it.
 *  3. The side map is `string -> AttentionSide` (a string union). It is
 *     arithmetically unusable: there is no numeric value here to add into
 *     `buySignalStrength` / `sellSignalStrength` / `baseConfidence` even by
 *     accident.
 */

import type { DirectionalFeatureKey } from './directionalScoring';

/**
 * Which side of the accumulator an attention entry actually moved.
 *
 * `*_PENALTY` means the entry SUBTRACTED from that side (e.g. `penalizeBuy`),
 * so its favoured direction is the opposite one. `CONTEXT` means the entry is
 * recorded for measurement and moved neither side. `TELEMETRY` is a
 * non-scoring `tick_telemetry:*` entry. `UNCLASSIFIED` means the record does
 * not establish a side and none may be inferred.
 */
export type AttentionSide =
  | 'BUY'
  | 'SELL'
  | 'BUY_PENALTY'
  | 'SELL_PENALTY'
  | 'CONTEXT'
  | 'TELEMETRY'
  | 'UNCLASSIFIED';

/**
 * Fallback side table for attention entries written DIRECTLY into the map
 * (`attentionScores.set(...)`) rather than through the accumulator.
 *
 * Every entry below is transcribed from its own call site in `signalEngine`,
 * not inferred from the key's wording. Keys whose side is genuinely
 * call-site-dependent (`fibonacci_alignment`, `rsi_learned_modulation`, the
 * `sr_zone_*` family, `multi_touch_sr_confirmation`) are deliberately ABSENT:
 * they are recorded in whichever direction the engine was already leaning, so
 * the observed side from the accumulator is the only truthful source, and if
 * that is missing they must render `UNCLASSIFIED`.
 */
export const ATTENTION_SIDE_BY_KEY: Readonly<Record<string, AttentionSide>> = {
  // HTF/LTF setup family — written directly, side fixed by the branch.
  htf_ltf_bullish_alignment: 'BUY',
  counter_trend_bounce_setup: 'BUY',
  intraday_correction_in_uptrend: 'BUY',
  neutral_htf_oversold_buy: 'BUY',
  ltf_momentum_buy: 'BUY',
  htf_ltf_bearish_alignment: 'SELL',
  counter_trend_rejection_setup: 'SELL',
  intraday_bounce_in_downtrend: 'SELL',
  neutral_htf_overbought_sell: 'SELL',
  ltf_momentum_sell: 'SELL',
  // Bar-sourced patterns / candlesticks.
  bar_bullish_reversal: 'BUY',
  bar_strong_uptrend_pattern: 'BUY',
  bullish_engulfing: 'BUY',
  bullish_pin_bar: 'BUY',
  bar_bearish_reversal: 'SELL',
  bar_strong_downtrend_pattern: 'SELL',
  bearish_engulfing: 'SELL',
  bearish_pin_bar: 'SELL',
  // Session structure.
  session_low_sweep: 'BUY',
  session_high_sweep: 'SELL',
  // Structure proximity.
  strong_support_proximity: 'BUY',
  strong_resistance_proximity: 'SELL',
  bullish_quasimodo: 'BUY',
  bearish_quasimodo: 'SELL',
  bullish_ema_crossover: 'BUY',
  bearish_ema_crossover: 'SELL',
  bullish_macd_momentum: 'BUY',
  bearish_macd_momentum: 'SELL',
  bullish_divergence: 'BUY',
  bearish_divergence: 'SELL',
  bar_strong_uptrend: 'BUY',
  bar_strong_downtrend: 'SELL',
  bar_above_vwap: 'BUY',
  bar_below_vwap: 'SELL',
  bar_bollinger_squeeze_bull_breakout: 'BUY',
  bar_bollinger_squeeze_bear_breakout: 'SELL',
  // Non-directional context entries (recorded for measurement only).
  high_liquidity_session: 'CONTEXT',
  volatile_regime_context: 'CONTEXT',
  doji_context: 'CONTEXT',
  bollinger_expansion: 'CONTEXT',
  order_flow_context: 'CONTEXT',
  volume_node_support_resistance: 'CONTEXT',
};

/** Display form of a raw key, matching the engine's `_`->' ' + uppercase transform. */
function toDisplayForm(key: string): string {
  return key.replace(/_/g, ' ').toUpperCase();
}

const DISPLAY_TO_SIDE: Readonly<Record<string, AttentionSide>> = Object.freeze(
  Object.entries(ATTENTION_SIDE_BY_KEY).reduce<Record<string, AttentionSide>>((acc, [key, side]) => {
    acc[toDisplayForm(key)] = side;
    return acc;
  }, {}),
);

/**
 * Best-known side for an attention key, accepting either the raw key
 * (`session_high_sweep`) or the already-rendered display form
 * (`SESSION HIGH SWEEP`). Returns `TELEMETRY` for `tick_telemetry:*` entries
 * and `UNCLASSIFIED` when the key's side is genuinely not established.
 */
export function attentionSideForKey(key: string): AttentionSide {
  const trimmed = key.trim();
  if (/^tick[ _]telemetry/i.test(trimmed)) return 'TELEMETRY';
  const direct = ATTENTION_SIDE_BY_KEY[trimmed];
  if (direct) return direct;
  const display = DISPLAY_TO_SIDE[trimmed.toUpperCase()];
  if (display) return display;
  return 'UNCLASSIFIED';
}

/** The direction an attention entry actually favoured, or null when undetermined. */
export function attentionFavouredDirection(side: AttentionSide): 'BUY' | 'SELL' | null {
  switch (side) {
    case 'BUY':
      return 'BUY';
    case 'SELL':
      return 'SELL';
    case 'BUY_PENALTY':
      return 'SELL';
    case 'SELL_PENALTY':
      return 'BUY';
    default:
      return null;
  }
}

/**
 * True when the entry's favoured direction is the OPPOSITE of the signal that
 * carried it. Returns false (not "unknown") only when a side is established
 * and agrees; undetermined sides return false and must be rendered as
 * unclassified by the caller so absence is never read as agreement.
 */
export function attentionOpposesSignal(side: AttentionSide, signalType: 'BUY' | 'SELL'): boolean {
  const favoured = attentionFavouredDirection(side);
  if (favoured === null) return false;
  return favoured !== signalType;
}

/**
 * One-token annotation for an attention entry, used by the diagnostics export.
 * Shape is deliberately compact and greppable, e.g.
 *   `+35.0(buy-side,OPPOSES-SELL)` / `-12.0(buy-penalty,OPPOSES-BUY)`
 *   `+3.0(context)` / `+8.0(side-unclassified)`
 */
export function renderAttentionAnnotation(
  side: AttentionSide,
  signalType: 'BUY' | 'SELL' | null,
): string {
  if (side === 'CONTEXT') return 'context';
  if (side === 'TELEMETRY') return 'non-scoring telemetry';
  if (side === 'UNCLASSIFIED') return 'side-unclassified';
  const label =
    side === 'BUY' ? 'buy-side'
      : side === 'SELL' ? 'sell-side'
        : side === 'BUY_PENALTY' ? 'buy-penalty'
          : 'sell-penalty';
  if (signalType === null) return label;
  const favoured = attentionFavouredDirection(side);
  if (favoured === null) return label;
  return favoured === signalType ? `${label},supports-${signalType}` : `${label},OPPOSES-${signalType}`;
}

/**
 * ITEM 28 — durable record of what the counter-trend classifier and the
 * intraday drift veto actually saw for one signal.
 *
 * Every field is a JSON primitive so it round-trips through the `features`
 * jsonb column and AsyncStorage unchanged. `null` means "not computable for
 * this signal" (e.g. fewer than three 5-min candles existed, so there was no
 * drift to compute) and is deliberately distinct from `0`.
 */
export interface CounterTrendGateTelemetry {
  /** HTF trend label as the gate itself read it. */
  htfTrendAtGate: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** LTF trend label as the gate itself read it. */
  ltfTrendAtGate: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** Did the (B1-repaired) classifier call this signal counter-trend? */
  counterTrendClassified: boolean;
  /** Signed 5-min drift over DRIFT_LOOKBACK_CANDLES in dollars; null if uncomputable. */
  recentDrift: number | null;
  /** Drift re-signed so positive = against this signal's direction. */
  driftAgainst: number | null;
  /** atr * COUNTER_TREND_DRIFT_ATR_VETO, the value driftAgainst was compared to. */
  driftVetoThreshold: number | null;
  /** True when driftAgainst >= driftVetoThreshold, i.e. the veto predicate fired. */
  driftVetoPredicateTrue: boolean;
  /** Was a sweep with reversalConfirmed present at gate time? */
  sweepReclaimConfirmed: boolean;
  /** True when the predicate fired but the sweep+conviction override let it through. */
  driftVetoOverrideApplied: boolean;
  /** Real bid/ask spread (pips) applied to this entry; null when no reading existed. */
  spreadPipsAtEntry: number | null;
}

export interface CounterTrendGateTelemetryInput {
  signalType: 'BUY' | 'SELL';
  htfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  ltfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  counterTrendClassified: boolean;
  recentDrift: number | null;
  atr: number;
  driftAtrVetoMultiple: number;
  overrideConfidence: number;
  confidence: number;
  sweepReclaimConfirmed: boolean;
  spreadPips: number | null;
}

/**
 * Pure recomputation of the drift-veto arithmetic for the record.
 *
 * It mirrors the engine's own branch conditions exactly (drift only counts when
 * the signal was classified counter-trend AND atr > 0; `driftAgainst` is the
 * drift negated for BUYs; the override needs a confirmed sweep AND
 * confidence >= the override floor) so the stored record can be checked against
 * the engine's realised decision. It decides nothing itself — the engine's own
 * branches are untouched and this function's return value is never read back
 * into them.
 */
export function buildCounterTrendGateTelemetry(
  input: CounterTrendGateTelemetryInput,
): Readonly<CounterTrendGateTelemetry> {
  const driftMeasurable = input.counterTrendClassified && input.recentDrift !== null && input.atr > 0;
  const driftAgainst = driftMeasurable
    ? parseFloat(((input.signalType === 'BUY' ? -1 : 1) * (input.recentDrift as number)).toFixed(3))
    : null;
  const driftVetoThreshold = driftMeasurable
    ? parseFloat((input.atr * input.driftAtrVetoMultiple).toFixed(3))
    : null;
  const driftVetoPredicateTrue =
    driftAgainst !== null && driftVetoThreshold !== null && driftAgainst >= driftVetoThreshold;
  const driftVetoOverrideApplied =
    driftVetoPredicateTrue && input.sweepReclaimConfirmed && input.confidence >= input.overrideConfidence;

  return Object.freeze({
    htfTrendAtGate: input.htfTrend,
    ltfTrendAtGate: input.ltfTrend,
    counterTrendClassified: input.counterTrendClassified,
    recentDrift: input.recentDrift === null ? null : parseFloat(input.recentDrift.toFixed(3)),
    driftAgainst,
    driftVetoThreshold,
    driftVetoPredicateTrue,
    sweepReclaimConfirmed: input.sweepReclaimConfirmed,
    driftVetoOverrideApplied,
    spreadPipsAtEntry:
      input.spreadPips === null || !Number.isFinite(input.spreadPips) || input.spreadPips <= 0
        ? null
        : parseFloat(input.spreadPips.toFixed(3)),
  });
}

/**
 * Compile-time guard (mirrors `assertNoTickKeysInAllowlist` in
 * `directionalScoring.ts`): no telemetry field name may also be a scoring key,
 * so `attentionScores.get('<scoring key>')` can never resolve to telemetry.
 * If someone ever names a telemetry field after a scoring key, this alias stops
 * resolving and the build breaks. Do not delete.
 */
type AssertTelemetryKeysAreNotScoringKeys =
  Extract<keyof CounterTrendGateTelemetry, DirectionalFeatureKey> extends never ? true : never;
export const assertTelemetryKeysAreNotScoringKeys: AssertTelemetryKeysAreNotScoringKeys = true;
