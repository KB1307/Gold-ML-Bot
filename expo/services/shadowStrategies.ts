/**
 * ITEMS BA–BD / CA–CC — SHADOW STRATEGY FORWARD BOOKS (WRITE-ONLY).
 *
 * Three backtest-derived strategies (12–18-month XAU/USD M5 backtests, matched
 * random-entry nulls, untouched holdouts) recorded as shadow entries at signal
 * emission time. None suppresses, delays, or modifies any existing signal —
 * these functions are pure detection + one fire-and-forget persistence helper.
 *
 *   SCORED_DT_SHORT   — sell M5 double tops near session levels, filtered by a
 *                       7-feature composite score (backtest: 61% WR, +$1.19/trade).
 *   SCORED_REOPEN_LONG — buy the first bar after the daily maintenance break,
 *                       2-of-3 context conditions (backtest: 67% WR, +$2.59/trade).
 *   ZONE_RETEST_LONG  — buy the first retest of a CONFIRMED fractal swing low
 *                       with a strong first reaction, 4h-trend filtered (backtest:
 *                       65% WR, +$1.00/trade). ITEM CA. Causality asserted:
 *                       the zone is born at the confirmation bar (j+2), never
 *                       at the swing low — a prior lookahead version (+$2.66)
 *                       was retracted.
 *
 * PRE-REGISTERED FORWARD GATES (Items BC/BD/CB reporting; not changeable later):
 *   DT_SHORT promotion: ABOVE n_decided >= 100 AND EV > 0; abort: first 50
 *   ABOVE-decided EV <= 0. REOPEN promotion: n_decided >= 60 AND EV > 0;
 *   abort: first 40 ABOVE-decided EV <= 0. ZONE promotion: n_decided >= 100
 *   AND EV > 0; abort: first 50 ABOVE-decided EV <= 0.
 *
 * CANDIDATE-NAME ISOLATION: 'SCORED_DT_SHORT' / 'SCORED_REOPEN_LONG' /
 * 'ZONE_RETEST_LONG' collide with no existing candidate_name (verified by
 * grep: BAND_VETO_SUPPRESSED, DRIFT_VETO_SUPPRESSED, MID_RSI_SUPPRESSED,
 * EXIT_SHADOW_LADDER, LDN-FADE, TREND-CONTINUATION). Every query in Items
 * BC/BD/CB must use STRICT name equality.
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
// ZONE_RETEST_LONG — long-only, first retest of a CONFIRMED fractal swing low
// with a strong first reaction, 4h-trend filtered. ITEM CA.
//
// CAUSALITY IS THE WHOLE POINT: the zone is born at the CONFIRMATION bar
// (k = j + 2 — the bar that completes the 5-bar fractal), never at the swing
// low itself. A prior version created the zone at the swing-low bar, using two
// FUTURE bars to confirm the fractal — 86% of its signals were lookahead and
// its +$2.66/trade figure was retracted. The search bounds below guarantee
// k <= i - 4 for every candidate, and the assertion throws if that ever fails,
// so a lookahead signal cannot be written silently.
// ─────────────────────────────────────────────────────────────────────────────

export const ZRL_TOL = 4.0; // retest tolerance: |low - A| <= 4
export const ZRL_REACT_MIN = 10.0; // first reaction: max(high[j..k]) - A >= 10
export const ZRL_BOUNCE_MIN = 4.0; // pullback: max(high[k+1..i-1]) >= A + 4
export const ZRL_MAX_SEP = 96; // swing low must be within 96 bars before retest
export const ZRL_MIN_SEP = 3; // confirmation bar must be at least 3 bars before retest
export const ZRL_EMA_4H_SPAN = 960; // 48 bars x 20 = 4h EMA on M5
const ZRL_EMA_FAST_SPAN = 20;
const ZRL_EMA_SLOW_SPAN = 50;

export interface ZoneRetestSignal {
  detected: boolean;
  /** A — the zone level (the swing low price). */
  swingLowPrice: number | null;
  /** j — index of the swing low bar. */
  swingLowBar: number | null;
  /** k = j + 2 — the bar that confirmed the fractal; when the zone was born. */
  confirmationBar: number | null;
  /** max(high[j..k]) - A. */
  firstReaction: number | null;
  /** max(high[k+1..i-1]) — must reach >= A + ZRL_BOUNCE_MIN. */
  pullbackHigh: number | null;
  /** |low[i] - A| on the retest bar. */
  retestDistance: number | null;
  /** close[i] above the long-horizon (4h) EMA. */
  trendUp: boolean;
  /** EMA20 > EMA50. */
  emaStacked: boolean;
  /** ABOVE if trendUp && emaStacked — the verdict never gates detection. */
  scoreVerdict: "ABOVE" | "BELOW" | null;
}

const ZRL_NOT_DETECTED: ZoneRetestSignal = {
  detected: false,
  swingLowPrice: null,
  swingLowBar: null,
  confirmationBar: null,
  firstReaction: null,
  pullbackHigh: null,
  retestDistance: null,
  trendUp: false,
  emaStacked: false,
  scoreVerdict: null,
};

/**
 * Detects a zone-retest LONG on the LAST bar of `m5Bars` (index i — the
 * emission bar). Long-only — returns `detected: false` for SELL emissions.
 * Pure function: no state, no side effects, no suppression of anything.
 *
 * TREND-EMA NOTE (Item CA live-code discrepancy, reported): the tested config
 * uses a 960-bar (4h) EMA, but the live barSeriesM5 is CAPPED at 300 bars
 * (BAR_M5_LOOKBACK), so emaSpan(closes, 960) returns null on every live
 * emission and a strict implementation would write BELOW-only rows forever.
 * The detector therefore uses span min(960, n-1) — the tested 960 the moment
 * the series is long enough, otherwise the longest horizon the live series
 * supports — and the engine records `trendEmaSpanUsed` in the persisted
 * metadata so the forward book can split the two regimes.
 */
export function detectZoneRetestLong(params: {
  m5Bars: ReadonlyArray<ShadowM5Bar>;
  entryPrice: number;
  direction: "BUY" | "SELL";
}): ZoneRetestSignal {
  const { m5Bars, direction } = params;
  if (direction !== "BUY") return ZRL_NOT_DETECTED;
  const n = m5Bars.length;
  if (n < 8) return ZRL_NOT_DETECTED;
  const i = n - 1;
  const last = m5Bars[i];

  // Trend context first — computed for EVERY qualifying-direction emission so
  // the verdict reflects the trend even when the pattern fails (the trend
  // filter determines the verdict, not detection).
  const closes = m5Bars.map((b) => b.close);
  const trendSpan = Math.min(ZRL_EMA_4H_SPAN, n - 1);
  const emaTrend = emaSpan(closes, trendSpan);
  const emaFast = emaSpan(closes, ZRL_EMA_FAST_SPAN);
  const emaSlow = emaSpan(closes, ZRL_EMA_SLOW_SPAN);
  const trendUp = emaTrend !== null ? last.close > emaTrend : false;
  const emaStacked = emaFast !== null && emaSlow !== null ? emaFast > emaSlow : false;
  const scoreVerdict: "ABOVE" | "BELOW" = trendUp && emaStacked ? "ABOVE" : "BELOW";
  const fail = (partial: Partial<ZoneRetestSignal>): ZoneRetestSignal => ({
    ...ZRL_NOT_DETECTED,
    trendUp,
    emaStacked,
    scoreVerdict,
    ...partial,
  });

  // 1) Most recent 5-bar fractal swing low with j in [max(2, i-96), i-5)
  // (exclusive upper bound), so the confirmation bar k = j+2 is at most i-4 —
  // knowable at bar i and at least ZRL_MIN_SEP bars before the retest.
  const jMin = Math.max(2, i - ZRL_MAX_SEP);
  const jUpperExclusive = i - 2 - ZRL_MIN_SEP;
  let swingLowBar = -1;
  let swingLowPrice = Number.NaN;
  for (let j = jUpperExclusive - 1; j >= jMin; j -= 1) {
    const l = m5Bars[j].low;
    if (
      l < m5Bars[j - 1].low &&
      l < m5Bars[j - 2].low &&
      l < m5Bars[j + 1].low &&
      l < m5Bars[j + 2].low
    ) {
      swingLowBar = j;
      swingLowPrice = l;
      break;
    }
  }
  if (swingLowBar < 0 || !Number.isFinite(swingLowPrice)) return fail({});

  const confirmationBar = swingLowBar + 2;
  // CAUSALITY ASSERTION (Item CA): structurally impossible given the bounds
  // above (k <= i - 4). A throw here means the search bounds are wrong — it
  // must NEVER fire in production, and a lookahead signal must NEVER be
  // written silently instead.
  if (confirmationBar >= i) {
    throw new Error(
      `[ZoneRetest] CAUSALITY VIOLATION: confirmationBar ${confirmationBar} >= retestBar ${i} — fractal search bounds are wrong`,
    );
  }

  // 2) Strong first reaction across the three zone-formation bars j..k.
  let reactionHigh = -Infinity;
  for (let h = swingLowBar; h <= confirmationBar; h += 1) {
    if (m5Bars[h].high > reactionHigh) reactionHigh = m5Bars[h].high;
  }
  const firstReaction = reactionHigh - swingLowPrice;
  if (firstReaction < ZRL_REACT_MIN) {
    return fail({ swingLowPrice, swingLowBar, confirmationBar, firstReaction });
  }

  // 3) A real pullback AWAY from the zone before the retest.
  if (confirmationBar + 1 > i - 1) {
    return fail({ swingLowPrice, swingLowBar, confirmationBar, firstReaction });
  }
  let pullbackHigh = -Infinity;
  for (let h = confirmationBar + 1; h <= i - 1; h += 1) {
    if (m5Bars[h].high > pullbackHigh) pullbackHigh = m5Bars[h].high;
  }
  if (pullbackHigh < swingLowPrice + ZRL_BOUNCE_MIN) {
    return fail({ swingLowPrice, swingLowBar, confirmationBar, firstReaction, pullbackHigh });
  }

  // 4) The retest ON THE LAST BAR: within $4 of A, closing ABOVE it, green.
  const retestDistance = Math.abs(last.low - swingLowPrice);
  if (retestDistance > ZRL_TOL) {
    return fail({ swingLowPrice, swingLowBar, confirmationBar, firstReaction, pullbackHigh, retestDistance });
  }
  if (!(last.close > swingLowPrice)) {
    return fail({ swingLowPrice, swingLowBar, confirmationBar, firstReaction, pullbackHigh, retestDistance });
  }
  if (!(last.close > last.open)) {
    return fail({ swingLowPrice, swingLowBar, confirmationBar, firstReaction, pullbackHigh, retestDistance });
  }

  return {
    detected: true,
    swingLowPrice,
    swingLowBar,
    confirmationBar,
    firstReaction,
    pullbackHigh,
    retestDistance,
    trendUp,
    emaStacked,
    scoreVerdict,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — one row per qualifying pattern, fire-and-forget.
// ─────────────────────────────────────────────────────────────────────────────

export type ShadowCandidateName = "SCORED_DT_SHORT" | "SCORED_REOPEN_LONG" | "ZONE_RETEST_LONG";

/**
 * The strategies' TESTED geometry (Item BD write-side, applied from day one so
 * no row ever lacks it): fixed SL/TP per strategy, time stop, no lock, no
 * partial exits. The core resolver's standard geometry does NOT match — see
 * Items CB/CC for how the books are read.
 *
 * ITEM CD: re-derivation RAN on 2026-09-08 and CHANGED NOTHING — DT: 260 cells,
 * best train t 3.91, holdout improvement +$0.08 (nothing); REOPEN: 155 cells,
 * best pick LOST $1.17 on holdout (overfit). Both keep SL $12 / TP $10 / T96.
 * Do not re-run this sweep for these two.
 */
export const SHADOW_STRATEGY_GEOMETRY = { sl: 12, tp: 10, timeStopBars: 96 } as const;
/**
 * Item CD: ZONE_RETEST_LONG's corrected tested geometry — SL $25 / TP $25 / T192.
 *
 * DERIVATION RECORD (re-derived 2026-09-08 on TRAIN ONLY across 177 cells in
 * five exit families: flat SL/TP/time-stop, TP proportional to the signal's own
 * first reaction, ATR-scaled, trailing, partial+runner; best train t = 3.01;
 * holdout then read ONCE):
 *   SL 15 / TP 10 / T96 (previous live):  full +$1.15 | train +$1.69 | holdout +$0.38
 *   SL 25 / TP 25 / T192 (CORRECT):       full +$4.07 | train +$5.16 | holdout +$2.51
 * Stop sweep at TP $25 / T192 (full EV, [holdout]):
 *   SL 10 +$2.09 [+0.51] · SL 15 +$2.94 [+1.22] · SL 20 +$3.28 [+2.02]
 *   · SL 25 +$4.06 [+2.51] · SL 30 +$4.00 [+1.83] — $25 peaks on BOTH halves.
 * REJECTED hypothesis: targeting a fraction of the signal's own first reaction.
 * EV rises MONOTONICALLY with target width — a $3 target wins 82% of trades and
 * still loses money (−$0.44/trade). The second reaction off a zone runs further
 * than the first, not shorter.
 * Every ZONE_RETEST_LONG row written before CD carries the old geometry and is
 * excluded from the forward book via inputs.geometryVersion (Item CE).
 */
export const ZONE_RETEST_GEOMETRY = { sl: 25, tp: 25, timeStopBars: 192 } as const;

/**
 * Per-candidate tested geometry — single source of truth for prices + inputs.
 * Item CD: return type is numeric (not a literal union) so a future geometry
 * re-derivation cannot become a type error in an unrelated file.
 */
export function geometryForStrategy(name: ShadowCandidateName): { readonly sl: number; readonly tp: number; readonly timeStopBars: number } {
  return name === "ZONE_RETEST_LONG" ? ZONE_RETEST_GEOMETRY : SHADOW_STRATEGY_GEOMETRY;
}

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
  /** ITEM EA — null for independent bar-close scan rows (no emitted signal exists; the row resolves via the Item DA resolver write-back, like the suppressed books). */
  signalId: string | null;
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
    // ITEM CD (supersedes the CA note): geometry is PER-CANDIDATE and now
    // comes from geometryForStrategy — ZONE_RETEST_LONG is SL $25 / TP $25 /
    // T192 (re-derived 2026-09-08, see the derivation record above), the other
    // two SL $12 / TP $10 / T96. Both the written prices and the inputs.geometry
    // blob must come from geometryForStrategy, never a shared constant, or the
    // forward book's EV math (SECTION 12 reads inputs.geometry.sl) lies.
    const geometry = geometryForStrategy(candidateName);
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    const slPrice = direction === "SELL"
      ? entryPrice + geometry.sl
      : entryPrice - geometry.sl;
    const tp1Price = direction === "SELL"
      ? entryPrice - geometry.tp
      : entryPrice + geometry.tp;
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
        signalId, // ITEM EA: null on scan rows — CF's signalId join sees no link (correct; EE's reader uses resolver write-back instead)
        score,
        scoreVerdict,
        geometry,
        // ITEM CE — forward-book self-diagnosis keys. geometryVersion marks the
        // post-CD geometry era: pre-CD ZONE rows carry SL $15 and are excluded
        // by SECTION 12; DT/REOPEN rows written before CE simply lack the key
        // and are excluded the same way. The three excursion fields are written
        // NULL at emission and are to be FILLED IN by whatever resolves the row
        // (CE resolver report: no dedicated shadow resolver exists yet — the
        // shared live-path resolver is deliberately NOT modified). mfe/mae in
        // $; barsHeld in M5 bars from fill to resolution.
        geometryVersion: 2,
        mfe: null,
        mae: null,
        barsHeld: null,
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
