export type SignalType = "BUY" | "SELL";

export type SignalStatus = "ACTIVE" | "TP1_HIT" | "TP2_HIT" | "TP3_HIT" | "ALL_TARGETS_HIT" | "SL_HIT" | "SL_AFTER_BE" | "CLOSED" | "PARTIALLY_MANAGED" | "EXPIRED_MISSED_ENTRY" | "PARTIAL_WIN_SL_HIT";

export interface FeatureConfidence {
  feature: string;
  score: number;
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

export interface SignalLearningContext {
  rsi: number;
  atr: number;
  volumeRatio: number;
  dxyChange: number;
  timeWindowFactor: number;
  sentiment: SentimentData;
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
  status: 'STABLE' | 'DEGRADING' | 'CRITICAL';
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
}
