/**
 * ITEM AA/AB/AC — pure model-fitting module.
 *
 * Deliberately dependency-free (no react-native / AsyncStorage imports) so the
 * EXACT same code runs in three places:
 *   1. the live training path (signalEngine.retrainModel),
 *   2. the live scoring path (buildLearningContext -> modelProbability),
 *   3. bun acceptance scripts that verify the math against the real
 *      trade_outcomes_v1 corpus before anything is claimed as done.
 *
 * Everything here is pure math over plain data. No side effects, no I/O.
 */

/** The 13 model features, in the FIXED vector order used everywhere. */
export const MODEL_FEATURE_KEYS = [
  // ---- legacy six (v1 scalars; weight names keep their existing form) ----
  "rsi",
  "atr",
  "volumeRatio",
  "sentiment",
  "dxyChange",
  "timeWindowFactor",
  // ---- Item AB: side-relative additions (weight names feat_*_weight) ----
  "feat_trend_aligned",
  "feat_rsi_aligned",
  "feat_ema_stack",
  "feat_session_level_count",
  "feat_at_day_extreme",
  "feat_zone_max_react",
  "feat_near_round50",
] as const;

export type ModelFeatureKey = (typeof MODEL_FEATURE_KEYS)[number];

export const MODEL_BIAS_KEY = "model_bias";

/** Item AB features all carry the feat_ prefix already. */
export function isSideRelativeFeature(key: string): boolean {
  return key.startsWith("feat_");
}

/** model_weights_v1 entry name for a feature's weight. */
export function weightKeyName(feature: string): string {
  return `${feature}_weight`;
}

/** model_weights_v1 entry name for a feature's training-corpus mean. */
export function meanKeyName(feature: string): string {
  return `feat_${feature}_mean`;
}

/** model_weights_v1 entry name for a feature's training-corpus std. */
export function stdKeyName(feature: string): string {
  return `feat_${feature}_std`;
}

/**
 * model_weights_v1 key for a feature's AC logistic weight. Legacy features
 * keep their historical weight names (volume_weight etc.); Item AB features
 * are feat_<name>_weight.
 */
export function getLogisticWeightName(feature: string): string {
  const spec = CENTROID_FEATURE_SPECS.find((s) => s.key === feature);
  return spec ? spec.weightName : `${feature}_weight`;
}

/**
 * Parses the AC logistic block (13 weights + bias + 13 means + 13 stds) out of
 * a persisted model_weights_v1 record. Returns null when any piece is missing
 * or non-finite — a pre-AC vector must score as "no model", never partially.
 */
export function parsePersistedLogisticModel(raw: unknown): LogisticModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const weights: number[] = [];
  for (const feature of MODEL_FEATURE_KEYS) {
    const w = rec[getLogisticWeightName(feature)];
    if (typeof w !== "number" || !Number.isFinite(w)) return null;
    weights.push(w);
  }
  const bias = rec[MODEL_BIAS_KEY];
  if (typeof bias !== "number" || !Number.isFinite(bias)) return null;
  const readVec = (nameFor: (feature: string) => string): number[] =>
    MODEL_FEATURE_KEYS.map((feature) => {
      const v = rec[nameFor(feature)];
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    });
  return { weights, bias, means: readVec(meanKeyName), stds: readVec(stdKeyName) };
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM AA — training-corpus cleanup (read-side only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ITEM 179(c) provenance marker. Reconstruction rows were written when the
 * learning context was missing at outcome time: 4 of the 6 v1 features are
 * defaulted (volumeRatio=1, timeWindowFactor=1, dxyChange=0,
 * sentiment.score=0) and dilute every fitted weight toward the defaults.
 */
export const RECONSTRUCTION_SOURCE = "app-bar-reconstruction";

/** The feature subset the reconstruction detectors read. */
export interface ReconstructionFeatureShape {
  featuresSource?: string;
  volumeRatio?: unknown;
  timeWindowFactor?: unknown;
  dxyChange?: unknown;
  sentiment?: { score?: unknown } | null;
}

/**
 * ITEM AE — the defaulted-feature fingerprint. True when ALL FOUR legacy
 * features carry their no-data defaults SIMULTANEOUSLY: volumeRatio === 1,
 * timeWindowFactor === 1, dxyChange === 0, and sentiment.score === 0 or the
 * sentiment object absent. Most reconstruction-era rows were pushed to
 * trade_outcomes_v1 BEFORE Item 194 added the featuresSource marker, so the
 * marker alone missed them (measured 2026-09-04: 347 unmarked of 373
 * fingerprint rows; every one carries a reconstruction-class sentiment
 * source — resolver-bar-reconstruction 285, record-fallback 62, marker 26).
 * A row where ANY ONE of the four has a non-default value carries at least
 * one real feature and is NOT excluded.
 */
export function matchesReconstructionFingerprint(
  features?: ReconstructionFeatureShape | null,
): boolean {
  if (!features || typeof features !== "object") return false;
  const volumeDefault = features.volumeRatio === 1;
  const timeWindowDefault = features.timeWindowFactor === 1;
  const dxyDefault = features.dxyChange === 0;
  const sentiment = features.sentiment;
  const sentimentDefault =
    sentiment === null ||
    sentiment === undefined ||
    (typeof sentiment === "object" && sentiment.score === 0);
  return volumeDefault && timeWindowDefault && dxyDefault && sentimentDefault;
}

/**
 * The AA+AE predicate: the explicit Item 179(c) marker (kept — it catches any
 * future case regardless of feature values) OR the Item AE defaulted-feature
 * fingerprint (catches the unmarked pre-marker reconstruction rows).
 */
export function isReconstructionRow(
  features?: ReconstructionFeatureShape | null,
): boolean {
  if (features?.featuresSource === RECONSTRUCTION_SOURCE) return true;
  return matchesReconstructionFingerprint(features);
}

export interface CorpusFilterResult<T> {
  /** Rows kept for training (reconstruction rows removed). */
  included: T[];
  /** Rows in, before the filter. */
  total: number;
  /** Rows removed by the filter (marked + fingerprint). */
  excludedReconstruction: number;
  /** ITEM AE — of the excluded, those carrying the explicit marker. */
  excludedReconstructionMarked: number;
  /** ITEM AE — of the excluded, those caught by the fingerprint alone. */
  excludedReconstructionFingerprint: number;
}

/**
 * Excludes reconstruction rows: the explicit 'app-bar-reconstruction' marker
 * (Item AA) plus unmarked rows matching the defaulted-feature fingerprint
 * (Item AE). Read-side only — rows are never deleted and the hydrate/push/
 * pull paths are untouched.
 */
export function filterTrainingCorpus<T extends { features?: unknown }>(
  rows: readonly T[],
): CorpusFilterResult<T> {
  let excludedMarked = 0;
  let excludedFingerprint = 0;
  const included = rows.filter((row) => {
    const features = row.features as ReconstructionFeatureShape | null;
    if (!isReconstructionRow(features)) return true;
    if (features?.featuresSource === RECONSTRUCTION_SOURCE) excludedMarked += 1;
    else excludedFingerprint += 1;
    return false;
  });
  return {
    included,
    total: rows.length,
    excludedReconstruction: rows.length - included.length,
    excludedReconstructionMarked: excludedMarked,
    excludedReconstructionFingerprint: excludedFingerprint,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature-vector extraction (training rows AND scoring-time signals)
// ─────────────────────────────────────────────────────────────────────────────

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readField(features: unknown, ...path: string[]): unknown {
  let cur: unknown = features;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * ITEM AB — the per-feature spec the weighted-centroid fitter consumes.
 *
 * The six legacy features keep their EXACT historical formulas/scales (the
 * scale constants transcribed from the original retrainModel blocks). A row
 * whose feature value is missing/non-finite is skipped FOR THAT FEATURE ONLY
 * (the legacy code would have produced NaN for the whole weight in that case
 * — never observable on real rows, where the v1 scalars are always present;
 * sentiment?.score ?? 0 and the finite-value skip agree on every real row).
 */
export interface CentroidFeatureSpec {
  key: ModelFeatureKey;
  /**
   * The model_weights_v1 name for this feature's weight. The six legacy
   * features keep their EXACT historical names (volume_weight, NOT
   * volumeRatio_weight — CONSUMED_MODEL_WEIGHTS, getFeatureModulation and the
   * drift auto-halver all match on those names); Item AB features are
   * feat_<name>_weight.
   */
  weightName: string;
  /** Multiplier applied to the (win-centroid − loss-centroid) difference. */
  scale: number;
  /** Reads the feature value; null = row does not carry this feature. */
  read: (features: unknown) => number | null;
}

export const CENTROID_FEATURE_SPECS: readonly CentroidFeatureSpec[] = [
  { key: "rsi", weightName: "rsi_weight", scale: 1 / 100, read: (f) => finiteOrNull(readField(f, "rsi")) },
  { key: "timeWindowFactor", weightName: "timeWindow_weight", scale: 0.5, read: (f) => finiteOrNull(readField(f, "timeWindowFactor")) },
  { key: "volumeRatio", weightName: "volume_weight", scale: 1, read: (f) => finiteOrNull(readField(f, "volumeRatio")) },
  { key: "sentiment", weightName: "sentiment_weight", scale: 2, read: (f) => finiteOrNull(readField(f, "sentiment", "score")) },
  { key: "atr", weightName: "atr_weight", scale: 1 / 10, read: (f) => finiteOrNull(readField(f, "atr")) },
  { key: "dxyChange", weightName: "dxy_weight", scale: 2, read: (f) => finiteOrNull(readField(f, "dxyChange")) },
  { key: "feat_trend_aligned", weightName: "feat_trend_aligned_weight", scale: 1, read: (f) => finiteOrNull(readField(f, "feat_trend_aligned")) },
  { key: "feat_rsi_aligned", weightName: "feat_rsi_aligned_weight", scale: 1, read: (f) => finiteOrNull(readField(f, "feat_rsi_aligned")) },
  { key: "feat_ema_stack", weightName: "feat_ema_stack_weight", scale: 1, read: (f) => finiteOrNull(readField(f, "feat_ema_stack")) },
  { key: "feat_session_level_count", weightName: "feat_session_level_count_weight", scale: 1, read: (f) => finiteOrNull(readField(f, "feat_session_level_count")) },
  { key: "feat_at_day_extreme", weightName: "feat_at_day_extreme_weight", scale: 1, read: (f) => finiteOrNull(readField(f, "feat_at_day_extreme")) },
  { key: "feat_zone_max_react", weightName: "feat_zone_max_react_weight", scale: 1, read: (f) => finiteOrNull(readField(f, "feat_zone_max_react")) },
  { key: "feat_near_round50", weightName: "feat_near_round50_weight", scale: 1, read: (f) => finiteOrNull(readField(f, "feat_near_round50")) },
];

/**
 * The 13-value model vector from a SignalLearningContext-shaped object.
 * Missing / non-finite values come back as null:
 *   - at TRAINING time a null excludes the whole row (Item AC NaN rule);
 *   - at SCORING time a null is standardised to 0 (the mean) by
 *     scoreLogisticModel, per the Item AC NaN rule.
 */
export function extractFeatureVector(features: unknown): (number | null)[] {
  const f = (features ?? {}) as Record<string, unknown>;
  const sentiment = f.sentiment as { score?: unknown } | undefined;
  return [
    finiteOrNull(f.rsi),
    finiteOrNull(f.atr),
    finiteOrNull(f.volumeRatio),
    finiteOrNull(sentiment?.score),
    finiteOrNull(f.dxyChange),
    finiteOrNull(f.timeWindowFactor),
    finiteOrNull(f.feat_trend_aligned),
    finiteOrNull(f.feat_rsi_aligned),
    finiteOrNull(f.feat_ema_stack),
    finiteOrNull(f.feat_session_level_count),
    finiteOrNull(f.feat_at_day_extreme),
    finiteOrNull(f.feat_zone_max_react),
    finiteOrNull(f.feat_near_round50),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM AB — side-relative feature computation
// ─────────────────────────────────────────────────────────────────────────────

export interface BarInput {
  readonly timestamp: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface SideRelativeFeatureInput {
  /** Trade direction of the signal being scored. */
  readonly direction: "BUY" | "SELL";
  /** Entry price (= the signal bar's close). */
  readonly entryPrice: number;
  /** 14-period RSI as already computed by the engine (null if unavailable). */
  readonly rsi: number | null;
  /**
   * Completed M5 bars, ascending by timestamp, ALL at or before the signal
   * bar — no lookahead. The engine's barSeriesM5 qualifies (built from
   * gold_m1_bars up to the present); the acceptance scripts pass tape slices
   * that end before the signal.
   */
  readonly m5Bars: readonly BarInput[];
  /** Engine SR zone level prices (the live map at emission time). */
  readonly zonePrices: readonly number[];
}

export interface SideRelativeFeatures {
  feat_trend_aligned: number | null;
  feat_rsi_aligned: number | null;
  feat_ema_stack: number | null;
  feat_session_level_count: number | null;
  feat_at_day_extreme: number | null;
  feat_zone_max_react: number | null;
  feat_near_round50: number | null;
}

/**
 * feat_trend_aligned span. The prompt defines EMA_4h as a 960-bar EMA of
 * 15-second closes ≡ 48 M5 bars (the same time constant: 48 bars × the
 * 5min/15s span factor of 20 = 960). Implemented as a span-48 EMA over the
 * available M5 closes; requires at least 48 bars, else null.
 */
export const EMA_4H_SPAN_M5_BARS = 48;
export const EMA_STACK_FAST_SPAN = 20;
export const EMA_STACK_SLOW_SPAN = 50;

/** USD distance for "near a level". */
export const LEVEL_PROXIMITY_USD = 3;
/** feat_at_day_extreme tolerance: within 0.1% of the running day extreme. */
export const DAY_EXTREME_FRACTION = 0.001;
/** feat_zone_max_react: reaction window after a zone touch, in M5 bars. */
export const REACTION_WINDOW_BARS = 6;
/** feat_zone_max_react normalisation cap (dollars). */
export const REACTION_CAP_USD = 50;
/** feat_session_level_count normalisation cap (levels). */
export const SESSION_LEVEL_CAP = 5;
/** feat_near_round50 step. */
export const ROUND_NUMBER_STEP = 50;

/** Session windows in UTC hours: Asia 00-07, London 07-12, NY 12-22. */
const SESSION_WINDOWS_UTC: ReadonlyArray<{ readonly startH: number; readonly endH: number }> = [
  { startH: 0, endH: 7 },
  { startH: 7, endH: 12 },
  { startH: 12, endH: 22 },
];

const SESSION_WINDOW_MS = 60 * 60 * 1000;

/** Standard span-based EMA (alpha = 2/(period+1)), seeded with the first value. */
export function emaSpan(values: readonly number[], period: number): number | null {
  if (!Number.isFinite(period) || period < 1 || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let acc = values[0];
  for (let i = 1; i < values.length; i += 1) {
    acc = alpha * values[i] + (1 - alpha) * acc;
  }
  return Number.isFinite(acc) ? acc : null;
}

function sessionWindowBoundsUtc(anchorMs: number): Array<{ startMs: number; endMs: number }> {
  const anchor = new Date(anchorMs);
  const dayStartUtc = Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth(),
    anchor.getUTCDate(),
  );
  return SESSION_WINDOWS_UTC.map(({ startH, endH }) => ({
    startMs: dayStartUtc + startH * SESSION_WINDOW_MS,
    endMs: dayStartUtc + endH * SESSION_WINDOW_MS,
  }));
}

function utcDayStartMs(anchorMs: number): number {
  const d = new Date(anchorMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Computes the 7 Item AB side-relative features.
 *
 * WINDOW HONESTY (deviation documented in the round artifact): the prompt's
 * spec says a 72h trailing window for feat_session_level_count and
 * feat_zone_max_react, but the engine retains only BAR_M5_LOOKBACK=300 M5
 * bars (~25h). Both features are computed over the FULL AVAILABLE bar window
 * (a session is counted only when the bar window fully covers it, so no
 * partial-session highs/lows ever enter the count). At emission the engine
 * passes barSeriesM5; nothing looks ahead.
 */
export function computeSideRelativeFeatures(
  input: SideRelativeFeatureInput,
): SideRelativeFeatures {
  const { direction, entryPrice, rsi, m5Bars, zonePrices } = input;

  // feat_trend_aligned — close vs EMA_4h.
  let featTrendAligned: number | null = null;
  const closes = m5Bars.map((b) => b.close);
  const ema4h = emaSpan(closes, EMA_4H_SPAN_M5_BARS);
  if (ema4h !== null) {
    featTrendAligned = (direction === "SELL" ? entryPrice < ema4h : entryPrice > ema4h) ? 1 : 0;
  }

  // feat_rsi_aligned — RSI is already side-agnostic; the test is side-relative.
  let featRsiAligned: number | null = null;
  if (rsi !== null) {
    featRsiAligned = (direction === "SELL" ? rsi > 60 : rsi < 40) ? 1 : 0;
  }

  // feat_ema_stack — EMA20 vs EMA50 on M5 closes.
  let featEmaStack: number | null = null;
  const emaFast = emaSpan(closes, EMA_STACK_FAST_SPAN);
  const emaSlow = emaSpan(closes, EMA_STACK_SLOW_SPAN);
  if (emaFast !== null && emaSlow !== null) {
    featEmaStack = (direction === "SELL" ? emaFast < emaSlow : emaFast > emaSlow) ? 1 : 0;
  }

  // feat_session_level_count — completed-session highs/lows near entry.
  let featSessionLevelCount: number | null = null;
  if (m5Bars.length > 0) {
    const firstBarMs = m5Bars[0].timestamp;
    const anchorMs = m5Bars[m5Bars.length - 1].timestamp;
    // Candidate windows anchored on the anchor day AND the previous day (a
    // session that started yesterday can still be the nearest completed one).
    const windows = [
      ...sessionWindowBoundsUtc(anchorMs - 24 * SESSION_WINDOW_MS),
      ...sessionWindowBoundsUtc(anchorMs),
    ];
    let levelsNear = 0;
    let countedSessions = 0;
    for (const w of windows) {
      // A session counts only when the bar window FULLY covers it — no
      // partial-session extremes. Completed only: window end <= anchor.
      if (firstBarMs <= w.startMs && w.endMs <= anchorMs) {
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
        if (seen > 0 && Number.isFinite(high) && Number.isFinite(low)) {
          countedSessions += 1;
          if (Math.abs(high - entryPrice) <= LEVEL_PROXIMITY_USD) levelsNear += 1;
          if (Math.abs(low - entryPrice) <= LEVEL_PROXIMITY_USD) levelsNear += 1;
        }
      }
    }
    featSessionLevelCount = countedSessions > 0 ? Math.min(levelsNear, SESSION_LEVEL_CAP) / SESSION_LEVEL_CAP : null;
  }

  // feat_at_day_extreme — running day high (SELL) / low (BUY).
  let featAtDayExtreme: number | null = null;
  if (m5Bars.length > 0) {
    const anchorMs = m5Bars[m5Bars.length - 1].timestamp;
    const dayStart = utcDayStartMs(anchorMs);
    let dayHigh = -Infinity;
    let dayLow = Infinity;
    let seen = 0;
    for (const bar of m5Bars) {
      if (bar.timestamp >= dayStart && bar.timestamp <= anchorMs) {
        if (bar.high > dayHigh) dayHigh = bar.high;
        if (bar.low < dayLow) dayLow = bar.low;
        seen += 1;
      }
    }
    if (seen > 0 && Number.isFinite(dayHigh) && Number.isFinite(dayLow)) {
      const tolerance = DAY_EXTREME_FRACTION * entryPrice;
      featAtDayExtreme =
        direction === "SELL"
          ? Math.abs(dayHigh - entryPrice) <= tolerance ? 1 : 0
          : Math.abs(entryPrice - dayLow) <= tolerance ? 1 : 0;
    }
  }

  // feat_zone_max_react — largest reaction away from the nearest zone within $3.
  let featZoneMaxReact: number | null = null;
  if (m5Bars.length > 0) {
    let nearest: number | null = null;
    let nearestDist = Infinity;
    for (const z of zonePrices) {
      const d = Math.abs(z - entryPrice);
      if (Number.isFinite(d) && d <= LEVEL_PROXIMITY_USD && d < nearestDist) {
        nearestDist = d;
        nearest = z;
      }
    }
    if (nearest === null) {
      featZoneMaxReact = 0; // no zone within $3 — defined value, not missing data
    } else {
      let maxReaction = 0;
      for (let i = 0; i < m5Bars.length; i += 1) {
        const bar = m5Bars[i];
        if (bar.low <= nearest && nearest <= bar.high) {
          const stop = Math.min(i + REACTION_WINDOW_BARS, m5Bars.length - 1);
          for (let j = i + 1; j <= stop; j += 1) {
            const up = m5Bars[j].high - nearest;
            const down = nearest - m5Bars[j].low;
            const reaction = Math.max(up, down);
            if (reaction > maxReaction) maxReaction = reaction;
          }
        }
      }
      featZoneMaxReact = Math.min(maxReaction, REACTION_CAP_USD) / REACTION_CAP_USD;
    }
  }

  // feat_near_round50 — entry within $3 of a $50 round number.
  const nearestRound = Math.round(entryPrice / ROUND_NUMBER_STEP) * ROUND_NUMBER_STEP;
  const featNearRound50 =
    Math.abs(entryPrice - nearestRound) <= LEVEL_PROXIMITY_USD ? 1 : 0;

  return {
    feat_trend_aligned: featTrendAligned,
    feat_rsi_aligned: featRsiAligned,
    feat_ema_stack: featEmaStack,
    feat_session_level_count: featSessionLevelCount,
    feat_at_day_extreme: featAtDayExtreme,
    feat_zone_max_react: featZoneMaxReact,
    feat_near_round50: featNearRound50,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM AC — logistic regression (replaces the centroid scorer)
// ─────────────────────────────────────────────────────────────────────────────

export interface LogisticModel {
  /** Weight per feature, in MODEL_FEATURE_KEYS order. */
  weights: number[];
  bias: number;
  /** Training-corpus means, in MODEL_FEATURE_KEYS order. */
  means: number[];
  /** Training-corpus stds, in MODEL_FEATURE_KEYS order (0 -> 1). */
  stds: number[];
}

export interface LogisticFitRow {
  x: (number | null)[];
  /** 1 = winner, 0 = loser. */
  y: number;
}

export interface LogisticFitOptions {
  /** L2 regularisation strength (default 1.0 per the Item AC spec). */
  lambda?: number;
  /** Gradient-descent learning rate (default 0.01 per the spec). */
  learningRate?: number;
  /** Max gradient-descent iterations (default 1000 per the spec). */
  maxIterations?: number;
  /** Convergence: stop when |loss change| < tolerance (default 1e-6). */
  tolerance?: number;
}

export interface LogisticFitResult extends LogisticModel {
  iterations: number;
  finalLoss: number;
  converged: boolean;
  /** Rows fitted (NaN-free rows only). */
  rowsUsed: number;
  /** Rows excluded for missing/NaN feature values. */
  excludedNaN: number;
  winners: number;
  losers: number;
}

export function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function clampP(p: number): number {
  return Math.min(Math.max(p, 1e-12), 1 - 1e-12);
}

function regularizedLogLoss(
  zs: readonly (readonly number[])[],
  ys: readonly number[],
  weights: readonly number[],
  bias: number,
  lambda: number,
): number {
  let loss = 0;
  for (let j = 0; j < zs.length; j += 1) {
    let dot = bias;
    const z = zs[j];
    for (let i = 0; i < weights.length; i += 1) dot += weights[i] * z[i];
    const p = clampP(sigmoid(dot));
    loss += -(ys[j] * Math.log(p) + (1 - ys[j]) * Math.log(1 - p));
  }
  let penalty = 0;
  for (let i = 0; i < weights.length; i += 1) penalty += weights[i] * weights[i];
  return loss + lambda * penalty;
}

/**
 * Fits the Item AC logistic regression exactly as specified:
 *   loss = -sum[y*log(p) + (1-y)*log(1-p)] + lambda * sum(w_i^2)
 *   full-batch gradient descent, learning_rate = 0.01, max 1000 iterations,
 *   converged when |loss change| < 1e-6.
 *
 * Rows with any null/NaN feature are EXCLUDED from training (no imputation).
 * A constant feature (std = 0) is standardised with std = 1, which makes its
 * z-scores all 0 and drives its weight to 0 — it carries no information.
 * A non-finite loss at any iteration aborts the fit with converged=false
 * (the caller keeps the previous weights).
 */
export function fitLogisticRegression(
  rows: readonly LogisticFitRow[],
  options: LogisticFitOptions = {},
): LogisticFitResult {
  const lambda = options.lambda ?? 1.0;
  const learningRate = options.learningRate ?? 0.01;
  const maxIterations = options.maxIterations ?? 1000;
  const tolerance = options.tolerance ?? 1e-6;
  const dims = MODEL_FEATURE_KEYS.length;

  const clean = rows.filter(
    (row) =>
      row.x.length === dims &&
      row.x.every((v) => typeof v === "number" && Number.isFinite(v)) &&
      (row.y === 0 || row.y === 1),
  );
  const excludedNaN = rows.length - clean.length;

  const zeros = () => new Array<number>(dims).fill(0);
  const base = {
    weights: zeros(),
    bias: 0,
    means: zeros(),
    stds: zeros(),
    iterations: 0,
    finalLoss: Number.NaN,
    converged: false,
    rowsUsed: clean.length,
    excludedNaN,
    winners: clean.filter((r) => r.y === 1).length,
    losers: clean.filter((r) => r.y === 0).length,
  };
  if (clean.length === 0) return base;

  // Standardise on the corpus (population std; std 0 -> 1).
  for (let i = 0; i < dims; i += 1) {
    let sum = 0;
    for (const row of clean) sum += row.x[i] as number;
    const mean = sum / clean.length;
    let sq = 0;
    for (const row of clean) {
      const d = (row.x[i] as number) - mean;
      sq += d * d;
    }
    const std = Math.sqrt(sq / clean.length);
    base.means[i] = mean;
    base.stds[i] = std > 0 ? std : 1;
  }

  const zs = clean.map((row) =>
    row.x.map((v, i) => ((v as number) - base.means[i]) / base.stds[i]),
  );
  const ys = clean.map((row) => row.y);

  let weights = zeros();
  let bias = 0;
  let loss = regularizedLogLoss(zs, ys, weights, bias, lambda);
  let converged = false;
  let iterations = 0;

  for (let iter = 1; iter <= maxIterations; iter += 1) {
    const gradW = zeros();
    let gradB = 0;
    for (let j = 0; j < zs.length; j += 1) {
      let dot = bias;
      const z = zs[j];
      for (let i = 0; i < dims; i += 1) dot += weights[i] * z[i];
      const err = sigmoid(dot) - ys[j];
      for (let i = 0; i < dims; i += 1) gradW[i] += err * z[i];
      gradB += err;
    }
    for (let i = 0; i < dims; i += 1) gradW[i] += 2 * lambda * weights[i];

    const nextWeights = zeros();
    for (let i = 0; i < dims; i += 1) nextWeights[i] = weights[i] - learningRate * gradW[i];
    const nextBias = bias - learningRate * gradB;

    const nextLoss = regularizedLogLoss(zs, ys, nextWeights, nextBias, lambda);
    weights = nextWeights;
    bias = nextBias;
    iterations = iter;
    if (!Number.isFinite(nextLoss)) {
      // Diverged — report honestly; the caller keeps the previous weights.
      return { ...base, weights, bias, iterations, finalLoss: nextLoss, converged: false };
    }
    if (Math.abs(nextLoss - loss) < tolerance) {
      loss = nextLoss;
      converged = true;
      break;
    }
    loss = nextLoss;
  }

  return { ...base, weights, bias, iterations, finalLoss: loss, converged };
}

/**
 * Scoring-time evaluation (Item AC): standardise with the STORED means/stds;
 * a null/NaN feature uses 0 (the standardised mean) per the spec; returns the
 * sigmoid probability, or null when no fitted model exists.
 */
export function scoreLogisticModel(
  x: readonly (number | null)[],
  model: LogisticModel | null,
): number | null {
  if (!model || model.weights.length !== x.length || x.length !== MODEL_FEATURE_KEYS.length) {
    return null;
  }
  let dot = model.bias;
  for (let i = 0; i < x.length; i += 1) {
    const v = x[i];
    const standardized =
      typeof v === "number" && Number.isFinite(v) ? (v - model.means[i]) / (model.stds[i] || 1) : 0;
    dot += model.weights[i] * standardized;
  }
  return sigmoid(dot);
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM AD — shadow verdict (no suppression anywhere; logging only)
// ─────────────────────────────────────────────────────────────────────────────

export type ModelVerdict = "AGREE" | "DISAGREE";

export function verdictForProbability(p: number): ModelVerdict {
  return p >= 0.5 ? "AGREE" : "DISAGREE";
}
