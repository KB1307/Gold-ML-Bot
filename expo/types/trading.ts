import type { AttentionSide, CounterTrendGateTelemetry } from "@/services/attentionTelemetry";

export type { AttentionSide, CounterTrendGateTelemetry };

export type SignalType = "BUY" | "SELL";

/**
 * ITEM 21 — `NEVER_FILLABLE` is a distinct terminal status, NOT a variant of
 * EXPIRED_MISSED_ENTRY. It means the signal's TP1 or SL was genuinely reached in
 * the bars, so the old resolver credited it a WIN or a LOSS, but no bar ever
 * traded through the entry band — the position it was paid for could not have
 * existed. It is excluded from EV, is never a win and never a loss, and renders
 * neutral (never red) so it cannot be misread as a stop-out.
 *
 * Kept separate from EXPIRED_MISSED_ENTRY on purpose: that status means "levels
 * were never reached either", which is an ordinary miss. This one means the book
 * was actively over-credited, which is a defect worth counting on its own.
 */
export type SignalStatus = "ACTIVE" | "TP1_HIT" | "TP2_HIT" | "TP3_HIT" | "ALL_TARGETS_HIT" | "SL_HIT" | "SL_AFTER_BE" | "CLOSED" | "PARTIALLY_MANAGED" | "EXPIRED_MISSED_ENTRY" | "NEVER_FILLABLE" | "PARTIAL_WIN_SL_HIT";

export interface FeatureConfidence {
  feature: string;
  /**
   * ABSOLUTE contribution x100, unchanged since v1 so every existing UI and
   * parser keeps reading the same number. ITEM 29: this field alone is
   * MISLEADING on its own — a +0.35 bonus and a -0.12 penalty both render as a
   * positive magnitude here. Use `signedScore` / `side` when interpreting.
   */
  score: number;
  /**
   * ITEM 29 (additive): the TRUE signed contribution x100. Negative means the
   * entry SUBTRACTED from the side it was recorded against (a penalty).
   */
  signedScore?: number;
  /**
   * ITEM 29 (additive): which side of the directional accumulator this entry
   * actually moved, captured at the call site — not inferred from the key name.
   * 'UNCLASSIFIED' means the record does not establish a side; it must never be
   * read as agreement with the signal.
   */
  side?: AttentionSide;
  /**
   * ITEM 29 (additive): true when this entry's favoured direction is the
   * OPPOSITE of the signal that carried it. Undefined/false on unclassified or
   * non-directional entries.
   */
  opposesSignal?: boolean;
}

export interface MacroEvent {
  name: string;
  impact: "HIGH" | "MEDIUM" | "LOW";
  timeUntilEvent: number;
}

export interface TradingSignal {
  id: string;
  timestamp: Date;
  type: SignalType;
  entryPrice: number;
  entryPriceWithSlippage: number;
  tp1: number;
  tp2: number;
  tp3: number;
  sl: number;
  slMultiplier: number;
  confidence: number;
  status: SignalStatus;
  targetsHit: number;
  entryTime: string;
  exitTime?: string;
  exitPrice?: number;
  topFeatures: FeatureConfidence[];
  /**
   * Part B (diagnostics): EVERY entry from attentionScores at generation time,
   * not just the top 3 (topFeatures above). Additive only - topFeatures stays
   * exactly as-is for existing UI display. Lets a full post-hoc reconstruction
   * of any past signal's complete scoring breakdown actually be possible.
   */
  fullAttentionScores?: FeatureConfidence[];
  /**
   * Per-signal S/R zone snapshot: the exact detectSRZones() output (post-decay,
   * as gating actually saw it) at the moment this signal was generated. Additive
   * only, same pattern as fullAttentionScores above - lets "was this level really
   * evidenced" be answered per-signal from the signal record itself, without
   * depending on log retention or reconstructing state after the fact.
   */
  srZonesSnapshot?: DetectedSRZone[];
  macroWarning?: MacroEvent;
  riskJustification: string;
  timeToLive?: number;
  nextMoveContext?: string;
  latencyWarning?: number;
  tp1Distance?: number;
  tp2Distance?: number;
  tp3Distance?: number;
  createdAt?: number;
  breakevenReached?: boolean;
  breakevenTime?: string;
  trailingSLPrice?: number;
  trailingSLLevel?: 'ENTRY' | 'TP1' | 'TP2';
  learningContext?: SignalLearningContext;
  slAuditVersion?: string;
  /**
   * ITEM 28 (additive, telemetry only): exactly what the counter-trend
   * classifier and the intraday drift veto saw for THIS signal — drift, the
   * ATR-scaled threshold, the sweep-reclaim flag, the resulting predicate, the
   * HTF/LTF labels the gate read, and the real spread applied at entry. These
   * values previously existed only in a console log, so no historical signal
   * could be checked against the rule that let it through.
   */
  counterTrendTelemetry?: CounterTrendGateTelemetry;
  /**
   * ITEM 194 — provenance marker for signals backfilled into local history by
   * reconcileHistoryFromServer() (startup reconciliation against
   * emitted_signals_v1). Absent on every normally-generated signal.
   */
  reconciledFrom?: "emitted_signals_v1";
}

export interface MarketSession {
  name: string;
  isActive: boolean;
  nextOpen?: Date;
  nextClose?: Date;
}

export interface DetectedSRZone {
  price: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  rejectionWicks: number;
  reactionStrength: number;
  source: "PRICE_ACTION" | "PIVOT" | "FIBONACCI" | "VOLUME_NODE" | "PREV_DAY" | "ASIAN_RANGE" | "ORH_ORL" | "WEEKLY" | "SESSION_BLOCK";
  confluenceScore: number;
  /**
   * Which tier supplied this zone at generation time: 'TIER_0_SERVER'
   * (durable, multi-day sr_zones_v1 cache computed from gold_m1_bars) or
   * 'TIER_1_LOCAL' (in-memory detectSRZones() fallback, reset on reload).
   * Optional so older cached/exported signals without this field still
   * type-check.
   */
  tier?: "TIER_0_SERVER" | "TIER_1_LOCAL";
  /**
   * ITEM 191 — the legacy spot-relative type (price > currentPrice at compute
   * time). Present on snapshots written after 2026-08-21; absent on older ones.
   */
  legacyType?: "SUPPORT" | "RESISTANCE";
  /** ITEM 191 — approaches from BELOW rejected back down (resistance behaviour), counted over the engine's in-memory window. */
  rejectionsFromBelow?: number;
  /** ITEM 191 — approaches from ABOVE rejected back up (support behaviour). */
  rejectionsFromAbove?: number;
}

export interface MarketOutlook {
  isMarketOpen: boolean;
  currentSession: string;
  sessions: MarketSession[];
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  volatility: "LOW" | "MEDIUM" | "HIGH";
  dailyPivot: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
  /**
   * Real, candlestick-derived S/R zones from detectSRZones() (fractal swing
   * highs/lows, actual touch counts, rejection wicks, PDH/PDL, Asian range,
   * opening range, weekly H/L, confluence). These are what structural gating
   * actually checks first - the r1/r2/r3/s1/s2/s3 fields above are the fixed
   * Camarilla reference pivots, kept for display/fallback only.
   */
  srZones: DetectedSRZone[];
  /**
   * Next upcoming high-impact macro event (NFP/CPI/FOMC/PCE/retail sales,
   * etc.) within a 24h look-ahead window, sourced from the real FMP economic
   * calendar (falling back to the date-pattern heuristic if FMP is
   * unreachable). Null when nothing relevant is upcoming.
   */
  upcomingHighImpactEvent: { name: string; impact: string; timeUntilEvent: number } | null;
}

export interface FibonacciLevel {
  level: number;
  price: number;
  type: "retracement" | "extension";
}

export interface SentimentData {
  score: number;
  confidence: number;
  source: string;
}

/**
 * Feature vector persisted with every resolved trade outcome.
 *
 * v1 (the six always-present scalars below) was too narrow to support the
 * Module B diagnostics the forensic audit asks for: feature importance,
 * false-positive drivers, session/regime attribution and precision-vs-recall
 * work all need the state the engine ACTUALLY scored on, not just RSI/ATR/
 * volume/DXY/time/sentiment.
 *
 * v2 adds the rest of that state as OPTIONAL fields, so:
 *   - every existing record (and every existing call site) stays valid;
 *   - `schemaVersion` tells any analysis code whether the wide fields can be
 *     expected, instead of it having to guess from `undefined`.
 * All fields are JSON-primitive (number/boolean/string) on purpose - this is
 * serialized into SQLite and into the `features` jsonb column in Supabase.
 */
export interface SignalLearningContext {
  // ---- v1: always present ----
  rsi: number;
  atr: number;
  volumeRatio: number;
  dxyChange: number;
  timeWindowFactor: number;
  sentiment: SentimentData;

  // ---- v2: wide vector (optional; present when schemaVersion >= 2) ----
  /** 1 = legacy six-scalar record, 2 = wide vector below. */
  schemaVersion?: number;

  /**
   * ITEM 179(c) — provenance marker. 'app-bar-reconstruction' when the
   * learning context was missing at outcome time and the six scalars were
   * reconstructed from gold_m1_bars before emission (RSI-14/ATR-14, M1).
   * Absent on every engine-generated record.
   */
  featuresSource?: string;

  /**
   * ITEM 195(c) — ATR construct provenance. Present on every bar-reconstructed
   * record written after 2026-08-21 (Wilder ATR-14 on M1). The engine's own
   * records do not carry these (their construct is the engine's M5 ATR-14).
   */
  atrPeriod?: number;
  atrTimeframe?: string;
  atrMethod?: string;

  // momentum / trend
  macdHistogram?: number;
  emaCrossover?: number;
  adx?: number | null;
  /** currentPrice - VWAP in dollars (null when VWAP unavailable). */
  vwapDelta?: number | null;
  htfTrend?: string;

  // volatility
  /** ATR as a fraction of price - comparable across gold price regimes. */
  atrPercentOfPrice?: number;
  bollingerBandwidth?: number | null;
  bollingerSqueeze?: boolean;
  bollingerExpansion?: boolean;
  sessionVolatilityIndex?: number;

  // regime
  regimeType?: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET';
  regimeStrength?: number;
  regimeConfidence?: number;

  // structure / key levels
  priceActionPattern?: string;
  candlestickPattern?: string;
  supportStrength?: number;
  resistanceStrength?: number;
  srZoneCount?: number;
  /** Distance from entry to the nearest detected zone, in ATR units. */
  nearestZoneDistanceAtr?: number;
  activeSRReactionType?: string | null;
  activeSRReactionStrength?: number;
  activeSRReactionConfirmed?: boolean;
  orderBlockCount?: number;
  quasimodoCount?: number;

  // liquidity sweeps (Module A)
  sweepCount?: number;
  confirmedSweepType?: string | null;
  confirmedSweepSession?: string | null;
  sweepPenetrationDepth?: number;
  sweepReclaimLatencyMs?: number;

  // microstructure (Module C)
  orderFlowImbalance?: number;
  institutionalFootprint?: number;
  largeOrdersDetected?: boolean;
  /** currentPrice - point of control, in dollars. */
  pocDelta?: number;

  // intermarket
  us10yChange?: number;
  vixChange?: number;
  goldDxyCorrelation?: number;
  goldYieldCorrelation?: number;

  // session / time (Module C session attribution)
  sessionName?: string;
  liquidityScore?: number;
  hourUtc?: number;
  minuteOfDayUtc?: number;
  dayOfWeekUtc?: number;
  timeToSessionEnd?: number;

  // entry geometry as scored (Module D)
  entryPrice?: number;
  slDistance?: number;
  tp1Distance?: number;
  plannedRR?: number;
  confidenceAtEntry?: number;

  // ---- v3: counter-trend gate + execution-cost telemetry (ITEM 28) ----
  // Present when schemaVersion >= 3. Every field mirrors the identically-named
  // field on CounterTrendGateTelemetry and is written from the SAME pure record,
  // so the learning corpus and the signal record can never disagree.
  /** HTF label the counter-trend gate itself read (v2 `htfTrend` is the same call). */
  htfTrendAtGate?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** LTF label the counter-trend gate itself read. */
  ltfTrendAtGate?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** Did the B1-repaired classifier call this signal counter-trend? */
  counterTrendClassified?: boolean;
  /** Signed 5-min drift in dollars over the veto lookback; null = uncomputable. */
  recentDrift?: number | null;
  /** Drift re-signed so positive = against this signal's direction. */
  driftAgainst?: number | null;
  /** The atr x veto-multiple value driftAgainst was compared against. */
  driftVetoThreshold?: number | null;
  /** True when driftAgainst >= driftVetoThreshold. */
  driftVetoPredicateTrue?: boolean;
  /** Sweep with reversalConfirmed present at gate time? */
  sweepReclaimConfirmedAtGate?: boolean;
  /** Predicate fired but sweep + conviction override allowed the entry. */
  driftVetoOverrideApplied?: boolean;
  /**
   * REAL bid/ask spread in pips applied to this entry, or null when no live
   * reading existed. This is the field that makes cost-adjusted expectancy
   * measurable forward — before it existed, no durable store anywhere held a
   * single observed spread.
   */
  spreadPipsAtEntry?: number | null;
}

export interface PerformanceMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalProfit: number;
  totalLoss: number;
  maxDrawdown: number;
  currentDrawdown: number;
  /**
   * PER-TRADE risk-adjusted return (mean R / stdev R). This is the honest
   * headline figure: the previously-reported annualized number read 5.010 on a
   * sample whose true per-trade Sharpe was 0.10, i.e. ~50x optimistic on every
   * risk read. The annualized value is still exposed separately below.
   */
  sharpeRatio: number;
  sharpeRatioAnnualized?: number;
  /** Mean per-trade expectancy in R AFTER the configured execution cost. */
  netExpectancyR?: number;
  profitFactor: number;
  winRate: number;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  modelHealthScore?: number;
  featureCorrelationStatus?: string;
  confidenceDegradation?: number;
  avgSlippageDiff?: number;
  hypotheticalAccuracy?: number;
  conceptDriftScore?: number;
  featureImportanceDrift?: FeatureDriftMetric[];
  driftAlertLevel?: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  daysSinceRetrain?: number;
  retrainingRecommended?: boolean;
}

export interface FeatureDriftMetric {
  feature: string;
  currentImportance: number;
  historicalImportance: number;
  drift: number;
  /**
   * ITEM 82 / B4 - F-14 FIX. `INSUFFICIENT_DATA` exists because a NaN drift was
   * previously classified CRITICAL: `NaN < 0.3` is false and `NaN < 0.6` is false,
   * so the else-branch caught it. That permanently pinned "Retraining recommended:
   * YES" and made Item 64(c)'s per-feature CRITICAL trigger unable to discriminate -
   * it was firing on ABSENT DATA, not on drift.
   *
   * A NaN means the feature was not present on the corpus rows being compared. That
   * is a corpus-completeness fact, not a model-degradation signal, and it must never
   * be actionable as CRITICAL.
   */
  status: 'STABLE' | 'DEGRADING' | 'CRITICAL' | 'INSUFFICIENT_DATA';
}

export interface DailyOHLC {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number;
}

export interface PositionSizing {
  baseSize: number;
  confidenceMultiplier: number;
  recommendedSize: number;
  riskPercentage: number;
  fractionalKelly: number;
  optimalKellyPercentage: number;
  adjustedForAccount: number;
}

export interface Settings {
  tp1Pips: number;
  tp2Pips: number;
  tp3Pips: number;
  slPips: number;
  numberOfTPs: 1 | 2 | 3;
  minConfidence: number;
  enableNotifications: boolean;
  enableTelegramNotifier: boolean;
  basePositionSize: number;
  maxRiskPercentage: number;
  useKellyCriterion: boolean;
  useDynamicSL: boolean;
  maxSLPips: number;
  /**
   * SELL suppression toggle (default false). When false, qualifying SELL
   * signals are fully scored and geometry-computed but NOT emitted as live
   * signals and NOT sent to Telegram. A shadow record is pushed to the
   * durable shadow_signals_v1 Supabase table so the decision stays
   * monitorable against real forward data. Gold's long bias is structural
   * today but could change — this is flippable back on without a code change.
   */
  allowShortSignals: boolean;
}
