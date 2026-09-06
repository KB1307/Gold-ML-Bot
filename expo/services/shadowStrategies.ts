/**
 * ITEMS BA–BD — SHADOW STRATEGY FORWARD BOOKS (WRITE-ONLY).
 *
 * Two backtest-derived strategies (18-month XAU/USD M5 backtest, matched
 * random-entry nulls, untouched holdout) recorded as shadow entries at signal
 * emission time. Neither suppresses, delays, nor modifies any existing signal —
 * these functions are pure detection + one fire-and-forget persistence helper.
 *
 *   SCORED_DT_SHORT   — sell M5 double tops near session levels, filtered by a
 *                       7-feature composite score (backtest: 61% WR, +$1.37/trade).
 *   SCORED_REOPEN_LONG — buy the first bar after the daily maintenance break,
 *                       2-of-3 context conditions (backtest: 65% WR, +$2.41/trade).
 *
 * PRE-REGISTERED FORWARD GATES (Items BC/BD reporting; not changeable later):
 *   DT_SHORT promotion: ABOVE n_decided >= 100 AND EV > 0; abort: first 50
 *   ABOVE-decided EV <= 0. REOPEN promotion: n_decided >= 60 AND EV > 0;
 *   abort: first 40 ABOVE-decided EV <= 0.
 *
 * CANDIDATE-NAME ISOLATION: 'SCORED_DT_SHORT' / 'SCORED_REOPEN_LONG' collide
 * with no existing candidate_name (verified by grep: BAND_VETO_SUPPRESSED,
 * DRIFT_VETO_SUPPRESSED, MID_RSI_SUPPRESSED, EXIT_SHADOW_LADDER, LDN-FADE,
 * TREND-CONTINUATION). Every query in Items BC/BD must use STRICT name equality.
 *
 * SCHEMA NOTE (Item BA verification — live code wins): shadow_candidates_v1 has
 * NO signal_id / score / metadata columns. Actual columns (migration 016):
 * candidate_name, evaluated_at, direction, entry, sl, tp1, tp2, tp3, inputs
 * (jsonb), created_at. The strategy's signalId, score, scoreVerdict, pattern
 * details and tested geometry are therefore written into `inputs` (jsonb).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeSideRelativeFeatures, emaSpan } from "@/services/modelFitting";

/** Minimal M5 bar the detectors operate on (ascending by timestamp, no lookahead). */
export interface ShadowM5Bar {
  readonly timestamp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session windows — replicated VERBATIM from modelFitting.ts (private there;
// the Items BA–BD scope constraint forbids modifying modelFitting.ts, so the
// bytes are duplicated rather than the function exported). Provenance:
// modelFitting.ts SESSION_WINDOWS_UTC / sessionWindowBoundsUtc.
// DISCREPANCY vs prompt (live code wins): the prompt says to import
// sessionWindowBoundsUtc from modelFitting.ts — it is not exported.
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_WINDOWS_UTC: ReadonlyArray<{ readonly startH: number; readonly endH: number }> = [
  { startH: 0, endH: 7 },
  { startH: 7, endH: 12 },
  { startH: 12, endH: 22 },
];
const SESSION_HOUR_MS = 60 * 60 * 1000;

interface SessionWindow {
  readonly startMs: number;
  readonly endMs: number;
}

function sessionWindowBoundsUtcReplica(anchorMs: number): SessionWindow[] {
  const anchor = new Date(anchorMs);
  const dayStartUtc = Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth(),
    anchor.getUTCDate(),
  );
  return SESSION_WINDOWS_UTC.map(({ startH, endH }) => ({
    startMs: dayStartUtc + startH * SESSION_HOUR_MS,
    endMs: dayStartUtc + endH * SESSION_HOUR_MS,
  }));
}

/** Item AH semantics: candidate windows span the trailing 72h (anchor day + 3 prior days). */
function trailing72hSessionWindows(anchorMs: number): SessionWindow[] {
  return [
    ...sessionWindowBoundsUtcReplica(anchorMs - 72 * SESSION_HOUR_MS),
    ...sessionWindowBoundsUtcReplica(anchorMs - 48 * SESSION_HOUR_MS),
    ...sessionWindowBoundsUtcReplica(anchorMs - 24 * SESSION_HOUR_MS),
    ...sessionWindowBoundsUtcReplica(anchorMs),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORED_DT_SHORT — double-top sells at session levels, scored by 7 features.
// ─────────────────────────────────────────────────────────────────────────────

/** ABOVE threshold (≈ backtest top quartile; the forward gate auto-calibrates). */
export const DT_SCORE_ABOVE_THRESHOLD = 2.0;

const DT_ZONE_TOLERANCE_USD = 3.0; // second touch within $3 of the A level (high)
const DT_CLOSE_INSIDE_USD = 0.5; // close at most A + $0.5 (back inside the zone)
const DT_CLOSE_TOLERANCE_USD = 3.0; // |close - A| <= $3
const DT_MIN_PULLBACK_USD = 4.0; // pullback between touches >= $4
const DT_SESSION_PROXIMITY_USD = 2.0; // A within $2 of a session H/L
const DT_SWING_WINDOW_BARS = 96; // swing candidate lookback (8h of M5)
const DT_SWING_MARGIN_BARS = 6; // swing must be >= 6 bars back

export interface DoubleTopSignal {
  detected: boolean;
  /** The A level (swing-high price of the first touch). */
  swingHighPrice: number | null;
  /** Index of the first touch in the passed bars. */
  swingHighBar: number | null;
  /** $ depth of the pullback between the two touches. */
  pullbackDepth: number | null;
  /** $ distance from A to the nearest completed-session H/L (72h candidates). */
  sessionLevelDistance: number | null;
  /** Composite score from the 7 feat_* values; null if any feature not computable. */
  score: number | null;
  scoreVerdict: "ABOVE" | "BELOW" | null;
}

const DT_NOT_DETECTED: DoubleTopSignal = {
  detected: false,
  swingHighPrice: null,
  swingHighBar: null,
  pullbackDepth: null,
  sessionLevelDistance: null,
  score: null,
  scoreVerdict: null,
};

/**
 * Detects a scored double-top SHORT setup on the LAST bar of `m5Bars`.
 * Short-only by design — returns `detected: false` for BUY emissions.
 * Pure function: no state, no side effects, no suppression of anything.
 */
export function detectDoubleTop(params: {
  m5Bars: ReadonlyArray<ShadowM5Bar>;
  entryPrice: number;
  direction: "BUY" | "SELL";
  /** 14-period RSI (null passthrough — live code wins: computeSideRelativeFeatures takes number|null). */
  rsi: number | null;
}): DoubleTopSignal {
  const { m5Bars, entryPrice, direction, rsi } = params;
  if (direction !== "SELL") return DT_NOT_DETECTED;
  const n = m5Bars.length;
  // Swing window [n-96, n-6] with a ±2-bar fractal needs n >= 98.
  if (n < DT_SWING_WINDOW_BARS + 2) return DT_NOT_DETECTED;
  const i = n - 1;
  const last = m5Bars[i];

  // 1) Most recent fractal swing high in [n-96, n-6] (largest qualifying j).
  let swingBar = -1;
  let levelA = Number.NaN;
  const jMin = Math.max(2, n - DT_SWING_WINDOW_BARS);
  const jMax = n - DT_SWING_MARGIN_BARS;
  for (let k = jMax; k >= jMin; k -= 1) {
    const h = m5Bars[k].high;
    if (
      h > m5Bars[k - 1].high &&
      h > m5Bars[k - 2].high &&
      h > m5Bars[k + 1].high &&
      h > m5Bars[k + 2].high
    ) {
      swingBar = k;
      levelA = h;
      break;
    }
  }
  if (swingBar < 0 || !Number.isFinite(levelA)) return DT_NOT_DETECTED;

  // 2) Second touch on the last bar: back into the zone on a red candle.
  if (Math.abs(last.high - levelA) > DT_ZONE_TOLERANCE_USD) return DT_NOT_DETECTED;
  if (last.close > levelA + DT_CLOSE_INSIDE_USD) return DT_NOT_DETECTED;
  if (Math.abs(last.close - levelA) > DT_CLOSE_TOLERANCE_USD) return DT_NOT_DETECTED;
  if (!(last.close < last.open)) return DT_NOT_DETECTED;

  // 3) Pullback of at least $4 between the two touches.
  let pullbackLow = Infinity;
  for (let k = swingBar + 1; k <= i - 1; k += 1) {
    if (m5Bars[k].low < pullbackLow) pullbackLow = m5Bars[k].low;
  }
  if (!Number.isFinite(pullbackLow) || pullbackLow > levelA - DT_MIN_PULLBACK_USD) {
    return DT_NOT_DETECTED;
  }
  const pullbackDepth = levelA - pullbackLow;

  // 4) Session-level confluence (BINARY): A within $2 of at least one
  // completed-session high/low from the trailing 72h. Bar-coverage guard is
  // byte-identical to feat_session_level_count: a session counts ONLY when the
  // passed bars FULLY cover it (window end <= anchor — completed only).
  let sessionLevelDistance: number | null = null;
  const firstBarMs = m5Bars[0].timestamp;
  const anchorMs = last.timestamp;
  for (const w of trailing72hSessionWindows(anchorMs)) {
    if (!(firstBarMs <= w.startMs && w.endMs <= anchorMs)) continue;
    let high = -Infinity;
    let low = Infinity;
    let seen = 0;
    for (const bar of m5Bars) {
      if (bar.timestamp >= w.startMs && bar.timestamp < w.endMs) {
        if (bar.high > high) high = bar.high;
        if (bar.low < low) low = bar.low;
        seen += 1;
      }
    }
    if (seen === 0 || !Number.isFinite(high) || !Number.isFinite(low)) continue;
    const d = Math.min(Math.abs(high - levelA), Math.abs(low - levelA));
    if (d <= DT_SESSION_PROXIMITY_USD && (sessionLevelDistance === null || d < sessionLevelDistance)) {
      sessionLevelDistance = d;
    }
  }
  if (sessionLevelDistance === null) return DT_NOT_DETECTED;

  // 5) Composite score from the 7 Item AB features (same values scored at
  // emission). Backtest sign convention: rsi_aligned and at_day_extreme are
  // BAD for this strategy (negative); the rest positive. zonePrices is not a
  // parameter of the DT pattern (per prompt) — [] yields feat_zone_max_react 0
  // (a defined value in modelFitting, not missing data).
  const f = computeSideRelativeFeatures({
    direction,
    entryPrice,
    rsi,
    m5Bars: m5Bars as ReadonlyArray<{ readonly timestamp: number; readonly high: number; readonly low: number; readonly close: number }>,
    zonePrices: [],
  });
  const signedComponents: ReadonlyArray<number | null> = [
    f.feat_trend_aligned,
    f.feat_rsi_aligned === null ? null : -f.feat_rsi_aligned,
    f.feat_ema_stack,
    f.feat_session_level_count,
    f.feat_at_day_extreme === null ? null : -f.feat_at_day_extreme,
    f.feat_zone_max_react,
    f.feat_near_round50,
  ];
  if (signedComponents.some((c) => c === null)) {
    // Pattern is real but scoring unavailable — report detected with null score.
    return { ...DT_NOT_DETECTED, detected: true, swingHighPrice: levelA, swingHighBar: swingBar, pullbackDepth, sessionLevelDistance };
  }
  const score = signedComponents.reduce<number>((acc, c) => acc + (c as number), 0);
  return {
    detected: true,
    swingHighPrice: levelA,
    swingHighBar: swingBar,
    pullbackDepth,
    sessionLevelDistance,
    score,
    scoreVerdict: score >= DT_SCORE_ABOVE_THRESHOLD ? "ABOVE" : "BELOW",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORED_REOPEN_LONG — buys the first bar after the daily maintenance break.
// ─────────────────────────────────────────────────────────────────────────────

const REOPEN_EMA_FAST_SPAN = 20;
const REOPEN_EMA_SLOW_SPAN = 50;
const REOPEN_GAP_USD = 0.5; // gap-down threshold
const REOPEN_BIG_MOVE_USD = 15; // prior-day move threshold
const REOPEN_DAY_BARS = 288; // ≈ 1 day of M5 bars
const REOPEN_SCORE_ABOVE = 2; // 2 of 3 conditions

export interface ReopenSignal {
  detected: boolean;
  /** Count of true conditions (0–3); null only when not detected. */
  score: number | null;
  scoreVerdict: "ABOVE" | "BELOW" | null;
  ema20AboveEma50: boolean;
  gapDown: boolean;
  priorDayBigMove: boolean;
}

const REOPEN_NOT_DETECTED: ReopenSignal = {
  detected: false,
  score: null,
  scoreVerdict: null,
  ema20AboveEma50: false,
  gapDown: false,
  priorDayBigMove: false,
};

/**
 * Detects a scored reopen LONG: the entry bar is the first bar after the daily
 * maintenance break (`isReopen`), scored by 3 binary context conditions.
 * Long-only by design — returns `detected: false` unless `isReopen` is true.
 * The LAST bar of `m5Bars` is the entry bar; conditions use bars up to but NOT
 * including it (the pre-gap bars). Pure function.
 */
export function detectScoredReopen(params: {
  m5Bars: ReadonlyArray<ShadowM5Bar>;
  isReopen: boolean;
  /** Open of the entry bar. */
  entryPrice: number;
  /** Close of the bar before the gap. */
  priorClose: number;
}): ReopenSignal {
  const { m5Bars, isReopen, entryPrice, priorClose } = params;
  if (!isReopen) return REOPEN_NOT_DETECTED;
  const n = m5Bars.length;
  // The EMA50 condition needs >= 50 pre-gap bars (emaSpan returns null below).
  if (n < REOPEN_EMA_SLOW_SPAN + 2) return REOPEN_NOT_DETECTED;

  const preGap = m5Bars.slice(0, -1);
  const closes = preGap.map((b) => b.close);
  const emaFast = emaSpan(closes, REOPEN_EMA_FAST_SPAN);
  const emaSlow = emaSpan(closes, REOPEN_EMA_SLOW_SPAN);
  const ema20AboveEma50 = emaFast !== null && emaSlow !== null ? emaFast > emaSlow : false;

  const gapDown = entryPrice < priorClose - REOPEN_GAP_USD;

  // Prior-day move: priorClose vs the close ~288 bars back (earliest if fewer).
  const backIdx = preGap.length - 1 - REOPEN_DAY_BARS;
  const close288Back = backIdx >= 0 ? preGap[backIdx].close : preGap[0].close;
  const priorDayBigMove = Math.abs(priorClose - close288Back) > REOPEN_BIG_MOVE_USD;

  const score = (ema20AboveEma50 ? 1 : 0) + (gapDown ? 1 : 0) + (priorDayBigMove ? 1 : 0);
  return {
    detected: true,
    score,
    scoreVerdict: score >= REOPEN_SCORE_ABOVE ? "ABOVE" : "BELOW",
    ema20AboveEma50,
    gapDown,
    priorDayBigMove,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — one row per qualifying pattern, fire-and-forget.
// ─────────────────────────────────────────────────────────────────────────────

export type ShadowCandidateName = "SCORED_DT_SHORT" | "SCORED_REOPEN_LONG";

/**
 * The strategies' TESTED geometry (Item BD write-side, applied from day one so
 * no row ever lacks it): fixed SL $12 / TP $10, 8h time stop, no lock, no
 * partial exits. The core resolver's standard geometry does NOT match — see
 * Items BC/BD for how the books are read.
 */
export const SHADOW_STRATEGY_GEOMETRY = { sl: 12, tp: 10, timeStopBars: 96 } as const;

/**
 * Inserts one row into shadow_candidates_v1. WRITE-ONLY shadow telemetry —
 * mirrors counterTrendShadow.ts exactly: log-and-swallow on failure, never
 * throws, never delays or crashes the emission path.
 *
 * Schema mapping (verified against migration 016 — no signal_id/score/metadata
 * columns exist): signalId, score, scoreVerdict, geometry and the pattern's
 * metadata go into the `inputs` jsonb column; sl/tp1 are written as PRICES
 * derived from the tested geometry (SELL: stop above entry, target below;
 * BUY mirrored); tp2/tp3 stay null (single-target strategies).
 */
export async function persistShadowStrategy(params: {
  supabaseClient: SupabaseClient;
  signalId: string;
  candidateName: ShadowCandidateName;
  direction: "BUY" | "SELL";
  entryPrice: number;
  /** ISO timestamp of the emission. */
  emittedAt: string;
  score: number;
  scoreVerdict: "ABOVE" | "BELOW";
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { supabaseClient, signalId, candidateName, direction, entryPrice, emittedAt, score, scoreVerdict, metadata } = params;
  try {
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    const slPrice = direction === "SELL"
      ? entryPrice + SHADOW_STRATEGY_GEOMETRY.sl
      : entryPrice - SHADOW_STRATEGY_GEOMETRY.sl;
    const tp1Price = direction === "SELL"
      ? entryPrice - SHADOW_STRATEGY_GEOMETRY.tp
      : entryPrice + SHADOW_STRATEGY_GEOMETRY.tp;
    const { error } = await supabaseClient.from("shadow_candidates_v1").insert({
      candidate_name: candidateName,
      evaluated_at: new Date(emittedAt).toISOString(),
      direction,
      entry: r2(entryPrice),
      sl: r2(slPrice),
      tp1: r2(tp1Price),
      tp2: null,
      tp3: null,
      inputs: {
        signalId,
        score,
        scoreVerdict,
        geometry: SHADOW_STRATEGY_GEOMETRY,
        ...metadata,
      },
    });
    if (error) {
      console.warn(`[ShadowStrategies] WRITE_FAILED (fire-and-forget, emission unaffected): ${error.message}`);
    } else {
      console.log(`[ShadowStrategies] ${candidateName} row persisted (score=${score} ${scoreVerdict})`);
    }
  } catch (err: unknown) {
    console.warn(`[ShadowStrategies] WRITE_ERROR (fire-and-forget, emission unaffected): ${err instanceof Error ? err.message : String(err)}`);
  }
}
