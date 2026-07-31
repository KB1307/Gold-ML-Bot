import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext, DetectedSRZone } from "../../types/trading.ts";

const sandboxStorage = new Map<string, string>();

interface SandboxBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SandboxContext {
  currentPrice: number;
  bars: SandboxBar[];
  getIntermarketSnapshot: (timestamp: number) => { dxy: number; us10y: number; vix: number };
}

const getSandboxContext = (): SandboxContext => {
  const context = (globalThis as { __SIGNAL_SIMULATION_CONTEXT__?: SandboxContext }).__SIGNAL_SIMULATION_CONTEXT__;
  if (!context) {
    throw new Error("Signal simulation context not initialized");
  }
  return context;
};

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return sandboxStorage.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    sandboxStorage.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    sandboxStorage.delete(key);
  },
};

(globalThis as Record<string, unknown>).__SANDBOX_TRPC__ = {
  goldPrice: {
    getSpotPrice: {
      async query(): Promise<{ price: number; source: string }> {
        return { price: getSandboxContext().currentPrice, source: "sandbox-spot" };
      },
    },
    getHistoricalData: {
      async query(input: { fromTime: number; toTime: number }): Promise<SandboxBar[]> {
        return getSandboxContext().bars.filter((bar) => bar.timestamp >= input.fromTime && bar.timestamp <= input.toTime);
      },
    },
    getIntermarketData: {
      async query(): Promise<{ dxy: number; us10y: number; vix: number }> {
        return getSandboxContext().getIntermarketSnapshot(Date.now());
      },
    },
  },
};

const trpcClient = (globalThis as Record<string, unknown>).__SANDBOX_TRPC__ as any;

const fetchHistoricalData = async (input: { fromTime: number; toTime: number }): Promise<SandboxBar[]> => {
  return getSandboxContext().bars.filter((bar) => bar.timestamp >= input.fromTime && bar.timestamp <= input.toTime);
};

const Platform = { OS: "web" as const };
type StoredTradeOutcome = any;
const sandboxLearningStoreOutcomes: unknown[] = [];
async function appendOutcomeToStore(outcome: unknown): Promise<void> { sandboxLearningStoreOutcomes.push(outcome); }
async function getAllOutcomesFromStore(): Promise<unknown[]> { return sandboxLearningStoreOutcomes.slice(); }
async function getOutcomeCountFromStore(): Promise<number> { return sandboxLearningStoreOutcomes.length; }
async function pruneOutcomeStoreToCap(cap: number): Promise<void> { if (sandboxLearningStoreOutcomes.length > cap) sandboxLearningStoreOutcomes.splice(0, sandboxLearningStoreOutcomes.length - cap); }
async function migrateLegacyOutcomesIfEmpty(legacy: unknown[]): Promise<number> {
  if (sandboxLearningStoreOutcomes.length > 0) return 0;
  if (!Array.isArray(legacy) || legacy.length === 0) return 0;
  sandboxLearningStoreOutcomes.push(...legacy);
  return legacy.length;
}
async function appendDiagnosticEvent(_event: unknown): Promise<void> {}

// Stub out pushShadowSellRecord so it doesn't try to fetch a backend URL
// during the test — we just want to verify the suppression path fires.
let shadowSellRecordPushed = false;
function pushShadowSellRecord(_record: unknown): void {
  shadowSellRecordPushed = true;
}

import type { OhlcBar } from "@/services/barStore";

/**
 * STEP 2 (GC=F/spot investigation): GENERATION_OHLC_SOURCE events aren't tied to
 * a specific signal (they're per-refresh, engine-level), but DiagnosticEvent
 * requires a signalId -- use this sentinel rather than widening the schema.
 */
const GENERATION_DIAGNOSTIC_SIGNAL_ID = '__generation__';

interface OrderFlowData {
  bidVolume: number;
  askVolume: number;
  volumeImbalance: number;
  largeOrdersDetected: boolean;
  institutionalFootprint: number;
}

interface VolumeProfile {
  highVolumeNodes: number[];
  lowVolumeNodes: number[];
  pointOfControl: number;
  valueAreaHigh: number;
  valueAreaLow: number;
}

interface MarketRegime {
  type: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET';
  strength: number;
  confidence: number;
}

interface TradeOutcome {
  signalId: string;
  entryPrice: number;
  exitPrice: number;
  result: 'WIN' | 'LOSS';
  pnl: number;
  confidence: number;
  features: SignalLearningContext;
  timestamp: Date;
  misleadingFeatures?: FeatureConfidence[];
  signalDuration?: number;
  /**
   * PHASE 2 (C4): trade direction, inferred from the realised exit relative to
   * entry so no call site has to pass it. Enables direction-bucketed
   * calibration instead of pooling a profitable long book with a losing short
   * book (audited BUY EV +0.695R vs SELL EV -0.349R).
   */
  direction?: 'BUY' | 'SELL';
  /** Realised R-multiple, when the stop distance was known at record time. */
  realizedR?: number;
  /**
   * PHASE 2 (C3): true when |realizedR| is inside the scratch band, i.e. the
   * trade neither won nor lost meaningfully (a breakeven/profit-lock scratch).
   * Scratches are retained for the audit trail but excluded from label-based
   * weight fitting and from win-rate/profit-factor, because labelling a ~0R
   * exit as a full WIN teaches the model that a scratch is a success.
   */
  isScratch?: boolean;
  /**
   * Schema version of `features`: 1 = the legacy six scalars only, 2 = the wide
   * vector (see SignalLearningContext). Lets diagnostics select only records
   * that actually carry the wide fields instead of inferring it from undefined.
   */
  featureSchemaVersion?: number;
}

interface IntermarketData {
  dxyPrice: number;
  dxyChange: number;
  dxyVelocity: number;
  us10yYield: number;
  us10yChange: number;
  vixPrice: number;
  vixChange: number;
  goldDxyCorrelation: number;
  goldYieldCorrelation: number;
}

interface IntermarketHistory {
  dxyPrices: number[];
  us10yYields: number[];
  vixPrices: number[];
  lastUpdate: number;
}

interface LiquidityWindow {
  score: number;
  sessionName: string;
  isHighLiquidity: boolean;
}

interface HypotheticalTrade {
  signalId: string;
  entryPrice: number;
  idealExit: number;
  actualMarketPrice: number;
  slippageDifference: number;
  timestamp: Date;
}

interface OrderBlock {
  price: number;
  type: 'BULLISH' | 'BEARISH';
  strength: number;
  timestamp: number;
}

interface QuasimodolLevel {
  price: number;
  type: 'BULLISH_QM' | 'BEARISH_QM';
  strength: number;
  timestamp: number;
  description: string;
}

interface SessionSweep {
  type: 'HIGH_SWEEP' | 'LOW_SWEEP';
  sessionType: 'ASIAN' | 'LONDON' | 'NY';
  sweepPrice: number;
  reversalConfirmed: boolean;
  timestamp: number;
  strength: number;
  /** PHASE 2 (B4): how far beyond the swept level price actually ran, in dollars. */
  penetrationDepth?: number;
  /** PHASE 2 (B4): ms between first penetration and the confirmed reclaim. */
  reclaimLatencyMs?: number;
}

interface SRZone {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  touches: number;
  lastTouch: number;
  rejectionWicks: number;
  avgRejectionSize: number;
  reactionStrength: number;
  source: 'PRICE_ACTION' | 'PIVOT' | 'FIBONACCI' | 'VOLUME_NODE' | 'PREV_DAY' | 'ASIAN_RANGE' | 'ORH_ORL' | 'WEEKLY' | 'SESSION_BLOCK';
  /**
   * Step 5e: number of distinct source types (PRICE_ACTION, PIVOT, PREV_DAY,
   * ASIAN_RANGE, ORH_ORL, WEEKLY, FIBONACCI, VOLUME_NODE) that cluster onto
   * this same price level. A level confirmed by several independent
   * timeframes/methods is structurally stronger than one seen only once.
   */
  confluenceScore: number;
  /**
   * Which tier actually supplied this zone: 'TIER_0_SERVER' (durable,
   * multi-day sr_zones_v1 cache computed server-side from gold_m1_bars) or
   * 'TIER_1_LOCAL' (this instance's own in-memory detectSRZones(), reset on
   * every reload). Mirrors the existing ohlcSourceDetail "which source fed
   * this decision" pattern. Defaults to TIER_1_LOCAL for any zone built by
   * the local computation path below.
   */
  tier: 'TIER_0_SERVER' | 'TIER_1_LOCAL';
}

interface SRZoneReaction {
  zone: SRZone;
  reactionType: 'BOUNCE' | 'REJECTION_WICK' | 'STRONG_REVERSAL';
  strength: number;
  confirmed: boolean;
}

interface MarketFeatures {
  asianHigh: number;
  asianLow: number;
  dailyPivot: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
  rsi: number;
  atr: number;
  dxyChange: number;
  volumeRatio: number;
  weeklyPivot: number;
  fractalResistance: number;
  fractalSupport: number;
  macdHistogram: number;
  emaCrossover: number;
  sessionVolatilityIndex: number;
  timeToSessionEnd: number;
  fibonacci: FibonacciLevel[];
  sentiment: SentimentData;
  orderFlow: OrderFlowData;
  volumeProfile: VolumeProfile;
  marketRegime: MarketRegime;
  priceActionPattern: string;
  candlestickPattern: string;
  supportStrength: number;
  resistanceStrength: number;
  srZones: SRZone[];
  activeSRReaction: SRZoneReaction | null;
  intermarketData: IntermarketData;
  liquidityWindow: LiquidityWindow;
  timeWindowFactor: number;
  orderBlocks: OrderBlock[];
  quasimodolLevels: QuasimodolLevel[];
  sessionSweeps: SessionSweep[];
  vwap: number | null;
  adx: number | null;
  bollingerSqueeze: boolean;
  bollingerExpansion: boolean;
  bollingerBandwidth: number | null;
}

const CACHE_DURATION = 7000;
let cachedGoldPrice: number | null = null;
let lastFetchTime: number = 0;
let lastPriceSource: string = 'connecting...';
let lastKnownGoodPrice: number = 0;
let _consecutiveFailures: number = 0;
let cachedDXY: number | null = null;
let cachedUS10Y: number | null = null;
let cachedVIX: number | null = null;
let lastIntermarketFetchTime: number = 0;
const LEARNING_STORAGE_KEY = 'trade_outcomes_learning';
const MODEL_WEIGHTS_KEY = 'model_weights_v1';
const DAILY_OHLC_STORAGE_KEY = 'daily_ohlc_history_v1';
/**
 * Step 3 — expanded persisted learning memory.
 * A 24h accelerated real-market replay (scripts/runSignalSimulation.ts)
 * produced 5 signals/day with 2 reaching a terminal WIN/LOSS outcome the same
 * day (the rest expired or stayed open) — i.e. roughly 2 real outcomes/day,
 * ~14/week at current signal volume. A 2,000-row cap would take ~2.7 years
 * to fill and is not a meaningful sliding window for a 14-day retrain cycle.
 * 300 is chosen as a realistic interim cap: ~3x the old 100-entry limit,
 * fills in roughly 21 weeks (~5 months) at measured volume, and can be raised
 * later with a one-line constant change now that storage is SQLite-backed
 * (no in-memory array copy cost to worry about).
 */
const MAX_STORED_OUTCOMES = 300;

const TRAINING_WINDOW_DAYS = 14;
const MIN_CONFIDENCE_FOR_RETRAINING = 0.68;

/**
 * Phase 0 — learning→scoring linkage.
 * Converts a learned (normalized, signed) feature weight into a multiplier that
 * scales that feature's hardcoded scoring contribution inside
 * enhancedTransformerAnalysis(). At cold-start (no learned weight) the multiplier
 * is 1.0, so behaviour is identical to the pre-Phase-0 engine. As a feature's
 * learned importance rises the multiplier grows; as it drifts toward zero (or is
 * halved by the concept-drift auto-response) the multiplier shrinks toward — and
 * can cross — zero, measurably reducing or reversing that feature's influence on
 * the next signal.
 */
const LEARNED_WEIGHT_GAIN = 2.5;
/**
 * Step 1 design decision: kept at 0 (not -1.0) even though Bayesian
 * consolidation (BAYESIAN_BLEND_ALPHA below) now damps single-cycle swings.
 * A blended weight can still legitimately land close to -1.0 if a feature has
 * been consistently poor across many consolidated cycles, and at that
 * magnitude a -1.0 floor would let the feature's contribution flip to argue
 * the OPPOSITE direction of its raw evidence — not just fade toward
 * irrelevant. That failure mode (a bad feature actively arguing backwards)
 * is worse than under-using a feature, so the floor stays at 0 until more
 * production retrain cycles have been observed to prove the blended weights
 * stay away from the extremes that made sign-flip risky.
 */
const LEARNED_MODULATION_MIN = 0;
const LEARNED_MODULATION_MAX = 3.0;
/**
 * Step 1: Bayesian memory consolidation. Each retrain blends the freshly
 * fitted (recent-window) weight vector with the previous consolidated
 * ("historical") vector instead of overwriting it outright, so a short
 * adverse/favorable streak can only nudge the learned weights, not swing
 * them to an extreme in a single cycle.
 * W_final = (alpha * W_historical) + ((1 - alpha) * W_recent)
 */
const BAYESIAN_BLEND_ALPHA = 0.4;
// Step 2 (zone staleness/decay): half-life, in hours, used to decay a detected
// S/R zone's reactionStrength based on how long it's been since its last real
// touch. Chosen so a zone with zero fresh touches decays below the 0.3
// structural-gating threshold well within a single trading day (0.5^(24/6) =
// ~6% of original strength at 24h), instead of retaining near-maximum
// strength indefinitely once earned during one early, low-volatility window.
const ZONE_STALENESS_HALF_LIFE_HOURS = 6;
/**
 * PHASE 2 (B4): sweep redefinition.
 *
 * Audited defect (Module A): a "sweep" was recorded the moment price traded a
 * fixed $2 beyond a session extreme, and `reversalConfirmed` was decided by
 * comparing the latest tick against the tick two samples earlier
 * (priceHistory[n-1] < priceHistory[n-3]). That is a momentum wiggle, not a
 * reclaim - so an ordinary break-and-run continuation was indistinguishable
 * from a genuine liquidity grab, and continuations were being scored with the
 * +0.35 "high accuracy setup" bonus reserved for real sweeps.
 *
 * A sweep now requires the full three-part structure:
 *   1. PENETRATION beyond the level by at least max($1, 0.25 x ATR) - so the
 *      trigger scales with volatility instead of a flat $2.
 *   2. RECLAIM: price must trade back INSIDE the swept level. Until it does,
 *      the penetration stays pending and produces no sweep at all.
 *   3. TIMELINESS: the reclaim must happen within the window below. A
 *      penetration that never reclaims is a genuine breakout and is discarded
 *      as such, not silently kept as sweep evidence.
 */
const SWEEP_PENETRATION_ATR_FRACTION = 0.25;
const SWEEP_PENETRATION_MIN_DOLLARS = 1.0;
const SWEEP_RECLAIM_WINDOW_MS = 45 * 60 * 1000;
/** Confirmed sweeps stay actionable for 2h (was 1h, which expired London sweeps mid-NY). */
const SWEEP_RETENTION_MS = 2 * 60 * 60 * 1000;

const BASE_SLIPPAGE_BUFFER_PIPS = 0.5;
const CONFIDENCE_SMOOTHING_WINDOW = 5;
const LATENCY_WARNING_THRESHOLD_MS = 100;
const FEATURE_CORRELATION_CHECK_INTERVAL = 30 * 24 * 60 * 60 * 1000;
const INTERMARKET_CACHE_DURATION = 10000;
const EXTERNAL_PRICE_MAX_AGE_MS = 15000;
const MIN_PRICE_HISTORY_SAMPLE_INTERVAL_MS = 5000;
const MIN_PRICE_HISTORY_CHANGE = 0.03;
const DAILY_OHLC_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const DAILY_OHLC_REFRESH_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const MIN_VALID_DAILY_RANGE = 6;

const HYPOTHETICAL_TRADE_HISTORY_LIMIT = 100;
const MIN_PIP_DIFFERENCE_FOR_NEW_SIGNAL = 12;
const MIN_PIP_DIFFERENCE_FOR_PARTIALLY_MANAGED = 20;
const MAX_RECENT_SIGNAL_TIME_MINUTES = 4;
const POST_TP1_COOLDOWN_MS = 3 * 60 * 1000;
const DRIFT_CHECK_INTERVAL = 4 * 60 * 60 * 1000;
const FEATURE_DRIFT_STORAGE_KEY = 'feature_drift_history_v1';
// #1 Direction-conviction gate. Raised from 0.50/0.08 to cut near-tie "coin-flip"
// entries that historically were the lowest win-rate bucket. The winning side must
// now show clearer dominance, and the per-regime separation floors are tightened a
// notch each so indecisive tape stands down instead of firing a marginal trade.
const MIN_SIGNAL_CONVICTION_THRESHOLD = 0.55;
const MIN_SIGNAL_STRENGTH_DIFFERENCE_BASE = 0.12;
function getMinStrengthDifferenceForRegime(regime: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET'): number {
  switch (regime) {
    case 'TRENDING': return 0.09;
    case 'VOLATILE': return 0.11;
    case 'RANGING': return 0.13;
    case 'QUIET': return 0.15;
    default: return MIN_SIGNAL_STRENGTH_DIFFERENCE_BASE;
  }
}
// ===================== PHASE 2 (post-audit corrections) =====================
// Derived from the 350-signal / 340-resolved forensic audit of the live export
// (window 2026-06-29 -> 2026-07-29). Every constant below is traceable to a
// measured fault in that log, not to a guess:
//
//  * Directional defect: BUY EV +0.695R vs SELL EV -0.349R (z=7.65 on the win
//    rate difference) -> counter-trend gate repair (B1).
//  * SL geometry inside the noise floor: median stop 0.90 ATR, p10 0.23 ATR,
//    TP1 at 0.50R, avg win 0.854R vs avg loss 1.000R -> 1.4R re-scope (B3).
//  * Volatility regime mislabelling: the "Low" bucket spanned ATR 0.4 -> 7.9
//    and then received a 0.80x TIGHTER stop -> regime boundaries re-derived (B2).
//  * Dead clock windows: h11 EV -0.497R, h04 -0.409R, h12 -0.246R, h15 -0.158R.
//  * Loss clustering: P(loss | prev loss) 54.7% vs 31.0% after a win; same
//    direction re-entry within 15 min of a stop won only 13.3% of the time.
//  * Contradictory feature states: 117 signals were simultaneously at "strong
//    support" AND "strong resistance".
//  * Zone evidence: nearest-zone confluence == 1 scored EV -0.326R.
//  * RSI learned modulation fired at 1.09-1.71 while every other attention
//    feature sat at 0.01-0.38, and its own EV contribution was NEGATIVE
//    (present +0.029R vs absent +0.128R, decaying monotonically with size).

/**
 * Round-trip execution cost in USD per trade (broker-confirmed XAU spread).
 * Used for cost-aware expectancy so audited R stops being frictionless.
 */
const EXECUTION_COST_PER_TRADE_USD = 0.05;
/** Formal system scope: a 1.4R scalper. TP ladder is a pure multiple of realised risk. */
const SCALPER_TP_R_MULTIPLES = { tp1: 0.7, tp2: 1.05, tp3: 1.4 } as const;
const SCALPER_TP3_STRETCH_R = 1.5;
const SCALPER_TP3_STRETCH_MAX_R = 1.6;
/** Stops must clear the real noise floor: never tighter than 1.2 x ATR. */
const MIN_SL_ATR_MULTIPLE = 1.2;
const VOL_REGIME_ATR_LOW_MAX = 2.5;
const VOL_REGIME_ATR_HIGH_MIN = 6.0;
const COUNTER_TREND_CONFIDENCE_PREMIUM = 0.10;
/** Reject any signal fighting an intraday impulse >= this many ATRs. */
const COUNTER_TREND_DRIFT_ATR_VETO = 2.0;
const COUNTER_TREND_DRIFT_OVERRIDE_CONFIDENCE = 0.85;
const DRIFT_LOOKBACK_CANDLES = 12;
const BLOCKED_UTC_HOURS: readonly number[] = [4, 11];
const ELEVATED_FLOOR_UTC_HOURS: readonly number[] = [12, 15, 17];
const ELEVATED_HOUR_CONFIDENCE_PREMIUM = 0.04;
const POST_STOP_SAME_DIRECTION_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_NEAR_ZONE_CONFLUENCE = 2;
const NEAR_ZONE_CONFLUENCE_PROXIMITY = 3.0;
const CONFLUENCE_GATE_OVERRIDE_CONFIDENCE = 0.75;
/**
 * Range-contradiction filter ceiling. Deliberately LOW: this filter was not part
 * of the three approved Phase 2 corrections, and at 0.85 the 24h replay showed it
 * becoming the third-largest rejection source (651 blocks) and pushing total
 * generation to ~3/day, far under the 10-20/day mandate. At 0.72 it only removes
 * genuinely low-conviction, range-pinned entries.
 */
const RANGE_CONTRADICTION_MAX_CONFIDENCE = 0.72;
/** Hard ceiling on the learned RSI multiplier (was effectively 3.0). */
const RSI_MODULATION_APPLIED_MAX = 1.5;
// ============================================================================

const ENFORCED_MIN_SIGNAL_CONFIDENCE = 0.68;
const ENFORCED_MIN_CONFIDENCE_POWER_HOUR = 0.65;
const ENFORCED_MIN_CONFIDENCE_LOW_LIQUIDITY = 0.72;
const ABSOLUTE_MIN_SIGNAL_CONFIDENCE = 0.62;
const SIGNAL_STARVATION_RELIEF_ATTEMPTS = 4;
const SIGNAL_STARVATION_RELIEF_CONFIDENCE = 0.64;
const EV_RELIEF_THRESHOLD = 1.5;
const EV_RELIEF_CONFIDENCE_FLOOR = 0.64;
const TREND_FAST_PATH_CONFIDENCE = 0.66;
const MOMENTUM_BREAKOUT_CONFIDENCE = 0.70;
const MOMENTUM_BREAKOUT_PIPS = 30;
const MOMENTUM_BREAKOUT_MAX_BARS = 3;
const NEAR_MISS_CONFIDENCE_LOW = 0.60;
const NEAR_MISS_CONFIDENCE_HIGH = 0.68;
const NEAR_MISS_DIFF_LOW = 0.04;
const NEAR_MISS_DIFF_HIGH = 0.06;
const NEAR_MISS_MAX_ENTRIES = 40;
const NEAR_MISS_MIN_MATURITY_MS = 2 * 60 * 60 * 1000;
const NEAR_MISS_LOOKAHEAD_MS = 6 * 60 * 60 * 1000;
const NEAR_MISS_FLAG_WIN_RATE = 0.40;
const NEAR_MISS_FLAG_MIN_SAMPLE = 3;

interface NearMissEntry {
  timestamp: number;
  signalType: SignalType;
  confidence: number;
  strengthDiff: number;
  reason: string;
  // Hypothetical trade snapshot at the moment of rejection, captured so the
  // setup can be retroactively resolved against real subsequent price action
  // (Step 6: near-miss threshold recalibration mining). Omitted when the
  // rejection happened before entry/TP/SL context existed.
  entryPrice?: number;
  tp1?: number;
  tp2?: number;
  tp3?: number;
  sl?: number;
}

export interface NearMissRecalibrationBucket {
  reason: string;
  wins: number;
  losses: number;
  noOutcome: number;
  winRate: number;
  flagged: boolean;
}
const SYNTHETIC_DATA_PENALTY = 0.03;
const _BIDIRECTIONAL_INFLATION_PENALTY = 0.04;
const LOW_DATA_QUALITY_PENALTY = 0.03;
const MAX_CONFIDENCE_CAP = 0.95;
const MAX_CALIBRATION_PENALTY = 0.08;
const MAX_LEARNING_ADJUSTMENT = 0.08;
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
const STARVATION_GAP_MS = 90 * 60 * 1000;
const BAYESIAN_PRIOR_ALPHA = 2;
const BAYESIAN_PRIOR_BETA = 2;

/**
 * PHASE 2 (C3): |R| band inside which an outcome is treated as a SCRATCH rather
 * than a win or a loss. The post-TP1 profit lock resolves at +0.35R and the
 * post-TP2 protected exit resolves near entry; before this, both were recorded
 * as unqualified WINs, so "win rate" counted scratches as successes and the
 * weight fitter learned scratch feature values as winning feature values.
 */
const SCRATCH_R_THRESHOLD = 0.15;

/**
 * PHASE 2 (C2 verification): the ONLY learned weights any scoring path actually
 * reads are rsi_weight (via getFeatureModulation('rsi_weight')) and dxy_weight
 * (via getFeatureModulation('dxy_weight')) - confirmed by direct code read of
 * every getFeatureModulation call site. sentiment_weight, volume_weight,
 * timeWindow_weight and atr_weight are fitted, persisted and logged but never
 * consumed by any decision. Because normalization divided every weight by the
 * sum of ALL absolute weights, those four inert columns were shrinking the two
 * live ones (roughly 2-4x dilution). Consumed weights are now normalized over
 * the consumed subset; inert ones keep the old denominator so they stay bounded
 * and comparable as telemetry.
 */
const CONSUMED_MODEL_WEIGHTS: ReadonlySet<string> = new Set(['rsi_weight', 'dxy_weight']);

/**
 * PHASE 2 (C4): direction-bucketed calibration. When one direction has enough
 * resolved, non-scratch history AND a negative realised expectancy, that
 * direction's confidence is penalised - self-correcting from live outcomes
 * rather than hardcoding "shorts are bad", so it decays automatically if the
 * short book recovers.
 */
const DIRECTION_CALIBRATION_MIN_SAMPLE = 20;
const DIRECTION_CALIBRATION_MAX_PENALTY = 0.05;

const TIME_WEIGHTS = {
  LOW_LIQUIDITY: 0.5,
  MODERATE_LIQUIDITY: 1.0,
  EUROPE_OPEN: 1.5,
  POWER_HOUR: 2.0,
};

/**
 * Version stamped onto every newly-captured learning feature vector.
 * 1 = the legacy six scalars only; 2 = the wide vector (see SignalLearningContext).
 */
const LEARNING_FEATURE_SCHEMA_VERSION = 2;

function createDefaultLearningContext(): SignalLearningContext {
  return {
    rsi: 50,
    atr: 10,
    volumeRatio: 1,
    dxyChange: 0,
    timeWindowFactor: 1,
    sentiment: {
      score: 0,
      confidence: 0,
      source: 'record-fallback',
    },
  };
}

const UTC_HOURS = {
  EUROPE_OPEN_START: 7,
  EUROPE_OPEN_END: 10,
  NY_LONDON_START: 13,
  NY_LONDON_END: 17,
};

/**
 * Daily market-close break. No signals should be produced during this window.
 * Expressed by the user in local time (UTC+2): 22:59 -> 23:59.
 * That maps to 20:59 -> 21:59 UTC (minutes-of-day 1259 -> 1319 inclusive).
 */
const MARKET_CLOSE_WINDOW_UTC = {
  startMinuteOfDay: 20 * 60 + 59, // 20:59 UTC = 22:59 UTC+2
  endMinuteOfDay: 21 * 60 + 59, // 21:59 UTC = 23:59 UTC+2
};

/**
 * Returns true when the given time falls inside the daily market-close break
 * (22:59-23:59 UTC+2). During this hour no new signals should be generated.
 */
function isWithinDailyMarketClose(date: Date = new Date()): boolean {
  const minuteOfDayUTC = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (
    minuteOfDayUTC >= MARKET_CLOSE_WINDOW_UTC.startMinuteOfDay &&
    minuteOfDayUTC <= MARKET_CLOSE_WINDOW_UTC.endMinuteOfDay
  );
}

let intermarketHistory: IntermarketHistory = {
  dxyPrices: [],
  us10yYields: [],
  vixPrices: [],
  lastUpdate: 0,
};

let goldPriceHistoryForCorrelation: number[] = [];

function calculateRollingCorrelation(x: number[], y: number[], fallback: number): number {
  const minLen = Math.min(x.length, y.length);
  if (minLen < 5) return fallback;
  
  const xSlice = x.slice(-minLen);
  const ySlice = y.slice(-minLen);
  const n = xSlice.length;
  
  const meanX = xSlice.reduce((a, b) => a + b, 0) / n;
  const meanY = ySlice.reduce((a, b) => a + b, 0) / n;
  
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  
  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - meanX;
    const dy = ySlice[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  
  const denominator = Math.sqrt(denomX * denomY);
  if (denominator === 0) return fallback;
  
  const corr = numerator / denominator;
  return parseFloat(Math.max(-1, Math.min(1, corr)).toFixed(3));
}

function calculateRealChange(history: number[]): number {
  if (history.length < 2) return 0;
  const current = history[history.length - 1];
  const previous = history[history.length - 2];
  return current - previous;
}

/**
 * PHASE 2 (C2 verification fix): change measured across a real WINDOW rather
 * than against the immediately-previous sample.
 *
 * Verified defect: intermarket samples are appended once per
 * INTERMARKET_CACHE_DURATION (10s), so `calculateRealChange(dxyPrices)` was a
 * 10-second first difference of DXY - typically 0.00-0.02. The ONLY consumer of
 * dxyChange gates at +/-0.15, so that gate could essentially never fire, and
 * dxy_weight was being fitted against a near-zero-variance column. DXY is
 * genuinely fetched (Yahoo DX=F via the backend) - the feature was not "never
 * populated", it was populated on a horizon its consumer could not use.
 *
 * Comparing against the oldest retained sample (up to 30 samples ~ 5 minutes)
 * puts the magnitude on the same scale the consumer threshold assumes.
 */
function calculateWindowedChange(history: number[], maxLookback: number): number {
  if (history.length < 2) return 0;
  const current = history[history.length - 1];
  const startIndex = Math.max(0, history.length - 1 - maxLookback);
  const reference = history[startIndex];
  if (!Number.isFinite(current) || !Number.isFinite(reference)) return 0;
  return parseFloat((current - reference).toFixed(4));
}

/** ~5 minutes of retained 10s intermarket samples. */
const DXY_CHANGE_LOOKBACK_SAMPLES = 30;

function calculateRealVelocity(history: number[]): number {
  if (history.length < 3) return 0;
  const current = history[history.length - 1];
  const previous = history[history.length - 2];
  const twoBefore = history[history.length - 3];
  const recentChange = current - previous;
  const olderChange = previous - twoBefore;
  return recentChange - olderChange;
}

async function fetchIntermarketViaBackend(): Promise<{ dxy: number; us10y: number; vix: number } | null> {
  try {
    const result = await trpcClient.goldPrice.getIntermarketData.query();
    return { dxy: result.dxy, us10y: result.us10y, vix: result.vix };
  } catch (error) {
    console.log('⚠️ Backend intermarket fetch failed:', error instanceof Error ? error.message : 'Unknown');
    return null;
  }
}

async function fetchIntermarketData(): Promise<IntermarketData> {
  const now = Date.now();
  
  if (cachedDXY !== null && cachedUS10Y !== null && cachedVIX !== null && now - lastIntermarketFetchTime < INTERMARKET_CACHE_DURATION) {
    const dxyChange = calculateWindowedChange(intermarketHistory.dxyPrices, DXY_CHANGE_LOOKBACK_SAMPLES);
    const dxyVelocity = calculateRealVelocity(intermarketHistory.dxyPrices);
    const us10yChange = calculateRealChange(intermarketHistory.us10yYields);
    const vixChange = calculateRealChange(intermarketHistory.vixPrices);
    
    return {
      dxyPrice: cachedDXY,
      dxyChange,
      dxyVelocity,
      us10yYield: cachedUS10Y,
      us10yChange,
      vixPrice: cachedVIX,
      vixChange,
      goldDxyCorrelation: calculateRollingCorrelation(goldPriceHistoryForCorrelation, intermarketHistory.dxyPrices, -0.65),
      goldYieldCorrelation: calculateRollingCorrelation(goldPriceHistoryForCorrelation, intermarketHistory.us10yYields, -0.55),
    };
  }

  const backendData = await withTimeout(
    fetchIntermarketViaBackend(),
    10000,
    'intermarketData'
  ).catch(() => null);
  
  if (backendData) {
    cachedDXY = backendData.dxy;
    cachedUS10Y = backendData.us10y;
    cachedVIX = backendData.vix;
  } else {
    if (!cachedDXY) cachedDXY = 103.5;
    if (!cachedUS10Y) cachedUS10Y = 4.2;
    if (!cachedVIX) cachedVIX = 18;
  }

  lastIntermarketFetchTime = now;

  intermarketHistory.dxyPrices.push(cachedDXY);
  intermarketHistory.us10yYields.push(cachedUS10Y);
  intermarketHistory.vixPrices.push(cachedVIX);
  intermarketHistory.lastUpdate = now;
  
  if (cachedGoldPrice) {
    goldPriceHistoryForCorrelation.push(cachedGoldPrice);
    if (goldPriceHistoryForCorrelation.length > 30) goldPriceHistoryForCorrelation.shift();
  }
  
  if (intermarketHistory.dxyPrices.length > 30) intermarketHistory.dxyPrices.shift();
  if (intermarketHistory.us10yYields.length > 30) intermarketHistory.us10yYields.shift();
  if (intermarketHistory.vixPrices.length > 30) intermarketHistory.vixPrices.shift();

  const dxyChange = calculateWindowedChange(intermarketHistory.dxyPrices, DXY_CHANGE_LOOKBACK_SAMPLES);
  const dxyVelocity = calculateRealVelocity(intermarketHistory.dxyPrices);
  const us10yChange = calculateRealChange(intermarketHistory.us10yYields);
  const vixChange = calculateRealChange(intermarketHistory.vixPrices);

  return {
    dxyPrice: cachedDXY,
    dxyChange,
    dxyVelocity,
    us10yYield: cachedUS10Y,
    us10yChange,
    vixPrice: cachedVIX,
    vixChange,
    goldDxyCorrelation: calculateRollingCorrelation(goldPriceHistoryForCorrelation, intermarketHistory.dxyPrices, -0.65),
    goldYieldCorrelation: calculateRollingCorrelation(goldPriceHistoryForCorrelation, intermarketHistory.us10yYields, -0.55),
  };
}

function markPriceSuccess(price: number, source: string, now: number): { price: number; source: string } {
  cachedGoldPrice = price;
  lastFetchTime = now;
  lastPriceSource = source;
  lastKnownGoodPrice = price;
  _consecutiveFailures = 0;
  return { price, source };
}

async function fetchWithClientTimeout(url: string, timeoutMs: number = 8000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function fetchClientSwissquote(): Promise<{ price: number; source: string } | null> {
  try {
    const response = await fetchWithClientTimeout(
      'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD',
      8000
    );
    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0) {
        const quote = data[0];
        const bid = quote?.spreadProfilePrices?.[0]?.bid;
        const ask = quote?.spreadProfilePrices?.[0]?.ask;
        if (bid && ask && typeof bid === 'number' && typeof ask === 'number') {
          const price = parseFloat(((bid + ask) / 2).toFixed(2));
          if (price > 1000 && price < 10000) {
            console.log(`✅ Client Swissquote: ${price} (bid: ${bid}, ask: ${ask})`);
            return { price, source: 'swissquote-spot' };
          }
        }
      }
    }
  } catch (e) {
    console.log('⚠️ Client Swissquote failed:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchClientMetalsLive(): Promise<{ price: number; source: string } | null> {
  try {
    const response = await fetchWithClientTimeout('https://api.metals.live/v1/spot/gold', 6000);
    if (response.ok) {
      const data = await response.json();
      if (data?.[0]?.price) {
        const price = Number(parseFloat(data[0].price.toString()).toFixed(2));
        if (price > 1000 && price < 10000) {
          console.log(`✅ Client metals.live: ${price}`);
          return { price, source: 'metals.live-spot' };
        }
      }
    }
  } catch (e) {
    console.log('⚠️ Client metals.live failed:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchClientGoldPriceOrg(): Promise<{ price: number; source: string } | null> {
  try {
    const response = await fetchWithClientTimeout('https://data-asg.goldprice.org/dbXRates/USD', 6000);
    if (response.ok) {
      const data = await response.json();
      if (data.items?.[0]?.xauPrice) {
        const price = Number(parseFloat(data.items[0].xauPrice).toFixed(2));
        if (price > 1000 && price < 10000) {
          console.log(`✅ Client goldprice.org: ${price}`);
          return { price, source: 'goldprice.org-spot' };
        }
      }
    }
  } catch (e) {
    console.log('⚠️ Client goldprice.org failed:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchClientFinnhub(): Promise<{ price: number; source: string } | null> {
  const apiKey = process.env.EXPO_PUBLIC_FINNHUB_API_KEY || '';
  if (!apiKey) return null;
  try {
    const response = await fetchWithClientTimeout(
      `https://finnhub.io/api/v1/quote?symbol=OANDA:XAU_USD&token=${apiKey}`,
      8000
    );
    if (response.ok) {
      const data = await response.json();
      const price = data?.c;
      if (typeof price === 'number' && price > 1000 && price < 10000) {
        console.log(`✅ Client Finnhub: ${price}`);
        return { price: parseFloat(price.toFixed(2)), source: 'finnhub-spot' };
      }
    }
  } catch (e) {
    console.log('⚠️ Client Finnhub failed:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchWebCorsProxy(): Promise<{ price: number; source: string } | null> {
  const proxyApis = [
    {
      name: 'frankfurter',
      url: 'https://api.frankfurter.app/latest?from=XAU&to=USD',
      parse: (data: any) => {
        if (data?.rates?.USD && typeof data.rates.USD === 'number' && data.rates.USD > 1000) {
          return data.rates.USD;
        }
        return null;
      },
    },
    {
      name: 'exchangerate',
      url: 'https://open.er-api.com/v6/latest/XAU',
      parse: (data: any) => {
        if (data?.rates?.USD && typeof data.rates.USD === 'number') {
          const price = data.rates.USD;
          if (price > 1000 && price < 10000) return price;
        }
        return null;
      },
    },
  ];

  for (const api of proxyApis) {
    try {
      console.log(`🌐 Web fallback: trying ${api.name}...`);
      const response = await fetchWithClientTimeout(api.url, 8000);
      if (response.ok) {
        const data = await response.json();
        const price = api.parse(data);
        if (price && price > 1000 && price < 10000) {
          const rounded = parseFloat(price.toFixed(2));
          console.log(`✅ Web fallback ${api.name}: ${rounded}`);
          return { price: rounded, source: `${api.name}-web` };
        }
      }
    } catch (e) {
      console.log(`⚠️ Web fallback ${api.name} failed:`, e instanceof Error ? e.message : 'Unknown');
    }
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function fetchBackendPriceWithRetry(maxRetries: number = 4): Promise<{ price: number; source: string } | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔄 Backend price fetch attempt ${attempt}/${maxRetries}...`);
      const result = await withTimeout(
        trpcClient.goldPrice.getSpotPrice.query(),
        15000,
        'getSpotPrice'
      );
      if (result.price > 0) {
        const isLive = !result.source.includes('cache') && !result.source.includes('estimate') && !result.source.includes('stale') && !result.source.includes('unavailable');
        const displaySource = isLive ? `🟢 ${result.source}` : `🟡 ${result.source}`;
        console.log(`✅ Gold price via backend: ${result.price} (${result.source})`);
        return { price: result.price, source: displaySource };
      } else {
        console.log('⚠️ Backend returned zero/unavailable price');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown';
      const is503 = msg.includes('503') || msg.includes('CORS') || msg.includes('NetworkError') || msg.includes('Failed to fetch');
      console.log(`⚠️ Backend fetch attempt ${attempt} failed: ${msg}${is503 ? ' (likely cold start 503)' : ''}`);
      if (attempt < maxRetries) {
        const delay = is503 
          ? Math.min(2000 * Math.pow(2, attempt - 1), 8000)
          : Math.min(1000 * attempt, 3000);
        console.log(`   Cold start detected - retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  return null;
}

async function fetchBackendDirectHttp(): Promise<{ price: number; source: string } | null> {
  const baseUrl = process.env.EXPO_PUBLIC_RORK_API_BASE_URL;
  if (!baseUrl) return null;

  try {
    console.log('🔄 Trying direct HTTP fallback to backend...');
    const url = `${baseUrl}/api/trpc/goldPrice.getSpotPrice?input=${encodeURIComponent(JSON.stringify({ json: null, meta: { values: ["undefined"], v: 1 } }))}`;
    const response = await fetchWithClientTimeout(url, 10000);
    if (response.ok) {
      const data = await response.json();
      const resultData = data?.result?.data;
      let price = 0;
      let source = 'direct-http';
      if (resultData?.json) {
        price = resultData.json.price;
        source = resultData.json.source || 'direct-http';
      } else if (resultData?.price) {
        price = resultData.price;
        source = resultData.source || 'direct-http';
      }
      if (typeof price === 'number' && price > 1000 && price < 10000) {
        console.log(`✅ Direct HTTP fallback success: ${price} (${source})`);
        return { price, source: `🟢 ${source}` };
      }
    } else {
      console.log(`⚠️ Direct HTTP fallback returned ${response.status}`);
    }
  } catch (e) {
    console.log('⚠️ Direct HTTP fallback failed:', e instanceof Error ? e.message : 'Unknown');
  }
  return null;
}

async function fetchLiveGoldPrice(): Promise<{ price: number; source: string }> {
  const now = Date.now();

  if (cachedGoldPrice !== null && now - lastFetchTime < CACHE_DURATION) {
    return { price: cachedGoldPrice, source: lastPriceSource };
  }

  const backendResult = await fetchBackendPriceWithRetry(3);
  if (backendResult) {
    return markPriceSuccess(backendResult.price, backendResult.source, now);
  }

  const directResult = await fetchBackendDirectHttp();
  if (directResult) {
    return markPriceSuccess(directResult.price, directResult.source, now);
  }

  console.log('🔄 Backend unavailable after retries, trying direct client-side sources...');

  const clientFetches: Promise<{ price: number; source: string } | null>[] = [];

  if (Platform.OS === 'web') {
    console.log('🌐 Web platform: trying CORS-friendly APIs...');
    clientFetches.push(
      fetchClientMetalsLive(),
      fetchClientGoldPriceOrg(),
      fetchWebCorsProxy(),
    );
  } else {
    clientFetches.push(
      fetchClientFinnhub(),
      fetchClientSwissquote(),
      fetchClientMetalsLive(),
      fetchClientGoldPriceOrg(),
    );
  }

  const clientResults = await Promise.allSettled(clientFetches);

  const validPrices: { price: number; source: string }[] = [];
  for (const result of clientResults) {
    if (result.status === 'fulfilled' && result.value) {
      validPrices.push(result.value);
    }
  }

  if (validPrices.length >= 2) {
    validPrices.sort((a, b) => a.price - b.price);
    const median = validPrices[Math.floor(validPrices.length / 2)];
    const filtered = validPrices.filter(p => Math.abs(p.price - median.price) < 15);
    if (filtered.length >= 2) {
      const avgPrice = parseFloat((filtered.reduce((sum, p) => sum + p.price, 0) / filtered.length).toFixed(2));
      const sourceNames = filtered.map(p => p.source).join('+');
      console.log(`✅ Client consensus (${filtered.length} sources): ${avgPrice}`);
      return markPriceSuccess(avgPrice, `🟢 ${sourceNames}`, now);
    }
  }

  if (validPrices.length === 1) {
    const best = validPrices[0];
    console.log(`✅ Client single source: ${best.price} (${best.source})`);
    return markPriceSuccess(best.price, `🟢 ${best.source}`, now);
  }

  _consecutiveFailures++;

  if (cachedGoldPrice !== null && now - lastFetchTime < 600000) {
    const ageSeconds = ((now - lastFetchTime) / 1000).toFixed(0);
    console.log(`⚠️ Using cached price (${ageSeconds}s old): ${cachedGoldPrice}`);
    lastPriceSource = `🟡 cache (${ageSeconds}s)`;
    return { price: cachedGoldPrice, source: lastPriceSource };
  }

  if (cachedGoldPrice !== null) {
    const ageSeconds = ((now - lastFetchTime) / 1000).toFixed(0);
    console.warn(`⚠️ Using stale cached price (${ageSeconds}s old): ${cachedGoldPrice}`);
    lastPriceSource = `🟠 stale (${ageSeconds}s)`;
    return { price: cachedGoldPrice, source: lastPriceSource };
  }

  if (lastKnownGoodPrice > 0) {
    console.warn(`⚠️ Using last known good price: ${lastKnownGoodPrice}`);
    lastPriceSource = '🟠 last-known';
    return { price: lastKnownGoodPrice, source: lastPriceSource };
  }

  console.warn('⚠️ No price data available yet, waiting for first successful fetch...');
  lastPriceSource = '🔴 waiting';
  return { price: 0, source: lastPriceSource };
}

class SignalGenerationEngine {
  private currentPrice: number = 0;
  private priceHistory: number[] = [];
  private highHistory: number[] = [];
  private lowHistory: number[] = [];
  private closeHistory: number[] = [];
  /**
   * Item 3 fix: bar-aligned close series, built in LOCKSTEP with
   * highHistory/lowHistory (same source, same wholesale-replace/push calls,
   * same length at all times) -- unlike priceHistory/closeHistory, which are
   * grown independently on the tick-arrival cadence. calculateRealATR() reads
   * prevClose from THIS array specifically so that highs[i]/lows[i]/closes[i]
   * always refer to the same underlying bar, eliminating the array-misalignment
   * defect where a tick-cadence close was paired with a bar-cadence high/low
   * purely by shared array index.
   */
  private barCloseHistory: number[] = [];
  private lastPriceHistorySampleAt: number = 0;
  private volumeHistory: number[] = [];
  private tradeOutcomes: TradeOutcome[] = [];
  private modelWeights: Map<string, number> = new Map();
  private lastTrainingTime: number = 0;
  private performanceMetrics: {
    recentWinRate: number;
    profitFactor: number;
    avgConfidence: number;
    recentWinningConfidences: number[];
  } = { recentWinRate: 0.65, profitFactor: 1.8, avgConfidence: 0.75, recentWinningConfidences: [] };
  private lastSignalType: SignalType | null = null;
  private lastSignalTime: number = 0;
  private nearMisses: NearMissEntry[] = [];
  private diffBucketStats: { low: { wins: number; losses: number }; mid: { wins: number; losses: number }; high: { wins: number; losses: number } } = { low: { wins: 0, losses: 0 }, mid: { wins: 0, losses: 0 }, high: { wins: 0, losses: 0 } };
  private lastSignalStrengthDifference: number = 0;
  private lastBuySignalTime: number = 0;
  private lastSellSignalTime: number = 0;
  private lastMarketRegime: MarketRegime | null = null;
  private signalGenerationAttempts: number = 0;
  private signalsGeneratedCount: number = 0;
  private successfulSignalsGenerated: number = 0;
  private recentAttemptTimestamps: number[] = [];
  private lastKnownSpreadPips: number = 0;
  /**
   * Part B — real order-flow signal. Rolling real tick-arrival timestamps
   * (retained up to TICK_HISTORY_MAX_AGE_MS) and their raw prices, captured on
   * EVERY live tick received via syncCurrentPrice — unlike priceHistory, which
   * is deliberately deduplicated/downsampled for signal-history quality
   * (MIN_PRICE_HISTORY_CHANGE / MIN_PRICE_HISTORY_SAMPLE_INTERVAL_MS). These
   * two arrays are the genuine tick-frequency + tick-price record used to
   * replace the old synthetic momentum-derived order-flow/volume-profile inputs.
   */
  private tickTimestamps: number[] = [];
  private tickPriceSamples: { price: number; timestamp: number }[] = [];
  /**
   * Bugfix: recordTickArrival() used to count EVERY raw tick reaching
   * syncCurrentPrice() toward real tick-frequency/activity, including a lone
   * uncorroborated glitch tick -- the exact kind of tick the bar-ingest spike
   * gate in TradingContext.tsx (barGate/classifyTick) exists to reject before
   * it can contaminate OHLC bars. signalEngine.ts doesn't have access to that
   * gate's state (it lives in the React context), so this replicates the same
   * two-tick corroboration standard locally: a tick that jumps further than a
   * time-scaled budget only counts toward tick-frequency once a second,
   * independent tick corroborates the new level. This affects ONLY what counts
   * toward the order-flow tick-frequency signal -- the on-screen price
   * (currentPrice) is unaffected and still updates on every tick as before.
   */
  private tickFrequencyGateState: { lastPrice: number; lastAt: number; pendingPrice: number; pendingAt: number } = { lastPrice: 0, lastAt: 0, pendingPrice: 0, pendingAt: 0 };
  /** Rolling history of real bid/ask spread readings (pips), feeding calculateSpreadRatio(). */
  private spreadHistory: number[] = [];
  /**
   * Phase 2 (A2): wall-clock of the last CONFIRMED stop-out per direction, so a
   * fresh same-direction re-entry can be blocked for a cooldown window. Audit
   * measured a 13.3% win rate (n=30) on same-direction re-entries inside 15 min
   * of a stop, and P(loss | prev loss) = 54.7% vs a 40.9% baseline.
   */
  private lastBuyStopOutTime: number = 0;
  private lastSellStopOutTime: number = 0;
  /**
   * PHASE 2 (C4): rolling realised expectancy per direction, in R, computed
   * only from resolved NON-scratch outcomes that carry a realizedR. Feeds the
   * direction-bucketed calibration penalty.
   */
  private directionalExpectancy: { BUY: { n: number; meanR: number }; SELL: { n: number; meanR: number } } = {
    BUY: { n: 0, meanR: 0 },
    SELL: { n: 0, meanR: 0 },
  };
  private confidenceHistory: number[] = [];
  private lastFeatureCorrelationCheck: number = 0;
  private featureCorrelationStatus: string = 'HEALTHY';
  private modelHealthScore: number = 100;
  private lastDriftCheck: number = 0;
  private featureDistributionHistory: Map<string, number[]> = new Map();
  private featureImportanceHistory: Map<string, number[]> = new Map();
  private conceptDriftScore: number = 0;
  private driftAlertLevel: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' = 'NONE';
  private retrainScheduled: boolean = false;
  private dailyOHLCHistory: DailyOHLC[] = [];
  private currentDayOHLC: { open: number; high: number; low: number; close: number; date: string } | null = null;
  private lastNYCloseCheck: number = 0;
  private orderBlocks: OrderBlock[] = [];
  private fiveMinCandles: { timestamp: number; open: number; high: number; low: number; close: number }[] = [];
  private lastFiveMinCandleClose: number = 0;
  private quasimodolLevels: QuasimodolLevel[] = [];
  private sessionSweeps: SessionSweep[] = [];
  /**
   * PHASE 2 (B4): open penetrations awaiting a reclaim, keyed
   * `${sessionType}-${type}`. A sweep is only emitted once one of these is
   * reclaimed inside SWEEP_RECLAIM_WINDOW_MS.
   */
  private pendingSweepPenetrations: Map<string, { level: number; extreme: number; firstAt: number }> = new Map();
  private srZones: SRZone[] = [];
  private asianSessionHigh: number = 0;
  private asianSessionLow: number = Infinity;
  private londonSessionHigh: number = 0;
  private londonSessionLow: number = Infinity;
  private nySessionHigh: number = 0;
  private nySessionLow: number = Infinity;
  /**
   * Step 5a: the Asian range frozen at the moment London opens, so it stays
   * available through London/NY for sweep + zone detection instead of being
   * silently replaced by a rolling recent-tick proxy the moment new data
   * arrives (which is what MarketFeatures.asianHigh/asianLow used to do).
   */
  private frozenAsianHigh: number = 0;
  private frozenAsianLow: number = Infinity;
  private asianRangeFrozenForToday: boolean = false;
  /** Step 5c: London/NY opening-range (first 30 min) highs/lows, distinct from the ongoing session high/low. */
  private londonOR: { high: number; low: number; captured: boolean } = { high: 0, low: Infinity, captured: false };
  private nyOR: { high: number; low: number; captured: boolean } = { high: 0, low: Infinity, captured: false };
  private lastOpeningRangeResetDate: string = '';
  private lastSessionUpdate: number = 0;
  private lastOHLCFetchTime: number = 0;
  private ohlcDataSource: string = 'estimated';
  /**
   * Systematic 4-hour UTC block range tracker: six fixed blocks per day
   * (00-04, 04-08, 08-12, 12-16, 16-20, 20-24 UTC), distinct from the
   * Asian/London/NY session tracking above. Each block's range is retained
   * (not discarded) once the clock moves past it — only the currently-active
   * (unfrozen) block keeps updating.
   */
  private sessionBlockHighs: number[] = [0, 0, 0, 0, 0, 0];
  private sessionBlockLows: number[] = [Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
  private sessionBlockFrozen: boolean[] = [false, false, false, false, false, false];
  private lastSessionBlockDateKey: string = '';
  private lastDailyOHLCRefreshAt: number = 0;
  /**
   * Option A (S/R zone persistence): durable TIER 0 zones read from the
   * server-side sr_zones_v1 cache (computed from gold_m1_bars). Null until
   * the first successful fetch, or if the fetch fails/returns nothing -- in
   * either case detectSRZones() falls back to its own TIER 1 local
   * computation below, exactly as it did before this change.
   */
  private tier0SRZones: SRZone[] | null = null;
  private tier0SRZonesFetchedAt: number = 0;
  private lastTier0SRZonesFetchAttemptAt: number = 0;
  private lastServerSRZonesRefreshTriggerAt: number = 0;
  /** How long a successful TIER 0 fetch stays valid before requiring a refetch. */
  private static readonly TIER0_SRZONES_TTL_MS = 15 * 60 * 1000;
  /** Throttle for both the TIER 0 read and the fire-and-forget server recompute trigger. */
  private static readonly TIER0_SRZONES_FETCH_INTERVAL_MS = 10 * 60 * 1000;
  /**
   * STEP 1/STEP 2: granular real-instrument tag for whichever tier actually fed
   * highHistory/lowHistory/barCloseHistory on the most recent refresh -- e.g.
   * 'twelvedata-spot', 'yahoo-futures-fallback', 'local-5min-candles',
   * 'estimated-synthetic'. Deliberately kept SEPARATE from this.ohlcDataSource
   * (which stays exactly as it was, since existing dataQualityPenalty gating
   * checks `=== 'estimated'` / `=== '5min-candles'` elsewhere and must not change
   * behavior) -- this field exists purely so the new diagnostic event log (Step 2)
   * can report which real instrument actually generated a given signal.
   */
  private ohlcSourceDetail: string = 'unknown';

  /** Step 2 diagnostic seam: expose the granular real-instrument tag for logging. */
  public getOhlcSourceDetail(): string {
    return this.ohlcSourceDetail;
  }

  private async fetchAndUpdateOHLCHistory(): Promise<void> {
    const now = Date.now();
    const OHLC_FETCH_INTERVAL = 60000;
    
    if (now - this.lastOHLCFetchTime < OHLC_FETCH_INTERVAL) {
      return;
    }
    this.lastOHLCFetchTime = now;
    
    try {
      const toTime = now;
      const fromTime = now - (100 * 60 * 1000);
      
      const bars = await fetchHistoricalData({
        fromTime,
        toTime,
        timeoutMs: 10000,
      });
      
      if (bars && bars.length > 0) {
        this.highHistory = bars.map((b: { high: number }) => b.high);
        this.lowHistory = bars.map((b: { low: number }) => b.low);
        this.barCloseHistory = bars.map((b: { close: number }) => b.close);
        this.ohlcDataSource = 'real-ohlc';
        // STEP 1/STEP 2: bars carry an explicit `source` tag now (see lib/trpc.ts +
        // backend goldPrice.ts) -- surface the REAL instrument (spot vs futures
        // fallback) instead of the generic 'real-ohlc' label so a future
        // investigation never again has to reverse-engineer this from indirect ATR
        // evidence the way this session had to.
        const barSource = (bars[0] as { source?: string })?.source;
        this.ohlcSourceDetail = barSource ?? 'real-ohlc-untagged';
        console.log(`✅ OHLC: Loaded ${bars.length} real 1-min bars (source=${this.ohlcSourceDetail})`);
        this.logOhlcSourceDiagnostic(bars.length);
        return;
      }
    } catch (error) {
      console.log('⚠️ OHLC fetch failed, using 5-min candle fallback:', error instanceof Error ? error.message : 'Unknown');
    }
    
    if (this.fiveMinCandles.length >= 5) {
      this.highHistory = this.fiveMinCandles.map(c => c.high);
      this.lowHistory = this.fiveMinCandles.map(c => c.low);
      this.barCloseHistory = this.fiveMinCandles.map(c => c.close);
      this.ohlcDataSource = '5min-candles';
      this.ohlcSourceDetail = 'local-5min-candles';
      console.log(`📊 OHLC: Using ${this.fiveMinCandles.length} locally-built 5-min candles for H/L`);
      this.logOhlcSourceDiagnostic(this.fiveMinCandles.length);
      return;
    }
    
    const realVolatility = this.calculateRealTimeVolatility();
    const priceDirection = this.detectPriceDirection();
    
    let estimatedHigh: number;
    let estimatedLow: number;
    
    if (priceDirection > 0) {
      estimatedHigh = this.currentPrice + (realVolatility * 0.6);
      estimatedLow = this.currentPrice - (realVolatility * 0.3);
    } else if (priceDirection < 0) {
      estimatedHigh = this.currentPrice + (realVolatility * 0.3);
      estimatedLow = this.currentPrice - (realVolatility * 0.6);
    } else {
      estimatedHigh = this.currentPrice + (realVolatility * 0.4);
      estimatedLow = this.currentPrice - (realVolatility * 0.4);
    }
    
    this.highHistory.push(estimatedHigh);
    this.lowHistory.push(estimatedLow);
    // Estimated fallback pushes one bar-equivalent at a time (unlike the two
    // wholesale-replace branches above) -- mirror that single push into
    // barCloseHistory using the actual current price as this synthetic bar's
    // close, keeping all three arrays the same length/order at all times.
    this.barCloseHistory.push(this.currentPrice);
    
    if (this.highHistory.length > 100) {
      this.highHistory.shift();
      this.lowHistory.shift();
    }
    if (this.barCloseHistory.length > 100) {
      this.barCloseHistory.shift();
    }
    this.ohlcDataSource = 'estimated';
    this.ohlcSourceDetail = 'estimated-synthetic';
    this.logOhlcSourceDiagnostic(this.highHistory.length);
  }

  /**
   * STEP 2 (GC=F/spot investigation): durable, fire-and-forget record of which
   * real instrument/tier fed highHistory/lowHistory/barCloseHistory on this
   * refresh cycle. Already naturally throttled to once per
   * fetchAndUpdateOHLCHistory call (60s), matching the "one row per meaningful
   * event" standard the rest of the diagnostic event log already follows --
   * purely additive observability, never awaited, never able to affect
   * generation/gating.
   */
  private logOhlcSourceDiagnostic(barCount: number): void {
    void appendDiagnosticEvent({
      ts: Date.now(),
      signalId: GENERATION_DIAGNOSTIC_SIGNAL_ID,
      eventType: 'GENERATION_OHLC_SOURCE',
      price: this.currentPrice,
      detail: { ohlcDataSource: this.ohlcDataSource, ohlcSourceDetail: this.ohlcSourceDetail, barCount },
    }).catch(err => console.warn('⚠️ [DiagnosticEventStore] generation-ohlc-source event log failed (non-blocking):', err));
  }
  
  private syncCurrentPrice(price: number, source: string): void {
    const now = Date.now();
    const previousPrice = this.currentPrice;
    const priceChangedMeaningfully = previousPrice <= 0 || Math.abs(price - previousPrice) >= MIN_PRICE_HISTORY_CHANGE;
    const shouldSampleHistory = priceChangedMeaningfully || (now - this.lastPriceHistorySampleAt) >= MIN_PRICE_HISTORY_SAMPLE_INTERVAL_MS;

    this.currentPrice = price;
    lastPriceSource = source;

    // Part B: record EVERY real tick arrival (not just the deduplicated/downsampled
    // priceHistory samples above) — this is the genuine tick-frequency + tick-price
    // record that replaces the old synthetic momentum-derived order-flow inputs.
    this.recordTickArrival(now, price);

    if (shouldSampleHistory) {
      this.lastPriceHistorySampleAt = now;

      this.priceHistory.push(price);
      if (this.priceHistory.length > 100) {
        this.priceHistory.shift();
      }

      this.closeHistory.push(price);
      if (this.closeHistory.length > 100) {
        this.closeHistory.shift();
      }
    } else {
      console.log(`ℹ️ Suppressing duplicate live tick ${price.toFixed(2)} from ${source} to preserve signal history quality`);
    }

    this.fetchAndUpdateOHLCHistory().catch(err => {
      console.warn('⚠️ Non-blocking OHLC fetch failed:', err instanceof Error ? err.message : 'Unknown');
    });

    this.update5MinCandles();
  }

  async updateCurrentPrice(): Promise<number> {
    try {
      const now = Date.now();
      const hasFreshExternalPrice = cachedGoldPrice !== null && (now - lastFetchTime) < EXTERNAL_PRICE_MAX_AGE_MS;

      if (hasFreshExternalPrice && cachedGoldPrice !== null) {
        this.syncCurrentPrice(cachedGoldPrice, lastPriceSource);
        console.log(`📊 Using live external price ${this.currentPrice.toFixed(2)} from ${lastPriceSource}`);
      } else {
        const result = await fetchLiveGoldPrice();

        if (result.price > 0) {
          cachedGoldPrice = result.price;
          lastFetchTime = Date.now();
          lastKnownGoodPrice = result.price;
          _consecutiveFailures = 0;
          this.syncCurrentPrice(result.price, result.source);
          console.log(`📊 Price set to ${this.currentPrice.toFixed(2)} from ${result.source}`);
        } else {
          console.warn(`⚠️ Invalid price received (${result.price}), keeping previous price: ${this.currentPrice}`);
          return this.currentPrice;
        }
      }

      const latestHigh = this.highHistory.length > 0 ? this.highHistory[this.highHistory.length - 1] : this.currentPrice;
      const latestLow = this.lowHistory.length > 0 ? this.lowHistory[this.lowHistory.length - 1] : this.currentPrice;
      const realVolatility = this.calculateRealTimeVolatility();
      const priceDirection = this.detectPriceDirection();

      console.log(`📊 Price Detail: Close=${this.currentPrice.toFixed(1)}, H=${latestHigh.toFixed(1)}, L=${latestLow.toFixed(1)} | Vol: ${realVolatility.toFixed(2)} | Dir: ${priceDirection > 0 ? '↑' : priceDirection < 0 ? '↓' : '→'} | OHLC: ${this.ohlcDataSource}`);

      return this.currentPrice;
    } catch (error) {
      console.error('❌ Failed to update current price:', error instanceof Error ? error.message : 'Unknown');
      return this.currentPrice;
    }
  }
  
  private calculateRealTimeVolatility(): number {
    if (this.priceHistory.length < 5) return 2.0;
    
    const recent = this.priceHistory.slice(-20);
    const changes: number[] = [];
    
    for (let i = 1; i < recent.length; i++) {
      changes.push(Math.abs(recent[i] - recent[i - 1]));
    }
    
    if (changes.length === 0) return 2.0;
    
    const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
    const maxChange = Math.max(...changes);
    
    const volatility = (avgChange * 0.7) + (maxChange * 0.3);
    return Math.max(0.5, Math.min(10, volatility));
  }
  
  private detectPriceDirection(): number {
    if (this.priceHistory.length < 5) return 0;
    
    const recent = this.priceHistory.slice(-5);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const diff = last - first;
    
    if (diff > 1) return 1;
    if (diff < -1) return -1;
    return 0;
  }

  async updateDailyOHLC(currentPrice: number): Promise<DailyOHLC | null> {
    const now = new Date();
    const dateKey = this.getNYTradingDayKey(now);

    if (!this.currentDayOHLC) {
      console.log(`📅 Starting tracked trading day: ${dateKey}`);
      this.currentDayOHLC = {
        date: dateKey,
        open: currentPrice,
        high: currentPrice,
        low: currentPrice,
        close: currentPrice,
      };
      return null;
    }

    if (this.currentDayOHLC.date !== dateKey) {
      const completedBar = await this.persistCompletedTradingDayBar(this.currentDayOHLC, 'day-rollover');
      console.log(`📅 Trading day rollover: ${this.currentDayOHLC.date} → ${dateKey}`);
      this.currentDayOHLC = {
        date: dateKey,
        open: currentPrice,
        high: currentPrice,
        low: currentPrice,
        close: currentPrice,
      };
      return completedBar;
    }

    this.currentDayOHLC.high = Math.max(this.currentDayOHLC.high, currentPrice);
    this.currentDayOHLC.low = Math.min(this.currentDayOHLC.low, currentPrice);
    this.currentDayOHLC.close = currentPrice;

    return null;
  }
  
  private getNYTradingDayKey(date: Date): string {
    const NY_CLOSE_HOUR_UTC = 21;
    const hour = date.getUTCHours();
    
    const tradingDate = new Date(date);
    if (hour >= NY_CLOSE_HOUR_UTC) {
      tradingDate.setUTCDate(tradingDate.getUTCDate() + 1);
    }
    
    const year = tradingDate.getUTCFullYear();
    const month = String(tradingDate.getUTCMonth() + 1).padStart(2, '0');
    const day = String(tradingDate.getUTCDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
  }

  private getNYTradingDayCloseTimestamp(dateKey: string): number {
    const [yearString, monthString, dayString] = dateKey.split('-');
    const year = Number.parseInt(yearString ?? '', 10);
    const month = Number.parseInt(monthString ?? '', 10);
    const day = Number.parseInt(dayString ?? '', 10);

    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      console.warn(`⚠️ Invalid NY trading day key received for close timestamp: ${dateKey}`);
      return Date.now();
    }

    return Date.UTC(year, month - 1, day, 21, 0, 0, 0);
  }

  private async persistCompletedTradingDayBar(
    tradingDay: { open: number; high: number; low: number; close: number; date: string },
    reason: 'day-rollover' | 'historical-refresh',
  ): Promise<DailyOHLC> {
    const completedBar: DailyOHLC = {
      date: tradingDay.date,
      open: tradingDay.open,
      high: tradingDay.high,
      low: tradingDay.low,
      close: tradingDay.close,
      timestamp: this.getNYTradingDayCloseTimestamp(tradingDay.date),
    };

    const existingIndex = this.dailyOHLCHistory.findIndex((bar) => bar.date === completedBar.date);
    if (existingIndex >= 0) {
      this.dailyOHLCHistory[existingIndex] = completedBar;
    } else {
      this.dailyOHLCHistory.push(completedBar);
    }

    this.dailyOHLCHistory = [...this.dailyOHLCHistory]
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-30);

    console.log(`📊 Daily OHLC persisted (${reason}): ${completedBar.date} | O: ${completedBar.open.toFixed(1)} H: ${completedBar.high.toFixed(1)} L: ${completedBar.low.toFixed(1)} C: ${completedBar.close.toFixed(1)}`);

    await this.saveDailyOHLCHistory();

    return completedBar;
  }

  private buildDailyOHLCBarsFromHistoricalBars(
    bars: { timestamp: number; open: number; high: number; low: number; close: number }[],
    now: number,
  ): DailyOHLC[] {
    const groupedBars = new Map<string, DailyOHLC>();
    const orderedBars = [...bars].sort((left, right) => left.timestamp - right.timestamp);

    orderedBars.forEach((bar) => {
      const dateKey = this.getNYTradingDayKey(new Date(bar.timestamp));
      const closeTimestamp = this.getNYTradingDayCloseTimestamp(dateKey);
      const existingBar = groupedBars.get(dateKey);

      if (!existingBar) {
        groupedBars.set(dateKey, {
          date: dateKey,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          timestamp: closeTimestamp,
        });
        return;
      }

      existingBar.high = Math.max(existingBar.high, bar.high);
      existingBar.low = Math.min(existingBar.low, bar.low);
      existingBar.close = bar.close;
    });

    return Array.from(groupedBars.values())
      .filter((bar) => bar.timestamp <= now)
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  private mergeDailyOHLCBars(bars: DailyOHLC[]): boolean {
    const existingSnapshot = JSON.stringify(
      [...this.dailyOHLCHistory].sort((left, right) => left.timestamp - right.timestamp),
    );
    const mergedBars = new Map<string, DailyOHLC>();

    this.dailyOHLCHistory.forEach((bar) => {
      mergedBars.set(bar.date, bar);
    });

    bars.forEach((bar) => {
      mergedBars.set(bar.date, bar);
    });

    const nextHistory = Array.from(mergedBars.values())
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-30);

    const nextSnapshot = JSON.stringify(nextHistory);
    if (nextSnapshot === existingSnapshot) {
      return false;
    }

    this.dailyOHLCHistory = nextHistory;
    return true;
  }

  private shouldRefreshDailyOHLCFromHistory(now: number): boolean {
    if (this.dailyOHLCHistory.length === 0) {
      return true;
    }

    const latestCompletedBar = [...this.dailyOHLCHistory].sort((left, right) => right.timestamp - left.timestamp)[0];
    if (!latestCompletedBar) {
      return true;
    }

    const expectedTimestamp = this.getNYTradingDayCloseTimestamp(latestCompletedBar.date);
    const range = latestCompletedBar.high - latestCompletedBar.low;
    const timestampLooksWrong = !Number.isFinite(latestCompletedBar.timestamp) || Math.abs(latestCompletedBar.timestamp - expectedTimestamp) > 60_000;
    const rangeLooksBroken = !Number.isFinite(range) || range < MIN_VALID_DAILY_RANGE;
    const dataIsStale = (now - latestCompletedBar.timestamp) > DAILY_OHLC_REFRESH_LOOKBACK_MS;

    return timestampLooksWrong || rangeLooksBroken || dataIsStale;
  }

  private async refreshRecentDailyOHLCFromHistory(force: boolean = false): Promise<void> {
    const now = Date.now();

    if (!force && (now - this.lastDailyOHLCRefreshAt) < DAILY_OHLC_REFRESH_INTERVAL_MS) {
      return;
    }

    if (!force && !this.shouldRefreshDailyOHLCFromHistory(now)) {
      return;
    }

    this.lastDailyOHLCRefreshAt = now;
    console.log('📊 Refreshing daily OHLC cache from recent historical minute bars...');

    try {
      const minuteBars = await fetchHistoricalData({
        fromTime: now - DAILY_OHLC_REFRESH_LOOKBACK_MS,
        toTime: now,
        timeoutMs: 20000,
      });

      if (minuteBars.length === 0) {
        console.warn('⚠️ Daily OHLC refresh returned no historical minute bars');
        return;
      }

      const rebuiltDailyBars = this.buildDailyOHLCBarsFromHistoricalBars(minuteBars, now);
      if (rebuiltDailyBars.length === 0) {
        console.warn('⚠️ Daily OHLC refresh could not derive any completed daily bars');
        return;
      }

      const historyChanged = this.mergeDailyOHLCBars(rebuiltDailyBars);
      if (!historyChanged) {
        console.log('ℹ️ Daily OHLC refresh found no changes');
        return;
      }

      await this.saveDailyOHLCHistory();
      console.log(`✅ Daily OHLC refresh rebuilt ${rebuiltDailyBars.length} completed trading day bar(s)`);
    } catch (error) {
      console.warn('⚠️ Daily OHLC refresh failed:', error instanceof Error ? error.message : 'Unknown');
    }
  }
  
  getCurrentPrice(): number {
    return this.currentPrice;
  }
  
  getPriceSource(): string {
    return lastPriceSource;
  }

  pushExternalPrice(price: number, source: string): void {
    if (price <= 1000 || price > 10000 || isNaN(price)) {
      console.warn(`⚠️ pushExternalPrice: Invalid price ${price}, ignoring`);
      return;
    }

    this.syncCurrentPrice(price, source);
  }
  
  /**
   * Part B: rolling real tick-arrival tracker. Called on every genuine live
   * tick (pushExternalPrice/syncCurrentPrice), retaining up to TICK_HISTORY_MAX_AGE_MS
   * of real arrival timestamps + prices for tick-frequency-based order-flow analysis.
   */
  private recordTickArrival(now: number, price: number): void {
    if (!this.isTickCorroboratedForFrequency(price, now)) {
      console.warn(`🛡️ [OrderFlow] Excluding uncorroborated tick ${price.toFixed(1)} from real tick-frequency signal -- awaiting a 2nd corroborating tick (same standard as the bar-ingest spike gate)`);
      return;
    }

    this.tickTimestamps.push(now);
    this.tickPriceSamples.push({ price, timestamp: now });

    const TICK_HISTORY_MAX_AGE_MS = 10 * 60 * 1000;
    while (this.tickTimestamps.length > 0 && now - this.tickTimestamps[0] > TICK_HISTORY_MAX_AGE_MS) {
      this.tickTimestamps.shift();
    }
    while (this.tickPriceSamples.length > 0 && now - this.tickPriceSamples[0].timestamp > TICK_HISTORY_MAX_AGE_MS) {
      this.tickPriceSamples.shift();
    }
    // Hard cap as a safety net independent of timing (e.g. a burst of ticks in a short span)
    if (this.tickTimestamps.length > 2000) this.tickTimestamps = this.tickTimestamps.slice(-2000);
    if (this.tickPriceSamples.length > 2000) this.tickPriceSamples = this.tickPriceSamples.slice(-2000);
  }

  /**
   * Lightweight two-tick spike gate mirroring TradingContext.tsx's classifyTick,
   * scoped to this engine's own tick-frequency counting only. A plausible move
   * (within the time-scaled budget) is accepted immediately; a jump beyond the
   * budget is only accepted once a second, independent tick corroborates the
   * new level within the confirm window -- otherwise it's a lone glitch and is
   * excluded from the real tick-frequency/activity signal.
   */
  private isTickCorroboratedForFrequency(price: number, now: number): boolean {
    const TICK_FREQ_PIP_VALUE = 0.1;
    const TICK_FREQ_SPIKE_BASE_PIPS = 8.0;
    const TICK_FREQ_SPIKE_RATE_PIPS_PER_SEC = 6.0;
    const TICK_FREQ_SPIKE_BUDGET_CAP_MS = 10000;
    const TICK_FREQ_CONFIRM_WINDOW_MS = 60000;
    const TICK_FREQ_CONFIRM_TOL_PIPS = 25;

    const state = this.tickFrequencyGateState;

    if (!(state.lastPrice > 0) || !(state.lastAt > 0) || now < state.lastAt) {
      state.lastPrice = price;
      state.lastAt = now;
      state.pendingPrice = 0;
      state.pendingAt = 0;
      return true;
    }

    const dtMs = now - state.lastAt;
    const gapPips = Math.abs(price - state.lastPrice) / TICK_FREQ_PIP_VALUE;
    const effectiveDtMs = Math.min(dtMs, TICK_FREQ_SPIKE_BUDGET_CAP_MS);
    const budgetPips = TICK_FREQ_SPIKE_BASE_PIPS + TICK_FREQ_SPIKE_RATE_PIPS_PER_SEC * (effectiveDtMs / 1000);

    if (gapPips <= budgetPips) {
      state.lastPrice = price;
      state.lastAt = now;
      state.pendingPrice = 0;
      state.pendingAt = 0;
      return true;
    }

    const pendingFresh = state.pendingAt > 0 && now - state.pendingAt <= TICK_FREQ_CONFIRM_WINDOW_MS;
    const corroborated = pendingFresh && Math.abs(price - state.pendingPrice) / TICK_FREQ_PIP_VALUE <= TICK_FREQ_CONFIRM_TOL_PIPS;

    if (corroborated) {
      state.lastPrice = price;
      state.lastAt = now;
      state.pendingPrice = 0;
      state.pendingAt = 0;
      return true;
    }

    state.pendingPrice = price;
    state.pendingAt = now;
    return false;
  }

  /**
   * Part B: real tick-arrival-frequency ratio — recent (last 60s) tick rate vs.
   * the baseline tick rate observed over the retained tick-history window.
   * ratio > 1 = genuinely busier than the recent baseline (more real market activity);
   * ratio < 1 = genuinely quieter. Returns sufficient:false (neutral ratio 1.0) when
   * there isn't yet enough real tick history to trust the comparison — this is a clearly
   * flagged fallback, not a fabricated synthetic reading.
   */
  private calculateTickFrequencyRatio(): { ratio: number; sufficient: boolean } {
    const now = Date.now();
    const RECENT_WINDOW_MS = 60 * 1000;
    const MIN_BASELINE_SPAN_MS = 3 * 60 * 1000;
    const MIN_BASELINE_TICKS = 10;

    const oldestTick = this.tickTimestamps[0];
    const baselineSpanMs = oldestTick ? now - oldestTick : 0;

    if (this.tickTimestamps.length < MIN_BASELINE_TICKS || baselineSpanMs < MIN_BASELINE_SPAN_MS) {
      return { ratio: 1.0, sufficient: false };
    }

    const recentCount = this.tickTimestamps.filter(t => now - t <= RECENT_WINDOW_MS).length;
    const baselineTicksPerMinute = this.tickTimestamps.length / (baselineSpanMs / 60000);
    const recentTicksPerMinute = recentCount / (RECENT_WINDOW_MS / 60000);

    if (baselineTicksPerMinute <= 0) return { ratio: 1.0, sufficient: false };

    return { ratio: parseFloat((recentTicksPerMinute / baselineTicksPerMinute).toFixed(2)), sufficient: true };
  }

  /**
   * Part B: real bid/ask spread ratio — the latest genuine spread reading
   * (from setLastKnownSpread, sourced from real Swissquote bid/ask data) vs.
   * the rolling average of recent real spread readings. ratio < 1 = tighter/
   * more liquid than typical; ratio > 1 = wider/thinner than typical.
   * Returns sufficient:false until enough real spread readings have accumulated.
   */
  private calculateSpreadRatio(): { ratio: number; sufficient: boolean } {
    const MIN_SPREAD_SAMPLES = 5;
    if (this.lastKnownSpreadPips <= 0 || this.spreadHistory.length < MIN_SPREAD_SAMPLES) {
      return { ratio: 1.0, sufficient: false };
    }
    const avgSpread = this.spreadHistory.reduce((a, b) => a + b, 0) / this.spreadHistory.length;
    if (avgSpread <= 0) return { ratio: 1.0, sufficient: false };

    return { ratio: parseFloat((this.lastKnownSpreadPips / avgSpread).toFixed(2)), sufficient: true };
  }

  /**
   * Test seam (Part B checkpoint): temporarily swap in injected real tick-arrival/
   * spread data (and optionally priceHistory), run the real calculateOrderFlow(),
   * then restore prior state. Lets the tick-frequency + spread logic be verified
   * deterministically without waiting on real wall-clock tick arrivals.
   */
  calculateOrderFlowForTest(injected: { tickTimestamps?: number[]; spreadHistory?: number[]; lastKnownSpreadPips?: number; priceHistory?: number[] }): OrderFlowData {
    const saved = {
      tickTimestamps: this.tickTimestamps,
      spreadHistory: this.spreadHistory,
      lastKnownSpreadPips: this.lastKnownSpreadPips,
      priceHistory: this.priceHistory,
    };
    if (injected.tickTimestamps) this.tickTimestamps = injected.tickTimestamps;
    if (injected.spreadHistory) this.spreadHistory = injected.spreadHistory;
    if (injected.lastKnownSpreadPips !== undefined) this.lastKnownSpreadPips = injected.lastKnownSpreadPips;
    if (injected.priceHistory) this.priceHistory = injected.priceHistory;
    try {
      return this.calculateOrderFlow();
    } finally {
      this.tickTimestamps = saved.tickTimestamps;
      this.spreadHistory = saved.spreadHistory;
      this.lastKnownSpreadPips = saved.lastKnownSpreadPips;
      this.priceHistory = saved.priceHistory;
    }
  }

  /**
   * Test seam (glitch-tick corroboration checkpoint): feeds a raw price through
   * the exact same public entry point real ticks arrive on (pushExternalPrice ->
   * syncCurrentPrice -> recordTickArrival), so the corroboration gate is
   * exercised for real rather than bypassed. Returns how many REAL (corroborated)
   * tick arrivals are currently retained, so a test can confirm a burst of lone
   * glitch ticks did NOT inflate the tick-frequency count.
   */
  pushTickForTest(price: number): number {
    this.syncCurrentPrice(price, 'test');
    return this.tickTimestamps.length;
  }

  /** Test seam: reset tick-frequency tracking + its corroboration gate to a clean slate. */
  resetTickFrequencyStateForTest(): void {
    this.tickTimestamps = [];
    this.tickPriceSamples = [];
    this.tickFrequencyGateState = { lastPrice: 0, lastAt: 0, pendingPrice: 0, pendingAt: 0 };
  }

  /**
   * Test seam (Part B checkpoint): temporarily swap in injected real tick-price
   * samples (and optionally priceHistory), run the real calculateVolumeProfile(),
   * then restore prior state.
   */
  calculateVolumeProfileForTest(injected: { tickPriceSamples?: { price: number; timestamp: number }[]; priceHistory?: number[] }): VolumeProfile {
    const saved = {
      tickPriceSamples: this.tickPriceSamples,
      priceHistory: this.priceHistory,
    };
    if (injected.tickPriceSamples) this.tickPriceSamples = injected.tickPriceSamples;
    if (injected.priceHistory) this.priceHistory = injected.priceHistory;
    try {
      return this.calculateVolumeProfile();
    } finally {
      this.tickPriceSamples = saved.tickPriceSamples;
      this.priceHistory = saved.priceHistory;
    }
  }

  private calculateFibonacciLevels(high: number, low: number): FibonacciLevel[] {
    const diff = high - low;
    const levels = [0.236, 0.382, 0.5, 0.618, 0.786];
    const extensions = [1.272, 1.414, 1.618];
    
    const retracements = levels.map(level => ({
      level,
      price: parseFloat((high - diff * level).toFixed(1)),
      type: "retracement" as const,
    }));
    
    const extensionLevels = extensions.map(level => ({
      level,
      price: parseFloat((high + diff * (level - 1)).toFixed(1)),
      type: "extension" as const,
    }));
    
    return [...retracements, ...extensionLevels];
  }

  private calculateOrderFlow(): OrderFlowData {
    if (this.priceHistory.length < 5) {
      return {
        bidVolume: 1000,
        askVolume: 1000,
        volumeImbalance: 0,
        largeOrdersDetected: false,
        institutionalFootprint: 0
      };
    }

    // Direction still needs SOME real signal to know which side (bid/ask) to skew —
    // price momentum direction (sign only, not magnitude) is used for that, since
    // there is no real Level 2 bid/ask volume feed available. The MAGNITUDE of the
    // skew, and largeOrdersDetected/institutionalFootprint, are now driven entirely
    // by real tick-arrival frequency + real bid/ask spread (Part B) instead of
    // synthetic price-momentum math.
    const recentPrices = this.priceHistory.slice(-10);
    const priceChange = recentPrices[recentPrices.length - 1] - recentPrices[0];
    const momentumDirection = priceChange > 0 ? 1 : priceChange < 0 ? -1 : 0;

    const tickFreq = this.calculateTickFrequencyRatio();
    const spread = this.calculateSpreadRatio();
    const realDataSufficient = tickFreq.sufficient && spread.sufficient;

    let activityScore: number;
    if (!realDataSufficient) {
      // Clearly-flagged neutral fallback (not a fabricated synthetic reading) —
      // genuinely not enough real tick/spread history yet (e.g. early in a session).
      activityScore = 1.0;
      console.log(`ℹ️ Order Flow: insufficient REAL tick/spread history yet (tickData:${tickFreq.sufficient ? 'ok' : 'pending'}, spreadData:${spread.sufficient ? 'ok' : 'pending'}) — using neutral activity baseline, not a synthetic substitute`);
    } else {
      // recent tick frequency above baseline + spread tighter than baseline = genuinely
      // more active/liquid conditions. Weighted 60/40 toward tick frequency since it's
      // the more directly observable real-activity signal.
      const tickComponent = tickFreq.ratio;
      const spreadComponent = 2 - Math.min(2, Math.max(0, spread.ratio)); // tighter spread (ratio<1) => >1 contribution
      activityScore = (tickComponent * 0.6) + (spreadComponent * 0.4);
    }

    const baseVolume = 1000;
    let bidVolume = baseVolume;
    let askVolume = baseVolume;

    const activitySkew = Math.max(0, activityScore - 1); // 0 at/below baseline activity
    if (momentumDirection > 0) {
      bidVolume *= (1 + activitySkew);
    } else if (momentumDirection < 0) {
      askVolume *= (1 + activitySkew);
    }

    const volumeImbalance = (bidVolume - askVolume) / (bidVolume + askVolume);

    // Large orders/institutional footprint now driven by a genuine tick-frequency spike
    // and/or a genuine spread shock (real conditions), rather than synthetic
    // momentum-vs-range absorption/aggression heuristics.
    const tickBurst = realDataSufficient && tickFreq.ratio > 1.8;
    const spreadShock = realDataSufficient && (spread.ratio > 1.5 || spread.ratio < 0.5);
    const largeOrdersDetected = tickBurst || spreadShock;

    const trendConsistency = this.calculateTrendStrength();
    const institutionalFootprint = (Math.abs(volumeImbalance) * (largeOrdersDetected ? 2 : 1)) * (1 + trendConsistency);

    return {
      bidVolume: Math.floor(bidVolume),
      askVolume: Math.floor(askVolume),
      volumeImbalance: parseFloat(volumeImbalance.toFixed(3)),
      largeOrdersDetected,
      institutionalFootprint: parseFloat(institutionalFootprint.toFixed(2)),
    };
  }
  
  private calculateVolumeProfile(): VolumeProfile {
    // Part B: prefer the REAL tick-arrival price samples (every genuine live tick,
    // undeduplicated) over the downsampled priceHistory — priceHistory intentionally
    // suppresses ticks that don't move price meaningfully (MIN_PRICE_HISTORY_CHANGE),
    // which undercounts real activity concentrated at a single price level.
    const MIN_REAL_TICK_SAMPLES = 20;
    const realTickPrices = this.tickPriceSamples.map(t => t.price);
    const usingRealTicks = realTickPrices.length >= MIN_REAL_TICK_SAMPLES;

    if (!usingRealTicks && this.priceHistory.length < 20) {
      // Fallback if not enough data
      return {
        highVolumeNodes: [this.currentPrice],
        lowVolumeNodes: [this.currentPrice - 10, this.currentPrice + 10],
        pointOfControl: this.currentPrice,
        valueAreaHigh: this.currentPrice + 5,
        valueAreaLow: this.currentPrice - 5
      };
    }

    const lookback = Math.min(300, realTickPrices.length || this.priceHistory.length);
    const prices = usingRealTicks ? realTickPrices.slice(-lookback) : this.priceHistory.slice(-Math.min(100, this.priceHistory.length));
    console.log(`📊 Volume Profile: built from ${usingRealTicks ? `${prices.length} REAL tick-arrival price samples` : `${prices.length} price-history samples (insufficient real ticks yet)`}`);

    // Create buckets
    const buckets = new Map<number, number>();
    const bucketSize = 2.0; // $2 buckets

    for (const price of prices) {
      const bucket = Math.floor(price / bucketSize) * bucketSize;
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }

    // Sort buckets by volume (count)
    const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);
    
    // Point of Control (highest volume)
    const pointOfControl = sortedBuckets[0][0];

    // Value Area (70% of volume)
    const totalVolume = prices.length;
    let volumeSum = 0;
    let vaBuckets: number[] = [];
    
    // Naive VA calculation (just taking top buckets until 70%)
    // Real profile expands from POC, but this is a good synthetic approx
    for (const [price, count] of sortedBuckets) {
      volumeSum += count;
      vaBuckets.push(price);
      if (volumeSum > totalVolume * 0.7) break;
    }

    const valueAreaHigh = Math.max(...vaBuckets);
    const valueAreaLow = Math.min(...vaBuckets);

    // High Volume Nodes (peaks) - Top 3 buckets
    const highVolumeNodes = sortedBuckets.slice(0, 3).map(b => b[0]);

    // Low Volume Nodes (valleys) - we can look for gaps or low counts in the range
    const lowVolumeNodes: number[] = [];
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    
    for (let p = minPrice; p <= maxPrice; p += bucketSize) {
      const bucketPrice = Math.floor(p / bucketSize) * bucketSize;
      const count = buckets.get(bucketPrice) || 0;
      // If count is low relative to POC
      if (count < sortedBuckets[0][1] * 0.2) {
        lowVolumeNodes.push(bucketPrice);
      }
    }

    return {
      highVolumeNodes,
      lowVolumeNodes: lowVolumeNodes.slice(0, 3), // Top 3 LVNs
      pointOfControl: parseFloat(pointOfControl.toFixed(1)),
      valueAreaHigh: parseFloat(valueAreaHigh.toFixed(1)),
      valueAreaLow: parseFloat(valueAreaLow.toFixed(1)),
    };
  }
  
  private async detectMarketRegime(vixPrice?: number): Promise<MarketRegime> {
    const atr = this.calculateRealATR(14);
    const volumeRatio = this.calculateRealVolumeRatio();
    
    let vix = vixPrice || 18;
    if (!vixPrice) {
      try {
        const intermarket = await fetchIntermarketData();
        vix = intermarket.vixPrice;
      } catch {
        console.warn('Failed to fetch VIX for regime detection');
      }
    }
    
    let type: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET';
    let strength = 0;
    
    const vixBoost = vix > 20 ? 0.15 : 0;
    const trendStrength = this.calculateTrendStrength();
    
    console.log(`\n📊 MARKET REGIME DETECTION (Real Data):`);    console.log(`   ATR (14): ${atr.toFixed(2)} | Volume Ratio: ${volumeRatio.toFixed(2)} | VIX: ${vix.toFixed(1)}`);
    console.log(`   Trend Strength: ${(trendStrength * 100).toFixed(1)}%`);
    
    if ((atr > 11 && volumeRatio > 1.1) || (vix > 22 && volumeRatio > 1.0)) {
      type = 'VOLATILE';
      strength = 0.8 + (Math.min(atr - 11, 3) * 0.05) + vixBoost;
      console.log(`   Result: VOLATILE regime (ATR high + VIX elevated)`);
    } else if (atr < 8.5 && volumeRatio < 0.9 && vix < 16) {
      type = 'QUIET';
      strength = 0.6 + ((8.5 - atr) * 0.05);
      console.log(`   Result: QUIET regime (Low ATR + Low VIX)`);
    } else if (trendStrength > 0.6 || (vix > 18 && atr > 9.5)) {
      type = 'TRENDING';
      strength = 0.7 + (trendStrength * 0.2) + (vixBoost * 0.5);
      console.log(`   Result: TRENDING regime (Strong directional movement)`);
    } else {
      type = 'RANGING';
      strength = 0.5 + (1 - trendStrength) * 0.3;
      console.log(`   Result: RANGING regime (Low trend strength)`);
    }
    
    strength = Math.min(1.0, Math.max(0.3, strength));
    
    const dataQuality = Math.min(1.0, this.priceHistory.length / 50);
    const confidence = 0.6 + (dataQuality * 0.25) + (vixBoost * 0.15);
    
    console.log(`   Strength: ${(strength * 100).toFixed(1)}% | Confidence: ${(confidence * 100).toFixed(1)}%\n`);
    
    return {
      type,
      strength: parseFloat(strength.toFixed(2)),
      confidence: parseFloat(Math.min(0.95, confidence).toFixed(2)),
    };
  }
  
  private calculateRealVolumeRatio(): number {
    if (this.priceHistory.length < 20) return 1.0;
    
    const recent10 = this.priceHistory.slice(-10);
    const older10 = this.priceHistory.slice(-20, -10);
    
    let recentActivity = 0;
    for (let i = 1; i < recent10.length; i++) {
      recentActivity += Math.abs(recent10[i] - recent10[i - 1]);
    }
    
    let olderActivity = 0;
    for (let i = 1; i < older10.length; i++) {
      olderActivity += Math.abs(older10[i] - older10[i - 1]);
    }
    
    if (olderActivity === 0) return 1.0;
    return recentActivity / olderActivity;
  }
  
  private calculateTrendStrength(): number {
    if (this.priceHistory.length < 20) return 0.5;
    
    const prices = this.priceHistory.slice(-20);
    const first = prices[0];
    const last = prices[prices.length - 1];
    const netMove = Math.abs(last - first);
    
    let totalMove = 0;
    for (let i = 1; i < prices.length; i++) {
      totalMove += Math.abs(prices[i] - prices[i - 1]);
    }
    
    if (totalMove === 0) return 0;
    return Math.min(1.0, netMove / totalMove);
  }
  
  private detectPriceActionPattern(): string {
    if (this.priceHistory.length < 5) return 'INSUFFICIENT_DATA';
    
    const recent = this.priceHistory.slice(-5);
    const trend = recent[4] - recent[0];
    const volatility = Math.max(...recent) - Math.min(...recent);
    
    if (trend > 10 && volatility < 20) return 'STRONG_UPTREND';
    if (trend < -10 && volatility < 20) return 'STRONG_DOWNTREND';
    if (Math.abs(trend) < 5 && volatility < 10) return 'CONSOLIDATION';
    if (volatility > 25) return 'HIGH_VOLATILITY_BREAKOUT';
    if (recent[4] > recent[3] && recent[3] < recent[2]) return 'BULLISH_REVERSAL';
    if (recent[4] < recent[3] && recent[3] > recent[2]) return 'BEARISH_REVERSAL';
    
    return 'NEUTRAL';
  }
  
  /**
   * Candlestick pattern recognition using the existing 5-min OHLC candles.
   * Order matters: pin bar is checked BEFORE the generic doji check, since a
   * real pin bar also has a small body and would otherwise be misclassified
   * as a doji.
   */
  private detectCandlestickPattern(candles?: { open: number; high: number; low: number; close: number }[]): string {
    const source = candles ?? this.fiveMinCandles;
    if (source.length < 2) return 'NONE';

    const curr = source[source.length - 1];
    const prev = source[source.length - 2];

    const currBody = Math.abs(curr.close - curr.open);
    const prevBody = Math.abs(prev.close - prev.open);
    const currRange = curr.high - curr.low;

    const currBullish = curr.close > curr.open;
    const prevBullish = prev.close > prev.open;

    // 1) Engulfing: current body fully contains previous body, opposite colors.
    const currBodyTop = Math.max(curr.open, curr.close);
    const currBodyBottom = Math.min(curr.open, curr.close);
    const prevBodyTop = Math.max(prev.open, prev.close);
    const prevBodyBottom = Math.min(prev.open, prev.close);
    const engulfs = currBodyTop >= prevBodyTop && currBodyBottom <= prevBodyBottom && currBody > 0 && prevBody > 0;

    if (engulfs && currBullish && !prevBullish) {
      return 'BULLISH_ENGULFING';
    }
    if (engulfs && !currBullish && prevBullish) {
      return 'BEARISH_ENGULFING';
    }

    // 2) Pin bar: small body with one wick >= 2x body and the opposite wick <= 0.5x body.
    if (currRange > 0) {
      const upperWick = curr.high - Math.max(curr.open, curr.close);
      const lowerWick = Math.min(curr.open, curr.close) - curr.low;
      const smallBody = currBody <= currRange * 0.35;

      if (smallBody && currBody > 0) {
        const bullishPinBar = lowerWick >= currBody * 2 && upperWick <= currBody * 0.5;
        const bearishPinBar = upperWick >= currBody * 2 && lowerWick <= currBody * 0.5;

        if (bullishPinBar) return 'BULLISH_PIN_BAR';
        if (bearishPinBar) return 'BEARISH_PIN_BAR';
      }

      // 3) Doji: body under 10% of full range, and pin-bar conditions didn't match
      // (i.e. wicks are roughly balanced, not strongly asymmetric).
      if (currBody < currRange * 0.10) {
        return 'DOJI';
      }
    }

    return 'NONE';
  }

  /** Candlestick-pattern test seam: swap in injected candle data and return the detected pattern. */
  public detectCandlestickPatternForTest(candles: { open: number; high: number; low: number; close: number }[]): string {
    return this.detectCandlestickPattern(candles);
  }

  private detectOrderBlocks(): OrderBlock[] {
    if (this.priceHistory.length < 20 || this.highHistory.length < 20 || this.lowHistory.length < 20) {
      console.log('⚠️ Insufficient data for Order Block detection');
      return this.orderBlocks;
    }

    const newOrderBlocks: OrderBlock[] = [];
    const lookback = Math.min(20, this.priceHistory.length);
    const prices = this.priceHistory.slice(-lookback);
    const highs = this.highHistory.slice(-lookback);
    const lows = this.lowHistory.slice(-lookback);

    for (let i = 2; i < lookback - 2; i++) {
      const isBullishOB = (
        lows[i] < lows[i - 1] &&
        lows[i] < lows[i - 2] &&
        prices[i + 1] > highs[i] &&
        prices[i + 2] > highs[i]
      );

      if (isBullishOB) {
        const strength = Math.min(1.0, (prices[i + 1] - lows[i]) / (this.currentPrice * 0.02));
        newOrderBlocks.push({
          price: parseFloat(lows[i].toFixed(1)),
          type: 'BULLISH',
          strength: parseFloat(strength.toFixed(2)),
          timestamp: Date.now() - ((lookback - i) * 60000),
        });
        console.log(`✅ Bullish OB detected @ ${lows[i].toFixed(1)} (Strength: ${(strength * 100).toFixed(0)}%)`);
      }

      const isBearishOB = (
        highs[i] > highs[i - 1] &&
        highs[i] > highs[i - 2] &&
        prices[i + 1] < lows[i] &&
        prices[i + 2] < lows[i]
      );

      if (isBearishOB) {
        const strength = Math.min(1.0, (highs[i] - prices[i + 1]) / (this.currentPrice * 0.02));
        newOrderBlocks.push({
          price: parseFloat(highs[i].toFixed(1)),
          type: 'BEARISH',
          strength: parseFloat(strength.toFixed(2)),
          timestamp: Date.now() - ((lookback - i) * 60000),
        });
        console.log(`✅ Bearish OB detected @ ${highs[i].toFixed(1)} (Strength: ${(strength * 100).toFixed(0)}%)`);
      }
    }

    const updatedOrderBlocks = [...this.orderBlocks, ...newOrderBlocks];
    const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000);
    this.orderBlocks = updatedOrderBlocks
      .filter(ob => ob.timestamp > fourHoursAgo)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 10);

    if (this.orderBlocks.length > 0) {
      console.log(`📊 Active Order Blocks: ${this.orderBlocks.length} (last 4 hours, top 10 by strength)`);
    }

    return this.orderBlocks;
  }

  private detectQuasimodolLevels(): QuasimodolLevel[] {
    if (this.priceHistory.length < 30 || this.highHistory.length < 30 || this.lowHistory.length < 30) {
      console.log('⚠️ Insufficient data for Quasimodo detection');
      return this.quasimodolLevels;
    }

    const newQMLevels: QuasimodolLevel[] = [];
    const lookback = Math.min(30, this.priceHistory.length);
    const prices = this.priceHistory.slice(-lookback);
    const highs = this.highHistory.slice(-lookback);
    const lows = this.lowHistory.slice(-lookback);

    console.log('\n🔍 QUASIMODO PATTERN DETECTION:');
    console.log('='.repeat(60));

    for (let i = 5; i < lookback - 5; i++) {
      const isBullishQM = (
        lows[i] < lows[i - 1] &&
        lows[i] < lows[i - 2] &&
        lows[i] < lows[i + 1] &&
        lows[i] < lows[i + 2] &&
        prices[i + 3] < lows[i - 2] &&
        prices[i + 4] > prices[i + 3] &&
        prices[i + 5] > lows[i - 2]
      );

      if (isBullishQM) {
        const failedLowLevel = lows[i];
        const breakOfStructure = lows[i - 2];
        const strength = Math.min(1.0, (prices[i + 5] - failedLowLevel) / (this.currentPrice * 0.01));
        
        newQMLevels.push({
          price: parseFloat(failedLowLevel.toFixed(1)),
          type: 'BULLISH_QM',
          strength: parseFloat(strength.toFixed(2)),
          timestamp: Date.now() - ((lookback - i) * 60000),
          description: `Failed Lower Low @ ${failedLowLevel.toFixed(1)}, BoS @ ${breakOfStructure.toFixed(1)}`,
        });
        
        console.log(`✅ BULLISH QUASIMODO detected @ ${failedLowLevel.toFixed(1)}`);
        console.log(`   Failed Lower Low: ${failedLowLevel.toFixed(1)}`);
        console.log(`   Break of Structure: ${breakOfStructure.toFixed(1)}`);
        console.log(`   Strength: ${(strength * 100).toFixed(0)}%`);
        console.log(`   Institutional Trap Zone identified`);
      }

      const isBearishQM = (
        highs[i] > highs[i - 1] &&
        highs[i] > highs[i - 2] &&
        highs[i] > highs[i + 1] &&
        highs[i] > highs[i + 2] &&
        prices[i + 3] > highs[i - 2] &&
        prices[i + 4] < prices[i + 3] &&
        prices[i + 5] < highs[i - 2]
      );

      if (isBearishQM) {
        const failedHighLevel = highs[i];
        const breakOfStructure = highs[i - 2];
        const strength = Math.min(1.0, (failedHighLevel - prices[i + 5]) / (this.currentPrice * 0.01));
        
        newQMLevels.push({
          price: parseFloat(failedHighLevel.toFixed(1)),
          type: 'BEARISH_QM',
          strength: parseFloat(strength.toFixed(2)),
          timestamp: Date.now() - ((lookback - i) * 60000),
          description: `Failed Higher High @ ${failedHighLevel.toFixed(1)}, BoS @ ${breakOfStructure.toFixed(1)}`,
        });
        
        console.log(`🔴 BEARISH QUASIMODO detected @ ${failedHighLevel.toFixed(1)}`);
        console.log(`   Failed Higher High: ${failedHighLevel.toFixed(1)}`);
        console.log(`   Break of Structure: ${breakOfStructure.toFixed(1)}`);
        console.log(`   Strength: ${(strength * 100).toFixed(0)}%`);
        console.log(`   Institutional Trap Zone identified`);
      }
    }

    const updatedQMLevels = [...this.quasimodolLevels, ...newQMLevels];
    const fourHoursAgo = Date.now() - (4 * 60 * 60 * 1000);
    this.quasimodolLevels = updatedQMLevels
      .filter(qm => qm.timestamp > fourHoursAgo)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5);

    if (this.quasimodolLevels.length > 0) {
      console.log(`📊 Active Quasimodo Levels: ${this.quasimodolLevels.length} (last 4 hours, top 5 by strength)`);
    }
    console.log('='.repeat(60) + '\n');

    return this.quasimodolLevels;
  }

  /**
   * Step 5c: freezes an opening-range high/low once the capture window has
   * passed, and keeps extending high/low while still inside the window.
   * Mutates `state` in place (object identity preserved for class fields).
   */
  private updateOpeningRange(
    totalMinutesUTC: number,
    windowStartMinutes: number,
    windowEndMinutes: number,
    currentPrice: number,
    state: { high: number; low: number; captured: boolean },
    label: string,
  ): void {
    const inWindow = totalMinutesUTC >= windowStartMinutes && totalMinutesUTC < windowEndMinutes;
    if (inWindow) {
      state.high = state.high > 0 ? Math.max(state.high, currentPrice) : currentPrice;
      state.low = state.low < Infinity ? Math.min(state.low, currentPrice) : currentPrice;
      state.captured = false;
    } else if (totalMinutesUTC >= windowEndMinutes && !state.captured && state.high > 0) {
      state.captured = true;
      console.log(`📐 ${label} Opening Range frozen: ${state.low.toFixed(1)} - ${state.high.toFixed(1)}`);
    }
  }

  /**
   * Six fixed 4-hour UTC blocks per day (00-04, 04-08, 08-12, 12-16, 16-20,
   * 20-24). Resets all six at UTC midnight rollover, freezes any block once
   * the clock has moved past it (range retained, not discarded), and updates
   * the running high/low of whichever block is currently active (unfrozen).
   */
  private updateSessionBlocks(currentPrice: number): void {
    const nowDate = new Date();
    const utcDateStr = nowDate.toISOString().slice(0, 10);
    if (this.lastSessionBlockDateKey !== utcDateStr) {
      this.lastSessionBlockDateKey = utcDateStr;
      this.sessionBlockHighs = [0, 0, 0, 0, 0, 0];
      this.sessionBlockLows = [Infinity, Infinity, Infinity, Infinity, Infinity, Infinity];
      this.sessionBlockFrozen = [false, false, false, false, false, false];
    }

    const activeBlockIndex = Math.floor(nowDate.getUTCHours() / 4);
    for (let i = 0; i < 6; i++) {
      if (i === activeBlockIndex) {
        if (this.sessionBlockFrozen[i]) continue;
        this.sessionBlockHighs[i] = this.sessionBlockHighs[i] > 0 ? Math.max(this.sessionBlockHighs[i], currentPrice) : currentPrice;
        this.sessionBlockLows[i] = this.sessionBlockLows[i] < Infinity ? Math.min(this.sessionBlockLows[i], currentPrice) : currentPrice;
      } else if (i < activeBlockIndex && !this.sessionBlockFrozen[i]) {
        this.sessionBlockFrozen[i] = true;
        if (this.sessionBlockHighs[i] > 0) {
          console.log(`📐 Session Block ${(i * 4).toString().padStart(2, '0')}-${(i * 4 + 4).toString().padStart(2, '0')} UTC frozen: ${this.sessionBlockLows[i].toFixed(1)} - ${this.sessionBlockHighs[i].toFixed(1)}`);
        }
      }
    }
  }

  /** Returns every block (frozen or still developing) with a real recorded range as SESSION_BLOCK zone candidates. */
  private getSessionBlockZoneCandidates(): { price: number; source: 'SESSION_BLOCK' }[] {
    const candidates: { price: number; source: 'SESSION_BLOCK' }[] = [];
    for (let i = 0; i < 6; i++) {
      const high = this.sessionBlockHighs[i];
      const low = this.sessionBlockLows[i];
      if (high > 0 && low < Infinity) {
        candidates.push({ price: high, source: 'SESSION_BLOCK' });
        candidates.push({ price: low, source: 'SESSION_BLOCK' });
      }
    }
    return candidates;
  }

  /** Session-block test seam: force block state, then read the derived zone candidates. */
  public getSessionBlocksForTest(highs: number[], lows: number[]): { price: number; source: 'SESSION_BLOCK' }[] {
    this.sessionBlockHighs = highs;
    this.sessionBlockLows = lows;
    return this.getSessionBlockZoneCandidates();
  }

  /**
   * PHASE 2 (B4): evaluate one session extreme for a genuine liquidity sweep.
   *
   * Emits a sweep ONLY on a confirmed reclaim (price penetrated the level by an
   * ATR-scaled amount and then traded back inside it within the reclaim
   * window). An unreclaimed penetration is held as pending and, if the window
   * expires, discarded as a real breakout rather than counted as sweep
   * evidence.
   */
  private evaluateSessionSweep(params: {
    sessionType: 'ASIAN' | 'LONDON' | 'NY';
    type: 'HIGH_SWEEP' | 'LOW_SWEEP';
    level: number;
    currentPrice: number;
    now: number;
    baseStrength: number;
  }): void {
    const { sessionType, type, level, currentPrice, now, baseStrength } = params;
    if (!Number.isFinite(level) || level <= 0) return;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

    const atr = this.calculateRealATR(14);
    const penetrationThreshold = Math.max(SWEEP_PENETRATION_MIN_DOLLARS, atr * SWEEP_PENETRATION_ATR_FRACTION);
    const key = `${sessionType}-${type}`;
    const isHigh = type === 'HIGH_SWEEP';
    const beyondLevel = isHigh ? currentPrice - level : level - currentPrice;
    const pending = this.pendingSweepPenetrations.get(key);

    // Step 1: still outside the level by more than the ATR-scaled threshold ->
    // open (or extend) a pending penetration. No sweep is emitted yet: without
    // a reclaim this is indistinguishable from a genuine breakout.
    if (beyondLevel >= penetrationThreshold) {
      if (pending && Math.abs(pending.level - level) <= penetrationThreshold) {
        pending.extreme = isHigh ? Math.max(pending.extreme, currentPrice) : Math.min(pending.extreme, currentPrice);
      } else {
        this.pendingSweepPenetrations.set(key, { level, extreme: currentPrice, firstAt: now });
        console.log(`⏳ ${sessionType} ${isHigh ? 'HIGH' : 'LOW'} PENETRATION OPEN @ ${level.toFixed(1)} (price ${currentPrice.toFixed(1)}, threshold $${penetrationThreshold.toFixed(2)}) - pending reclaim, NOT yet a sweep`);
      }
      return;
    }

    if (!pending) return;

    const latency = now - pending.firstAt;
    if (latency > SWEEP_RECLAIM_WINDOW_MS) {
      this.pendingSweepPenetrations.delete(key);
      console.log(`🚫 ${sessionType} ${isHigh ? 'HIGH' : 'LOW'} penetration @ ${pending.level.toFixed(1)} never reclaimed within ${(SWEEP_RECLAIM_WINDOW_MS / 60000).toFixed(0)}min - treated as a genuine BREAKOUT, discarded (not a sweep)`);
      return;
    }

    // Step 2: reclaim - price must be back INSIDE the swept level.
    const reclaimed = isHigh ? currentPrice < pending.level : currentPrice > pending.level;
    if (!reclaimed) return;

    const penetrationDepth = isHigh ? pending.extreme - pending.level : pending.level - pending.extreme;
    if (penetrationDepth < penetrationThreshold) {
      this.pendingSweepPenetrations.delete(key);
      return;
    }

    // Strength: deeper grabs and faster reclaims are stronger evidence.
    const depthScore = Math.min(1, penetrationDepth / Math.max(atr, 0.01));
    const speedScore = 1 - Math.min(1, latency / SWEEP_RECLAIM_WINDOW_MS);
    const strength = parseFloat(Math.max(0, Math.min(0.98, baseStrength + depthScore * 0.15 + speedScore * 0.10)).toFixed(3));

    const existingIndex = this.sessionSweeps.findIndex(
      s => s.type === type && s.sessionType === sessionType && Math.abs(s.sweepPrice - pending.level) <= penetrationThreshold * 2,
    );
    const sweep: SessionSweep = {
      type,
      sessionType,
      sweepPrice: parseFloat(pending.level.toFixed(1)),
      reversalConfirmed: true,
      timestamp: now,
      strength,
      penetrationDepth: parseFloat(penetrationDepth.toFixed(2)),
      reclaimLatencyMs: latency,
    };
    if (existingIndex >= 0) this.sessionSweeps[existingIndex] = sweep;
    else this.sessionSweeps.push(sweep);

    this.pendingSweepPenetrations.delete(key);

    console.log(`🚨 ${sessionType} ${isHigh ? 'HIGH' : 'LOW'} SWEEP CONFIRMED (penetration + reclaim)`);
    console.log(`   Swept level: ${pending.level.toFixed(1)} | Extreme reached: ${pending.extreme.toFixed(1)} (depth $${penetrationDepth.toFixed(2)}, threshold $${penetrationThreshold.toFixed(2)})`);
    console.log(`   Reclaimed back inside in ${(latency / 1000).toFixed(0)}s | Strength: ${(strength * 100).toFixed(0)}%`);
    console.log(`   → Genuine liquidity grab - potential ${isHigh ? 'SHORT' : 'LONG'} setup`);
  }

  private detectSessionSweeps(): SessionSweep[] {
    const now = Date.now();
    const currentPrice = this.currentPrice;
    const nowDate = new Date();
    const hour = nowDate.getUTCHours();
    const minute = nowDate.getUTCMinutes();

    if (now - this.lastSessionUpdate < 60000) {
      return this.sessionSweeps;
    }
    this.lastSessionUpdate = now;

    const utcDateStr = nowDate.toISOString().slice(0, 10);
    if (this.lastOpeningRangeResetDate !== utcDateStr) {
      this.lastOpeningRangeResetDate = utcDateStr;
      this.londonOR = { high: 0, low: Infinity, captured: false };
      this.nyOR = { high: 0, low: Infinity, captured: false };
      this.asianRangeFrozenForToday = false;
    }

    // Step 5c: London 07:00-07:30 UTC / NY 13:30-14:00 UTC opening ranges.
    const totalMinutesUTC = hour * 60 + minute;
    this.updateOpeningRange(totalMinutesUTC, 7 * 60, 7 * 60 + 30, currentPrice, this.londonOR, 'London');
    this.updateOpeningRange(totalMinutesUTC, 13 * 60 + 30, 14 * 60, currentPrice, this.nyOR, 'NY');

    const isAsianSession = (hour >= 0 && hour < 6) || (hour >= 22 && hour < 24);
    const isLondonSession = hour >= 6 && hour < 13;
    const isNYSession = hour >= 13 && hour < 21;

    console.log('\n🎯 SESSION SWEEP DETECTION:');
    console.log('='.repeat(60));
    console.log(`Current Session: ${isAsianSession ? 'ASIAN' : isLondonSession ? 'LONDON' : isNYSession ? 'NY' : 'OFF_HOURS'}`);
    console.log(`Current Price: ${currentPrice.toFixed(1)}`);

    if (isAsianSession) {
      this.asianSessionHigh = Math.max(this.asianSessionHigh, currentPrice);
      this.asianSessionLow = Math.min(this.asianSessionLow, currentPrice);
      console.log(`Asian Session - High: ${this.asianSessionHigh.toFixed(1)}, Low: ${this.asianSessionLow.toFixed(1)}`);
    } else if (isLondonSession) {
      // Step 5a: freeze the Asian range the moment London opens so it survives
      // through London/NY instead of being silently overwritten by a rolling
      // recent-tick proxy elsewhere in the pipeline.
      if (!this.asianRangeFrozenForToday && this.asianSessionHigh > 0 && this.asianSessionLow < Infinity) {
        this.frozenAsianHigh = this.asianSessionHigh;
        this.frozenAsianLow = this.asianSessionLow;
        this.asianRangeFrozenForToday = true;
        console.log(`🔒 Asian Range frozen for the day: ${this.frozenAsianLow.toFixed(1)} - ${this.frozenAsianHigh.toFixed(1)}`);
      }

      this.londonSessionHigh = Math.max(this.londonSessionHigh, currentPrice);
      this.londonSessionLow = Math.min(this.londonSessionLow, currentPrice);

      // PHASE 2 (B4): penetration + reclaim, ATR-scaled. Replaces the old
      // "price is $2 past the level" trigger with its 2-tick pseudo-reversal.
      this.evaluateSessionSweep({ sessionType: 'ASIAN', type: 'HIGH_SWEEP', level: this.asianSessionHigh, currentPrice, now, baseStrength: 0.70 });
      if (this.asianSessionLow < Infinity) {
        this.evaluateSessionSweep({ sessionType: 'ASIAN', type: 'LOW_SWEEP', level: this.asianSessionLow, currentPrice, now, baseStrength: 0.70 });
      }

      console.log(`London Session - High: ${this.londonSessionHigh.toFixed(1)}, Low: ${this.londonSessionLow.toFixed(1)}`);
    } else if (isNYSession) {
      this.nySessionHigh = Math.max(this.nySessionHigh, currentPrice);
      this.nySessionLow = Math.min(this.nySessionLow, currentPrice);

      // PHASE 2 (B4): same penetration + reclaim structure for the London range.
      this.evaluateSessionSweep({ sessionType: 'LONDON', type: 'HIGH_SWEEP', level: this.londonSessionHigh, currentPrice, now, baseStrength: 0.75 });

      if (this.londonSessionLow < Infinity) {
        this.evaluateSessionSweep({ sessionType: 'LONDON', type: 'LOW_SWEEP', level: this.londonSessionLow, currentPrice, now, baseStrength: 0.75 });
      }

      console.log(`NY Session - High: ${this.nySessionHigh.toFixed(1)}, Low: ${this.nySessionLow.toFixed(1)}`);
    } else {
      this.asianSessionHigh = 0;
      this.asianSessionLow = Infinity;
      this.londonSessionHigh = 0;
      this.londonSessionLow = Infinity;
      this.nySessionHigh = 0;
      this.nySessionLow = Infinity;
    }

    // PHASE 2 (B4): confirmed sweeps stay actionable for SWEEP_RETENTION_MS (2h).
    // The old 1h window expired a London sweep partway through the NY session
    // that traded off it. Stale pending penetrations are also swept up here.
    const retentionCutoff = now - SWEEP_RETENTION_MS;
    this.sessionSweeps = this.sessionSweeps
      .filter(sweep => sweep.timestamp > retentionCutoff)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 10);

    for (const [key, pending] of Array.from(this.pendingSweepPenetrations.entries())) {
      if (now - pending.firstAt > SWEEP_RECLAIM_WINDOW_MS) {
        this.pendingSweepPenetrations.delete(key);
        console.log(`🧹 Cleared expired pending penetration ${key} @ ${pending.level.toFixed(1)} (no reclaim - breakout, not a sweep)`);
      }
    }

    if (this.sessionSweeps.length > 0) {
      console.log(`📊 Active CONFIRMED Session Sweeps: ${this.sessionSweeps.length} (last ${(SWEEP_RETENTION_MS / 3600000).toFixed(0)}h, top 10) | pending penetrations: ${this.pendingSweepPenetrations.size}`);
    }
    console.log('='.repeat(60) + '\n');

    return this.sessionSweeps;
  }

  private calculateSupportResistanceStrength(): { supportStrength: number; resistanceStrength: number } {
    const currentPrice = this.currentPrice;
    const recentHigh = this.highHistory.length > 0 ? Math.max(...this.highHistory.slice(-20)) : currentPrice + 50;
    const recentLow = this.lowHistory.length > 0 ? Math.min(...this.lowHistory.slice(-20)) : currentPrice - 50;
    
    const distanceToResistance = recentHigh - currentPrice;
    const distanceToSupport = currentPrice - recentLow;
    
    // Bug fix: the previous flat $50 divisor made strength decay at a fixed
    // dollar distance regardless of price level or real volatility - same bug
    // class as the earlier Camarilla-floor/zoneWidth/proximityThreshold fixes.
    // Use the same Math.max(atr-relative, price-relative) convention already
    // established elsewhere in this file (e.g. zoneWidth, proximityThreshold).
    const atr = this.calculateRealATR(14);
    const strengthDecayDistance = Math.max(atr * 5, currentPrice * 0.015);
    
    const resistanceStrength = Math.max(0, Math.min(1, 1 - (distanceToResistance / strengthDecayDistance)));
    const supportStrength = Math.max(0, Math.min(1, 1 - (distanceToSupport / strengthDecayDistance)));
    
    return {
      supportStrength: parseFloat(supportStrength.toFixed(2)),
      resistanceStrength: parseFloat(resistanceStrength.toFixed(2)),
    };
  }

  /**
   * Option A (S/R zone persistence): async TIER 0 fetch from the durable
   * server-side sr_zones_v1 cache. Throttled to TIER0_SRZONES_FETCH_INTERVAL_MS
   * and fully fire-and-forget -- never awaited by detectSRZones() itself, so
   * generation stays synchronous exactly as before. Also fires the (equally
   * throttled, equally non-blocking) server-side recompute so the cache keeps
   * accumulating evidence from fresh gold_m1_bars over time.
   */
  private maybeRefreshTier0SRZones(): void {
    const now = Date.now();
    if (now - this.lastTier0SRZonesFetchAttemptAt < SignalGenerationEngine.TIER0_SRZONES_FETCH_INTERVAL_MS) {
      return;
    }
    this.lastTier0SRZonesFetchAttemptAt = now;

    // Defensive: some sandboxed test harnesses stub trpcClient as `{}` (no
    // real router). Guard both calls below so this never throws synchronously
    // and test scripts that don't wire a full tRPC client keep working exactly
    // as before (falling straight through to TIER 1 local detection).
    const srZonesClient = (trpcClient as { srZones?: { getZones?: { query?: unknown }; refreshZones?: { mutate?: unknown } } })?.srZones;
    if (typeof srZonesClient?.getZones?.query !== 'function') {
      return;
    }

    trpcClient.srZones.getZones.query()
      .then((result) => {
        if (result?.available && Array.isArray(result.zones) && result.zones.length > 0) {
          this.tier0SRZones = result.zones.map((z): SRZone => ({
            price: z.price,
            type: z.type,
            touches: z.touches,
            lastTouch: z.lastTouchTs ? new Date(z.lastTouchTs).getTime() : 0,
            rejectionWicks: z.rejectionWicks,
            avgRejectionSize: 0,
            reactionStrength: z.reactionStrength,
            source: z.source,
            confluenceScore: z.confluenceScore,
            tier: 'TIER_0_SERVER',
          }));
          this.tier0SRZonesFetchedAt = Date.now();
          console.log(`✅ SR-ZONES: TIER 0 server cache loaded (${this.tier0SRZones.length} durable zone(s))`);
        } else {
          console.log('ℹ️ SR-ZONES: TIER 0 server cache empty/unavailable -- will use TIER 1 local detection');
        }
      })
      .catch((err) => {
        console.warn('⚠️ SR-ZONES: TIER 0 fetch failed (non-blocking, falling back to TIER 1 local):', err instanceof Error ? err.message : 'Unknown');
      });

    if (now - this.lastServerSRZonesRefreshTriggerAt >= SignalGenerationEngine.TIER0_SRZONES_FETCH_INTERVAL_MS && typeof srZonesClient?.refreshZones?.mutate === 'function') {
      this.lastServerSRZonesRefreshTriggerAt = now;
      trpcClient.srZones.refreshZones.mutate()
        .then((result) => {
          if (result?.success) {
            console.log(`✅ SR-ZONES: server-side recompute triggered (${result.zoneCount ?? 0} zone(s))`);
          } else {
            console.log(`ℹ️ SR-ZONES: server-side recompute skipped (${result?.reason ?? 'unknown'})`);
          }
        })
        .catch((err) => {
          console.warn('⚠️ SR-ZONES: server-side recompute trigger failed (non-blocking):', err instanceof Error ? err.message : 'Unknown');
        });
    }
  }

  private detectSRZones(): SRZone[] {
    const now = Date.now();
    const currentPrice = this.currentPrice;
    this.updateSessionBlocks(currentPrice);

    // Kick off (throttled, non-blocking) TIER 0 refresh for the NEXT call --
    // never awaited here, so this stays synchronous like before.
    this.maybeRefreshTier0SRZones();

    // TIER 0: if a fresh, non-empty durable server cache is available, use it
    // directly instead of the local TIER 1 computation below. This is the
    // evidence base that survives a browser refresh (computed server-side from
    // days of real gold_m1_bars), unlike this.srZones/this.priceHistory which
    // reset to empty on every reload.
    const tier0Fresh = this.tier0SRZones !== null
      && this.tier0SRZones.length > 0
      && (now - this.tier0SRZonesFetchedAt) < SignalGenerationEngine.TIER0_SRZONES_TTL_MS;
    if (tier0Fresh) {
      this.srZones = this.tier0SRZones!.slice(0, 16);
      return this.srZones;
    }

    const zones: SRZone[] = [];
    const atr = this.calculateRealATR(14);
    // Bug fix: the previous flat "$2" floor collapsed zone-merge distance to a
    // meaningless value for gold at $3,000+ whenever ATR came back small (quiet
    // market / thin history). Use the same price-relative floor convention as
    // the pivot-level fix, but with a smaller coefficient (0.15% of price)
    // because zoneWidth is a *merge/touch* distance, not a full daily-range
    // floor — it needs to stay tight enough to keep genuinely distinct levels
    // separate (at $3,250 gold that's ~$4.9, vs. the ~$26 the pivot fix's 0.008
    // coefficient would produce, which would over-merge distinct S/R levels).
    const zoneWidth = Math.max(atr * 0.3, currentPrice * 0.0015);

    if (this.priceHistory.length < 20 || this.highHistory.length < 20 || this.lowHistory.length < 20) {
      console.log('⚠️ S/R Zones: Insufficient data for zone detection');
      return this.srZones;
    }

    type ZoneSource = SRZone['source'];
    const candidateLevels: { price: number; source: ZoneSource; alwaysAdmit?: boolean }[] = [];

    const recentHighs = this.highHistory.slice(-50);
    const recentLows = this.lowHistory.slice(-50);
    for (let i = 2; i < recentHighs.length - 2; i++) {
      if (recentHighs[i] > recentHighs[i - 1] && recentHighs[i] > recentHighs[i - 2] &&
          recentHighs[i] > recentHighs[i + 1] && recentHighs[i] > recentHighs[i + 2]) {
        candidateLevels.push({ price: recentHighs[i], source: 'PRICE_ACTION' });
      }
    }
    for (let i = 2; i < recentLows.length - 2; i++) {
      if (recentLows[i] < recentLows[i - 1] && recentLows[i] < recentLows[i - 2] &&
          recentLows[i] < recentLows[i + 1] && recentLows[i] < recentLows[i + 2]) {
        candidateLevels.push({ price: recentLows[i], source: 'PRICE_ACTION' });
      }
    }

    const ohlc = this.getDerivedDailyOHLC();
    const dailyPivot = (ohlc.yesterdayHigh + ohlc.yesterdayLow + ohlc.yesterdayClose) / 3;
    // Bug fix: flooring only on raw atr (no price-relative safety net) let
    // zoneStep collapse toward zero on the same small-ATR condition as the
    // pivot-level bug. Reuse the same 0.008 daily-range-floor coefficient
    // already established as correct in getDerivedDailyOHLC() /
    // calculateDashboardPivotLevels() / calculateMarketFeatures() for this same
    // "genuine daily range" concept.
    const dailyRange = Math.max(ohlc.yesterdayHigh - ohlc.yesterdayLow, atr, currentPrice * 0.008);
    const zoneStep = dailyRange / 12;
    candidateLevels.push({ price: dailyPivot, source: 'PIVOT' });
    candidateLevels.push({ price: ohlc.yesterdayClose + zoneStep, source: 'PIVOT' });
    candidateLevels.push({ price: ohlc.yesterdayClose - zoneStep, source: 'PIVOT' });
    candidateLevels.push({ price: ohlc.yesterdayClose + zoneStep * 2, source: 'PIVOT' });
    candidateLevels.push({ price: ohlc.yesterdayClose - zoneStep * 2, source: 'PIVOT' });

    // Step 5b: Previous-Day High/Low/Open are structurally significant by
    // definition (not discovered via touch count) — always admit them.
    candidateLevels.push({ price: ohlc.yesterdayHigh, source: 'PREV_DAY', alwaysAdmit: true });
    candidateLevels.push({ price: ohlc.yesterdayLow, source: 'PREV_DAY', alwaysAdmit: true });
    candidateLevels.push({ price: ohlc.yesterdayOpen, source: 'PREV_DAY', alwaysAdmit: true });

    // Step 5a: the Asian range frozen at London open (falls back to the live
    // tracked range if the freeze hasn't fired yet this cycle).
    if (this.frozenAsianHigh > 0 && this.frozenAsianLow < Infinity) {
      candidateLevels.push({ price: this.frozenAsianHigh, source: 'ASIAN_RANGE', alwaysAdmit: true });
      candidateLevels.push({ price: this.frozenAsianLow, source: 'ASIAN_RANGE', alwaysAdmit: true });
    } else if (this.asianSessionHigh > 0 && this.asianSessionLow < Infinity) {
      candidateLevels.push({ price: this.asianSessionHigh, source: 'ASIAN_RANGE', alwaysAdmit: true });
      candidateLevels.push({ price: this.asianSessionLow, source: 'ASIAN_RANGE', alwaysAdmit: true });
    }

    // Step 5c: London/NY opening-range highs/lows, distinct from the ongoing session high/low.
    if (this.londonOR.high > 0 && this.londonOR.low < Infinity) {
      candidateLevels.push({ price: this.londonOR.high, source: 'ORH_ORL', alwaysAdmit: true });
      candidateLevels.push({ price: this.londonOR.low, source: 'ORH_ORL', alwaysAdmit: true });
    }
    if (this.nyOR.high > 0 && this.nyOR.low < Infinity) {
      candidateLevels.push({ price: this.nyOR.high, source: 'ORH_ORL', alwaysAdmit: true });
      candidateLevels.push({ price: this.nyOR.low, source: 'ORH_ORL', alwaysAdmit: true });
    }

    // Step 5d: genuine weekly high/low (not a copy of the daily pivot inputs).
    const { weeklyHigh, weeklyLow } = this.getWeeklyHighLow();
    candidateLevels.push({ price: weeklyHigh, source: 'WEEKLY', alwaysAdmit: true });
    candidateLevels.push({ price: weeklyLow, source: 'WEEKLY', alwaysAdmit: true });

    // 4-hour UTC session block ranges (00-04/04-08/08-12/12-16/16-20/20-24),
    // distinct from Asian/London/NY session tracking above.
    for (const blockCandidate of this.getSessionBlockZoneCandidates()) {
      candidateLevels.push({ price: blockCandidate.price, source: 'SESSION_BLOCK', alwaysAdmit: true });
    }

    const clustered: { price: number; source: ZoneSource; count: number; sources: Set<ZoneSource>; alwaysAdmit: boolean }[] = [];
    for (const level of candidateLevels) {
      const existing = clustered.find(c => Math.abs(c.price - level.price) < zoneWidth);
      if (existing) {
        existing.count++;
        existing.price = (existing.price + level.price) / 2;
        existing.sources.add(level.source);
        existing.alwaysAdmit = existing.alwaysAdmit || !!level.alwaysAdmit;
        if (level.source === 'PRICE_ACTION') existing.source = level.source;
      } else {
        clustered.push({ price: level.price, source: level.source, count: 1, sources: new Set([level.source]), alwaysAdmit: !!level.alwaysAdmit });
      }
    }

    for (const cluster of clustered) {
      let touches = 0;
      let rejectionWicks = 0;
      let totalRejectionSize = 0;
      let lastTouch = 0;
      const isResistance = cluster.price > currentPrice;

      // PHASE 2 (B5): count DISTINCT touch EVENTS, not samples inside the zone.
      // priceHistory is sampled every ~5s, so a single visit that lingered in a
      // zone for two minutes previously logged ~24 "touches" while a genuine
      // second test of the level logged 1 - i.e. `touches` measured dwell time,
      // not how many times the market actually came back and respected the
      // level. A touch is now only counted when price ENTERS the zone from
      // outside it, which is what "tested twice" is supposed to mean and what
      // every downstream `touches >= 2` gate assumes.
      let insideZone = false;
      for (let i = 0; i < this.priceHistory.length; i++) {
        const price = this.priceHistory[i];
        const high = this.highHistory[i] ?? price;
        const low = this.lowHistory[i] ?? price;

        const isInsideNow = Math.abs(price - cluster.price) < zoneWidth;
        if (isInsideNow) {
          if (!insideZone) touches++;
          lastTouch = now - ((this.priceHistory.length - i) * 5000);
        }
        insideZone = isInsideNow;

        if (isResistance && high >= cluster.price - zoneWidth && price < cluster.price) {
          const wickSize = high - Math.max(price, this.priceHistory[Math.max(0, i - 1)] ?? price);
          if (wickSize > zoneWidth * 0.3) {
            rejectionWicks++;
            totalRejectionSize += wickSize;
          }
        }

        if (!isResistance && low <= cluster.price + zoneWidth && price > cluster.price) {
          const wickSize = Math.min(price, this.priceHistory[Math.max(0, i - 1)] ?? price) - low;
          if (wickSize > zoneWidth * 0.3) {
            rejectionWicks++;
            totalRejectionSize += wickSize;
          }
        }
      }

      // PHASE 2 (B5): un-clamp the evidence curves. The old hard caps
      // (touches/6 and rejectionWicks/4, both clipped at 1.0) made a level
      // tested 6 times and one tested 30 times numerically IDENTICAL, so the
      // most-respected levels on the chart were indistinguishable from merely
      // adequate ones - and because zones are ranked and sliced by
      // reactionStrength, that plateau was decided by tie-break order rather
      // than by evidence. These are now soft-saturating (exponential) curves:
      // strictly increasing in evidence forever, with diminishing returns, and
      // still bounded in [0,1) so every downstream threshold (>= 0.3 gating,
      // the 0.8 + rs zone multiplier) keeps its meaning.
      const touchScore = 1 - Math.exp(-touches / 3);
      const rejectionScore = 1 - Math.exp(-rejectionWicks / 2);
      const avgRejectionSize = rejectionWicks > 0 ? totalRejectionSize / rejectionWicks : 0;
      const rejectionSizeScore = Math.min(1, avgRejectionSize / (atr * 0.5));
      const clusterScore = Math.min(1, cluster.count / 3);
      // Step 5e: confluence — how many distinct source types agree on this
      // level (e.g. PREV_DAY + ASIAN_RANGE + PIVOT). Genuine multi-timeframe
      // agreement earns real extra strength on top of the base score.
      const confluenceScore = cluster.sources.size;
      const confluenceBonus = Math.min(1, confluenceScore * 0.25);
      // Structural fix: clusterScore/confluenceBonus reward multiple
      // reference CALCULATIONS agreeing on a price (e.g. PDH + Asian range +
      // pivot all landing near the same level) — that is agreement between
      // arithmetic sources, not evidence the market has actually reacted
      // there. Without a floor, a zero-touch/zero-rejection zone with enough
      // agreeing sources could already clear the 0.3 gating threshold on
      // confluence alone. Require at least one earned touch or rejection
      // wick before clustering/confluence agreement is allowed to contribute
      // anything — this generalizes to every zone source (not just the
      // always-admitted structural ones) and keeps agreement-without-
      // interaction at a LOW (but still visible/reference-worthy) strength.
      const hasEarnedEvidence = touches >= 1 || rejectionWicks >= 1;
      const effectiveClusterScore = hasEarnedEvidence ? clusterScore : 0;
      const effectiveConfluenceBonus = hasEarnedEvidence ? confluenceBonus : 0;
      // PHASE 2 (B5, second half of the un-clamp): the component weights used to
      // sum to 1.00 and then confluenceBonus (up to +1.00) was ADDED on top,
      // with the total clipped by Math.min(1, ...). Any zone with a couple of
      // rejection wicks plus multi-source confluence therefore pinned at
      // exactly 1.000, which is why un-clamping touchScore alone changed
      // nothing: the sum was saturating above the clip long before touches
      // mattered. Measured on a synthetic 30-touch vs 6-touch history, both
      // scored 1.000 - indistinguishable. Confluence is now a WEIGHTED TERM
      // inside the blend (weights sum to exactly 1.00), so the result is
      // strictly monotonic in every component, never needs clipping, and
      // remains bounded in [0,1] for the downstream >= 0.3 gates.
      const rawReactionStrength =
        (touchScore * 0.28) +
        (rejectionScore * 0.28) +
        (rejectionSizeScore * 0.16) +
        (effectiveClusterScore * 0.16) +
        (effectiveConfluenceBonus * 0.12);

      // Step 2 fix (zone staleness/decay): without this, a zone that earned
      // maximum touchScore/rejectionScore during one early, low-volatility
      // window would retain that same maximum reactionStrength indefinitely —
      // price could travel far away and hours could pass with zero fresh
      // touches, yet the zone still dominated structural gating for the rest
      // of the session. Apply an exponential recency decay keyed off lastTouch
      // (halving every ZONE_STALENESS_HALF_LIFE_HOURS with no fresh touch) so a
      // genuinely stale, untested-recently zone naturally fades toward
      // irrelevance instead of retaining full strength forever. Zones with no
      // touch at all in the current scan window (lastTouch === 0, e.g. an
      // always-admitted structural level like PDH that simply hasn't been
      // revisited yet) are NOT penalized here — they already earn zero
      // touchScore/rejectionScore credit above, so they aren't being
      // double-penalized for staleness they don't actually have evidence of.
      const ageMs = lastTouch > 0 ? Math.max(0, now - lastTouch) : 0;
      const ageHours = ageMs / (60 * 60 * 1000);
      const recencyDecayFactor = lastTouch > 0
        ? Math.pow(0.5, ageHours / ZONE_STALENESS_HALF_LIFE_HOURS)
        : 1;
      const reactionStrength = Math.min(1, rawReactionStrength * recencyDecayFactor);

      if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1 || cluster.count >= 2) {
        zones.push({
          price: parseFloat(cluster.price.toFixed(1)),
          type: isResistance ? 'RESISTANCE' : 'SUPPORT',
          touches,
          lastTouch,
          rejectionWicks,
          avgRejectionSize: parseFloat(avgRejectionSize.toFixed(2)),
          reactionStrength: parseFloat(reactionStrength.toFixed(3)),
          source: cluster.source,
          confluenceScore,
          tier: 'TIER_1_LOCAL',
        });
      }
    }

    zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
    this.srZones = zones.slice(0, 16);

    if (this.srZones.length > 0) {
      console.log('\n📊 S/R ZONE DETECTION:');
      console.log('='.repeat(60));
      for (const zone of this.srZones.slice(0, 6)) {
        console.log(`   ${zone.type} @ ${zone.price.toFixed(1)} | Touches: ${zone.touches} | Wick Rejections: ${zone.rejectionWicks} | Reaction: ${(zone.reactionStrength * 100).toFixed(0)}% | Source: ${zone.source} | Confluence: ${zone.confluenceScore}`);
      }
      console.log('='.repeat(60));
    }

    return this.srZones;
  }

  private detectActiveSRReaction(features: MarketFeatures): SRZoneReaction | null {
    const currentPrice = this.currentPrice;
    const atr = features.atr || this.calculateRealATR(14);
    // Bug fix: same flat-dollar-floor class of bug as zoneWidth/dailyRange above
    // — replace the flat "$3" floor with a price-relative one (0.1% of price,
    // ~$3.25 at $3,250 gold, matching the old default's rough magnitude at
    // today's price while actually scaling with price going forward).
    const proximityThreshold = Math.max(atr * 0.25, currentPrice * 0.001);

    for (const zone of this.srZones) {
      const distance = Math.abs(currentPrice - zone.price);
      if (distance > proximityThreshold) continue;

      if (zone.reactionStrength < 0.3) continue;

      const recentPrices = this.priceHistory.slice(-5);
      const recentHighs = this.highHistory.slice(-5);
      const recentLows = this.lowHistory.slice(-5);
      if (recentPrices.length < 3) continue;

      let reactionType: 'BOUNCE' | 'REJECTION_WICK' | 'STRONG_REVERSAL' = 'BOUNCE';
      let reactionConfirmed = false;
      let reactionBoost = 0;

      if (zone.type === 'SUPPORT') {
        const touchedZone = recentLows.some(l => l <= zone.price + proximityThreshold * 0.5);
        const priceAboveZone = currentPrice > zone.price;
        const movingAway = recentPrices.length >= 3 && recentPrices[recentPrices.length - 1] > recentPrices[recentPrices.length - 3];

        if (touchedZone && priceAboveZone && movingAway) {
          reactionConfirmed = true;
          const bounceSize = currentPrice - zone.price;
          if (bounceSize > atr * 0.4) {
            reactionType = 'STRONG_REVERSAL';
            reactionBoost = 0.25;
          } else if (recentLows.some(l => l < zone.price) && currentPrice > zone.price) {
            reactionType = 'REJECTION_WICK';
            reactionBoost = 0.20;
          } else {
            reactionBoost = 0.15;
          }
        }
      } else {
        const touchedZone = recentHighs.some(h => h >= zone.price - proximityThreshold * 0.5);
        const priceBelowZone = currentPrice < zone.price;
        const movingAway = recentPrices.length >= 3 && recentPrices[recentPrices.length - 1] < recentPrices[recentPrices.length - 3];

        if (touchedZone && priceBelowZone && movingAway) {
          reactionConfirmed = true;
          const rejectionSize = zone.price - currentPrice;
          if (rejectionSize > atr * 0.4) {
            reactionType = 'STRONG_REVERSAL';
            reactionBoost = 0.25;
          } else if (recentHighs.some(h => h > zone.price) && currentPrice < zone.price) {
            reactionType = 'REJECTION_WICK';
            reactionBoost = 0.20;
          } else {
            reactionBoost = 0.15;
          }
        }
      }

      if (reactionConfirmed) {
        const zoneMultiplier = Math.min(1.5, 0.8 + zone.reactionStrength);
        const finalStrength = reactionBoost * zoneMultiplier;

        console.log(`\n🎯 S/R ZONE REACTION DETECTED:`);
        console.log(`   Zone: ${zone.type} @ ${zone.price.toFixed(1)} (Reaction Strength: ${(zone.reactionStrength * 100).toFixed(0)}%)`);
        console.log(`   Reaction Type: ${reactionType}`);
        console.log(`   Touches: ${zone.touches} | Rejection Wicks: ${zone.rejectionWicks}`);
        console.log(`   Signal Boost: +${(finalStrength * 100).toFixed(1)}% (base: ${(reactionBoost * 100).toFixed(0)}% × zone multiplier: ${zoneMultiplier.toFixed(2)})`);

        return {
          zone,
          reactionType,
          strength: parseFloat(finalStrength.toFixed(3)),
          confirmed: true,
        };
      }
    }

    return null;
  }

  private generateSentimentAnalysis(): SentimentData {
    const rsi = this.calculateRealRSI(14);
    const trendStrength = this.calculateTrendStrength();
    const priceDirection = this.detectPriceDirection();
    
    // Derive sentiment score from technicals (-1 to 1)
    let technicalSentiment = 0;
    
    if (rsi > 60) technicalSentiment += 0.3;
    if (rsi < 40) technicalSentiment -= 0.3;
    if (trendStrength > 0.5) {
       technicalSentiment += (priceDirection * 0.4);
    }
    
    // News simulation (synthetic)
    // const now = Date.now();
    const hour = new Date().getUTCHours();
    
    // Market more optimistic during London/NY overlap usually? Synthetic bias.
    const timeBias = (hour >= 13 && hour <= 16) ? 0.1 : 0;
    
    const baseScore = technicalSentiment + timeBias;
    const normalizedScore = Math.max(-1, Math.min(1, baseScore));
    
    let keyword = "neutral";
    if (normalizedScore > 0.5) keyword = "strong_buy_momentum";
    else if (normalizedScore > 0.2) keyword = "bullish_sentiment";
    else if (normalizedScore < -0.5) keyword = "strong_sell_pressure";
    else if (normalizedScore < -0.2) keyword = "bearish_sentiment";
    
    return {
      score: parseFloat(normalizedScore.toFixed(2)),
      confidence: parseFloat((0.6 + Math.abs(normalizedScore) * 0.3).toFixed(2)),
      source: keyword.replace(/_/g, " ").toUpperCase(),
    };
  }

  private getTimeWindowFactor(): number {
    const now = new Date();
    const currentUTCHour = now.getUTCHours();
    
    let factor = TIME_WEIGHTS.LOW_LIQUIDITY;
    
    if (currentUTCHour >= UTC_HOURS.NY_LONDON_START && currentUTCHour < UTC_HOURS.NY_LONDON_END) {
      factor = TIME_WEIGHTS.POWER_HOUR;
      console.log('⏰ Time Window: POWER HOUR (London/NY Overlap) - 2.0x weight');
    } else if (currentUTCHour >= UTC_HOURS.EUROPE_OPEN_START && currentUTCHour < UTC_HOURS.EUROPE_OPEN_END) {
      factor = TIME_WEIGHTS.EUROPE_OPEN;
      console.log('⏰ Time Window: EUROPE OPEN (Tokyo/London Overlap) - 1.5x weight');
    } else if (currentUTCHour >= UTC_HOURS.EUROPE_OPEN_END && currentUTCHour < UTC_HOURS.NY_LONDON_START) {
      factor = TIME_WEIGHTS.MODERATE_LIQUIDITY;
      console.log('⏰ Time Window: MID-LONDON SESSION - 1.0x weight');
    } else if (currentUTCHour >= UTC_HOURS.NY_LONDON_END && currentUTCHour < 22) {
      factor = TIME_WEIGHTS.MODERATE_LIQUIDITY;
      console.log('⏰ Time Window: LATE NY SESSION - 1.0x weight');
    } else {
      console.log('⏰ Time Window: ASIAN/OFF HOURS - 0.5x weight (Low Liquidity)');
    }
    
    return factor;
  }
  
  private calculateLiquidityWindow(): LiquidityWindow {
    const now = new Date();
    const hour = now.getUTCHours();
    
    const isLondonOpen = hour >= 6 && hour < 13;
    const isNYOpen = hour >= 13 && hour < 21;
    const isAsianOpen = (hour >= 0 && hour < 6) || (hour >= 21 && hour < 24);
    
    let sessionName = 'OFF_HOURS';
    let baseScore = 0.3;
    let isHighLiquidity = false;
    
    if (isLondonOpen) {
      sessionName = 'LONDON';
      baseScore = 0.9;
      isHighLiquidity = true;
      console.log('📊 Liquidity Window: LONDON SESSION (High Liquidity)');
    } else if (isNYOpen) {
      sessionName = 'NEW_YORK';
      baseScore = 0.85;
      isHighLiquidity = true;
      console.log('📊 Liquidity Window: NEW YORK SESSION (High Liquidity)');
    } else if (isAsianOpen) {
      sessionName = 'ASIAN';
      baseScore = 0.5;
      isHighLiquidity = false;
      console.log('📊 Liquidity Window: ASIAN SESSION (Moderate Liquidity)');
    } else {
      console.log('📊 Liquidity Window: OFF HOURS (Low Liquidity)');
    }
    
    return {
      score: parseFloat(baseScore.toFixed(2)),
      sessionName,
      isHighLiquidity,
    };
  }
  
  /**
   * Step 5d: a genuine weekly high/low/close derived from the actual last 7
   * days of dailyOHLCHistory, instead of weeklyPivot simply being a copy of
   * the daily pivot.
   */
  private getWeeklyHighLow(): { weeklyHigh: number; weeklyLow: number; weeklyClose: number } {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentBars = this.dailyOHLCHistory.filter((bar) => bar.timestamp >= sevenDaysAgo);

    if (recentBars.length === 0) {
      const ohlc = this.getDerivedDailyOHLC();
      return { weeklyHigh: ohlc.yesterdayHigh, weeklyLow: ohlc.yesterdayLow, weeklyClose: ohlc.yesterdayClose };
    }

    const weeklyHigh = Math.max(...recentBars.map((bar) => bar.high));
    const weeklyLow = Math.min(...recentBars.map((bar) => bar.low));
    const mostRecent = [...recentBars].sort((a, b) => b.timestamp - a.timestamp)[0];

    return {
      weeklyHigh,
      weeklyLow,
      weeklyClose: mostRecent.close,
    };
  }

  private getDerivedDailyOHLC(): { yesterdayHigh: number; yesterdayLow: number; yesterdayClose: number; yesterdayOpen: number } {
    const currentPrice = this.currentPrice;
    const STALENESS_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    if (this.dailyOHLCHistory.length > 0) {
      const sortedHistory = [...this.dailyOHLCHistory].sort((left, right) => right.timestamp - left.timestamp);
      const mostRecentBar = sortedHistory[0];
      const barAge = now - mostRecentBar.timestamp;
      const priceDrift = currentPrice > 0
        ? Math.abs(currentPrice - mostRecentBar.close) / mostRecentBar.close
        : 0;
      const isStale = barAge > STALENESS_THRESHOLD_MS || priceDrift > 0.025;

      if (!isStale) {
        console.log(`📊 Using Latest Completed Daily Bar: ${mostRecentBar.date}`);
        console.log(`   Open: ${mostRecentBar.open.toFixed(1)} | High: ${mostRecentBar.high.toFixed(1)} | Low: ${mostRecentBar.low.toFixed(1)} | Close: ${mostRecentBar.close.toFixed(1)}`);

        return {
          yesterdayHigh: mostRecentBar.high,
          yesterdayLow: mostRecentBar.low,
          yesterdayClose: mostRecentBar.close,
          yesterdayOpen: mostRecentBar.open,
        };
      }

      console.log(`⚠️ Stored daily bar is stale (age ${(barAge / 3600000).toFixed(1)}h, drift ${(priceDrift * 100).toFixed(2)}%) - preferring developing day or live data`);
    }

    if (this.currentDayOHLC) {
      console.log(`📊 Using Developing Trading Day Fallback: ${this.currentDayOHLC.date}`);
      console.log(`   Open: ${this.currentDayOHLC.open.toFixed(1)} | High: ${this.currentDayOHLC.high.toFixed(1)} | Low: ${this.currentDayOHLC.low.toFixed(1)} | Close: ${this.currentDayOHLC.close.toFixed(1)}`);

      return {
        yesterdayHigh: this.currentDayOHLC.high,
        yesterdayLow: this.currentDayOHLC.low,
        yesterdayClose: this.currentDayOHLC.close,
        yesterdayOpen: this.currentDayOHLC.open,
      };
    }

    const fallbackPrice = currentPrice > 0 ? currentPrice : 2000;
    const atrFloor = Math.max(this.calculateRealATR(14), fallbackPrice * 0.008);
    const sessionHigh = this.highHistory.length > 0 ? Math.max(...this.highHistory.slice(-480)) : fallbackPrice + atrFloor;
    const sessionLow = this.lowHistory.length > 0 ? Math.min(...this.lowHistory.slice(-480)) : fallbackPrice - atrFloor;
    const derivedHigh = Math.max(sessionHigh, fallbackPrice + atrFloor * 0.5);
    const derivedLow = Math.min(sessionLow, fallbackPrice - atrFloor * 0.5);
    console.log(`📊 OHLC fallback from live session range: H ${derivedHigh.toFixed(1)} L ${derivedLow.toFixed(1)} C ${fallbackPrice.toFixed(1)}`);
    return {
      yesterdayHigh: derivedHigh,
      yesterdayLow: derivedLow,
      yesterdayClose: fallbackPrice,
      yesterdayOpen: (derivedHigh + derivedLow) / 2,
    };
  }

  private calculateDashboardPivotLevels(): {
    dailyPivot: number;
    r1: number;
    r2: number;
    r3: number;
    s1: number;
    s2: number;
    s3: number;
  } {
    const ohlc = this.getDerivedDailyOHLC();
    const currentPrice = this.currentPrice > 0 ? this.currentPrice : ohlc.yesterdayClose;
    const observedDailyRange = Math.max(ohlc.yesterdayHigh - ohlc.yesterdayLow, 0);
    const atrFloor = Math.max(this.calculateRealATR(14), currentPrice * 0.008);
    const dailyRange = Math.max(observedDailyRange, atrFloor);

    let H = ohlc.yesterdayHigh;
    let L = ohlc.yesterdayLow;
    let C = ohlc.yesterdayClose;

    const priceOutsideRange = currentPrice > H + dailyRange * 0.5 || currentPrice < L - dailyRange * 0.5;
    if (priceOutsideRange) {
      console.log(`⚠️ Current price ${currentPrice.toFixed(1)} far outside prior day range [${L.toFixed(1)}-${H.toFixed(1)}] - re-centering pivots around live price`);
      const halfRange = dailyRange / 2;
      H = currentPrice + halfRange;
      L = currentPrice - halfRange;
      C = currentPrice;
    }

    const dailyPivot = (H + L + C) / 3;
    const range = Math.max(H - L, dailyRange);
    const r1 = C + (range * 1.1) / 12;
    const s1 = C - (range * 1.1) / 12;
    const r2 = C + (range * 1.1) / 6;
    const s2 = C - (range * 1.1) / 6;
    const r3 = C + (range * 1.1) / 4;
    const s3 = C - (range * 1.1) / 4;

    console.log(`📊 Dashboard Daily Pivot Levels (Camarilla - intraday):`);
    console.log(`   OHLC used -> H: ${H.toFixed(1)} | L: ${L.toFixed(1)} | C: ${C.toFixed(1)} | Current: ${currentPrice.toFixed(1)}`);
    console.log(`   Range: ${dailyRange.toFixed(1)} | Pivot (ref): ${dailyPivot.toFixed(1)}`);
    console.log(`   Resistance -> R1: ${r1.toFixed(1)} | R2: ${r2.toFixed(1)} | R3: ${r3.toFixed(1)}`);
    console.log(`   Support    -> S1: ${s1.toFixed(1)} | S2: ${s2.toFixed(1)} | S3: ${s3.toFixed(1)}`);

    return {
      dailyPivot: parseFloat(dailyPivot.toFixed(1)),
      r1: parseFloat(r1.toFixed(1)),
      r2: parseFloat(r2.toFixed(1)),
      r3: parseFloat(r3.toFixed(1)),
      s1: parseFloat(s1.toFixed(1)),
      s2: parseFloat(s2.toFixed(1)),
      s3: parseFloat(s3.toFixed(1)),
    };
  }

  private async calculateMarketFeatures(): Promise<MarketFeatures> {
    const currentPrice = this.currentPrice;
    
    // Synthetic Asian Session Range based on recent price history or ATR
    // If we have history, find min/max of last N bars to simulate session
    // Step 5a: prefer the real tracked Asian session range (frozen at London
    // open so it survives through the day) over a rolling recent-tick proxy,
    // which effectively "forgot" the actual Asian session the moment new
    // ticks arrived.
    let asianHigh: number;
    let asianLow: number;
    if (this.frozenAsianHigh > 0 && this.frozenAsianLow < Infinity) {
      asianHigh = this.frozenAsianHigh;
      asianLow = this.frozenAsianLow;
    } else if (this.asianSessionHigh > 0 && this.asianSessionLow < Infinity) {
      asianHigh = this.asianSessionHigh;
      asianLow = this.asianSessionLow;
    } else if (this.priceHistory.length > 20) {
      const recent = this.priceHistory.slice(-50); // Last 50 ticks
      asianHigh = Math.max(...recent);
      asianLow = Math.min(...recent);
      // Expand slightly to simulate a session range if ticks are tight
      if (asianHigh - asianLow < 2) {
        const atr = this.calculateRealATR(14);
        asianHigh += atr;
        asianLow -= atr;
      }
    } else {
       // Fallback using synthetic volatility
       const volatility = this.calculateRealTimeVolatility();
       asianHigh = currentPrice + volatility * 2;
       asianLow = currentPrice - volatility * 2;
    }
    
    const ohlc = this.getDerivedDailyOHLC();
    const yesterdayHigh = ohlc.yesterdayHigh;
    const yesterdayLow = ohlc.yesterdayLow;
    const yesterdayClose = ohlc.yesterdayClose;
    
    let pivotH = yesterdayHigh;
    let pivotL = yesterdayLow;
    let pivotC = yesterdayClose;
    const rawRange = Math.max(pivotH - pivotL, 0);
    const atrFloorFeatures = Math.max(this.calculateRealATR(14), currentPrice * 0.008);
    const effectiveRange = Math.max(rawRange, atrFloorFeatures);

    const priceOutsidePivotRange = currentPrice > pivotH + effectiveRange * 0.5 || currentPrice < pivotL - effectiveRange * 0.5;
    if (priceOutsidePivotRange) {
      const halfRange = effectiveRange / 2;
      pivotH = currentPrice + halfRange;
      pivotL = currentPrice - halfRange;
      pivotC = currentPrice;
    }

    const dailyPivot = (pivotH + pivotL + pivotC) / 3;
    const dailyRange = pivotH - pivotL;

    const camRange = Math.max(pivotH - pivotL, effectiveRange);
    const r1 = pivotC + (camRange * 1.1) / 12;
    const s1 = pivotC - (camRange * 1.1) / 12;
    const r2 = pivotC + (camRange * 1.1) / 6;
    const s2 = pivotC - (camRange * 1.1) / 6;
    const r3 = pivotC + (camRange * 1.1) / 4;
    const s3 = pivotC - (camRange * 1.1) / 4;
    
    const rsi = this.calculateRealRSI(14);
    const atr = this.calculateRealATR(14);
    const volumeRatio = this.calculateRealVolumeRatio();
    
    // Step 5d: a genuine weekly figure from actual daily bars, not a copy of dailyPivot.
    const { weeklyHigh, weeklyLow, weeklyClose } = this.getWeeklyHighLow();
    const weeklyPivot = (weeklyHigh + weeklyLow + weeklyClose) / 3;
    
    // Fractals from price history
    let fractalResistance = currentPrice;
    let fractalSupport = currentPrice;
    
    if (this.highHistory.length >= 5) {
       const highs = this.highHistory.slice(-5);
       const lows = this.lowHistory.slice(-5);
       // Simple fractal: High surrounded by lower highs
       if (highs[2] > highs[0] && highs[2] > highs[1] && highs[2] > highs[3] && highs[2] > highs[4]) {
         fractalResistance = highs[2];
       } else {
         fractalResistance = Math.max(...highs) + atr;
       }
       
       if (lows[2] < lows[0] && lows[2] < lows[1] && lows[2] < lows[3] && lows[2] < lows[4]) {
         fractalSupport = lows[2];
       } else {
         fractalSupport = Math.min(...lows) - atr;
       }
    }
    
    const macdHistogram = this.calculateRealMACD();
    const emaCrossover = this.calculateRealEMACrossover();
    
    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    
    let sessionEndHour = 0;
    if (hour >= 6 && hour < 13) {
      sessionEndHour = 13;
    } else if (hour >= 13 && hour < 21) {
      sessionEndHour = 21;
    } else {
      sessionEndHour = 6;
    }
    
    const minutesToEnd = sessionEndHour * 60 - (hour * 60 + minute);
    const timeToSessionEnd = minutesToEnd > 0 ? minutesToEnd : 24 * 60 + minutesToEnd;
    
    const sessionVolatilityIndex = volumeRatio * atr / 10;
    
    const fibonacci = this.calculateFibonacciLevels(fractalResistance, fractalSupport);
    const sentiment = this.generateSentimentAnalysis();
    const orderFlow = this.calculateOrderFlow();
    const volumeProfile = this.calculateVolumeProfile();
    const marketRegime = await this.detectMarketRegime();
    const priceActionPattern = this.detectPriceActionPattern();
    const candlestickPattern = this.detectCandlestickPattern();
    const srStrength = this.calculateSupportResistanceStrength();
    const srZones = this.detectSRZones();
    
    const intermarketData = await fetchIntermarketData();
    const liquidityWindow = this.calculateLiquidityWindow();
    const timeWindowFactor = this.getTimeWindowFactor();
    const orderBlocks = this.detectOrderBlocks();
    const quasimodolLevels = this.detectQuasimodolLevels();
    const sessionSweeps = this.detectSessionSweeps();
    
    this.volumeHistory.push(volumeRatio * 1000);
    if (this.volumeHistory.length > 50) {
      this.volumeHistory.shift();
    }

    const vwap = this.calculateVWAP();
    const adx = this.calculateADX(14);
    const bollinger = this.calculateBollingerBands(20, 2);
    
    console.log(`📊 Camarilla Pivot Points Calculated:`);    console.log(`   Daily Pivot: ${dailyPivot.toFixed(1)} (H: ${yesterdayHigh.toFixed(1)}, L: ${yesterdayLow.toFixed(1)}, C: ${yesterdayClose.toFixed(1)})`);
    console.log(`   R1: ${r1.toFixed(1)} | R2: ${r2.toFixed(1)} | R3: ${r3.toFixed(1)}`);
    console.log(`   S1: ${s1.toFixed(1)} | S2: ${s2.toFixed(1)} | S3: ${s3.toFixed(1)}`);
    console.log(`   Current Price: ${currentPrice.toFixed(1)}`);
    
    return {
      asianHigh,
      asianLow,
      dailyPivot: parseFloat(dailyPivot.toFixed(1)),
      r1: parseFloat(r1.toFixed(1)),
      r2: parseFloat(r2.toFixed(1)),
      r3: parseFloat(r3.toFixed(1)),
      s1: parseFloat(s1.toFixed(1)),
      s2: parseFloat(s2.toFixed(1)),
      s3: parseFloat(s3.toFixed(1)),
      rsi,
      atr,
      dxyChange: intermarketData.dxyChange,
      volumeRatio,
      weeklyPivot: parseFloat(weeklyPivot.toFixed(1)),
      fractalResistance,
      fractalSupport,
      macdHistogram,
      emaCrossover,
      sessionVolatilityIndex,
      timeToSessionEnd,
      fibonacci,
      sentiment,
      orderFlow,
      volumeProfile,
      marketRegime,
      priceActionPattern,
      candlestickPattern,
      supportStrength: srStrength.supportStrength,
      resistanceStrength: srStrength.resistanceStrength,
      srZones,
      activeSRReaction: null,
      intermarketData,
      liquidityWindow,
      timeWindowFactor,
      orderBlocks,
      quasimodolLevels,
      sessionSweeps,
      vwap,
      adx,
      bollingerSqueeze: bollinger.squeeze,
      bollingerExpansion: bollinger.expansion,
      bollingerBandwidth: bollinger.bandwidth,
    };
  }

  private calculateVWAP(): number | null {
    if (this.priceHistory.length < 10 || this.highHistory.length < 10 || this.lowHistory.length < 10) return null;
    const n = Math.min(30, this.priceHistory.length);
    const closes = this.priceHistory.slice(-n);
    const highs = this.highHistory.slice(-n);
    const lows = this.lowHistory.slice(-n);
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      const typical = (highs[i] + lows[i] + closes[i]) / 3;
      const pseudoVolume = Math.max(0.1, Math.abs(highs[i] - lows[i]));
      numerator += typical * pseudoVolume;
      denominator += pseudoVolume;
    }
    if (denominator === 0) return null;
    return parseFloat((numerator / denominator).toFixed(2));
  }

  private calculateADX(period: number = 14): number | null {
    if (this.highHistory.length < period + 1 || this.lowHistory.length < period + 1 || this.priceHistory.length < period + 1) return null;
    const highs = this.highHistory.slice(-(period + 1));
    const lows = this.lowHistory.slice(-(period + 1));
    const closes = this.priceHistory.slice(-(period + 1));
    const plusDM: number[] = [];
    const minusDM: number[] = [];
    const trs: number[] = [];
    for (let i = 1; i < highs.length; i++) {
      const upMove = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];
      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      trs.push(tr);
    }
    const sumTR = trs.reduce((a, b) => a + b, 0);
    if (sumTR === 0) return null;
    const plusDI = 100 * (plusDM.reduce((a, b) => a + b, 0) / sumTR);
    const minusDI = 100 * (minusDM.reduce((a, b) => a + b, 0) / sumTR);
    const diSum = plusDI + minusDI;
    if (diSum === 0) return 0;
    const dx = 100 * Math.abs(plusDI - minusDI) / diSum;
    return parseFloat(dx.toFixed(1));
  }

  private calculateBollingerBands(period: number = 20, stdDevMultiplier: number = 2): { squeeze: boolean; expansion: boolean; bandwidth: number | null } {
    if (this.priceHistory.length < period * 2) return { squeeze: false, expansion: false, bandwidth: null };
    const prices = this.priceHistory.slice(-period);
    const mean = prices.reduce((a, b) => a + b, 0) / period;
    const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    const upper = mean + std * stdDevMultiplier;
    const lower = mean - std * stdDevMultiplier;
    const bandwidth = (upper - lower) / mean;
    const priorPrices = this.priceHistory.slice(-period * 2, -period);
    const priorMean = priorPrices.reduce((a, b) => a + b, 0) / period;
    const priorVar = priorPrices.reduce((s, p) => s + (p - priorMean) ** 2, 0) / period;
    const priorStd = Math.sqrt(priorVar);
    const priorBandwidth = (priorStd * 2 * stdDevMultiplier) / priorMean;
    const squeeze = bandwidth < priorBandwidth * 0.7 && bandwidth < 0.006;
    const expansion = bandwidth > priorBandwidth * 1.3;
    return { squeeze, expansion, bandwidth: parseFloat(bandwidth.toFixed(5)) };
  }

  /** Date-pattern NFP/CPI/FOMC heuristic - kept as an explicit fallback for when the real FMP calendar is unavailable. */
  private detectMacroEventsHeuristic(): MacroEvent | undefined {
    const now = new Date();
    const hour = now.getUTCHours();
    const dayOfWeek = now.getUTCDay();
    const dayOfMonth = now.getUTCDate();
    
    const nfpWeek = dayOfWeek === 5 && dayOfMonth >= 1 && dayOfMonth <= 7;
    const cpiWeek = dayOfMonth >= 10 && dayOfMonth <= 15;
    const fomcWeek = [20, 21, 22, 23].includes(dayOfMonth);
    
    if (nfpWeek && hour >= 12 && hour < 15) {
      return {
        name: "Non-Farm Payrolls (NFP)",
        impact: "HIGH",
        timeUntilEvent: (13.5 - hour) * 60,
      };
    }
    
    if (cpiWeek && dayOfWeek >= 2 && dayOfWeek <= 4 && hour >= 12 && hour < 15) {
      return {
        name: "CPI Data Release",
        impact: "HIGH",
        timeUntilEvent: (13.5 - hour) * 60,
      };
    }
    
    if (fomcWeek && dayOfWeek === 3 && hour >= 17 && hour < 20) {
      return {
        name: "FOMC Statement",
        impact: "HIGH",
        timeUntilEvent: (19 - hour) * 60,
      };
    }
    
    return undefined;
  }

  private macroCalendarCache: { events: { name: string; impact: string; date: string }[]; timestamp: number } | null = null;
  private lastMacroCalendarFetchAttempt: number = 0;
  private readonly MACRO_CALENDAR_CLIENT_CACHE_MS = 45 * 60 * 1000;

  /** Fetches the real FMP-backed calendar (server-cached 30-60min), re-fetching client-side at most every 30-60min too. Falls back to the date-pattern heuristic if unreachable/errors/empty. */
  private async fetchRealMacroCalendar(): Promise<{ name: string; impact: string; date: string }[] | null> {
    const now = Date.now();
    if (this.macroCalendarCache && now - this.macroCalendarCache.timestamp < this.MACRO_CALENDAR_CLIENT_CACHE_MS) {
      return this.macroCalendarCache.events;
    }
    if (now - this.lastMacroCalendarFetchAttempt < 60000 && this.macroCalendarCache) {
      return this.macroCalendarCache.events;
    }
    this.lastMacroCalendarFetchAttempt = now;

    try {
      const result = await trpcClient.economicCalendar.getUpcomingEvents.query();
      if (result.source === "FMP") {
        this.macroCalendarCache = { events: result.events, timestamp: now };
        console.log(`\uD83D\uDCC5 Macro Calendar: real FMP calendar loaded (${result.events.length} gold-relevant high-impact events, cached=${result.cached})`);
        return result.events;
      }
      console.warn("\uD83D\uDCC5 Macro Calendar: FMP unavailable (no server key or fetch failed) - falling back to date-pattern heuristic");
      return null;
    } catch (error) {
      console.warn("\uD83D\uDCC5 Macro Calendar: FMP request failed - falling back to date-pattern heuristic", error instanceof Error ? error.message : "Unknown");
      return null;
    }
  }

  /** Real-calendar-first macro event detector. Same MacroEvent shape as before, so shouldSuppressMacroEvent()/downstream code needs no changes. */
  private detectMacroEvents(): MacroEvent | undefined {
    const cachedEvents = this.macroCalendarCache?.events;
    if (cachedEvents) {
      return this.nearestMacroEventFromCalendar(cachedEvents) ?? undefined;
    }
    void this.fetchRealMacroCalendar();
    return this.detectMacroEventsHeuristic();
  }

  private nearestMacroEventFromCalendar(events: { name: string; impact: string; date: string }[]): MacroEvent | null {
    const now = Date.now();
    let nearest: MacroEvent | null = null;
    let nearestAbsMinutes = Infinity;
    for (const event of events) {
      const eventTime = new Date(event.date).getTime();
      if (!Number.isFinite(eventTime)) continue;
      const minutesUntil = (eventTime - now) / 60000;
      if (minutesUntil < -240 || minutesUntil > 24 * 60) continue;
      if (Math.abs(minutesUntil) < nearestAbsMinutes) {
        nearestAbsMinutes = Math.abs(minutesUntil);
        nearest = {
          name: event.name,
          impact: (event.impact === "HIGH" || event.impact === "MEDIUM" || event.impact === "LOW") ? event.impact : "HIGH",
          timeUntilEvent: Math.round(minutesUntil),
        };
      }
    }
    return nearest;
  }

  /** Next upcoming high-impact event within a 24h look-ahead window, for MarketOutlook.upcomingHighImpactEvent. */
  private async getUpcomingHighImpactEventForOutlook(): Promise<{ name: string; impact: string; timeUntilEvent: number } | null> {
    const events = await this.fetchRealMacroCalendar();
    let source: { name: string; impact: string; date: string }[];
    if (events) {
      source = events;
    } else {
      const heuristic = this.detectMacroEventsHeuristic();
      source = heuristic ? [{
        name: heuristic.name,
        impact: heuristic.impact,
        date: new Date(Date.now() + heuristic.timeUntilEvent * 60000).toISOString(),
      }] : [];
    }
    const nearest = this.nearestMacroEventFromCalendar(source);
    if (!nearest || nearest.timeUntilEvent < 0 || nearest.timeUntilEvent > 24 * 60) return null;
    return { name: nearest.name, impact: nearest.impact, timeUntilEvent: nearest.timeUntilEvent };
  }
  
  private smoothConfidence(rawConfidence: number): number {
    this.confidenceHistory.push(rawConfidence);
    if (this.confidenceHistory.length > CONFIDENCE_SMOOTHING_WINDOW) {
      this.confidenceHistory.shift();
    }

    // Minimal smoothing: blend 85% raw + 15% previous to preserve true signal confidence
    // while avoiding frame-to-frame jitter. Previous aggressive EMA was clustering all
    // signals near the 66% mean regardless of actual setup quality.
    const prev = this.confidenceHistory.length >= 2
      ? this.confidenceHistory[this.confidenceHistory.length - 2]
      : rawConfidence;
    const blended = 0.85 * rawConfidence + 0.15 * prev;
    const finalConfidence = Math.min(blended, MAX_CONFIDENCE_CAP);

    console.log(`🔄 Confidence (light blend): Raw ${(rawConfidence * 100).toFixed(1)}% -> Final ${(finalConfidence * 100).toFixed(1)}% (prev ${(prev * 100).toFixed(1)}%)`);

    return parseFloat(finalConfidence.toFixed(3));
  }
  
  private calculateFeatureCorrelation(): void {
    const now = Date.now();
    if (now - this.lastFeatureCorrelationCheck < FEATURE_CORRELATION_CHECK_INTERVAL) {
      return;
    }
    
    this.lastFeatureCorrelationCheck = now;
    
    if (this.tradeOutcomes.length < 20) {
      console.log('⚠️ Insufficient data for feature correlation check');
      return;
    }
    
    console.log('🔍 Running Feature Correlation Monitor...');
    
    const recentOutcomes = this.tradeOutcomes.slice(-50);
    const features = recentOutcomes.map(o => o.features);
    
    const rsiValues = features.map(f => f.rsi);
    const volumeValues = features.map(f => f.volumeRatio);
    const sentimentValues = features.map(f => f.sentiment?.score ?? 0);
    
    const rsiVolCorr = this.calculateCorrelation(rsiValues, volumeValues);
    const rsiSentCorr = this.calculateCorrelation(rsiValues, sentimentValues);
    
    let redundantFeatures = 0;
    const correlationThreshold = 0.85;
    
    if (Math.abs(rsiVolCorr) > correlationThreshold) {
      redundantFeatures++;
      console.log(`⚠️ High correlation detected: RSI <-> Volume (${rsiVolCorr.toFixed(2)})`);
    }
    if (Math.abs(rsiSentCorr) > correlationThreshold) {
      redundantFeatures++;
      console.log(`⚠️ High correlation detected: RSI <-> Sentiment (${rsiSentCorr.toFixed(2)})`);
    }
    
    if (redundantFeatures === 0) {
      this.featureCorrelationStatus = 'HEALTHY';
      console.log('✅ Feature Correlation: HEALTHY (No redundant features)');
    } else if (redundantFeatures <= 2) {
      this.featureCorrelationStatus = 'MODERATE';
      console.log(`⚠️ Feature Correlation: MODERATE (${redundantFeatures} correlated pairs)`);
    } else {
      this.featureCorrelationStatus = 'POOR';
      console.log(`🛑 Feature Correlation: POOR (${redundantFeatures}+ correlated features)`);
    }
    
    this.updateModelHealthScore();
  }
  
  private calculateCorrelation(x: number[], y: number[]): number {
    if (x.length !== y.length || x.length === 0) return 0;
    
    const n = x.length;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;
    
    let numerator = 0;
    let denomX = 0;
    let denomY = 0;
    
    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      denomX += dx * dx;
      denomY += dy * dy;
    }
    
    const denominator = Math.sqrt(denomX * denomY);
    return denominator === 0 ? 0 : numerator / denominator;
  }
  
  private updateModelHealthScore(): void {
    let healthScore = 100;
    
    const timeSinceRetraining = this.lastTrainingTime > 0 ? Date.now() - this.lastTrainingTime : 0;
    const daysSinceRetraining = this.lastTrainingTime > 0 ? timeSinceRetraining / (24 * 60 * 60 * 1000) : 0;
    
    console.log(`📊 Model Health Debug: lastTrainingTime=${this.lastTrainingTime > 0 ? new Date(this.lastTrainingTime).toISOString() : 'NEVER_TRAINED'}, timeSince=${this.lastTrainingTime > 0 ? (timeSinceRetraining/1000/60).toFixed(1) + 'min' : 'N/A'}, days=${daysSinceRetraining.toFixed(2)}`);
    
    if (this.lastTrainingTime === 0) {
      healthScore = 85;
      console.log('⚠️ Model never trained - starting with baseline health of 85/100');
    } else if (daysSinceRetraining > 2) {
      healthScore -= Math.min(40, (daysSinceRetraining - 2) * 5);
      if (daysSinceRetraining > 2) {
        console.log(`⚠️ Model is ${daysSinceRetraining.toFixed(1)} days old (48-hour schedule exceeded)`);
      }
    }
    
    const avgRecentWinConfidence = this.performanceMetrics.recentWinningConfidences.length > 0
      ? this.performanceMetrics.recentWinningConfidences.reduce((a, b) => a + b, 0) / this.performanceMetrics.recentWinningConfidences.length
      : 0.80;
    const confidenceDegradation = MIN_CONFIDENCE_FOR_RETRAINING - avgRecentWinConfidence;
    if (confidenceDegradation > 0) {
      healthScore -= Math.min(40, confidenceDegradation * 100);
    }
    
    if (this.featureCorrelationStatus === 'MODERATE') {
      healthScore -= 15;
    } else if (this.featureCorrelationStatus === 'POOR') {
      healthScore -= 30;
    }
    
    if (this.conceptDriftScore > 0.3) {
      healthScore -= Math.min(25, this.conceptDriftScore * 50);
    }
    
    this.modelHealthScore = Math.max(0, Math.min(100, healthScore));
    
    console.log(`🏥 Model Health Score: ${this.modelHealthScore.toFixed(0)}/100 (Days: ${daysSinceRetraining.toFixed(1)}, ConfDeg: ${(confidenceDegradation * 100).toFixed(1)}%, FeatureCorr: ${this.featureCorrelationStatus}, Drift: ${this.conceptDriftScore.toFixed(2)})`);
    
    if (this.modelHealthScore < 70) {
      console.log('🚨 WARN: Model Health Score below 70. System check recommended before degradation.');
    }
  }
  
  private checkRollingWinRateDrift(): boolean {
    if (this.tradeOutcomes.length < 20) return false;
    const recent = this.tradeOutcomes.slice(-10);
    const older = this.tradeOutcomes.slice(-20, -10);
    const recentWr = recent.filter(o => o.result === 'WIN').length / recent.length;
    const olderWr = older.filter(o => o.result === 'WIN').length / older.length;
    return (olderWr - recentWr) > 0.25;
  }

  private async detectConceptDrift(features: MarketFeatures): Promise<void> {
    const now = Date.now();
    const winRateDrift = this.checkRollingWinRateDrift();
    if (winRateDrift) {
      console.log('🚨 Rolling win-rate dropped >25% - forcing drift check');
    }
    if (!winRateDrift && this.lastDriftCheck > 0 && now - this.lastDriftCheck < DRIFT_CHECK_INTERVAL) {
      const nextCheck = new Date(this.lastDriftCheck + DRIFT_CHECK_INTERVAL);
      const hoursRemaining = ((this.lastDriftCheck + DRIFT_CHECK_INTERVAL - now) / (1000 * 60 * 60)).toFixed(1);
      console.log(`⏰ Next Drift Check in ${hoursRemaining}h (scheduled: ${nextCheck.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })})`);
      return;
    }
    
    this.lastDriftCheck = now;
    
    if (this.tradeOutcomes.length < 30) {
      console.log('⚠️ Insufficient data for drift detection (need 30+ outcomes)');
      return;
    }
    
    console.log('\n🔍 DRIFT DETECTION ANALYSIS');
    console.log('='.repeat(60));
    
    const featureKeys = ['rsi', 'atr', 'dxyChange', 'volumeRatio', 'sentiment_score', 'orderFlow_volumeImbalance'];
    
    for (const key of featureKeys) {
      let currentValue: number;
      
      switch (key) {
        case 'rsi':
          currentValue = features.rsi;
          break;
        case 'atr':
          currentValue = features.atr;
          break;
        case 'dxyChange':
          currentValue = features.dxyChange;
          break;
        case 'volumeRatio':
          currentValue = features.volumeRatio;
          break;
        case 'sentiment_score':
          currentValue = features.sentiment?.score ?? 0;
          break;
        case 'orderFlow_volumeImbalance':
          currentValue = features.orderFlow.volumeImbalance;
          break;
        default:
          continue;
      }
      
      if (!this.featureDistributionHistory.has(key)) {
        this.featureDistributionHistory.set(key, []);
      }
      
      const history = this.featureDistributionHistory.get(key)!;
      history.push(currentValue);
      
      if (history.length > 100) {
        history.shift();
      }
      
      this.featureDistributionHistory.set(key, history);
    }
    
    let totalDrift = 0;
    let driftCount = 0;
    
    for (const [key, values] of this.featureDistributionHistory.entries()) {
      if (values.length < 30) continue;
      
      const recent = values.slice(-10);
      const historical = values.slice(0, -10);
      
      const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const historicalMean = historical.reduce((a, b) => a + b, 0) / historical.length;
      
      const recentStd = Math.sqrt(recent.reduce((sum, val) => sum + Math.pow(val - recentMean, 2), 0) / recent.length);
      const historicalStd = Math.sqrt(historical.reduce((sum, val) => sum + Math.pow(val - historicalMean, 2), 0) / historical.length);
      
      const meanShift = Math.abs(recentMean - historicalMean) / (historicalStd + 0.01);
      const stdShift = Math.abs(recentStd - historicalStd) / (historicalStd + 0.01);
      
      const drift = (meanShift + stdShift) / 2;
      totalDrift += drift;
      driftCount++;
      
      console.log(`   ${key}: Mean ${historicalMean.toFixed(2)} -> ${recentMean.toFixed(2)} | Drift: ${drift.toFixed(2)}`);
    }
    
    this.conceptDriftScore = driftCount > 0 ? totalDrift / driftCount : 0;
    
    if (this.conceptDriftScore < 0.2) {
      this.driftAlertLevel = 'NONE';
      console.log(`✅ Concept Drift: STABLE (${this.conceptDriftScore.toFixed(2)})`);
    } else if (this.conceptDriftScore < 0.4) {
      this.driftAlertLevel = 'LOW';
      console.log(`⚠️ Concept Drift: LOW (${this.conceptDriftScore.toFixed(2)})`);
    } else if (this.conceptDriftScore < 0.6) {
      this.driftAlertLevel = 'MEDIUM';
      console.log(`🔶 Concept Drift: MEDIUM (${this.conceptDriftScore.toFixed(2)}) - Monitor closely`);
    } else {
      this.driftAlertLevel = 'HIGH';
      console.log(`🚨 Concept Drift: HIGH (${this.conceptDriftScore.toFixed(2)}) - SCHEDULING RETRAIN`);
      // E25: Auto-halve weights of critical-drift features
      const featureDriftMetrics = this.analyzeFeatureImportanceDrift();
      featureDriftMetrics.forEach(m => {
        if (m.status === 'CRITICAL') {
          const key = `${m.feature}_weight`;
          const current = this.modelWeights.get(key);
          if (current !== undefined) {
            const halved = current * 0.5;
            this.modelWeights.set(key, halved);
            console.log(`   ⚡ Auto-halved ${key}: ${current.toFixed(3)} -> ${halved.toFixed(3)}`);
          }
        }
      });
      
      console.log('\n' + '🔥'.repeat(30));
      console.log('⚡ CONCEPT DRIFT AUTO-RESPONSE SYSTEM ACTIVATED');
      console.log('🔥'.repeat(30));
      console.log(`   Drift Score: ${this.conceptDriftScore.toFixed(2)} (Threshold: 0.6)`);
      console.log(`   Alert Level: HIGH`);
      console.log(`   Action 1: Scheduling model retrain for low-liquidity window`);
      console.log(`   Action 2: Temporarily increasing confidence threshold 70% -> 80%`);
      console.log(`   Target Window: Asian Session (22:00 - 07:00 UTC)`);
      console.log('🔥'.repeat(30) + '\n');
      
      this.retrainScheduled = true;
      
      console.log('\n✅ Concept Drift Response: Retrain Scheduled');
      console.log('   - Retrain flag set to TRUE');
      console.log('   - Will execute during next Asian Session (22:00-07:00 UTC)');
      console.log('   - Confidence threshold temporarily elevated to 80%');
      console.log('   - System will automatically revert threshold after retrain\n');
    }
    
    console.log('='.repeat(60) + '\n');
    
    await this.saveFeatureDriftHistory();
    this.updateModelHealthScore();
  }
  
  private analyzeFeatureImportanceDrift(): FeatureDriftMetric[] {
    if (this.tradeOutcomes.length < 20) {
      console.log('⚠️ Feature Importance Drift: Insufficient data (need 20+ outcomes, have ' + this.tradeOutcomes.length + ')');
      return [];
    }
    
    const recentOutcomes = this.tradeOutcomes.slice(-20);
    const olderOutcomes = this.tradeOutcomes.slice(-40, -20);
    
    if (olderOutcomes.length < 10) {
      return [];
    }
    
    const metrics: FeatureDriftMetric[] = [];
    
    const featureNames = ['rsi', 'atr', 'volumeRatio', 'sentiment', 'dxyChange'];
    
    for (const featureName of featureNames) {
      const recentWinFeatures = recentOutcomes.filter(o => o.result === 'WIN');
      const olderWinFeatures = olderOutcomes.filter(o => o.result === 'WIN');
      
      if (recentWinFeatures.length === 0 || olderWinFeatures.length === 0) continue;
      
      let recentAvg = 0;
      let olderAvg = 0;
      
      if (featureName === 'rsi') {
        recentAvg = recentWinFeatures.reduce((sum, o) => sum + o.features.rsi, 0) / recentWinFeatures.length;
        olderAvg = olderWinFeatures.reduce((sum, o) => sum + o.features.rsi, 0) / olderWinFeatures.length;
      } else if (featureName === 'atr') {
        recentAvg = recentWinFeatures.reduce((sum, o) => sum + o.features.atr, 0) / recentWinFeatures.length;
        olderAvg = olderWinFeatures.reduce((sum, o) => sum + o.features.atr, 0) / olderWinFeatures.length;
      } else if (featureName === 'volumeRatio') {
        recentAvg = recentWinFeatures.reduce((sum, o) => sum + o.features.volumeRatio, 0) / recentWinFeatures.length;
        olderAvg = olderWinFeatures.reduce((sum, o) => sum + o.features.volumeRatio, 0) / olderWinFeatures.length;
      } else if (featureName === 'sentiment') {
        recentAvg = recentWinFeatures.reduce((sum, o) => sum + (o.features.sentiment?.score ?? 0), 0) / recentWinFeatures.length;
        olderAvg = olderWinFeatures.reduce((sum, o) => sum + (o.features.sentiment?.score ?? 0), 0) / olderWinFeatures.length;
      } else if (featureName === 'dxyChange') {
        recentAvg = recentWinFeatures.reduce((sum, o) => sum + o.features.dxyChange, 0) / recentWinFeatures.length;
        olderAvg = olderWinFeatures.reduce((sum, o) => sum + o.features.dxyChange, 0) / olderWinFeatures.length;
      }
      
      const historicalImportance = Math.abs(olderAvg);
      const currentImportance = Math.abs(recentAvg);
      const drift = Math.abs(currentImportance - historicalImportance) / (historicalImportance + 0.01);
      
      let status: 'STABLE' | 'DEGRADING' | 'CRITICAL';
      if (drift < 0.3) {
        status = 'STABLE';
      } else if (drift < 0.6) {
        status = 'DEGRADING';
      } else {
        status = 'CRITICAL';
      }
      
      metrics.push({
        feature: featureName,
        currentImportance: parseFloat(currentImportance.toFixed(3)),
        historicalImportance: parseFloat(historicalImportance.toFixed(3)),
        drift: parseFloat(drift.toFixed(3)),
        status,
      });
      
      const impact = drift > 0.6 ? '🚨 CRITICAL' : drift > 0.3 ? '⚠️ WARNING' : '✅ STABLE';
      console.log(`   📊 ${featureName}: ${impact} (Historical: ${historicalImportance.toFixed(3)}, Current: ${currentImportance.toFixed(3)}, Drift: ${(drift * 100).toFixed(1)}%)`);
      
      if (status === 'CRITICAL') {
        console.log(`      🔥 Feature ${featureName} showing critical drift - may need to be removed or retrained`);
      } else if (status === 'DEGRADING') {
        console.log(`      ⚠️ Feature ${featureName} degrading - monitor for continued deterioration`);
      }
    }
    
    return metrics;
  }
  
  private async saveFeatureDriftHistory(): Promise<void> {
    try {
      const data = {
        featureDistributionHistory: Array.from(this.featureDistributionHistory.entries()),
        conceptDriftScore: this.conceptDriftScore,
        driftAlertLevel: this.driftAlertLevel,
        lastDriftCheck: this.lastDriftCheck,
      };
      await AsyncStorage.setItem(FEATURE_DRIFT_STORAGE_KEY, JSON.stringify(data));
    } catch (error) {
      console.error('Failed to save drift history:', error);
    }
  }
  
  private async loadFeatureDriftHistory(): Promise<void> {
    try {
      const data = await AsyncStorage.getItem(FEATURE_DRIFT_STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        this.featureDistributionHistory = new Map(parsed.featureDistributionHistory);
        this.conceptDriftScore = parsed.conceptDriftScore || 0;
        this.driftAlertLevel = parsed.driftAlertLevel || 'NONE';
        this.lastDriftCheck = parsed.lastDriftCheck || 0;
        console.log('✓ Loaded drift detection history');
      }
    } catch (error) {
      console.error('Failed to load drift history:', error);
    }
  }
  
  /**
   * Phase 0: maps a learned (normalized, signed) feature weight to a scoring
   * multiplier. Returns 1.0 when the feature has no learned weight yet (cold
   * start), so the engine reproduces pre-Phase-0 behaviour until training data
   * exists. A positive learned weight amplifies the feature's contribution; a
   * weight that has drifted toward/under zero (including the concept-drift
   * auto-halving) shrinks or reverses it.
   */
  private getFeatureModulation(featureKey: string): number {
    const w = this.modelWeights.get(featureKey);
    if (w === undefined || !Number.isFinite(w)) {
      return 1;
    }
    const factor = 1 + LEARNED_WEIGHT_GAIN * w;
    return Math.max(LEARNED_MODULATION_MIN, Math.min(LEARNED_MODULATION_MAX, factor));
  }

  /** Phase 0 test seam: deterministically retrain weights from a fixed outcome set. */
  public trainOnOutcomesForTest(outcomes: TradeOutcome[]): void {
    this.retrainModel(outcomes);
  }

  /** Phase 0 test seam: read the live learned modulation applied to a feature's scoring contribution. */
  public getLearnedFeatureModulationForTest(featureKey: string): number {
    return this.getFeatureModulation(featureKey);
  }

  /** Phase 0 test seam: read the current learned weight for a feature. */
  public getModelWeightForTest(featureKey: string): number | undefined {
    return this.modelWeights.get(featureKey);
  }

  /**
   * PHASE 2 (C4): recompute realised expectancy per direction from stored
   * outcomes. Only non-scratch outcomes with a known realizedR are counted, so
   * a book with no stop-distance history simply produces n=0 and the
   * calibration gate stays inert rather than guessing.
   */
  private recomputeDirectionalExpectancy(): void {
    const buckets: { BUY: number[]; SELL: number[] } = { BUY: [], SELL: [] };
    for (const outcome of this.tradeOutcomes) {
      if (outcome.isScratch === true) continue;
      if (outcome.direction !== 'BUY' && outcome.direction !== 'SELL') continue;
      if (typeof outcome.realizedR !== 'number' || !Number.isFinite(outcome.realizedR)) continue;
      buckets[outcome.direction].push(outcome.realizedR);
    }

    const summarize = (values: number[]): { n: number; meanR: number } => ({
      n: values.length,
      meanR: values.length > 0 ? parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)) : 0,
    });

    this.directionalExpectancy = { BUY: summarize(buckets.BUY), SELL: summarize(buckets.SELL) };
    console.log(`📐 Directional expectancy: BUY n=${this.directionalExpectancy.BUY.n} EV=${this.directionalExpectancy.BUY.meanR.toFixed(3)}R | SELL n=${this.directionalExpectancy.SELL.n} EV=${this.directionalExpectancy.SELL.meanR.toFixed(3)}R`);
  }

  /**
   * PHASE 2 (C4): confidence penalty for a direction whose own realised
   * expectancy is negative over a sufficient sample. Scales with how negative
   * the expectancy is (0.20R deficit = full penalty) and is capped, so it
   * nudges rather than hard-suppresses, and decays to zero automatically once
   * that direction's expectancy recovers.
   */
  private getDirectionalCalibrationPenalty(direction: 'BUY' | 'SELL'): number {
    const bucket = this.directionalExpectancy[direction];
    if (bucket.n < DIRECTION_CALIBRATION_MIN_SAMPLE) return 0;
    if (bucket.meanR >= 0) return 0;
    const severity = Math.min(1, Math.abs(bucket.meanR) / 0.2);
    return parseFloat((DIRECTION_CALIBRATION_MAX_PENALTY * severity).toFixed(4));
  }

  /** Test seam: realised expectancy per direction (C4). */
  public getDirectionalExpectancyForTest(): { BUY: { n: number; meanR: number }; SELL: { n: number; meanR: number } } {
    this.recomputeDirectionalExpectancy();
    return this.directionalExpectancy;
  }

  /** Test seam: the live direction-bucketed calibration penalty (C4). */
  public getDirectionalCalibrationPenaltyForTest(direction: 'BUY' | 'SELL'): number {
    this.recomputeDirectionalExpectancy();
    return this.getDirectionalCalibrationPenalty(direction);
  }

  /** Test seam: recorded outcome labels/scratch flags (C3). */
  public getStoredOutcomesForTest(): { result: 'WIN' | 'LOSS'; realizedR?: number; isScratch?: boolean; direction?: 'BUY' | 'SELL' }[] {
    return this.tradeOutcomes.map(o => ({ result: o.result, realizedR: o.realizedR, isScratch: o.isScratch, direction: o.direction }));
  }

  /** Test seam: reset learning state so a test starts from a clean book. */
  public resetOutcomesForTest(): void {
    this.tradeOutcomes = [];
    this.directionalExpectancy = { BUY: { n: 0, meanR: 0 }, SELL: { n: 0, meanR: 0 } };
  }

  /**
   * Test seam (B4): drive one sweep evaluation directly and read the resulting
   * confirmed sweeps plus the pending-penetration count.
   */
  public evaluateSessionSweepForTest(params: {
    sessionType: 'ASIAN' | 'LONDON' | 'NY';
    type: 'HIGH_SWEEP' | 'LOW_SWEEP';
    level: number;
    currentPrice: number;
    now: number;
    baseStrength?: number;
  }): { sweeps: SessionSweep[]; pending: number } {
    this.evaluateSessionSweep({ ...params, baseStrength: params.baseStrength ?? 0.70 });
    return { sweeps: this.sessionSweeps.slice(), pending: this.pendingSweepPenetrations.size };
  }

  /** Test seam (B4): clear sweep state between scenarios. */
  public resetSweepStateForTest(): void {
    this.sessionSweeps = [];
    this.pendingSweepPenetrations.clear();
  }

  /** Step 1 test seam: read the Bayesian blend alpha (historical-weight share) used by retrainModel. */
  public getBayesianBlendAlphaForTest(): number {
    return BAYESIAN_BLEND_ALPHA;
  }

  /** Pivot-floor-fix test seam: force deterministic price/ATR/prior-day inputs, then read the dashboard pivot levels. */
  public getDashboardPivotLevelsForTest(
    price: number,
    highs: number[],
    lows: number[],
    closes: number[],
    priorDayBar?: { high: number; low: number; close: number; open: number }
  ): {
    dailyPivot: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number;
  } {
    this.currentPrice = price;
    this.highHistory = highs;
    this.lowHistory = lows;
    this.priceHistory = closes;
    this.barCloseHistory = closes; // test-provided closes are already bar-aligned with highs/lows
    if (priorDayBar) {
      this.dailyOHLCHistory = [{
        date: "test-day",
        open: priorDayBar.open,
        high: priorDayBar.high,
        low: priorDayBar.low,
        close: priorDayBar.close,
        timestamp: Date.now() - 60 * 60 * 1000, // 1h old -> not stale
      }];
    }
    return this.calculateDashboardPivotLevels();
  }

  /** Pivot-floor-fix test seam: read the ATR value that would be used as the floor's raw input. */
  public getRealATRForTest(period: number = 14): number {
    return this.calculateRealATR(period);
  }

  /**
   * Item 3 (ATR array-misalignment repro) test seam: mimics EXACTLY the
   * wholesale-replace assignment fetchAndUpdateOHLCHistory's real-bar branch
   * performs (`this.highHistory = bars.map(b => b.high); this.lowHistory =
   * bars.map(b => b.low);`, see the 60s-interval OHLC refresh above) without
   * touching priceHistory. This lets a test drive highHistory/lowHistory on
   * their own real 60s-bar-refresh cadence while priceHistory is driven
   * independently via the REAL production tick path (pushTickForTest ->
   * syncCurrentPrice), reproducing the two arrays' independent cadences
   * exactly as they occur in production — purely additive test
   * infrastructure, does not alter calculateRealATR or any other behavior.
   */
  public pushBarRefreshForTest(bars: { high: number; low: number; close: number }[]): void {
    this.highHistory = bars.map(b => b.high);
    this.lowHistory = bars.map(b => b.low);
    this.barCloseHistory = bars.map(b => b.close);
  }

  /** Item 3 test seam: read priceHistory length (to confirm tick cadence actually diverged from bar cadence during a repro run). */
  public getPriceHistoryLengthForTest(): number {
    return this.priceHistory.length;
  }

  /** Step 3 investigation seam: read the live, already-computed this.srZones snapshot (top-16, post-decay, as gating actually sees it) without forcing synthetic inputs. */
  public getCurrentSRZonesForTest(): SRZone[] {
    return this.srZones;
  }

  /** SRZone-floor-fix test seam: force deterministic price/history/prior-day inputs, then read detectSRZones() output. */
  public getSRZonesForTest(
    price: number,
    highs: number[],
    lows: number[],
    closes: number[],
    priorDayBar?: { high: number; low: number; close: number; open: number }
  ): SRZone[] {
    this.currentPrice = price;
    this.highHistory = highs;
    this.lowHistory = lows;
    this.priceHistory = closes;
    this.barCloseHistory = closes; // test-provided closes are already bar-aligned with highs/lows
    if (priorDayBar) {
      this.dailyOHLCHistory = [{
        date: "test-day",
        open: priorDayBar.open,
        high: priorDayBar.high,
        low: priorDayBar.low,
        close: priorDayBar.close,
        timestamp: Date.now() - 60 * 60 * 1000,
      }];
    }
    return this.detectSRZones();
  }

  /** Part 2 test seam: call validateStructuralConditions() directly with synthetic features/settings, bypassing full analysis. */
  public validateStructuralConditionsForTest(
    signalType: SignalType,
    features: MarketFeatures,
    settings: { tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number },
    currentPrice: number
  ): { valid: boolean; reason?: string; tip?: string } {
    this.currentPrice = currentPrice;
    return this.validateStructuralConditions(signalType, features, settings);
  }

  /** Part 2 test seam: call computeRoomToSR() directly with synthetic features. */
  public computeRoomToSRForTest(signalType: SignalType, features: MarketFeatures, currentPrice: number): number {
    this.currentPrice = currentPrice;
    return this.computeRoomToSR(signalType, features);
  }

  private enhancedTransformerAnalysis(features: MarketFeatures): {
    signalStrength: number;
    signalType: SignalType;
    confidence: number;
    sentimentImpact: number;
    fibonacciAlignment: boolean;
    attentionScores: Map<string, number>;
  } {
    const now = new Date();
    const hour = now.getUTCHours();
    
    const isLondonSession = hour >= 6 && hour < 13;
    const isNYSession = hour >= 13 && hour < 21;
    
    const attentionScores = new Map<string, number>();
    let buySignalStrength = 0;
    let sellSignalStrength = 0;
    
    console.log('\n🔍 MULTI-TIMEFRAME ANALYSIS:');
    console.log('='.repeat(60));
    
    const htfTrend = this.detectHTFTrend(features);
    const ltfTrend = this.detectLTFTrend();
    const rsiOverbought = features.rsi > 70;
    const rsiOversold = features.rsi < 30;
    const rsiNeutralBullish = features.rsi >= 50 && features.rsi <= 70;
    const rsiNeutralBearish = features.rsi > 30 && features.rsi < 50;
    
    console.log(`📊 HTF Trend (Daily): ${htfTrend}`);
    console.log(`📈 LTF Trend (5min): ${ltfTrend}`);
    console.log(`📉 RSI: ${features.rsi.toFixed(1)} (Overbought: ${rsiOverbought}, Oversold: ${rsiOversold})`);
    
    // Phase 0: the HTF/LTF × RSI setups below are the RSI feature family. Each branch
    // is gated on RSI state, so the whole block's contribution is routed through the
    // learned `rsi_weight` modulation rather than being added as a fixed constant.
    let rsiBuyContribution = 0;
    let rsiSellContribution = 0;
    if (htfTrend === 'BULLISH') {
      if (ltfTrend === 'BULLISH' && !rsiOverbought) {
        rsiBuyContribution += 0.4;
        attentionScores.set('htf_ltf_bullish_alignment', 0.4);
        console.log('✅ BUY: HTF + LTF Bullish Alignment');
      }
      
      if (rsiOversold || (rsiNeutralBearish && ltfTrend === 'BEARISH')) {
        rsiBuyContribution += 0.35;
        attentionScores.set('counter_trend_bounce_setup', 0.35);
        console.log('✅ BUY: Counter-trend Bounce Setup (Oversold in Uptrend)');
      }
      
      if (rsiOverbought && ltfTrend === 'BEARISH') {
        rsiSellContribution += 0.3;
        attentionScores.set('intraday_correction_in_uptrend', 0.3);
        console.log('🔴 SELL: Intraday Correction Setup (Overbought + LTF Bearish)');
      }
    } else if (htfTrend === 'BEARISH') {
      if (ltfTrend === 'BEARISH' && !rsiOversold) {
        rsiSellContribution += 0.4;
        attentionScores.set('htf_ltf_bearish_alignment', 0.4);
        console.log('🔴 SELL: HTF + LTF Bearish Alignment');
      }
      
      if (rsiOverbought || (rsiNeutralBullish && ltfTrend === 'BULLISH')) {
        rsiSellContribution += 0.35;
        attentionScores.set('counter_trend_rejection_setup', 0.35);
        console.log('🔴 SELL: Counter-trend Rejection Setup (Overbought in Downtrend)');
      }
      
      if (rsiOversold && ltfTrend === 'BULLISH') {
        rsiBuyContribution += 0.3;
        attentionScores.set('intraday_bounce_in_downtrend', 0.3);
        console.log('✅ BUY: Intraday Bounce Setup (Oversold + LTF Bullish)');
      }
    } else {
      if (rsiOverbought && ltfTrend === 'BEARISH') {
        rsiSellContribution += 0.35;
        attentionScores.set('neutral_htf_overbought_sell', 0.35);
        console.log('🔴 SELL: Neutral HTF - Overbought Mean Reversion');
      }
      
      if (rsiOversold && ltfTrend === 'BULLISH') {
        rsiBuyContribution += 0.35;
        attentionScores.set('neutral_htf_oversold_buy', 0.35);
        console.log('✅ BUY: Neutral HTF - Oversold Mean Reversion');
      }
      
      if (ltfTrend === 'BULLISH' && !rsiOverbought) {
        rsiBuyContribution += 0.25;
        attentionScores.set('ltf_momentum_buy', 0.25);
        console.log('✅ BUY: LTF Momentum (Neutral HTF)');
      }
      
      if (ltfTrend === 'BEARISH' && !rsiOversold) {
        rsiSellContribution += 0.25;
        attentionScores.set('ltf_momentum_sell', 0.25);
        console.log('🔴 SELL: LTF Momentum (Neutral HTF)');
      }
    }

    // PHASE 2 (C1): the learned RSI multiplier is capped, and what gets recorded
    // in attentionScores is the actual CONTRIBUTION rather than the raw
    // multiplier. Pre-fix, this single entry was logged at 1.09-1.71 while every
    // other feature sat at 0.01-0.38, so it mechanically owned the top-feature
    // ranking - despite its measured marginal EV being negative (present
    // +0.029R vs absent +0.128R, and -0.009R once the multiplier passed 1.50).
    const rawRsiModulation = this.getFeatureModulation('rsi_weight');
    const rsiModulation = Math.min(rawRsiModulation, RSI_MODULATION_APPLIED_MAX);
    buySignalStrength += rsiBuyContribution * rsiModulation;
    sellSignalStrength += rsiSellContribution * rsiModulation;
    if (rsiBuyContribution > 0 || rsiSellContribution > 0) {
      const rsiContribution = Math.max(rsiBuyContribution, rsiSellContribution) * rsiModulation;
      attentionScores.set('rsi_learned_modulation', parseFloat(rsiContribution.toFixed(4)));
      if (rawRsiModulation > rsiModulation) {
        console.log(`🧠 Learned RSI modulation CAPPED ${rawRsiModulation.toFixed(3)} → x${rsiModulation.toFixed(3)} (max ${RSI_MODULATION_APPLIED_MAX})`);
      }
      console.log(`🧠 Learned RSI modulation x${rsiModulation.toFixed(3)} → BUY+${(rsiBuyContribution * rsiModulation).toFixed(3)} SELL+${(rsiSellContribution * rsiModulation).toFixed(3)} (raw BUY+${rsiBuyContribution.toFixed(2)} SELL+${rsiSellContribution.toFixed(2)}, attention records contribution ${rsiContribution.toFixed(3)})`);
    }
    
    if (isLondonSession || isNYSession) {
      attentionScores.set('high_liquidity_session', 0.10);
      console.log(`✅ High Liquidity Session (${isLondonSession ? 'LONDON' : 'NY'}) - context factor, not directional boost`);
    }
    
    // C12: Trend feature stack capped at 0.50 combined contribution
    let trendBuyContribution = 0;
    let trendSellContribution = 0;
    if (features.marketRegime.type === 'TRENDING' && features.marketRegime.strength > 0.75) {
      if (htfTrend === 'BULLISH' && ltfTrend === 'BULLISH') {
        trendBuyContribution += 0.15;
        attentionScores.set('strong_uptrend', 0.15);
        console.log('✅ BUY: Strong Uptrend Confirmed');
      } else if (htfTrend === 'BEARISH' && ltfTrend === 'BEARISH') {
        trendSellContribution += 0.15;
        attentionScores.set('strong_downtrend', 0.15);
        console.log('🔴 SELL: Strong Downtrend Confirmed');
      }
    } else if (features.marketRegime.type === 'VOLATILE') {
      attentionScores.set('volatile_regime_context', 0.03);
    }
    if (features.priceActionPattern === 'BULLISH_REVERSAL') {
      trendBuyContribution += 0.12;
      attentionScores.set('bullish_reversal', 0.12);
    } else if (features.priceActionPattern === 'BEARISH_REVERSAL') {
      trendSellContribution += 0.12;
      attentionScores.set('bearish_reversal', 0.12);
    } else if (features.priceActionPattern === 'STRONG_UPTREND') {
      trendBuyContribution += 0.10;
      attentionScores.set('strong_uptrend_pattern', 0.10);
    } else if (features.priceActionPattern === 'STRONG_DOWNTREND') {
      trendSellContribution += 0.10;
      attentionScores.set('strong_downtrend_pattern', 0.10);
    }
    if (features.candlestickPattern === 'BULLISH_ENGULFING') {
      trendBuyContribution += 0.12;
      attentionScores.set('bullish_engulfing', 0.12);
      console.log('✅ BUY: Bullish Engulfing Candle');
    } else if (features.candlestickPattern === 'BEARISH_ENGULFING') {
      trendSellContribution += 0.12;
      attentionScores.set('bearish_engulfing', 0.12);
      console.log('🔴 SELL: Bearish Engulfing Candle');
    } else if (features.candlestickPattern === 'BULLISH_PIN_BAR') {
      trendBuyContribution += 0.09;
      attentionScores.set('bullish_pin_bar', 0.09);
      console.log('✅ BUY: Bullish Pin Bar');
    } else if (features.candlestickPattern === 'BEARISH_PIN_BAR') {
      trendSellContribution += 0.09;
      attentionScores.set('bearish_pin_bar', 0.09);
      console.log('🔴 SELL: Bearish Pin Bar');
    } else if (features.candlestickPattern === 'DOJI') {
      attentionScores.set('doji_context', 0);
    }
    const TREND_STACK_CAP = 0.50;
    trendBuyContribution = Math.min(trendBuyContribution, TREND_STACK_CAP);
    trendSellContribution = Math.min(trendSellContribution, TREND_STACK_CAP);
    buySignalStrength += trendBuyContribution;
    sellSignalStrength += trendSellContribution;
    if (trendBuyContribution > 0 || trendSellContribution > 0) {
      console.log(`📊 Trend Stack (capped ${TREND_STACK_CAP}): BUY+${trendBuyContribution.toFixed(2)} SELL+${trendSellContribution.toFixed(2)}`);
    }
    
    if (features.supportStrength > 0.8) {
      buySignalStrength += 0.10;
      attentionScores.set('strong_support_proximity', 0.10);
      console.log('✅ BUY: Strong Support Proximity');
    }
    
    if (features.resistanceStrength > 0.8) {
      sellSignalStrength += 0.10;
      attentionScores.set('strong_resistance_proximity', 0.10);
      console.log('🔴 SELL: Strong Resistance Proximity');
    }

    const srReaction = this.detectActiveSRReaction(features);
    if (srReaction && srReaction.confirmed) {
      features.activeSRReaction = srReaction;
      if (srReaction.zone.type === 'SUPPORT') {
        buySignalStrength += srReaction.strength;
        attentionScores.set(`sr_zone_${srReaction.reactionType.toLowerCase()}`, srReaction.strength);
        console.log(`✅ BUY: S/R Zone ${srReaction.reactionType} @ ${srReaction.zone.price.toFixed(1)} (+${(srReaction.strength * 100).toFixed(1)}%)`);
      } else {
        sellSignalStrength += srReaction.strength;
        attentionScores.set(`sr_zone_${srReaction.reactionType.toLowerCase()}`, srReaction.strength);
        console.log(`🔴 SELL: S/R Zone ${srReaction.reactionType} @ ${srReaction.zone.price.toFixed(1)} (+${(srReaction.strength * 100).toFixed(1)}%)`);
      }

      if (srReaction.zone.touches >= 3 && srReaction.zone.rejectionWicks >= 2) {
        const multiTouchBonus = 0.08;
        if (srReaction.zone.type === 'SUPPORT') {
          buySignalStrength += multiTouchBonus;
          attentionScores.set('multi_touch_sr_confirmation', multiTouchBonus);
        } else {
          sellSignalStrength += multiTouchBonus;
          attentionScores.set('multi_touch_sr_confirmation', multiTouchBonus);
        }
        console.log(`   🔥 Multi-touch S/R Confirmation: ${srReaction.zone.touches} touches, ${srReaction.zone.rejectionWicks} rejection wicks (+${(multiTouchBonus * 100).toFixed(0)}%)`);
      }
    }
    
    // C13: Self-referential sentiment feature removed. Kept for telemetry only.
    const sentimentImpact = 0;
    if (features.sentiment && Math.abs(features.sentiment.score) > 0.3) {
      console.log(`ℹ️ Sentiment ${features.sentiment.score.toFixed(2)} noted as telemetry only (no directional boost)`);
    }
    
    const fibRetracementLevels = features.fibonacci
      .filter(f => f.type === "retracement")
      .map(f => f.price);
    
    const nearFibLevel = fibRetracementLevels.some(
      price => Math.abs(this.currentPrice - price) < 5
    );
    
    const fibonacciAlignment = nearFibLevel;
    if (fibonacciAlignment) {
      const fibDirectionalBoost = 0.08;
      if (buySignalStrength > sellSignalStrength) {
        buySignalStrength += fibDirectionalBoost;
      } else if (sellSignalStrength > buySignalStrength) {
        sellSignalStrength += fibDirectionalBoost;
      }
      attentionScores.set('fibonacci_alignment', fibDirectionalBoost);
      console.log(`✅ Price near Fibonacci Level (+${(fibDirectionalBoost * 100).toFixed(0)}% to dominant direction only)`);
    }
    
    if (features.emaCrossover > 0.5) {
      buySignalStrength += 0.08;
      attentionScores.set('bullish_ema_crossover', 0.08);
      console.log('✅ BUY: Bullish EMA Crossover');
    } else if (features.emaCrossover < -0.5) {
      sellSignalStrength += 0.08;
      attentionScores.set('bearish_ema_crossover', 0.08);
      console.log('🔴 SELL: Bearish EMA Crossover');
    }
    
    if (features.macdHistogram > 0.3) {
      buySignalStrength += 0.07;
      attentionScores.set('bullish_macd_momentum', 0.07);
      console.log('✅ BUY: Bullish MACD Momentum');
    } else if (features.macdHistogram < -0.3) {
      sellSignalStrength += 0.07;
      attentionScores.set('bearish_macd_momentum', 0.07);
      console.log('🔴 SELL: Bearish MACD Momentum');
    }

    if (features.vwap !== null) {
      const vwapDelta = this.currentPrice - features.vwap;
      if (vwapDelta > 1.5) {
        buySignalStrength += 0.05;
        attentionScores.set('above_vwap', 0.05);
        console.log(`✅ BUY: Price ${vwapDelta.toFixed(1)} above VWAP (${features.vwap.toFixed(1)})`);
      } else if (vwapDelta < -1.5) {
        sellSignalStrength += 0.05;
        attentionScores.set('below_vwap', 0.05);
        console.log(`🔴 SELL: Price ${Math.abs(vwapDelta).toFixed(1)} below VWAP (${features.vwap.toFixed(1)})`);
      }
    }

    if (features.adx !== null) {
      if (features.adx > 25) {
        const adxBoost = Math.min(0.08, (features.adx - 25) * 0.003);
        if (htfTrend === 'BULLISH' && ltfTrend === 'BULLISH') {
          buySignalStrength += adxBoost;
          attentionScores.set('adx_trend_strength', adxBoost);
          console.log(`✅ ADX ${features.adx.toFixed(1)} confirms uptrend (+${(adxBoost * 100).toFixed(1)}%)`);
        } else if (htfTrend === 'BEARISH' && ltfTrend === 'BEARISH') {
          sellSignalStrength += adxBoost;
          attentionScores.set('adx_trend_strength', adxBoost);
          console.log(`🔴 ADX ${features.adx.toFixed(1)} confirms downtrend (+${(adxBoost * 100).toFixed(1)}%)`);
        }
      } else if (features.adx < 18) {
        console.log(`ℹ️ Low ADX ${features.adx.toFixed(1)} - weak trend regime`);
      }
    }

    if (features.bollingerSqueeze && features.marketRegime.type === 'QUIET') {
      const breakoutBias = this.detectPriceDirection();
      if (breakoutBias > 0) {
        buySignalStrength += 0.08;
        attentionScores.set('bollinger_squeeze_bull_breakout', 0.08);
        console.log('✅ BUY: Bollinger Squeeze + Bullish Breakout');
      } else if (breakoutBias < 0) {
        sellSignalStrength += 0.08;
        attentionScores.set('bollinger_squeeze_bear_breakout', 0.08);
        console.log('🔴 SELL: Bollinger Squeeze + Bearish Breakout');
      }
    }
    if (features.bollingerExpansion) {
      attentionScores.set('bollinger_expansion', 0.03);
    }

    // C17: DXY correlation gate for LONG gold
    // Phase 0: the headwind penalty is scaled by the learned `dxy_weight` (magnitude
    // only, clamped ≥0) so a feature that has proven predictive applies a stronger
    // penalty, and one that has drifted to zero applies none.
    const dxy = features.intermarketData;
    const dxyModulation = Math.max(0, this.getFeatureModulation('dxy_weight'));
    if (dxy && dxy.dxyChange !== 0 && dxy.goldDxyCorrelation < -0.3) {
      if (dxy.dxyChange > 0.15 && buySignalStrength > sellSignalStrength) {
        const dxyPenalty = Math.min(0.12, dxy.dxyChange * 0.5) * dxyModulation;
        buySignalStrength = Math.max(0, buySignalStrength - dxyPenalty);
        attentionScores.set('dxy_headwind', -dxyPenalty);
        console.log(`⚠️ DXY +${dxy.dxyChange.toFixed(2)} rising vs LONG gold bias: -${(dxyPenalty * 100).toFixed(1)}% (learned x${dxyModulation.toFixed(2)})`);
      } else if (dxy.dxyChange < -0.15 && sellSignalStrength > buySignalStrength) {
        const dxyPenalty = Math.min(0.12, Math.abs(dxy.dxyChange) * 0.5) * dxyModulation;
        sellSignalStrength = Math.max(0, sellSignalStrength - dxyPenalty);
        attentionScores.set('dxy_headwind', -dxyPenalty);
        console.log(`⚠️ DXY ${dxy.dxyChange.toFixed(2)} falling vs SHORT gold bias: -${(dxyPenalty * 100).toFixed(1)}% (learned x${dxyModulation.toFixed(2)})`);
      }
    }
    
    
    const bearishDivergence = this.detectBearishDivergence(features);
    const bullishDivergence = this.detectBullishDivergence(features);
    
    if (bearishDivergence) {
      sellSignalStrength += 0.20;
      attentionScores.set('bearish_divergence', 0.20);
      console.log('🔴 SELL: Bearish Divergence Detected');
    }
    
    if (bullishDivergence) {
      buySignalStrength += 0.20;
      attentionScores.set('bullish_divergence', 0.20);
      console.log('✅ BUY: Bullish Divergence Detected');
    }
    
    const nearBullishQM = features.quasimodolLevels.some(
      qm => qm.type === 'BULLISH_QM' && Math.abs(this.currentPrice - qm.price) < 8
    );
    if (nearBullishQM) {
      buySignalStrength += 0.18;
      attentionScores.set('bullish_quasimodo', 0.18);
      console.log('✅ BUY: Near Bullish Quasimodo Level (Institutional Trap Zone)');
    }
    
    const nearBearishQM = features.quasimodolLevels.some(
      qm => qm.type === 'BEARISH_QM' && Math.abs(this.currentPrice - qm.price) < 8
    );
    if (nearBearishQM) {
      sellSignalStrength += 0.18;
      attentionScores.set('bearish_quasimodo', 0.18);
      console.log('🔴 SELL: Near Bearish Quasimodo Level (Institutional Trap Zone)');
    }
    
    const confirmedLowSweep = features.sessionSweeps.find(
      sweep => sweep.type === 'LOW_SWEEP' && sweep.reversalConfirmed
    );
    if (confirmedLowSweep) {
      buySignalStrength += 0.35 * confirmedLowSweep.strength; // Increased for high accuracy
      attentionScores.set('session_low_sweep', 0.35);
      console.log(`✅ BUY: ${confirmedLowSweep.sessionType} Session Low Sweep Confirmed (High Accuracy Setup)`);
      console.log(`   Sweep @ ${confirmedLowSweep.sweepPrice.toFixed(1)} - Reversal confirmed`);
    }
    
    const confirmedHighSweep = features.sessionSweeps.find(
      sweep => sweep.type === 'HIGH_SWEEP' && sweep.reversalConfirmed
    );
    if (confirmedHighSweep) {
      sellSignalStrength += 0.35 * confirmedHighSweep.strength; // Increased for high accuracy
      attentionScores.set('session_high_sweep', 0.35);
      console.log(`🔴 SELL: ${confirmedHighSweep.sessionType} Session High Sweep Confirmed (High Accuracy Setup)`);
      console.log(`   Sweep @ ${confirmedHighSweep.sweepPrice.toFixed(1)} - Reversal confirmed`);
    }

    // STEP 4: De-correlate synthetic microstructure features (order-flow proxy,
    // volume-profile histogram). Both are derived from the SAME raw price series as
    // RSI/trend/EMA/MACD above (there is no real tick/volume feed), so if a momentum
    // feature has already fired in the same analysis pass, order-flow/volume-node
    // "confirmation" is a redundant re-expression of that signal, not new evidence.
    // Redundancy is down-weighted to near-zero unless a genuine structural signal
    // (a confirmed session-range sweep, checked here now that sweeps are resolved) is
    // also present. HTF/LTF trend alignment does NOT count as structural confirmation
    // here - it's the same momentum family, not an order-block/sweep-level event.
    const momentumAlreadyCounted = [
      'htf_ltf_bullish_alignment', 'htf_ltf_bearish_alignment',
      'ltf_momentum_buy', 'ltf_momentum_sell',
      'strong_uptrend', 'strong_downtrend',
      'bullish_ema_crossover', 'bearish_ema_crossover',
      'bullish_macd_momentum', 'bearish_macd_momentum',
      'rsi_learned_modulation',
    ].some(k => attentionScores.has(k));
    const hasStructuralConfirmation = attentionScores.has('session_low_sweep') || attentionScores.has('session_high_sweep');
    const microstructureRedundancyFactor = hasStructuralConfirmation ? 1.0 : (momentumAlreadyCounted ? 0.25 : 1.0);
    const microstructureDownWeighted = momentumAlreadyCounted && !hasStructuralConfirmation;

    if (features.orderFlow.largeOrdersDetected) {
      const orderFlowWeight = parseFloat((0.02 * microstructureRedundancyFactor).toFixed(4));
      attentionScores.set('order_flow_context', orderFlowWeight);
      console.log(`ℹ️ Order Flow context only (synthetic, no directional boost): imbalance ${(features.orderFlow.volumeImbalance * 100).toFixed(1)}% | weight ${orderFlowWeight.toFixed(3)}${microstructureDownWeighted ? ' (down-weighted: redundant with momentum already counted)' : ''}`);
    }

    const nearHighVolumeNode = features.volumeProfile.highVolumeNodes.some(
      node => Math.abs(this.currentPrice - node) < 3
    );
    if (nearHighVolumeNode) {
      const volumeNodeWeight = parseFloat((0.05 * microstructureRedundancyFactor).toFixed(4));
      attentionScores.set('volume_node_support_resistance', volumeNodeWeight);
      console.log(`ℹ️ Price near High Volume Node (context only, no directional boost) | weight ${volumeNodeWeight.toFixed(3)}${microstructureDownWeighted ? ' (down-weighted: redundant with momentum already counted)' : ''}`);
    }

    console.log('\n📊 SIGNAL STRENGTH COMPARISON:');
    console.log(`   BUY Strength: ${buySignalStrength.toFixed(3)}`);
    console.log(`   SELL Strength: ${sellSignalStrength.toFixed(3)}`);
    console.log('='.repeat(60) + '\n');
    
    const winningStrength = Math.max(buySignalStrength, sellSignalStrength);
    const strengthDifference = Math.abs(buySignalStrength - sellSignalStrength);
    
    console.log('\n🔍 BIDIRECTIONAL CONFLICT PREVENTION:');
    console.log(`   Winning Strength: ${winningStrength.toFixed(3)} (Min: ${MIN_SIGNAL_CONVICTION_THRESHOLD})`);
    console.log(`   Strength Difference: ${strengthDifference.toFixed(3)} (Base Min: ${MIN_SIGNAL_STRENGTH_DIFFERENCE_BASE})`);
    
    if (winningStrength < MIN_SIGNAL_CONVICTION_THRESHOLD) {
      console.log(`\n❌ REJECTED: Winning strength ${winningStrength.toFixed(3)} below conviction threshold ${MIN_SIGNAL_CONVICTION_THRESHOLD}`);
      console.log('   Market shows no clear directional bias');
      console.log('   Status: NEUTRAL / STAND DOWN');
      console.log('='.repeat(60) + '\n');
      return {
        signalStrength: 0,
        signalType: "BUY",
        confidence: winningStrength,
        sentimentImpact: 0,
        fibonacciAlignment: false,
        attentionScores,
      };
    }
    
    const adaptiveAdjust = this.getAdaptiveDiffAdjustment(features.marketRegime.type);
    const regimeMinDiff = Math.max(0.04, getMinStrengthDifferenceForRegime(features.marketRegime.type) + adaptiveAdjust);
    if (adaptiveAdjust !== 0) {
      console.log(`📉 Adaptive diff gate: ${adaptiveAdjust.toFixed(3)} (low-bucket EV positive)`);
    }
    if (strengthDifference < regimeMinDiff) {
      console.log(`\n❌ REJECTED: Strength difference ${strengthDifference.toFixed(3)} too small (regime ${features.marketRegime.type} min: ${regimeMinDiff})`);
      console.log(`   BUY: ${buySignalStrength.toFixed(3)} vs SELL: ${sellSignalStrength.toFixed(3)}`);
      console.log('   Market indecision detected - prevents conflicting signals');
      console.log('   Status: NEUTRAL / STAND DOWN');
      console.log('='.repeat(60) + '\n');
      return {
        signalStrength: 0,
        signalType: "BUY",
        confidence: winningStrength,
        sentimentImpact: 0,
        fibonacciAlignment: false,
        attentionScores,
      };
    }
    
    const isBullish = buySignalStrength > sellSignalStrength;
    const signalStrength = isBullish ? buySignalStrength : sellSignalStrength;
    
    console.log(`\n✅ CONFLICT CHECK PASSED:`);
    console.log(`   Direction: ${isBullish ? 'BUY' : 'SELL'}`);
    console.log(`   Winning Strength: ${signalStrength.toFixed(3)}`);
    console.log(`   Losing Strength: ${(isBullish ? sellSignalStrength : buySignalStrength).toFixed(3)}`);
    console.log(`   Conviction: ${strengthDifference.toFixed(3)} (Clear directional bias)`);
    console.log('='.repeat(60) + '\n');
    
    if (strengthDifference < 0.15) {
      console.log(`⚠️ WARNING: Moderate conviction (difference: ${(strengthDifference * 100).toFixed(1)}%)`);
      console.log('   Signal allowed but confidence may be reduced');
    }
    
    // Proposal #4: Scale confidence with alignment count
    const alignmentKeys = [
      'htf_ltf_bullish_alignment', 'htf_ltf_bearish_alignment',
      'strong_uptrend', 'strong_downtrend',
      'strong_uptrend_pattern', 'strong_downtrend_pattern',
      'bullish_ema_crossover', 'bearish_ema_crossover',
      'adx_trend_strength',
      'above_vwap', 'below_vwap',
    ];
    const alignmentCount = alignmentKeys.reduce((acc, k) => acc + (attentionScores.has(k) ? 1 : 0), 0);
    const dxyAligned = (
      features.intermarketData &&
      ((isBullish && features.intermarketData.dxyChange < -0.05) ||
       (!isBullish && features.intermarketData.dxyChange > 0.05))
    ) ? 1 : 0;
    const totalAlignment = alignmentCount + dxyAligned;
    const alignmentBonus = Math.min(0.18, totalAlignment * 0.03);
    let baseConfidence = 0.40 + signalStrength * 0.40 + alignmentBonus;
    if (alignmentBonus > 0) {
      console.log(`🧩 Alignment bonus: +${(alignmentBonus * 100).toFixed(1)}% (${totalAlignment} confluence factors)`);
    }
    
    baseConfidence += Math.abs(sentimentImpact) * 0.05;
    
    if (fibonacciAlignment) {
      baseConfidence += 0.04;
    }

    if (features.activeSRReaction && features.activeSRReaction.confirmed) {
      const srConfBoost = features.activeSRReaction.strength * 0.15;
      baseConfidence += srConfBoost;
      console.log(`🎯 S/R Zone Reaction Confidence Boost: +${(srConfBoost * 100).toFixed(1)}% (${features.activeSRReaction.reactionType} @ ${features.activeSRReaction.zone.price.toFixed(1)})`);
    }
    
    if (features.marketRegime.confidence > 0.85) {
      baseConfidence += 0.02;
    }
    
    const timeBoost = (features.timeWindowFactor - 1.0) * 0.04;
    baseConfidence += timeBoost;
    
    if (timeBoost > 0) {
      console.log(`⏰ Time Window Boost: +${(timeBoost * 100).toFixed(1)}% confidence (Factor: ${features.timeWindowFactor.toFixed(1)}x)`);
    }
    
    const learningAdjustment = Math.max(-MAX_LEARNING_ADJUSTMENT, Math.min(MAX_LEARNING_ADJUSTMENT, (this.performanceMetrics.profitFactor - 1.5) * 0.06));
    baseConfidence += learningAdjustment;
    
    if (strengthDifference < 0.12) {
      baseConfidence *= 0.85;
      console.log(`⚠️ Weak directional conviction (<12%) - Confidence reduced by 15%`);
    } else if (strengthDifference < 0.18) {
      baseConfidence *= 0.94;
      console.log(`⚠️ Moderate directional conviction (<18%) - Confidence reduced by 6%`);
    }
    
    const losingStrength = isBullish ? sellSignalStrength : buySignalStrength;
    // Proposal #13: Skip losing-strength penalty when winning side is very strong (>0.75) - opposing is noise
    if (losingStrength > 0.3 && signalStrength <= 0.75) {
      const conflictPenalty = losingStrength * 0.12;
      baseConfidence -= conflictPenalty;
      console.log(`⚠️ Opposing signal strength penalty: -${(conflictPenalty * 100).toFixed(1)}% (opposing: ${(losingStrength * 100).toFixed(1)}%)`);
    } else if (losingStrength > 0.3) {
      console.log(`ℹ️ Skipping opposing penalty - winning strength ${signalStrength.toFixed(2)} > 0.75 (opposing treated as noise)`);
    }
    
    let dataQualityPenalty = 0;
    if (this.ohlcDataSource === 'estimated') {
      dataQualityPenalty += 0.06;
      console.log(`⚠️ Estimated OHLC penalty: -6.0% (no real H/L available)`);
    } else if (this.ohlcDataSource === '5min-candles') {
      dataQualityPenalty += 0.02;
      console.log(`⚠️ 5-min synthesized OHLC penalty: -2.0%`);
    }
    if (this.priceHistory.length < 30) {
      dataQualityPenalty += 0.02;
      console.log(`⚠️ Low sample count penalty: -2.0% (only ${this.priceHistory.length} samples)`);
    }
    
    let rawConfidence = Math.max(0.45, Math.min(MAX_CONFIDENCE_CAP, baseConfidence - dataQualityPenalty));
    let calibrationPenalty = 0;

    if (strengthDifference < 0.25) calibrationPenalty += 0.04;
    if (signalStrength < 0.74) calibrationPenalty += 0.02;
    if (features.marketRegime.confidence < 0.7) calibrationPenalty += 0.02;
    if (losingStrength > 0.22) calibrationPenalty += 0.02;
    if (this.priceHistory.length < 60) calibrationPenalty += 0.01;

    calibrationPenalty = Math.min(calibrationPenalty, MAX_CALIBRATION_PENALTY);

    // PHASE 2 (C4): direction-bucketed calibration. The penalties above are
    // direction-agnostic, so a book where one side earns +0.695R and the other
    // loses -0.349R was calibrated as if both sides were the same system. This
    // adds a separate, evidence-driven penalty applied ONLY to the side whose
    // own realised expectancy is negative over a sufficient sample.
    const candidateDirection: 'BUY' | 'SELL' = isBullish ? 'BUY' : 'SELL';
    const directionPenalty = this.getDirectionalCalibrationPenalty(candidateDirection);
    if (directionPenalty > 0) {
      const bucket = this.directionalExpectancy[candidateDirection];
      console.log(`⚠️ Direction calibration penalty (${candidateDirection}): -${(directionPenalty * 100).toFixed(1)}% (own realised EV ${bucket.meanR.toFixed(3)}R over n=${bucket.n})`);
    }

    if (calibrationPenalty > 0) {
      console.log(`⚠️ Calibration penalty (capped at ${(MAX_CALIBRATION_PENALTY * 100).toFixed(0)}%): -${(calibrationPenalty * 100).toFixed(1)}%`);
    }
    calibrationPenalty += directionPenalty;

    rawConfidence = Math.max(0.42, Math.min(MAX_CONFIDENCE_CAP, rawConfidence - calibrationPenalty));
    
    console.log(`📊 Confidence Breakdown: base=${(0.40 + signalStrength * 0.40).toFixed(3)}, alignment=+${alignmentBonus.toFixed(3)}, bonuses=${(baseConfidence - 0.40 - signalStrength * 0.40 - alignmentBonus).toFixed(3)}, penalties=-${dataQualityPenalty.toFixed(3)}, calibration=-${calibrationPenalty.toFixed(3)}, raw=${rawConfidence.toFixed(3)}`);
    this.lastSignalStrengthDifference = strengthDifference;
    
    const smoothedConfidence = this.smoothConfidence(rawConfidence);
    
    console.log('📊 Attention Scores:', Array.from(attentionScores.entries()).map(([k, v]) => `${k}: ${v.toFixed(2)}`).join(', '));
    
    console.log(`\n🎯 FINAL DECISION: ${isBullish ? 'BUY' : 'SELL'} Signal`);
    console.log(`   Strength: ${signalStrength.toFixed(3)}`);
    console.log(`   Confidence: ${(smoothedConfidence * 100).toFixed(1)}%`);
    console.log(`   Direction Conviction: ${(strengthDifference * 100).toFixed(1)}%\n`);
    
    return {
      signalStrength: Math.max(0, Math.min(1, signalStrength)),
      signalType: isBullish ? "BUY" : "SELL",
      confidence: parseFloat(smoothedConfidence.toFixed(2)),
      sentimentImpact: parseFloat(sentimentImpact.toFixed(2)),
      fibonacciAlignment,
      attentionScores,
    };
  }
  
  /**
   * Phase B1 fix: detectHTFTrend now uses GENUINELY higher-timeframe data
   * (daily OHLC bars from dailyOHLCHistory) instead of tick-level
   * priceHistory. The previous version was 67% tick-level (20-tick trend
   * strength + 9/21-tick EMAs), which meant a short counter-trend bounce
   * on a downtrend day could return BULLISH — the root cause of the 31 July
   * losses where 3 of 4 losing BUYs scored "STRONG UPTREND" on a -401 pip day.
   *
   * Scoring (all components now daily-bar-based):
   * 1. priceVsPivot: current price vs daily pivot (unchanged — was already HTF)
   * 2. developingDayDirection: current trading day's close vs its open.
   *    A >20 pip move from open contributes ±1.0; a >50 pip move contributes
   *    ±1.5 (a strong intraday directional move is a genuine HTF signal —
   *    the developing day's OHLC is tracked from the session open, not from
   *    tick-level noise). This is the component that catches a clear bearish
   *    day even when completed daily bars are V-shaped (as on 31 July, where
   *    28→29→30 were lower-lower-higher but the developing day dropped -480
   *    pips from open).
   * 3. dailyTrendDirection: last 3 completed daily bars' closes
   *    (higher-highs+higher-closes = BULLISH, lower-lows+lower-closes = BEARISH)
   * 4. dailyEMA: EMA5 vs EMA10 on daily bar closes
   *    (genuine daily-timescale momentum, not tick-level)
   *
   * BULLISH/BEARISH requires score >= 1.5. A strong developing-day move
   * (>50 pips) can trigger the signal by itself; a moderate move (>20 pips)
   * needs corroboration from at least one other component.
   */
  private detectHTFTrend(features: MarketFeatures): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const priceVsPivot = this.currentPrice - features.dailyPivot;

    // Component 1: price vs daily pivot (genuinely HTF — unchanged)
    const pivotBullish = priceVsPivot > 10 ? 1 : 0;
    const pivotBearish = priceVsPivot < -10 ? 1 : 0;

    // Component 2: developing trading day direction (genuinely HTF — the
    // current day's OHLC tracked from session open, not tick-level).
    // Uses this.currentDayOHLC which is updated on every price tick via
    // updateDailyOHLC(). devMove is in DOLLARS (e.g., -47.6 = -$47.6).
    // For gold, 1 pip = $0.1, so 50 pips = $5.00, 20 pips = $2.00.
    // A >$2.00 (20 pip) move from open = ±1.0, >$5.00 (50 pip) = ±1.5.
    let developingDayBullish = 0;
    let developingDayBearish = 0;
    if (this.currentDayOHLC) {
      const devMove = this.currentDayOHLC.close - this.currentDayOHLC.open;
      const DEV_DAY_MODERATE_DOLLARS = 2.0; // 20 pips
      const DEV_DAY_STRONG_DOLLARS = 5.0;   // 50 pips
      if (devMove > DEV_DAY_STRONG_DOLLARS) {
        developingDayBullish = 1.5;
      } else if (devMove > DEV_DAY_MODERATE_DOLLARS) {
        developingDayBullish = 1.0;
      } else if (devMove < -DEV_DAY_STRONG_DOLLARS) {
        developingDayBearish = 1.5;
      } else if (devMove < -DEV_DAY_MODERATE_DOLLARS) {
        developingDayBearish = 1.0;
      }
    }

    // Component 3: multi-day trend direction from completed daily bars.
    // Requires at least 3 completed daily bars to determine trend.
    const sortedDailyBars = [...this.dailyOHLCHistory]
      .sort((left, right) => left.timestamp - right.timestamp)
      .filter((bar) => bar.timestamp < Date.now()); // completed bars only

    let dailyTrendBullish = 0;
    let dailyTrendBearish = 0;
    if (sortedDailyBars.length >= 3) {
      const recent3 = sortedDailyBars.slice(-3);
      const [bar1, bar2, bar3] = recent3;
      const higherHighs = bar3.high > bar2.high && bar2.high > bar1.high;
      const higherCloses = bar3.close > bar2.close && bar2.close > bar1.close;
      const lowerLows = bar3.low < bar2.low && bar2.low < bar1.low;
      const lowerCloses = bar3.close < bar2.close && bar2.close < bar1.close;

      if (higherHighs && higherCloses) {
        dailyTrendBullish = 1;
      } else if (lowerLows && lowerCloses) {
        dailyTrendBearish = 1;
      }
    }

    // Component 4: daily-timescale EMA crossover (EMA5 vs EMA10 on daily closes).
    // This replaces the old tick-level EMA9 vs EMA21 — same structural idea but
    // on the correct timescale. Requires at least 10 daily bars.
    let dailyEmaBullish = 0;
    let dailyEmaBearish = 0;
    if (sortedDailyBars.length >= 10) {
      const dailyCloses = sortedDailyBars.map((bar) => bar.close);
      const ema5 = this.calculateEMA(dailyCloses, 5);
      const ema10 = this.calculateEMA(dailyCloses, 10);
      if (ema5 > ema10) {
        dailyEmaBullish = 0.5;
      } else if (ema5 < ema10) {
        dailyEmaBearish = 0.5;
      }
    }

    const bullishScore = pivotBullish + developingDayBullish + dailyTrendBullish + dailyEmaBullish;
    const bearishScore = pivotBearish + developingDayBearish + dailyTrendBearish + dailyEmaBearish;

    if (bullishScore >= 1.5) {
      return 'BULLISH';
    } else if (bearishScore >= 1.5) {
      return 'BEARISH';
    } else {
      return 'NEUTRAL';
    }
  }
  
  private detectLTFTrend(): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    if (this.priceHistory.length < 5) return 'NEUTRAL';
    
    const recent5 = this.priceHistory.slice(-5);
    const avg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
    const currentPrice = this.currentPrice;
    
    const momentum = currentPrice - avg;
    const volatility = this.calculateRealTimeVolatility();
    // Bug fix: the previous flat $0.80 floor / $2.50 cap was calibrated for a
    // coarser momentum window than this function actually measures (current
    // price vs. a 5-tick/~2.5min average). Investigation showed volatility
    // pinned at its own floor (0.5) in the vast majority of real attempts,
    // which meant momentumThreshold was ALWAYS pinned to the 0.80 floor too -
    // while genuine momentum in this short window tops out around 0.15-0.30
    // even during confirmed 90%+ strength TRENDING regimes, so the floor was
    // structurally unreachable and the classifier always fell back to NEUTRAL.
    // Rescaled price-relative (matching the Math.max(atr/price-relative, ...)
    // convention already used elsewhere in this file) so floor/cap scale with
    // the actual price level instead of a stale flat dollar value.
    const momentumThreshold = Math.max(currentPrice * 0.00005, Math.min(currentPrice * 0.0005, volatility * 0.3));
    
    console.log(`📈 LTF Momentum: ${momentum.toFixed(2)} vs threshold ${momentumThreshold.toFixed(2)} (volatility: ${volatility.toFixed(2)})`);
    
    if (momentum > momentumThreshold) {
      return 'BULLISH';
    } else if (momentum < -momentumThreshold) {
      return 'BEARISH';
    } else {
      return 'NEUTRAL';
    }
  }
  
  private calculateRealRSI(period: number = 14): number {
    if (this.priceHistory.length < period + 1) {
      console.log('⚠️ RSI: Insufficient data, using default value 50');
      return 50;
    }

    const prices = this.priceHistory.slice(-period - 1);
    let gains = 0;
    let losses = 0;

    for (let i = 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) {
      return 100;
    }

    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));

    console.log(`✅ RSI (${period}): ${rsi.toFixed(1)} (avgGain: ${avgGain.toFixed(2)}, avgLoss: ${avgLoss.toFixed(2)})`);
    return parseFloat(rsi.toFixed(1));
  }

  private calculateRealATR(period: number = 14): number {
    // Item 3 fix: highs/lows/closes are all sliced from arrays built in
    // LOCKSTEP (highHistory/lowHistory/barCloseHistory), so index i always
    // refers to the SAME underlying bar across all three -- unlike the old
    // version, which paired a bar-cadence high/low with a tick-cadence
    // priceHistory close purely by shared array index, even though the two
    // arrays are populated on completely independent cadences (60s bar
    // refresh vs tick-driven sampling). A period+1-length window is needed so
    // every one of the `period` true-range calculations has a genuine
    // previous bar to read its prevClose from.
    if (this.highHistory.length < period + 1 || this.lowHistory.length < period + 1 || this.barCloseHistory.length < period + 1) {
      console.log('⚠️ ATR: Insufficient data, using default value 10');
      return 10;
    }

    const trueRanges: number[] = [];
    const highs = this.highHistory.slice(-(period + 1));
    const lows = this.lowHistory.slice(-(period + 1));
    const closes = this.barCloseHistory.slice(-(period + 1));

    for (let i = 1; i <= period; i++) {
      const high = highs[i];
      const low = lows[i];
      const prevClose = closes[i - 1]; // genuine previous bar's close -- same aligned series as high/low

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    const atr = trueRanges.reduce((sum, tr) => sum + tr, 0) / period;
    console.log(`✅ ATR (${period}): ${atr.toFixed(1)} (True Range avg, bar-aligned prevClose)`);
    return parseFloat(atr.toFixed(1));
  }

  private detectBearishDivergence(features: MarketFeatures): boolean {
    if (this.priceHistory.length < 10 || this.highHistory.length < 10) return false;
    
    const recent10Highs = this.highHistory.slice(-10);
    
    const priceHigh1 = recent10Highs[4];
    const priceHigh2 = recent10Highs[9];
    
    const rsi1 = this.calculateRSIAtIndex(4);
    const rsi2 = features.rsi;
    
    const priceHigherHigh = priceHigh2 > priceHigh1;
    const rsiLowerHigh = rsi2 < rsi1;
    
    if (priceHigherHigh && rsiLowerHigh && features.rsi > 60) {
      console.log(`🔍 Bearish Divergence: Price HH (${priceHigh2.toFixed(1)} > ${priceHigh1.toFixed(1)}), RSI LH (${rsi2.toFixed(1)} < ${rsi1.toFixed(1)})`);
      return true;
    }
    
    return false;
  }

  private calculateRSIAtIndex(indexFromEnd: number): number {
    if (this.priceHistory.length < indexFromEnd + 15) {
      return 50;
    }
    
    const prices = this.priceHistory.slice(-(indexFromEnd + 15), -indexFromEnd);
    const period = 14;
    
    let gains = 0;
    let losses = 0;

    for (let i = 1; i < prices.length && i <= period; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses += Math.abs(change);
      }
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    
    return parseFloat(rsi.toFixed(1));
  }
  
  private calculateRealMACD(): number {
    if (this.priceHistory.length < 26) {
      console.log('⚠️ MACD: Insufficient data for calculation, using neutral value');
      return 0;
    }

    const ema12 = this.calculateEMA(this.priceHistory, 12);
    const ema26 = this.calculateEMA(this.priceHistory, 26);
    const macdLine = ema12 - ema26;
    
    const macdHistory = [macdLine];
    for (let i = this.priceHistory.length - 9; i < this.priceHistory.length; i++) {
      const slicedPrices = this.priceHistory.slice(0, i + 1);
      const e12 = this.calculateEMA(slicedPrices, 12);
      const e26 = this.calculateEMA(slicedPrices, 26);
      macdHistory.push(e12 - e26);
    }
    
    const signalLine = this.calculateEMA(macdHistory, 9);
    const histogram = macdLine - signalLine;
    
    console.log(`✅ MACD Histogram: ${histogram.toFixed(3)} (MACD: ${macdLine.toFixed(2)}, Signal: ${signalLine.toFixed(2)})`);
    return parseFloat(histogram.toFixed(3));
  }

  private calculateRealEMACrossover(): number {
    if (this.priceHistory.length < 50) {
      console.log('⚠️ EMA Crossover: Insufficient data for calculation, using neutral value');
      return 0;
    }

    const ema9 = this.calculateEMA(this.priceHistory, 9);
    const ema21 = this.calculateEMA(this.priceHistory, 21);
    const ema50 = this.calculateEMA(this.priceHistory, 50);
    
    const shortTermCross = ema9 - ema21;
    const longTermCross = ema21 - ema50;
    
    const crossoverStrength = (shortTermCross * 0.6 + longTermCross * 0.4) / this.currentPrice * 1000;
    
    console.log(`✅ EMA Crossover: ${crossoverStrength.toFixed(3)} (EMA9: ${ema9.toFixed(1)}, EMA21: ${ema21.toFixed(1)}, EMA50: ${ema50.toFixed(1)})`);
    return parseFloat(crossoverStrength.toFixed(3));
  }

  private calculateEMA(data: number[], period: number): number {
    if (data.length < period) {
      return data[data.length - 1] || 0;
    }

    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    
    return ema;
  }

  private checkAlternativeCounterTrendConfirmation(
    signalType: SignalType,
    features: MarketFeatures,
  ): { confirmed: boolean; reason: string } {
    const price = this.currentPrice;
    const proximity = 8;

    if (signalType === 'BUY') {
      const strongOB = features.orderBlocks.find(ob => ob.type === 'BULLISH' && ob.strength >= 0.6 && Math.abs(ob.price - price) < proximity);
      if (strongOB) return { confirmed: true, reason: `Bullish OB @ ${strongOB.price.toFixed(1)} (strength ${(strongOB.strength * 100).toFixed(0)}%)` };

      const strongQM = features.quasimodolLevels.find(qm => qm.type === 'BULLISH_QM' && qm.strength >= 0.6 && Math.abs(qm.price - price) < proximity);
      if (strongQM) return { confirmed: true, reason: `Bullish Quasimodo @ ${strongQM.price.toFixed(1)}` };

      const confirmedSweep = features.sessionSweeps.find(s => s.type === 'LOW_SWEEP' && s.reversalConfirmed);
      if (confirmedSweep) return { confirmed: true, reason: `Confirmed ${confirmedSweep.sessionType} low sweep reversal` };
    } else {
      const strongOB = features.orderBlocks.find(ob => ob.type === 'BEARISH' && ob.strength >= 0.6 && Math.abs(ob.price - price) < proximity);
      if (strongOB) return { confirmed: true, reason: `Bearish OB @ ${strongOB.price.toFixed(1)} (strength ${(strongOB.strength * 100).toFixed(0)}%)` };

      const strongQM = features.quasimodolLevels.find(qm => qm.type === 'BEARISH_QM' && qm.strength >= 0.6 && Math.abs(qm.price - price) < proximity);
      if (strongQM) return { confirmed: true, reason: `Bearish Quasimodo @ ${strongQM.price.toFixed(1)}` };

      const confirmedSweep = features.sessionSweeps.find(s => s.type === 'HIGH_SWEEP' && s.reversalConfirmed);
      if (confirmedSweep) return { confirmed: true, reason: `Confirmed ${confirmedSweep.sessionType} high sweep reversal` };
    }

    return { confirmed: false, reason: 'No strong OB / Quasimodo / confirmed sweep nearby' };
  }

  private requiresHigherTimeframeConfirmation(): { confirmed: boolean; reason: string; tip: string } {
    if (this.fiveMinCandles.length < 2) {
      return {
        confirmed: false,
        reason: 'Insufficient 5-minute candle data (need at least 2 candles)',
        tip: 'System is building 5-minute candle history. Wait 5-10 minutes after app launch.'
      };
    }
    
    const now = Date.now();
    const timeSinceLastCandle = now - this.lastFiveMinCandleClose;
    const maxAgeMs = 10 * 60 * 1000;
    
    if (timeSinceLastCandle > maxAgeMs) {
      return {
        confirmed: false,
        reason: `Last 5-minute candle close was ${(timeSinceLastCandle / 1000 / 60).toFixed(1)} minutes ago`,
        tip: 'Waiting for fresh 5-minute candle close to confirm trend reversal. Max age: 10 minutes.'
      };
    }
    
    const lastClosedCandle = this.fiveMinCandles[this.fiveMinCandles.length - 2];
    const previousCandle = this.fiveMinCandles[this.fiveMinCandles.length - 3];
    
    if (!lastClosedCandle || !previousCandle) {
      return {
        confirmed: false,
        reason: 'Need at least 2 completed 5-minute candles for comparison',
        tip: 'Building candle history. Counter-trend signals will be available shortly.'
      };
    }
    
    const breakoutDetected = (
      (lastClosedCandle.close > previousCandle.high && lastClosedCandle.close > lastClosedCandle.open) ||
      (lastClosedCandle.close < previousCandle.low && lastClosedCandle.close < lastClosedCandle.open)
    );
    
    if (!breakoutDetected) {
      return {
        confirmed: false,
        reason: `Last 5-min candle did not close outside previous candle range (Close: ${lastClosedCandle.close.toFixed(1)}, Prev H/L: ${previousCandle.high.toFixed(1)}/${previousCandle.low.toFixed(1)})`,
        tip: 'Counter-trend signals require 5-minute candle to close ABOVE previous high (bullish) or BELOW previous low (bearish).'
      };
    }
    
    const candleAge = (now - lastClosedCandle.timestamp) / 1000 / 60;
    const direction = lastClosedCandle.close > previousCandle.high ? 'BULLISH' : 'BEARISH';
    
    console.log(`\n🕯️ 5-MINUTE CANDLE CONFIRMATION:`);
    console.log(`   Last Candle: O=${lastClosedCandle.open.toFixed(1)}, H=${lastClosedCandle.high.toFixed(1)}, L=${lastClosedCandle.low.toFixed(1)}, C=${lastClosedCandle.close.toFixed(1)}`);
    console.log(`   Previous Candle: H=${previousCandle.high.toFixed(1)}, L=${previousCandle.low.toFixed(1)}`);
    console.log(`   Breakout Direction: ${direction}`);
    console.log(`   Candle Age: ${candleAge.toFixed(1)} minutes`);
    
    return {
      confirmed: true,
      reason: `${direction} breakout confirmed - 5-min candle closed ${direction === 'BULLISH' ? 'above' : 'below'} previous candle ${direction === 'BULLISH' ? 'high' : 'low'} (${candleAge.toFixed(1)}min ago)`,
      tip: 'Higher timeframe confirmation increases signal reliability for counter-trend entries.'
    };
  }
  
  private detectBullishDivergence(features: MarketFeatures): boolean {
    if (this.priceHistory.length < 10 || this.lowHistory.length < 10) return false;
    
    const recent10Lows = this.lowHistory.slice(-10);
    
    const priceLow1 = recent10Lows[4];
    const priceLow2 = recent10Lows[9];
    
    const rsi1 = this.calculateRSIAtIndex(4);
    const rsi2 = features.rsi;
    
    const priceLowerLow = priceLow2 < priceLow1;
    const rsiHigherLow = rsi2 > rsi1;
    
    if (priceLowerLow && rsiHigherLow && features.rsi < 40) {
      console.log(`🔍 Bullish Divergence: Price LL (${priceLow2.toFixed(1)} < ${priceLow1.toFixed(1)}), RSI HL (${rsi2.toFixed(1)} > ${rsi1.toFixed(1)})`);
      return true;
    }
    
    return false;
  }
  
  /**
   * Builds the v2 (wide) learning feature vector from the exact MarketFeatures
   * the signal was scored on, plus the realised entry geometry.
   *
   * The v1 six scalars keep identical semantics and positions, so anything
   * reading `rsi/atr/volumeRatio/dxyChange/timeWindowFactor/sentiment` is
   * unaffected. Everything else is additive and marked with schemaVersion 2 so
   * diagnostics can tell a wide record from a legacy one without guessing.
   */
  private buildLearningContext(
    features: MarketFeatures,
    geometry: { entryPrice: number; slDistance: number; tp1Distance: number; confidence: number },
  ): SignalLearningContext {
    const now = new Date();
    const price = geometry.entryPrice;
    const atr = Math.max(features.atr, 0.01);

    const nearestZoneDistance = features.srZones.length > 0
      ? Math.min(...features.srZones.map(z => Math.abs(z.price - price)))
      : undefined;

    const confirmedSweep = features.sessionSweeps.find(s => s.reversalConfirmed)
      ?? features.sessionSweeps[features.sessionSweeps.length - 1];

    return {
      rsi: features.rsi,
      atr: features.atr,
      volumeRatio: features.volumeRatio,
      dxyChange: features.dxyChange,
      timeWindowFactor: features.timeWindowFactor,
      sentiment: features.sentiment ?? { score: 0, confidence: 0, source: 'engine-default' },

      schemaVersion: LEARNING_FEATURE_SCHEMA_VERSION,

      macdHistogram: features.macdHistogram,
      emaCrossover: features.emaCrossover,
      adx: features.adx,
      vwapDelta: features.vwap !== null ? parseFloat((price - features.vwap).toFixed(2)) : null,
      htfTrend: this.detectHTFTrend(features),

      atrPercentOfPrice: price > 0 ? parseFloat((features.atr / price).toFixed(6)) : undefined,
      bollingerBandwidth: features.bollingerBandwidth,
      bollingerSqueeze: features.bollingerSqueeze,
      bollingerExpansion: features.bollingerExpansion,
      sessionVolatilityIndex: features.sessionVolatilityIndex,

      regimeType: features.marketRegime.type,
      regimeStrength: features.marketRegime.strength,
      regimeConfidence: features.marketRegime.confidence,

      priceActionPattern: features.priceActionPattern,
      candlestickPattern: features.candlestickPattern,
      supportStrength: features.supportStrength,
      resistanceStrength: features.resistanceStrength,
      srZoneCount: features.srZones.length,
      nearestZoneDistanceAtr: nearestZoneDistance !== undefined
        ? parseFloat((nearestZoneDistance / atr).toFixed(3))
        : undefined,
      activeSRReactionType: features.activeSRReaction?.reactionType ?? null,
      activeSRReactionStrength: features.activeSRReaction?.strength,
      activeSRReactionConfirmed: features.activeSRReaction?.confirmed,
      orderBlockCount: features.orderBlocks.length,
      quasimodoCount: features.quasimodolLevels.length,

      sweepCount: features.sessionSweeps.length,
      confirmedSweepType: confirmedSweep?.reversalConfirmed ? confirmedSweep.type : null,
      confirmedSweepSession: confirmedSweep?.reversalConfirmed ? confirmedSweep.sessionType : null,
      sweepPenetrationDepth: confirmedSweep?.penetrationDepth,
      sweepReclaimLatencyMs: confirmedSweep?.reclaimLatencyMs,

      orderFlowImbalance: features.orderFlow.volumeImbalance,
      institutionalFootprint: features.orderFlow.institutionalFootprint,
      largeOrdersDetected: features.orderFlow.largeOrdersDetected,
      pocDelta: Number.isFinite(features.volumeProfile.pointOfControl)
        ? parseFloat((price - features.volumeProfile.pointOfControl).toFixed(2))
        : undefined,

      us10yChange: features.intermarketData?.us10yChange,
      vixChange: features.intermarketData?.vixChange,
      goldDxyCorrelation: features.intermarketData?.goldDxyCorrelation,
      goldYieldCorrelation: features.intermarketData?.goldYieldCorrelation,

      sessionName: features.liquidityWindow?.sessionName,
      liquidityScore: features.liquidityWindow?.score,
      hourUtc: now.getUTCHours(),
      minuteOfDayUtc: now.getUTCHours() * 60 + now.getUTCMinutes(),
      dayOfWeekUtc: now.getUTCDay(),
      timeToSessionEnd: features.timeToSessionEnd,

      entryPrice: parseFloat(price.toFixed(2)),
      slDistance: parseFloat(geometry.slDistance.toFixed(2)),
      tp1Distance: parseFloat(geometry.tp1Distance.toFixed(2)),
      plannedRR: geometry.slDistance > 0
        ? parseFloat((geometry.tp1Distance / geometry.slDistance).toFixed(3))
        : undefined,
      confidenceAtEntry: parseFloat(geometry.confidence.toFixed(4)),
    };
  }

  async recordTradeOutcome(signalId: string, entryPrice: number, exitPrice: number, result: 'WIN' | 'LOSS', features?: Partial<SignalLearningContext>, misleadingFeatures?: FeatureConfidence[], signalDuration?: number, confidence?: number, stopDistance?: number): Promise<void> {
    const pnl = result === 'WIN' ? Math.abs(exitPrice - entryPrice) : -Math.abs(exitPrice - entryPrice);
    const normalizedConfidence = Math.max(0.42, Math.min(0.95, confidence ?? this.performanceMetrics.avgConfidence ?? 0.72));
    const defaultContext = createDefaultLearningContext();
    // The six v1 scalars are still normalized with explicit fallbacks (they are
    // REQUIRED and read unconditionally by drift/correlation code). Every wide
    // v2 field is carried through verbatim via the spread: absent stays absent,
    // so a legacy record is never back-filled with invented values.
    const normalizedFeatures: SignalLearningContext = {
      ...(features ?? {}),
      rsi: typeof features?.rsi === 'number' ? features.rsi : defaultContext.rsi,
      atr: typeof features?.atr === 'number' ? features.atr : defaultContext.atr,
      volumeRatio: typeof features?.volumeRatio === 'number' ? features.volumeRatio : defaultContext.volumeRatio,
      dxyChange: typeof features?.dxyChange === 'number' ? features.dxyChange : defaultContext.dxyChange,
      timeWindowFactor: typeof features?.timeWindowFactor === 'number' ? features.timeWindowFactor : defaultContext.timeWindowFactor,
      sentiment: features?.sentiment ?? defaultContext.sentiment,
      schemaVersion: features?.schemaVersion ?? 1,
    };
    
    // PHASE 2 (C4): infer direction from realised geometry so no call site has
    // to be changed. A WIN that exited ABOVE entry can only have been a BUY; a
    // LOSS that exited BELOW entry can only have been a BUY; and vice versa.
    let direction: 'BUY' | 'SELL' | undefined;
    if (Number.isFinite(entryPrice) && Number.isFinite(exitPrice) && exitPrice !== entryPrice) {
      const exitedAbove = exitPrice > entryPrice;
      direction = result === 'WIN' ? (exitedAbove ? 'BUY' : 'SELL') : (exitedAbove ? 'SELL' : 'BUY');
    }

    // PHASE 2 (C3): realised R + scratch classification. Only computable when
    // the caller supplies the stop distance; without it the outcome keeps its
    // raw WIN/LOSS label exactly as before (no silent behaviour change for
    // older call sites or restored records).
    const usableStopDistance = Number.isFinite(stopDistance) && (stopDistance ?? 0) > 0 ? (stopDistance as number) : undefined;
    const realizedR = usableStopDistance !== undefined
      ? parseFloat((pnl / usableStopDistance).toFixed(4))
      : undefined;
    const isScratch = realizedR !== undefined ? Math.abs(realizedR) < SCRATCH_R_THRESHOLD : undefined;
    if (isScratch) {
      console.log(`➖ SCRATCH outcome ${signalId.slice(-6)}: ${realizedR?.toFixed(3)}R (|R| < ${SCRATCH_R_THRESHOLD}) - retained for audit, EXCLUDED from learning labels and win-rate`);
    }

    const outcome: TradeOutcome = {
      signalId,
      entryPrice,
      exitPrice,
      result,
      pnl,
      confidence: parseFloat(normalizedConfidence.toFixed(2)),
      features: normalizedFeatures,
      timestamp: new Date(),
      misleadingFeatures,
      signalDuration,
      direction,
      realizedR,
      isScratch,
      featureSchemaVersion: normalizedFeatures.schemaVersion,
    };
    
    // PHASE 2 (A2): remember confirmed stop-outs per direction. Direction is
    // inferred from the realised exit rather than adding a parameter: a LOSS
    // that exited BELOW entry can only have been a BUY, and vice versa.
    if (result === 'LOSS' && Number.isFinite(entryPrice) && Number.isFinite(exitPrice) && exitPrice !== entryPrice) {
      const stopOutWasBuy = exitPrice < entryPrice;
      if (stopOutWasBuy) this.lastBuyStopOutTime = Date.now();
      else this.lastSellStopOutTime = Date.now();
      console.log(`🧊 POST-STOP COOLDOWN ARMED for ${stopOutWasBuy ? 'BUY' : 'SELL'} (${(POST_STOP_SAME_DIRECTION_COOLDOWN_MS / 60000).toFixed(0)} min)`);
    }

    this.tradeOutcomes.push(outcome);
    
    if (this.tradeOutcomes.length > MAX_STORED_OUTCOMES) {
      this.tradeOutcomes = this.tradeOutcomes.slice(-MAX_STORED_OUTCOMES);
    }
    
    // PHASE 2 (C3): scratches are excluded from win-rate / profit-factor. A
    // profit-lock exit at ~0R counted as a full WIN previously inflated both.
    const recentOutcomes = this.tradeOutcomes.filter(o => o.isScratch !== true).slice(-20);
    const scratchCount = this.tradeOutcomes.filter(o => o.isScratch === true).length;
    const wins = recentOutcomes.filter(o => o.result === 'WIN').length;
    const losses = recentOutcomes.filter(o => o.result === 'LOSS').length;
    const winPnl = recentOutcomes.filter(o => o.result === 'WIN').reduce((sum, o) => sum + o.pnl, 0);
    const lossPnl = Math.abs(recentOutcomes.filter(o => o.result === 'LOSS').reduce((sum, o) => sum + o.pnl, 0));
    
    this.performanceMetrics.recentWinRate = wins + losses > 0 ? wins / (wins + losses) : 0;
    this.performanceMetrics.profitFactor = lossPnl > 0 ? winPnl / lossPnl : 2.0;
    this.performanceMetrics.avgConfidence = recentOutcomes.length > 0
      ? recentOutcomes.reduce((sum, o) => sum + o.confidence, 0) / recentOutcomes.length
      : (this.performanceMetrics.avgConfidence ?? 0.72);
    
    const winningConfidences = recentOutcomes
      .filter(o => o.result === 'WIN')
      .map(o => o.confidence)
      .slice(-10);
    this.performanceMetrics.recentWinningConfidences = winningConfidences;
    
    if (result === 'LOSS' && misleadingFeatures && misleadingFeatures.length > 0) {
      console.log(`⚠️ LOST SIGNAL #${signalId}. Post-mortem:`);
      misleadingFeatures.forEach(feature => {
        console.log(`   - ${feature.feature} (${feature.score}% weight) failed to predict outcome`);
      });
    }
    
    console.log('🧠 Self-Learning Update:', {
      winRate: (this.performanceMetrics.recentWinRate * 100).toFixed(1) + '%',
      profitFactor: this.performanceMetrics.profitFactor.toFixed(2),
      totalOutcomes: this.tradeOutcomes.length,
      scratchesExcluded: scratchCount,
    });
    
    const now = Date.now();
    const currentUTCHour = new Date().getUTCHours();
    const isLowLiquidityWindow = currentUTCHour >= 22 || currentUTCHour < 7;
    
    const shouldRetrainScheduled = now - this.lastTrainingTime > 48 * 60 * 60 * 1000;
    
    const avgRecentWinConfidence = this.performanceMetrics.recentWinningConfidences.length > 0
      ? this.performanceMetrics.recentWinningConfidences.reduce((a, b) => a + b, 0) / this.performanceMetrics.recentWinningConfidences.length
      : 0.80;
    const winRateDrift = this.checkRollingWinRateDrift();
    const shouldRetrainConfidenceDrop = avgRecentWinConfidence < MIN_CONFIDENCE_FOR_RETRAINING || winRateDrift;
    
    if (shouldRetrainScheduled || shouldRetrainConfidenceDrop) {
      const reason = shouldRetrainConfidenceDrop 
        ? `Confidence Degradation (avg: ${(avgRecentWinConfidence * 100).toFixed(1)}%)`
        : 'Scheduled 48-Hour Retrain';
      
      if (isLowLiquidityWindow) {
        console.log(`🔔 RETRAINING TRIGGERED: ${reason}`);
        console.log(`   Scheduled: ${shouldRetrainScheduled}, ConfDrop: ${shouldRetrainConfidenceDrop}`);
        console.log(`   Avg Win Conf: ${(avgRecentWinConfidence * 100).toFixed(1)}%, Threshold: ${(MIN_CONFIDENCE_FOR_RETRAINING * 100).toFixed(1)}%`);
        console.log(`   ✅ EXECUTING NOW: Low-liquidity window active (${currentUTCHour}:00 UTC)`);
        await this.walkForwardOptimization(reason);
        this.retrainScheduled = false;
      } else {
        console.log(`🔔 RETRAINING NEEDED: ${reason}`);
        console.log(`   ⏰ SCHEDULED: Waiting for low-liquidity window (Asian Session: 22:00-07:00 UTC)`);
        console.log(`   Current Time: ${currentUTCHour}:00 UTC (High Liquidity)`);
        console.log(`   Reason: Minimize execution risk and resource contention`);
        this.retrainScheduled = true;
      }
    } else if (this.retrainScheduled && isLowLiquidityWindow) {
      console.log(`🔔 EXECUTING SCHEDULED RETRAIN`);
      console.log(`   ✅ Low-liquidity window active (${currentUTCHour}:00 UTC - Asian Session)`);
      console.log(`   Previous trigger: High drift or confidence degradation`);
      await this.walkForwardOptimization('Scheduled Retrain (Deferred from Peak Hours)');
      this.retrainScheduled = false;
    } else if (this.retrainScheduled) {
      console.log(`⏰ RETRAIN SCHEDULED: Waiting for Asian Session (22:00-07:00 UTC)`);
      console.log(`   Current Time: ${currentUTCHour}:00 UTC`);
      console.log(`   Status: Deferred from peak trading hours`);
    } else {
      const hoursSinceRetrain = ((now - this.lastTrainingTime) / (60*60*1000)).toFixed(1);
      console.log(`✅ No retraining needed - Hours: ${hoursSinceRetrain}/48.0, AvgConf: ${(avgRecentWinConfidence * 100).toFixed(1)}%`);
    }
    
    this.calculateFeatureCorrelation();
    this.updateModelHealthScore();
    
    try {
      await appendOutcomeToStore(outcome as unknown as StoredTradeOutcome);
      await pruneOutcomeStoreToCap(MAX_STORED_OUTCOMES);
    } catch (error) {
      console.error('Failed to persist trade outcome to local learning store:', error);
    }

    // Durable tier: upsert into Supabase (`trade_outcomes_v1`) so the model's
    // memory survives a browser reload and is shared across devices. Keyed by
    // signalId, so this is idempotent and never double-counts a trade. Failure
    // is non-fatal - the row stays queued in learningStore for the next push.
    try {
      await pushOutcomesToRemote([outcome as unknown as StoredTradeOutcome]);
    } catch (error) {
      console.warn('Durable learning-corpus push failed (queued for retry):', error);
    }
  }
  
  private async walkForwardOptimization(reason: string = 'Scheduled'): Promise<void> {
    console.log(`🔄 Walk-Forward Optimization: Retraining model... (Reason: ${reason})`);
    
    if (this.tradeOutcomes.length < 20) {
      console.log('⚠️ Insufficient data for retraining. Need at least 20 outcomes.');
      return;
    }
    
    const trainingWindowMs = TRAINING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const cutoffDate = new Date(Date.now() - trainingWindowMs);
    const trainingData = this.tradeOutcomes.filter(o => new Date(o.timestamp) >= cutoffDate);
    
    if (trainingData.length < 10) {
      console.log(`⚠️ Time-based window yielded only ${trainingData.length} outcomes. Using all available trades as fallback.`);
      const fallbackData = this.tradeOutcomes.slice(-MAX_STORED_OUTCOMES);
      this.retrainModel(fallbackData);
      return;
    }
    
    console.log(`✓ Training on ${trainingData.length} outcomes from last ${TRAINING_WINDOW_DAYS} days`);
    console.log(`   Exponential decay weighting: Last 7 days will have 80-90% influence`);
    this.retrainModel(trainingData);
  }
  
  private retrainModel(trainingData: TradeOutcome[]): void {
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
    
    const DECAY_LAMBDA = 0.75;
    
    const dataWithWeights = trainingData.map(outcome => {
      const age = now - new Date(outcome.timestamp).getTime();
      const daysSinceOutcome = age / (24 * 60 * 60 * 1000);
      
      const weight = Math.pow(DECAY_LAMBDA, daysSinceOutcome);
      
      return { outcome, weight };
    });
    
    const totalWeight = dataWithWeights.reduce((sum, d) => sum + d.weight, 0);
    const normalizedData = dataWithWeights.map(d => ({
      ...d,
      weight: d.weight / totalWeight
    }));
    
    const last3DaysInfluence = normalizedData
      .filter(d => (now - new Date(d.outcome.timestamp).getTime()) <= threeDaysMs)
      .reduce((sum, d) => sum + d.weight, 0);
    
    const last7DaysInfluence = normalizedData
      .filter(d => (now - new Date(d.outcome.timestamp).getTime()) <= sevenDaysMs)
      .reduce((sum, d) => sum + d.weight, 0);
    
    console.log(`\n📊 EXPONENTIAL DECAY WEIGHTING:`);    console.log(`   Last 3 Days Influence: ${(last3DaysInfluence * 100).toFixed(1)}%`);
    console.log(`   Last 7 Days Influence: ${(last7DaysInfluence * 100).toFixed(1)}%`);
    console.log(`   Older Data Influence: ${((1 - last7DaysInfluence) * 100).toFixed(1)}%`);
    
    // PHASE 2 (C3): drop scratches from the LABEL partition. A ~0R profit-lock
    // exit carries no information about whether the setup was good, but as an
    // unqualified WIN it dragged the "winning" feature centroid toward neutral
    // feature values, which is exactly what makes a fitted weight vector look
    // like it has no signal.
    const scratchData = normalizedData.filter(d => d.outcome.isScratch === true);
    const labelledData = normalizedData.filter(d => d.outcome.isScratch !== true);
    if (scratchData.length > 0) {
      console.log(`➖ Excluding ${scratchData.length} scratch outcome(s) (|R| < ${SCRATCH_R_THRESHOLD}) from label-based weight fitting`);
    }
    const winningData = labelledData.filter(d => d.outcome.result === 'WIN');
    const losingData = labelledData.filter(d => d.outcome.result === 'LOSS');
    const weightedWinningData = winningData.length > 0 ? winningData : normalizedData;
    const weightedLosingData = losingData.length > 0 ? losingData : normalizedData;

    // PHASE 2 (C4): realised expectancy per direction, computed here so the
    // calibration gate reads a freshly consolidated view on every retrain.
    this.recomputeDirectionalExpectancy();

    if (winningData.length === 0 || losingData.length === 0) {
      console.log('⚠️ Retrain class diversity is limited - applying neutral fallback weighting to avoid unstable model weights');
    }
    
    // Step 1: capture the pre-retrain ("historical") vector BEFORE clearing,
    // so the freshly fitted recent-window vector can be blended against it
    // rather than overwriting it outright.
    const historicalWeights = new Map<string, number>(this.modelWeights);
    this.modelWeights.clear();
    
    const rawWeights: { [key: string]: number } = {};
    
    const weightedAvgWinRSI = weightedWinningData.reduce((sum, d) => sum + d.outcome.features.rsi * d.weight, 0) / 
      weightedWinningData.reduce((sum, d) => sum + d.weight, 0);
    const weightedAvgLossRSI = weightedLosingData.reduce((sum, d) => sum + d.outcome.features.rsi * d.weight, 0) / 
      weightedLosingData.reduce((sum, d) => sum + d.weight, 0);
    rawWeights['rsi_weight'] = (weightedAvgWinRSI - weightedAvgLossRSI) / 100;
    
    const weightedAvgWinTimeWindow = weightedWinningData.reduce((sum, d) => sum + d.outcome.features.timeWindowFactor * d.weight, 0) / 
      weightedWinningData.reduce((sum, d) => sum + d.weight, 0);
    const weightedAvgLossTimeWindow = weightedLosingData.reduce((sum, d) => sum + d.outcome.features.timeWindowFactor * d.weight, 0) / 
      weightedLosingData.reduce((sum, d) => sum + d.weight, 0);
    rawWeights['timeWindow_weight'] = (weightedAvgWinTimeWindow - weightedAvgLossTimeWindow) * 0.5;
    
    const weightedAvgWinVolume = weightedWinningData.reduce((sum, d) => sum + d.outcome.features.volumeRatio * d.weight, 0) / 
      weightedWinningData.reduce((sum, d) => sum + d.weight, 0);
    const weightedAvgLossVolume = weightedLosingData.reduce((sum, d) => sum + d.outcome.features.volumeRatio * d.weight, 0) / 
      weightedLosingData.reduce((sum, d) => sum + d.weight, 0);
    rawWeights['volume_weight'] = weightedAvgWinVolume - weightedAvgLossVolume;
    
    const weightedAvgWinSentiment = weightedWinningData.reduce((sum, d) => sum + (d.outcome.features.sentiment?.score ?? 0) * d.weight, 0) / 
      weightedWinningData.reduce((sum, d) => sum + d.weight, 0);
    const weightedAvgLossSentiment = weightedLosingData.reduce((sum, d) => sum + (d.outcome.features.sentiment?.score ?? 0) * d.weight, 0) / 
      weightedLosingData.reduce((sum, d) => sum + d.weight, 0);
    rawWeights['sentiment_weight'] = (weightedAvgWinSentiment - weightedAvgLossSentiment) * 2;
    
    const weightedAvgWinATR = weightedWinningData.reduce((sum, d) => sum + d.outcome.features.atr * d.weight, 0) / 
      weightedWinningData.reduce((sum, d) => sum + d.weight, 0);
    const weightedAvgLossATR = weightedLosingData.reduce((sum, d) => sum + d.outcome.features.atr * d.weight, 0) / 
      weightedLosingData.reduce((sum, d) => sum + d.weight, 0);
    rawWeights['atr_weight'] = (weightedAvgWinATR - weightedAvgLossATR) / 10;
    
    const weightedAvgWinDXY = weightedWinningData.reduce((sum, d) => sum + d.outcome.features.dxyChange * d.weight, 0) / 
      weightedWinningData.reduce((sum, d) => sum + d.weight, 0);
    const weightedAvgLossDXY = weightedLosingData.reduce((sum, d) => sum + d.outcome.features.dxyChange * d.weight, 0) / 
      weightedLosingData.reduce((sum, d) => sum + d.weight, 0);
    rawWeights['dxy_weight'] = (weightedAvgWinDXY - weightedAvgLossDXY) * 2;
    
    console.log('\n📐 WEIGHT NORMALIZATION:');
    console.log('   Raw Weights (before normalization):');
    Object.entries(rawWeights).forEach(([key, value]) => {
      console.log(`      ${key}: ${value.toFixed(4)}`);
    });
    
    const sumAbsoluteWeights = Object.values(rawWeights).reduce((sum, w) => sum + Math.abs(w), 0);
    const sumAbsoluteConsumedWeights = Object.entries(rawWeights)
      .filter(([key]) => CONSUMED_MODEL_WEIGHTS.has(key))
      .reduce((sum, [, w]) => sum + Math.abs(w), 0);
    console.log(`   Sum of Absolute Weights: ${sumAbsoluteWeights.toFixed(4)}`);
    console.log(`   Sum of Absolute CONSUMED Weights (${Array.from(CONSUMED_MODEL_WEIGHTS).join(', ')}): ${sumAbsoluteConsumedWeights.toFixed(4)}`);
    
    const recentWeights = new Map<string, number>();
    if (sumAbsoluteWeights > 0) {
      Object.entries(rawWeights).forEach(([key, value]) => {
        // PHASE 2 (C2): weights that actually modulate scoring are normalized
        // over the consumed subset, so inert telemetry-only columns can no
        // longer dilute them. Inert columns keep the all-features denominator
        // so they stay bounded and comparable for drift/telemetry reads.
        const denominator = CONSUMED_MODEL_WEIGHTS.has(key) && sumAbsoluteConsumedWeights > 0
          ? sumAbsoluteConsumedWeights
          : sumAbsoluteWeights;
        const normalizedWeight = value / denominator;
        recentWeights.set(key, normalizedWeight);
      });
    } else {
      console.log('   ⚠️ Warning: All weights are zero. Using equal distribution.');
      Object.keys(rawWeights).forEach(key => {
        recentWeights.set(key, 1.0 / Object.keys(rawWeights).length);
      });
    }

    // Step 1: Bayesian memory consolidation. Blend the freshly fitted
    // recent-window vector (W_recent) with the previous consolidated vector
    // (W_historical, i.e. last cycle's W_final) instead of overwriting it:
    //   W_final = (alpha * W_historical) + ((1 - alpha) * W_recent)
    // A feature with no prior history defaults W_historical to 0 (neutral),
    // so cold-start behaviour is unaffected.
    console.log('\n🧮 BAYESIAN MEMORY CONSOLIDATION:');
    console.log(`   alpha (historical weight): ${BAYESIAN_BLEND_ALPHA}`);
    const blendedKeys = new Set<string>([...historicalWeights.keys(), ...recentWeights.keys()]);
    blendedKeys.forEach(key => {
      const historical = historicalWeights.get(key) ?? 0;
      const recent = recentWeights.get(key) ?? 0;
      const blended = (BAYESIAN_BLEND_ALPHA * historical) + ((1 - BAYESIAN_BLEND_ALPHA) * recent);
      this.modelWeights.set(key, blended);
      console.log(`      ${key}: historical=${historical.toFixed(4)} recent=${recent.toFixed(4)} -> blended=${blended.toFixed(4)}`);
    });

    console.log('   Final Blended Weights:');
    let verificationSum = 0;
    this.modelWeights.forEach((value, key) => {
      console.log(`      ${key}: ${value.toFixed(4)} (${(Math.abs(value) * 100).toFixed(1)}% influence)`);
      verificationSum += Math.abs(value);
    });
    console.log(`   Verification Sum (post-blend, not necessarily 1.0): ${verificationSum.toFixed(4)}`);
    
    this.lastTrainingTime = Date.now();
    
    console.log('\n' + '='.repeat(80));
    console.log('✅✅✅ MODEL RETRAINED ✅✅✅');
    console.log('='.repeat(80));
    console.log(`   Training Time: ${new Date(this.lastTrainingTime).toISOString()}`);
    console.log(`   Retraining Strategy: 48-Hour Schedule + Confidence Degradation + Drift Detection`);
    console.log(`   Training Window: ${TRAINING_WINDOW_DAYS} days with exponential decay`);
    console.log(`   Normalized weights:`, Array.from(this.modelWeights.entries()));
    console.log(`   Training Data Size: ${trainingData.length} outcomes`);
    console.log(`   Wins: ${winningData.length}, Losses: ${losingData.length}`);
    console.log(`   Last 3 Days Weight: ${(last3DaysInfluence * 100).toFixed(1)}%`);
    console.log(`   Last 7 Days Weight: ${(last7DaysInfluence * 100).toFixed(1)}%`);
    console.log(`   Target: 80-90% influence from last 3-7 days`);
    console.log(`   Weight Normalization: ✅ Complete (prevents single feature monopolization)`);
    console.log('='.repeat(80) + '\n');
    
    const persistData = {
      weights: Array.from(this.modelWeights.entries()),
      lastTrainingTime: this.lastTrainingTime,
    };
    AsyncStorage.setItem(MODEL_WEIGHTS_KEY, JSON.stringify(persistData)).catch((error: unknown) => {
      console.error('Failed to persist model weights:', error);
    });
    
    this.updateModelHealthScore();
  }
  
  async loadPersistedLearningData(): Promise<DailyOHLC[]> {
    try {
      const [legacyOutcomesData, weightsData, dailyOHLCData] = await Promise.all([
        AsyncStorage.getItem(LEARNING_STORAGE_KEY),
        AsyncStorage.getItem(MODEL_WEIGHTS_KEY),
        AsyncStorage.getItem(DAILY_OHLC_STORAGE_KEY),
      ]);
      
      // Step 3: trade outcomes now live in SQLite (learningStore.ts), not this
      // AsyncStorage blob. One-time, idempotent migration: if SQLite is still
      // empty but a legacy AsyncStorage blob exists, copy it in (preserving
      // order), then always read from SQLite going forward.
      try {
        if (legacyOutcomesData) {
          const legacyOutcomes = JSON.parse(legacyOutcomesData);
          const migratedCount = await migrateLegacyOutcomesIfEmpty(Array.isArray(legacyOutcomes) ? legacyOutcomes : []);
          if (migratedCount > 0) {
            console.log(`✓ Migrated ${migratedCount} legacy trade outcomes from AsyncStorage into SQLite learning store`);
          }
        }
        // Durable tier merge: pull the Supabase corpus in BEFORE reading the
        // local store, so a reloaded web session / fresh device starts with the
        // full shared history instead of an empty (or install-local) one.
        try {
          const hydration = await hydrateLearningStoreFromRemote({ limit: 300, cap: MAX_STORED_OUTCOMES });
          if (hydration.available) {
            console.log(`✓ Durable learning corpus: pulled ${hydration.pulled}, merged ${hydration.merged} new, backfilled ${hydration.backfilled}`);
          }
        } catch (hydrateError) {
          console.warn('Durable learning corpus hydrate skipped:', hydrateError);
        }

        const storedOutcomes = await getAllOutcomesFromStore();
        this.tradeOutcomes = (storedOutcomes.length > MAX_STORED_OUTCOMES
          ? storedOutcomes.slice(-MAX_STORED_OUTCOMES)
          : storedOutcomes) as unknown as TradeOutcome[];
        console.log(`✓ Loaded ${this.tradeOutcomes.length} trade outcomes from SQLite learning store`);
      } catch (migrationError) {
        console.error('Failed to load/migrate trade outcomes into SQLite learning store:', migrationError);
      }
      
      if (weightsData) {
        const weightsObj = JSON.parse(weightsData);
        this.modelWeights = new Map(weightsObj.weights || weightsObj);
        if (weightsObj.lastTrainingTime && weightsObj.lastTrainingTime > 0) {
          this.lastTrainingTime = weightsObj.lastTrainingTime;
          const daysSince = (Date.now() - this.lastTrainingTime) / (24 * 60 * 60 * 1000);
          console.log(`✓ Loaded model weights and training time from storage: ${new Date(this.lastTrainingTime).toISOString()} (${daysSince.toFixed(1)} days ago)`);
          
          const shouldRetrain = daysSince > 2;
          if (shouldRetrain) {
            console.log(`⚠️ Model is ${daysSince.toFixed(1)} days old - retrain scheduled for next low-liquidity window`);
            this.retrainScheduled = true;
          }
        } else {
          console.log('⚠️ No previous training time found - initializing fresh model');
          this.lastTrainingTime = Date.now();
          console.log(`✓ Model initialized at: ${new Date(this.lastTrainingTime).toISOString()}`);
        }
      } else {
        console.log('⚠️ No model weights found in storage - initializing fresh model');
        this.lastTrainingTime = Date.now();
        console.log(`✓ Model initialized at: ${new Date(this.lastTrainingTime).toISOString()}`);
      }
      
      if (dailyOHLCData) {
        this.dailyOHLCHistory = JSON.parse(dailyOHLCData);
        console.log(`✓ Loaded ${this.dailyOHLCHistory.length} daily OHLC bars from storage`);
        if (this.dailyOHLCHistory.length > 0) {
          const latest = this.dailyOHLCHistory[this.dailyOHLCHistory.length - 1];
          console.log(`   Latest bar: ${latest.date} (Close: ${latest.close.toFixed(1)})`);
        }
      }
      
      await this.loadFeatureDriftHistory();
      
      // Bug fix: loadFeatureDriftHistory() restores conceptDriftScore/driftAlertLevel from
      // storage but never recomputed modelHealthScore, so health stayed at its default (100)
      // until an unrelated event (trade outcome, correlation check, retrain) triggered a
      // recompute — producing contradictory dashboard states like Health 100/100 alongside
      // a HIGH drift alert. Recompute immediately after restoring drift state.
      this.updateModelHealthScore();
      
      return this.dailyOHLCHistory;
    } catch (error) {
      console.error('Failed to load learning data:', error);
      return [];
    }
  }
  
  private async saveDailyOHLCHistory(): Promise<void> {
    try {
      await AsyncStorage.setItem(DAILY_OHLC_STORAGE_KEY, JSON.stringify(this.dailyOHLCHistory));
      console.log(`✓ Saved ${this.dailyOHLCHistory.length} daily OHLC bars to storage`);
    } catch (error) {
      console.error('Failed to save daily OHLC history:', error);
    }
  }
  
  private calculateDynamicCooldown(marketRegime: MarketRegime, confidence: number, adx: number | null = null): number {
    // D21: Regime-scale cooldown (TRENDING 30-60s, RANGING 90s, VOLATILE 180s, QUIET 150s)
    const BASE_COOLDOWN = 60000;
    const MIN_COOLDOWN = 30000;
    const MAX_COOLDOWN = 180000;
    
    let cooldownMultiplier = 1.0;
    
    // Proposal #14: Drop TRENDING cooldown to 15-25s when ADX>30
    const strongAdx = adx !== null && adx > 30;
    if (marketRegime.type === 'TRENDING' && marketRegime.strength > 0.75 && strongAdx) {
      cooldownMultiplier = 0.25;
      console.log(`📊 Regime: STRONG TRENDING + ADX ${adx?.toFixed(1)}>30 - cooldown 15s`);
    } else if (marketRegime.type === 'TRENDING' && strongAdx) {
      cooldownMultiplier = 0.4;
      console.log(`📊 Regime: TRENDING + ADX ${adx?.toFixed(1)}>30 - cooldown 24s`);
    } else if (marketRegime.type === 'TRENDING' && marketRegime.strength > 0.75) {
      cooldownMultiplier = 0.5;
      console.log('📊 Regime: STRONG TRENDING - cooldown 30s');
    } else if (marketRegime.type === 'TRENDING') {
      cooldownMultiplier = 0.75;
      console.log('📊 Regime: TRENDING - cooldown 45s');
    } else if (marketRegime.type === 'VOLATILE') {
      cooldownMultiplier = 3.0;
      console.log('📊 Regime: VOLATILE - cooldown 180s (noise protection)');
    } else if (marketRegime.type === 'RANGING') {
      cooldownMultiplier = 1.5;
      console.log('📊 Regime: RANGING - cooldown 90s');
    } else if (marketRegime.type === 'QUIET') {
      cooldownMultiplier = 2.5;
      console.log('📊 Regime: QUIET - cooldown 150s');
    }
    
    if (confidence >= 0.90) {
      cooldownMultiplier *= 0.45;
      console.log('🚀 Ultra-high confidence (≥90%) - 55% cooldown reduction');
    } else if (confidence >= 0.84) {
      cooldownMultiplier *= 0.65;
      console.log('⚡ High confidence (≥84%) - 35% cooldown reduction');
    } else if (confidence >= 0.76) {
      cooldownMultiplier *= 0.82;
      console.log('⚡ Strong confidence (≥76%) - 18% cooldown reduction');
    }
    
    const calculatedCooldown = BASE_COOLDOWN * cooldownMultiplier;
    const EFFECTIVE_MIN_COOLDOWN = (marketRegime.type === 'TRENDING' && strongAdx) ? 15000 : MIN_COOLDOWN;
    const finalCooldown = Math.max(EFFECTIVE_MIN_COOLDOWN, Math.min(MAX_COOLDOWN, calculatedCooldown));
    
    console.log(`⏱️ Dynamic Cooldown: ${(finalCooldown / 1000).toFixed(1)}s (Base: ${BASE_COOLDOWN / 1000}s, Multiplier: ${cooldownMultiplier.toFixed(2)}x)`);
    
    return finalCooldown;
  }
  
  private shouldSuppressMacroEvent(macroEvent: MacroEvent | undefined): boolean {
    if (!macroEvent) return false;
    
    const suppressionWindow = 30;
    
    if (macroEvent.timeUntilEvent < suppressionWindow && macroEvent.impact === 'HIGH') {
      console.log(`⚠️ HIGH IMPACT EVENT: ${macroEvent.name} in ${macroEvent.timeUntilEvent} minutes. Signal suppressed.`);
      return true;
    }
    
    if (macroEvent.timeUntilEvent < 10 && macroEvent.impact === 'MEDIUM') {
      console.log(`⚠️ MEDIUM IMPACT EVENT: ${macroEvent.name} in ${macroEvent.timeUntilEvent} minutes. Signal suppressed.`);
      return true;
    }
    
    if (macroEvent.timeUntilEvent < suppressionWindow) {
      console.log(`📢 ADVISORY: ${macroEvent.name} in ${macroEvent.timeUntilEvent} minutes. Signal allowed with warning.`);
    }
    
    return false;
  }
  
  async generateSignal(
    settings: { tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number; minConfidence: number; useDynamicSL?: boolean; maxSLPips?: number; allowShortSignals?: boolean },
    accountBalance: number = 10000,
    activeSignals: TradingSignal[] = []
  ): Promise<TradingSignal | null> {
    const now = Date.now();
    const startTime = performance.now();
    this.signalGenerationAttempts++;
    this.recentAttemptTimestamps.push(now);
    this.getRecentAttemptCount(now);
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 SIGNAL GENERATION ATTEMPT #${this.signalGenerationAttempts}`);
    console.log(`${'='.repeat(80)}`);
    
    if (isWithinDailyMarketClose()) {
      const nowDate = new Date();
      console.log(`❌ REJECTED: Daily market-close break (22:59-23:59 UTC+2 / 20:59-21:59 UTC). No signals during this hour. Current UTC ${nowDate.getUTCHours()}:${String(nowDate.getUTCMinutes()).padStart(2, '0')}`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    
    const fullyActiveSignals = activeSignals.filter((signal) => (
      signal.status === "ACTIVE" && signal.confidence >= ENFORCED_MIN_SIGNAL_CONFIDENCE
    ));
    
    console.log(`🔍 Signal Status Check:`);
    console.log(`   Active Signals: ${fullyActiveSignals.length}`);
    
    const trendChangeDetected = this.detectTrendChange();
    const largePriceMovement = this.detectLargePriceMovement();
    const cooldownElapsed = now - this.lastSignalTime;
    
    let exceptionConditionActive = false;
    if (trendChangeDetected || largePriceMovement) {
      console.log(`\n🚨 EXCEPTION DETECTED - Override Conditions:`);
      if (trendChangeDetected) {
        console.log(`   ✅ TREND CHANGE: Market regime shift detected`);
      }
      if (largePriceMovement) {
        console.log(`   ✅ LARGE PRICE MOVEMENT: Significant price action (${largePriceMovement.toFixed(1)} pips in 5 minutes)`);
      }
      console.log(`   → Bypassing standard cooldown and proximity filters`);
      console.log(`   ⚠️  IMPORTANT: Structural validation STILL REQUIRED\n`);
      exceptionConditionActive = true;
    } else {
      // H38: separate BUY/SELL cooldown timers
      const MIN_GLOBAL_COOLDOWN_MS = 30000;
      if (this.lastSignalTime > 0 && cooldownElapsed < MIN_GLOBAL_COOLDOWN_MS) {
        const remainingCooldown = ((MIN_GLOBAL_COOLDOWN_MS - cooldownElapsed) / 1000).toFixed(1);
        console.log(`⏱️ EARLY COOLDOWN: ${remainingCooldown}s min cooldown remaining — deferring expensive analysis`);
        console.log(`${'='.repeat(80)}\n`);
        return null;
      }
    }
    
    const livePriceAgeMs = Date.now() - lastFetchTime;
    if (this.currentPrice > 0 && livePriceAgeMs < EXTERNAL_PRICE_MAX_AGE_MS) {
      console.log(`📡 Signal generation using live chart/feed price ${this.currentPrice.toFixed(2)} from ${lastPriceSource} (${livePriceAgeMs}ms old)`);
    } else {
      await this.updateCurrentPrice();
    }
    
    if (this.currentPrice <= 0) {
      console.log('❌ REJECTED: No valid price available yet - cannot generate signal');
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    
    const features = await this.calculateMarketFeatures();
    
    await this.detectConceptDrift(features);
    
    const endTime = performance.now();
    const latency = endTime - startTime;
    
    const analysis = this.enhancedTransformerAnalysis(features);
    const dynamicCooldown = this.calculateDynamicCooldown(features.marketRegime, analysis.confidence, features.adx);
    
    // Proposal #1 + #3 + #10: Fast-path signals
    const fastPath = this.detectFastPathSignal(features, analysis);
    if (fastPath.active) {
      console.log(`⚡ FAST-PATH ACTIVATED: ${fastPath.reason}`);
      analysis.confidence = Math.max(analysis.confidence, fastPath.minConfidence);
      analysis.signalType = fastPath.signalType ?? analysis.signalType;
    }
    
    // PHASE 2 (measurement integrity): a non-finite confidence silently DEFEATS
    // every downstream gate, because in JS `NaN < threshold` is false - so a
    // NaN-confidence signal passes the session floor, the counter-trend premium,
    // the absolute engine floor and the quality gate all at once. Confirmed
    // pre-existing (NaN confidences appear in simulation runs recorded before
    // this Phase 2 work), which is why some sandbox signals reported
    // `confidence=NaN%`. Fail closed instead of trading on an unknown number.
    if (!Number.isFinite(analysis.confidence)) {
      console.log(`❌ REJECTED: non-finite confidence (${String(analysis.confidence)}) — failing closed`);
      console.log(`   💡 A NaN confidence would bypass every threshold comparison, so the signal is discarded rather than trusted.`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }

    const htfTrend = this.detectHTFTrend(features);
    const ltfTrendForGate = this.detectLTFTrend();

    // ── PHASE B2: STAND-ASIDE SAFETY GATE ───────────────────────────────
    // When allowShortSignals is FALSE and HTF trend is BEARISH, the system
    // cannot trade the correct direction (SELL is suppressed) and must NOT
    // trade the wrong one (BUY against a bearish daily trend). A system that
    // cannot trade the correct direction stands aside rather than forcing a
    // counter-trend entry. This single gate would have prevented all four
    // 31 July losses (-$31.9 on a -401 pip downtrend day where 3 of 4 losing
    // BUYs scored "STRONG UPTREND" due to the tick-level HTF defect fixed in B1).
    //
    // This is placed BEFORE any internal state mutations (cooldown, lock,
    // lastSignalType) — a stand-aside does not consume cooldown or block the
    // next signal. It is logged with a distinct reason so it is visible in
    // diagnostics and near-miss tracking.
    const allowShortSignals = settings.allowShortSignals !== false;
    if (!allowShortSignals && analysis.signalType === 'BUY' && htfTrend === 'BEARISH') {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`🛑 STAND-ASIDE: BUY signal blocked — HTF trend is BEARISH and SELL is suppressed`);
      console.log(`   The system cannot trade the correct direction (SELL suppressed) and will not trade the wrong one (BUY against bearish HTF).`);
      console.log(`   Confidence: ${(analysis.confidence * 100).toFixed(1)}% | HTF: ${htfTrend} | LTF: ${ltfTrendForGate} | Regime: ${features.marketRegime.type}`);
      console.log(`   Price: ${this.currentPrice.toFixed(1)} | Daily Pivot: ${features.dailyPivot.toFixed(1)}`);
      console.log(`${'='.repeat(80)}\n`);
      this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'stand-aside: bearish HTF with SELL suppressed', {
        entryPrice: this.currentPrice,
        atr: features.atr,
        tp1Pips: settings.tp1Pips,
        tp2Pips: settings.tp2Pips,
        tp3Pips: settings.tp3Pips,
        slPips: settings.slPips,
      });
      return null;
    }

    // PHASE 2 (B1) COUNTER-TREND GATE REPAIR.
    // Pre-fix, a signal only counted as counter-trend when the DAILY trend
    // directly opposed it. The dominant real failure mode in the audit was a
    // SELL fired while HTF was NEUTRAL but the intraday (LTF) trend was
    // climbing: that combination classified as 'NEUTRAL' and therefore skipped
    // BOTH the confidence premium here AND the structural counter-trend branch
    // in validateStructuralConditions (whose neutral fallthrough returns
    // valid:true unconditionally). Adding the HTF-neutral/LTF-opposed case is
    // the actual repair; the RSI-extreme cases are retained unchanged.
    const isCounterTrendSignal = (
      (analysis.signalType === 'BUY' && htfTrend === 'BEARISH') ||
      (analysis.signalType === 'SELL' && htfTrend === 'BULLISH') ||
      (analysis.signalType === 'BUY' && htfTrend === 'NEUTRAL' && ltfTrendForGate === 'BEARISH') ||
      (analysis.signalType === 'SELL' && htfTrend === 'NEUTRAL' && ltfTrendForGate === 'BULLISH') ||
      (analysis.signalType === 'BUY' && htfTrend === 'NEUTRAL' && features.rsi < 35) ||
      (analysis.signalType === 'SELL' && htfTrend === 'NEUTRAL' && features.rsi > 65)
    );

    // PHASE 2 (B1) INTRADAY DRIFT VETO. Scoped to signals already classified
    // counter-trend: the worst observed day (2026-07-10: 17 SELL / 1 BUY, SELL
    // EV -1.00R, day net -$88.3) drifted +$13.8 while the classifier stayed
    // NEUTRAL, so the repaired classifier above now catches it and this veto
    // then refuses the entry outright unless a genuine sweep reversal is
    // confirmed AND conviction is very high.
    //
    // CALIBRATION NOTE: an earlier revision of this veto applied to EVERY signal
    // at 1.5 x ATR. The 24h replay measured 1,168 rejections from that rule
    // alone and total generation collapsed to ZERO signals - far outside the
    // 10-20/day mandate - because normal gold drifts more than 1.5 ATR in an
    // hour routinely, so it was also vetoing legitimate with-trend and
    // at-structure entries. Scoped + widened to 2.0 x ATR on that evidence.
    const recentDrift = isCounterTrendSignal ? this.computeRecentDrift() : null;
    if (recentDrift !== null && features.atr > 0) {
      const driftAgainst = analysis.signalType === 'BUY' ? -recentDrift : recentDrift;
      const driftVetoThreshold = features.atr * COUNTER_TREND_DRIFT_ATR_VETO;
      if (driftAgainst >= driftVetoThreshold) {
        const sweepReclaimConfirmed = features.sessionSweeps.some(s => s.reversalConfirmed);
        if (sweepReclaimConfirmed && analysis.confidence >= COUNTER_TREND_DRIFT_OVERRIDE_CONFIDENCE) {
          console.log(`✅ DRIFT VETO OVERRIDE: ${analysis.signalType} against $${driftAgainst.toFixed(2)} drift allowed on confirmed sweep reversal + ${(analysis.confidence * 100).toFixed(1)}% conviction`);
        } else {
          console.log(`❌ REJECTED: Counter-trend drift veto — ${analysis.signalType} fights a $${driftAgainst.toFixed(2)} adverse impulse (>= ${driftVetoThreshold.toFixed(2)} = ${COUNTER_TREND_DRIFT_ATR_VETO} x ATR ${features.atr.toFixed(1)})`);
          console.log(`   💡 TIP: Needs a CONFIRMED sweep reversal plus >=${(COUNTER_TREND_DRIFT_OVERRIDE_CONFIDENCE * 100).toFixed(0)}% conviction to trade against a live impulse of this size.`);
          console.log(`${'='.repeat(80)}\n`);
          this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'intraday drift veto', { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips });
          return null;
        }
      }
    }
    
    if (isCounterTrendSignal && !trendChangeDetected && !largePriceMovement) {
      // Proposal #5: Asymmetric gate - RSI extreme with confirmed sweep bypasses 5-min requirement
      const rsiExtreme = features.rsi < 25 || features.rsi > 75;
      const rsiMidRange = features.rsi >= 40 && features.rsi <= 60;
      const hasConfirmedSweep = features.sessionSweeps.some(s => s.reversalConfirmed);
      
      if (rsiExtreme && hasConfirmedSweep) {
        console.log(`✅ COUNTER-TREND RSI EXTREME + SWEEP: bypassing 5-min gate (RSI ${features.rsi.toFixed(1)})`);
      } else {
        const requires5MinConfirmation = this.requiresHigherTimeframeConfirmation();
        
        if (!requires5MinConfirmation.confirmed) {
          const altConfirmation = this.checkAlternativeCounterTrendConfirmation(analysis.signalType, features);
          if (altConfirmation.confirmed) {
            console.log(`✅ COUNTER-TREND ALT CONFIRMATION: ${altConfirmation.reason}`);
          } else if (rsiMidRange) {
            console.log(`❌ REJECTED: Counter-trend signal at mid-range RSI requires 5-min candle OR OB/QM/Sweep confirmation`);
            console.log(`   ${requires5MinConfirmation.reason}`);
            console.log(`   Alt check: ${altConfirmation.reason}`);
            console.log(`   💡 TIP: ${requires5MinConfirmation.tip}`);
            console.log(`${'='.repeat(80)}\n`);
            this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'counter-trend mid-RSI unconfirmed', { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips });
            return null;
          } else {
            console.log(`✅ COUNTER-TREND ASYMMETRIC: RSI ${features.rsi.toFixed(1)} not mid-range, accepting without 5-min gate`);
          }
        } else {
          console.log(`✅ COUNTER-TREND CONFIRMATION: 5-minute candle closed outside range`);
          console.log(`   ${requires5MinConfirmation.reason}`);
        }
      }
    }
    
    // Proposal #6: Session-aware threshold
    const utcHour = new Date().getUTCHours();
    // PHASE 2 (A1): hard clock blocks on the two measured dead hours
    // (h11 EV -0.497R, h04 EV -0.409R in the 340-trade audit).
    if (BLOCKED_UTC_HOURS.includes(utcHour)) {
      console.log(`❌ REJECTED: UTC hour ${utcHour} is a blocked window (measured negative expectancy across the audited sample)`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    const isPowerHour = utcHour >= UTC_HOURS.NY_LONDON_START && utcHour < UTC_HOURS.NY_LONDON_END;
    const isLowLiquidity = (utcHour >= 22 || utcHour < 6);
    let sessionFloor = ENFORCED_MIN_SIGNAL_CONFIDENCE;
    if (isPowerHour) {
      sessionFloor = ENFORCED_MIN_CONFIDENCE_POWER_HOUR;
      console.log(`⏰ POWER HOUR: lowering enforced floor to ${(sessionFloor * 100).toFixed(0)}%`);
    } else if (isLowLiquidity) {
      sessionFloor = ENFORCED_MIN_CONFIDENCE_LOW_LIQUIDITY;
      console.log(`⏰ LOW LIQUIDITY: raising enforced floor to ${(sessionFloor * 100).toFixed(0)}%`);
    }
    // PHASE 2 (A1): demote (not block) the marginal hours h12/h15/h17.
    if (ELEVATED_FLOOR_UTC_HOURS.includes(utcHour)) {
      sessionFloor += ELEVATED_HOUR_CONFIDENCE_PREMIUM;
      console.log(`⏰ MARGINAL HOUR ${utcHour} UTC: floor raised to ${(sessionFloor * 100).toFixed(0)}% (+${(ELEVATED_HOUR_CONFIDENCE_PREMIUM * 100).toFixed(0)}pp)`);
    }
    const requestedMinConfidence = Math.max(sessionFloor, settings.minConfidence);

    console.log(`🎯 Preliminary Analysis:`);
    console.log(`   Signal Type: ${analysis.signalType}`);
    console.log(`   Confidence: ${(analysis.confidence * 100).toFixed(1)}% (Min Required: ${(requestedMinConfidence * 100).toFixed(0)}%)`);
    console.log(`   Market Regime: ${features.marketRegime.type} (Strength: ${(features.marketRegime.strength * 100).toFixed(0)}%)`);
    console.log(`   Final Cooldown: ${(dynamicCooldown / 1000).toFixed(1)}s`);
    
    if (this.lastSignalTime > 0 && cooldownElapsed < dynamicCooldown) {
      const remainingCooldown = ((dynamicCooldown - cooldownElapsed) / 1000).toFixed(1);
      console.log(`❌ REJECTED: Dynamic cooldown active: ${remainingCooldown}s remaining (Regime: ${features.marketRegime.type})`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    
    // PHASE 2 (A2): post-stop, same-direction cooldown.
    const lastStopOutTime = analysis.signalType === 'BUY' ? this.lastBuyStopOutTime : this.lastSellStopOutTime;
    if (lastStopOutTime > 0 && (now - lastStopOutTime) < POST_STOP_SAME_DIRECTION_COOLDOWN_MS) {
      const remainingMin = ((POST_STOP_SAME_DIRECTION_COOLDOWN_MS - (now - lastStopOutTime)) / 60000).toFixed(1);
      console.log(`❌ REJECTED: Post-stop cooldown — a ${analysis.signalType} was stopped out ${(((now - lastStopOutTime)) / 60000).toFixed(1)} min ago (${remainingMin} min remaining)`);
      console.log(`   💡 TIP: Same-direction re-entry within 15 min of a stop won only 13.3% of the time in the audited sample. Let structure re-form.`);
      console.log(`${'='.repeat(80)}\n`);
      this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'post-stop cooldown', { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips });
      return null;
    }

    const macroEvent = this.detectMacroEvents();
    if (this.shouldSuppressMacroEvent(macroEvent)) {
      console.log(`❌ REJECTED: Macro event suppression (${macroEvent?.name})`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    
    let effectiveMinConfidence = requestedMinConfidence;
    // #2 HTF-alignment veto. detectHTFTrend is a real filter here, not just a soft
    // bonus: a signal that fights a clear higher-timeframe (daily) trend must clear
    // a +5% confidence premium on top of the session floor. Counter-trend gold setups
    // are the lowest win-rate bucket, so we only take the highest-quality ones.
    if (isCounterTrendSignal) {
      effectiveMinConfidence = Math.max(effectiveMinConfidence, requestedMinConfidence + COUNTER_TREND_CONFIDENCE_PREMIUM);
      console.log(`🧭 COUNTER-TREND vs HTF ${htfTrend}: confidence floor raised to ${(effectiveMinConfidence * 100).toFixed(0)}%`);
    }
    // H40 + Proposal #2: Tighten starvation relief - require TRENDING regime + ADX>20
    const lastSignalAgeMs = this.lastSignalTime > 0 ? (now - this.lastSignalTime) : Number.POSITIVE_INFINITY;
    const starvationEligibleRegime = (
      features.marketRegime.type === 'TRENDING' &&
      features.adx !== null && features.adx > 20
    );
    const starvationReliefActive = (
      lastSignalAgeMs > STARVATION_GAP_MS &&
      this.getRecentAttemptCount(now) >= SIGNAL_STARVATION_RELIEF_ATTEMPTS &&
      starvationEligibleRegime
    );
    if (lastSignalAgeMs > STARVATION_GAP_MS && !starvationEligibleRegime) {
      console.log(`ℹ️ Starvation gap reached but regime ${features.marketRegime.type} / ADX ${features.adx?.toFixed(1) ?? 'n/a'} not eligible - relief suppressed`);
    }
    
    if (this.driftAlertLevel === 'HIGH') {
      effectiveMinConfidence = Math.max(requestedMinConfidence, 0.80);
      console.log(`🔶 HIGH DRIFT DETECTED: Confidence threshold temporarily elevated`);
      console.log(`   Base Threshold: ${(settings.minConfidence * 100).toFixed(0)}%`);
      console.log(`   Elevated Threshold: ${(effectiveMinConfidence * 100).toFixed(0)}%`);
      console.log(`   Reason: Protecting capital during market regime shift`);
      console.log(`   Duration: Until next model retrain (48h max)\n`);
    }

    if (starvationReliefActive) {
      const relievedThreshold = Math.min(effectiveMinConfidence, SIGNAL_STARVATION_RELIEF_CONFIDENCE);
      if (relievedThreshold !== effectiveMinConfidence) {
        console.log(`🟢 SIGNAL STARVATION RELIEF ACTIVE: ${this.signalGenerationAttempts} attempts with no signals`);
        console.log(`   Confidence threshold relaxed from ${(effectiveMinConfidence * 100).toFixed(0)}% to ${(relievedThreshold * 100).toFixed(0)}%`);
        console.log(`   Structural validation, cooldowns, and macro-event suppression remain enforced`);
        effectiveMinConfidence = relievedThreshold;
      }
    }
    
    // Proposal #12: EV-weighted acceptance
    const tentativeAtrMultiplier = Math.max(1.0, Math.min(1.6, 0.7 + features.atr * 0.06));
    const evScore = this.computeExpectedValue(analysis.confidence, settings.tp2Pips, settings.slPips, tentativeAtrMultiplier);
    const evReliefEligible = (
      analysis.confidence >= EV_RELIEF_CONFIDENCE_FLOOR &&
      analysis.confidence < effectiveMinConfidence &&
      evScore >= EV_RELIEF_THRESHOLD &&
      this.driftAlertLevel !== 'HIGH'
    );
    if (evReliefEligible) {
      console.log(`💰 EV RELIEF: confidence ${(analysis.confidence * 100).toFixed(1)}% with EV ${evScore.toFixed(2)}R (>= ${EV_RELIEF_THRESHOLD}R) allows below ${(effectiveMinConfidence * 100).toFixed(0)}% floor`);
      effectiveMinConfidence = EV_RELIEF_CONFIDENCE_FLOOR;
    }
    
    if (analysis.confidence < effectiveMinConfidence) {
      console.log(`❌ REJECTED: Confidence ${(analysis.confidence * 100).toFixed(1)}% below threshold ${(effectiveMinConfidence * 100).toFixed(0)}% (EV ${evScore.toFixed(2)}R)`);
      if (this.driftAlertLevel === 'HIGH') {
        console.log(`   ⚠️ Elevated threshold active due to HIGH CONCEPT DRIFT`);
      }
      console.log(`   💡 TIP: Confidence ${(analysis.confidence * 100).toFixed(1)}% below ${(effectiveMinConfidence * 100).toFixed(0)}% threshold. Wait for stronger alignment or adjust threshold in settings.`);
      console.log(`${'='.repeat(80)}\n`);
      this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, `below threshold ${(effectiveMinConfidence * 100).toFixed(0)}%`, { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips });
      return null;
    }
    
    const absoluteConfidenceFloor = starvationReliefActive
      ? ABSOLUTE_MIN_SIGNAL_CONFIDENCE
      : Math.max(ABSOLUTE_MIN_SIGNAL_CONFIDENCE, effectiveMinConfidence - 0.03);

    if (analysis.confidence < absoluteConfidenceFloor) {
      console.log(`❌ REJECTED: Confidence ${(analysis.confidence * 100).toFixed(1)}% below engine floor ${(absoluteConfidenceFloor * 100).toFixed(0)}%`);
      console.log(`   Engine floor keeps low-quality setups out even if user threshold is lower`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    
    const qualityGate = this.evaluateQualityGate(analysis, features);
    if (!qualityGate.passed) {
      console.log(`❌ REJECTED: Quality Gate — ${qualityGate.reason}`);
      console.log(`   💡 ${qualityGate.tip}`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    console.log(`✅ QUALITY GATE PASSED: ${qualityGate.summary}`);

    const structuralValidation = this.validateStructuralConditions(analysis.signalType, features, settings);
    if (!structuralValidation.valid) {
      console.log(`❌ REJECTED: Structural Validation Failed`);
      if (exceptionConditionActive) {
        console.log(`   🛡️  EXCEPTION BLOCKED: Large movement/trend change detected BUT structural conditions not met`);
        console.log(`   This prevents false signals during volatility spikes`);
      }
      console.log(`   ${structuralValidation.reason}`);
      console.log(`   💡 TIP: ${structuralValidation.tip}`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    
    if (exceptionConditionActive) {
      console.log(`✅ EXCEPTION + STRUCTURAL VALIDATION: Both conditions met`);
      console.log(`   Large movement/trend change confirmed by structural levels`);
      console.log(`   This combination indicates high-probability setup\n`);
    }

    if (!exceptionConditionActive) {
      const proximityCheck = this.checkPriceProximity(activeSignals, analysis.signalType, dynamicCooldown);
      if (proximityCheck.blocked) {
        console.log(`❌ REJECTED: Price Proximity Filter Block`);
        console.log(`   ${proximityCheck.reason}`);
        console.log(`   💡 TIP: ${proximityCheck.tip}`);
        console.log(`${'='.repeat(80)}\n`);
        return null;
      }
    } else {
      console.log(`✅ PROXIMITY CHECK BYPASSED: Exception condition active (already passed structural validation)`);
    }
    
    if (this.lastSignalType !== null && this.lastSignalType !== analysis.signalType) {
      // Proposal #9: Allow reversal if previous signal already resolved (TP1+ or SL)
      const previousResolved = activeSignals.some(s =>
        s.type === this.lastSignalType &&
        (s.targetsHit >= 1 || s.status === 'SL_HIT' || s.status === 'SL_AFTER_BE' ||
         s.status === 'ALL_TARGETS_HIT' || s.status === 'TP3_HIT' || s.status === 'PARTIAL_WIN_SL_HIT' ||
         s.status === 'CLOSED')
      ) || !activeSignals.some(s => s.type === this.lastSignalType && s.status === 'ACTIVE');
      const MIN_OVERRIDE_CONFIDENCE = 0.55;
      const opposingStrength = analysis.signalType === 'BUY' ? analysis.attentionScores.get('htf_ltf_bearish_alignment') || 0 : analysis.attentionScores.get('htf_ltf_bullish_alignment') || 0;
      
      if (previousResolved) {
        console.log(`✅ PRIOR SIGNAL RESOLVED: ${this.lastSignalType} already managed/closed - reversal allowed`);
        this.resetSignalLock();
      } else if (analysis.confidence < MIN_OVERRIDE_CONFIDENCE || opposingStrength > 0.15) {
        console.log(`❌ REJECTED: Signal conflict prevention`);
        console.log(`   Last Signal: ${this.lastSignalType}, New Signal: ${analysis.signalType}`);
        console.log(`   New Signal Confidence: ${(analysis.confidence * 100).toFixed(1)}% (Min: ${(MIN_OVERRIDE_CONFIDENCE * 100).toFixed(0)}%)`);
        console.log(`   Opposing Signal Strength: ${(opposingStrength * 100).toFixed(1)}% (Max: 15%)`);
        console.log(`   💡 CONFLICT RESOLUTION: New signal must be >55% confident AND opposing signal <15% strength`);
        console.log(`${'='.repeat(80)}\n`);
        this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'conflict with last signal type', { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips });
        return null;
      } else {
        console.log(`✅ SIGNAL OVERRIDE APPROVED: Conflict check passed`);
        console.log(`   ${this.lastSignalType} -> ${analysis.signalType}`);
        console.log(`   Confidence: ${(analysis.confidence * 100).toFixed(1)}%, Opposing Strength: ${(opposingStrength * 100).toFixed(1)}%`);
        this.resetSignalLock();
      }
    }
    
    const entryPrice = this.currentPrice;
    
    const slippageBuffer = this.calculateDynamicSlippage(features.marketRegime, latency);
    const spreadPips = this.lastKnownSpreadPips > 0 ? this.lastKnownSpreadPips : 0;
    const totalSlippage = slippageBuffer + spreadPips;
    const entryPriceWithSlippage = analysis.signalType === "BUY" 
      ? entryPrice + (totalSlippage * 0.1)
      : entryPrice - (totalSlippage * 0.1);
    if (spreadPips > 0) console.log(`💵 Real bid/ask spread applied: ${spreadPips.toFixed(2)} pips`);
    
    console.log(`💰 Dynamic Slippage Buffer: ${slippageBuffer.toFixed(2)} pips (Regime: ${features.marketRegime.type}, Latency: ${latency.toFixed(0)}ms)`);
    
    const pipValue = 0.1;
    
    // ============ PHASE 2 (B2 + B3): 1.4R SCALPER GEOMETRY ============
    // The system is now FORMALLY scoped as a 1.4R scalper: the TP ladder is a
    // pure multiple of the realised risk distance, so reward-to-risk can no
    // longer drift with independently-configured pip settings. This replaces
    // three interacting faults measured in the audit:
    //   1. SL sat INSIDE the noise floor (median 0.90 ATR, p10 0.23 ATR) - all
    //      139 SL hits resolved at exactly -1.000R, the signature of
    //      noise-triggered stops. Stops now clear 1.2 x ATR by construction.
    //   2. The "Low Volatility" label reached ATR 7.9 and then applied a 0.80x
    //      TIGHTER stop, amplifying (1). The 0.80x floor is gone (min 1.00x) and
    //      the regime boundaries are re-derived from the real ATR distribution.
    //   3. TP1 sat at 0.50R while every loss was a full -1.00R, forcing a 53.9%
    //      breakeven win rate. TP1 is now 0.70R, TP2 1.05R, TP3 1.40R, so the
    //      breakeven win rate drops below 50% at the same hit distribution.
    const useDynamicSL = settings.useDynamicSL !== false;
    const maxSLPips = settings.maxSLPips ?? 90;
    const atrMultiplier = useDynamicSL
      ? parseFloat(Math.max(1.0, Math.min(1.6, 0.7 + features.atr * 0.06)).toFixed(2))
      : 1.0;
    // ATR is in PRICE units (calculateRealATR averages high-low true ranges on
    // raw bars), so the pip-denominated noise floor is atr * multiple / pipValue.
    const atrFloorSlPips = (features.atr * MIN_SL_ATR_MULTIPLE) / pipValue;
    if (atrFloorSlPips > maxSLPips) {
      console.log(`❌ REJECTED: noise floor unreachable — a ${MIN_SL_ATR_MULTIPLE} x ATR stop needs ${atrFloorSlPips.toFixed(0)} pips but maxSLPips is ${maxSLPips} (ATR ${features.atr.toFixed(1)})`);
      console.log(`   💡 TIP: Volatility is too high to place a stop outside the noise floor within the risk cap. High-ATR conditions measured EV -0.030R / PF 0.94 in the audit.`);
      console.log(`${'='.repeat(80)}\n`);
      this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'ATR noise floor exceeds SL cap', { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips });
      return null;
    }
    const configuredSlPips = settings.slPips * atrMultiplier;
    const rawSlPips = Math.max(configuredSlPips, atrFloorSlPips);
    if (atrFloorSlPips > configuredSlPips) {
      console.log(`🛡️ SL widened to the ${MIN_SL_ATR_MULTIPLE} x ATR noise floor: ${atrFloorSlPips.toFixed(1)} pips (configured would have been ${configuredSlPips.toFixed(1)})`);
    }
    const dynamicSlPips = Math.min(rawSlPips, maxSLPips);
    if (rawSlPips > maxSLPips) {
      console.log(`🛡️ SL capped at maxSLPips ${maxSLPips} (would have been ${rawSlPips.toFixed(1)})`);
    }

    // Re-derived volatility labels (B2). Pre-fix: Low < 8, High > 10, which put
    // ~60% of all signals - including ATR 5-to-8 conditions - in "Low".
    const volatilityLabel = features.atr > VOL_REGIME_ATR_HIGH_MIN
      ? "High Volatility"
      : features.atr < VOL_REGIME_ATR_LOW_MAX ? "Low Volatility" : "Normal Volatility";
    const slAtrMultiple = (dynamicSlPips * pipValue) / Math.max(features.atr, 0.01);
    const riskJustification = `SL ${dynamicSlPips.toFixed(0)}p (${slAtrMultiple.toFixed(2)}x ATR) | Multiplier: ${atrMultiplier.toFixed(2)}x (${volatilityLabel} | ATR: ${features.atr.toFixed(1)}) | 1.4R scalper scope`;

    // TP ladder as pure R-multiples of the FINAL risk distance. TP3 may stretch
    // to 1.5R/1.6R only when conviction is high AND there is measured room to
    // the next real barrier - it can never shrink below the 1.4R scope.
    const roomToSR = this.computeRoomToSR(analysis.signalType, features);
    const atrUnits = roomToSR / Math.max(features.atr, 1);
    let tp3R: number = SCALPER_TP_R_MULTIPLES.tp3;
    if (analysis.confidence >= 0.89 && atrUnits >= 3) tp3R = SCALPER_TP3_STRETCH_MAX_R;
    else if (analysis.confidence >= 0.82 && atrUnits >= 2.5) tp3R = SCALPER_TP3_STRETCH_R;
    const tp1Distance = dynamicSlPips * SCALPER_TP_R_MULTIPLES.tp1;
    const tp2Distance = dynamicSlPips * SCALPER_TP_R_MULTIPLES.tp2;
    const tp3Distance = dynamicSlPips * tp3R;
    const grossTp3Dollars = tp3Distance * pipValue;
    console.log(`🎯 1.4R SCALPER LADDER: TP1 ${tp1Distance.toFixed(1)}p (${SCALPER_TP_R_MULTIPLES.tp1}R) | TP2 ${tp2Distance.toFixed(1)}p (${SCALPER_TP_R_MULTIPLES.tp2}R) | TP3 ${tp3Distance.toFixed(1)}p (${tp3R}R) | SL ${dynamicSlPips.toFixed(1)}p`);
    console.log(`   room-to-SR ${roomToSR.toFixed(0)}p / ATR ${atrUnits.toFixed(1)}u → TP3 stretch ${tp3R}R`);
    console.log(`💵 Cost-adjusted TP3: gross $${grossTp3Dollars.toFixed(2)} − $${EXECUTION_COST_PER_TRADE_USD.toFixed(2)} spread = net $${(grossTp3Dollars - EXECUTION_COST_PER_TRADE_USD).toFixed(2)} (${((grossTp3Dollars - EXECUTION_COST_PER_TRADE_USD) / Math.max(dynamicSlPips * pipValue, 0.01)).toFixed(2)}R net)`);
    
    const tp1 = entryPriceWithSlippage + (analysis.signalType === "BUY" ? 1 : -1) * tp1Distance * pipValue;
    const tp2 = entryPriceWithSlippage + (analysis.signalType === "BUY" ? 1 : -1) * tp2Distance * pipValue;
    const tp3 = entryPriceWithSlippage + (analysis.signalType === "BUY" ? 1 : -1) * tp3Distance * pipValue;
    const sl = entryPriceWithSlippage - (analysis.signalType === "BUY" ? 1 : -1) * dynamicSlPips * pipValue;
    
    const sortedAttention = Array.from(analysis.attentionScores.entries())
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3);
    
    const topFeatures: FeatureConfidence[] = sortedAttention.map(([feature, score]) => ({
      feature: feature.replace(/_/g, ' ').toUpperCase(),
      score: parseFloat((Math.abs(score) * 100).toFixed(1)),
    }));

    // Part B (diagnostics): capture EVERY entry in attentionScores, not just
    // the top 3 above. Purely additive - topFeatures/UI display is unchanged.
    const fullAttentionScores: FeatureConfidence[] = Array.from(analysis.attentionScores.entries())
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([feature, score]) => ({
        feature: feature.replace(/_/g, ' ').toUpperCase(),
        score: parseFloat((Math.abs(score) * 100).toFixed(1)),
      }));

    // Per-signal srZones snapshot: capture the exact detectSRZones() output
    // (post-decay, as opposing-structure veto / confluence gating actually saw
    // it for THIS signal) at generation time. Additive only, same pattern as
    // fullAttentionScores above -- no change to gating/scoring/generation logic.
    const srZonesSnapshot: DetectedSRZone[] = features.srZones.map(zone => ({
      price: zone.price,
      type: zone.type,
      touches: zone.touches,
      rejectionWicks: zone.rejectionWicks,
      reactionStrength: zone.reactionStrength,
      source: zone.source,
      confluenceScore: zone.confluenceScore,
      tier: zone.tier ?? 'TIER_1_LOCAL',
    }));
    
    // ── SELL SUPPRESSION CHECK ──────────────────────────────────────────────
    // Placed AFTER all geometry is computed but BEFORE any internal state
    // mutations (lastSignalType, lastSignalTime, cooldown, active-signal-lock,
    // successfulSignalsGenerated). A suppressed SELL never consumes the
    // cooldown or active-signal lock and can never block the next BUY.
    // The engine still fully scored and geometry-computed this SELL — only
    // the emission is suppressed. A shadow record is pushed (fire-and-forget)
    // to the durable shadow_signals_v1 Supabase table so the decision stays
    // monitorable against real forward data.
    // allowShortSignals was declared earlier (Phase B2 stand-aside gate)
    if (!allowShortSignals && analysis.signalType === 'SELL') {
      const shadowId = `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const htfTrendForShadow = this.detectHTFTrend(features);
      const ltfTrendForShadow = this.detectLTFTrend();
      const utcHourForShadow = new Date().getUTCHours();
      const sessionName = utcHourForShadow >= 0 && utcHourForShadow < 7 ? 'ASIA'
        : utcHourForShadow >= 7 && utcHourForShadow < 12 ? 'LONDON'
        : utcHourForShadow >= 12 && utcHourForShadow < 17 ? 'NY'
        : 'NY_PM';
      // +40pip shifted entry variant (77% fill rate in counterfactual)
      const shiftPips = 40;
      const entryShifted = entryPriceWithSlippage + shiftPips * pipValue;
      const slShifted = entryShifted + 70 * pipValue; // 70-pip SL
      const tp1Shifted = entryShifted - 30 * pipValue;
      const tp2Shifted = entryShifted - 60 * pipValue;
      const tp3Shifted = entryShifted - 90 * pipValue;

      console.log(`\n${'='.repeat(80)}`);
      console.log(`🚫 SELL SUPPRESSED (allowShortSignals=false)`);
      console.log(`${'='.repeat(80)}`);
      console.log(`📈 Type: SELL @ ${entryPriceWithSlippage.toFixed(1)} | Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
      console.log(`📊 Shadow record pushed to shadow_signals_v1 for forward monitoring`);
      console.log(`   Original:  entry=${entryPriceWithSlippage.toFixed(1)} SL=${sl.toFixed(1)} TP1=${tp1.toFixed(1)} TP2=${tp2.toFixed(1)} TP3=${tp3.toFixed(1)}`);
      console.log(`   Shifted:   entry=${entryShifted.toFixed(1)} SL=${slShifted.toFixed(1)} TP1=${tp1Shifted.toFixed(1)} TP2=${tp2Shifted.toFixed(1)} TP3=${tp3Shifted.toFixed(1)}`);
      console.log(`${'='.repeat(80)}\n`);

      const shadowRecord: ShadowSellRecord = {
        signalId: shadowId,
        createdAt: Date.now(),
        direction: 'SELL',
        entry: parseFloat(entryPriceWithSlippage.toFixed(1)),
        sl: parseFloat(sl.toFixed(1)),
        tp1: parseFloat(tp1.toFixed(1)),
        tp2: parseFloat(tp2.toFixed(1)),
        tp3: parseFloat(tp3.toFixed(1)),
        confidence: analysis.confidence,
        entryShifted: parseFloat(entryShifted.toFixed(1)),
        slShifted: parseFloat(slShifted.toFixed(1)),
        tp1Shifted: parseFloat(tp1Shifted.toFixed(1)),
        tp2Shifted: parseFloat(tp2Shifted.toFixed(1)),
        tp3Shifted: parseFloat(tp3Shifted.toFixed(1)),
        slMultiplier: parseFloat(atrMultiplier.toFixed(2)),
        atr: features.atr,
        regime: features.marketRegime.type,
        sessionName,
        hourUtc: utcHourForShadow,
        srZonesSnapshot: srZonesSnapshot,
        attentionScores: fullAttentionScores.map(f => ({ feature: f.feature, score: f.score })),
        htfTrend: htfTrendForShadow,
        ltfTrend: ltfTrendForShadow,
        rsi: features.rsi,
      };
      pushShadowSellRecord(shadowRecord);
      return null;
    }

    const nowLocal = new Date();
    const timeString = `${nowLocal.getHours().toString().padStart(2, "0")}:${nowLocal.getMinutes().toString().padStart(2, "0")}`;
    
    let latencyWarning: number | undefined;
    if (latency > LATENCY_WARNING_THRESHOLD_MS) {
      latencyWarning = parseFloat(latency.toFixed(0));
      console.log(`⚠️ High Latency Alert (${latency.toFixed(0)}ms). Entry price may have shifted.`);
    }
    
    const avgATR = features.atr;
    const estimatedMovePips = avgATR * 1.5;
    const estimatedTimeToTarget = (tp3Distance / estimatedMovePips) * 240;
    const timeToLiveMinutes = Math.round(estimatedTimeToTarget);
    
    let nextMoveContext: string | undefined;
    const oppositeType = analysis.signalType === "BUY" ? "SELL" : "BUY";
    if (features.marketRegime.type === 'VOLATILE') {
      const expectedCooldown = this.calculateDynamicCooldown(features.marketRegime, 0.85) / 1000;
      nextMoveContext = `NOTE: If SL is hit, next high-prob signal likely ${oppositeType} (~${expectedCooldown.toFixed(0)}s cooldown).`;
    } else if (features.marketRegime.type === 'TRENDING') {
      nextMoveContext = `NOTE: Trending regime detected. Continuation ${analysis.signalType} signal likely if TP1 hit.`;
    }
    
    this.lastSignalType = analysis.signalType;
    this.lastSignalTime = now;
    if (analysis.signalType === 'BUY') this.lastBuySignalTime = now; else this.lastSellSignalTime = now;
    this.lastMarketRegime = features.marketRegime;
    this.successfulSignalsGenerated++;
    this.signalsGeneratedCount++;
    
    const signalFrequencyRate = this.signalGenerationAttempts > 0 
      ? ((this.successfulSignalsGenerated / this.signalGenerationAttempts) * 100).toFixed(1)
      : '0.0';
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`✅ SIGNAL GENERATED #${this.successfulSignalsGenerated}`);
    console.log(`${'='.repeat(80)}`);
    console.log(`📈 Type: ${analysis.signalType} @ ${entryPriceWithSlippage.toFixed(1)} | Confidence: ${(analysis.confidence * 100).toFixed(1)}%`);
    console.log(`📊 Top Features: ${topFeatures.map(f => `${f.feature} (${f.score}%)`).join(', ')}`);
    console.log(`⚙️ ${riskJustification}`);
    console.log(`📊 Market Regime: ${features.marketRegime.type} (Strength: ${(features.marketRegime.strength * 100).toFixed(0)}%, Confidence: ${(features.marketRegime.confidence * 100).toFixed(0)}%)`);
    console.log(`🎯 Signal Generation Rate: ${signalFrequencyRate}% (${this.successfulSignalsGenerated} signals / ${this.signalGenerationAttempts} attempts)`);
    console.log(`⏱️ Next Dynamic Cooldown: ${(dynamicCooldown / 1000).toFixed(1)}s`);
    console.log(`⏰ Time-To-Live (TTL): ~${timeToLiveMinutes} minutes`);
    if (latencyWarning) {
      console.log(`⚠️ Latency Warning: ${latencyWarning}ms`);
    }
    if (nextMoveContext) {
      console.log(`💡 ${nextMoveContext}`);
    }
    if (macroEvent) {
      console.log(`⚠️ Warning: ${macroEvent.name} in ${macroEvent.timeUntilEvent} minutes`);
    }
    console.log(`${'='.repeat(80)}\n`);
    
    this.logSignalGenerationMetrics();
    
    return {
      id: `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      type: analysis.signalType,
      entryPrice: parseFloat(entryPrice.toFixed(1)),
      entryPriceWithSlippage: parseFloat(entryPriceWithSlippage.toFixed(1)),
      tp1: parseFloat(tp1.toFixed(1)),
      tp2: parseFloat(tp2.toFixed(1)),
      tp3: parseFloat(tp3.toFixed(1)),
      sl: parseFloat(sl.toFixed(1)),
      slMultiplier: parseFloat(atrMultiplier.toFixed(2)),
      confidence: analysis.confidence,
      status: "ACTIVE",
      targetsHit: 0,
      entryTime: timeString,
      topFeatures,
      fullAttentionScores,
      srZonesSnapshot,
      macroWarning: macroEvent,
      riskJustification,
      learningContext: this.buildLearningContext(features, {
        entryPrice: entryPriceWithSlippage,
        slDistance: Math.abs(entryPriceWithSlippage - sl),
        tp1Distance: Math.abs(tp1 - entryPriceWithSlippage),
        confidence: analysis.confidence,
      }),
      timeToLive: timeToLiveMinutes,
      nextMoveContext,
      latencyWarning,
      tp1Distance: parseFloat(tp1Distance.toFixed(1)),
      tp2Distance: parseFloat(tp2Distance.toFixed(1)),
      tp3Distance: parseFloat(tp3Distance.toFixed(1)),
      createdAt: Date.now(),
    };
  }
  
  private update5MinCandles(): void {
    const now = Date.now();
    const fiveMinMs = 5 * 60 * 1000;
    const currentCandleStartTime = Math.floor(now / fiveMinMs) * fiveMinMs;
    
    if (this.priceHistory.length === 0) return;
    
    const currentPrice = this.currentPrice;
    
    const existingCandleIndex = this.fiveMinCandles.findIndex(
      candle => candle.timestamp === currentCandleStartTime
    );
    
    if (existingCandleIndex >= 0) {
      const existingCandle = this.fiveMinCandles[existingCandleIndex];
      this.fiveMinCandles[existingCandleIndex] = {
        ...existingCandle,
        high: Math.max(existingCandle.high, currentPrice),
        low: Math.min(existingCandle.low, currentPrice),
        close: currentPrice,
      };
    } else {
      const newCandle = {
        timestamp: currentCandleStartTime,
        open: currentPrice,
        high: currentPrice,
        low: currentPrice,
        close: currentPrice,
      };
      this.fiveMinCandles.push(newCandle);
      
      if (this.fiveMinCandles.length > 1) {
        const previousCandle = this.fiveMinCandles[this.fiveMinCandles.length - 2];
        this.lastFiveMinCandleClose = previousCandle.timestamp;
        console.log(`📊 NEW 5-MIN CANDLE CLOSED:`);
        console.log(`   Time: ${new Date(previousCandle.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`);
        console.log(`   O: ${previousCandle.open.toFixed(1)} | H: ${previousCandle.high.toFixed(1)} | L: ${previousCandle.low.toFixed(1)} | C: ${previousCandle.close.toFixed(1)}`);
      }
      
      if (this.fiveMinCandles.length > 50) {
        this.fiveMinCandles.shift();
      }
    }
  }
  
  private detectTrendChange(): boolean {
    if (this.priceHistory.length < 10) return false;
    
    if (!this.lastMarketRegime) return false;
    
    const recentPrices = this.priceHistory.slice(-10);
    const oldPrices = this.priceHistory.slice(-20, -10);
    
    if (oldPrices.length === 0) return false;
    
    const recentAvg = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const oldAvg = oldPrices.reduce((a, b) => a + b, 0) / oldPrices.length;
    
    const priceDifference = Math.abs(recentAvg - oldAvg);
    
    const significantTrendChange = priceDifference > 15;
    
    if (significantTrendChange) {
      console.log(`📊 TREND CHANGE: Recent avg: ${recentAvg.toFixed(1)}, Old avg: ${oldAvg.toFixed(1)}, Diff: ${priceDifference.toFixed(1)} pips`);
    }
    
    return significantTrendChange;
  }
  
  private detectLargePriceMovement(): number | false {
    if (this.priceHistory.length < 5) return false;
    
    const recentPrices = this.priceHistory.slice(-5);
    const highest = Math.max(...recentPrices);
    const lowest = Math.min(...recentPrices);
    const range = Math.abs(highest - lowest);
    
    const isLargeMovement = range > 20;
    
    if (isLargeMovement) {
      console.log(`📈 LARGE PRICE MOVEMENT: Range of ${range.toFixed(1)} pips in last 5 data points`);
      return range;
    }
    
    return false;
  }

  private evaluateQualityGate(
    analysis: { signalType: SignalType; confidence: number },
    features: MarketFeatures,
  ): { passed: boolean; reason?: string; tip?: string; summary?: string } {
    const { signalType, confidence } = analysis;
    const regime = features.marketRegime;
    const volumeRatio = features.volumeRatio;
    const atr = features.atr;
    const srReaction = features.activeSRReaction;

    // PHASE 2 (A3): reject mutually contradictory structural states. 117 of the
    // 340 audited signals were scored as sitting at STRONG SUPPORT and STRONG
    // RESISTANCE simultaneously - that is a compressed range being credited
    // with confluence on both sides at once, not a real edge.
    //
    // CALIBRATION NOTE: the first revision rejected on the double-strength
    // condition alone. The 24h replay attributed 895 rejections to it and
    // generation fell to zero, so it is now scoped exactly to the harmful case:
    // a compressed range with NO confirmed rejection in the signal's favour and
    // without high conviction. A confirmed bounce inside a range is a legitimate
    // scalp and is no longer blocked.
    const rangeContradiction = features.supportStrength > 0.8 && features.resistanceStrength > 0.8;
    const hasConfirmedReaction = srReaction?.confirmed === true;
    if (rangeContradiction && !hasConfirmedReaction && confidence < RANGE_CONTRADICTION_MAX_CONFIDENCE) {
      return {
        passed: false,
        reason: `Contradictory structure: strong support (${features.supportStrength.toFixed(2)}) AND strong resistance (${features.resistanceStrength.toFixed(2)}) with no confirmed reaction`,
        tip: 'Price is pinned inside a compressed range with no confirmed rejection either way. Wait for one side to actually break or hold before taking a direction.',
      };
    }

    // PHASE 2 (A4): nearest-zone confluence gate. Audited nearest-zone
    // confluence == 1 scored EV -0.326R; confluence >= 3 was the only zone
    // bucket with a genuinely positive edge.
    const zonesNearPrice = features.srZones
      .filter(z => Math.abs(z.price - this.currentPrice) <= NEAR_ZONE_CONFLUENCE_PROXIMITY)
      .sort((a, b) => Math.abs(a.price - this.currentPrice) - Math.abs(b.price - this.currentPrice));
    const nearestZone = zonesNearPrice[0];
    if (nearestZone && nearestZone.confluenceScore < MIN_NEAR_ZONE_CONFLUENCE && confidence < CONFLUENCE_GATE_OVERRIDE_CONFIDENCE) {
      return {
        passed: false,
        reason: `Nearest zone @ ${nearestZone.price.toFixed(1)} has confluence ${nearestZone.confluenceScore} (< ${MIN_NEAR_ZONE_CONFLUENCE})`,
        tip: `Single-source zones measured EV -0.326R in the audited sample. Needs >=${MIN_NEAR_ZONE_CONFLUENCE} independent sources agreeing on the level, or >=${(CONFLUENCE_GATE_OVERRIDE_CONFIDENCE * 100).toFixed(0)}% conviction.`,
      };
    }

    const minVolume = regime.type === 'QUIET' ? 0.55 : 0.75;
    if (volumeRatio < minVolume && confidence < 0.82) {
      return {
        passed: false,
        reason: `Low participation (volume ratio ${volumeRatio.toFixed(2)} < ${minVolume})`,
        tip: 'Avoiding dead-tape breakouts. Wait for volume expansion or ultra-high conviction (≥82%).',
      };
    }

    // D18: QUIET regime allows mean-reversion setups when Bollinger bands are squeezed + S/R reaction
    if (regime.type === 'QUIET' && regime.strength < 0.35 && confidence < 0.80) {
      const hasMeanRevSetup = features.bollingerSqueeze && srReaction && srReaction.confirmed;
      if (!hasMeanRevSetup) {
        return {
          passed: false,
          reason: 'QUIET regime with weak directional strength',
          tip: 'Price is compressed and directionless. Needs Bollinger squeeze + confirmed S/R bounce for mean-reversion entry.',
        };
      }
      console.log('✅ QUIET mean-reversion setup: Bollinger squeeze + S/R reaction confirmed');
    }

    // D19: Cold-start relaxation for RANGING - allow near-S/R plus higher conviction
    const isColdStart = this.priceHistory.length < 40 || this.tradeOutcomes.length < 10;
    if (regime.type === 'RANGING' && !srReaction && confidence < 0.78) {
      const coldStartMin = 0.72;
      if (isColdStart && confidence >= coldStartMin) {
        console.log(`✅ RANGING cold-start relief: accepting ${(confidence * 100).toFixed(1)}% (>= ${coldStartMin * 100}%)`);
      } else {
        return {
          passed: false,
          reason: 'RANGING regime with no confirmed S/R reaction',
          tip: isColdStart
            ? `Cold start: need >=${coldStartMin * 100}% confidence OR a confirmed S/R touch.`
            : 'In a range, only trade confirmed bounces off support/resistance. No S/R touch detected.',
        };
      }
    }

    if (srReaction && !srReaction.confirmed && confidence < 0.80) {
      return {
        passed: false,
        reason: `S/R interaction present but reaction not confirmed (${srReaction.reactionType})`,
        tip: 'Wait for the rejection candle to close outside the S/R zone before entering.',
      };
    }

    if (signalType === 'BUY' && features.rsi > 72 && regime.type !== 'TRENDING') {
      return {
        passed: false,
        reason: `BUY blocked at RSI ${features.rsi.toFixed(1)} outside a trending regime`,
        tip: 'Overbought without trend strength — high chance of mean-reversion failure.',
      };
    }

    if (signalType === 'SELL' && features.rsi < 28 && regime.type !== 'TRENDING') {
      return {
        passed: false,
        reason: `SELL blocked at RSI ${features.rsi.toFixed(1)} outside a trending regime`,
        tip: 'Oversold without trend strength — high chance of mean-reversion failure.',
      };
    }

    if (atr < 4 && confidence < 0.82) {
      return {
        passed: false,
        reason: `ATR too low (${atr.toFixed(1)} pips) — insufficient volatility for target chase`,
        tip: 'Market is too quiet for TP2/TP3 to realistically hit. Wait for volatility to expand.',
      };
    }

    return {
      passed: true,
      summary: `Regime ${regime.type} | Vol ${volumeRatio.toFixed(2)} | ATR ${atr.toFixed(1)} | SR ${srReaction?.confirmed ? 'confirmed' : 'n/a'}`,
    };
  }

  private validateStructuralConditions(
    signalType: SignalType,
    features: MarketFeatures,
    settings: { tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number }
  ): { valid: boolean; reason?: string; tip?: string } {
    const currentPrice = this.currentPrice;
    const pipValue = 0.1;

    console.log('\n🏗️ STRUCTURAL VALIDATION CHECK:');
    console.log('='.repeat(60));

    const htfTrend = this.detectHTFTrend(features);
    const ltfTrend = this.detectLTFTrend();

    console.log(`HTF Trend: ${htfTrend} | LTF Trend: ${ltfTrend}`);
    console.log(`Signal Type: ${signalType}`);

    const isPrimaryTrend = (
      (signalType === 'BUY' && htfTrend === 'BULLISH' && ltfTrend === 'BULLISH') ||
      (signalType === 'SELL' && htfTrend === 'BEARISH' && ltfTrend === 'BEARISH')
    );

    // PHASE 2 (B1): kept in lock-step with the generation-time classifier above.
    // The HTF-neutral / LTF-opposed case is the repair: those signals previously
    // fell through to the unconditional "allowing with caution" return at the
    // bottom of this function, so they never had to prove a real structural
    // level existed. They now go through the counter-trend bounce requirement.
    const isCounterTrend = (
      (signalType === 'BUY' && htfTrend === 'BEARISH') ||
      (signalType === 'SELL' && htfTrend === 'BULLISH') ||
      (signalType === 'BUY' && htfTrend === 'NEUTRAL' && ltfTrend === 'BEARISH') ||
      (signalType === 'SELL' && htfTrend === 'NEUTRAL' && ltfTrend === 'BULLISH') ||
      (signalType === 'BUY' && htfTrend === 'NEUTRAL' && features.rsi < 35) ||
      (signalType === 'SELL' && htfTrend === 'NEUTRAL' && features.rsi > 65)
    );

    console.log(`Classification: ${isPrimaryTrend ? 'PRIMARY TREND' : isCounterTrend ? 'COUNTER-TREND' : 'NEUTRAL'}`);

    // Step 3: baseline opposing-structure veto, runs REGARDLESS of primary/
    // counter/neutral classification (closes the "neutral bypasses everything"
    // gap - the neutral fallback below returns valid:true unconditionally and
    // never checked real srZones at all). A 142-signal diagnostics export
    // showed 38% of signals fired with a top-3 displayed feature directly
    // opposing their own direction (win rate 46.3% vs 64.8% overall in that
    // group) - this closes that gap by rejecting any signal that sits near a
    // real, previously-tested opposing zone with no confirmed favorable
    // reaction. Depends on Step 2's staleness decay already being applied to
    // features.srZones, otherwise a single stale-but-maxed zone can veto
    // almost everything for a full session.
    const vetoTargetScalePips = Math.max(settings.tp3Pips, 20);
    const OPPOSING_ZONE_VETO_PROXIMITY = Math.max(vetoTargetScalePips * 1.1, 15) * pipValue;
    const OPPOSING_ZONE_VETO_MIN_REACTION = 0.3;
    const opposingZoneType = signalType === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const favorableReactionType = signalType === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
    const nearOpposingZone = features.srZones.find(z =>
      z.type === opposingZoneType &&
      z.reactionStrength >= OPPOSING_ZONE_VETO_MIN_REACTION &&
      Math.abs(z.price - currentPrice) <= OPPOSING_ZONE_VETO_PROXIMITY
    );
    const hasFavorableConfirmedReaction = (
      features.activeSRReaction?.confirmed === true &&
      features.activeSRReaction.zone.type === favorableReactionType
    );
    if (nearOpposingZone && !hasFavorableConfirmedReaction) {
      const reason = `${signalType} REJECTED: within ${OPPOSING_ZONE_VETO_PROXIMITY} of a real ${opposingZoneType} zone @ ${nearOpposingZone.price.toFixed(1)} (reaction ${(nearOpposingZone.reactionStrength * 100).toFixed(0)}%, ${nearOpposingZone.touches} touches) with no confirmed favorable reaction`;
      const tip = `A real, previously-tested ${opposingZoneType.toLowerCase()} zone sits nearby without a confirmed bounce in this signal's favor - firing here risks entering directly against genuine structure.`;
      console.log(`   ❌ BASELINE OPPOSING-STRUCTURE VETO: ${reason}`);
      console.log(`   💡 ${tip}`);
      console.log('='.repeat(60) + '\n');
      return { valid: false, reason, tip };
    }

    if (isPrimaryTrend) {
      console.log('\n🎯 PRIMARY TREND FILTER: Checking Runway to Barriers');

      const tp2Distance = settings.tp2Pips;
      const tp3Distance = settings.tp3Pips;
      const requiredRunway = Math.max(settings.tp1Pips * 0.95, settings.slPips * 0.7);
      const tp1Target = signalType === 'BUY' ? currentPrice + (settings.tp1Pips * pipValue) : currentPrice - (settings.tp1Pips * pipValue);

      console.log(`   Fixed SL Risk: ${settings.slPips} pips`);
      console.log(`   TP1 Target: ${tp1Target.toFixed(1)} (${settings.tp1Pips} pips away)`);
      console.log(`   TP3 Stretch Target: ${tp3Distance.toFixed(0)} pips`);
      console.log(`   Required Runway: ${requiredRunway.toFixed(0)} pips (TP1 clearance + managed-runner protection)`);

      let nearestBarrierDistance = Infinity;
      let barrierType = 'None';

      // Part 2: real, candlestick-derived srZones (fractal swings, actual touch
      // counts, rejection wicks, PDH/PDL, Asian range, opening range, weekly
      // H/L + confluence) are checked FIRST as the primary barrier source.
      // Fixed Camarilla pivots (r1-r3/s1-s3) are now only a fallback used when
      // no qualifying real zone exists - they have no requirement to
      // correspond to anywhere price has actually reacted before.
      if (signalType === 'BUY') {
        const bearishOBs = features.orderBlocks.filter(ob => ob.type === 'BEARISH' && ob.price > currentPrice);
        const qualifyingZones = features.srZones.filter(z => z.type === 'RESISTANCE' && z.price > currentPrice && z.reactionStrength >= 0.3);
        const hasRealBarrier = bearishOBs.length > 0 || qualifyingZones.length > 0;
        const resistanceLevels = hasRealBarrier ? [] : [features.r1, features.r2, features.r3].filter(r => r > currentPrice);

        bearishOBs.forEach(ob => {
          const distance = (ob.price - currentPrice) / pipValue;
          if (distance < nearestBarrierDistance) {
            nearestBarrierDistance = distance;
            barrierType = `Bearish OB @ ${ob.price.toFixed(1)}`;
          }
        });

        qualifyingZones.forEach(zone => {
          const distance = (zone.price - currentPrice) / pipValue;
          if (distance < nearestBarrierDistance) {
            nearestBarrierDistance = distance;
            barrierType = `SRZone RESISTANCE @ ${zone.price.toFixed(1)} (reaction ${(zone.reactionStrength * 100).toFixed(0)}%, touches ${zone.touches}, source ${zone.source})`;
          }
        });

        resistanceLevels.forEach(level => {
          const distance = (level - currentPrice) / pipValue;
          if (distance < nearestBarrierDistance) {
            nearestBarrierDistance = distance;
            barrierType = `Resistance (Camarilla fallback) @ ${level.toFixed(1)}`;
          }
        });
      } else {
        const bullishOBs = features.orderBlocks.filter(ob => ob.type === 'BULLISH' && ob.price < currentPrice);
        const qualifyingZones = features.srZones.filter(z => z.type === 'SUPPORT' && z.price < currentPrice && z.reactionStrength >= 0.3);
        const hasRealBarrier = bullishOBs.length > 0 || qualifyingZones.length > 0;
        const supportLevels = hasRealBarrier ? [] : [features.s1, features.s2, features.s3].filter(s => s < currentPrice);

        bullishOBs.forEach(ob => {
          const distance = (currentPrice - ob.price) / pipValue;
          if (distance < nearestBarrierDistance) {
            nearestBarrierDistance = distance;
            barrierType = `Bullish OB @ ${ob.price.toFixed(1)}`;
          }
        });

        qualifyingZones.forEach(zone => {
          const distance = (currentPrice - zone.price) / pipValue;
          if (distance < nearestBarrierDistance) {
            nearestBarrierDistance = distance;
            barrierType = `SRZone SUPPORT @ ${zone.price.toFixed(1)} (reaction ${(zone.reactionStrength * 100).toFixed(0)}%, touches ${zone.touches}, source ${zone.source})`;
          }
        });

        supportLevels.forEach(level => {
          const distance = (currentPrice - level) / pipValue;
          if (distance < nearestBarrierDistance) {
            nearestBarrierDistance = distance;
            barrierType = `Support (Camarilla fallback) @ ${level.toFixed(1)}`;
          }
        });
      }

      console.log(`   Nearest Barrier: ${barrierType} (${nearestBarrierDistance.toFixed(1)} pips away)`);

      if (nearestBarrierDistance < requiredRunway) {
        const reason = `PRIMARY TREND REJECTED: Insufficient runway (${nearestBarrierDistance.toFixed(0)} pips < ${requiredRunway.toFixed(0)} pips required)`;
        const tip = `Price must have ${requiredRunway.toFixed(0)} pips clear space to ${barrierType} so TP1 remains achievable before the next barrier. Market is still too compressed.`;
        console.log(`   ❌ ${reason}`);
        console.log(`   💡 ${tip}`);
        console.log('='.repeat(60) + '\n');
        return { valid: false, reason, tip };
      }

      console.log(`   ✅ RUNWAY CLEAR: ${nearestBarrierDistance.toFixed(0)} pips to nearest barrier (>${requiredRunway.toFixed(0)} pips)`);
      console.log('='.repeat(60) + '\n');
      return { valid: true };
    }

    if (isCounterTrend) {
      console.log('\n🔄 COUNTER-TREND FILTER: Checking Bounce off Major Level');

      const bounceThreshold = 10;
      let nearMajorLevel = false;
      let levelDescription = 'None';

      // Part 2: counter-trend entries now require proof of a REAL,
      // previously-tested level (order block, or an srZone with
      // reactionStrength >= 0.3 AND touches >= 2) - not an
      // arithmetically-derived Camarilla pivot that merely happens to be
      // nearby. No pivot-proximity fallback here (unlike the primary-trend
      // branch): a counter-trend bet against the prevailing HTF/LTF trend
      // needs genuine structural evidence, not a fixed grid number.
      if (signalType === 'BUY') {
        const bullishOBs = features.orderBlocks.filter(ob => ob.type === 'BULLISH' && Math.abs(ob.price - currentPrice) < bounceThreshold);
        const qualifyingZone = features.srZones.find(z => z.type === 'SUPPORT' && Math.abs(z.price - currentPrice) < bounceThreshold && z.reactionStrength >= 0.3 && z.touches >= 2);

        if (bullishOBs.length > 0) {
          nearMajorLevel = true;
          levelDescription = `Bullish OB @ ${bullishOBs[0].price.toFixed(1)} (Strength: ${(bullishOBs[0].strength * 100).toFixed(0)}%)`;
        } else if (qualifyingZone) {
          nearMajorLevel = true;
          levelDescription = `SRZone SUPPORT @ ${qualifyingZone.price.toFixed(1)} (reaction ${(qualifyingZone.reactionStrength * 100).toFixed(0)}%, touches ${qualifyingZone.touches}, source ${qualifyingZone.source})`;
        }
      } else {
        const bearishOBs = features.orderBlocks.filter(ob => ob.type === 'BEARISH' && Math.abs(ob.price - currentPrice) < bounceThreshold);
        const qualifyingZone = features.srZones.find(z => z.type === 'RESISTANCE' && Math.abs(z.price - currentPrice) < bounceThreshold && z.reactionStrength >= 0.3 && z.touches >= 2);

        if (bearishOBs.length > 0) {
          nearMajorLevel = true;
          levelDescription = `Bearish OB @ ${bearishOBs[0].price.toFixed(1)} (Strength: ${(bearishOBs[0].strength * 100).toFixed(0)}%)`;
        } else if (qualifyingZone) {
          nearMajorLevel = true;
          levelDescription = `SRZone RESISTANCE @ ${qualifyingZone.price.toFixed(1)} (reaction ${(qualifyingZone.reactionStrength * 100).toFixed(0)}%, touches ${qualifyingZone.touches}, source ${qualifyingZone.source})`;
        }
      }

      console.log(`   Bounce Threshold: ${bounceThreshold} pips`);
      console.log(`   Near Major Level: ${nearMajorLevel ? 'YES' : 'NO'}`);
      if (nearMajorLevel) {
        console.log(`   Level: ${levelDescription}`);
      }

      if (!nearMajorLevel) {
        const reason = `COUNTER-TREND REJECTED: Not bouncing off a real, previously-tested structural level`;
        const tip = `Counter-trend signals require price within ${bounceThreshold} pips of a Bullish/Bearish OB, or an S/R zone with reaction strength >= 30% and at least 2 confirmed touches - not just a nearby arithmetic pivot.`;
        console.log(`   ❌ ${reason}`);
        console.log(`   💡 ${tip}`);
        console.log('='.repeat(60) + '\n');
        return { valid: false, reason, tip };
      }

      console.log(`   ✅ BOUNCE CONFIRMED: Counter-trend from ${levelDescription}`);
      console.log('='.repeat(60) + '\n');
      return { valid: true };
    }

    console.log('   ⚠️ Signal classification unclear - allowing with caution');
    console.log('='.repeat(60) + '\n');
    return { valid: true };
  }
  
  private checkPriceProximity(
    activeSignals: TradingSignal[],
    proposedType: SignalType,
    _dynamicCooldown: number
  ): { blocked: boolean; reason?: string; tip?: string } {
    const proposedEntryPrice = this.currentPrice;
    const maxSignalAge = MAX_RECENT_SIGNAL_TIME_MINUTES * 60 * 1000;
    const now = Date.now();
    
    // F31: Allow opposite-direction to bypass proximity filter entirely
    // proximity rules only apply to same-direction signals here
    const partiallyManagedSignals = activeSignals.filter(signal => {
      if (signal.type !== proposedType) return false;
      
      const isPartiallyManaged = signal.targetsHit >= 1 && signal.status !== "ALL_TARGETS_HIT" && signal.status !== "SL_HIT" && signal.status !== "CLOSED";
      
      if (!isPartiallyManaged) return false;
      
      const tp1HitTime = signal.createdAt ? signal.createdAt : new Date(signal.timestamp).getTime();
      const timeSinceTP1 = now - tp1HitTime;
      
      return timeSinceTP1 < POST_TP1_COOLDOWN_MS;
    });
    
    if (partiallyManagedSignals.length > 0) {
      const signal = partiallyManagedSignals[0];
      const tp1HitTime = signal.createdAt ? signal.createdAt : new Date(signal.timestamp).getTime();
      const timeSinceTP1 = now - tp1HitTime;
      const remainingCooldown = ((POST_TP1_COOLDOWN_MS - timeSinceTP1) / 1000).toFixed(0);
      
      console.log(`🔒 POST-TP1 COOLDOWN CHECK:`);
      console.log(`   Signal #${signal.id.slice(-6)} hit TP${signal.targetsHit} ${(timeSinceTP1 / 1000).toFixed(0)}s ago`);
      console.log(`   Cooldown Remaining: ${remainingCooldown}s`);
      
      return {
        blocked: true,
        reason: `Post-TP1 cooldown active for signal #${signal.id.slice(-6)}. Time since TP1: ${(timeSinceTP1 / 1000).toFixed(0)}s`,
        tip: `Wait ${remainingCooldown}s before new ${proposedType} signal. This prevents immediate re-entry at TP1 level.`
      };
    }
    
    const recentActiveSignals = activeSignals.filter(signal => {
      if (signal.status !== "ACTIVE" && signal.status !== "TP1_HIT" && signal.status !== "TP2_HIT") return false;
      if (signal.type !== proposedType) return false;
      
      const signalAge = now - new Date(signal.timestamp).getTime();
      return signalAge < maxSignalAge;
    });
    
    if (recentActiveSignals.length === 0) {
      console.log('✓ Price Proximity Check: No recent active signals of same type');
      return { blocked: false };
    }
    
    for (const signal of recentActiveSignals) {
      const priceDifference = Math.abs(proposedEntryPrice - signal.entryPrice) * 1000;
      const signalAge = ((now - new Date(signal.timestamp).getTime()) / 1000 / 60).toFixed(1);
      
      const isPartiallyManaged = signal.targetsHit >= 1;
      const requiredDistance = isPartiallyManaged ? MIN_PIP_DIFFERENCE_FOR_PARTIALLY_MANAGED : MIN_PIP_DIFFERENCE_FOR_NEW_SIGNAL;
      
      console.log(`🔍 Proximity Check: Comparing with Signal #${signal.id.slice(-6)}`);
      console.log(`   Status: ${signal.status} | Targets: ${signal.targetsHit}/3`);
      console.log(`   Active Signal Entry: ${signal.entryPrice.toFixed(1)} | Proposed: ${proposedEntryPrice.toFixed(1)}`);
      console.log(`   Price Difference: ${priceDifference.toFixed(1)} pips | Signal Age: ${signalAge}m`);
      console.log(`   Required Distance: ${requiredDistance} pips (${isPartiallyManaged ? 'PARTIALLY MANAGED' : 'ACTIVE'})`);
      
      if (priceDifference < requiredDistance) {
        return {
          blocked: true,
          reason: `Signal #${signal.id.slice(-6)} at ${signal.entryPrice.toFixed(1)} is within ${requiredDistance} pips (${priceDifference.toFixed(1)} pips difference). Status: ${signal.status}`,
          tip: `Price must move >${requiredDistance} pips from ${isPartiallyManaged ? 'partially managed' : 'active'} ${proposedType} signals. ${isPartiallyManaged ? 'Stricter distance required for partially managed signals.' : ''}`
        };
      }
    }
    
    console.log(`✓ Price Proximity Check: All signals are beyond required distance`);
    return { blocked: false };
  }
  
  resetSignalLock(): void {
    this.lastSignalType = null;
    this.lastSignalTime = 0;
    this.lastBuySignalTime = 0;
    this.lastSellSignalTime = 0;
    console.log('🔓 Signal lock reset. New signals can be generated.');
  }

  private getRecentAttemptCount(now: number): number {
    this.recentAttemptTimestamps = this.recentAttemptTimestamps.filter(t => (now - t) < ATTEMPT_WINDOW_MS);
    return this.recentAttemptTimestamps.length;
  }

  private detectFastPathSignal(
    features: MarketFeatures,
    analysis: { signalType: SignalType; confidence: number; attentionScores: Map<string, number> }
  ): { active: boolean; reason: string; minConfidence: number; signalType?: SignalType } {
    const adx = features.adx ?? 0;
    const htf = this.detectHTFTrend(features);
    const ltf = this.detectLTFTrend();
    const aligned = (htf === 'BULLISH' && ltf === 'BULLISH') || (htf === 'BEARISH' && ltf === 'BEARISH');
    const emaBoost = analysis.attentionScores.has('bullish_ema_crossover') || analysis.attentionScores.has('bearish_ema_crossover');
    // Proposal #1: Trend-continuation fast path
    if (adx > 25 && aligned && emaBoost) {
      const vwap = features.vwap;
      const pullback = vwap !== null && Math.abs(this.currentPrice - vwap) < Math.max(2, features.atr * 0.5);
      if (pullback) {
        return {
          active: true,
          reason: `Trend continuation: ADX ${adx.toFixed(1)}, HTF+LTF ${htf}, pullback to VWAP`,
          minConfidence: TREND_FAST_PATH_CONFIDENCE,
          signalType: htf === 'BULLISH' ? 'BUY' : 'SELL',
        };
      }
    }
    // Proposal #3: Momentum breakout trigger
    if (this.priceHistory.length >= MOMENTUM_BREAKOUT_MAX_BARS + 1 && features.bollingerExpansion) {
      const recent = this.priceHistory.slice(-(MOMENTUM_BREAKOUT_MAX_BARS + 1));
      const impulse = recent[recent.length - 1] - recent[0];
      const impulsePips = Math.abs(impulse) / 0.1;
      if (impulsePips >= MOMENTUM_BREAKOUT_PIPS) {
        return {
          active: true,
          reason: `Momentum impulse: ${impulsePips.toFixed(0)} pips in ${MOMENTUM_BREAKOUT_MAX_BARS} bars + Bollinger expansion`,
          minConfidence: MOMENTUM_BREAKOUT_CONFIDENCE,
          signalType: impulse > 0 ? 'BUY' : 'SELL',
        };
      }
    }
    // Proposal #10: Pre-signal impulse detection (5min candle > 2x ATR)
    if (this.fiveMinCandles.length >= 2 && features.atr > 0) {
      const lastCandle = this.fiveMinCandles[this.fiveMinCandles.length - 2];
      const candleRangePips = Math.abs(lastCandle.high - lastCandle.low) / 0.1;
      if (candleRangePips > features.atr * 2) {
        const direction: SignalType = lastCandle.close > lastCandle.open ? 'BUY' : 'SELL';
        return {
          active: true,
          reason: `5-min impulse candle ${candleRangePips.toFixed(0)}p > 2xATR ${(features.atr * 2).toFixed(0)}p`,
          minConfidence: TREND_FAST_PATH_CONFIDENCE,
          signalType: direction,
        };
      }
    }
    return { active: false, reason: '', minConfidence: 0 };
  }

  private recordNearMiss(
    signalType: SignalType,
    confidence: number,
    strengthDiff: number,
    reason: string,
    snapshot?: { entryPrice: number; atr: number; tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number },
  ): void {
    // Proposal #11: Setup brewing telemetry
    const inConfBand = confidence >= NEAR_MISS_CONFIDENCE_LOW && confidence < NEAR_MISS_CONFIDENCE_HIGH;
    const inDiffBand = strengthDiff >= NEAR_MISS_DIFF_LOW && strengthDiff < NEAR_MISS_DIFF_HIGH;
    if (!inConfBand && !inDiffBand) return;

    const entry: NearMissEntry = { timestamp: Date.now(), signalType, confidence, strengthDiff, reason };
    if (snapshot) {
      // Step 6: capture a hypothetical entry/TP/SL snapshot (same ATR-scaled sizing
      // an accepted signal would have used) so this rejected setup can later be
      // resolved against REAL subsequent price action via the same resolver logic
      // that grades real signals — never inventing a separate, looser grading path.
      // PHASE 2: mirrors the live 1.4R scalper geometry exactly, so mined
      // near-misses are graded against the same ladder a real signal would get.
      const pipValue = 0.1;
      const atrMultiplier = Math.max(1.0, Math.min(1.6, 0.7 + snapshot.atr * 0.06));
      const atrFloorSlPips = (snapshot.atr * MIN_SL_ATR_MULTIPLE) / pipValue;
      const slPips = Math.max(snapshot.slPips * atrMultiplier, atrFloorSlPips);
      const dir = signalType === 'BUY' ? 1 : -1;
      entry.entryPrice = snapshot.entryPrice;
      entry.tp1 = snapshot.entryPrice + dir * slPips * SCALPER_TP_R_MULTIPLES.tp1 * pipValue;
      entry.tp2 = snapshot.entryPrice + dir * slPips * SCALPER_TP_R_MULTIPLES.tp2 * pipValue;
      entry.tp3 = snapshot.entryPrice + dir * slPips * SCALPER_TP_R_MULTIPLES.tp3 * pipValue;
      entry.sl = snapshot.entryPrice - dir * slPips * pipValue;
    }

    this.nearMisses.push(entry);
    if (this.nearMisses.length > NEAR_MISS_MAX_ENTRIES) {
      this.nearMisses = this.nearMisses.slice(-NEAR_MISS_MAX_ENTRIES);
    }
    console.log(`🔍 NEAR-MISS logged: ${signalType} conf ${(confidence * 100).toFixed(1)}% diff ${strengthDiff.toFixed(3)} - ${reason}`);
  }

  getRecentNearMisses(): NearMissEntry[] {
    return [...this.nearMisses].reverse();
  }

  /**
   * Step 6: retroactively resolves every matured, price-snapshotted near-miss
   * against REAL subsequent price action (via the same signalResolver logic
   * used for real signals, fromScratch so it never trusts a stored status)
   * and buckets the hypothetical outcomes by rejection reason. A bucket where
   * a meaningful fraction of rejected setups would have won flags that
   * threshold/reason as miscalibrated-too-tight; a bucket that mostly would
   * have lost confirms the gate is working as intended.
   */
  async mineNearMissesForRecalibration(
    fetchBars: (fromTs: number, toTs: number) => Promise<OhlcBar[]>,
    nowMs: number = Date.now(),
  ): Promise<NearMissRecalibrationBucket[]> {
    const buckets = new Map<string, { wins: number; losses: number; noOutcome: number }>();

    for (const nm of this.nearMisses) {
      if (nm.entryPrice === undefined || nm.tp1 === undefined || nm.tp2 === undefined || nm.tp3 === undefined || nm.sl === undefined) {
        continue; // no snapshot captured (rejection happened before entry context existed)
      }
      if (nowMs - nm.timestamp < NEAR_MISS_MIN_MATURITY_MS) {
        continue; // too recent to have played out
      }

      const bars = await fetchBars(nm.timestamp, Math.min(nowMs, nm.timestamp + NEAR_MISS_LOOKAHEAD_MS));
      const hypotheticalSignal: TradingSignal = {
        id: `nearmiss-${nm.timestamp}`,
        timestamp: new Date(nm.timestamp),
        type: nm.signalType,
        entryPrice: nm.entryPrice,
        entryPriceWithSlippage: nm.entryPrice,
        tp1: nm.tp1,
        tp2: nm.tp2,
        tp3: nm.tp3,
        sl: nm.sl,
        slMultiplier: 1,
        confidence: nm.confidence,
        status: 'ACTIVE',
        targetsHit: 0,
        entryTime: new Date(nm.timestamp).toISOString(),
        topFeatures: [],
        riskJustification: 'near-miss hypothetical resolution (never emitted as a real signal)',
        createdAt: nm.timestamp,
      };

      const outcome = resolveSignalWithBars(hypotheticalSignal, bars, {
        fromScratch: true,
        evalNowMs: nowMs,
        logPrefix: `   [NearMissMiner ${nm.reason}]`,
      });

      const bucket = buckets.get(nm.reason) ?? { wins: 0, losses: 0, noOutcome: 0 };
      if (outcome.outcomeResult === 'WIN') bucket.wins++;
      else if (outcome.outcomeResult === 'LOSS') bucket.losses++;
      else bucket.noOutcome++;
      buckets.set(nm.reason, bucket);
    }

    return Array.from(buckets.entries()).map(([reason, b]) => {
      const decided = b.wins + b.losses;
      const winRate = decided > 0 ? b.wins / decided : 0;
      return {
        reason,
        wins: b.wins,
        losses: b.losses,
        noOutcome: b.noOutcome,
        winRate,
        flagged: decided >= NEAR_MISS_FLAG_MIN_SAMPLE && winRate > NEAR_MISS_FLAG_WIN_RATE,
      };
    });
  }

  getDiffBucketStats(): { low: { wins: number; losses: number; ev: number }; mid: { wins: number; losses: number; ev: number }; high: { wins: number; losses: number; ev: number } } {
    const computeEv = (b: { wins: number; losses: number }): number => {
      const total = b.wins + b.losses;
      if (total === 0) return 0;
      return b.wins / total;
    };
    return {
      low: { ...this.diffBucketStats.low, ev: computeEv(this.diffBucketStats.low) },
      mid: { ...this.diffBucketStats.mid, ev: computeEv(this.diffBucketStats.mid) },
      high: { ...this.diffBucketStats.high, ev: computeEv(this.diffBucketStats.high) },
    };
  }

  getAdaptiveDiffAdjustment(regime: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET'): number {
    // Proposal #8: Adaptive conviction threshold
    const stats = this.diffBucketStats.low;
    const total = stats.wins + stats.losses;
    if (total < 10) return 0;
    const winRate = stats.wins / total;
    if (winRate >= 0.55) {
      const relaxedBy = regime === 'RANGING' ? 0.02 : 0.015;
      return -relaxedBy;
    }
    return 0;
  }

  recordDiffOutcome(strengthDiff: number, result: 'WIN' | 'LOSS'): void {
    const bucket: 'low' | 'mid' | 'high' = strengthDiff < 0.09 ? 'low' : strengthDiff < 0.15 ? 'mid' : 'high';
    if (result === 'WIN') this.diffBucketStats[bucket].wins++;
    else this.diffBucketStats[bucket].losses++;
  }

  private computeExpectedValue(confidence: number, tp2Pips: number, slPips: number, atrMultiplier: number): number {
    const rr = tp2Pips / (slPips * atrMultiplier);
    const winProb = Math.min(0.95, Math.max(0.3, confidence));
    return winProb * rr - (1 - winProb);
  }

  /**
   * PHASE 2 (B1): signed intraday price drift in PRICE units over the most
   * recent closed 5-minute candles. Positive = price climbing. Returns null
   * when there aren't enough candles to make an honest reading (never a
   * synthetic substitute). Feeds the drift veto that stops the engine firing
   * repeatedly into a live impulse.
   */
  private computeRecentDrift(candles: number = DRIFT_LOOKBACK_CANDLES): number | null {
    if (this.fiveMinCandles.length < 3) return null;
    const window = this.fiveMinCandles.slice(-Math.max(3, candles));
    const first = window[0];
    const last = window[window.length - 1];
    if (!first || !last) return null;
    return last.close - first.open;
  }

  private computeRoomToSR(signalType: SignalType, features: MarketFeatures): number {
    const price = this.currentPrice;
    const pip = 0.1;
    // Part 2: real srZones (filtered by side + reactionStrength >= 0.3) are
    // now included alongside the Camarilla pivots and order blocks as
    // candidate barriers for TP2/TP3 room sizing.
    if (signalType === 'BUY') {
      const srBarriers = features.srZones
        .filter(z => z.type === 'RESISTANCE' && z.price > price && z.reactionStrength >= 0.3)
        .map(z => z.price);
      const barriers = [features.r1, features.r2, features.r3, ...features.orderBlocks.filter(o => o.type === 'BEARISH').map(o => o.price), ...srBarriers].filter(p => p > price);
      if (barriers.length === 0) return 200;
      return (Math.min(...barriers) - price) / pip;
    } else {
      const srBarriers = features.srZones
        .filter(z => z.type === 'SUPPORT' && z.price < price && z.reactionStrength >= 0.3)
        .map(z => z.price);
      const barriers = [features.s1, features.s2, features.s3, ...features.orderBlocks.filter(o => o.type === 'BULLISH').map(o => o.price), ...srBarriers].filter(p => p < price);
      if (barriers.length === 0) return 200;
      return (price - Math.max(...barriers)) / pip;
    }
  }

  setLastKnownSpread(spreadPips: number): void {
    if (spreadPips > 0 && spreadPips < 20) {
      this.lastKnownSpreadPips = spreadPips;
      // Part B: retain real spread readings so calculateSpreadRatio() can compare
      // the latest reading against a genuine rolling baseline, not a single snapshot.
      this.spreadHistory.push(spreadPips);
      if (this.spreadHistory.length > 200) {
        this.spreadHistory.shift();
      }
    }
  }
  
  private logSignalGenerationMetrics(): void {
    if (this.signalGenerationAttempts % 10 === 0) {
      const signalRate = ((this.successfulSignalsGenerated / this.signalGenerationAttempts) * 100).toFixed(1);
      const currentCooldownMultiplier = this.lastMarketRegime 
        ? this.calculateDynamicCooldown(this.lastMarketRegime, this.performanceMetrics.avgConfidence) / 60000
        : 1.0;
      
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`📊 VISUAL STATE OUTPUT (Every 10 Attempts)`);
      console.log(`${'─'.repeat(80)}`);
      console.log(`   Success Rate: ${signalRate}%`);
      console.log(`   Total Signals: ${this.successfulSignalsGenerated}`);
      console.log(`   Total Attempts: ${this.signalGenerationAttempts}`);
      console.log(`   Current Regime: ${this.lastMarketRegime?.type || 'UNKNOWN'}`);
      console.log(`   Win Rate: ${(this.performanceMetrics.recentWinRate * 100).toFixed(1)}%`);
      console.log(`   Profit Factor: ${this.performanceMetrics.profitFactor.toFixed(2)}`);
      console.log(`   Current Cooldown Multiplier: ${currentCooldownMultiplier.toFixed(2)}x (due to ${this.lastMarketRegime?.type || 'UNKNOWN'} Regime + ${(this.performanceMetrics.avgConfidence * 100).toFixed(0)}% Avg Confidence)`);
      console.log(`   Model Health Score: ${this.modelHealthScore.toFixed(0)}/100`);
      console.log(`   Feature Correlation: ${this.featureCorrelationStatus}`);
      console.log(`${'─'.repeat(80)}\n`);
    }
  }
  
  getSignalGenerationStats(): { attempts: number; successful: number; rate: number } {
    return {
      attempts: this.signalGenerationAttempts,
      successful: this.successfulSignalsGenerated,
      rate: this.signalGenerationAttempts > 0 
        ? parseFloat(((this.successfulSignalsGenerated / this.signalGenerationAttempts) * 100).toFixed(1))
        : 0
    };
  }
  
  calculatePositionSizing(
    confidence: number, 
    settings: { basePositionSize: number; maxRiskPercentage: number; useKellyCriterion: boolean },
    accountBalance: number = 10000
  ): PositionSizing {
    let confidenceMultiplier = 1.0;
    
    if (confidence >= 0.92) {
      confidenceMultiplier = 1.75;
    } else if (confidence >= 0.87) {
      confidenceMultiplier = 1.5;
    } else if (confidence >= 0.82) {
      confidenceMultiplier = 1.25;
    } else if (confidence >= 0.77) {
      confidenceMultiplier = 1.1;
    } else if (confidence >= 0.72) {
      confidenceMultiplier = 1.0;
    } else {
      confidenceMultiplier = 0.75;
    }
    
    const winRate = this.performanceMetrics.recentWinRate || 0.65;
    const avgWinLoss = this.performanceMetrics.profitFactor || 1.5;
    
    const kellyPercentage = (winRate * avgWinLoss - (1 - winRate)) / avgWinLoss;
    const fractionalKelly = 0.25;
    const optimalKellyPercentage = Math.max(0, Math.min(0.05, kellyPercentage * fractionalKelly));
    
    let recommendedSize = settings.basePositionSize * confidenceMultiplier;
    
    if (settings.useKellyCriterion) {
      const kellyBasedSize = accountBalance * optimalKellyPercentage;
      const lotsFromKelly = kellyBasedSize / 1000;
      recommendedSize = Math.max(settings.basePositionSize, lotsFromKelly);
    }
    
    const maxSize = accountBalance * (settings.maxRiskPercentage / 100) / 100;
    recommendedSize = Math.min(recommendedSize, maxSize);
    
    const riskPercentage = (recommendedSize * 100) / accountBalance * settings.maxRiskPercentage;
    const adjustedForAccount = parseFloat(((recommendedSize / settings.basePositionSize) * 100).toFixed(1));
    
    return {
      baseSize: settings.basePositionSize,
      confidenceMultiplier: parseFloat(confidenceMultiplier.toFixed(2)),
      recommendedSize: parseFloat(recommendedSize.toFixed(3)),
      riskPercentage: parseFloat(riskPercentage.toFixed(2)),
      fractionalKelly,
      optimalKellyPercentage: parseFloat((optimalKellyPercentage * 100).toFixed(2)),
      adjustedForAccount,
    };
  }
  
  getPerformanceMetrics() {
    return this.performanceMetrics;
  }
  
  getModelHealthMetrics() {
    const featureDriftMetrics = this.analyzeFeatureImportanceDrift();
    const timeSinceRetraining = this.lastTrainingTime > 0 ? Date.now() - this.lastTrainingTime : 0;
    const daysSinceRetrain = this.lastTrainingTime > 0 ? timeSinceRetraining / (24 * 60 * 60 * 1000) : 0;
    
    const confidenceDegradation = this.performanceMetrics.recentWinningConfidences.length > 0
      ? MIN_CONFIDENCE_FOR_RETRAINING - (this.performanceMetrics.recentWinningConfidences.reduce((a, b) => a + b, 0) / this.performanceMetrics.recentWinningConfidences.length)
      : 0;
    
    const retrainingRecommended = (
      this.driftAlertLevel === 'HIGH' ||
      this.conceptDriftScore > 0.5 ||
      confidenceDegradation > 0.08 ||
      daysSinceRetrain > 5
    );
    
    return {
      modelHealthScore: this.modelHealthScore,
      featureCorrelationStatus: this.featureCorrelationStatus,
      confidenceDegradation,
      conceptDriftScore: this.conceptDriftScore,
      featureImportanceDrift: featureDriftMetrics,
      driftAlertLevel: this.driftAlertLevel,
      daysSinceRetrain: parseFloat(daysSinceRetrain.toFixed(1)),
      retrainingRecommended,
      retrainScheduled: this.retrainScheduled,
    };
  }

  async getMarketOutlook(): Promise<MarketOutlook> {
    await this.refreshRecentDailyOHLCFromHistory();

    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const dayOfWeek = now.getUTCDay();
    
    const isSaturday = dayOfWeek === 6;
    const isFridayClose = dayOfWeek === 5 && hour >= 21;
    const isSundayBeforeOpen = dayOfWeek === 0 && hour < 22;
    const isDailyCloseBreak = isWithinDailyMarketClose(now);
    
    const isMarketOpen = !isSaturday && !isFridayClose && !isSundayBeforeOpen && !isDailyCloseBreak;
    
    console.log(`[MarketStatus] UTC ${dayOfWeek} ${hour}:${minute} | open=${isMarketOpen} | sat=${isSaturday} friClose=${isFridayClose} sunBefore=${isSundayBeforeOpen} dailyClose=${isDailyCloseBreak}`);
    
    const isLondonActive = hour >= 6 && hour < 13 && isMarketOpen;
    const isNYActive = hour >= 13 && hour < 21 && isMarketOpen;
    const isAsianActive = ((hour >= 0 && hour < 6) || (hour >= 21 && hour < 24)) && isMarketOpen;
    
    let currentSession = "MARKET_CLOSED";
    if (isLondonActive) currentSession = "LONDON";
    else if (isNYActive) currentSession = "NEW_YORK";
    else if (isAsianActive) currentSession = "ASIAN";
    
    const features = await this.calculateMarketFeatures();
    const pivotLevels = this.calculateDashboardPivotLevels();
    const currentPrice = this.getCurrentPrice();
    
    const trendBuffer = Math.max(2.5, Math.abs(pivotLevels.r2 - pivotLevels.dailyPivot));
    let trend: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
    if (currentPrice > pivotLevels.dailyPivot + trendBuffer) trend = "BULLISH";
    else if (currentPrice < pivotLevels.dailyPivot - trendBuffer) trend = "BEARISH";
    
    const volatility: "LOW" | "MEDIUM" | "HIGH" = 
      features.atr < 9 ? "LOW" : features.atr < 11 ? "MEDIUM" : "HIGH";
    
    return {
      isMarketOpen,
      currentSession,
      sessions: [
        { name: "ASIAN", isActive: isAsianActive },
        { name: "LONDON", isActive: isLondonActive },
        { name: "NEW_YORK", isActive: isNYActive },
      ],
      trend,
      volatility,
      dailyPivot: pivotLevels.dailyPivot,
      r1: pivotLevels.r1,
      r2: pivotLevels.r2,
      r3: pivotLevels.r3,
      s1: pivotLevels.s1,
      s2: pivotLevels.s2,
      s3: pivotLevels.s3,
      // Part 3: expose the real, candlestick-derived S/R zones already
      // computed above as part of calculateMarketFeatures() - features.srZones
      // is fresh for this exact call (calculateMarketFeatures() runs detectSRZones()
      // synchronously at the top of this function), so no extra recompute is needed.
      srZones: features.srZones.map(zone => ({
        price: zone.price,
        type: zone.type,
        touches: zone.touches,
        rejectionWicks: zone.rejectionWicks,
        reactionStrength: zone.reactionStrength,
        source: zone.source,
        confluenceScore: zone.confluenceScore,
        tier: zone.tier ?? 'TIER_1_LOCAL',
      })),
      upcomingHighImpactEvent: await this.getUpcomingHighImpactEventForOutlook(),
    };
  }
  
  private hypotheticalTrades: HypotheticalTrade[] = [];
  private slippageHistory: number[] = [];
  
  private calculateDynamicSlippage(marketRegime: MarketRegime, latency: number): number {
    let slippageMultiplier = 1.0;
    
    if (marketRegime.type === 'VOLATILE') {
      slippageMultiplier = 3.0;
      console.log('⏱️ SAM: VOLATILE regime -> 3.0x slippage multiplier');
    } else if (marketRegime.type === 'TRENDING') {
      slippageMultiplier = 1.5;
      console.log('⏱️ SAM: TRENDING regime -> 1.5x slippage multiplier');
    } else if (marketRegime.type === 'RANGING') {
      slippageMultiplier = 1.0;
    } else {
      slippageMultiplier = 0.8;
      console.log('⏱️ SAM: QUIET regime -> 0.8x slippage multiplier');
    }
    
    if (latency > LATENCY_WARNING_THRESHOLD_MS) {
      const latencyPenalty = Math.min(2.0, latency / LATENCY_WARNING_THRESHOLD_MS);
      slippageMultiplier *= latencyPenalty;
      console.log(`⏱️ SAM: High latency (${latency.toFixed(0)}ms) -> ${latencyPenalty.toFixed(2)}x additional penalty`);
    }
    
    const dynamicSlippage = BASE_SLIPPAGE_BUFFER_PIPS * slippageMultiplier;
    return parseFloat(Math.max(0.3, Math.min(5.0, dynamicSlippage)).toFixed(2));
  }
  
  recordHypotheticalTrade(signalId: string, entryPrice: number, idealExit: number, idealMarketPrice: number): void {
    const slippageDifference = Math.abs(idealExit - idealMarketPrice);
    
    const hypotheticalTrade: HypotheticalTrade = {
      signalId,
      entryPrice,
      idealExit,
      actualMarketPrice: idealMarketPrice,
      slippageDifference,
      timestamp: new Date(),
    };
    
    this.hypotheticalTrades.push(hypotheticalTrade);
    if (this.hypotheticalTrades.length > HYPOTHETICAL_TRADE_HISTORY_LIMIT) {
      this.hypotheticalTrades.shift();
    }
    
    this.slippageHistory.push(slippageDifference);
    if (this.slippageHistory.length > 50) {
      this.slippageHistory.shift();
    }
    
    const avgSlippageDiff = this.slippageHistory.reduce((a, b) => a + b, 0) / this.slippageHistory.length;
    
    console.log(`📈 Hypothetical Trade Recorded: ID ${signalId}`);
    console.log(`   Ideal Exit: ${idealExit.toFixed(1)} | Actual Market: ${idealMarketPrice.toFixed(1)}`);
    console.log(`   Hypo-Slippage: ${slippageDifference > 0 ? '+' : ''}${slippageDifference.toFixed(2)} pips ${slippageDifference > 0 ? 'worse' : 'better'} than ideal`);
    console.log(`   Avg Slippage Diff (Last 50): ${avgSlippageDiff.toFixed(2)} pips`);
  }
  
  getHypotheticalTradeStats(): { avgSlippageDiff: number; hypotheticalAccuracy: number } {
    if (this.slippageHistory.length === 0) {
      return { avgSlippageDiff: 0, hypotheticalAccuracy: 100 };
    }
    
    const avgSlippageDiff = this.slippageHistory.reduce((a, b) => a + b, 0) / this.slippageHistory.length;
    const accuracy = Math.max(0, 100 - (avgSlippageDiff * 10));
    
    return {
      avgSlippageDiff: parseFloat(avgSlippageDiff.toFixed(2)),
      hypotheticalAccuracy: parseFloat(accuracy.toFixed(1)),
    };
  }
  
  async manualRetrain(reason: string = 'Manual Trigger'): Promise<{ success: boolean; message: string }> {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔧 MANUAL RETRAINING INITIATED`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   Reason: ${reason}`);
    console.log(`   Triggered at: ${new Date().toISOString()}`);
    console.log(`   Current Trade Outcomes: ${this.tradeOutcomes.length}`);
    
    if (this.tradeOutcomes.length < 10) {
      const message = `Insufficient data for retraining. Need at least 10 outcomes, have ${this.tradeOutcomes.length}.`;
      console.log(`   ❌ ${message}`);
      console.log(`${'='.repeat(80)}\n`);
      return {
        success: false,
        message
      };
    }
    
    try {
      await this.walkForwardOptimization(reason);
      
      const message = `Model successfully retrained with ${this.tradeOutcomes.length} outcomes. Training time: ${new Date(this.lastTrainingTime).toISOString()}`;
      console.log(`   ✅ ${message}`);
      console.log(`   New Model Health Score: ${this.modelHealthScore.toFixed(0)}/100`);
      console.log(`${'='.repeat(80)}\n`);
      
      return {
        success: true,
        message
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const message = `Failed to retrain model: ${errorMessage}`;
      console.error(`   ❌ ${message}`);
      console.log(`${'='.repeat(80)}\n`);
      
      return {
        success: false,
        message
      };
    }
  }

  /**
   * Raw persisted model_weights_v1 contents, for the Settings > Export
   * Diagnostics feature. Reads directly from AsyncStorage rather than the
   * in-memory this.modelWeights map so the export reflects exactly what was
   * actually persisted. Returns null (not a default/empty map) when the model
   * has never been retrained yet, so callers can render an explicit
   * "never retrained" message instead of a misleading empty section.
   */
  async getRawModelWeightsForExport(): Promise<{ weights: [string, number][]; lastTrainingTime: number } | null> {
    try {
      const weightsData = await AsyncStorage.getItem(MODEL_WEIGHTS_KEY);
      if (!weightsData) return null;
      const parsed = JSON.parse(weightsData);
      const weights: [string, number][] = Array.isArray(parsed?.weights) ? parsed.weights : Array.isArray(parsed) ? parsed : [];
      const lastTrainingTime: number = typeof parsed?.lastTrainingTime === 'number' ? parsed.lastTrainingTime : 0;
      if (weights.length === 0 && !lastTrainingTime) return null;
      return { weights, lastTrainingTime };
    } catch (error) {
      console.error('[SignalEngine] Failed to read raw model weights for export:', error);
      return null;
    }
  }

  getTradeOutcomeCount(): number {
    return this.tradeOutcomes.length;
  }
}

export const signalEngine = new SignalGenerationEngine();

export async function fetchLiveGoldPriceFallback(): Promise<{ price: number; source: string }> {
  return fetchLiveGoldPrice();
}

export function setExternalPrice(price: number, source: string): void {
  if (price <= 1000 || price > 10000 || isNaN(price)) {
    console.warn(`⚠️ setExternalPrice: Invalid price ${price}, ignoring`);
    return;
  }

  cachedGoldPrice = price;
  lastFetchTime = Date.now();
  lastPriceSource = source;
  lastKnownGoodPrice = price;
  _consecutiveFailures = 0;

  signalEngine.pushExternalPrice(price, source);
}
