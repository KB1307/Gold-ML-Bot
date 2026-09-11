import { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext, DetectedSRZone } from "@/types/trading";
import { pushShadowSellRecord, type ShadowSellRecord } from "@/services/shadowSignalService";
import { writeCounterTrendSuppression } from "@/services/counterTrendShadow";
import { computeSwingStructure, detectDoubleTop, detectScoredReopen, detectZoneRetestLong, persistShadowStrategy, SHADOW_CONCURRENCY_CAP, SWING_TOLERANCE } from "@/services/shadowStrategies";
import { resolveShadowRows } from "@/services/shadowResolver";
import { pushEmittedSignalRecord } from "@/services/emittedSignalService";
import { BAND_PROXIMITY_VETO_ENABLED, evaluateBandProximityVeto } from "@/services/bandProximityVeto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchHistoricalData, trpcClient } from "@/lib/trpc";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { Platform } from "react-native";
import { appendOutcome as appendOutcomeToStore, getAllOutcomes as getAllOutcomesFromStore, getOutcomeCount as getOutcomeCountFromStore, migrateLegacyOutcomesIfEmpty, pruneToCap as pruneOutcomeStoreToCap, pushOutcomesToRemote, hydrateFromRemote as hydrateLearningStoreFromRemote, getLearningCorpusStats, type StoredTradeOutcome } from "@/services/learningStore";
import { resolveSignalWithBars } from "@/services/signalResolver";
import type { MfeResult } from "@/services/maxFavourableExcursion";
import type { OhlcBar } from "@/services/barStore";
import { filterTrainingCorpus, computeSideRelativeFeatures, fitLogisticRegression, extractFeatureVector, scoreLogisticModel, parsePersistedLogisticModel, getLogisticWeightName, meanKeyName, stdKeyName, verdictForProbability, MODEL_FEATURE_KEYS, MODEL_BIAS_KEY, type LogisticModel } from "@/services/modelFitting";
import { appendDiagnosticEvent } from "@/services/diagnosticEventStore";
import { fetchTier0SRZones, recordTier0FallbackUse } from "@/services/srZoneTier0Service";
import { recordAppFeedTick } from "@/services/appFeedBarCapture";
import { DirectionalScoreAccumulator } from "@/services/directionalScoring";
import { computeMarketStructure, findNearbyUnmitigatedOBs } from "@/services/marketStructure";
import { EXECUTION_COST_PER_TRADE_USD, costInR } from "@/constants/executionCost";
import {
  attentionOpposesSignal,
  attentionSideForKey,
  buildCounterTrendGateTelemetry,
  type AttentionSide,
  type CounterTrendGateTelemetry,
} from "@/services/attentionTelemetry";
import {
  aggregateBars,
  barADX,
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
  isBarSeriesFresh,
  sealBarSeries,
  type Bar,
  type BarSeries,
} from "@/services/barIndicators";

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
  /**
   * ITEM 224 — max favourable excursion, split at the terminal bar. Supplied by
   * the CALLER from the resolver that produced this outcome, because the engine
   * has no bars of its own at record time. Absent means "this path had no bars
   * to measure", NOT "the excursion was zero" — the two must never collapse.
   *
   * OBSERVATIONAL: read by measurement scripts only. It feeds no gate, no score,
   * no weight fitting and no ladder, so it cannot alter what the engine emits.
   * BEFORE-EXIT is capturable; AFTER-EXIT is counterfactual (Item 204).
   */
  maxFavourable?: MfeResult;
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
  /**
   * ITEM 191 — the legacy spot-relative type (cluster.price > currentPrice at
   * compute time). ALWAYS stored alongside the live type so both typings stay
   * comparable forever; snapshot consumers use it to audit the directed typing.
   */
  legacyType: 'SUPPORT' | 'RESISTANCE';
  /** ITEM 191 — approaches from BELOW rejected back down (true resistance behaviour), counted over the engine's in-memory price-history window. */
  rejectionsFromBelow: number;
  /** ITEM 191 — approaches from ABOVE rejected back up (true support behaviour). */
  rejectionsFromAbove: number;
  tier: 'TIER_0_SERVER' | 'TIER_1_LOCAL';
  /**
   * ITEM 212 — merged cluster STRENGTH price (weighted centroid / strongest member).
   * This is the price used for scoring and gating (reactionStrength, touches).
   */
  strengthPrice: number;
  /**
   * ITEM 212 — merged cluster ENTRY-EDGE price.
   * For a SUPPORT cluster, the lowest price (best long entry).
   * For a RESISTANCE cluster, the highest price (best short entry).
   * Used for await-the-zone / signal targeting, separate from strengthPrice.
   */
  entryEdgePrice: number;
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
  // ITEM 3: bar-based directional features (from Supabase gold_m1_bars via M5
  // aggregation). These are the ONLY inputs that may contribute to directional
  // buySignalStrength. Tick-based priceHistory may NOT feed directional score.
  barBasedPriceActionPattern: string;
  barBasedVwap: number | null;
  barBasedTrendStrength: number;
  barBasedRegimeType: string;
  barBasedRegimeStrength: number;
  barBasedAdx: number | null;
}

const CACHE_DURATION = 7000;
let cachedGoldPrice: number | null = null;
let lastFetchTime: number = 0;
/**
 * ITEM 17b — the instant a price was genuinely OBSERVED from a live source.
 *
 * This is deliberately NOT `lastFetchTime`. `lastFetchTime` is reset to now()
 * by `updateCurrentPrice()` even when `fetchLiveGoldPrice()` returned a CACHED
 * or STALE value (see the cache-replay branches in fetchLiveGoldPrice), so
 * `now - lastFetchTime` reports a fresh anchor while the underlying quote is
 * arbitrarily old. That is the mechanism behind the 02:48Z staleness event.
 * This variable is written ONLY where a real new quote arrives.
 */
let lastRealPriceObservedAt: number = 0;
/** Source tag of the last genuinely observed (non-replayed) price. */
let lastRealPriceSource: string = 'none';
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
 * ITEM 4 — durable home for the SECTION 8 (F6 criterion 4) counters.
 *
 * They were process-lifetime, so an app reload zeroed them and a full trading
 * day exported as "Readiness checks: 0, Stand-asides: 0" — indistinguishable
 * from "never checked". AsyncStorage is chosen over Supabase deliberately: these
 * are per-install process telemetry with no cross-device meaning, the write must
 * never depend on a network path (the Rork backend flaps 503 and is WRITE-only
 * by rule), and the engine already persists its other durable counters and model
 * state through this same key space.
 */
const DIRECTIONAL_LAYER_COUNTERS_KEY = 'directional_layer_counters_v1';
/**
 * EMISSION FUNNEL durable counters (SECTION 10). Same key-space rationale as
 * DIRECTIONAL_LAYER_COUNTERS_KEY above: per-install telemetry with no
 * cross-device meaning, written through AsyncStorage so the exit-path funnel
 * survives an app reload instead of restarting attribution from zero.
 */
const EMISSION_FUNNEL_COUNTERS_KEY = 'emission_funnel_counters_v1';
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
const MAX_STORED_OUTCOMES = 2000;

/**
 * ITEM 82 / B2 — F-12 FIX. Ceiling for the durable-corpus pull, deliberately far
 * above the corpus so it acts as a runaway guard and NOT as a window.
 *
 * ROOT CAUSE OF F-12, stated before the fix: the 300-row truncation was NOT a
 * PostgREST cap. `fetchRemoteOutcomesDirect` pages at `OUTCOMES_PAGE_SIZE = 500`
 * (learningStore.ts:567) and PostgREST caps a response at 1000, so neither limit
 * was reached. The cap was this module's own CALLER ARGUMENT: `{ limit: 300 }` at
 * the hydrate call site below, plus the same 300 as the parameter default at
 * learningStore.ts:996. Because 300 < 500 the loop exited after ONE page — which
 * is exactly what the export reported ("300 row(s) across 1 page(s)"). The
 * pagination was working correctly; it was never asked for more than 300 rows.
 *
 * `MAX_STORED_OUTCOMES` was the second, independent truncation: at 300 it sliced
 * the merged corpus back down to 300 rows even when more had been pulled, so the
 * learner, the drift computation and every corpus-size claim were all capped at
 * 300 regardless of how many resolved outcomes existed. Both are lifted here.
 */
const CORPUS_PULL_LIMIT = 5000;

/** ITEM 103 — TRAINING WINDOW.
 * Provenance: CHOSEN (not measured) at 14 days. This is the recurring
 * absolute-constant defect (48a, 48b, 56, 59, 73).
 * Item 103(b) held-out validation: 7d/14d/30d/60d/ALL all produced
 * accuracy within 0.8% of each other (49.2%-50.0%) on n=124 test set,
 * 95% CIs fully overlapping. Statistically INDISTINGUISHABLE.
 * Per rule: ship the LONGEST — more data at equal quality is strictly better.
 * Value 0 = no window filter (use ALL available outcomes).
 * The 14-day window cut 399 usable rows to ~35 — the learner saw <10% of
 * its corpus. With 0, it sees 100%. */
const TRAINING_WINDOW_DAYS = 0;
const MIN_CONFIDENCE_FOR_RETRAINING = 0.68;

/**
 * Phase 0 — learning→scoring linkage.
 * Converts a learned (normalized, signed) feature weight into a multiplier that
 * scales that feature's hardcoded scoring contribution inside
 * enhancedTransformerAnalysis(). At cold-start (no learned weight) the multiplier
 * is 1.0, so behaviour is identical to the pre-Phase-0 engine. As a feature's
 * learned importance rises the multiplier grows; as it drifts toward zero the
 * multiplier shrinks toward — and
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
// ITEM 130: RENAMED from ZONE_STALENESS_HALF_LIFE_HOURS. That name collided with a
// DIFFERENT constant of the same name in the two server zone paths
// (expo/backend/trpc/routes/srZones.ts:37 and
// backend/functions/refresh-sr-zones/index.ts:27), both = 18. The two values are
// INTENTIONALLY different — this LOCAL in-memory tier decays faster than the
// server tier, which represents a multi-day evidence base — but a shared name
// across live files means a grep for the constant returns two contradictory
// answers and neither caller can tell which tier it is reading. The LOCAL_ prefix
// makes the tier explicit so the CI guard can parity-assert the server pair
// without a false positive on this one. VALUE UNCHANGED at 6.
const LOCAL_ZONE_STALENESS_HALF_LIFE_HOURS = 6;
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
// ITEM 2c: widened from 72h to 35d so the dailyEMA component (needs 10
// completed daily bars) can genuinely fire. With 44+ days of M1 bars in
// Supabase, a 72h lookback yielded only 3 daily bars — dailyEMA was dead code.
// 35d yields ~25 completed daily bars (excluding weekends), well above the 10
// minimum. The buildDailyOHLCBarsFromHistoricalBars method groups M1 bars by
// NY trading day, so the extra bars are genuine completed daily candles.
const DAILY_OHLC_REFRESH_LOOKBACK_MS = 35 * 24 * 60 * 60 * 1000;
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

// ITEM 80(c) — :6001 calibration penalty instrumentation.
// Durable counters that persist across evaluations, surfacing how many times
// the 0.25/0.04 penalty fires and how many of those evaluations subsequently
// fail the confidence gate. Instrumentation only — the 0.25 and 0.04 values
// are unchanged until there is evidence to move them.
let calibrationPenalty25Count = 0;
let calibrationPenalty25ThenFailedCount = 0;

export function getCalibrationPenalty25Stats(): { count: number; thenFailed: number } {
  return { count: calibrationPenalty25Count, thenFailed: calibrationPenalty25ThenFailedCount };
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
 * ITEM 82 / B6 — F-4 FIX. Was a local `const ... = 0.05` here, commented
 * "broker-confirmed XAU spread". Two things were wrong with it:
 *   1. The value contradicted the project's closed $0.20 round-trip figure, and
 *      no $0.20 constant existed anywhere in the tree.
 *   2. It had exactly ONE consumer — the console.log at :7795 below — so it never
 *      entered a single EV, R-multiple or PnL computation. `realized_r`, which
 *      every book in this project is computed from, is produced FRICTIONLESS by
 *      both resolvers.
 * Now sourced from the one shared definition. See constants/executionCost.ts.
 */
/**
 * ITEM 111 — MODULATION_ENABLED.
 *
 * The learned modulation layer has NO measurable predictive power: held-out
 * accuracy is 49.2-50.0% across all training windows (CI [41%, 59%]), which is
 * chance. C-2 ten-feature validation (Item 111(d)) found ZERO features with CIs
 * excluding zero on the full population.
 *
 * ITEM 117(a) CORRECTION — the prior justification here was ARITHMETICALLY WRONG.
 * It claimed that with rsi_weight=-0.171 the LEARNED_MODULATION_MIN=0 clamp
 * "would ZERO the RSI family contribution entirely". That is false:
 *     1 + 2.5 * (-0.171) = +0.5725
 * which is ABOVE MIN=0 and is therefore NOT clamped. The true effect is a
 * REDUCTION to 0.57x of the RSI family contribution, not elimination.
 *
 * The MODULATION_ENABLED=false decision STANDS — it rests on the chance-level
 * held-out evidence above (49.2-50.0% accuracy, CI [41%, 59%]), which is
 * untouched by this correction. Only the justifying arithmetic was wrong.
 * (Contrast: the -0.684 weight documented further down DOES clamp, because
 * 1 + 2.5 * (-0.684) = -0.71 < 0. That comment is correct and unchanged.)
 *
 * RE-ENABLING CRITERION: held-out accuracy beats chance with p<0.05 (binomial
 * test, n>=200, accuracy >= 55%). Until then, modulation returns 1.0 (no-op).
 */
const MODULATION_ENABLED = false;

/**
 * ITEM 109 — TP ladder now uses the USER'S configured pip settings directly.
 * Prior: R-derived 0.7/1.05/1.4R of dynamicSlPips, which ignored settings.tp1Pips/
 * tp2Pips/tp3Pips entirely. Canonical re-resolution (n=412) showed user pips win:
 * EV_net +0.0371R vs +0.0198R, TP1 hit 65.0% vs 61.2%, await-the-zone conversions
 * 16/20 (80%) vs 13/20 (65%). The R-multiple constants below are retained for
 * the near-miss snapshot fallback only (recordNearMiss uses settings pips now).
 */
const SCALPER_TP_R_MULTIPLES = { tp1: 0.7, tp2: 1.05, tp3: 1.4 } as const;
const SCALPER_TP3_STRETCH_R = 1.5;
const SCALPER_TP3_STRETCH_MAX_R = 1.6;
/** Stops must clear the real noise floor: never tighter than 1.2 x ATR. */
const MIN_SL_ATR_MULTIPLE = 1.2;
/**
 * ITEM 17b — maximum age of the ENTRY ANCHOR at signal generation.
 *
 * Threshold derivation (age itself is NOT INSTRUMENTED historically, so it
 * could not be measured retrospectively — rule 8 applies and this is decided
 * on first principles, bounded by what WAS measurable):
 *   - EXTERNAL_PRICE_MAX_AGE_MS (15s) is the pre-existing, pre-registered
 *     definition of "fresh" for this exact anchor, so the cap must not be
 *     tighter than that or healthy operation would be rejected.
 *   - 60s is 4x that window, so it cannot fire on a healthy feed, and is ~5x
 *     TIGHTER than the >=5 minute staleness measured on the 02:48Z event.
 *   - Measured consequence at the tail: anchor-vs-Vantage divergence reached
 *     p99 $5.32 / max $11.68 over 379 signals, and TP1 sits only ~$4-5.6 away,
 *     so a tail-stale anchor is the entire first target wide.
 * The cap is the OUTER bound; the source-quality check below is what actually
 * catches the measured failure, since the cache-replay path can return a quote
 * of unbounded age while resetting the age clock.
 */
const ENTRY_ANCHOR_MAX_AGE_MS = 60 * 1000;
/** Source tags that mean "this quote was replayed, not observed" (ITEM 17b). */
const REPLAYED_PRICE_SOURCE_MARKERS = ['cache', 'stale', 'last-known'] as const;
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

export const ENFORCED_MIN_SIGNAL_CONFIDENCE = 0.68;
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
// ITEM 48(b): low-volatility safety net for S/R zone merge/touch distance.
// Must stay BELOW `atr * 0.3` in normal conditions so the ATR term actually
// governs band width. Calibrated against the real distribution of
// (atr*0.3)/price over 233 hourly samples of live gold_m1_bars: p25 = 9.56e-5,
// p50 = 1.22e-4. 0.0001 sits just above p25, so the floor binds only in roughly
// the bottom quartile of volatility (a genuinely quiet tape) and real ATR
// governs the other ~72%. The previous 0.0015 produced $6.38 at gold $4,250
// versus an atr*0.3 term of ~$0.55, so it won 233/233 samples — the ATR term
// was unreachable dead code and every zone got a fixed 128-pip band.
const ZONE_WIDTH_FLOOR_PCT = 0.0001;
/** ITEM 96 — PATH-TO-TARGET VETO. Derived from canonical split (n=161):
 * path-blocked n=22 WR=36.4% EV=-0.2193R vs path-clear n=139 WR=58.3% EV=+0.0537R,
 * ΔWR=21.9%, 95% CI [0.2%, 43.6%]. Unconditional — no setting disables it. */
const PATH_TO_TARGET_VETO_ENABLED = true;
/**
 * ITEM 137 — ENTRY-QUALITY TRIGGER (await-the-zone for path-clear signals).
 *
 * MEASUREMENT (expo/scripts/item137_138_139_measure.ts, 137(b)):
 *   Near (<1.5 ATR to nearest same-side zone): n=79 WR=40.5% EV=-0.2125R
 *   Far (>=1.5 ATR):                         n=41 WR=53.7% EV=+0.0303R
 * The far bucket is BETTER, not worse — the opposite of the pre-registered
 * gate's assumption. Entering far from a same-side zone does not degrade
 * outcome; if anything it improves it. The gate FAILS.
 *
 * SHIPPED BEHIND AN OFF FLAG (Item 137(e)): underpowered must not mean
 * deferred. The flag is off because the measurement inverted the hypothesis.
 * Forward evidence that would flip it: a regime-conditioned split where the
 * far bucket degrades in TRENDING markets specifically (the current split is
 * regime-agnostic). Until then, await-the-zone stays veto-only.
 */
const ENTRY_QUALITY_TRIGGER_ENABLED = false;
/**
 * ITEM 191(f) — REJECTION-DIRECTED ZONE TYPING.
 *
 * Zone type was assigned by a bare spot comparison (cluster.price > currentPrice
 * at compute time, detectSRZones): the moment price pokes above a band that
 * has rejected it from below all session, that band flips to "SUPPORT" and the
 * engine buys straight into it (the 4601, 4565 and 4438.6 top-buys all share
 * this one mechanism).
 *
 * MEASUREMENT (expo/scripts/item191_192_193_round.ts, 2026-08-21, canonical
 * n=147, re-typing from gold_m1_bars over the 24h before emission): 27 of 147
 * signals would flip emit->veto under directed typing. Changed set WR=37.0%
 * [21.5, 55.8] EV_net=-0.2794R [-0.652, 0.124] vs unchanged WR=50.0%
 * EV_net=-0.1028R. Direction favours the fix, but at MDE ±29.7pp the
 * changed-set EV CI SPANS ZERO — UNDERPOWERED.
 *
 * SHIPPED BEHIND AN OFF FLAG per the Item 191(f) gate: underpowered must not
 * mean deferred. The typing, the directional counts and legacyType ship NOW
 * and are recorded on every zone of every sr_zones_snapshot, so forward
 * evidence accumulates on the LIVE system. Flip condition (pre-registered):
 * re-run the 191(e) measurement at n>=100/arm (~6 weeks at the current
 * accrual) and ship ON only if the changed set's EV_net advantage holds with
 * the CI excluding zero. NOT neutralised by any floor/clamp: the flag gates
 * only the type assignment; reactionStrength, touches and rejectionWicks are
 * untouched by this flag.
 */
const REJECTION_DIRECTED_ZONES_ENABLED = false;
/**
 * ITEM 192(d) — NO-STRUCTURE ROUTE (an empty opposing set is NOT a clear path).
 *
 * MEASUREMENT (192(b), canonical n=147, LEGACY typing as the shipped veto
 * actually saw): zero-opposing n=8 WR=50.0% [21.5, 78.5] EV_net=-0.1876R
 * [-0.766, 0.404] vs >=1-opposing n=139 WR=47.5% EV_net=-0.1322R. MDE
 * ±50.7pp — the zero arm holds 8 of the 30 rows the pre-registered gate
 * (n>=30/arm) requires, and both CIs are uninformative.
 *
 * SHIPPED BEHIND AN OFF FLAG per Item 192(d). ACCRUAL MEASURED FROM THE DATA
 * (not assumed): 8 zero-opposing canonical rows accumulated over the snapshot
 * era 2026-07-16 -> 2026-08-21 (36 days) = ~0.22/day (~1.6/week); the zero
 * arm reaches n=30 around 2026-11-28 at that rate.
 * Flip condition (pre-registered, unchanged from 180(e)/192(c)): the
 * zero-opposing arm is materially worse with the EV CI excluding zero at
 * n>=30/arm.
 *
 * When ON, this routes zero-opposing signals to await-the-zone at the
 * strongest same-side shelf within the Item 104 band (3 ATR) instead of
 * emitting at market — and vetoes outright when no same-side shelf exists in
 * the band either. It ALSO makes await-the-zone reachable independently of
 * the veto branch (Item 193(b)): the 4601/4565/4438.6 top-buys were all
 * zero-opposing maps the veto branch could never reach.
 */
const NO_STRUCTURE_VETO_ENABLED = false;
/**
 * ITEM 196(d) — ASYMMETRIC ENTRY BUFFER (the user's own design request).
 *
 * BUY 4500 -> fill band 4495-4500 (enter DEEPER); SELL 4500 -> 4500-4505.
 * The whole TP/SL ladder derives from entryPriceWithSlippage
 * (signalEngine.ts:8882-8885), so shifting the entry shifts the ladder by the
 * same delta. If price never reaches the band the trade is missed
 * (EXPIRED_MISSED_ENTRY) — a miss forgoes EV, it never books a loss.
 *
 * MEASUREMENT (expo/scripts/item196d_entry_buffer.ts, 2026-08-21, canonical
 * n=328, retrace rates split by WIN/LOSS, canonical re-resolution from the
 * deeper entry with the ladder shifted, miss cost NETTED):
 *   retrace >=20p: WIN 92.8% / LOSS 100.0%   >=30p: 87.8% / 100.0%
 *   >=50p: WIN 79.0% / LOSS 98.6%            >=80p: 64.1% / 90.5%
 *   netEV: actual -0.0697R | 20p -0.0415R | 30p -0.0012R | 50p +0.0809R |
 *   80p +0.0318R. DERIVED WIDTH = 50 pips ($5): best net EV, +0.151R vs
 *   at-market, at a 79.0% WIN / 98.6% LOSS fill rate (missed 40/328).
 *
 * SHIPPED BEHIND AN OFF FLAG: the +0.151R improvement sits right at the
 * stated paired MDE (~±0.15R at this n) — favourable direction, marginal
 * power. NOT neutralised: when ON the buffer shifts entryPriceWithSlippage
 * directly with no clamp or floor downstream of it; when OFF the entry is
 * bit-for-bit unchanged. Forward evidence to flip: paired re-measure at
 * n>=500 (~10 weeks) with the CI excluding zero.
 */
const ENTRY_BUFFER_ENABLED = false;
const ENTRY_BUFFER_PIPS = 50; // DERIVED (196d): best net-EV width from the canonical re-resolution
/**
 * PHASE C / C2 — BEHIND-ENTRY ARMING for await-the-zone (ITEM 210/211 route).
 * Ships OFF. The 2026-08-24 failed BUYs (bl78nz, z6o9nm) both had an opposing
 * zone BEHIND the entry rather than in the path — a shape the path-to-target
 * veto cannot see and await-the-zone cannot arm for (it arms only from the
 * blocking-zone branch or the OFF no-structure branch). This is the fourth
 * arming condition: nearest opposing zone BEHIND entry within
 * BEHIND_ENTRY_ARMING_MAX_ATR (1.0 ATR — the Item 210 bucket boundary where
 * bucket EV flips sign: <=0.5 ATR +0.5685R, 0.5-1.0 +0.1960R, >2.0 -0.0839R)
 * AND a same-side shelf inside the 3 ATR band (RS >= 0.3) -> arm a pending
 * entry at the shelf instead of emitting at market.
 * MEASURED ACCRUAL (2026-08-24, live probe): 7/335 canonical (2.1%) match the
 * condition; LIVE rate 7/36 = 19.4% of LIVE emissions, ~2.8/week; armed EV
 * +0.1623R at n=7 (deeply underpowered — recorded, not acted on).
 * GATE (pre-registered): flip ON only when the armed bucket reaches n>=30 with
 * the EV CI excluding zero; at ~2.8/week that projects ~2026-11-15. Re-run the
 * rate probe before flipping — if the LIVE rate regresses toward the canonical
 * 2.1%, the projection slips past 2028 and the gate should be restated.
 */
const BEHIND_ENTRY_ARMING_ENABLED = false;
const BEHIND_ENTRY_ARMING_MAX_ATR = 1.0;
/**
 * ITEM 138(d) — TP3 CONFIDENCE STRETCH.
 *
 * MEASUREMENT (138(c)): the TP3/SL ratio for high-confidence (>=0.89) signals
 * is 1.60 vs 1.06 for low-confidence — the stretch at the old :8056-8057 code
 * IS firing and changing geometry. Combined with F-33 (confidence is
 * anti-predictive), this means the engine stretches TP3 for the signals whose
 * confidence ranking is INVERTED — giving the worst-EV cohort a wider target.
 *
 * The stretch is currently inert because Item 109 rewired the TP ladder to
 * user-pips (settings.tp3Pips is the absolute distance), but the flag is
 * retained so any future confidence-conditioned geometry change is explicitly
 * gated rather than implicit.
 */
const TP3_CONFIDENCE_STRETCH_ENABLED = false;
/**
 * ITEM 116 — OB FILTER, RE-WIRED TO THE CONSTRUCT THAT WAS ACTUALLY MEASURED.
 *
 * DEFECT FIXED: Item 114 shipped a filter reading `features.orderBlocks`, which
 * comes from the CLASS-LOCAL `this.detectOrderBlocks()` built off
 * `this.priceHistory` — the Capital.com/Swissquote TICK stream — filtered to the
 * last 4 hours, kept as TOP 10 BY STRENGTH, with NO mitigation tracking.
 * Item 108's authorising measurement used `computeMarketStructure()` over 24h of
 * BARS with real mitigation tracking. Two different constructs; the measurement
 * did not authorise the filter that shipped (same defect class as B22's zone
 * width being neutralised by a price floor).
 *
 * It also violated the DATA-SOURCE RULE: priceHistory feeds entry TIMING only
 * and must never gate emission.
 *
 * NOW: the filter reads `findNearbyUnmitigatedOBs(computeMarketStructure(bars))`
 * over the engine's BAR arrays (highHistory/lowHistory/barCloseHistory), with
 * mitigation honoured and NO top-10-by-strength truncation — the measured
 * construct. See `buildStructureBars()` and `hasNearbyUnmitigatedOB()`.
 */
const OB_FILTER_ENABLED = false;
/** PHASE C / C3 — REMOVAL (pre-registered criterion met 2026-08-24).
 * Re-measured a SECOND time on the CURRENT construct over the grown canonical
 * book (scripts/item159_160_161_round.ts, artifacts/item160_remeasure_run.txt):
 *   OB-present n=306 EV_net=+0.0006R CI=[-0.1016,0.1028] PF=1.00
 *   OB-absent  n=118 EV_net=+0.0177R CI=[-0.1443,0.1796] PF=1.05
 *   Welch t=-0.174 p≈0.8616
 * Both arms now exceed the pre-registered n≥100 threshold and the split STILL
 * does not exclude zero (p=0.86) — the original authorising split (Item 114:
 * z=2.295, p=0.0217) has now failed to reproduce TWICE. The 160(c) relaxation
 * (hard reject → 5pt penalty) was itself a post-hoc loosening: it kept charging
 * a penalty against an unvalidated confidence score on an effect that does not
 * exist. The filter is therefore REMOVED (enabled=false).
 * RE-ENABLE criterion (unchanged): a held-out re-measurement with n≥100 per
 * arm whose OB-present vs OB-absent EV difference excludes zero at 95%,
 * FAVOURING the filter — then re-enable and set OB_FILTER_MODE='reject'. */
/**
 * ITEM 226 (C5) — THIS CONSTANT IS CURRENTLY DEAD, AND DELIBERATELY RETAINED.
 *
 * REACHABILITY, VERIFIED AT LINE LEVEL: the only read of OB_FILTER_MODE that can
 * affect behaviour is at :8845 (`if (OB_FILTER_MODE === 'reject')`), which sits
 * INSIDE `if (OB_FILTER_ENABLED)` at :8840. With OB_FILTER_ENABLED = false that
 * whole block is unreachable, so the value 'penalty' has NO effect on emission
 * today — neither the hard reject nor the 5pt OB_ABSENT_CONFIDENCE_PENALTY path
 * can run. The only other read is getRuntimeConfigProbe() at :2910, which merely
 * REPORTS the value into the diagnostics export and gates nothing.
 *
 * NEUTRALISATION CHECK (guardrail): there is no floor, clamp or Math.max applied
 * to this constant or to OB_ABSENT_CONFIDENCE_PENALTY on any read path — the
 * penalty is a plain subtraction at :8854 compared against the pre-existing
 * absoluteConfidenceFloor. So the constant is not silently neutralised; it is
 * simply not reached.
 *
 * WHY RETAIN RATHER THAN DELETE: the re-enable criterion documented immediately
 * above explicitly names setting OB_FILTER_MODE='reject'. The constant IS that
 * documented path, so deleting it would delete the shape of the decision and
 * leave a criterion referring to something that no longer exists. What was
 * wrong was the SILENCE — a live-looking 'penalty' value implying an active
 * penalty. That is now stated here instead of being inferable only by reading
 * two distant call sites.
 */
const OB_FILTER_MODE: 'reject' | 'penalty' = 'penalty';
/** ITEM 160(c) — confidence penalty (percentage points) applied when no
 * nearby unmitigated OB exists. A candidate whose penalised confidence falls
 * below the engine floor is still rejected; everything above still emits. */
const OB_ABSENT_CONFIDENCE_PENALTY = 0.05;
/** ITEM 116 — proximity threshold in ATR. Matches the authorising measurement's
 * `findNearbyUnmitigatedOBs(structure, price, atr, 3)` default exactly. */
const OB_PROXIMITY_ATR = 3;
/** ITEM 116 — minimum bars required before the OB filter may reject. Below this
 * the structure is not computable and the filter ABSTAINS (passes) rather than
 * rejecting on absent data — a filter must never reject for lack of input. */
const OB_FILTER_MIN_BARS = 21;
/** ITEM 97 — ZONE CLUSTERING MERGE THRESHOLD (derived). Gap distribution across
 * 1242 same-side pairs: p25=2.00 ATR, 18.3% within 1.5 ATR. Merging at 1.5 ATR
 * collapses the overlapping fifth while keeping distinct levels (p25=2.0) separate. */
const ZONE_MERGE_THRESHOLD_ATR = 1.5;
/** ITEM 99 — 24-HOUR TRAILING ZONE WINDOW.
 * Gate passed: short-horizon reversal persistence is positive and > +0.3 at all
 * three tested horizons (4h=+0.3644, 8h=+0.4117, 12h=+0.4507, all with tight CIs).
 * The 120h window produced 9 SUPPORT vs 2 RESISTANCE (dense, overlapping). The
 * 24h window produces a more balanced 7S/10R map. Ship ON. */
/** ITEM 105 — CLUSTER-SCOPED DEDUP GUARD (replaces Item 97's time-window proxy).
 *
 * The 30-min time window let the motivating 5-signal cluster through by 1 minute.
 * The real cluster is 15 BUYs spanning 204 min within 3.59 ATR. A time window
 * is a proxy for "same zone cluster" and a worse one.
 *
 * PRIMARY mechanism: suppress a same-direction signal while an ACTIVE signal
 * exists in the same zone cluster, regardless of elapsed time. An ACTIVE
 * signal is one that has not yet reached a terminal status (SL/TP/TP1+).
 *
 * SECONDARY backstop: a time window (DEDUP_TIME_WINDOW_MS) as a safety net for
 * the case where an active signal's zone cluster is not available. Derived
 * from the 15-signal cluster's max time gap of 204.6 min → ceil to 210 min.
 * Price band derived from max gap of 3.59 ATR → ceil to 4.0 ATR.
 *
 * Measurement (n=328 same-direction pairs within 2h): 49.4% within 30 min,
 * 73.8% within 60 min, 90.5% within 2.0 ATR. The cluster-scoped guard is
 * strictly more conservative than the time window because it does not expire. */
const DEDUP_PRICE_BAND_ATR = 4.0;
/**
 * ITEM 118 — RE-DERIVED FROM DUPLICATE CLUSTERS, superseding Item 113(b).
 *
 * Item 113(b) took p95 of ALL same-direction pair gaps (n=3813) = 1387 min and
 * shipped 1390 min. That was the WRONG DISTRIBUTION. The window's job is to catch
 * DUPLICATES, so it must come from the gaps observed INSIDE genuine duplicate
 * clusters — not from every same-direction pair in the book, most of which are
 * legitimately distinct setups hours apart at different price levels. p95 of all
 * pairs suppresses 95% of LEGITIMATE setups; at 1390 min (23.2 hours) combined
 * with DEDUP_PRICE_BAND_ATR=4.0 that approaches one signal per direction per day.
 *
 * DUPLICATE CLUSTER DEFINITION (Item 118a): a maximal set of >= 2 signals sharing
 * ALL of (1) same direction, (2) entries within DEDUP_CLUSTER_BAND_ATR=1.5 ATR,
 * (3) overlapping [entry, tp3] ladder intervals; chained transitively in emission
 * order. Measured on n=426 resolved signals: 15 duplicate clusters, 396 internal
 * consecutive gaps, distribution p25=10.2 / p50=54.8 / p75=224.6 / p90=637.4 min.
 *
 * SHIPPED VALUE = p75 of cluster-internal gaps = 224.6 -> 225 min.
 *
 * WHY p75 AND NOT p95: p95 of the cluster-internal distribution is 1866.8 min,
 * WIDER than the 1390 it replaces, because single-linkage chaining merges some
 * clusters that span weeks (largest chained cluster = 180 signals), inflating the
 * upper tail. That tail is a chaining artefact, not a real duplicate gap. p75 is
 * taken from the dense, well-populated part of the distribution and is robust to
 * it. This window is the SECONDARY backstop only — it exists for the case where a
 * signal's zone cluster is unavailable. The PRIMARY cluster-scoped guard catches
 * the rest, and measurement confirms it: cluster-guard-alone survives 39 signals
 * vs 40 with the 1390-min window over a 50.1-day book — the wide time window adds
 * essentially NOTHING (1 signal in 50 days) while costing enormous emission.
 *
 * NOT NEUTRALISED: this value is compared directly against elapsed ms in the
 * dedup check; there is no floor, clamp or Math.max applied to it anywhere.
 */
const DEDUP_TIME_WINDOW_MS = 225 * 60 * 1000;
/** ITEM 105 — Zone cluster proximity for dedup. Same as ZONE_MERGE_THRESHOLD_ATR:
 * if two signals' entries are within 1.5 ATR, they are in the same zone cluster. */
const DEDUP_CLUSTER_BAND_ATR = 1.5;
/** ITEM 107 — SESSION-LIQUIDITY TELEMETRY.
 * Pre-open (0-15 min before session open): n=7, WR=28.6%, EV=-0.6516R.
 * UNDERPOWERED (< 15). Expansion measurement: avg range 60min AFTER 07:00 UTC
 * is $13.92 vs $16.33 BEFORE — expansion is -14.8% (range DECREASES, not
 * increases). The London-open expansion hypothesis is NOT confirmed.
 * Ship TELEMETRY only: minutes-to-open recorded per signal. Forward evidence:
 * once n >= 30 in the pre-open bucket, re-run and ship a delay gate if the gap
 * is material. */
const SESSION_OPEN_LONDON_UTC_HOUR = 7;
const SESSION_OPEN_NY_UTC_HOUR = 13;
/** PHASE D / D3 — STRENGTH-WEIGHTED ZONE SELECTION: DELETED 2026-08-24.
 * The Item 98(c) flag shipped OFF at n=2 near-strongest vs n=46 near-weak and
 * NO CODE EVER READ IT — 120 items of "waiting for forward evidence" with no
 * instrument collecting any. A flag without a reader is a ledger lie: it
 * implies a decision exists when none does. Deleted rather than wired, per
 * the 150-218 audit. If strength-weighted selection is ever wanted, it must
 * ship as a REAL gated mechanism with an accrual instrument and a projected
 * flip date — not as a bare constant. */
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
  /** SMOOTHED confidence — the value every gate actually compares against. */
  confidence: number;
  /**
   * ITEM 54(b): RAW pre-smoothing confidence for the same scoring run, captured
   * so the UI and export can show both and never conflate them. Display and
   * telemetry only — no gate reads this. Undefined if the rejection happened
   * before any scoring run produced a raw value.
   */
  rawConfidence?: number;
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
 * ITEM 64 (2026-08-12) — EXPANDED CONSUMED SET.
 *
 * The consumed set was {rsi_weight, dxy_weight} only. With just two consumed
 * weights, the normalization was a two-horse race: when |raw_rsi| >> |raw_dxy|,
 * rsi_weight pinned at ±1.0 and getFeatureModulation('rsi_weight') clamped to
 * zero — the engine's largest-weighted feature contributed literally nothing
 * for nine days (2026-08-03 onward, confirmed from the live export).
 *
 * volume_weight and atr_weight are computed in retrainModel() and were already
 * fitted and persisted — they just never modulated scoring. Adding them to the
 * consumed set widens the normalization denominator so rsi can no longer pin
 * at ±1.0 by sole dominance.
 *
 * G64-1 RESULT (measured against the 51-row durable corpus, 27W/24L):
 *   OLD (consumed = rsi, dxy):    rsi_weight normalised = -1.000000, modulation = 0.000
 *   NEW (consumed = rsi, dxy, volume, atr): rsi_weight normalised = -0.684128
 *   The weight is no longer at ±1.0. However, with LEARNED_WEIGHT_GAIN=2.5,
 *   factor = 1 + 2.5 * (-0.684) = -0.71, still clamped to LEARNED_MODULATION_MIN=0.
 *   The modulation is NOT yet unclamped. The root cause is that |raw_rsi| (0.158)
 *   still dominates the expanded denominator (0.231) at 68.4%. For modulation > 0,
 *   the normalised weight must exceed -0.4 (i.e. 1 + 2.5*w > 0). The expansion
 *   moved the needle from -1.0 to -0.684 — progress, but not sufficient. This
 *   is reported per the G64-1 gate: the weight moved, the modulation did not.
 *
 * sentiment_weight and timeWindow_weight remain telemetry-only (not in the
 * consumed set) because getFeatureModulation is never called for them — no
 * scoring path reads them, so including them in the normalization denominator
 * would dilute the consumed weights without any scoring benefit.
 */
const CONSUMED_MODEL_WEIGHTS: ReadonlySet<string> = new Set(['rsi_weight', 'dxy_weight', 'volume_weight', 'atr_weight']);

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
/**
 * 3 = v2 wide vector PLUS the ITEM 28 counter-trend-gate / execution-cost
 * telemetry block.
 * 4 = ITEM AB: adds the seven side-relative model features (feat_* fields,
 * see services/modelFitting.ts). Every consumer checks `>= 2`, so the bump is
 * backward compatible and legacy records keep declaring 1, 2 or 3 truthfully.
 */
const LEARNING_FEATURE_SCHEMA_VERSION = 4;

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

/**
 * GG.3a — single source of truth for XAU/USD market hours, consumed by BOTH
 * the dashboard indicator (getMarketOutlook) and the price-feed gate
 * (goldWebSocketService). PURE SYNC, log-free, DB-free.
 *
 * Weekend coverage (NOT just the daily break):
 *   - isSaturday: all of Saturday
 *   - isFridayClose: Friday 21:00-23:59 UTC
 *   - isSundayBeforeOpen: Sunday 00:00-21:59 UTC
 *   - isDailyCloseBreak: 20:59-21:59 UTC every day (incl. Friday 20:59)
 */
// ═══ ITEM DC — M5 FEED FAILURE INSTRUMENTATION (diagnostic only) ═══════════
// WHY the M5 feed ends up empty — per-reason counters + last failure, for BOTH
// independent gold_m1_bars fetch paths:
//   (a) fetch_error    — the fetch threw or returned an error (retried 1s/3s/9s)
//   (b) zero_rows      — the fetch succeeded but returned 0 rows
//   (c) all_stale      — rows returned but all older than BAR_MAX_AGE_M5_MS
//   (d) interval_guard — the refresh early-returned on its 5-min guard while
//                        the series was still empty
// DIAGNOSTIC ONLY: nothing in gating reads these — they surface in SECTION 8.
export type M5FeedFailureReason = 'fetch_error' | 'zero_rows' | 'all_stale' | 'interval_guard';

export interface M5FeedPathDiagnostics {
  counters: Record<M5FeedFailureReason, number>;
  lastReason: M5FeedFailureReason | null;
  lastReasonAt: number | null;
  lastDetail: string | null;
}

export interface M5FeedDiagnostics {
  /** refreshM5SupabaseBars — the ITEM 3 bar-based feature feed. */
  item3: M5FeedPathDiagnostics;
  /** refreshBarSeries — the F1 series the SECTION 8 readiness check reads. */
  f1: M5FeedPathDiagnostics;
}

export interface GoldMarketClock {
  isMarketOpen: boolean;
  isSaturday: boolean;
  isFridayClose: boolean;
  isSundayBeforeOpen: boolean;
  isDailyCloseBreak: boolean;
}

export function getGoldMarketClock(now: Date = new Date()): GoldMarketClock {
  const hour = now.getUTCHours();
  const dayOfWeek = now.getUTCDay();
  const isSaturday = dayOfWeek === 6;
  const isFridayClose = dayOfWeek === 5 && hour >= 21;
  const isSundayBeforeOpen = dayOfWeek === 0 && hour < 22;
  const isDailyCloseBreak = isWithinDailyMarketClose(now);
  return {
    isMarketOpen: !isSaturday && !isFridayClose && !isSundayBeforeOpen && !isDailyCloseBreak,
    isSaturday,
    isFridayClose,
    isSundayBeforeOpen,
    isDailyCloseBreak,
  };
}

/** Boolean convenience wrapper over getGoldMarketClock for the price-feed gate. */
export function isGoldMarketOpen(now: Date = new Date()): boolean {
  return getGoldMarketClock(now).isMarketOpen;
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
  // ITEM 17b: a real quote actually arrived on this path.
  lastRealPriceObservedAt = now;
  lastRealPriceSource = source;
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
  const baseUrl = process.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL
    ?? process.env.EXPO_PUBLIC_RORK_API_BASE_URL;
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
  /**
   * ITEM AC — the fitted logistic model (13 weights + bias + corpus
   * means/stds). Restored from model_weights_v1 at boot, refreshed at every
   * retrain. The live scorer's ONLY model; null until an AC-architecture fit
   * has been persisted, in which case modelProbability is simply not stamped.
   */
  private logisticModel: LogisticModel | null = null;
  private lastTrainingTime: number = 0;
  /** ITEM 12 / 11(b): outcome count the persisted weight vector was trained on. */
  private corpusSizeAtTraining: number | null = null;
  /** ITEM 12 / 11(b): hydrateUnavailableCount as of that training pass. */
  private hydrateUnavailableAtTraining: number | null = null;
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
  /**
   * UU — mutually-exclusive market-gate rejection funnel (COUNTERS ONLY, no
   * scoring effect). Exactly ONE bucket increments per generation attempt
   * rejected by the market gate: saturday / fridayClose / sundayBeforeOpen /
   * dailyBreak name the closing condition (same precedence order as the reject
   * log), failSafe counts clock-throw / non-boolean stand-asides (UU.3).
   * Process-lifetime, like signalGenerationAttempts. The band veto persists its
   * counter as shadow rows because vetoes are rare; market-closed rejections
   * fire on EVERY attempt during closed hours, so these stay in-memory and are
   * greppable via the "REJECTED: MARKET_CLOSED — condition=" log line.
   */
  private marketGateRejections: {
    saturday: number;
    fridayClose: number;
    sundayBeforeOpen: number;
    dailyBreak: number;
    failSafe: number;
  } = { saturday: 0, fridayClose: 0, sundayBeforeOpen: 0, dailyBreak: 0, failSafe: 0 };

  /** UU — read access to the market-gate rejection funnel for diagnostics. */
  getMarketGateRejectionCounts(): { saturday: number; fridayClose: number; sundayBeforeOpen: number; dailyBreak: number; failSafe: number } {
    return { ...this.marketGateRejections };
  }

  /**
   * EMISSION FUNNEL — mutually-exclusive exit-path counters for generateSignal()
   * (COUNTERS ONLY, no gating effect). Every exit path of generateSignal()
   * records EXACTLY ONE bucket via recordFunnelRejection(); a successful
   * emission counts once via emissionFunnelEmitted at the single
   * confirmed-emission point (next to pushEmittedSignalRecord). attempts is the
   * pre-existing signalGenerationAttempts counter incremented at the top of
   * generateSignal(). The ❌ REJECTED log lines inside
   * enhancedTransformerAnalysis (winning-strength / strength-difference) are
   * deliberately NOT buckets: they are sub-gates of scoring, not exits — the
   * attempt continues after them.
   * Invariant: sum(rejections) + emitted === attempts. getEmissionFunnel()
   * reports the check so an unaccounted exit is visible immediately. The
   * in-process counters are mirrored into a durable AsyncStorage copy that
   * survives app reloads (funnelDurable below).
   */
  private emissionFunnelRejections: Record<string, number> = {};
  private emissionFunnelEmitted: number = 0;
  /**
   * EMISSION FUNNEL durability: the in-memory counters above die with the JS
   * process on every app reload, so the funnel also keeps a durable copy that
   * hydrates from AsyncStorage at boot (max-merged — never resets a live count
   * down) and flushes on the same 15s throttle as the SECTION 8 counters. A hard
   * reload can lose at most the last ~15s of counts; the durable invariant
   * check reports that shortfall honestly instead of hiding it.
   */
  private funnelDurable: { attempts: number; rejections: Record<string, number>; emitted: number } = {
    attempts: 0,
    rejections: {},
    emitted: 0,
  };
  private funnelFlushedAt: number = 0;
  /** Set once the persisted funnel has been read back in (loadEmissionFunnelCounters). */
  private funnelHydrated: boolean = false;

  private recordFunnelRejection(label: string): void {
    this.emissionFunnelRejections[label] = (this.emissionFunnelRejections[label] ?? 0) + 1;
    this.funnelDurable.rejections[label] = (this.funnelDurable.rejections[label] ?? 0) + 1;
    this.persistEmissionFunnelCounters();
  }

  /** Durable attempt counter — incremented next to signalGenerationAttempts. */
  private recordFunnelAttempt(): void {
    this.funnelDurable.attempts += 1;
    this.persistEmissionFunnelCounters();
  }

  /** Durable emitted counter — incremented at the single confirmed-emission point. */
  private recordFunnelEmission(): void {
    this.funnelDurable.emitted += 1;
    this.persistEmissionFunnelCounters();
  }

  /** EMISSION FUNNEL — read access for the diagnostics export (SECTION 10). */
  getEmissionFunnel(): {
    attempts: number;
    rejections: Record<string, number>;
    rejectionTotal: number;
    emitted: number;
    accounted: number;
    invariantOk: boolean;
    durableAttempts: number;
    durableRejections: Record<string, number>;
    durableRejectionTotal: number;
    durableEmitted: number;
    durableAccounted: number;
    durableInvariantOk: boolean;
    durableHydrated: boolean;
  } {
    const rejections: Record<string, number> = {};
    let rejectionTotal = 0;
    for (const [label, count] of Object.entries(this.emissionFunnelRejections)) {
      rejections[label] = count;
      rejectionTotal += count;
    }
    const accounted = rejectionTotal + this.emissionFunnelEmitted;
    const durableRejections: Record<string, number> = {};
    let durableRejectionTotal = 0;
    for (const [label, count] of Object.entries(this.funnelDurable.rejections)) {
      durableRejections[label] = count;
      durableRejectionTotal += count;
    }
    const durableAccounted = durableRejectionTotal + this.funnelDurable.emitted;
    return {
      attempts: this.signalGenerationAttempts,
      rejections,
      rejectionTotal,
      emitted: this.emissionFunnelEmitted,
      accounted,
      invariantOk: accounted === this.signalGenerationAttempts,
      durableAttempts: this.funnelDurable.attempts,
      durableRejections,
      durableRejectionTotal,
      durableEmitted: this.funnelDurable.emitted,
      durableAccounted,
      durableInvariantOk: durableAccounted === this.funnelDurable.attempts,
      durableHydrated: this.funnelHydrated,
    };
  }

  /**
   * EMISSION FUNNEL durability — hydrate from AsyncStorage so the funnel
   * survives an app reload. Idempotent; max-merge semantics mean a corrupt or
   * absent record never resets a live count down (same contract as the SECTION 8
   * counters). Called during boot next to loadDirectionalLayerCounters.
   */
  public async loadEmissionFunnelCounters(): Promise<void> {
    if (this.funnelHydrated) return;
    this.funnelHydrated = true;
    try {
      const raw = await AsyncStorage.getItem(EMISSION_FUNNEL_COUNTERS_KEY);
      if (!raw) {
        console.log('ℹ️ [EmissionFunnel] no persisted counters yet — starting from 0');
        return;
      }
      const parsed = JSON.parse(raw) as { attempts?: unknown; rejections?: unknown; emitted?: unknown };
      if (typeof parsed.attempts === 'number' && Number.isFinite(parsed.attempts) && parsed.attempts >= 0) {
        this.funnelDurable.attempts = Math.max(this.funnelDurable.attempts, Math.floor(parsed.attempts));
      }
      if (typeof parsed.emitted === 'number' && Number.isFinite(parsed.emitted) && parsed.emitted >= 0) {
        this.funnelDurable.emitted = Math.max(this.funnelDurable.emitted, Math.floor(parsed.emitted));
      }
      if (typeof parsed.rejections === 'object' && parsed.rejections !== null) {
        for (const [label, count] of Object.entries(parsed.rejections as Record<string, unknown>)) {
          if (typeof count === 'number' && Number.isFinite(count) && count >= 0) {
            this.funnelDurable.rejections[label] = Math.max(this.funnelDurable.rejections[label] ?? 0, Math.floor(count));
          }
        }
      }
      const durableTotal = Object.values(this.funnelDurable.rejections).reduce((a, b) => a + b, 0);
      console.log(
        `✓ [EmissionFunnel] restored attempts=${this.funnelDurable.attempts} rejections=${durableTotal} emitted=${this.funnelDurable.emitted}`,
      );
    } catch (error: unknown) {
      console.warn('⚠️ [EmissionFunnel] load failed (non-blocking):', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * EMISSION FUNNEL durability — throttled fire-and-forget flush, same 15s floor
   * as persistDirectionalLayerCounters: at most one write per 15s, so a hard
   * reload loses at most the last ~15s of counts.
   */
  private persistEmissionFunnelCounters(): void {
    const now = Date.now();
    if (now - this.funnelFlushedAt < 15_000) return;
    this.funnelFlushedAt = now;
    const payload = JSON.stringify({
      attempts: this.funnelDurable.attempts,
      rejections: this.funnelDurable.rejections,
      emitted: this.funnelDurable.emitted,
      updatedAt: now,
    });
    AsyncStorage.setItem(EMISSION_FUNNEL_COUNTERS_KEY, payload).catch((error: unknown) => {
      console.warn('⚠️ [EmissionFunnel] persist failed (non-blocking):', error instanceof Error ? error.message : String(error));
    });
  }
  /**
   * F6 criterion 4 telemetry (COUNTERS ONLY — no scoring effect).
   * `directionalStandAsideChecks` counts every time the generation path asked
   * whether the bar layer was usable; `directionalStandAsideCount` counts how
   * often it answered no and the engine stood aside. The pre-registered
   * refutation threshold is stand-aside > 5% of market-open attempts, which is
   * not evaluable unless BOTH numbers are recorded. Process-lifetime, like the
   * shadow-write counters — they monitor the CURRENT process, not history.
   */
  private directionalStandAsideChecks: number = 0;
  private directionalStandAsideCount: number = 0;
  /** ITEM 4: last epoch ms the counters above were flushed to AsyncStorage. */
  private directionalCountersFlushedAt: number = 0;
  /** ITEM 4: set once the persisted counters have been read back in. */
  private directionalCountersHydrated: boolean = false;
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
  /**
   * ITEM 54(a) — confidence smoother state, now keyed BY DIRECTION.
   *
   * This was a single engine-level `confidenceHistory: number[]` shared across
   * every scoring run. `smoothConfidence` blends 15% of the PREVIOUS entry, so a
   * fresh BUY setup was being blended with whatever the last run scored — often
   * an unrelated SELL candidate from a different minute and a different regime.
   * That is the same shared-mutable-field defect class Item 51 fixed in
   * `lastSignalStrengthDifference`: engine-level state read as if it were
   * per-setup state. Keying by candidate direction means a BUY only ever blends
   * with the previous BUY score and a SELL with the previous SELL score.
   */
  private confidenceHistoryByDirection: Record<'BUY' | 'SELL', number[]> = {
    BUY: [],
    SELL: [],
  };

  /**
   * ITEM 54(b) — last RAW (pre-smoothing) confidence, telemetry only.
   * Surfaced next to the smoothed value so the two are never conflated in the
   * UI or the export. Never read by any scoring or gating path.
   */
  private lastRawConfidence: number | null = null;
  private lastFeatureCorrelationCheck: number = 0;
  private featureCorrelationStatus: string = 'HEALTHY';
  private modelHealthScore: number = 100;
  private lastDriftCheck: number = 0;
  private featureDistributionHistory: Map<string, number[]> = new Map();
  private featureImportanceHistory: Map<string, number[]> = new Map();
  private conceptDriftScore: number = 0;
  private driftAlertLevel: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' = 'NONE';
  /**
   * ITEM DB — per-feature contributions from the LAST COMPLETED live drift
   * cycle (detectConceptDrift). Diagnostic only: the diagnostics export reads
   * it for SECTION 3's LIVE WINDOW DRIFT block; NO gating path reads it. Each
   * cycle REPLACES the snapshot (never merged), so the export can never mix
   * features from two different cycles.
   */
  private liveFeatureDrift: {
    feature: string;
    recentMean: number;
    historicalMean: number;
    recentStd: number;
    historicalStd: number;
    meanShift: number;
    stdShift: number;
    drift: number;
    /** ITEM DE — set when the feature is excluded from the gating average. */
    skipped?: boolean;
    skipReason?: string;
  }[] = [];
  private retrainScheduled: boolean = false;
  /** ITEM 230(G5) — provenance of the CURRENT schedule, recorded purely for DISPLAY
   *  (screen banner + export Section 3). No trigger logic reads these. */
  private retrainScheduledAtMs: number | null = null;
  private retrainScheduledReason: string | null = null;
  private dailyOHLCHistory: DailyOHLC[] = [];
  private currentDayOHLC: { open: number; high: number; low: number; close: number; date: string } | null = null;
  private lastNYCloseCheck: number = 0;
  private orderBlocks: OrderBlock[] = [];
  /** ITEM 116(c) — live count of emissions rejected by the bar-based OB filter. */
  private obFilterRejectionCount: number = 0;
  /** ITEM 116(c) — live count of times the OB filter was evaluated (rejections + passes + abstains). */
  private obFilterEvaluationCount: number = 0;
  /** ITEM 131(b) — live count of times the maxSLPips ceiling truncated the stop below the 1.2 x ATR noise floor. */
  private slCeilingBindCount: number = 0;
  /** ITEM 131(b) — live count of times the SL ceiling was evaluated. */
  private slCeilingEvaluationCount: number = 0;
  /** ITEM 131(b) — the most recent ceiling bind, so the condition is identifiable rather than inferred. */
  private lastSLCeilingBind: { atr: number; atrFloorSlPips: number; maxSLPips: number; at: number } | null = null;
  private fiveMinCandles: { timestamp: number; open: number; high: number; low: number; close: number }[] = [];
  private lastFiveMinCandleClose: number = 0;

  // ITEM 3: M5 bar cache from Supabase gold_m1_bars for bar-based directional
  // features. M1/tick data may ONLY refine entry timing — it must be
  // structurally incapable of contributing to directional score.
  private m5SupabaseBars: { timestamp: number; open: number; high: number; low: number; close: number }[] = [];
  private lastM5BarRefreshAt: number = 0;
  private static readonly M5_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
  private static readonly M5_LOOKBACK_BARS = 200; // ~16h of M5 bars, enough for all bar-based features

  // ITEM DC — per-reason M5 feed failure diagnostics for BOTH gold_m1_bars fetch
  // paths (see M5FeedDiagnostics above for the reason taxonomy). DIAGNOSTIC ONLY:
  // nothing in gating reads this; the counters surface in SECTION 8 via
  // getM5FeedDiagnostics(). In-process counters — not persisted (a restart
  // restarts the instrumentation, stated honestly in the SECTION 8 label).
  private m5FeedDiagnostics: M5FeedDiagnostics = {
    item3: { counters: { fetch_error: 0, zero_rows: 0, all_stale: 0, interval_guard: 0 }, lastReason: null, lastReasonAt: null, lastDetail: null },
    f1: { counters: { fetch_error: 0, zero_rows: 0, all_stale: 0, interval_guard: 0 }, lastReason: null, lastReasonAt: null, lastDetail: null },
  };

  // ── ITEM F: sealed bar series for the RE-SOURCED DIRECTIONAL LAYER ────────
  //
  // F0 MEASUREMENT POSITION (also recorded in services/barIndicators.ts):
  // the tick stream is NOT STORED, so a historical tick-vs-bar A/B at signal
  // level is IMPOSSIBLE — not underpowered, impossible. Everything below is a
  // DESIGN decision on first-principles grounds (an indicator whose "period" is
  // denominated in tick observations has no fixed time base and is therefore
  // not the indicator it claims to be), validated on FORWARD data only. It may
  // never be cited as a measured performance improvement.
  //
  // F1 LOOKBACKS (each sized for the longest indicator it must serve):
  //   M1  — 240 bars (4h).   Entry-timing refinement only. NEVER directional.
  //   M5  — 300 bars (25h).  Serves EMA-50 (250min), MACD-26+9 (175min),
  //                          RSI-14 (70min), ADX-14 double-smoothed (needs
  //                          2*14+1 bars), Bollinger-20, regime (60 bars).
  //   M15 — 200 bars (50h).  Mid-timeframe confluence / HTF corroboration.
  //
  // F1 STALENESS: if the newest bar is older than the timeframe's max age the
  // series is treated as ABSENT, not served stale. Directional features then
  // return null and the engine stands aside rather than scoring on stale
  // structure. There is no GC=F / TwelveData substitution path — the only
  // producer of a BarSeries is sealBarSeries(), called once, below, on data
  // read DIRECTLY from Supabase gold_m1_bars via the anon key.
  private barSeriesM1: BarSeries | null = null;
  private barSeriesM5: BarSeries | null = null;
  private barSeriesM15: BarSeries | null = null;
  private barSeriesBuiltAt: number = 0;
  /** ITEM EA — timestamp of the last closed M5 bar runShadowStrategyScan evaluated (double-scan guard). */
  private lastShadowScanBarTs: number = 0;
  /** ITEM EA — scans that passed the guard (acceptance: invocation count + one log line per scan). */
  private shadowScanCount: number = 0;
  private static readonly BAR_M1_LOOKBACK = 240;
  private static readonly BAR_M5_LOOKBACK = 300;
  private static readonly BAR_M15_LOOKBACK = 200;
  /**
   * WEEKEND COLD START: the M1 fetch window must span the Fri-close → Sun-reopen
   * gap. A 50h window anchored to `now` reaches only the Friday TAIL at reopen,
   * so the aggregated M5 series sits below the 60-bar floor of
   * getDirectionalM5() for hours and the engine stands aside blind. 72h reaches
   * back into the previous session's full Friday tape at the earliest reopen
   * (Sun 22:00 UTC → Thu 22:00), so the series is built ACROSS the gap from
   * pre-close bars. Row cap: 72h of M1 bars = 4320 rows ≤ MAX_PAGES × PAGE_SIZE.
   */
  private static readonly BAR_SERIES_LOOKBACK_MIN = 72 * 60;
  /** A timeframe's newest bar may be at most 3 of its own periods old. */
  private static readonly BAR_MAX_AGE_M1_MS = 3 * 60 * 1000;
  private static readonly BAR_MAX_AGE_M5_MS = 15 * 60 * 1000;
  private static readonly BAR_MAX_AGE_M15_MS = 45 * 60 * 1000;
  /**
   * ITEM 17b/17c counters. A guard that silently emits nothing would reduce
   * measured signal volume with NO denominator, which is exactly how
   * "NOT INSTRUMENTED" gets misread as "zero". Both a numerator and a
   * denominator are therefore recorded for each gate.
   */
  private entryAnchorChecks: number = 0;
  private entryAnchorStaleRejections: number = 0;
  private geometrySanityChecks: number = 0;
  private geometryUnwinnableRejections: number = 0;
  /** ITEM 96 — path-to-target veto counters. */
  private pathToTargetChecks: number = 0;
  private pathToTargetVetoes: number = 0;
  /** ITEM 97/105 — dedup guard counters. */
  private dedupChecks: number = 0;
  private dedupBlocks: number = 0;
  /** ITEM 105 — cluster-scoped dedup: tracks active signals per direction.
   * A same-direction signal is suppressed while an ACTIVE signal exists in
   * the same zone cluster, regardless of elapsed time. */
  private activeSignalsByDirection: Map<SignalType, Array<{ price: number; atr: number; timestamp: number; signalId: string }>> = new Map();
  /** ITEM 192 — no-structure route counters (zero-opposing maps). */
  private noStructureRoutes: number = 0;
  private noStructureVetoes: number = 0;
  /** ITEM 104 — await-the-zone telemetry. */
  private awaitZoneArmed: number = 0;
  private awaitZoneConverted: number = 0;
  private awaitZoneExpired: number = 0;
  private awaitZoneInvalidated: number = 0;
  /** PHASE C / C2 — behind-entry arming telemetry (flag OFF until n>=30, EV CI excludes zero). */
  private behindEntryArmed: number = 0;
  /** ITEM 167(d): ring buffer of recent stand-aside REASONS (persisted with the counters). */
  private standAsideReasons: Array<{ ts: number; reason: string; m5Bars: number; newestM5AgeMin: number | null }> = [];
  /** ITEM 167(c): hourly counter snapshots → computable 24h rate (the lifetime counter hid degradation). */
  private standAsideSnapshots: Array<{ ts: number; checks: number; standAsides: number }> = [];
  private standAsideSnapshotAt: number = 0;
  /** ITEM 104 — pending entries armed by await-the-zone.
   * One per direction per zone cluster. */
  private pendingZoneEntries: Map<string, { direction: SignalType; zonePrice: number; zoneClusterId: string; armedAt: number; expiresAt: number; signalParams: Record<string, unknown> }> = new Map();
  /** ITEM 107 — session-liquidity telemetry: minutes-to-next-session-open per signal. */
  private sessionTelemetry: Array<{ signalId: string; minutesToOpen: number; session: string }> = [];
  /** ITEM 95(c) — RSI modulation agreement tracker.
   * Tracks whether the RSI learned modulation contribution AGREED or DISAGREED
   * with the canonical outcome. A signal where RSI modulation pushed BUY and the
   * outcome was a WIN = agreed; pushed BUY and outcome was LOSS = disagreed.
   * n=4 so far: 4/4 disagreed. WATCH ITEM — do NOT change any weight on it. */
  private rsiModAgreed: number = 0;
  private rsiModDisagreed: number = 0;
  /** The RSI modulation direction for the current signal, set at scoring time
   * and read at outcome time. */
  private lastRsiModDirection: 'BUY' | 'SELL' | 'NEUTRAL' = 'NEUTRAL';
  /** ITEM 97(c)/105 — last emitted signal per direction for dedup. */
  private lastEmittedSignal: { direction: SignalType; price: number; atr: number; timestamp: number } | null = null;
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
  /**
   * B2(c): true when the most recent detectSRZones() pass had to score off
   * TIER_1_LOCAL micro-zones because TIER_0 was empty/stale/unreachable/too weak.
   * Consumed by the emission path to suppress or penalise signals that lean on
   * ~100 minutes of in-memory micro-structure.
   */
  private tier0DegradedThisPass: boolean = false;
  /** Signals suppressed because a TIER_1-only zone was the dominant feature. */
  private tier1DominantSuppressions: number = 0;
  /** Signals emitted with the reduced-confidence TIER_0-degraded penalty applied. */
  private tier0DegradedPenaltyApplications: number = 0;
  /** Confidence multiplier when TIER_0 is degraded but a TIER_1 zone is NOT dominant. */
  private static readonly TIER0_DEGRADED_CONFIDENCE_MULTIPLIER = 0.85;

  /** B2(c) counters, surfaced in the diagnostics export. */
  public getTier0DegradationStats(): { tier1DominantSuppressions: number; tier0DegradedPenaltyApplications: number; tier0DegradedNow: boolean } {
    return {
      tier1DominantSuppressions: this.tier1DominantSuppressions,
      tier0DegradedPenaltyApplications: this.tier0DegradedPenaltyApplications,
      tier0DegradedNow: this.tier0DegradedThisPass,
    };
  }

  /**
   * B2(c) POLICY. When TIER_0 zones are unavailable the engine scores off
   * TIER_1_LOCAL micro-zones built from ~100 minutes of in-memory M1 samples.
   * On 31 July that input supplied the top-scoring feature (SR ZONE STRONG
   * REVERSAL, 28-37 pts) in all four losing BUYs, so continuing to trade at
   * full confidence off it is itself the defect.
   *
   * Chosen behaviour, graded by how much the signal actually leans on the
   * degraded input rather than a blanket stand-aside:
   *   - dominant (top-ranked) feature is an S/R-zone feature AND the zones are
   *     TIER_1-only  -> SUPPRESS. The signal's main reason to exist is
   *     un-evidenced ~100-minute micro-structure.
   *   - otherwise -> confidence penalty, because the zone input still feeds
   *     gating and geometry but is not the primary driver.
   *
   * A blanket stand-aside was rejected: TIER_0 depends on a refresh WRITE that
   * needs the 503-prone backend, so a blanket rule would zero out all volume for
   * an infrastructure reason rather than a market one. A flat penalty alone was
   * also rejected: an 88-95% confidence signal penalised to ~75-81% still clears
   * every emission gate, so it would NOT have blocked any of the four 31 July
   * losses - which is the whole point of this control.
   */
  private evaluateTier0Degradation(
    topFeatureName: string | null,
    zones: SRZone[],
  ): { suppress: boolean; confidenceMultiplier: number; reason: string | null } {
    if (!this.tier0DegradedThisPass) {
      return { suppress: false, confidenceMultiplier: 1, reason: null };
    }

    const zonesAreTier1Only = zones.length > 0 && zones.every((z) => z.tier !== 'TIER_0_SERVER');
    const topIsZoneFeature = topFeatureName !== null && /ZONE/i.test(topFeatureName);

    if (zonesAreTier1Only && topIsZoneFeature) {
      this.tier1DominantSuppressions += 1;
      const reason = `TIER1_DOMINANT_ZONE_SUPPRESSION topFeature=${topFeatureName} zones=${zones.length} allTier1=true`;
      console.warn(`[SRZoneTier0] SIGNAL_SUPPRESSED ${reason}`);
      return { suppress: true, confidenceMultiplier: 1, reason };
    }

    this.tier0DegradedPenaltyApplications += 1;
    const reason = `TIER0_DEGRADED_CONFIDENCE_PENALTY multiplier=${SignalGenerationEngine.TIER0_DEGRADED_CONFIDENCE_MULTIPLIER} topFeature=${topFeatureName ?? 'n/a'}`;
    console.warn(`[SRZoneTier0] ${reason}`);
    return {
      suppress: false,
      confidenceMultiplier: SignalGenerationEngine.TIER0_DEGRADED_CONFIDENCE_MULTIPLIER,
      reason,
    };
  }
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

    // PHASE C / C1 (ITEM 214): aggregate this app-feed tick into a durable M1 bar
    // (app_m1_bars). Write-only instrument for the cross-venue basis fix — O(1)
    // per tick, one fire-and-forget upsert per completed minute, never read on
    // the signal path. Zero scoring change.
    recordAppFeedTick(price, now);

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

  // ITEM 2c: dedicated Supabase client for the daily OHLC refresh.
  // Reads gold_m1_bars DIRECTLY — no fetchHistoricalData, no stale-bar guard,
  // no GC=F/TwelveData fallback. For building historical daily candles,
  // staleness is irrelevant (we want ALL available bars, not just "current").
  // The stale-bar guard in fetchHistoricalData returns empty on weekends
  // (market closed), which would fall through to GC=F/TwelveData — a
  // DATA-SOURCE RULE violation for the daily series.
  private dailyOhlcSupabaseClient: SupabaseClient | null | undefined;

  private getDailyOhlcSupabaseClient(): SupabaseClient | null {
    if (this.dailyOhlcSupabaseClient !== undefined) return this.dailyOhlcSupabaseClient;
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      this.dailyOhlcSupabaseClient = null;
      return null;
    }
    this.dailyOhlcSupabaseClient = createSupabaseClient(url, anonKey, {
      // OO.2 — distinct storageKey: ends the shared-key "Multiple GoTrueClient
      // instances" warning; each client owns its own storage namespace/lock name.
      auth: { autoRefreshToken: false, persistSession: false, storageKey: "rork-svc-signal-engine-daily-ohlc" },
    });
    return this.dailyOhlcSupabaseClient;
  }

  private shadowStrategiesClient: SupabaseClient | null | undefined;

  /**
   * Dedicated anon client for the shadow strategy books, same OO.2 pattern as
   * getDailyOhlcSupabaseClient / counterTrendShadow.getClient: distinct
   * storageKey so this client never contends on a shared GoTrue lock name.
   */
  private getShadowStrategiesClient(): SupabaseClient | null {
    if (this.shadowStrategiesClient !== undefined) return this.shadowStrategiesClient;
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      this.shadowStrategiesClient = null;
      return null;
    }
    this.shadowStrategiesClient = createSupabaseClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false, storageKey: "rork-svc-shadow-strategies" },
    });
    return this.shadowStrategiesClient;
  }

  // ITEM 2c: fetch M1 bars directly from Supabase for daily OHLC aggregation.
  // No stale-bar guard (historical daily candles don't need "current" bars).
  // No GC=F/TwelveData fallback (DATA-SOURCE RULE: different venue).
  // Paginated (PostgREST caps at 1000 rows per response).
  private async fetchM1BarsForDailyOhlc(fromTime: number, toTime: number): Promise<
    { timestamp: number; open: number; high: number; low: number; close: number }[]
  > {
    const client = this.getDailyOhlcSupabaseClient();
    if (!client) return [];

    const fromIso = new Date(fromTime).toISOString();
    const toIso = new Date(toTime).toISOString();
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 50; // 50k bars = ~35 days, matching the widened lookback
    const out: { timestamp: number; open: number; high: number; low: number; close: number }[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const startIdx = page * PAGE_SIZE;
      const endIdx = startIdx + PAGE_SIZE - 1;
      const { data, error } = await client
        .from('gold_m1_bars')
        .select('timestamp, open, high, low, close')
        .gte('timestamp', fromIso)
        .lte('timestamp', toIso)
        .order('timestamp', { ascending: true })
        .range(startIdx, endIdx);
      if (error) {
        console.warn(`⚠️ [DailyOHLC-Supabase] Query failed (page ${page}): ${error.message}`);
        return [];
      }
      if (!data || data.length === 0) break;
      for (const row of data) {
        out.push({
          timestamp: new Date(row.timestamp).getTime(),
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
        });
      }
      if (data.length < PAGE_SIZE) break;
    }
    console.log(`✅ [DailyOHLC-Supabase] Loaded ${out.length} bars directly from gold_m1_bars (no GC=F fallback)`);
    return out;
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
    console.log('📊 Refreshing daily OHLC cache from Supabase gold_m1_bars (direct, no GC=F fallback)...');

    try {
      // ITEM 2c: read DIRECTLY from Supabase gold_m1_bars, NOT via
      // fetchHistoricalData. fetchHistoricalData has a stale-bar guard that
      // returns empty on weekends (market closed) and falls through to
      // GC=F/TwelveData — a different venue, which violates the DATA-SOURCE
      // RULE for the daily series. For historical daily candle aggregation,
      // staleness is irrelevant; we want all available bars.
      const minuteBars = await this.fetchM1BarsForDailyOhlc(
        now - DAILY_OHLC_REFRESH_LOOKBACK_MS,
        now,
      );

      if (minuteBars.length === 0) {
        console.warn('⚠️ Daily OHLC refresh: Supabase returned no bars — standing aside (no GC=F fallback)');
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

  // ── ITEM 3: M5 bar-based directional features ─────────────────────────────
  //
  // STRUCTURAL ENFORCEMENT: these methods read ONLY from Supabase gold_m1_bars
  // (via M5 aggregation). They do NOT read priceHistory, highHistory, lowHistory,
  // or any tick-level array. Tick-based methods (detectPriceActionPattern,
  // calculateVWAP, calculateTrendStrength, calculateADX) remain for ENTRY TIMING
  // and non-directional purposes only — they are NOT called from the directional
  // scoring path below.
  //
  // DATA-SOURCE RULE: reads gold_m1_bars DIRECTLY from Supabase via anon key.
  // No Rork backend, no GC=F/TwelveData, no priceHistory ticks.

  private m5SupabaseClient: SupabaseClient | null | undefined;

  private getM5SupabaseClient(): SupabaseClient | null {
    if (this.m5SupabaseClient !== undefined) return this.m5SupabaseClient;
    const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      this.m5SupabaseClient = null;
      return null;
    }
    this.m5SupabaseClient = createSupabaseClient(url, anonKey, {
      // OO.2 — distinct storageKey (see daily-ohlc comment above).
      auth: { autoRefreshToken: false, persistSession: false, storageKey: "rork-svc-signal-engine-m5" },
    });
    return this.m5SupabaseClient;
  }

  /** ITEM DC — record one M5 feed failure against one path (diagnostic only). */
  private recordM5FeedFailure(path: keyof M5FeedDiagnostics, reason: M5FeedFailureReason, detail: string): void {
    const d = this.m5FeedDiagnostics[path];
    d.counters[reason] += 1;
    d.lastReason = reason;
    d.lastReasonAt = Date.now();
    d.lastDetail = detail;
  }

  /** ITEM DC — read-only SECTION 8 surface. Diagnostic only; nothing gates on it. */
  public getM5FeedDiagnostics(): M5FeedDiagnostics {
    return this.m5FeedDiagnostics;
  }

  /**
   * ITEM DC — the shared gold_m1_bars paginated fetch, now with 3 attempts and
   * 1s/3s/9s backoff between attempts. Used by BOTH fetch paths (the ITEM 3
   * refresh and the F1 bar series). Retries TRANSPORT failures only (query
   * error or throw); a successful fetch returning zero rows is a data
   * condition and is returned as-is for the caller to classify. The callers
   * already treat the refresh as best-effort — the backoff only extends one
   * refresh call (worst case +13s after three consecutive failures).
   */
  private async fetchGoldM1Rows(
    client: SupabaseClient,
    fromIso: string,
    toIso: string,
    maxPages: number,
    logTag: string,
  ): Promise<{ rows: { timestamp: string; open: number; high: number; low: number; close: number }[]; attempts: number; lastError: string | null }> {
    const PAGE_SIZE = 1000;
    const BACKOFFS_MS = [1_000, 3_000, 9_000]; // ITEM DC: 1s / 3s / 9s
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      lastError = null;
      const rows: { timestamp: string; open: number; high: number; low: number; close: number }[] = [];
      try {
        for (let page = 0; page < maxPages; page++) {
          const { data, error } = await client
            .from('gold_m1_bars')
            .select('timestamp, open, high, low, close')
            .gte('timestamp', fromIso)
            .lte('timestamp', toIso)
            .order('timestamp', { ascending: true })
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
          if (error) {
            lastError = `page ${page}: ${error.message}`;
            break;
          }
          if (!data || data.length === 0) break;
          rows.push(...(data as typeof rows));
          if (data.length < PAGE_SIZE) break;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : 'unknown';
      }
      if (lastError === null) {
        if (attempt > 1) console.log(`✅ [${logTag}] fetch attempt ${attempt}/3 succeeded after backoff (${rows.length} M1 rows)`);
        return { rows, attempts: attempt, lastError: null };
      }
      console.warn(`⚠️ [${logTag}] fetch attempt ${attempt}/3 failed: ${lastError}`);
      if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, BACKOFFS_MS[attempt - 1]));
    }
    return { rows: [], attempts: 3, lastError };
  }

  /** Fetch recent M1 bars from Supabase and aggregate into M5 bars. */
  private async refreshM5SupabaseBars(): Promise<void> {
    const now = Date.now();
    if (now - this.lastM5BarRefreshAt < SignalGenerationEngine.M5_REFRESH_INTERVAL_MS) {
      // ITEM DC (d): a guard skip is only a FEED FAILURE while this path's series
      // is still empty — a skip over a live series is the normal steady state.
      if (this.m5SupabaseBars.length === 0) {
        this.recordM5FeedFailure('item3', 'interval_guard', `refresh skipped with ${Math.ceil((SignalGenerationEngine.M5_REFRESH_INTERVAL_MS - (now - this.lastM5BarRefreshAt)) / 1000)}s left on the 5-min guard, series empty`);
      }
      return;
    }
    this.lastM5BarRefreshAt = now;

    const client = this.getM5SupabaseClient();
    if (!client) {
      this.recordM5FeedFailure('item3', 'fetch_error', 'no Supabase client (EXPO_PUBLIC_SUPABASE_URL / ANON_KEY missing)');
      return;
    }

    // Fetch enough M1 bars for M5_LOOKBACK_BARS M5 candles + buffer
    const lookbackMs = (SignalGenerationEngine.M5_LOOKBACK_BARS * 5 + 100) * 60 * 1000;
    const fromIso = new Date(now - lookbackMs).toISOString();
    const toIso = new Date(now).toISOString();

    try {
      // ITEM DC — the paginated fetch now goes through fetchGoldM1Rows (3
      // attempts, 1s/3s/9s backoff on transport failures; zero rows is NOT
      // retried). ~12k M1 bars = ~8h, enough for 200 M5 bars.
      const { rows: allM1, lastError } = await this.fetchGoldM1Rows(client, fromIso, toIso, 12, 'M5-Supabase');
      if (lastError !== null) {
        this.recordM5FeedFailure('item3', 'fetch_error', `all 3 fetch attempts failed (1s/3s/9s backoff) — last: ${lastError}`);
        return;
      }

      if (allM1.length === 0) {
        console.warn('⚠️ [M5-Supabase] No bars returned — standing aside (no GC=F fallback)');
        // ITEM DC (b): transport was healthy — the table itself returned nothing.
        this.recordM5FeedFailure('item3', 'zero_rows', `0 rows from gold_m1_bars in [${fromIso}, ${toIso}] — not retried (data condition, not transport)`);
        return;
      }

      // Aggregate M1 → M5
      const fiveMinMs = 5 * 60 * 1000;
      const grouped = new Map<number, { timestamp: number; open: number; high: number; low: number; close: number }>();
      for (const bar of allM1) {
        const ts = new Date(bar.timestamp).getTime();
        const bucket = Math.floor(ts / fiveMinMs) * fiveMinMs;
        const existing = grouped.get(bucket);
        if (!existing) {
          grouped.set(bucket, { timestamp: bucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        } else {
          existing.high = Math.max(existing.high, bar.high);
          existing.low = Math.min(existing.low, bar.low);
          existing.close = bar.close;
        }
      }
      this.m5SupabaseBars = [...grouped.values()]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-SignalGenerationEngine.M5_LOOKBACK_BARS);

      // ITEM DC (c): rows came back but the newest M5 bar is older than
      // BAR_MAX_AGE_M5_MS — the freshness gate downstream will stand aside.
      // Recorded only; the series is still assigned and NO threshold changed.
      const newestM5AgeMs = now - this.m5SupabaseBars[this.m5SupabaseBars.length - 1].timestamp;
      if (newestM5AgeMs > SignalGenerationEngine.BAR_MAX_AGE_M5_MS) {
        this.recordM5FeedFailure('item3', 'all_stale', `newest M5 bar ${(newestM5AgeMs / 60000).toFixed(1)}min old (> ${(SignalGenerationEngine.BAR_MAX_AGE_M5_MS / 60000).toFixed(0)}min BAR_MAX_AGE_M5_MS)`);
      }

      console.log(`✅ [M5-Supabase] ${this.m5SupabaseBars.length} M5 bars from gold_m1_bars (no GC=F fallback)`);
    } catch (err) {
      console.warn(`⚠️ [M5-Supabase] Error: ${err instanceof Error ? err.message : 'unknown'}`);
      this.recordM5FeedFailure('item3', 'fetch_error', `aggregation threw: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  /** Get M5 bars up to a given time (completed bars only). */
  private getM5BarsUpTo(sigTime: number): { timestamp: number; open: number; high: number; low: number; close: number }[] {
    return this.m5SupabaseBars.filter(b => b.timestamp < sigTime);
  }

  // ═══ ITEM F1 — THE BAR SERIES ════════════════════════════════════════
  //
  // Reads gold_m1_bars DIRECTLY from Supabase via the anon key + RLS and
  // aggregates M1 → M5 → M15 locally. There is NO Rork backend call, NO
  // fetchHistoricalData(), NO GC=F, NO TwelveData, and NO priceHistory tick on
  // this path. Confirm structurally with:
  //     grep -n "sealBarSeries(" services/
  // — it must appear ONLY in this method. sealBarSeries is the sole producer of
  // the branded BarSeries type that every indicator in barIndicators.ts demands,
  // so no other series can physically reach the directional layer.

  /**
   * Rebuild the M1/M5/M15 sealed series from Supabase gold_m1_bars.
   * Throttled to the M5 refresh interval; shares the paginated fetch with the
   * legacy M5 cache so this adds no extra round trips.
   */
  private async refreshBarSeries(force: boolean = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.barSeriesBuiltAt < SignalGenerationEngine.M5_REFRESH_INTERVAL_MS) {
      // ITEM DC (d): same rule as the ITEM 3 path — only a failure while the
      // readiness series is absent. THIS is the series recordStandAsideReason
      // reports as "M5 series ABSENT (m5Bars=0)".
      if (!this.barSeriesM5 || this.barSeriesM5.length === 0) {
        this.recordM5FeedFailure('f1', 'interval_guard', `refresh skipped with ${Math.ceil((SignalGenerationEngine.M5_REFRESH_INTERVAL_MS - (now - this.barSeriesBuiltAt)) / 1000)}s left on the 5-min guard, barSeriesM5 absent`);
      }
      return;
    }

    const client = this.getM5SupabaseClient();
    if (!client) {
      console.warn('⚠️ [BarSeries] No Supabase client — directional layer will stand aside');
      this.recordM5FeedFailure('f1', 'fetch_error', 'no Supabase client (EXPO_PUBLIC_SUPABASE_URL / ANON_KEY missing) — series nulled, directional layer stands aside');
      this.barSeriesM1 = null;
      this.barSeriesM5 = null;
      this.barSeriesM15 = null;
      return;
    }
    this.barSeriesBuiltAt = now;

    // WEEKEND COLD START: see BAR_SERIES_LOOKBACK_MIN. 72h spans the
    // Fri-close → Sun-reopen gap so the M5/M15 series is built ACROSS the gap
    // from the previous session's bars instead of requiring 60 post-reopen bars.
    const lookbackMs = SignalGenerationEngine.BAR_SERIES_LOOKBACK_MIN * 60 * 1000;
    const fromIso = new Date(now - lookbackMs).toISOString();
    const toIso = new Date(now).toISOString();

    try {
      // ITEM DC — the paginated fetch now goes through fetchGoldM1Rows (3
      // attempts, 1s/3s/9s backoff on transport failures; zero rows is NOT
      // retried). 72h of M1 bars = ~4320 rows; 5 pages keeps headroom.
      const { rows, lastError } = await this.fetchGoldM1Rows(client, fromIso, toIso, 5, 'BarSeries');
      if (lastError !== null) {
        console.warn(`⚠️ [BarSeries] all 3 fetch attempts failed (1s/3s/9s) — last: ${lastError} — standing aside`);
        this.recordM5FeedFailure('f1', 'fetch_error', `all 3 fetch attempts failed (1s/3s/9s backoff) — last: ${lastError}`);
        return;
      }

      if (rows.length === 0) {
        console.warn('⚠️ [BarSeries] gold_m1_bars returned 0 rows — directional layer stands aside (NO GC=F fallback)');
        // ITEM DC (b): transport healthy, table empty — the series is nulled and
        // the next readiness check reports "M5 series ABSENT (m5Bars=0)".
        this.recordM5FeedFailure('f1', 'zero_rows', `0 rows from gold_m1_bars in [${fromIso}, ${toIso}] — series nulled, not retried (data condition, not transport)`);
        this.barSeriesM1 = null;
        this.barSeriesM5 = null;
        this.barSeriesM15 = null;
        return;
      }

      const m1: Bar[] = rows.map(r => ({
        timestamp: new Date(r.timestamp).getTime(),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
      }));

      this.applyM1RowsToBarSeries(m1);

      const newest = m1[m1.length - 1].timestamp;
      const ageMin = (now - newest) / 60000;
      // ITEM DC (c): rows returned but ALL older than BAR_MAX_AGE_M5_MS — the
      // freshness gate in getDirectionalM5 will stand aside. Recorded only.
      if (now - newest > SignalGenerationEngine.BAR_MAX_AGE_M5_MS) {
        this.recordM5FeedFailure('f1', 'all_stale', `newest bar ${ageMin.toFixed(1)}min old (> ${(SignalGenerationEngine.BAR_MAX_AGE_M5_MS / 60000).toFixed(0)}min BAR_MAX_AGE_M5_MS)`);
      }
      const counts = `M1 ${this.barSeriesM1?.length ?? 0} / M5 ${this.barSeriesM5?.length ?? 0} / M15 ${this.barSeriesM15?.length ?? 0}`;
      console.log(
        `✅ [BarSeries] ${rows.length} M1 rows → ${counts}` +
        ` — newest bar ${new Date(newest).toISOString()} (${ageMin.toFixed(1)}min old)`,
      );
    } catch (err) {
      console.warn(`⚠️ [BarSeries] Error: ${err instanceof Error ? err.message : 'unknown'} — standing aside`);
      this.recordM5FeedFailure('f1', 'fetch_error', `aggregation threw: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  /**
   * The SOLE place a BarSeries is constructed. Keeping all three seals inside
   * one private method is what makes the `grep -n "sealBarSeries("` audit
   * meaningful: the provenance of every bar the directional layer can ever see
   * is decided here and nowhere else.
   */
  private applyM1RowsToBarSeries(m1: readonly Bar[]): void {
    this.barSeriesM1 = sealBarSeries(m1.slice(-SignalGenerationEngine.BAR_M1_LOOKBACK));
    this.barSeriesM5 = sealBarSeries(aggregateBars(m1, 5).slice(-SignalGenerationEngine.BAR_M5_LOOKBACK));
    this.barSeriesM15 = sealBarSeries(aggregateBars(m1, 15).slice(-SignalGenerationEngine.BAR_M15_LOOKBACK));
  }

  /**
   * TEST/SIMULATION SEAM — NOT A PRODUCTION PATH.
   *
   * The deterministic sandboxes (`test_sell_suppression.ts`,
   * `runSignalSimulation.ts`) synthesise their own M1 bars and run on a
   * simulated or real-but-closed-market clock, so the live Supabase read would
   * legitimately return stale bars and the F1 stand-aside gate would (correctly)
   * reject every attempt. This seam lets a harness supply the M1 series it is
   * already simulating.
   *
   * It is deliberately verbose and greppable. It is never called from any
   * production code path — verify with:
   *     grep -rn "__injectBarSeriesForTestOnly" services/ contexts/ app/
   * (must return only this definition).
   */
  __injectBarSeriesForTestOnly(m1: readonly Bar[]): void {
    this.applyM1RowsToBarSeries(m1);
    this.barSeriesBuiltAt = Date.now();
  }

  /**
   * The M5 series, or null when it is missing / too short / STALE.
   * F1: stale structure is never served — the caller stands aside instead.
   */
  private getDirectionalM5(): BarSeries | null {
    const s = this.barSeriesM5;
    if (!s || s.length < 60) return null;
    if (!isBarSeriesFresh(s, Date.now(), SignalGenerationEngine.BAR_MAX_AGE_M5_MS)) {
      console.warn('⚠️ [BarSeries] M5 series is STALE — directional features stand aside (not served stale)');
      return null;
    }
    return s;
  }

  /** The M15 series, or null when missing / too short / stale. */
  private getDirectionalM15(): BarSeries | null {
    const s = this.barSeriesM15;
    if (!s || s.length < 40) return null;
    if (!isBarSeriesFresh(s, Date.now(), SignalGenerationEngine.BAR_MAX_AGE_M15_MS)) return null;
    return s;
  }

  /**
   * Is the directional layer able to produce a verdict RIGHT NOW?
   *
   * Derived from the series itself rather than cached in a flag set during
   * feature build. A cached flag would go stale the moment anything re-ordered
   * the call sequence, and would report "ready" for a series that had since
   * aged out. This asks the source every time.
   */
  private isDirectionalLayerReady(): boolean {
    const m5 = this.getDirectionalM5();
    const ready = m5 !== null && barRSI(m5, 14) !== null;
    this.directionalStandAsideChecks += 1;
    if (!ready) {
      this.directionalStandAsideCount += 1;
      this.recordStandAsideReason();
    }
    // ITEM 167(c): hourly counter snapshots so a RECENT (24h) rate is
    // computable. The durable lifetime counter averaged a degrading layer
    // into a cumulative number; a snapshot per hour makes the last-day rate a
    // difference of two integers instead of an investigation.
    const nowMs = Date.now();
    if (nowMs - this.standAsideSnapshotAt > 3_600_000) {
      this.standAsideSnapshotAt = nowMs;
      this.standAsideSnapshots.push({
        ts: nowMs,
        checks: this.directionalStandAsideChecks,
        standAsides: this.directionalStandAsideCount,
      });
      if (this.standAsideSnapshots.length > 48) this.standAsideSnapshots.shift();
    }
    this.persistDirectionalLayerCounters();
    return ready;
  }

  /**
   * ITEM 167(d) — record WHY the layer stood aside: bar count, newest bar age
   * and the failing threshold, with a timestamp. A gate that silently
   * suppressed 100% of emission for a day left no reason anywhere; this ring
   * buffer (last 50, persisted with the counters) makes a stalled bar feed one
   * query away instead of one investigation away.
   */
  private recordStandAsideReason(): void {
    const series = this.barSeriesM5;
    const newestAgeMin =
      series && series.length > 0 ? (Date.now() - series[series.length - 1].timestamp) / 60_000 : null;
    const stalenessThresholdMin = SignalGenerationEngine.BAR_MAX_AGE_M5_MS / 60_000;
    const reason =
      !series || series.length === 0
        ? 'M5 series ABSENT — gold_m1_bars not ingested (sync stalled or cold start)'
        : series.length < 60
          ? `M5 series TOO SHORT: ${series.length} bars (< 60 required)`
          : newestAgeMin !== null && newestAgeMin > stalenessThresholdMin
            ? `M5 series STALE: newest bar ${newestAgeMin.toFixed(1)} min old (> ${stalenessThresholdMin.toFixed(0)} min threshold) — bar sync stalled`
            : 'RSI(14) not computable on M5 series';
    this.standAsideReasons.push({
      ts: Date.now(),
      reason,
      m5Bars: series ? series.length : 0,
      newestM5AgeMin: newestAgeMin !== null ? Number(newestAgeMin.toFixed(1)) : null,
    });
    if (this.standAsideReasons.length > 50) this.standAsideReasons.shift();
  }

  /**
   * ITEM 4: hydrate the SECTION 8 counters from AsyncStorage so they survive an
   * app reload. Idempotent; a corrupt or absent record leaves them at whatever
   * the current process has already counted (never resets a live count down).
   */
  public async loadDirectionalLayerCounters(): Promise<void> {
    if (this.directionalCountersHydrated) return;
    this.directionalCountersHydrated = true;
    try {
      const raw = await AsyncStorage.getItem(DIRECTIONAL_LAYER_COUNTERS_KEY);
      if (!raw) {
        console.log('ℹ️ [DirectionalCounters] no persisted counters yet — starting from 0');
        return;
      }
      const parsed = JSON.parse(raw) as { checks?: unknown; standAsides?: unknown; recent?: unknown; snapshots?: unknown };
      const checks = typeof parsed.checks === 'number' && Number.isFinite(parsed.checks) ? parsed.checks : 0;
      const standAsides = typeof parsed.standAsides === 'number' && Number.isFinite(parsed.standAsides) ? parsed.standAsides : 0;
      this.directionalStandAsideChecks = Math.max(this.directionalStandAsideChecks, Math.floor(checks));
      this.directionalStandAsideCount = Math.max(this.directionalStandAsideCount, Math.floor(standAsides));
      if (Array.isArray(parsed.recent) && this.standAsideReasons.length === 0) {
        this.standAsideReasons = parsed.recent.filter(
          (r): r is { ts: number; reason: string; m5Bars: number; newestM5AgeMin: number | null } =>
            typeof r === 'object' && r !== null && typeof (r as { ts?: unknown }).ts === 'number' && typeof (r as { reason?: unknown }).reason === 'string',
        );
      }
      if (Array.isArray(parsed.snapshots) && this.standAsideSnapshots.length === 0) {
        this.standAsideSnapshots = parsed.snapshots.filter(
          (s): s is { ts: number; checks: number; standAsides: number } =>
            typeof s === 'object' && s !== null && typeof (s as { ts?: unknown }).ts === 'number',
        );
        const lastSnapshot = this.standAsideSnapshots[this.standAsideSnapshots.length - 1];
        if (lastSnapshot) this.standAsideSnapshotAt = lastSnapshot.ts;
      }
      console.log(`✓ [DirectionalCounters] restored checks=${this.directionalStandAsideChecks} standAsides=${this.directionalStandAsideCount}`);
    } catch (error: unknown) {
      console.warn('⚠️ [DirectionalCounters] load failed (non-blocking):', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * ITEM 4: throttled fire-and-forget flush. Readiness is checked on every
   * generation attempt, so an unthrottled write would hammer AsyncStorage; a
   * 15s floor keeps at most one write per 15s while never losing more than that
   * much of a count on a hard reload.
   */
  private persistDirectionalLayerCounters(): void {
    const now = Date.now();
    if (now - this.directionalCountersFlushedAt < 15_000) return;
    this.directionalCountersFlushedAt = now;
    const payload = JSON.stringify({
      checks: this.directionalStandAsideChecks,
      standAsides: this.directionalStandAsideCount,
      // ITEM 167(d): stand-aside REASONS + hourly snapshots ride the same
      // throttled flush — one AsyncStorage key, no extra write pressure.
      recent: this.standAsideReasons.slice(-10),
      snapshots: this.standAsideSnapshots,
      updatedAt: now,
    });
    AsyncStorage.setItem(DIRECTIONAL_LAYER_COUNTERS_KEY, payload).catch((error: unknown) => {
      console.warn('⚠️ [DirectionalCounters] persist failed (non-blocking):', error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * F6 criterion 4: how often the bar-based directional layer was unavailable
   * or stale at generation time. Read-only accessor for the diagnostics export.
   */
  /**
   * ITEM 74(a) — RUNTIME probe of Item 64's consumed-weight set. Returns the
   * ACTUAL contents of `CONSUMED_MODEL_WEIGHTS` as the running bundle holds it,
   * so the diagnostics export can report observed presence rather than trusting
   * a changelog. A pre-Item-64 bundle does not export this method at all.
   */
  public getConsumedModelWeightKeys(): string[] {
    return Array.from(CONSUMED_MODEL_WEIGHTS);
  }

  public getDirectionalLayerStats(): {
    checks: number;
    standAsides: number;
    readyNow: boolean;
    /** ITEM DC — per-reason M5 feed failure diagnostics (diagnostic only). */
    m5FeedDiagnostics: M5FeedDiagnostics;
  } {
    const m5 = this.getDirectionalM5();
    return {
      checks: this.directionalStandAsideChecks,
      standAsides: this.directionalStandAsideCount,
      readyNow: m5 !== null && barRSI(m5, 14) !== null,
      m5FeedDiagnostics: this.getM5FeedDiagnostics(),
    };
  }

  /**
   * ITEM 167(c)/(d) — stand-aside observability for the diagnostics export.
   * rate24h is the RECENT-window rate computed from hourly snapshots; it is
   * null until 24h of snapshots have accumulated (snapshots began at Item
   * 167(d)). recent[] carries the last stand-aside REASONS.
   */
  public getStandAsideTelemetry(): {
    checks: number;
    standAsides: number;
    lifetimeRate: number;
    checks24h: number | null;
    standAsides24h: number | null;
    rate24h: number | null;
    recent: Array<{ ts: number; reason: string; m5Bars: number; newestM5AgeMin: number | null }>;
  } {
    const dayAgo = Date.now() - 24 * 3_600_000;
    let base: { ts: number; checks: number; standAsides: number } | null = null;
    for (const s of this.standAsideSnapshots) {
      if (s.ts <= dayAgo) base = s;
    }
    const checks24h = base !== null ? this.directionalStandAsideChecks - base.checks : null;
    const standAsides24h = base !== null ? this.directionalStandAsideCount - base.standAsides : null;
    return {
      checks: this.directionalStandAsideChecks,
      standAsides: this.directionalStandAsideCount,
      lifetimeRate:
        this.directionalStandAsideChecks > 0 ? this.directionalStandAsideCount / this.directionalStandAsideChecks : 0,
      checks24h,
      standAsides24h,
      rate24h: checks24h !== null && checks24h > 0 && standAsides24h !== null ? standAsides24h / checks24h : null,
      recent: this.standAsideReasons.slice(-10),
    };
  }

  /**
   * ITEM 168(b) — runtime configuration probe. Answers "which bundle is
   * running" from the RUNNING code: the recent gate constants and modes, the
   * await-the-zone counters, and the current zone-map age. Read by the
   * diagnostics export next to the build marker.
   */
  public getRuntimeConfigProbe(): Record<string, string | number | boolean | null> {
    return {
      OB_FILTER_ENABLED,
      OB_FILTER_MODE,
      OB_ABSENT_CONFIDENCE_PENALTY,
      ENTRY_QUALITY_TRIGGER_ENABLED,
      MODULATION_ENABLED,
      PATH_TO_TARGET_VETO_ENABLED,
      DEDUP_TIME_WINDOW_MS,
      awaitZoneArmed: this.awaitZoneArmed,
      awaitZoneConverted: this.awaitZoneConverted,
      awaitZoneExpired: this.awaitZoneExpired,
      awaitZoneInvalidated: this.awaitZoneInvalidated,
      noStructureRoutes: this.noStructureRoutes,
      noStructureVetoes: this.noStructureVetoes,
      rejectionDirectedZonesEnabled: REJECTION_DIRECTED_ZONES_ENABLED,
      noStructureVetoEnabled: NO_STRUCTURE_VETO_ENABLED,
      zoneMapAgeMinutes:
        this.tier0SRZonesFetchedAt > 0 ? Math.round((Date.now() - this.tier0SRZonesFetchedAt) / 60_000) : null,
    };
  }

  /**
   * F4: the M1 series exists ONLY for entry-timing refinement. It is deliberately
   * NOT exposed to any directional call site — see the audit in the F4 section of
   * the report. Kept as a method so the intent is greppable.
   */
  private getEntryTimingM1(): BarSeries | null {
    const s = this.barSeriesM1;
    if (!s || s.length < 30) return null;
    if (!isBarSeriesFresh(s, Date.now(), SignalGenerationEngine.BAR_MAX_AGE_M1_MS)) return null;
    return s;
  }

  /** Bar-based detectPriceActionPattern: uses last 5 M5 bars instead of 5 ticks. */
  private detectPriceActionPatternBarBased(m5Bars: { open: number; high: number; low: number; close: number }[]): string {
    if (m5Bars.length < 5) return 'INSUFFICIENT_DATA';
    const recent = m5Bars.slice(-5);
    const trend = recent[4].close - recent[0].open;
    const volatility = Math.max(...recent.map(b => b.high)) - Math.min(...recent.map(b => b.low));
    if (trend > 10 && volatility < 20) return 'STRONG_UPTREND';
    if (trend < -10 && volatility < 20) return 'STRONG_DOWNTREND';
    if (Math.abs(trend) < 5 && volatility < 10) return 'CONSOLIDATION';
    if (volatility > 25) return 'HIGH_VOLATILITY_BREAKOUT';
    if (recent[4].close > recent[3].close && recent[3].close < recent[2].close) return 'BULLISH_REVERSAL';
    if (recent[4].close < recent[3].close && recent[3].close > recent[2].close) return 'BEARISH_REVERSAL';
    return 'NEUTRAL';
  }

  /** Bar-based calculateVWAP: uses last 30 M5 bars instead of 30 ticks. */
  private calculateVWAPBarBased(m5Bars: { high: number; low: number; close: number }[]): number | null {
    if (m5Bars.length < 10) return null;
    const n = Math.min(30, m5Bars.length);
    const bars = m5Bars.slice(-n);
    let numerator = 0;
    let denominator = 0;
    for (const bar of bars) {
      const typical = (bar.high + bar.low + bar.close) / 3;
      const pseudoVolume = Math.max(0.1, Math.abs(bar.high - bar.low));
      numerator += typical * pseudoVolume;
      denominator += pseudoVolume;
    }
    if (denominator === 0) return null;
    return parseFloat((numerator / denominator).toFixed(2));
  }

  /** Bar-based calculateTrendStrength: uses last 20 M5 bar closes instead of 20 ticks. */
  private calculateTrendStrengthBarBased(m5Bars: { close: number }[]): number {
    if (m5Bars.length < 20) return 0.5;
    const closes = m5Bars.slice(-20).map(b => b.close);
    const first = closes[0];
    const last = closes[closes.length - 1];
    const netMove = Math.abs(last - first);
    let totalMove = 0;
    for (let i = 1; i < closes.length; i++) {
      totalMove += Math.abs(closes[i] - closes[i - 1]);
    }
    if (totalMove === 0) return 0;
    return Math.min(1.0, netMove / totalMove);
  }

  /** Bar-based detectMarketRegime: uses M5 bars for ATR + trend strength. */
  private detectMarketRegimeBarBased(m5Bars: { high: number; low: number; close: number }[]): { type: string; strength: number } {
    if (m5Bars.length < 20) return { type: 'RANGING', strength: 0.5 };
    const recent14 = m5Bars.slice(-14);
    let atrSum = 0;
    for (let i = 1; i < recent14.length; i++) {
      const tr = Math.max(
        recent14[i].high - recent14[i].low,
        Math.abs(recent14[i].high - recent14[i - 1].close),
        Math.abs(recent14[i].low - recent14[i - 1].close),
      );
      atrSum += tr;
    }
    const atr = atrSum / Math.max(1, recent14.length - 1);

    const recent10 = m5Bars.slice(-10);
    const older10 = m5Bars.slice(-20, -10);
    let recentActivity = 0;
    for (let i = 1; i < recent10.length; i++) recentActivity += Math.abs(recent10[i].close - recent10[i - 1].close);
    let olderActivity = 0;
    for (let i = 1; i < older10.length; i++) olderActivity += Math.abs(older10[i].close - older10[i - 1].close);
    const volumeRatio = olderActivity === 0 ? 1.0 : recentActivity / olderActivity;

    const trendStrength = this.calculateTrendStrengthBarBased(m5Bars);

    let type: string;
    let strength: number;
    if (atr > 11 && volumeRatio > 1.1) {
      type = 'VOLATILE';
      strength = 0.8 + Math.min(atr - 11, 3) * 0.05;
    } else if (atr < 8.5 && volumeRatio < 0.9) {
      type = 'QUIET';
      strength = 0.6 + (8.5 - atr) * 0.05;
    } else if (trendStrength > 0.6) {
      type = 'TRENDING';
      strength = 0.7 + trendStrength * 0.2;
    } else {
      type = 'RANGING';
      strength = 0.5 + (1 - trendStrength) * 0.3;
    }
    return { type, strength: Math.min(1.0, Math.max(0.3, strength)) };
  }

  /** Bar-based calculateADX: uses M5 bar OHLC instead of tick arrays. */
  private calculateADXBarBased(m5Bars: { high: number; low: number; close: number }[], period: number = 14): number | null {
    if (m5Bars.length < period + 1) return null;
    const highs = m5Bars.slice(-(period + 1)).map(b => b.high);
    const lows = m5Bars.slice(-(period + 1)).map(b => b.low);
    const closes = m5Bars.slice(-(period + 1)).map(b => b.close);
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
    return parseFloat((100 * Math.abs(plusDI - minusDI) / diSum).toFixed(1));
  }

  getCurrentPrice(): number {
    return this.currentPrice;
  }
  
  getPriceSource(): string {
    return lastPriceSource;
  }

  /**
   * ITEM 17b/17c telemetry. Numerator AND denominator for both new gates, so a
   * volume drop can be attributed instead of guessed. `null` is never returned
   * as 0 — a zero check count means the gate has not run, not that it passed.
   */
  getEntryAnchorGateStats(): {
    anchorChecks: number;
    anchorStaleRejections: number;
    geometryChecks: number;
    geometryUnwinnableRejections: number;
    anchorAgeMsNow: number | null;
    lastRealPriceSource: string;
  } {
    return {
      anchorChecks: this.entryAnchorChecks,
      anchorStaleRejections: this.entryAnchorStaleRejections,
      geometryChecks: this.geometrySanityChecks,
      geometryUnwinnableRejections: this.geometryUnwinnableRejections,
      anchorAgeMsNow: lastRealPriceObservedAt > 0 ? Date.now() - lastRealPriceObservedAt : null,
      lastRealPriceSource,
    };
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

  /**
   * ITEM 116 — build a BAR series for marketStructure.ts from the engine's
   * bar-aligned arrays.
   *
   * DATA SOURCE: highHistory / lowHistory / barCloseHistory. These are BAR
   * arrays (1-min OHLC), set in lockstep by fetchAndUpdateOHLCHistory(). They are
   * NOT this.priceHistory (the Capital.com/Swissquote TICK stream), which the
   * DATA-SOURCE RULE forbids from gating emission.
   *
   * `open` is approximated by the previous bar's close, which is standard for a
   * continuous series and is NOT used by detectSwings/detectOrderBlocks
   * mitigation logic (those read high/low/close only). Timestamps are synthesized
   * as minute-spaced from now, which preserves ORDER — the only property the
   * structure/mitigation logic depends on.
   */
  private buildStructureBars(): { timestamp: number; open: number; high: number; low: number; close: number }[] {
    const n = Math.min(this.highHistory.length, this.lowHistory.length, this.barCloseHistory.length);
    if (n === 0) return [];
    const highs = this.highHistory.slice(-n);
    const lows = this.lowHistory.slice(-n);
    const closes = this.barCloseHistory.slice(-n);
    const now = Date.now();
    const bars: { timestamp: number; open: number; high: number; low: number; close: number }[] = [];
    for (let i = 0; i < n; i++) {
      const high = highs[i];
      const low = lows[i];
      const close = closes[i];
      if (high === undefined || low === undefined || close === undefined) continue;
      const prevClose = i > 0 ? closes[i - 1] : close;
      bars.push({
        timestamp: now - (n - 1 - i) * 60000,
        open: prevClose ?? close,
        high,
        low,
        close,
      });
    }
    return bars;
  }

  /**
   * ITEM 116 — the OB filter's actual predicate, on the MEASURED construct.
   *
   * FUNCTION: marketStructure.computeMarketStructure() + findNearbyUnmitigatedOBs()
   * DATA SOURCE: BAR arrays via buildStructureBars() — with mitigation tracking,
   * no 4h cutoff, no top-10-by-strength truncation.
   *
   * This is the same function and construct Item 108's authorising measurement
   * used. The prior implementation used this.detectOrderBlocks()/priceHistory
   * (ticks, 4h, top-10, no mitigation) — a different construct.
   *
   * ABSTAINS (returns hasOB=true) when there are too few bars to compute
   * structure. A filter must never reject for lack of input data.
   */
  private hasNearbyUnmitigatedOB(atr: number): {
    hasOB: boolean;
    abstained: boolean;
    barCount: number;
    totalOBs: number;
    unmitigatedOBs: number;
    nearbyOBs: number;
    threshold: number;
  } {
    this.obFilterEvaluationCount += 1;
    const bars = this.buildStructureBars();
    const safeAtr = Math.max(atr, 0.01);
    const threshold = safeAtr * OB_PROXIMITY_ATR;
    if (bars.length < OB_FILTER_MIN_BARS) {
      return { hasOB: true, abstained: true, barCount: bars.length, totalOBs: 0, unmitigatedOBs: 0, nearbyOBs: 0, threshold };
    }
    const structure = computeMarketStructure(bars);
    const unmitigated = structure.orderBlocks.filter(ob => !ob.mitigated);
    const nearby = findNearbyUnmitigatedOBs(structure, this.currentPrice, safeAtr, OB_PROXIMITY_ATR);
    return {
      hasOB: nearby.length > 0,
      abstained: false,
      barCount: bars.length,
      totalOBs: structure.orderBlocks.length,
      unmitigatedOBs: unmitigated.length,
      nearbyOBs: nearby.length,
      threshold,
    };
  }

  /** ITEM 116(c) — live OB filter counters for emission-rate reporting. */
  public getOBFilterStats(): { rejections: number; evaluations: number; rejectionRate: number } {
    const evaluations = this.obFilterEvaluationCount;
    return {
      rejections: this.obFilterRejectionCount,
      evaluations,
      rejectionRate: evaluations > 0 ? this.obFilterRejectionCount / evaluations : 0,
    };
  }

  /**
   * ITEM 131(b) — SL CEILING TELEMETRY.
   *
   * The user's requirement is that the system can IDENTIFY when the ceiling binds,
   * not that it drops trades at it. Before Item 131 a binding ceiling produced a
   * silent `return null`; it now clamps and increments these counters.
   *
   * Counters are IN-MEMORY and reset when the engine is re-created, so they
   * describe the current session only.
   */
  public getSLCeilingStats(): {
    binds: number;
    evaluations: number;
    bindRate: number;
    lastBind: { atr: number; atrFloorSlPips: number; maxSLPips: number; at: number } | null;
  } {
    const evaluations = this.slCeilingEvaluationCount;
    return {
      binds: this.slCeilingBindCount,
      evaluations,
      bindRate: evaluations > 0 ? this.slCeilingBindCount / evaluations : 0,
      lastBind: this.lastSLCeilingBind,
    };
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
    
    // ITEM 63(c): ATR-relative strength decay distance. The previous
    // max(atr*5, price*0.015) produced ~$66 at gold $4,414 — 213x wider than
    // zoneWidth's ~$0.31 (atr*0.3). The price*0.015 term always dominated,
    // making the ATR term dead code. At that width, the threshold for
    // strength > 0.8 (distance < 0.2 * decay = ~$13.2) was so wide that 88.1%
    // of 20-bar windows had BOTH support and resistance > 0.8 simultaneously.
    //
    // Coefficient derivation (measured against 9,980 M1 bar windows from
    // gold_m1_bars, 2026-08-03 to 2026-08-12):
    //   ATR p50 = $1.70, current ATR = $1.04, current price = $4,414.21
    //   atr*2 at p50 = $3.40, price*0.0001 = $0.44 → ATR term governs at p50
    //   atr*2 at p10 ATR ($1.04) = $2.08, still > $0.44 → ATR governs broadly
    //   Dual-fire rate with atr*2: 0.0% (down from 88.1%)
    //   Single-fire rate with atr*2: 25.5% (up from 11.9%) — correctly resolves
    //   to one side instead of crediting both.
    //
    // The 51x gap rationale: strengthDecayDistance measures "how close is price
    // to the 20-bar high/low extreme" — a STRUCTURAL PROXIMITY concept that
    // operates on a longer horizon than zoneWidth's "are two zones the same
    // level" merge distance. A 2x ATR coefficient (~$3.40) means strength > 0.8
    // when price is within $0.68 of the 20-bar extreme — tight enough to be
    // meaningful, loose enough to fire when price genuinely approaches a range
    // boundary. zoneWidth's 0.3x ATR (~$0.31) is a MERGE distance between
    // detected zones, not a proximity-to-extreme distance. They serve different
    // purposes and need not match; the 10x ratio (2.0 vs 0.3) is the calibrated
    // gap between a merge distance and a proximity distance.
    const atr = this.calculateRealATR(14);
    const STRENGTH_DECAY_ATR_COEFF = 2.0;
    const strengthDecayDistance = Math.max(atr * STRENGTH_DECAY_ATR_COEFF, currentPrice * ZONE_WIDTH_FLOOR_PCT);
    
    const resistanceStrength = Math.max(0, Math.min(1, 1 - (distanceToResistance / strengthDecayDistance)));
    const supportStrength = Math.max(0, Math.min(1, 1 - (distanceToSupport / strengthDecayDistance)));
    
    return {
      supportStrength: parseFloat(supportStrength.toFixed(2)),
      resistanceStrength: parseFloat(resistanceStrength.toFixed(2)),
    };
  }

  /**
   * TIER 0 S/R zone refresh.
   *
   * B2(a) REPOINT: the READ now goes DIRECTLY to Supabase `sr_zones_v1` via the
   * anon key (srZoneTier0Service), NOT through the Rork backend tRPC route. On
   * 31 July the backend 503'd on both configured base URLs and the engine fell
   * back to TIER_1_LOCAL micro-zones silently; `sr_zones_v1` has anon SELECT
   * enabled, so the backend never needed to be in this read path.
   *
   * The backend is retained ONLY for the refresh/compute WRITE below, which
   * genuinely requires the service-role key.
   *
   * DATA-SOURCE RULE: this read has NO fallback to GC=F / TwelveData / any
   * other venue. If Supabase is unavailable, tier0SRZones stays null and the
   * caller applies the B2(c) stand-aside/penalty policy - it never substitutes
   * a different instrument's zones.
   *
   * Throttled to TIER0_SRZONES_FETCH_INTERVAL_MS and fully fire-and-forget --
   * never awaited by detectSRZones(), so generation stays synchronous.
   */
  private maybeRefreshTier0SRZones(): void {
    const now = Date.now();
    if (now - this.lastTier0SRZonesFetchAttemptAt < SignalGenerationEngine.TIER0_SRZONES_FETCH_INTERVAL_MS) {
      return;
    }
    this.lastTier0SRZonesFetchAttemptAt = now;

    // B2(a): direct Supabase anon read. No backend, no tRPC, no other venue.
    void fetchTier0SRZones()
      .then((result) => {
        if (result.ok && result.zones.length > 0) {
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
            // ITEM 191 / PHASE A-A3: legacy spot-relative type from the server's
            // computeZones; the directed counts now arrive from the SERVER too
            // (24h bar window — a DIFFERENT instrument than the client's
            // ~100-sample window; applyRejectionDirectedTyping() overwrites them
            // with the client-window counts, which remain the shipped labels).
            legacyType: z.legacyType ?? z.type,
            rejectionsFromBelow: z.rejectionsFromBelow ?? 0,
            rejectionsFromAbove: z.rejectionsFromAbove ?? 0,
            // ITEM 212: TIER_0 may not have computed these yet; fall back to the
            // zone price so downstream geometry is always defined.
            strengthPrice: z.strengthPrice ?? z.price,
            entryEdgePrice: z.entryEdgePrice ?? z.price,
          }));
          this.tier0SRZonesFetchedAt = Date.now();
          console.log(`✅ SR-ZONES: TIER 0 loaded DIRECT from Supabase (${this.tier0SRZones.length} usable zone(s), ${result.weakZoneCount} below the ${0.3} consumer threshold)`);
        } else {
          // Do NOT keep serving a previously-cached zone set once the live read
          // says the cache is unusable - that is precisely the silent-staleness
          // failure mode B2(c) exists to eliminate.
          this.tier0SRZones = null;
          console.warn(`[SRZoneTier0] TIER0_FALLBACK_TO_TIER1 reason=${result.reason ?? 'UNKNOWN'} detail=${result.detail ?? 'n/a'}`);
        }
      })
      .catch((err: unknown) => {
        this.tier0SRZones = null;
        console.warn(`[SRZoneTier0] TIER0_FALLBACK_TO_TIER1 reason=UNEXPECTED detail=${err instanceof Error ? err.message : String(err)}`);
      });

    // The compute/refresh WRITE legitimately needs the service-role key, so it
    // stays on the backend. It is fire-and-forget and NOT on the read path -
    // if the backend is 503, TIER 0 reads above still work off the last
    // successfully written cache.
    const srZonesClient = (trpcClient as { srZones?: { refreshZones?: { mutate?: unknown } } })?.srZones;
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

  /**
   * ITEM 191(c) — REJECTION-DIRECTED TYPING POST-PASS.
   *
   * For EVERY zone in the final map (TIER_0 and TIER_1 alike), count how many
   * approaches came from BELOW and were rejected back down (true resistance
   * behaviour) versus from ABOVE and rejected back up (true support behaviour),
   * over the same in-memory price/high/low history the touch and wick counting
   * already uses. ALWAYS records the counts plus legacyType on the zone (so
   * every sr_zones_snapshot accumulates forward evidence); re-types the zone
   * by dominant rejection direction ONLY when REJECTION_DIRECTED_ZONES_ENABLED
   * is on (tie -> legacy spot-relative type).
   *
   * LABEL (rule 5): the shipped counts are computed over the engine's
   * in-memory window (~100 M1 samples); the 191(e) measurement used 24h of
   * gold_m1_bars. Both count approach->reject events with the same wick test;
   * the windows differ and the snapshot stores the counts so the shipped
   * construct is auditable per-signal.
   *
   * Did NOT change: reactionStrength, touches, rejectionWicks, cluster
   * merging (still on legacy typing), or anything downstream of zone.type
   * while the flag is off. Returns CLONES — this.tier0SRZones cache entries
   * are never mutated.
   */
  private applyRejectionDirectedTyping(zones: SRZone[]): SRZone[] {
    const atr = this.calculateRealATR(14);
    return zones.map(zone => {
      const legacyType = zone.legacyType ?? zone.type;
      const band = Math.max(atr * 0.3, zone.price * ZONE_WIDTH_FLOOR_PCT);
      if (this.priceHistory.length < 20 || this.highHistory.length < 20 || this.lowHistory.length < 20) {
        return { ...zone, legacyType, rejectionsFromBelow: 0, rejectionsFromAbove: 0 };
      }
      let below = 0;
      let above = 0;
      for (let i = 0; i < this.priceHistory.length; i++) {
        const price = this.priceHistory[i];
        const high = this.highHistory[i] ?? price;
        const low = this.lowHistory[i] ?? price;
        // Approach from below probed into the band and was pushed back below
        // the level: RESISTANCE behaviour (mirrors the :4321 wick test,
        // direction-agnostic — the legacy test only counts this when the zone
        // already sits above spot, which is exactly the discarded evidence).
        if (high >= zone.price - band && price < zone.price) {
          const wickSize = high - Math.max(price, this.priceHistory[Math.max(0, i - 1)] ?? price);
          if (wickSize > band * 0.3) below++;
        }
        // Approach from above probed into the band and was pushed back above
        // the level: SUPPORT behaviour (mirrors the :4329 wick test).
        if (low <= zone.price + band && price > zone.price) {
          const wickSize = Math.min(price, this.priceHistory[Math.max(0, i - 1)] ?? price) - low;
          if (wickSize > band * 0.3) above++;
        }
      }
      const directedType: 'SUPPORT' | 'RESISTANCE' = below > above ? 'RESISTANCE' : above > below ? 'SUPPORT' : legacyType;
      return {
        ...zone,
        legacyType,
        rejectionsFromBelow: below,
        rejectionsFromAbove: above,
        type: REJECTION_DIRECTED_ZONES_ENABLED ? directedType : zone.type,
      };
    });
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
      this.tier0DegradedThisPass = false;
      this.srZones = this.applyRejectionDirectedTyping(this.tier0SRZones!.slice(0, 16));
      return this.srZones;
    }

    // B2(c): TIER_0 is unusable, so this pass will score off TIER_1_LOCAL
    // micro-zones derived from ~100 minutes of in-memory M1 samples. That is
    // exactly the input that produced the dominant scoring feature in all four
    // losing BUYs on 31 July. Record the fallback so it is COUNTED and VISIBLE
    // in the diagnostics export, and flag the pass as degraded so the confidence
    // penalty in applyTier0DegradationPenalty() applies downstream.
    this.tier0DegradedThisPass = true;
    recordTier0FallbackUse();

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
    // ITEM 48(b) SCALE FIX. The floor was `currentPrice * 0.0015`, which at gold
    // $4,250 is $6.38 — while the intended governing term `atr * 0.3` is ~$0.65
    // at a typical M1 ATR of ~$2.2. The floor therefore ALWAYS won and the ATR
    // term was dead code: every zone got a fixed +/-$6.38 (128-pip) band no
    // matter what real volatility was doing, which merged genuinely distinct
    // levels into one band. Drop the coefficient 10x so the floor is a true
    // low-volatility safety net (binding only when ATR is below ~$2.1) and the
    // ATR term governs in normal conditions, as originally intended.
    const zoneWidth = Math.max(atr * 0.3, currentPrice * ZONE_WIDTH_FLOOR_PCT);

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
      // (halving every LOCAL_ZONE_STALENESS_HALF_LIFE_HOURS with no fresh touch) so a
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
        ? Math.pow(0.5, ageHours / LOCAL_ZONE_STALENESS_HALF_LIFE_HOURS)
        : 1;
      // ITEM 150 FIX (2026-08-19): zero-touch zones must not score above the
      // 0.3 consumer threshold, regardless of wicks or confluence. A rejection
      // wick without a touch means price spiked into the zone but never actually
      // traded there — that is weaker evidence than a genuine touch. Census of
      // the live map found 3 zero-touch zones scoring RS=1.0 (backend) or ~0.40
      // (local), all above 0.3 and dominating structural gating. The minimum
      // touch count is derived from the distribution: 29/32 zones have touches
      // >= 4; the 3 outliers all have touches=0. Capping at 0.29 (below the 0.3
      // consumer threshold) ensures zero-touch zones are visible in the map but
      // cannot influence scoring, gating, or the path-to-target veto.
      const uncappedRS = Math.min(1, rawReactionStrength * recencyDecayFactor);
      const reactionStrength = touches === 0 ? Math.min(uncappedRS, 0.29) : uncappedRS;

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
          // ITEM 191: legacy spot-relative type; directed counts are filled by
          // applyRejectionDirectedTyping() over the final merged map.
          legacyType: isResistance ? 'RESISTANCE' : 'SUPPORT',
          rejectionsFromBelow: 0,
          rejectionsFromAbove: 0,
          // ITEM 212 — each raw zone seeds its own strength/edge price; merge loop will overwrite these
          // on clusters that contain multiple members, so single-member zones are self-consistent.
          strengthPrice: parseFloat(cluster.price.toFixed(1)),
          entryEdgePrice: parseFloat(cluster.price.toFixed(1)),
        });
      }
    }

    // ITEM 97(b) — ZONE CLUSTERING. Merge same-side zones whose separation is
    // below ZONE_MERGE_THRESHOLD_ATR (1.5, derived from the gap distribution:
    // p25=2.00 ATR, 18.3% of pairs within 1.5 ATR). Merged zones get a combined
    // touch count and the strongest member's reaction strength, preventing the
    // dense-zone layering where 5 overlapping supports in a $13.6 band always
    // produce a "buy at support" signal regardless of where price actually sits.
    const preClusterCount = zones.length;
    const mergeThreshold = Math.max(atr * ZONE_MERGE_THRESHOLD_ATR, currentPrice * ZONE_WIDTH_FLOOR_PCT);
    const merged: SRZone[] = [];
    const bySide: { supports: SRZone[]; resistances: SRZone[] } = {
      supports: zones.filter(z => z.type === 'SUPPORT').sort((a, b) => a.price - b.price),
      resistances: zones.filter(z => z.type === 'RESISTANCE').sort((a, b) => a.price - b.price),
    };
    for (const arr of [bySide.supports, bySide.resistances]) {
      let i = 0;
      while (i < arr.length) {
        let cluster = { ...arr[i] };
        let j = i + 1;
        while (j < arr.length && Math.abs(arr[j].price - cluster.price) < mergeThreshold) {
          // Merge: combine touches, take strongest reaction_strength, average price
          cluster.price = (cluster.price * cluster.touches + arr[j].price * arr[j].touches) / (cluster.touches + arr[j].touches);
          cluster.touches += arr[j].touches;
          cluster.rejectionWicks += arr[j].rejectionWicks;
          // ITEM 212 — keep BOTH the weighted average price and the strongest-member price.
          // strengthPrice = price of the cluster member with the highest reactionStrength.
          if (arr[j].reactionStrength > cluster.reactionStrength) {
            cluster.strengthPrice = arr[j].price;
          }
          cluster.reactionStrength = Math.max(cluster.reactionStrength, arr[j].reactionStrength);
          cluster.confluenceScore = Math.max(cluster.confluenceScore, arr[j].confluenceScore);
          // entryEdgePrice = outermost merged cluster member in the risk direction of the zone type:
          // SUPPORT → risk is below, so lowest price; RESISTANCE → risk is above, so highest price.
          if (cluster.type === 'SUPPORT') {
            cluster.entryEdgePrice = Math.min(cluster.entryEdgePrice, arr[j].price);
          } else {
            cluster.entryEdgePrice = Math.max(cluster.entryEdgePrice, arr[j].price);
          }
          j++;
        }
        cluster.price = parseFloat(cluster.price.toFixed(1));
        cluster.reactionStrength = parseFloat(cluster.reactionStrength.toFixed(3));
        cluster.strengthPrice = parseFloat((cluster.strengthPrice ?? cluster.price).toFixed(1));
        cluster.entryEdgePrice = parseFloat((cluster.entryEdgePrice ?? cluster.price).toFixed(1));
        merged.push(cluster);
        i = j;
      }
    }
    const postClusterCount = merged.length;
    if (preClusterCount !== postClusterCount) {
      console.log(`  [ZoneClustering] merged ${preClusterCount} -> ${postClusterCount} zones (threshold ${mergeThreshold.toFixed(2)} = ${ZONE_MERGE_THRESHOLD_ATR} ATR)`);
    }

    merged.sort((a, b) => b.reactionStrength - a.reactionStrength);
    this.srZones = this.applyRejectionDirectedTyping(merged.slice(0, 16));

    if (this.srZones.length > 0) {
      console.log('\n📊 S/R ZONE DETECTION (post-clustering):');
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

    // ITEM 3: refresh M5 bars from Supabase and compute bar-based directional features.
    // These are the ONLY inputs that may contribute to directional buySignalStrength.
    // Tick-based priceHistory may NOT feed directional score.
    await this.refreshM5SupabaseBars();
    const nowMs = Date.now();
    const m5BarsForFeatures = this.getM5BarsUpTo(nowMs);
    const barBasedPriceActionPattern = this.detectPriceActionPatternBarBased(m5BarsForFeatures);
    const barBasedVwap = this.calculateVWAPBarBased(m5BarsForFeatures);
    const barBasedTrendStrength = this.calculateTrendStrengthBarBased(m5BarsForFeatures);
    const barBasedRegime = this.detectMarketRegimeBarBased(m5BarsForFeatures);
    const barBasedAdx = this.calculateADXBarBased(m5BarsForFeatures, 14);
    console.log(`📊 [ITEM3] Bar-based features: pattern=${barBasedPriceActionPattern} vwap=${barBasedVwap?.toFixed(1) ?? 'null'} trendStr=${(barBasedTrendStrength * 100).toFixed(0)}% regime=${barBasedRegime.type}(${(barBasedRegime.strength * 100).toFixed(0)}%) adx=${barBasedAdx?.toFixed(1) ?? 'null'} [M5 bars: ${m5BarsForFeatures.length}]`);

    // ═══ ITEM F — RE-SOURCED DIRECTIONAL LAYER ══════════════════════════════
    // Every momentum / trend / volatility input below now reads a SEALED M5 bar
    // series built directly from Supabase gold_m1_bars. The tick versions of the
    // same indicators are retained only where they serve entry timing (F4).
    //
    // TIMEFRAME CHOICE FOR RSI(14) — justified, not defaulted:
    // M5. RSI(14) on M5 spans a FIXED 70 minutes. The alternatives were M1
    // (14 minutes — too short to be anything but noise once the tick smoothing
    // is gone, and it would reproduce the defect being fixed at a slightly
    // longer scale) and M15 (3.5 hours — closer to the trade holding horizon but
    // out of step with the rest of the entry layer). M5 is chosen because it is
    // the engine's NATIVE ENTRY TIMEFRAME: the counter-trend confirmation gate
    // requires a completed 5-minute candle (requiresHigherTimeframeConfirmation),
    // the candlestick patterns are read off 5-minute candles, and the S/R zone
    // reactions are evaluated on M5. Putting RSI on M15 while EMA/MACD and the
    // confirmation gate sit on M5 would reintroduce exactly the cross-base
    // incoherence this item exists to remove. One time base for the whole
    // directional layer; M15 is reserved for HTF corroboration only.
    //
    // BEHAVIOURAL NOTE, stated plainly: priceHistory was sampled roughly every
    // 5 seconds, so the old RSI(14) window covered ~75 SECONDS. The bar version
    // covers 70 MINUTES — a ~56x lengthening. Overbought/oversold will fire far
    // less often and mean far more when it does. That is the intended change,
    // and it is the main driver of the emission-volume delta in F5.
    await this.refreshBarSeries();
    // ITEM EA — shadow strategy scan on every closed M5 bar, independent of
    // emission. DISCREPANCY vs the prompt (live code wins): the prompt hooks
    // after refreshM5SupabaseBars, but the detectors consume barSeriesM5 —
    // built by refreshBarSeries, 34 lines later in this same flow — so the
    // hook sits after THAT refresh. The double-scan guard inside dedupes.
    void this.runShadowStrategyScan().catch((err: unknown) => {
      console.warn(`[ShadowScan] FAILED (fire-and-forget, emission unaffected): ${err instanceof Error ? err.message : String(err)}`);
    });
    const dirM5 = this.getDirectionalM5();
    const dirM15 = this.getDirectionalM15();

    const barRsi = dirM5 ? barRSI(dirM5, 14) : null;
    const barMacdHist = dirM5 ? barMACDHistogram(dirM5) : null;
    const barEmaCross = dirM5 ? barEMACrossover(dirM5) : null;
    const barVwapValue = dirM5 ? barVWAP(dirM5, 30) : null;
    const barAdxResult = dirM5 ? barADX(dirM5, 14) : null;
    const barBands = dirM5 ? barBollinger(dirM5, 20, 2) : null;
    const barPattern = dirM5 ? barPriceActionPattern(dirM5, 5) : null;
    const barRegimeResult = dirM5 ? barRegime(dirM5) : null;
    const barTrendStr = dirM5 ? barTrendStrength(dirM5, 20) : null;
    const barM15Rsi = dirM15 ? barRSI(dirM15, 14) : null;

    if (!dirM5) {
      console.warn('⚠️ [ITEM F] M5 bar series unavailable or stale — directional features are NULL; the engine will stand aside rather than score on ticks.');
    } else {
      console.log(
        `📊 [ITEM F] Bar-sourced directional layer (M5 x${dirM5.length}): ` +
        `RSI(14)=${barRsi?.toFixed(1) ?? 'null'} MACD-hist=${barMacdHist?.toFixed(3) ?? 'null'} ` +
        `EMA9/21/50=${barEmaCross?.toFixed(3) ?? 'null'} VWAP=${barVwapValue?.toFixed(2) ?? 'null'} ` +
        `ADX=${barAdxResult?.adx.toFixed(1) ?? 'null'} (+DI ${barAdxResult?.plusDI.toFixed(1) ?? '-'} / -DI ${barAdxResult?.minusDI.toFixed(1) ?? '-'}) ` +
        `BBw=${barBands?.bandwidth.toFixed(3) ?? 'null'} pattern=${barPattern ?? 'null'} ` +
        `regime=${barRegimeResult?.type ?? 'null'}(${barRegimeResult ? (barRegimeResult.strength * 100).toFixed(0) + '%' : '-'}) ` +
        `eff=${barTrendStr?.toFixed(3) ?? 'null'} | M15 RSI=${barM15Rsi?.toFixed(1) ?? 'null'}`,
      );
    }

    // Tick-sourced values are still computed above for telemetry and entry
    // timing; the FEATURE VECTOR now carries the bar-sourced value wherever one
    // is available. When the bar series is unavailable the feature is null/50
    // and the downstream gate stands the engine aside — it never silently falls
    // back to the tick value.
    const rsiFinal = barRsi ?? 50;
    const macdHistogramFinal = barMacdHist ?? 0;
    const emaCrossoverFinal = barEmaCross ?? 0;
    const vwapFinal = barVwapValue;
    const adxFinal = barAdxResult === null ? null : parseFloat(barAdxResult.adx.toFixed(1));
    const bollingerFinal = barBands === null
      ? { squeeze: false, expansion: false, bandwidth: null as number | null }
      : { squeeze: barBands.squeeze, expansion: barBands.expansion, bandwidth: barBands.bandwidth };
    const priceActionPatternFinal = barPattern ?? 'INSUFFICIENT_DATA';
    const marketRegimeFinal: MarketRegime = barRegimeResult === null
      ? marketRegime
      : { ...marketRegime, type: barRegimeResult.type as MarketRegime['type'], strength: barRegimeResult.strength };

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
      rsi: rsiFinal,
      atr,
      dxyChange: intermarketData.dxyChange,
      volumeRatio,
      weeklyPivot: parseFloat(weeklyPivot.toFixed(1)),
      fractalResistance,
      fractalSupport,
      macdHistogram: macdHistogramFinal,
      emaCrossover: emaCrossoverFinal,
      sessionVolatilityIndex,
      timeToSessionEnd,
      fibonacci,
      sentiment,
      orderFlow,
      volumeProfile,
      marketRegime: marketRegimeFinal,
      priceActionPattern: priceActionPatternFinal,
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
      vwap: vwapFinal,
      adx: adxFinal,
      bollingerSqueeze: bollingerFinal.squeeze,
      bollingerExpansion: bollingerFinal.expansion,
      bollingerBandwidth: bollingerFinal.bandwidth,
      barBasedPriceActionPattern,
      barBasedVwap,
      barBasedTrendStrength,
      barBasedRegimeType: barBasedRegime.type,
      barBasedRegimeStrength: barBasedRegime.strength,
      barBasedAdx,
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
  
  /**
   * ITEM 54(a): smoothing is now scoped to the candidate direction, so a BUY
   * candidate can no longer inherit 15% of an unrelated SELL candidate's score.
   * Behaviour for a run of same-direction candidates is unchanged.
   */
  private smoothConfidence(rawConfidence: number, candidateDirection: 'BUY' | 'SELL'): number {
    this.lastRawConfidence = rawConfidence;

    const history = this.confidenceHistoryByDirection[candidateDirection];
    history.push(rawConfidence);
    if (history.length > CONFIDENCE_SMOOTHING_WINDOW) {
      history.shift();
    }

    // Minimal smoothing: blend 85% raw + 15% previous to preserve true signal confidence
    // while avoiding frame-to-frame jitter. Previous aggressive EMA was clustering all
    // signals near the 66% mean regardless of actual setup quality.
    const prev = history.length >= 2
      ? history[history.length - 2]
      : rawConfidence;
    const blended = 0.85 * rawConfidence + 0.15 * prev;
    const finalConfidence = Math.min(blended, MAX_CONFIDENCE_CAP);

    console.log(`🔄 Confidence (light blend, ${candidateDirection}): Raw ${(rawConfidence * 100).toFixed(1)}% -> Final ${(finalConfidence * 100).toFixed(1)}% (prev ${candidateDirection} ${(prev * 100).toFixed(1)}%)`);

    return parseFloat(finalConfidence.toFixed(3));
  }

  /**
   * ITEM 54(b) — RAW (pre-smoothing) confidence of the most recent scoring run.
   * Telemetry/display only. Returns null before the first scored run.
   */
  getLastRawConfidence(): number | null {
    return this.lastRawConfidence;
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
    
    // ITEM DA — resolve one shadow-candidate pass (≤200 rows, oldest first) on
    // the SAME 4h cadence as this drift check. STANDALONE: shadowResolver.ts
    // imports neither signalResolver nor any live resolution path. Fire-and-
    // forget: a resolution failure must never affect emission. The write-back
    // needs migration 024 (anon UPDATE on shadow_candidates_v1.inputs); until
    // it is applied every pass reports RLS no-op errors in its own log line.
    const shadowResolverClient = this.getShadowStrategiesClient();
    if (shadowResolverClient) {
      void resolveShadowRows({ supabaseClient: shadowResolverClient })
        .then((r) => console.log(`[ShadowResolver] pass done: resolved=${r.resolved} stillOpen=${r.stillOpen} errors=${r.errors} skippedPreGeometryV2=${r.skippedPreGeometryV2}${r.lastError ? ` lastError=${r.lastError}` : ""}`))
        .catch((err: unknown) => console.log(`[ShadowResolver] pass failed (fire-and-forget, emission unaffected): ${err instanceof Error ? err.message : String(err)}`));
    }
    
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
    
    // ITEM BE: sentiment_score excluded from the drift average. It reads an
    // external news feed that is non-stationary by nature — its drift was
    // measured at 0.97 (2026-09-07), which poisoned the average and held
    // driftAlertLevel at HIGH indefinitely, raising the confidence floor to
    // 80% and blocking 44% of emission attempts for 3.5 days. The remaining
    // features (rsi, atr, dxyChange, volumeRatio, orderFlow_volumeImbalance)
    // are price-derived and stationary enough for drift detection. Sentiment
    // drift is still tracked by analyzeFeatureValueDrift (diagnostics) but no
    // longer gates emissions.
    // DISCREPANCY vs the ITEM BE prompt (live code wins): the prompt says to
    // remove 'sentiment_score' from featureKeys, but the average below iterates
    // featureDistributionHistory (NOT featureKeys) and that map is persisted
    // across restarts via saveFeatureDriftHistory — removing it from featureKeys
    // would BOTH stop the required tracking push AND leave the already-persisted
    // sentiment history feeding this average forever. So sentiment STAYS in
    // featureKeys (tracking) and is skipped HERE, in the averaging loop.
    // ITEM DB — each completed drift cycle REPLACES the per-feature snapshot.
    this.liveFeatureDrift = [];
    for (const [key, values] of this.featureDistributionHistory.entries()) {
      if (values.length < 30) continue;
      if (key === 'sentiment_score') continue;
      
      const recent = values.slice(-10);
      const historical = values.slice(0, -10);
      
      const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const historicalMean = historical.reduce((a, b) => a + b, 0) / historical.length;
      
      const recentStd = Math.sqrt(recent.reduce((sum, val) => sum + Math.pow(val - recentMean, 2), 0) / recent.length);
      const historicalStd = Math.sqrt(historical.reduce((sum, val) => sum + Math.pow(val - historicalMean, 2), 0) / historical.length);
      
      const meanShift = Math.abs(recentMean - historicalMean) / (historicalStd + 0.01);
      const stdShift = Math.abs(recentStd - historicalStd) / (historicalStd + 0.01);
      
      const drift = (meanShift + stdShift) / 2;
      // ITEM DE: skip features with near-zero historical variance. A feature that
      // barely moves (historicalStd < 0.1) cannot carry meaningful drift information
      // — there is nothing to drift FROM. Without this guard, dxyChange (std ≈ 0.001)
      // and orderFlow_volumeImbalance (std ≈ 0.005-0.02) produce explosive drift
      // scores through the +0.01 denominator, pinning driftAlertLevel at HIGH
      // permanently and blocking ~40% of emission attempts.
      //
      // This is the same class of fix as ITEM BE (sentiment excluded): a feature
      // whose nature makes it permanently non-informative for drift detection is
      // excluded from the gating average. It is still TRACKED in
      // featureDistributionHistory and logged per ITEM DB — just not counted
      // toward totalDrift / driftCount.
      //
      // The 0.1 threshold is generous — features with std > 0.1 include rsi (std ~12),
      // atr (std ~0.5), and volumeRatio (std ~0.15). Features below 0.1 are
      // dxyChange (std ~0.001) and orderFlow_volumeImbalance (std ~0.005-0.02).
      if (historicalStd < 0.1) {
        // ITEM DB — still log the per-feature drift for visibility
        this.liveFeatureDrift.push({ feature: key, recentMean, historicalMean, recentStd, historicalStd, meanShift, stdShift, drift, skipped: true, skipReason: 'historicalStd < 0.1' });
        console.log(`[DRIFT] ${key}: SKIPPED (historicalStd=${historicalStd.toFixed(6)} < 0.1 — near-constant, excluded from gating average)`);
        continue; // do NOT add to totalDrift / driftCount
      }
      // ITEM DB — per-feature contribution, logged and stored so the export
      // can name WHICH feature drives the average. Diagnostic only: nothing
      // below (thresholds, alert level, emission) reads this line's values.
      this.liveFeatureDrift.push({ feature: key, recentMean, historicalMean, recentStd, historicalStd, meanShift, stdShift, drift });
      console.log(`[DRIFT] ${key}: recentMean=${recentMean.toFixed(6)} historicalMean=${historicalMean.toFixed(6)} recentStd=${recentStd.toFixed(6)} historicalStd=${historicalStd.toFixed(6)} meanShift=${meanShift.toFixed(6)} stdShift=${stdShift.toFixed(6)} drift=${drift.toFixed(6)}`);
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
      // ITEM BE: auto-halving of CRITICAL-drift feature weights REMOVED.
      // The halving compounded on every drift-check cycle while driftAlertLevel
      // stayed HIGH, progressively destroying learned weights. The retrain
      // (scheduled for the next low-liquidity window) is the correct response
      // to concept drift. Weight modification between retrains is a compounding
      // error that Item AC's logistic regression replaces entirely.
      
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
      this.retrainScheduledAtMs = Date.now();
      this.retrainScheduledReason = 'Concept drift alert HIGH (drift score reached 0.6)';
      
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
  
  /**
   * ITEM 64(d): renamed from analyzeFeatureImportanceDrift to analyzeFeatureValueDrift.
   *
   * This function does NOT measure feature importance or marginal contribution.
   * It computes the AVERAGE FEATURE VALUE among winning outcomes in a recent
   * window vs an older window, then reports the absolute change as "drift".
   * For RSI, that means: "the average RSI of winning trades was 42.4 recently
   * vs 37.4 historically" — a central-tendency shift, NOT a predictive-power
   * shift. The previous name ("Feature Importance Drift") was a label error
   * that made a central-tendency metric look like a marginal-contribution metric.
   *
   * Renamed rather than replaced with a true marginal-contribution computation
   * (EV present vs absent) because: (1) the existing drift-trigger logic reads
   * this metric's `status` field and changing the computation would alter what
   * fires — a scoring-path change that needs its own gate; (2) the historical
   * drift telemetry in prior exports used this computation, so renaming keeps
   * the time series comparable; (3) the rename itself fixes the label without
   * changing what is measured, which is the minimum honest fix.
   */
  private analyzeFeatureValueDrift(): FeatureDriftMetric[] {
    if (this.tradeOutcomes.length < 20) {
      console.log('⚠️ Feature Importance Drift: Insufficient data (need 20+ outcomes, have ' + this.tradeOutcomes.length + ')');
      return [];
    }
    
    // ITEM 201(b) — DRIFT WINDOWS EXCLUDE PROVENANCE-MARKED RECONSTRUCTION ROWS.
    // Measured 2026-08-21 (expo/scripts/item201b_drift_retrain.ts): with all
    // rows the drift is dominated by reconstruction defaults — sentiment
    // drift 11.875 (0.0000 -> 0.1188), mean 2.5068 — because HALF the older
    // window is backfill rows whose sentiment/volume/dxy/timeWindow are
    // documented DEFAULTS, not measurements. Excluding them: sentiment drift
    // 0.735 (0.0800 -> 0.1462), mean 0.3275. Retraining on the contaminated
    // windows would bake a manufactured drift signal into the weights.
    // Fallback: if fewer than 40 measurable rows exist, use all rows (the
    // pre-fix behaviour) so drift stays computable on a young corpus.
    // Did NOT change: the drift formula, the status thresholds, the retrain
    // trigger conjunction, or the learner itself.
    const measurableOutcomes = this.tradeOutcomes.filter(o => {
      const f = o.features as Partial<SignalLearningContext> | undefined;
      const sent = f?.sentiment as { source?: string } | undefined;
      return sent?.source !== 'resolver-bar-reconstruction'
        && f?.featuresSource !== 'app-bar-reconstruction'
        && (f as Record<string, unknown> | undefined)?.featuresIncomplete !== true;
    });
    const driftSource = measurableOutcomes.length >= 40 ? measurableOutcomes : this.tradeOutcomes;
    const recentOutcomes = driftSource.slice(-20);
    const olderOutcomes = driftSource.slice(-40, -20);
    
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

      // ── ITEM 82 / B4 — F-14 FIX: NaN IS NOT CRITICAL ─────────────────────────
      // ROOT CAUSE, measured before fixing (scripts/auditItem82RoundTwo.ts against
      // the live corpus, 2026-08-17): 287 of 401 trade_outcomes_v1 rows carry a
      // COMPLETELY EMPTY `features` object. Only 114 rows have rsi/atr/volumeRatio/
      // dxyChange at all. `o.features.rsi` on such a row is `undefined`, and
      // `sum + undefined === NaN`, so recentAvg/olderAvg/drift all become NaN.
      //
      // It is NOT division by zero: the denominator is `historicalImportance + 0.01`
      // and is therefore always >= 0.01. Proof from the same audit: `sentiment` is
      // the ONE feature that produced real numbers, and it is the ONE feature read
      // through a nullish guard (`o.features.sentiment?.score ?? 0`, :5058-5059).
      // Same arithmetic, guarded input, finite result.
      //
      // The classification bug: `NaN < 0.3` is false and `NaN < 0.6` is false, so a
      // NaN fell through to the else-branch and was reported CRITICAL. Because
      // Item 64(c) treats ANY CRITICAL feature as a retrain trigger, an empty corpus
      // permanently pinned "Retraining recommended: YES" and the trigger could never
      // discriminate real drift from missing data.
      //
      // A non-finite drift is now INSUFFICIENT_DATA — a corpus-completeness state,
      // never actionable as degradation.
      const driftIsMeasurable = Number.isFinite(drift) && Number.isFinite(currentImportance) && Number.isFinite(historicalImportance);

      let status: 'STABLE' | 'DEGRADING' | 'CRITICAL' | 'INSUFFICIENT_DATA';
      if (!driftIsMeasurable) {
        status = 'INSUFFICIENT_DATA';
      } else if (drift < 0.3) {
        status = 'STABLE';
      } else if (drift < 0.6) {
        status = 'DEGRADING';
      } else {
        status = 'CRITICAL';
      }

      if (status === 'INSUFFICIENT_DATA') {
        const presentRecent = recentWinFeatures.filter(o => Object.keys((o.features ?? {}) as unknown as Record<string, unknown>).length > 0).length;
        console.log(`   ℹ️ ${featureName}: INSUFFICIENT_DATA — drift is not computable (feature absent from the compared rows; ${presentRecent}/${recentWinFeatures.length} recent winners carry any features at all). NOT counted as CRITICAL.`);
        metrics.push({
          feature: featureName,
          currentImportance: 0,
          historicalImportance: 0,
          drift: 0,
          status,
        });
        continue;
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
   * weight that has drifted toward/under zero shrinks or reverses it. (The
   * concept-drift auto-halving that could push weights there was removed by
   * Item BE.)
   */
  private getFeatureModulation(featureKey: string): number {
    // ITEM 111: modulation disabled — learner is at chance (50.0% held-out
    // accuracy, CIs [41%, 59%]). C-2 ten-feature validation found ZERO features
    // with CIs excluding zero. Returning 1.0 makes modulation a no-op until
    // held-out accuracy beats chance with p<0.05 (n>=200, accuracy >= 55%).
    if (!MODULATION_ENABLED) {
      return 1;
    }
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
    /**
     * ITEM 29 (telemetry only): which side of the accumulator each attention
     * entry actually moved, recorded at the call site. Carries string-union
     * values, never numbers, so it cannot enter any strength/confidence sum.
     */
    attentionSides: Map<string, AttentionSide>;
  } {
    const now = new Date();
    const hour = now.getUTCHours();
    
    const isLondonSession = hour >= 6 && hour < 13;
    const isNYSession = hour >= 13 && hour < 21;
    
    const attentionScores = new Map<string, number>();
    // TICK-INPUT REMOVAL (2026-08-02): the directional accumulators are no longer
    // plain locals. Every contribution must go through DirectionalScoreAccumulator,
    // whose signature accepts only keys from the bar-derived allowlist in
    // services/directionalScoring.ts. Re-adding a tick-window contribution is a
    // COMPILE error, not a review miss. See that module's header for the full
    // rationale (design decision on first-principles grounds; the measurement at
    // n=369 was underpowered and could not adjudicate).
    // ITEM 29: the accumulator now also records WHICH SIDE each entry moved into
    // this parallel map. Telemetry only - see attentionTelemetry.ts header.
    const attentionSides = new Map<string, AttentionSide>();
    const dir = new DirectionalScoreAccumulator(attentionScores, attentionSides);
    
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
    //
    // ITEM 140 — THE MODULATION_ENABLED FLAG DOES NOT ZERO THIS PATH.
    // getFeatureModulation() returns 1.0 when MODULATION_ENABLED=false, so the
    // RSI modulation multiplier is 1.0 (identity). But the RSI contributions
    // (rsiBuyContribution, rsiSellContribution) are computed INDEPENDENTLY from
    // HTF/LTF/RSI conditions above — they are NOT gated by MODULATION_ENABLED.
    // The flag only controls the LEARNED WEIGHT multiplier on top of those
    // base contributions. With modulation off, rsiModulation=1.0, so the
    // attention contribution is rsiBuyContribution * 1.0 = the full base value
    // (e.g. 0.35). The attention score IS the base contribution, unchanged.
    //
    // This is CORRECT behaviour: MODULATION_ENABLED was never meant to disable
    // the RSI feature itself, only the learned-weight amplification on top of
    // it. The base RSI contributions are legitimate directional signals. The
    // flag disabled the amplification layer (which was at chance), not the
    // feature. The 35.00 attention score the user saw is rsiBuyContribution * 100
    // = 0.35 * 100 = 35.0, which is the CORRECT unamplified value.
    //
    // ITEM 140 DECISION: leave as-is. The flag does exactly what its name
    // implies — disables the learned modulation multiplier, not the base feature.
    // Zeroing the attention contribution would remove a legitimate directional
    // signal that is NOT at chance (the base RSI conditions are hand-coded
    // rules with domain logic, not learned weights). The learned layer is what
    // was at chance, and it IS disabled.
    const rawRsiModulation = this.getFeatureModulation('rsi_weight');
    const rsiModulation = Math.min(rawRsiModulation, RSI_MODULATION_APPLIED_MAX);
    dir.addBuy('rsi_learned_modulation', rsiBuyContribution * rsiModulation, false);
    dir.addSell('rsi_learned_modulation', rsiSellContribution * rsiModulation, false);
    // ITEM 95(c): track which direction the RSI modulation pushed this signal,
    // so at outcome time we can tally agreement vs disagreement.
    this.lastRsiModDirection = rsiBuyContribution > rsiSellContribution ? 'BUY'
      : rsiSellContribution > rsiBuyContribution ? 'SELL'
      : 'NEUTRAL';
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
    //
    // TICK-INPUT REMOVAL (2026-08-02) — DESIGN DECISION, NOT A MEASUREMENT RESULT.
    // Two contributions were removed from this block:
    //   1. marketRegime TRENDING+strength>0.75 -> strong_uptrend/strong_downtrend
    //      (±0.15). `marketRegime` is produced by detectMarketRegime(), whose
    //      trendStrength is calculateTrendStrength() = a 20-TICK window of
    //      priceHistory, with volumeRatio from a 10-vs-10 TICK comparison.
    //   2. priceActionPattern -> bullish/bearish_reversal (±0.12) and
    //      strong_uptrend_pattern/strong_downtrend_pattern (±0.10).
    //      detectPriceActionPattern() reads priceHistory.slice(-5) — FIVE TICKS.
    // Both remain COMPUTED, ATTACHED and LOGGED (via dir.noteTelemetry) so they
    // stay measurable as the sample grows. The bar-based replacements were NOT
    // wired in: at n=369 they are equally unvalidated, and adding new unvalidated
    // weight is the Item 3 mistake repeated.
    // ITEM F: `features.marketRegime` and `features.priceActionPattern` are now
    // produced by barRegime()/barPriceActionPattern() over the sealed M5 series
    // (see analyzeMarketFeatures). The contributions removed on the tick basis
    // are restored here on the BAR basis, under `bar_`-prefixed allowlist keys.
    let trendBuyContribution = 0;
    let trendSellContribution = 0;
    if (features.marketRegime.type === 'TRENDING' && features.marketRegime.strength > 0.75) {
      if (htfTrend === 'BULLISH' && ltfTrend === 'BULLISH') {
        dir.addBuy('bar_strong_uptrend', 0.15);
        console.log('✅ BUY: Strong Uptrend (M5-bar regime + HTF/LTF alignment)');
      } else if (htfTrend === 'BEARISH' && ltfTrend === 'BEARISH') {
        dir.addSell('bar_strong_downtrend', 0.15);
        console.log('🔴 SELL: Strong Downtrend (M5-bar regime + HTF/LTF alignment)');
      }
    } else if (features.marketRegime.type === 'VOLATILE') {
      attentionScores.set('volatile_regime_context', 0.03);
    }
    if (features.priceActionPattern === 'BULLISH_REVERSAL') {
      trendBuyContribution += 0.12;
      attentionScores.set('bar_bullish_reversal', 0.12);
      console.log('✅ BUY: Bullish Reversal (M5 bars)');
    } else if (features.priceActionPattern === 'BEARISH_REVERSAL') {
      trendSellContribution += 0.12;
      attentionScores.set('bar_bearish_reversal', 0.12);
      console.log('🔴 SELL: Bearish Reversal (M5 bars)');
    } else if (features.priceActionPattern === 'STRONG_UPTREND') {
      trendBuyContribution += 0.10;
      attentionScores.set('bar_strong_uptrend_pattern', 0.10);
      console.log('✅ BUY: Strong Uptrend price action (M5 bars)');
    } else if (features.priceActionPattern === 'STRONG_DOWNTREND') {
      trendSellContribution += 0.10;
      attentionScores.set('bar_strong_downtrend_pattern', 0.10);
      console.log('🔴 SELL: Strong Downtrend price action (M5 bars)');
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
    const CANDLE_STACK_KEYS = [
      'bullish_engulfing', 'bearish_engulfing', 'bullish_pin_bar', 'bearish_pin_bar',
      'bar_bullish_reversal', 'bar_bearish_reversal',
      'bar_strong_uptrend_pattern', 'bar_strong_downtrend_pattern',
    ] as const;
    dir.addCappedBuy(CANDLE_STACK_KEYS, trendBuyContribution);
    dir.addCappedSell(CANDLE_STACK_KEYS, trendSellContribution);
    if (trendBuyContribution > 0 || trendSellContribution > 0) {
      console.log(`📊 Trend Stack (capped ${TREND_STACK_CAP}): BUY+${trendBuyContribution.toFixed(2)} SELL+${trendSellContribution.toFixed(2)}`);
    }
    
    // ITEM 63(a): MUTUAL EXCLUSION at the detector. The previous code had two
    // independent `if` statements — both fired whenever both strengths > 0.8,
    // which happened 88.1% of the time because the old strengthDecayDistance
    // ($66) was so wide that most 20-bar windows satisfied both by construction.
    //
    // Now: with the ATR-relative decay distance (atr*2, ~$3.40), both > 0.8
    // fires 0.0% of the time (measured on 9,980 windows). But the distance-
    // relative margin (option 2 from the approved proposal) is still applied as
    // a guard: if both somehow exceed 0.8, only the side with a material
    // strength advantage fires. The margin (1.15) was derived from the
    // distribution of strength ratios when both > 0.5 — at the 0.0% dual-fire
    // rate with atr*2, this guard is effectively a safety net, not the primary
    // exclusion mechanism. The primary exclusion is the narrower decay distance.
    const SR_STRENGTH_THRESHOLD = 0.8;
    const SR_MUTUAL_EXCLUSION_MARGIN = 1.15;
    const supFires = features.supportStrength > SR_STRENGTH_THRESHOLD;
    const resFires = features.resistanceStrength > SR_STRENGTH_THRESHOLD;
    if (supFires && resFires) {
      // Both above threshold — resolve to the stronger side by margin
      if (features.supportStrength > features.resistanceStrength * SR_MUTUAL_EXCLUSION_MARGIN) {
        dir.addBuy('strong_support_proximity', 0.10);
        console.log(`✅ BUY: Strong Support Proximity (mutual exclusion: support ${features.supportStrength.toFixed(2)} > resistance ${features.resistanceStrength.toFixed(2)} * ${SR_MUTUAL_EXCLUSION_MARGIN})`);
      } else if (features.resistanceStrength > features.supportStrength * SR_MUTUAL_EXCLUSION_MARGIN) {
        dir.addSell('strong_resistance_proximity', 0.10);
        console.log(`🔴 SELL: Strong Resistance Proximity (mutual exclusion: resistance ${features.resistanceStrength.toFixed(2)} > support ${features.supportStrength.toFixed(2)} * ${SR_MUTUAL_EXCLUSION_MARGIN})`);
      } else {
        console.log(`⚖️ S/R proximity NEUTRAL: both strong (${features.supportStrength.toFixed(2)}/${features.resistanceStrength.toFixed(2)}) but no margin winner — firing neither`);
      }
    } else if (supFires) {
      dir.addBuy('strong_support_proximity', 0.10);
      console.log('✅ BUY: Strong Support Proximity');
    } else if (resFires) {
      dir.addSell('strong_resistance_proximity', 0.10);
      console.log('🔴 SELL: Strong Resistance Proximity');
    }

    const srReaction = this.detectActiveSRReaction(features);
    if (srReaction && srReaction.confirmed) {
      features.activeSRReaction = srReaction;
      if (srReaction.zone.type === 'SUPPORT') {
        dir.addBuy(`sr_zone_${srReaction.reactionType.toLowerCase()}`, srReaction.strength);
        console.log(`✅ BUY: S/R Zone ${srReaction.reactionType} @ ${srReaction.zone.price.toFixed(1)} (+${(srReaction.strength * 100).toFixed(1)}%)`);
      } else {
        dir.addSell(`sr_zone_${srReaction.reactionType.toLowerCase()}`, srReaction.strength);
        console.log(`🔴 SELL: S/R Zone ${srReaction.reactionType} @ ${srReaction.zone.price.toFixed(1)} (+${(srReaction.strength * 100).toFixed(1)}%)`);
      }

      if (srReaction.zone.touches >= 3 && srReaction.zone.rejectionWicks >= 2) {
        const multiTouchBonus = 0.08;
        if (srReaction.zone.type === 'SUPPORT') {
          dir.addBuy('multi_touch_sr_confirmation', multiTouchBonus);
        } else {
          dir.addSell('multi_touch_sr_confirmation', multiTouchBonus);
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
      if (dir.buy > dir.sell) {
        dir.addBuy('fibonacci_alignment', fibDirectionalBoost, false);
      } else if (dir.sell > dir.buy) {
        dir.addSell('fibonacci_alignment', fibDirectionalBoost, false);
      }
      attentionScores.set('fibonacci_alignment', fibDirectionalBoost);
      console.log(`✅ Price near Fibonacci Level (+${(fibDirectionalBoost * 100).toFixed(0)}% to dominant direction only)`);
    }
    
    if (features.emaCrossover > 0.5) {
      dir.addBuy('bullish_ema_crossover', 0.08);
      console.log('✅ BUY: Bullish EMA Crossover');
    } else if (features.emaCrossover < -0.5) {
      dir.addSell('bearish_ema_crossover', 0.08);
      console.log('🔴 SELL: Bearish EMA Crossover');
    }
    
    if (features.macdHistogram > 0.3) {
      dir.addBuy('bullish_macd_momentum', 0.07);
      console.log('✅ BUY: Bullish MACD Momentum');
    } else if (features.macdHistogram < -0.3) {
      dir.addSell('bearish_macd_momentum', 0.07);
      console.log('🔴 SELL: Bearish MACD Momentum');
    }

    // ITEM F — VWAP, RE-SOURCED. `features.vwap` is now barVWAP() over the
    // sealed M5 series (range-weighted, 30 bars = 2.5h). The old value paired
    // priceHistory closes (Capital.com/Swissquote TICKS) with highHistory/
    // lowHistory (TwelveData/Yahoo BARS) by shared array index — tick-derived
    // AND cross-venue. Restored to scoring on the bar basis.
    if (features.vwap !== null) {
      const vwapDelta = this.currentPrice - features.vwap;
      if (vwapDelta > 1.5) {
        dir.addBuy('bar_above_vwap', 0.05);
        console.log(`✅ BUY: Price ${vwapDelta.toFixed(1)} above M5 VWAP (${features.vwap.toFixed(1)})`);
      } else if (vwapDelta < -1.5) {
        dir.addSell('bar_below_vwap', 0.05);
        console.log(`🔴 SELL: Price ${Math.abs(vwapDelta).toFixed(1)} below M5 VWAP (${features.vwap.toFixed(1)})`);
      }
    }

    // ITEM F — ADX, RE-SOURCED. `features.adx` is now a properly Wilder-smoothed
    // ADX over the sealed M5 series. The old value was a single-window DX that
    // paired bar highs/lows with TICK closes by shared array index across two
    // independently-populated arrays.
    if (features.adx !== null) {
      if (features.adx > 25) {
        const adxBoost = Math.min(0.08, (features.adx - 25) * 0.003);
        if ((htfTrend === 'BULLISH' && ltfTrend === 'BULLISH')) {
          dir.addBuy('bar_adx_trend_strength', parseFloat(adxBoost.toFixed(4)));
          console.log(`✅ BUY: M5 ADX ${features.adx.toFixed(1)} confirms BULLISH alignment (+${(adxBoost * 100).toFixed(1)}%)`);
        } else if ((htfTrend === 'BEARISH' && ltfTrend === 'BEARISH')) {
          dir.addSell('bar_adx_trend_strength', parseFloat(adxBoost.toFixed(4)));
          console.log(`🔴 SELL: M5 ADX ${features.adx.toFixed(1)} confirms BEARISH alignment (+${(adxBoost * 100).toFixed(1)}%)`);
        }
      } else if (features.adx < 18) {
        console.log(`ℹ️ Low M5 ADX ${features.adx.toFixed(1)} - weak trend regime`);
      }
    }

    // ITEM F — Bollinger squeeze breakout, RE-SOURCED. Both the squeeze AND the
    // breakout direction now come from the sealed M5 series. The direction
    // previously came from detectPriceDirection() = priceHistory.slice(-5) —
    // FIVE TICKS deciding which way a breakout was going.
    if (features.bollingerSqueeze && features.marketRegime.type === 'QUIET') {
      const m5ForBreakout = this.getDirectionalM5();
      const breakoutBias = m5ForBreakout === null ? 0 : barBollingerBreakout(m5ForBreakout, 20);
      if (breakoutBias > 0) {
        dir.addBuy('bar_bollinger_squeeze_bull_breakout', 0.08);
        console.log('✅ BUY: M5 Bollinger squeeze breakout (close above upper band)');
      } else if (breakoutBias < 0) {
        dir.addSell('bar_bollinger_squeeze_bear_breakout', 0.08);
        console.log('🔴 SELL: M5 Bollinger squeeze breakout (close below lower band)');
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
      if (dxy.dxyChange > 0.15 && dir.buy > dir.sell) {
        const dxyPenalty = Math.min(0.12, dxy.dxyChange * 0.5) * dxyModulation;
        dir.penalizeBuy('dxy_headwind', dxyPenalty);
        console.log(`⚠️ DXY +${dxy.dxyChange.toFixed(2)} rising vs LONG gold bias: -${(dxyPenalty * 100).toFixed(1)}% (learned x${dxyModulation.toFixed(2)})`);
      } else if (dxy.dxyChange < -0.15 && dir.sell > dir.buy) {
        const dxyPenalty = Math.min(0.12, Math.abs(dxy.dxyChange) * 0.5) * dxyModulation;
        dir.penalizeSell('dxy_headwind', dxyPenalty);
        console.log(`⚠️ DXY ${dxy.dxyChange.toFixed(2)} falling vs SHORT gold bias: -${(dxyPenalty * 100).toFixed(1)}% (learned x${dxyModulation.toFixed(2)})`);
      }
    }
    
    
    const bearishDivergence = this.detectBearishDivergence(features);
    const bullishDivergence = this.detectBullishDivergence(features);
    
    if (bearishDivergence) {
      dir.addSell('bearish_divergence', 0.20);
      console.log('🔴 SELL: Bearish Divergence Detected');
    }
    
    if (bullishDivergence) {
      dir.addBuy('bullish_divergence', 0.20);
      console.log('✅ BUY: Bullish Divergence Detected');
    }
    
    // ITEM 63(b): QUASIMODO mutual exclusion. The previous code had two
    // independent `some()` calls — both fired whenever both a BULLISH_QM and a
    // BEARISH_QM level existed within $8 of current price. Now: filter by
    // proximity, sort by strength, fire only the strongest side. Both can
    // never fire (G63-2: absolute mutual exclusion).
    //
    // ITEM 63(c): QM proximity radius is now ATR-relative. The previous flat $8
    // was 7.7x the current ATR ($1.04) and 4.7x the median ATR ($1.70). At
    // 2x ATR (~$3.40 at p50), the radius is tighter and scales with volatility.
    // Coefficient 2.0 matches the strengthDecayDistance coefficient for
    // consistency: both are "proximity to meaningful structure" concepts.
    const QM_PROXIMITY_ATR_COEFF = 2.0;
    const qmProximity = Math.max(features.atr * QM_PROXIMITY_ATR_COEFF, this.currentPrice * ZONE_WIDTH_FLOOR_PCT);
    const nearbyQM = features.quasimodolLevels
      .filter(qm => Math.abs(this.currentPrice - qm.price) < qmProximity)
      .sort((a, b) => b.strength - a.strength);
    if (nearbyQM.length > 0) {
      const strongest = nearbyQM[0];
      if (strongest.type === 'BULLISH_QM') {
        dir.addBuy('bullish_quasimodo', 0.18);
        console.log(`✅ BUY: Strongest nearby Quasimodo (BULLISH @ ${strongest.price.toFixed(1)}, strength ${(strongest.strength * 100).toFixed(0)}%, proximity $${qmProximity.toFixed(2)}) — ${nearbyQM.length} QM level(s) nearby, fired strongest`);
      } else {
        dir.addSell('bearish_quasimodo', 0.18);
        console.log(`🔴 SELL: Strongest nearby Quasimodo (BEARISH @ ${strongest.price.toFixed(1)}, strength ${(strongest.strength * 100).toFixed(0)}%, proximity $${qmProximity.toFixed(2)}) — ${nearbyQM.length} QM level(s) nearby, fired strongest`);
      }
    }
    
    const confirmedLowSweep = features.sessionSweeps.find(
      sweep => sweep.type === 'LOW_SWEEP' && sweep.reversalConfirmed
    );
    if (confirmedLowSweep) {
      dir.addBuy('session_low_sweep', 0.35 * confirmedLowSweep.strength, false); // Increased for high accuracy
      attentionScores.set('session_low_sweep', 0.35);
      console.log(`✅ BUY: ${confirmedLowSweep.sessionType} Session Low Sweep Confirmed (High Accuracy Setup)`);
      console.log(`   Sweep @ ${confirmedLowSweep.sweepPrice.toFixed(1)} - Reversal confirmed`);
    }
    
    const confirmedHighSweep = features.sessionSweeps.find(
      sweep => sweep.type === 'HIGH_SWEEP' && sweep.reversalConfirmed
    );
    if (confirmedHighSweep) {
      dir.addSell('session_high_sweep', 0.35 * confirmedHighSweep.strength, false); // Increased for high accuracy
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
    // TICK-INPUT REMOVAL: 'strong_uptrend'/'strong_downtrend' dropped from this
    // list — they no longer exist as scoring keys (now tick_telemetry:*).
    const momentumAlreadyCounted = [
      'htf_ltf_bullish_alignment', 'htf_ltf_bearish_alignment',
      'ltf_momentum_buy', 'ltf_momentum_sell',
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

    const buySignalStrength = dir.buy;
    const sellSignalStrength = dir.sell;

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
      // ITEM 51 STALENESS FIX. `lastSignalStrengthDifference` used to be assigned
      // ONLY on the success path (after every gate passed). Every rejection
      // returned early and left the field holding the diff from whatever run last
      // succeeded — sometimes many minutes old. recordNearMiss() reads that same
      // field, so every "Setup Brewing" row logged between two successful runs
      // was stamped with one identical, stale diff regardless of its own inputs.
      // Assign on EVERY exit path so the value always describes THIS evaluation.
      this.lastSignalStrengthDifference = strengthDifference;
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
        attentionSides,
      };
    }
    
    const adaptiveAdjust = this.getAdaptiveDiffAdjustment(features.marketRegime.type);
    const regimeMinDiff = Math.max(0.04, getMinStrengthDifferenceForRegime(features.marketRegime.type) + adaptiveAdjust);
    if (adaptiveAdjust !== 0) {
      console.log(`📉 Adaptive diff gate: ${adaptiveAdjust.toFixed(3)} (low-bucket EV positive)`);
    }
    if (strengthDifference < regimeMinDiff) {
      // ITEM 51 STALENESS FIX (see the conviction-gate exit above).
      this.lastSignalStrengthDifference = strengthDifference;
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
        attentionSides,
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
    // TICK-INPUT REMOVAL (2026-08-02): the six tick-derived keys
    // (strong_uptrend/downtrend, strong_up/downtrend_pattern, adx_trend_strength,
    // above/below_vwap) are removed here too. Leaving them would have let a
    // zero-weight telemetry entry keep inflating CONFIDENCE through the
    // confluence bonus — and confidence gates emission via minConfidence, so
    // that is a scoring contribution in all but name. They now live under the
    // `tick_telemetry:` prefix, which cannot match any key lookup.
    const alignmentKeys = [
      'htf_ltf_bullish_alignment', 'htf_ltf_bearish_alignment',
      'bullish_ema_crossover', 'bearish_ema_crossover',
    ];
    const alignmentCount = alignmentKeys.reduce((acc, k) => acc + (attentionScores.has(k) ? 1 : 0), 0);
    const dxyAligned = (
      features.intermarketData &&
      ((isBullish && features.intermarketData.dxyChange < -0.05) ||
       (!isBullish && features.intermarketData.dxyChange > 0.05))
    ) ? 1 : 0;
    const totalAlignment = alignmentCount + dxyAligned;
    const alignmentBonus = Math.min(0.18, totalAlignment * 0.03);
    // ITEM 138(b) — CONFIDENCE SCORE DECOMPOSITION.
    // The inputs that feed confidence, in order of their weight:
    //   1. signalStrength * 0.40    — the dominant term (buySignalStrength or sellSignalStrength)
    //   2. 0.40 base                 — constant floor
    //   3. alignmentBonus (max 0.18) — HTF/LTF alignment + DXY confluence
    //   4. sentimentImpact * 0.05   — sentiment score magnitude
    //   5. fibonacciAlignment +0.04 — fib confluence
    //   6. srReactionBoost           — S/R zone reaction strength * 0.15
    //   7. regimeConfidence +0.02   — if market regime confidence > 0.85
    //   8. timeBoost                 — time window factor * 0.04
    //   9. learningAdjustment        — (profitFactor - 1.5) * 0.06, clamped
    //  Then penalties: strengthDifference < 0.12 (* 0.85), < 0.18 (* 0.94),
    //  losingStrength > 0.3 (-losingStrength * 0.12), data quality, calibration.
    //
    //  ITEM 138(c) MECHANICAL EXPLANATION TESTS:
    //  (1) TP3 stretch: the old code stretched TP3 when confidence >= 0.89.
    //      Item 109 rewired TP to user-pips, so the stretch is now inert.
    //      TP3_CONFIDENCE_STRETCH_ENABLED=false documents this.
    //  (2) SL multiplier: atrMultiplier = Math.max(1.0, Math.min(1.6, 0.7 + atr*0.06))
    //      is NOT conditioned on confidence — it reads ATR only.
    //  (3) Sub-0.68 cohort: 100% BACKFILL (0% LIVE), spread across Jun 29 - Jul 31.
    //      F-32 proved era splits can be artefacts of a corrupted column. The
    //      sub-0.68 EV +0.0754R has CI [-0.145, +0.296] — INCLUDES ZERO.
    //      Combined with the era confound, F-33 is NOT CONFIRMED as inversion.
    //  (4) The canonical book n=313 EV=-0.0751R differs from the prior round's
    //      n=426 EV=+0.0178R because the resolver has since resolved more rows,
    //      changing the book composition. The +0.0178R was correct at its time.
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
    // ITEM 63(e): the free pass for signalStrength > 0.75 is REMOVED. The skip
    // let a strong signal ignore contradictory structure entirely — opposing
    // evidence was treated as "noise" just because the winning side was strong.
    // With Item 63(a)/(b) fixing the S/R and QM mutual-exclusion defects, the
    // contradictory contributions from those two sources are gone, but OTHER
    // features can still create opposing strength (e.g., bullish_divergence and
    // bearish_divergence are still two independent `if` statements). The penalty
    // now applies whenever losingStrength > 0.3, regardless of how strong the
    // winning side is. A strong signal with genuine opposing evidence should be
    // penalized — high conviction does not make contradictory structure disappear.
    if (losingStrength > 0.3) {
      const conflictPenalty = losingStrength * 0.12;
      baseConfidence -= conflictPenalty;
      console.log(`⚠️ Opposing signal strength penalty: -${(conflictPenalty * 100).toFixed(1)}% (opposing: ${(losingStrength * 100).toFixed(1)}%, winning: ${(signalStrength * 100).toFixed(1)}%)`);
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

    if (strengthDifference < 0.25) {
      calibrationPenalty += 0.04;
      calibrationPenalty25Count += 1;
      console.log(`⚠️ CALIBRATION_PENALTY_25_FIRED: strengthDifference=${strengthDifference.toFixed(4)} < 0.25, +0.04 (total penalty=${calibrationPenalty.toFixed(4)}, count=${calibrationPenalty25Count})`);
    }
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
    
    const smoothedConfidence = this.smoothConfidence(rawConfidence, isBullish ? 'BUY' : 'SELL');
    
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
      attentionSides,
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

    // ITEM 2a fix: arbitration order bug — the previous code tested
    // bullishScore >= 1.5 FIRST and returned BULLISH early, so when both sides
    // cleared 1.5 (e.g. bear=2.5 vs bull=1.5), BULLISH always won regardless of
    // which score was actually higher. This was the measured defect: on 31 July,
    // detectHTFTrend returned BULLISH on a -401 pip downtrend day because
    // developingDayBullish (a V-shaped intraday bounce) contributed 1.0 while
    // pivotBearish + dailyTrendBearish contributed 1.5, but the early bull
    // return fired on pivotBullish + developingDayBullish = 1.5.
    //
    // Fix: the HIGHER score wins. Ties (equal scores, both >= 1.5) resolve to
    // NEUTRAL — a genuinely ambiguous signal should not commit to a direction.
    if (bullishScore >= 1.5 && bullishScore > bearishScore) {
      return 'BULLISH';
    } else if (bearishScore >= 1.5 && bearishScore > bullishScore) {
      return 'BEARISH';
    } else {
      return 'NEUTRAL';
    }
  }
  
  /**
   * ITEM F — LTF trend, RE-SOURCED ONTO BARS.
   *
   * Was: `priceHistory.slice(-5)` — the current price against a FIVE-TICK
   * average, i.e. roughly a 25-second window whose duration varied with tick
   * arrival rate, compared against a threshold derived from a tick-window
   * volatility estimate. Two unstable quantities divided by each other.
   *
   * Now: EMA-9 vs EMA-21 on the sealed M5 series (45 vs 105 minutes) with an
   * ATR-scaled hysteresis band, so the verdict has a fixed time base and the
   * NEUTRAL zone adapts to the volatility regime instead of a hand-tuned
   * constant. Correctness covered by test 9 in `test_bar_indicators.ts`.
   *
   * When the bar series is missing or stale this returns NEUTRAL — stand aside,
   * never fall back to the tick classifier.
   */
  private detectLTFTrend(): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const m5 = this.getDirectionalM5();
    if (!m5) {
      console.log('📈 LTF Trend: M5 bar series unavailable/stale → NEUTRAL (standing aside, no tick fallback)');
      return 'NEUTRAL';
    }
    const verdict = barLTFTrend(m5, 0.25);
    console.log(`📈 LTF Trend (M5 EMA9/21, ATR hysteresis): ${verdict}`);
    return verdict;
  }

  /** Legacy 5-tick LTF classifier. RETAINED FOR TELEMETRY/COMPARISON ONLY — not called on any scoring path. */
  private detectLTFTrendFromTicksLegacy(): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
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

  /**
   * ITEM F — bearish RSI divergence, RE-SOURCED ONTO BARS.
   *
   * Was: `highHistory[4]` vs `highHistory[9]` (arbitrary fixed offsets into a
   * 10-element bar-cadence array) compared against an RSI computed on a
   * DIFFERENT series entirely (`priceHistory`, ticks). Price and momentum were
   * literally not measured on the same data, which is fatal for a divergence
   * test — the whole construct is "price and its own momentum disagree".
   *
   * Now: swing extremes and RSI both read from the same sealed M5 series.
   * Correctness covered by test 11 in `test_bar_indicators.ts`.
   */
  private detectBearishDivergence(features: MarketFeatures): boolean {
    void features;
    const m5 = this.getDirectionalM5();
    if (!m5) return false;
    const d = barDivergence(m5, 5, 14);
    if (d.bearish) console.log(`🔍 Bearish Divergence (M5 bars): ${d.detail}`);
    return d.bearish;
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
  
  /** ITEM F — bullish RSI divergence, RE-SOURCED ONTO BARS. See detectBearishDivergence. */
  private detectBullishDivergence(features: MarketFeatures): boolean {
    void features;
    const m5 = this.getDirectionalM5();
    if (!m5) return false;
    const d = barDivergence(m5, 5, 14);
    if (d.bullish) console.log(`🔍 Bullish Divergence (M5 bars): ${d.detail}`);
    return d.bullish;
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
    gate?: CounterTrendGateTelemetry,
    direction: 'BUY' | 'SELL' = 'BUY',
  ): SignalLearningContext {
    const now = new Date();
    const price = geometry.entryPrice;
    const atr = Math.max(features.atr, 0.01);

    // ITEM AB — side-relative features, computed from data available AT or
    // BEFORE the signal bar (barSeriesM5 is aggregated from gold_m1_bars up
    // to the present; srZones is the live zone map). A null component means
    // "not computable" (insufficient bars) — training excludes such rows
    // (Item AC NaN rule) and scoring standardises null to the mean.
    const sideRelative = computeSideRelativeFeatures({
      direction,
      entryPrice: price,
      rsi: Number.isFinite(features.rsi) ? features.rsi : null,
      m5Bars: this.barSeriesM5 ?? [],
      zonePrices: features.srZones.map((z) => z.price),
    });

    const nearestZoneDistance = features.srZones.length > 0
      ? Math.min(...features.srZones.map(z => Math.abs(z.price - price)))
      : undefined;

    const confirmedSweep = features.sessionSweeps.find(s => s.reversalConfirmed)
      ?? features.sessionSweeps[features.sessionSweeps.length - 1];

    const context: SignalLearningContext = {
      rsi: features.rsi,
      atr: features.atr,
      volumeRatio: features.volumeRatio,
      dxyChange: features.dxyChange,
      timeWindowFactor: features.timeWindowFactor,
      sentiment: features.sentiment ?? { score: 0, confidence: 0, source: 'engine-default' },

      schemaVersion: LEARNING_FEATURE_SCHEMA_VERSION,

      // ITEM AB — side-relative feature vector (see computeSideRelativeFeatures).
      ...sideRelative,

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

      // ITEM 28 (v3): written from the SAME frozen telemetry record attached to
      // the signal, so the learning corpus and the signal record can never
      // disagree about what the gate saw. Absent (not zero) on any path that
      // does not supply it.
      htfTrendAtGate: gate?.htfTrendAtGate,
      ltfTrendAtGate: gate?.ltfTrendAtGate,
      counterTrendClassified: gate?.counterTrendClassified,
      recentDrift: gate?.recentDrift,
      driftAgainst: gate?.driftAgainst,
      driftVetoThreshold: gate?.driftVetoThreshold,
      driftVetoPredicateTrue: gate?.driftVetoPredicateTrue,
      sweepReclaimConfirmedAtGate: gate?.sweepReclaimConfirmed,
      driftVetoOverrideApplied: gate?.driftVetoOverrideApplied,
      spreadPipsAtEntry: gate?.spreadPipsAtEntry,
    };

    // ITEM AC — shadow model probability. Standardises with the STORED corpus
    // means/stds; a missing/NaN feature standardises to 0 (the mean). NEVER
    // used for the emission decision or the confidence field (the Item AD
    // verdict is logging only; suppression is a future, separately-gated item).
    const probability = scoreLogisticModel(extractFeatureVector(context), this.logisticModel);
    if (probability !== null) {
      context.modelProbability = probability;
      // ITEM AD — shadow verdict, derived from the probability. Logging/
      // telemetry ONLY: no signal is suppressed, filtered, demoted or delayed
      // on this basis (the promotion gate lives in the diagnostics export).
      context.modelVerdict = verdictForProbability(probability);
    }
    return context;
  }

  /**
   * ITEM 179(c) — bar-derived learning-context reconstruction. Mirrors the
   * resolver's computeLearningFeatures(): RSI-14 (Wilder) and ATR-14 over the
   * M1 bars in the 60 minutes BEFORE emission, read DIRECT from gold_m1_bars
   * via the anon key. Returns null when bars are insufficient — the caller
   * then keeps the default-context path (which logs loudly).
   *
   * Labeled reconstruction, not engine-identical values: the engine computes
   * its own scalars on M5 aggregates with live sentiment/DXY feeds; these are
   * M1 bar-derived approximations for capture, marked
   * featuresSource='app-bar-reconstruction' so the provenance is permanent.
   */
  private async reconstructLearningFeaturesFromBars(emittedAtMs: number): Promise<Partial<SignalLearningContext> | null> {
    try {
      const client = this.getDailyOhlcSupabaseClient();
      if (!client) return null;
      const fromIso = new Date(emittedAtMs - 60 * 60_000).toISOString();
      const toIso = new Date(emittedAtMs - 1_000).toISOString();
      const { data, error } = await client
        .from('gold_m1_bars')
        .select('timestamp, high, low, close')
        .gte('timestamp', fromIso)
        .lte('timestamp', toIso)
        .order('timestamp', { ascending: true })
        .range(0, 999);
      if (error || !data || data.length < 15) return null;
      const bars = data as Array<{ timestamp: string; high: number; low: number; close: number }>;
      const closes = bars.map((b) => Number(b.close));
      let avgGain = 0;
      let avgLoss = 0;
      for (let i = 1; i <= 14; i += 1) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) avgGain += d;
        else avgLoss -= d;
      }
      avgGain /= 14;
      avgLoss /= 14;
      for (let i = 15; i < closes.length; i += 1) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * 13 + Math.max(d, 0)) / 14;
        avgLoss = (avgLoss * 13 + Math.max(-d, 0)) / 14;
      }
      const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      // ITEM 195(c) — ATR-14: genuine Wilder ATR-14 over the LAST 15 M1 bars.
      // The previous construct averaged true range across the whole ~59-bar
      // pre-emission window while labelling itself "ATR-14" — the F-32
      // collision class (one atr column, two incompatible constructs). Now:
      // bars.slice(-15) -> 14 true ranges -> Wilder seed (mean of the first
      // 14) -> Wilder smoothing over any remainder (no-op at exactly 15 bars),
      // plus construct-provenance fields so the value self-describes.
      const atrWindow = bars.slice(-15);
      const trs: number[] = [];
      for (let i = 1; i < atrWindow.length; i += 1) {
        const prevClose = Number(atrWindow[i - 1].close);
        trs.push(Math.max(
          Number(atrWindow[i].high) - Number(atrWindow[i].low),
          Math.abs(Number(atrWindow[i].high) - prevClose),
          Math.abs(Number(atrWindow[i].low) - prevClose),
        ));
      }
      let atr: number | null = null;
      if (trs.length >= 14) {
        let wilder = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
        for (let i = 14; i < trs.length; i += 1) {
          wilder = (wilder * 13 + trs[i]) / 14;
        }
        atr = wilder;
      }
      if (!Number.isFinite(rsi) || atr === null || !Number.isFinite(atr)) return null;
      return {
        rsi: Number(rsi.toFixed(2)),
        atr: Number(atr.toFixed(2)),
        // ITEM 195(c): construct provenance — the atr column now self-describes.
        atrPeriod: 14,
        atrTimeframe: 'M1',
        atrMethod: 'wilder',
        volumeRatio: 1,
        timeWindowFactor: 1,
        dxyChange: 0,
        sentiment: { score: 0, confidence: 0, source: 'app-bar-reconstruction' },
        schemaVersion: 1,
        featuresSource: 'app-bar-reconstruction',
      };
    } catch (err) {
      console.warn('[Item179] learning-context bar reconstruction failed:', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * ITEM 224: `maxFavourable` is the LAST parameter and fully optional, so every
   * pre-existing call site keeps its exact behaviour and simply records the
   * field as absent. Nothing else in this method changed.
   */
  async recordTradeOutcome(signalId: string, entryPrice: number, exitPrice: number, result: 'WIN' | 'LOSS', features?: Partial<SignalLearningContext>, misleadingFeatures?: FeatureConfidence[], signalDuration?: number, confidence?: number, stopDistance?: number, maxFavourable?: MfeResult): Promise<void> {
    const pnl = result === 'WIN' ? Math.abs(exitPrice - entryPrice) : -Math.abs(exitPrice - entryPrice);
    const normalizedConfidence = Math.max(0.42, Math.min(0.95, confidence ?? this.performanceMetrics.avgConfidence ?? 0.72));
    // ITEM 179(c) — bar-derived fallback when the caller dropped the learning
    // context. Every app call site passes signal.learningContext, and that
    // field persists with signal_history, so this fires only for a signal
    // restored without its context (e.g. emitted before an app update added
    // the field). Previously such an outcome silently fell back to DEFAULT
    // scalars — the uniform-1/6 mechanism. Now the six scalars are
    // reconstructed from the real M1 bars before emission. `signalDuration`
    // is (now - emission) at every call site, so the emission instant is
    // Date.now() - signalDuration.
    let effectiveFeatures = features;
    if (features === undefined || Object.keys(features).length === 0) {
      const emittedAtMs = typeof signalDuration === 'number' && Number.isFinite(signalDuration) && signalDuration > 0
        ? Date.now() - signalDuration
        : null;
      if (emittedAtMs !== null) {
        const reconstructed = await this.reconstructLearningFeaturesFromBars(emittedAtMs);
        if (reconstructed !== null) {
          effectiveFeatures = reconstructed;
          console.warn(`⚠️ [Item179] outcome ${signalId.slice(-6)} arrived with NO learning context — reconstructed bar-derived features (rsi=${reconstructed.rsi}, atr=${reconstructed.atr}) from gold_m1_bars before emission; provenance featuresSource='app-bar-reconstruction'`);
        }
      }
    }
    // ITEM 199(c) — ENGINE-NATIVE ATR CONSTRUCT PROVENANCE. The engine's
    // calculateRealATR(14) is a SIMPLE MEAN of the last 14 true ranges over
    // bar-aligned M1 history (TwelveData XAU/USD 1-min), NOT Wilder. Until
    // now only reconstruction rows carried construct provenance, leaving
    // engine-native rows silent in the same atr column — exactly how F-32
    // started. Any features reaching this point WITHOUT an atrMethod are
    // engine-native and now get their own provenance values, so both
    // constructs are self-describing forever. Did NOT change: the atr value
    // itself, any other feature, the reconstruction path's wilder/M1/14 set.
    if (effectiveFeatures && effectiveFeatures.atrMethod === undefined) {
      effectiveFeatures = {
        ...effectiveFeatures,
        atrPeriod: 14,
        atrTimeframe: 'M1',
        atrMethod: 'mean-tr',
      };
    }
    const defaultContext = createDefaultLearningContext();
    // The six v1 scalars are still normalized with explicit fallbacks (they are
    // REQUIRED and read unconditionally by drift/correlation code). Every wide
    // v2 field is carried through verbatim via the spread: absent stays absent,
    // so a legacy record is never back-filled with invented values.
    const normalizedFeatures: SignalLearningContext = {
      ...(effectiveFeatures ?? {}),
      rsi: typeof effectiveFeatures?.rsi === 'number' ? effectiveFeatures.rsi : defaultContext.rsi,
      atr: typeof effectiveFeatures?.atr === 'number' ? effectiveFeatures.atr : defaultContext.atr,
      volumeRatio: typeof effectiveFeatures?.volumeRatio === 'number' ? effectiveFeatures.volumeRatio : defaultContext.volumeRatio,
      dxyChange: typeof effectiveFeatures?.dxyChange === 'number' ? effectiveFeatures.dxyChange : defaultContext.dxyChange,
      timeWindowFactor: typeof effectiveFeatures?.timeWindowFactor === 'number' ? effectiveFeatures.timeWindowFactor : defaultContext.timeWindowFactor,
      sentiment: effectiveFeatures?.sentiment ?? defaultContext.sentiment,
      schemaVersion: effectiveFeatures?.schemaVersion ?? 1,
    };
    // ITEM 169(c) — write-time capture assertion. An outcome whose incoming
    // learning context was dropped AND could not be reconstructed from bars
    // falls back to defaults for all six scalars, which is precisely the
    // uniform-1/6 mechanism (identical winner and loser centroids). The
    // fallback announces itself instead of pretending to be data.
    if (effectiveFeatures === undefined || Object.keys(effectiveFeatures).length === 0) {
      console.warn(`⚠️ [Item169] outcome ${signalId.slice(-6)} recorded with DEFAULT features — the caller dropped the learning context and bar reconstruction was unavailable (capture defect, not a modelling one)`);
    }
    
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
      // ITEM 224 — ADDITIVE. Every field above is computed exactly as before:
      // result, pnl, realizedR and isScratch are untouched by this round.
      maxFavourable,
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

    // ITEM 105 — remove this signal from the activeSignalsByDirection tracker.
    // It has reached a terminal status, so it no longer blocks same-direction
    // signals in its zone cluster.
    if (direction) {
      const dirList = this.activeSignalsByDirection.get(direction);
      if (dirList) {
        const filtered = dirList.filter(s => s.signalId !== signalId);
        if (filtered.length !== dirList.length) {
          this.activeSignalsByDirection.set(direction, filtered);
        }
      }
    }

    // ITEM 95(c) — RSI modulation agreement tracker.
    // Compare the direction the RSI modulation pushed (lastRsiModDirection)
    // against the actual outcome. A WIN where RSI pushed BUY = agreed;
    // a LOSS where RSI pushed BUY = disagreed. WATCH ITEM only — n=4 so far
    // (4/4 disagreed). Do NOT change any weight on it; the tracker accumulates
    // evidence for a future round once n is adequate.
    if (this.lastRsiModDirection !== 'NEUTRAL' && !isScratch) {
      const outcomeDirection = direction ?? 'BUY';
      const modAgreedWithOutcome =
        (this.lastRsiModDirection === outcomeDirection && result === 'WIN') ||
        (this.lastRsiModDirection !== outcomeDirection && result === 'LOSS');
      if (modAgreedWithOutcome) {
        this.rsiModAgreed += 1;
      } else {
        this.rsiModDisagreed += 1;
      }
      console.log(`🧠 RSI_MOD_TRACKER: pushed ${this.lastRsiModDirection}, outcome ${result} (${outcomeDirection}) → ${modAgreedWithOutcome ? 'AGREED' : 'DISAGREED'} (tally: ${this.rsiModAgreed} agreed / ${this.rsiModDisagreed} disagreed)`);
    }
    
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

    // ITEM 64(c): per-feature CRITICAL drift now triggers a retrain independently
    // of the overall concept drift score. Previously, a single feature could be
    // CRITICAL (drift > 0.6) while the arithmetic-mean overall score sat at MEDIUM
    // (0.4559), firing nothing. The overall average masks individual features —
    // sentiment sat at 0.699 CRITICAL under a 0.4559 MEDIUM average for days.
    const latestDriftMetrics = this.analyzeFeatureValueDrift();
    // ITEM 82 / B4 — F-14: only a MEASURED CRITICAL may force retrain eligibility.
    // An INSUFFICIENT_DATA metric is explicitly excluded: it means the feature was
    // absent from the compared corpus rows, which is a completeness problem, not
    // drift. Before this fix a NaN was classified CRITICAL and pinned this trigger
    // permanently ON, so it could never discriminate.
    const anyFeatureCritical = latestDriftMetrics.some(m => m.status === 'CRITICAL');
    const insufficientDataFeatures = latestDriftMetrics.filter(m => m.status === 'INSUFFICIENT_DATA').map(m => m.feature);
    if (insufficientDataFeatures.length > 0) {
      console.log(`ℹ️ DRIFT NOT MEASURABLE for ${insufficientDataFeatures.length} feature(s): ${insufficientDataFeatures.join(', ')} — excluded from the retrain trigger (F-14).`);
    }
    if (anyFeatureCritical) {
      console.log(`🚨 PER-FEATURE CRITICAL DRIFT detected — forcing retrain eligibility`);
      latestDriftMetrics.filter(m => m.status === 'CRITICAL').forEach(m => {
        console.log(`   🔥 ${m.feature}: drift ${m.drift.toFixed(3)} (CRITICAL)`);
      });
    }
    
    if (shouldRetrainScheduled || shouldRetrainConfidenceDrop || anyFeatureCritical) {
      const reason = anyFeatureCritical
        ? `Per-Feature CRITICAL Drift (${latestDriftMetrics.filter(m => m.status === 'CRITICAL').map(m => m.feature).join(', ')})`
        : shouldRetrainConfidenceDrop 
          ? `Confidence Degradation (avg: ${(avgRecentWinConfidence * 100).toFixed(1)}%)`
          : 'Scheduled 48-Hour Retrain';
      
      if (isLowLiquidityWindow) {
        console.log(`🔔 RETRAINING TRIGGERED: ${reason}`);
        console.log(`   Scheduled: ${shouldRetrainScheduled}, ConfDrop: ${shouldRetrainConfidenceDrop}`);
        console.log(`   Avg Win Conf: ${(avgRecentWinConfidence * 100).toFixed(1)}%, Threshold: ${(MIN_CONFIDENCE_FOR_RETRAINING * 100).toFixed(1)}%`);
        console.log(`   ✅ EXECUTING NOW: Low-liquidity window active (${currentUTCHour}:00 UTC)`);
        await this.walkForwardOptimization(reason);
        this.retrainScheduled = false;

        this.retrainScheduledAtMs = null;

        this.retrainScheduledReason = null;
      } else {
        console.log(`🔔 RETRAINING NEEDED: ${reason}`);
        console.log(`   ⏰ SCHEDULED: Waiting for low-liquidity window (Asian Session: 22:00-07:00 UTC)`);
        console.log(`   Current Time: ${currentUTCHour}:00 UTC (High Liquidity)`);
        console.log(`   Reason: Minimize execution risk and resource contention`);
        this.retrainScheduled = true;
        this.retrainScheduledAtMs = Date.now();
        this.retrainScheduledReason = `${reason} - deferred until the low-liquidity window (22:00-07:00 UTC)`;
      }
    } else if (this.retrainScheduled && isLowLiquidityWindow) {
      console.log(`🔔 EXECUTING SCHEDULED RETRAIN`);
      console.log(`   ✅ Low-liquidity window active (${currentUTCHour}:00 UTC - Asian Session)`);
      console.log(`   Previous trigger: High drift or confidence degradation`);
      await this.walkForwardOptimization('Scheduled Retrain (Deferred from Peak Hours)');
      this.retrainScheduled = false;

      this.retrainScheduledAtMs = null;

      this.retrainScheduledReason = null;
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
    
    // ITEM 103: TRAINING_WINDOW_DAYS = 0 means NO window filter — use all
    // available outcomes. The 14-day window was CHOSEN not MEASURED and cut
    // 399 usable rows to ~35. Held-out validation (7d/14d/30d/60d/ALL) showed
    // 0.8% accuracy spread — statistically indistinguishable. Ship ALL.
    const trainingData = TRAINING_WINDOW_DAYS > 0
      ? this.tradeOutcomes.filter(o => new Date(o.timestamp) >= new Date(Date.now() - TRAINING_WINDOW_DAYS * 24 * 60 * 60 * 1000))
      : this.tradeOutcomes.slice(-MAX_STORED_OUTCOMES);

    if (trainingData.length < 10) {
      console.log(`⚠️ Only ${trainingData.length} outcomes available. Need at least 10.`);
      return;
    }

    console.log(`✓ Training on ${trainingData.length} outcomes (TRAINING_WINDOW_DAYS=${TRAINING_WINDOW_DAYS})`);
    console.log(`   Exponential decay weighting: Last 7 days will have 80-90% influence`);
    this.retrainModel(trainingData);
  }
  
  private retrainModel(trainingData: TradeOutcome[]): void {
    // ITEM AA — READ-SIDE CORPUS CLEANUP, applied BEFORE any weight computation.
    // Rows marked featuresSource='app-bar-reconstruction' carry 4-of-6 defaulted
    // features (volumeRatio=1, timeWindowFactor=1, dxyChange=0, sentiment.score=0
    // — see reconstructLearningFeaturesFromBars) and dilute every fitted weight
    // toward the defaults. Read-side only: rows are never deleted, and the
    // hydrate/push/pull paths are untouched. A row WITHOUT the marker predates
    // the marker and is treated as engine-native (INCLUDED).
    const corpusFilter = filterTrainingCorpus(trainingData);
    const filteredTrainingData = corpusFilter.included;
    if (corpusFilter.excludedReconstruction > 0) {
      console.log(
        `🧹 ITEM AA+AE CORPUS FILTER: excluded ${corpusFilter.excludedReconstruction} of ${corpusFilter.total} outcome(s) ` +
        `(marked ${corpusFilter.excludedReconstructionMarked} + defaulted-fingerprint ${corpusFilter.excludedReconstructionFingerprint}) — ` +
        `${filteredTrainingData.length} engine-native row(s) used for training`,
      );
    }
    if (filteredTrainingData.length < 10) {
      console.log(
        `⚠️ ITEM AA: only ${filteredTrainingData.length} engine-native outcome(s) after the reconstruction filter — ` +
        'too few to fit; keeping the existing weights',
      );
      return;
    }
    // ITEM AC — the decay weighting is retired with the centroid architecture
    // it served: the Item AC spec fits the cleaned corpus directly, with L2
    // (lambda = 1.0) providing the shrinkage. The scratch exclusion below is
    // label hygiene (PHASE 2 (C3)), not weighting.
    
    // PHASE 2 (C3) — kept under the AC architecture: drop scratches from the
    // LABEL partition. A ~0R profit-lock exit carries no information about
    // whether the setup was good.
    const scratchRows = filteredTrainingData.filter(o => o.isScratch === true);
    const labelledRows = filteredTrainingData.filter(o => o.isScratch !== true);
    if (scratchRows.length > 0) {
      console.log(`➖ Excluding ${scratchRows.length} scratch outcome(s) (|R| < ${SCRATCH_R_THRESHOLD}) from label-based weight fitting`);
    }

    // PHASE 2 (C4): realised expectancy per direction, computed here so the
    // calibration gate reads a freshly consolidated view on every retrain.
    this.recomputeDirectionalExpectancy();
    // ITEM AC — LOGISTIC REGRESSION (replaces the centroid scorer). Spec:
    //   input  = cleaned corpus (Item AA filter + scratch exclusion), each row
    //            = 13 feature values + outcome (1 = winner, 0 = loser)
    //   fit    = L2-regularised logistic regression, lambda = 1.0
    //   solver = full-batch gradient descent, lr 0.01, <= 1000 iterations,
    //            converged when |loss change| < 1e-6
    //   NaN    = rows with any missing/non-finite feature are EXCLUDED (no
    //            imputation); at scoring time a missing feature standardises
    //            to 0 (the mean)
    // Guards: fewer than 30 usable rows, no class diversity, or
    // non-convergence keeps the EXISTING weights (never fits noise).
    if (filteredTrainingData.length < 30) {
      console.log(`⚠️ ITEM AC: corpus after the AA filter is ${filteredTrainingData.length} row(s) (< 30) — NOT retraining; keeping the existing weights`);
      return;
    }
    const fitRows = labelledRows.map(o => ({
      x: extractFeatureVector(o.features),
      y: o.result === 'WIN' ? 1 : 0,
    }));
    const fitWinners = fitRows.filter(r => r.y === 1).length;
    const fitLosers = fitRows.filter(r => r.y === 0).length;
    if (fitWinners === 0 || fitLosers === 0) {
      console.log(`⚠️ ITEM AC: labelled rows have no class diversity (wins=${fitWinners}, losses=${fitLosers}) — NOT retraining; keeping the existing weights`);
      return;
    }
    // ITEM AG (ML round, weight-sign audit — distinct from the counter-trend
    // ITEM AG.2/AG.4 instrumentation) — WEIGHT-SIGN CONTEXT (documentation
    // only, no weight is changed):
    // The backtest population (4,570 double-top/bottom signals, matched null,
    // 18mo M5) found opposite signs for trend_aligned and rsi_aligned compared
    // to this corpus. The most likely cause is population composition: the
    // engine emits ~60% BUYs with 36% WR, skewing the winner centroid. The
    // shadow gate (SECTION 11) settles whether these weights predict on the
    // live population.
    const fit = fitLogisticRegression(fitRows, { lambda: 1.0, learningRate: 0.01, maxIterations: 1000, tolerance: 1e-6 });
    // ITEM AF — the corpus-level <30 guard above counts rows BEFORE the fit's
    // NaN exclusion; the fit can still land on as few as 2 usable rows. A 2-29
    // row fit is exactly the "fitting noise on tiny samples" case the AC guard
    // exists to prevent, so the same floor applies to the fit's own usable-row
    // count. Sits BEFORE the convergence check and BEFORE
    // this.modelWeights.clear() — on this return the existing
    // weights and the restored logisticModel are untouched, so modelProbability
    // continues to be stamped from the previous model (or not stamped when no
    // previous model exists).
    if (fit.rowsUsed < 30) {
      console.log(`⚠️ ITEM AF: logistic fit used only ${fit.rowsUsed} rows (< 30) — keeping the existing weights to prevent noise`);
      return;
    }
    // (72h review D2: the former `rowsUsed < 2` clause here was unreachable
    // once the AF `< 30` floor above existed — removed, no behaviour change.)
    if (!fit.converged || !Number.isFinite(fit.finalLoss)) {
      console.log(
        `⚠️ ITEM AC: logistic fit did not converge (iterations=${fit.iterations}, rowsUsed=${fit.rowsUsed}, finalLoss=${fit.finalLoss}) — keeping the existing weights`,
      );
      return;
    }

    console.log('\n📈 ITEM AC LOGISTIC FIT:');
    console.log(`   rows=${fit.rowsUsed} excludedNaN=${fit.excludedNaN} winners=${fit.winners} losers=${fit.losers}`);
    console.log(`   iterations=${fit.iterations} finalLoss=${fit.finalLoss.toFixed(6)} (L2 lambda=1.0, lr=0.01)`);
    console.log(`   ${MODEL_BIAS_KEY}: ${fit.bias.toFixed(6)}`);
    MODEL_FEATURE_KEYS.forEach((key, i) => {
      console.log(`   ${getLogisticWeightName(key)}: ${fit.weights[i].toFixed(6)} (mean ${fit.means[i].toFixed(4)}, std ${fit.stds[i].toFixed(4)})`);
    });

    // The fitted vector + bias + corpus means/stds go into model_weights_v1
    // under their own names. The six legacy modulation names (rsi_weight,
    // volume_weight, ...) are carried by the LOGISTIC weights themselves (the
    // Item AC spec: "plus the existing 6 names"), so getFeatureModulation and
    // CONSUMED_MODEL_WEIGHTS keep valid targets.
    // NOTE: the E25 drift auto-halver was REMOVED by Item BE (compounding
    // weight destruction while drift stayed HIGH) — nothing modifies a fitted
    // weight between retrains any more.
    this.modelWeights.clear();
    MODEL_FEATURE_KEYS.forEach((key, i) => {
      this.modelWeights.set(getLogisticWeightName(key), fit.weights[i]);
      this.modelWeights.set(meanKeyName(key), fit.means[i]);
      this.modelWeights.set(stdKeyName(key), fit.stds[i]);
    });
    this.modelWeights.set(MODEL_BIAS_KEY, fit.bias);
    this.logisticModel = {
      weights: [...fit.weights],
      bias: fit.bias,
      means: [...fit.means],
      stds: [...fit.stds],
    };

    // ITEM BE: clear the elevated threshold immediately after a successful
    // retrain so the system returns to the normal 68% floor. Without this,
    // driftAlertLevel stays HIGH until the next detectConceptDrift cycle
    // (hours later), blocking emissions the whole time.
    // SUCCESS-ONLY by construction: every failure guard above (Item AA filter
    // <10 rows, AC corpus <30, class diversity, AF rowsUsed <30, AC
    // non-convergence) returns early — control only reaches this point with a
    // converged fit that was actually written into modelWeights/logisticModel.
    this.driftAlertLevel = 'NONE';
    this.conceptDriftScore = 0;

    console.log('   Final Vector (Item AC logistic: 13 weights + bias + means + stds):');
    let verificationSum = 0;
    this.modelWeights.forEach((value, key) => {
      console.log(`      ${key}: ${value.toFixed(6)}`);
      verificationSum += Math.abs(value);
    });
    console.log(`   Verification Sum (|entries| total, not necessarily 1.0): ${verificationSum.toFixed(4)}`);

    this.lastTrainingTime = Date.now();

    console.log('\n' + '='.repeat(80));
    console.log('✅✅✅ MODEL RETRAINED (Item AC logistic regression) ✅✅✅');
    console.log('='.repeat(80));
    console.log(`   Training Time: ${new Date(this.lastTrainingTime).toISOString()}`);
    console.log(`   Retraining Triggers: 48-Hour Schedule + Confidence Degradation + Drift Detection`);
    console.log(`   Scorer: L2 logistic regression, 13 features (lambda=1.0, lr=0.01, ${fit.iterations} iterations)`);
    console.log(`   Final loss: ${fit.finalLoss.toFixed(6)} | bias: ${fit.bias.toFixed(6)}`);
    console.log(`   Vector entries: ${this.modelWeights.size} (13 weights + model_bias + 13 means + 13 stds)`);
    console.log(`   Training Data Size: ${filteredTrainingData.length} outcomes (after Item AA filter; raw corpus ${corpusFilter.total})`);
    console.log(`   Fit rows: ${fit.rowsUsed} (NaN-excluded ${fit.excludedNaN}) | Wins: ${fit.winners}, Losses: ${fit.losers}`);
    console.log('='.repeat(80) + '\n');
    
    // ITEM 12 / 11(b): record HOW MANY outcomes these weights were trained on, and
    // how many durable-corpus reads had come back UNAVAILABLE by then. Without
    // both numbers a weight vector's provenance is unrecoverable - weights trained
    // on the full corpus are indistinguishable from weights trained on a truncated
    // one after a failed hydrate.
    this.corpusSizeAtTraining = fit.rowsUsed;
    this.hydrateUnavailableAtTraining = getLearningCorpusStats().hydrateUnavailableCount;
    const persistData = {
      weights: Array.from(this.modelWeights.entries()),
      lastTrainingTime: this.lastTrainingTime,
      corpusSizeAtTraining: this.corpusSizeAtTraining,
      hydrateUnavailableAtTraining: this.hydrateUnavailableAtTraining,
      // ITEM AA — corpus-cleanup provenance so the diagnostics export can show
      // exactly what the vector was fitted on (and what was excluded).
      corpusTotal: corpusFilter.total,
      corpusExcludedReconstruction: corpusFilter.excludedReconstruction,
      // ITEM AE — exclusion sub-counts: explicit featuresSource marker vs the
      // defaulted-feature fingerprint (unmarked pre-marker reconstruction rows).
      corpusExcludedReconstructionMarked: corpusFilter.excludedReconstructionMarked,
      corpusExcludedReconstructionFingerprint: corpusFilter.excludedReconstructionFingerprint,
      corpusUsedForTraining: filteredTrainingData.length,
      // ITEM AC — architecture + fit provenance.
      architecture: 'logistic_regression_v1',
      fitIterations: fit.iterations,
      fitFinalLoss: fit.finalLoss,
      fitRowsUsed: fit.rowsUsed,
      fitExcludedNaN: fit.excludedNaN,
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
          // ITEM 82 / B2: was `{ limit: 300, ... }`. That 300 — not a PostgREST cap
          // — is what held the corpus pull to one page and starved the learner of
          // ~100 resolved outcomes. See CORPUS_PULL_LIMIT above.
          const hydration = await hydrateLearningStoreFromRemote({ limit: CORPUS_PULL_LIMIT, cap: MAX_STORED_OUTCOMES });
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
        // ITEM AC — restore the fitted logistic model (13 weights + bias +
        // means/stds). Null on a pre-AC vector: modelProbability stays unset
        // until the next retrain fits under the AC architecture.
        this.logisticModel = parsePersistedLogisticModel(weightsObj);
        if (this.logisticModel) {
          console.log('✓ ITEM AC logistic model restored from model_weights_v1 (13 weights + bias + means/stds)');
        }
        if (weightsObj.lastTrainingTime && weightsObj.lastTrainingTime > 0) {
          this.lastTrainingTime = weightsObj.lastTrainingTime;
          const daysSince = (Date.now() - this.lastTrainingTime) / (24 * 60 * 60 * 1000);
          console.log(`✓ Loaded model weights and training time from storage: ${new Date(this.lastTrainingTime).toISOString()} (${daysSince.toFixed(1)} days ago)`);
          
          const shouldRetrain = daysSince > 2;
          if (shouldRetrain) {
            console.log(`⚠️ Model is ${daysSince.toFixed(1)} days old - retrain scheduled for next low-liquidity window`);
            this.retrainScheduled = true;
            this.retrainScheduledAtMs = Date.now();
            this.retrainScheduledReason = 'Stored model was > 2 days old when weights loaded';
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
    this.recordFunnelAttempt();
    this.recentAttemptTimestamps.push(now);
    this.getRecentAttemptCount(now);
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 SIGNAL GENERATION ATTEMPT #${this.signalGenerationAttempts}`);
    console.log(`${'='.repeat(80)}`);
    
    // UU — MARKET GATE (containment fix). Previously this path rejected ONLY
    // the daily-close break (isWithinDailyMarketClose), while the weekend-aware
    // predicate (getGoldMarketClock.isMarketOpen, :1136) was consumed only by
    // the dashboard label (getMarketOutlook) and the price-feed gate. A BUY was
    // emitted into the closed weekend market of 2026-08-29/30 through exactly
    // this gap (backgroundTaskService.ts:142 calls generateSignal with no
    // market gate of its own). Both consumers now share ONE predicate —
    // getGoldMarketClock / isGoldMarketOpen (:1128-:1147). NO second
    // session/hours calculation exists anywhere.
    let marketClock: GoldMarketClock;
    try {
      marketClock = getGoldMarketClock();
      if (typeof marketClock?.isMarketOpen !== "boolean") {
        throw new Error(`non-boolean isMarketOpen: ${String(marketClock?.isMarketOpen)}`);
      }
    } catch (gateErr) {
      // UU.3 FAIL-SAFE: an unknown market state must NEVER emit a trade. This
      // is deliberately the OPPOSITE of the price path's fail-safe (which
      // defaults to fetching): when the clock throws or returns a non-boolean,
      // the engine STANDS ASIDE and emits nothing. DEFAULT = REJECT.
      this.marketGateRejections.failSafe++;
      this.recordFunnelRejection('MARKET_GATE_FAILSAFE');
      console.log(`❌ REJECTED: MARKET_GATE_FAILSAFE — market clock threw or returned a non-boolean (${gateErr instanceof Error ? gateErr.message : String(gateErr)}). Default: STAND-ASIDE (reject). No signal is emitted while the market state is unknown.`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    if (!marketClock.isMarketOpen) {
      const closedAs = marketClock.isSaturday
        ? "SATURDAY"
        : marketClock.isFridayClose
          ? "FRIDAY_CLOSE"
          : marketClock.isSundayBeforeOpen
            ? "SUNDAY_BEFORE_OPEN"
            : "DAILY_BREAK";
      this.marketGateRejections[closedAs === "SATURDAY" ? "saturday" : closedAs === "FRIDAY_CLOSE" ? "fridayClose" : closedAs === "SUNDAY_BEFORE_OPEN" ? "sundayBeforeOpen" : "dailyBreak"]++;
      this.recordFunnelRejection('MARKET_CLOSED');
      const nowDate = new Date();
      console.log(`❌ REJECTED: MARKET_CLOSED — condition=${closedAs}. Market gate (weekend-aware, shared predicate getGoldMarketClock) blocks all signal generation while the gold market is closed. Current UTC ${nowDate.getUTCHours()}:${String(nowDate.getUTCMinutes()).padStart(2, '0')}`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }

    // D5 / F-13 — RETRAIN DECOUPLING. Under Correction I the app runs 24/5, so
    // retrain conditions 1 (>48h since training) and 3 (process running) hold
    // continuously. The retrain was coupled to recordTradeOutcome(), which only
    // fires after a trade resolves — so with 1 signal in 3 days, no trades
    // resolve and the retrain NEVER fires even during 22:00-07:00 UTC when the
    // app IS running. This check decouples it: if retrainScheduled and we are
    // inside the low-liquidity window, fire the retrain from the generation path.
    // Idempotent — walkForwardOptimization sets retrainScheduled=false.
    if (this.retrainScheduled) {
      const retrainHour = new Date().getUTCHours();
      const retrainLowLiq = retrainHour >= 22 || retrainHour < 7;
      if (retrainLowLiq) {
        console.log(`🔔 D5: EXECUTING SCHEDULED RETRAIN (decoupled from trade resolution, ${retrainHour}:00 UTC)`);
        try {
          await this.walkForwardOptimization('Scheduled Retrain (D5 decoupled from trade resolution)');
          this.retrainScheduled = false;

          this.retrainScheduledAtMs = null;

          this.retrainScheduledReason = null;
        } catch (retrainErr) {
          console.error('D5: Retrain failed (non-blocking, will retry next low-liquidity window):', retrainErr instanceof Error ? retrainErr.message : String(retrainErr));
        }
      }
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
        this.recordFunnelRejection('EARLY_COOLDOWN_DEFER');
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
      this.recordFunnelRejection('NO_VALID_PRICE');
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    
    // ── ITEM 17b: ENTRY-ANCHOR FRESHNESS GUARD ──────────────────────────
    // signal.entryPrice is stamped from this.currentPrice. Before this guard
    // the only freshness notion on that anchor was `now - lastFetchTime`, and
    // lastFetchTime is reset by updateCurrentPrice() even when
    // fetchLiveGoldPrice() REPLAYED a cached/stale quote — so an arbitrarily
    // old anchor reported as fresh. The bar layer has BAR_MAX_AGE_M1_MS
    // (3 min); the entry anchor had no equivalent at all. It does now.
    //
    // On breach: emit NOTHING. No bar close and no second venue is
    // substituted, because either would price the entry off a different
    // instrument than the one the signal claims to trade.
    this.entryAnchorChecks += 1;
    const anchorAgeMs = lastRealPriceObservedAt > 0
      ? Date.now() - lastRealPriceObservedAt
      : Number.POSITIVE_INFINITY;
    const anchorSourceLower = lastPriceSource.toLowerCase();
    const anchorIsReplayed = REPLAYED_PRICE_SOURCE_MARKERS.some(m => anchorSourceLower.includes(m));
    if (anchorAgeMs > ENTRY_ANCHOR_MAX_AGE_MS || anchorIsReplayed) {
      this.entryAnchorStaleRejections += 1;
      this.recordFunnelRejection('ENTRY_ANCHOR_STALE');
      const ageLabel = Number.isFinite(anchorAgeMs) ? `${(anchorAgeMs / 1000).toFixed(1)}s` : 'never observed';
      console.log('❌ REJECTED [EntryAnchorStale]: entry anchor is not a live observation — emitting nothing');
      console.log(`   [EntryAnchorStale] age=${ageLabel} (cap ${(ENTRY_ANCHOR_MAX_AGE_MS / 1000).toFixed(0)}s) | replayed=${anchorIsReplayed} | source="${lastPriceSource}" | lastRealSource="${lastRealPriceSource}"`);
      console.log(`   [EntryAnchorStale] 💡 A stale anchor prices the entry away from the market, so the first target can already be behind price. No bar close or second venue is substituted, by design.`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }

    const features = await this.calculateMarketFeatures();

    // ITEM F1 — STAND ASIDE RATHER THAN SERVE STALE/ABSENT STRUCTURE.
    // The whole directional layer is now sourced from the sealed M5 bar series.
    // If that series was missing, too short or stale at feature-build time then
    // RSI/MACD/EMA/ADX/VWAP/regime/pattern are all null-or-neutral. Scoring on
    // that vector would emit a signal with NO directional evidence behind it,
    // which is strictly worse than the tick inputs we just removed. There is no
    // GC=F / TwelveData / priceHistory fallback on this path by design.
    if (!this.isDirectionalLayerReady()) {
      console.log('❌ REJECTED: directional bar layer unavailable or stale (M5 gold_m1_bars) - standing aside rather than scoring on a null feature vector');
      this.recordFunnelRejection('DIRECTIONAL_BAR_LAYER_UNAVAILABLE');
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }

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
      this.recordFunnelRejection('NON_FINITE_CONFIDENCE');
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
      this.recordFunnelRejection('STAND_ASIDE_BEARISH_HTF_SELL_SUPPRESSED');
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
          // ITEM AG.2 — forward instrumentation (write-only, fire-and-forget): the
          // rejected setup is persisted to shadow_candidates_v1 under the STRICT
          // candidate_name 'DRIFT_VETO_SUPPRESSED' so the "gate or leak" question
          // is answered by forward canonical rows, not by reasoning. See the
          // pre-registered promotion gate on writeCounterTrendShadow below.
          this.writeCounterTrendShadow('DRIFT_VETO_SUPPRESSED', analysis.signalType, analysis.confidence, { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips }, { driftAgainst, driftVetoThreshold, sweepReclaimConfirmed, rsi: features.rsi });
          this.recordFunnelRejection('COUNTER_TREND_DRIFT_VETO');
          return null;
        }
      }
    }
    
    // ── ITEM 28: COUNTER-TREND GATE TELEMETRY (non-scoring record) ──────────
    // Everything below is a READ of values the gate above already produced. It
    // is computed AFTER the veto block, so a vetoed signal never reaches here
    // (it returned null) and the surviving signal carries the exact arithmetic
    // the veto applied to it. `recentDrift` is reused verbatim when the
    // classifier computed it; when the classifier short-circuited (not
    // counter-trend, so `recentDrift` is null by construction) the drift is
    // recomputed by the same pure helper purely so the record is populated for
    // every signal. Nothing here is read by any branch, threshold or sum.
    const counterTrendTelemetry: CounterTrendGateTelemetry = buildCounterTrendGateTelemetry({
      signalType: analysis.signalType,
      htfTrend,
      ltfTrend: ltfTrendForGate,
      counterTrendClassified: isCounterTrendSignal,
      recentDrift: recentDrift !== null ? recentDrift : this.computeRecentDrift(),
      atr: features.atr,
      driftAtrVetoMultiple: COUNTER_TREND_DRIFT_ATR_VETO,
      overrideConfidence: COUNTER_TREND_DRIFT_OVERRIDE_CONFIDENCE,
      confidence: analysis.confidence,
      sweepReclaimConfirmed: features.sessionSweeps.some(s => s.reversalConfirmed),
      spreadPips: this.lastKnownSpreadPips > 0 ? this.lastKnownSpreadPips : null,
    });
    console.log(`🧾 GATE TELEMETRY: counterTrend=${counterTrendTelemetry.counterTrendClassified} htf=${counterTrendTelemetry.htfTrendAtGate} ltf=${counterTrendTelemetry.ltfTrendAtGate} drift=${counterTrendTelemetry.recentDrift ?? 'n/a'} against=${counterTrendTelemetry.driftAgainst ?? 'n/a'} threshold=${counterTrendTelemetry.driftVetoThreshold ?? 'n/a'} predicate=${counterTrendTelemetry.driftVetoPredicateTrue} sweepReclaim=${counterTrendTelemetry.sweepReclaimConfirmed} override=${counterTrendTelemetry.driftVetoOverrideApplied} spread=${counterTrendTelemetry.spreadPipsAtEntry ?? 'none'}`);

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
            // ITEM AG.2 — forward instrumentation, candidate_name 'MID_RSI_SUPPRESSED'
            // (strict equality; counts toward NO existing gate). Write-only.
            this.writeCounterTrendShadow('MID_RSI_SUPPRESSED', analysis.signalType, analysis.confidence, { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips }, { driftAgainst: recentDrift !== null ? (analysis.signalType === 'BUY' ? -recentDrift : recentDrift) : null, driftVetoThreshold: recentDrift !== null ? features.atr * COUNTER_TREND_DRIFT_ATR_VETO : null, sweepReclaimConfirmed: features.sessionSweeps.some(s => s.reversalConfirmed), rsi: features.rsi });
            this.recordFunnelRejection('COUNTER_TREND_MID_RSI_UNCONFIRMED');
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
      this.recordFunnelRejection('BLOCKED_UTC_HOUR');
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
      this.recordFunnelRejection('DYNAMIC_COOLDOWN');
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
      this.recordFunnelRejection('POST_STOP_COOLDOWN');
      return null;
    }

    const macroEvent = this.detectMacroEvents();
    if (this.shouldSuppressMacroEvent(macroEvent)) {
      console.log(`❌ REJECTED: Macro event suppression (${macroEvent?.name})`);
      this.recordFunnelRejection('MACRO_EVENT_SUPPRESSION');
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

    // ITEM 172(b) — the user-configured minConfidence GOVERNS when raised
    // above the enforced default: no starvation relief and no EV relief may
    // drop below an explicitly raised bar (the 69% emission cleared a 90%
    // setting through exactly these reliefs). When the setting is at or below
    // the enforced minimum (the default 0.68), every pre-existing relief path
    // is untouched, bit-for-bit.
    if (settings.minConfidence > ENFORCED_MIN_SIGNAL_CONFIDENCE && effectiveMinConfidence < settings.minConfidence) {
      console.log(`🛡️ USER THRESHOLD GOVERNS (Item 172b): relief floor ${(effectiveMinConfidence * 100).toFixed(0)}% raised back to the configured ${(settings.minConfidence * 100).toFixed(0)}%`);
      effectiveMinConfidence = settings.minConfidence;
    }
    
    if (analysis.confidence < effectiveMinConfidence) {
      console.log(`❌ REJECTED: Confidence ${(analysis.confidence * 100).toFixed(1)}% below threshold ${(effectiveMinConfidence * 100).toFixed(0)}% (EV ${evScore.toFixed(2)}R)`);
      if (this.driftAlertLevel === 'HIGH') {
        console.log(`   ⚠️ Elevated threshold active due to HIGH CONCEPT DRIFT`);
      }
      console.log(`   💡 TIP: Confidence ${(analysis.confidence * 100).toFixed(1)}% below ${(effectiveMinConfidence * 100).toFixed(0)}% threshold. Wait for stronger alignment or adjust threshold in settings.`);
      console.log(`${'='.repeat(80)}\n`);
      this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, `below threshold ${(effectiveMinConfidence * 100).toFixed(0)}%`, { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips });
      this.recordFunnelRejection('CONFIDENCE_BELOW_THRESHOLD');
      return null;
    }
    
    const absoluteConfidenceFloor = starvationReliefActive
      ? ABSOLUTE_MIN_SIGNAL_CONFIDENCE
      : Math.max(ABSOLUTE_MIN_SIGNAL_CONFIDENCE, effectiveMinConfidence - 0.03);

    if (analysis.confidence < absoluteConfidenceFloor) {
      console.log(`❌ REJECTED: Confidence ${(analysis.confidence * 100).toFixed(1)}% below engine floor ${(absoluteConfidenceFloor * 100).toFixed(0)}%`);
      this.recordFunnelRejection('CONFIDENCE_BELOW_ENGINE_FLOOR');
      console.log(`   Engine floor keeps low-quality setups out even if user threshold is lower`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    
    const qualityGate = this.evaluateQualityGate(analysis, features);
    if (!qualityGate.passed) {
      console.log(`❌ REJECTED: Quality Gate — ${qualityGate.reason}`);
      this.recordFunnelRejection('QUALITY_GATE');
      console.log(`   💡 ${qualityGate.tip}`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }

    // ITEM 114/116 — OB PRESENCE FILTER, on the BAR-DERIVED construct.
    // Canonical measurement (n=409): OB-present WR=63.3% EV=+0.0470R vs OB-absent
    // WR=45.5% EV=-0.1951R. z=2.295, p=0.0217. The OB-absent arm (n=44) is
    // adequately powered (>= 30).
    // DATA SOURCE: marketStructure.computeMarketStructure() over the engine's BAR
    // arrays with mitigation tracking — the same FUNCTION and CONSTRUCT the
    // measurement used. NOT this.detectOrderBlocks()/priceHistory (ticks).
    if (OB_FILTER_ENABLED) {
      const obCheck = this.hasNearbyUnmitigatedOB(features.atr);
      if (obCheck.abstained) {
        console.log(`⚪ [OBFilter] ABSTAIN: only ${obCheck.barCount} bars (< ${OB_FILTER_MIN_BARS}) — structure not computable, filter passes rather than rejecting on absent data`);
      } else if (!obCheck.hasOB) {
        if (OB_FILTER_MODE === 'reject') {
          console.log(`❌ REJECTED [OBFilter]: No UNMITIGATED order block within ${OB_PROXIMITY_ATR} ATR of ${this.currentPrice.toFixed(1)} — structural support absent`);
          console.log(`   [OBFilter] source=BARS(n=${obCheck.barCount}) totalOBs=${obCheck.totalOBs} unmitigated=${obCheck.unmitigatedOBs} nearby=0 threshold=${obCheck.threshold.toFixed(2)}`);
          console.log(`${'='.repeat(80)}\n`);
          this.obFilterRejectionCount += 1;
          this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'OB filter: no nearby unmitigated order block (bars)', { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips });
          this.recordFunnelRejection('OB_FILTER_REJECT');
          return null;
        }
        // ITEM 160(c): relaxed — confidence penalty instead of hard reject.
        const penalizedConfidence = analysis.confidence - OB_ABSENT_CONFIDENCE_PENALTY;
        if (penalizedConfidence < absoluteConfidenceFloor) {
          console.log(`❌ REJECTED [OBFilter penalty]: confidence ${(analysis.confidence * 100).toFixed(1)}% − ${OB_ABSENT_CONFIDENCE_PENALTY * 100}pt OB-absent penalty = ${(penalizedConfidence * 100).toFixed(1)}% below floor ${(absoluteConfidenceFloor * 100).toFixed(0)}%`);
          console.log(`${'='.repeat(80)}\n`);
          this.obFilterRejectionCount += 1;
          this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'OB filter penalty: below confidence floor after 5pt penalty', { entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips });
          this.recordFunnelRejection('OB_FILTER_PENALTY_BELOW_FLOOR');
          return null;
        }
        analysis.confidence = penalizedConfidence;
        console.log(`⚠️ [OBFilter] PENALTY (Item 160 relaxation): no nearby unmitigated OB within ${OB_PROXIMITY_ATR} ATR — confidence reduced ${(OB_ABSENT_CONFIDENCE_PENALTY * 100).toFixed(0)}pt to ${(analysis.confidence * 100).toFixed(1)}%; signal still emits`);
      } else {
        console.log(`✅ [OBFilter] PASS: ${obCheck.nearbyOBs} unmitigated OB(s) within ${OB_PROXIMITY_ATR} ATR (source=BARS n=${obCheck.barCount}, total=${obCheck.totalOBs}, unmitigated=${obCheck.unmitigatedOBs})`);
      }
    }
    console.log(`✅ QUALITY GATE PASSED: ${qualityGate.summary}`);

    const structuralValidation = this.validateStructuralConditions(analysis.signalType, features, settings);
    if (!structuralValidation.valid) {
      console.log(`❌ REJECTED: Structural Validation Failed`);
      this.recordFunnelRejection('STRUCTURAL_VALIDATION_FAILED');
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
        this.recordFunnelRejection('PRICE_PROXIMITY_BLOCK');
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
        this.recordFunnelRejection('SIGNAL_CONFLICT_PREVENTION');
        return null;
      } else {
        console.log(`✅ SIGNAL OVERRIDE APPROVED: Conflict check passed`);
        console.log(`   ${this.lastSignalType} -> ${analysis.signalType}`);
        console.log(`   Confidence: ${(analysis.confidence * 100).toFixed(1)}%, Opposing Strength: ${(opposingStrength * 100).toFixed(1)}%`);
        this.resetSignalLock();
      }
    }
    
    let entryPrice = this.currentPrice;
    
    const slippageBuffer = this.calculateDynamicSlippage(features.marketRegime, latency);
    const spreadPips = this.lastKnownSpreadPips > 0 ? this.lastKnownSpreadPips : 0;
    const totalSlippage = slippageBuffer + spreadPips;
    let entryPriceWithSlippage = analysis.signalType === "BUY" 
      ? entryPrice + (totalSlippage * 0.1)
      : entryPrice - (totalSlippage * 0.1);
    if (spreadPips > 0) console.log(`💵 Real bid/ask spread applied: ${spreadPips.toFixed(2)} pips`);

    // ITEM 196(d) — asymmetric entry buffer. Applied to entryPriceWithSlippage
    // BEFORE the ladder is derived from it (signalEngine.ts:8882-8885), so TP1/
    // TP2/TP3/SL all shift by the same delta and the R-geometry is unchanged.
    // OFF (default) = bit-for-bit identical entry. The status monitor marks a
    // never-filled band entry EXPIRED_MISSED_ENTRY — a miss forgoes EV, never
    // books a loss.
    if (ENTRY_BUFFER_ENABLED) {
      const bufferPrice = ENTRY_BUFFER_PIPS * 0.1;
      entryPriceWithSlippage = analysis.signalType === 'BUY'
        ? entryPriceWithSlippage - bufferPrice
        : entryPriceWithSlippage + bufferPrice;
      console.log(`🎯 [Item196d] Entry buffer ${ENTRY_BUFFER_PIPS}p applied: entry now ${entryPriceWithSlippage.toFixed(1)} (band entry — ladder shifts with it; unfilled = EXPIRED_MISSED_ENTRY)`);
    }
    
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
    // ITEM 131(b): THE CEILING NOW CLAMPS INSTEAD OF REJECTING.
    //
    // This block previously did `return null` whenever a 1.2 x ATR stop would not
    // fit inside maxSLPips — an uncounted emission suppressor. The user's stated
    // requirement is that the system IDENTIFY the ceiling, not that it drop the
    // trade at it: "SL range can be anywhere, it just needs a ceiling, and it's
    // also changeable in settings — but the system needs to be able to identify
    // it." The widen-and-cap below (rawSlPips -> Math.min(rawSlPips, maxSLPips))
    // already produced the correct clamped stop; the reject simply pre-empted it.
    //
    // MEASURED before shipping (expo/scripts/item131_133_measure.ts, 59,556 bar
    // ATR samples over the 2026-06-18 -> 2026-08-18 tape, engine's own
    // calculateRealATR(14) construct):
    //   cap  70 -> ATR > 5.83 -> 377/59556 =  0.63% of tape minutes
    //   cap  90 -> ATR > 7.50 -> 107/59556 =  0.18% of tape minutes  <-- live cap
    //   cap 110 -> ATR > 9.17 ->  38/59556 =  0.06%
    // On the 13 LIVE-sourced signals the stored ATR maxes at 2.60 (atrFloor 31
    // pips), so this gate has never bound on a live signal. It is a RARE
    // suppressor, not a major one — but a rare uncounted drop is still a drop,
    // and clamping is strictly safer than discarding a qualified setup.
    //
    // CEILING-BIND TELEMETRY: counted below and surfaced via getSLCeilingStats()
    // so the bind is identifiable in telemetry rather than inferred.
    const slCeilingBinds = atrFloorSlPips > maxSLPips;
    if (slCeilingBinds) {
      this.slCeilingBindCount += 1;
      this.lastSLCeilingBind = { atr: features.atr, atrFloorSlPips, maxSLPips, at: Date.now() };
      console.log(`🔒 SL CEILING BINDS: a ${MIN_SL_ATR_MULTIPLE} x ATR stop needs ${atrFloorSlPips.toFixed(0)} pips but maxSLPips is ${maxSLPips} (ATR ${features.atr.toFixed(1)}). CLAMPING to ${maxSLPips} and PROCEEDING (Item 131 — was a hard reject).`);
      console.log(`   ⚠️ The realised stop is now TIGHTER than the ${MIN_SL_ATR_MULTIPLE} x ATR noise floor, so this signal carries a higher noise-stop-out risk. Raise Max SL Cap in Settings to give it the full noise-floor clearance.`);
    }
    this.slCeilingEvaluationCount += 1;
    const configuredSlPips = settings.slPips * atrMultiplier;
    const rawSlPips = Math.max(configuredSlPips, atrFloorSlPips);
    if (atrFloorSlPips > configuredSlPips) {
      console.log(`🛡️ SL widened to the ${MIN_SL_ATR_MULTIPLE} x ATR noise floor: ${atrFloorSlPips.toFixed(1)} pips (configured would have been ${configuredSlPips.toFixed(1)})`);
    }
    // ITEM 131(b): this IS the clamp — dynamicSlPips = min(max(configured, atrFloor), maxSLPips).
    // NOT neutralised: maxSLPips is read straight from settings (default 90) and
    // Math.min is the only operation applied, so the ceiling always binds when it
    // should. There is no second floor downstream that could re-widen the stop.
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
    const riskJustification = `SL ${dynamicSlPips.toFixed(0)}p (${slAtrMultiple.toFixed(2)}x ATR) | Multiplier: ${atrMultiplier.toFixed(2)}x (${volatilityLabel} | ATR: ${features.atr.toFixed(1)}) | user-pips TP ladder (${settings.tp1Pips}/${settings.tp2Pips}/${settings.tp3Pips}p)`;

    // ITEM 109: TP ladder uses the USER'S configured pip settings directly.
    // settings.tp1Pips/tp2Pips/tp3Pips are now the actual TP distances, not
    // R-multiples of the SL. The R-multiples are computed for display only.
    const roomToSR = this.computeRoomToSR(analysis.signalType, features);
    const atrUnits = roomToSR / Math.max(features.atr, 1);
    const tp1Distance = settings.tp1Pips;
    const tp2Distance = settings.tp2Pips;
    const tp3Distance = settings.tp3Pips;
    const tp1R = tp1Distance / dynamicSlPips;
    const tp2R = tp2Distance / dynamicSlPips;
    const tp3R = tp3Distance / dynamicSlPips;
    const grossTp3Dollars = tp3Distance * pipValue;
    console.log(`🎯 USER-PIPS LADDER: TP1 ${tp1Distance}p (${tp1R.toFixed(2)}R) | TP2 ${tp2Distance}p (${tp2R.toFixed(2)}R) | TP3 ${tp3Distance}p (${tp3R.toFixed(2)}R) | SL ${dynamicSlPips.toFixed(1)}p`);
    console.log(`   room-to-SR ${roomToSR.toFixed(0)}p / ATR ${atrUnits.toFixed(1)}u`);
    // ITEM 82 / B6: the R conversion now goes through the shared costInR() helper
    // rather than re-deriving the division inline, so this print and any book
    // computation can never disagree about what a $0.20 round trip costs in R.
    const riskUsdForCost = Math.max(dynamicSlPips * pipValue, 0.01);
    const costR = costInR(riskUsdForCost);
    console.log(`💵 Cost-adjusted TP3: gross $${grossTp3Dollars.toFixed(2)} − $${EXECUTION_COST_PER_TRADE_USD.toFixed(2)} spread = net $${(grossTp3Dollars - EXECUTION_COST_PER_TRADE_USD).toFixed(2)} (${((grossTp3Dollars - EXECUTION_COST_PER_TRADE_USD) / riskUsdForCost).toFixed(2)}R net) | cost burden ${costR.toFixed(4)}R per trade at $${EXECUTION_COST_PER_TRADE_USD.toFixed(2)}`);
    
    let tp1 = entryPriceWithSlippage + (analysis.signalType === "BUY" ? 1 : -1) * tp1Distance * pipValue;
    let tp2 = entryPriceWithSlippage + (analysis.signalType === "BUY" ? 1 : -1) * tp2Distance * pipValue;
    let tp3 = entryPriceWithSlippage + (analysis.signalType === "BUY" ? 1 : -1) * tp3Distance * pipValue;
    let sl = entryPriceWithSlippage - (analysis.signalType === "BUY" ? 1 : -1) * dynamicSlPips * pipValue;
    
    const sortedAttention = Array.from(analysis.attentionScores.entries())
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3);
    
    // ITEM 29: `feature` and `score` are produced by the SAME expressions as
    // before (display name, absolute magnitude x100) so no UI or parser changes
    // meaning. `signedScore` / `side` / `opposesSignal` are additive fields that
    // finally make a penalty distinguishable from a bonus, and a bullish entry
    // riding on a SELL visible as opposing rather than as supporting evidence.
    // The side comes from `attentionSides` (recorded at the call site by the
    // accumulator) and falls back to the static table only for entries written
    // straight into the attention map.
    const resolveSide = (rawKey: string): AttentionSide =>
      analysis.attentionSides.get(rawKey) ?? attentionSideForKey(rawKey);
    const topFeatures: FeatureConfidence[] = sortedAttention.map(([feature, score]) => ({
      feature: feature.replace(/_/g, ' ').toUpperCase(),
      score: parseFloat((Math.abs(score) * 100).toFixed(1)),
      signedScore: parseFloat((score * 100).toFixed(1)),
      side: resolveSide(feature),
      opposesSignal: attentionOpposesSignal(resolveSide(feature), analysis.signalType),
    }));

    // Part B (diagnostics): capture EVERY entry in attentionScores, not just
    // the top 3 above. Purely additive - topFeatures/UI display is unchanged.
    const fullAttentionScores: FeatureConfidence[] = Array.from(analysis.attentionScores.entries())
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([feature, score]) => ({
        feature: feature.replace(/_/g, ' ').toUpperCase(),
        score: parseFloat((Math.abs(score) * 100).toFixed(1)),
        signedScore: parseFloat((score * 100).toFixed(1)),
        side: resolveSide(feature),
        opposesSignal: attentionOpposesSignal(resolveSide(feature), analysis.signalType),
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
      // ITEM 191: directed-typing evidence on every snapshot — legacyType plus
      // both directional rejection counts — so forward evidence accumulates
      // on the LIVE system while the flag is OFF.
      legacyType: zone.legacyType ?? zone.type,
      rejectionsFromBelow: zone.rejectionsFromBelow ?? 0,
      rejectionsFromAbove: zone.rejectionsFromAbove ?? 0,
      // ITEM 200(d) — entry-backing annotation: this zone's distance from the
      // entry in ATR units. Together with zone.price, the emitted row's entry
      // and stored atr, BOTH entry-backing splits (nearest opposing zone
      // AHEAD of the entry in the direction of risk, and nearest opposing
      // zone BEHIND the entry — the 4601 shape) are directly re-derivable
      // under BOTH typings from the snapshot alone, so the forward
      // measurement never depends on reconstructing engine state.
      // Underpowered must not mean nothing ships: the 200(b/c) splits found
      // no CI separation (buckets n=1..59, MDE ±20-35pp), so the ANNOTATION
      // is the ship; a flagged entry-backing check waits for forward evidence.
      distFromEntryAtr: parseFloat((Math.abs(zone.price - entryPriceWithSlippage) / Math.max(features.atr, 0.01)).toFixed(2)),
      // ITEM 212 — merged cluster strength/entry-edge prices. If the zone was built
      // by the merge logic, these carry the combined cluster's price and outer edge.
      strengthPrice: zone.strengthPrice,
      entryEdgePrice: zone.entryEdgePrice,
    }));

    // ITEM 210 / 213 — signal-level entry-backing + driving-zone-touch annotations.
    // Computed purely from the snapshot, so they are durable even if the engine state resets.
    const atr = features.atr || 0.01;
    const opposingType = analysis.signalType === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    // Nearest opposing zone BEHIND the entry (BUY: resistance below entry; SELL: support above entry).
    const behindZones = srZonesSnapshot.filter(z => z.type === opposingType && ((analysis.signalType === 'BUY' && z.price < entryPriceWithSlippage) || (analysis.signalType === 'SELL' && z.price > entryPriceWithSlippage)));
    const nearestBehind = behindZones.length > 0
      ? behindZones.sort((a, b) => Math.abs(a.price - entryPriceWithSlippage) - Math.abs(b.price - entryPriceWithSlippage))[0]
      : null;
    // Driving zone: nearest opposing zone AHEAD of entry (used by the path-to-target gate).
    const aheadZones = srZonesSnapshot.filter(z => z.type === opposingType && ((analysis.signalType === 'BUY' && z.price > entryPriceWithSlippage) || (analysis.signalType === 'SELL' && z.price < entryPriceWithSlippage)));
    const drivingZone = aheadZones.length > 0
      ? aheadZones.sort((a, b) => Math.abs(a.price - entryPriceWithSlippage) - Math.abs(b.price - entryPriceWithSlippage))[0]
      : null;
    const nearestOppZoneBehindEntryPrice = nearestBehind ? nearestBehind.price : null;
    const nearestOppZoneBehindEntryType = nearestBehind ? nearestBehind.type : null;
    const nearestOppZoneBehindEntryDistAtr = nearestBehind ? parseFloat((Math.abs(nearestBehind.price - entryPriceWithSlippage) / atr).toFixed(2)) : null;
    const drivingZoneTouches = drivingZone ? drivingZone.touches : null;
    
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
      this.recordFunnelRejection('SELL_SUPPRESSED_SHADOW');
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

    // B2(c): TIER_0 degradation policy. If this pass fell back to TIER_1_LOCAL
    // micro-zones AND the dominant feature is a zone feature, the signal's main
    // reason to exist is ~100 minutes of un-evidenced micro-structure - suppress
    // it. Otherwise apply a confidence penalty. Both outcomes are counted and
    // logged with the greppable [SRZoneTier0] tag.
    const tier0Degradation = this.evaluateTier0Degradation(
      topFeatures.length > 0 ? topFeatures[0].feature : null,
      features.srZones,
    );
    if (tier0Degradation.suppress) {
      this.recordFunnelRejection('TIER0_DEGRADATION_SUPPRESS');
      return null;
    }
    const tier0AdjustedConfidence = parseFloat(
      (analysis.confidence * tier0Degradation.confidenceMultiplier).toFixed(4),
    );

    // ── ITEM 17c: UNCONDITIONAL GEOMETRY SANITY GATE ────────────────────
    // A signal whose FIRST target is already behind the market is unwinnable
    // as specified: it can only be filled worse than its own TP1, so the
    // designed R:R cannot be realised no matter what price does next.
    // Checked against the freshest live price at EMISSION time (ticks do
    // arrive during the awaits above), NOT against a bar close.
    //
    // Deliberately unconditional — no setting disables it, because there is no
    // configuration under which emitting an unwinnable ladder is correct.
    this.geometrySanityChecks += 1;
    const emissionPrice = this.currentPrice;
    const tp1AlreadyBehind = analysis.signalType === 'BUY'
      ? emissionPrice >= tp1
      : emissionPrice <= tp1;
    if (tp1AlreadyBehind) {
      this.geometryUnwinnableRejections += 1;
      this.recordFunnelRejection('GEOMETRY_UNWINNABLE');
      console.log('❌ REJECTED [GeometryUnwinnable]: TP1 is already behind the live price — emitting nothing');
      console.log(`   [GeometryUnwinnable] ${analysis.signalType} anchor=${entryPrice.toFixed(2)} livePrice=${emissionPrice.toFixed(2)} TP1=${tp1.toFixed(2)} SL=${sl.toFixed(2)} | drift since anchor $${(emissionPrice - entryPrice).toFixed(2)}`);
      console.log(`   [GeometryUnwinnable] 💡 Measured on 379 historical signals: 11 (2.90%) were already at/past TP1 at their own generation minute, and 7 of those were nonetheless stored ALL_TARGETS_HIT.`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }

    // ── ITEM 96/104: PATH-TO-TARGET VETO + AWAIT-THE-ZONE ──────────────
    // A SELL with a SUPPORT between entry and TP1, or a BUY with a RESISTANCE
    // between entry and TP1, is path-blocked. Canonical split (n=171):
    //   path-blocked n=20 WR=30.0% EV=-0.3713R
    //   path-clear  n=151 WR=55.0% EV=-0.0149R
    // Hard veto WINS on canonical EV (Item 106: -0.0149R vs graded -0.0348R
    // vs no-gate -0.0565R).
    //
    // ITEM 104 — AWAIT-THE-ZONE: instead of vetoing a directionally-correct
    // but path-blocked signal, attempt to MOVE the entry to the strongest
    // same-side zone within a derived band. If moving the entry clears the
    // path, arm a PENDING entry at that zone instead of vetoing.
    // The path-to-target check is re-evaluated AT THE MOVED ENTRY PRICE.
    //
    // ITEM 137 — CONFIRMED: await-the-zone is ONLY reachable from inside the
    // `if (blockingZone)` block below. A path-clear signal never enters this
    // branch, so a poor-but-path-clear entry has no mechanism to be improved.
    // ITEM 137(b) MEASURED whether that matters: Near (<1.5 ATR to nearest
    // same-side zone) n=79 WR=40.5% EV=-0.2125R vs Far (>=1.5 ATR) n=41
    // WR=53.7% EV=+0.0303R. The far bucket is BETTER, not worse — the gate
    // FAILS. ENTRY_QUALITY_TRIGGER_ENABLED is false. Forward evidence that
    // would flip it: a regime-conditioned split where the far bucket degrades
    // in TRENDING markets specifically.
    if (PATH_TO_TARGET_VETO_ENABLED) {
      this.pathToTargetChecks += 1;
      const opposingType = analysis.signalType === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
      const sameSideType = analysis.signalType === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
      const tp1Price = tp1;
      const minP = Math.min(entryPriceWithSlippage, tp1Price);
      const maxP = Math.max(entryPriceWithSlippage, tp1Price);
      const blockingZone = features.srZones.find(z =>
        z.type === opposingType &&
        z.price > minP + 0.01 &&
        z.price < maxP - 0.01 &&
        z.reactionStrength >= 0.3,
      );
      if (blockingZone) {
        // ITEM 104 — AWAIT-THE-ZONE: find the strongest same-side zone within
        // a derived proximity band (3 ATR). The strongest = highest reactionStrength.
        // Derived from the canonical population: the user's 5 failed BUYs would
        // have TP1'd at SUPPORT 4393.1 (t=966, r=97%), which was $6-7 below entry.
        // At ATR ~2-3, that's 2-3 ATR — so 3 ATR is the derived band.
        const awaitZoneBandAtr = 3.0;
        const sameSideZones = features.srZones
          .filter(z => z.type === sameSideType && z.reactionStrength >= 0.3)
          .filter(z => {
            // Must be on the correct side of current price for the direction
            const dist = Math.abs(z.price - this.currentPrice);
            const distAtr = dist / Math.max(features.atr, 0.01);
            return distAtr <= awaitZoneBandAtr && distAtr > 0.1;
          })
          .sort((a, b) => b.reactionStrength - a.reactionStrength);

        if (sameSideZones.length > 0) {
          const targetZone = sameSideZones[0];
          // Re-derive the ladder from the target zone price.
          // The R-based ladder shifts by the same delta as the entry: if entry
          // moves down by $5, TP1/TP2/TP3/SL all shift down by $5 too.
          const movedEntry = targetZone.price;
          const moveDelta = movedEntry - entryPriceWithSlippage;
          const movedTP1 = tp1Price + moveDelta;
          // Re-check path-to-target at the MOVED entry and MOVED TP1
          const movedMinP = Math.min(movedEntry, movedTP1);
          const movedMaxP = Math.max(movedEntry, movedTP1);
          const stillBlocked = features.srZones.find(z =>
            z.type === opposingType &&
            z.price > movedMinP + 0.01 &&
            z.price < movedMaxP - 0.01 &&
            z.reactionStrength >= 0.3,
          );
          if (!stillBlocked) {
            // Path is CLEAR at the moved entry — arm a pending entry
            this.awaitZoneArmed += 1;
            const clusterId = `${analysis.signalType}_${movedEntry.toFixed(1)}`;
            const pendingTimeoutMs = 4 * 60 * 60 * 1000; // 4h expiry
            // Check for existing pending entry in this cluster
            const existing = this.pendingZoneEntries.get(clusterId);
            if (!existing) {
              this.pendingZoneEntries.set(clusterId, {
                direction: analysis.signalType,
                zonePrice: movedEntry,
                zoneClusterId: clusterId,
                armedAt: now,
                expiresAt: now + pendingTimeoutMs,
                signalParams: {
                  confidence: tier0AdjustedConfidence,
                  tp1, tp2, tp3, sl,
                  originalEntry: entryPriceWithSlippage,
                  slMultiplier: atrMultiplier,
                  atr: features.atr,
                  regime: features.marketRegime.type,
                  rsi: features.rsi,
                  topFeatures,
                },
              });
              console.log(`⏳ [AwaitTheZone] ARMED pending ${analysis.signalType} at ${sameSideType} ${movedEntry.toFixed(1)} (reaction ${(targetZone.reactionStrength * 100).toFixed(0)}%, touches=${targetZone.touches}) — path clears at moved entry`);
              console.log(`   [AwaitTheZone] original entry=${entryPriceWithSlippage.toFixed(1)} → moved=${movedEntry.toFixed(1)} (${Math.abs(movedEntry - entryPriceWithSlippage).toFixed(1)} $ = ${(Math.abs(movedEntry - entryPriceWithSlippage) / Math.max(features.atr, 0.01)).toFixed(2)} ATR)`);
            }
            // Do NOT emit at current price — return null (the pending entry
            // converts to a live signal when price reaches the zone)
            this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'await-the-zone: pending entry armed at strong zone', {
              entryPrice: movedEntry, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips,
            });
            this.recordFunnelRejection('AWAIT_ZONE_ARMED');
            return null;
          }
        }
        // Path still blocked at the moved entry, or no same-side zone found → VETO
        this.pathToTargetVetoes += 1;
        this.recordFunnelRejection('PATH_TO_TARGET_VETO');
        console.log(`❌ REJECTED [PathToTargetVeto]: ${analysis.signalType} TP1 ${tp1Price.toFixed(1)} blocked by ${opposingType} @ ${blockingZone.price.toFixed(1)} (reaction ${(blockingZone.reactionStrength * 100).toFixed(0)}%)`);
        console.log(`   [PathToTargetVeto] entry=${entryPriceWithSlippage.toFixed(1)} TP1=${tp1Price.toFixed(1)} ${opposingType}@${blockingZone.price.toFixed(1)} — no await-the-zone escape possible`);
        console.log(`${'='.repeat(80)}\n`);
        this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'path-to-target veto: opposing zone between entry and TP1', {
          entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips,
        });
        return null;
      }
      // ITEM 192 — AN EMPTY OPPOSING SET IS NOT A CLEAR PATH. The blocking-zone
      // search above found nothing: EITHER the path is genuinely clear, OR the
      // map simply contains no opposing zones at all — opposite epistemic
      // states that the shipped code treated identically. All three documented
      // top-buys (4601, 4565, 4438.6) were zero-opposing maps: the veto branch
      // was unreachable and await-the-zone could never arm. Behind the flag
      // until the 192(d) gate closes (n>=30/arm on the zero-opposing arm).
      else if (NO_STRUCTURE_VETO_ENABLED) {
        const opposingZones = features.srZones.filter(z => z.type === opposingType);
        if (opposingZones.length === 0) {
          const awaitZoneBandAtr = 3.0;
          const sameSideZones = features.srZones
            .filter(z => z.type === sameSideType && z.reactionStrength >= 0.3)
            .filter(z => {
              const dist = Math.abs(z.price - this.currentPrice);
              const distAtr = dist / Math.max(features.atr, 0.01);
              return distAtr <= awaitZoneBandAtr && distAtr > 0.1;
            })
            .sort((a, b) => b.reactionStrength - a.reactionStrength);
          if (sameSideZones.length > 0) {
            const targetZone = sameSideZones[0];
            const movedEntry = targetZone.price;
            const moveDelta = movedEntry - entryPriceWithSlippage;
            // ITEM 193(b): await-the-zone ARMED from the no-structure branch,
            // independently of the veto branch. No moved-entry path re-check is
            // needed: the opposing set is empty by this branch's condition, so
            // nothing can block the moved path.
            this.awaitZoneArmed += 1;
            this.noStructureRoutes += 1;
            const clusterId = `${analysis.signalType}_${movedEntry.toFixed(1)}`;
            const pendingTimeoutMs = 4 * 60 * 60 * 1000; // 4h expiry
            const existing = this.pendingZoneEntries.get(clusterId);
            if (!existing) {
              this.pendingZoneEntries.set(clusterId, {
                direction: analysis.signalType,
                zonePrice: movedEntry,
                zoneClusterId: clusterId,
                armedAt: now,
                expiresAt: now + pendingTimeoutMs,
                signalParams: {
                  confidence: tier0AdjustedConfidence,
                  tp1, tp2, tp3, sl,
                  originalEntry: entryPriceWithSlippage,
                  slMultiplier: atrMultiplier,
                  atr: features.atr,
                  regime: features.marketRegime.type,
                  rsi: features.rsi,
                  topFeatures,
                },
              });
              console.log(`⏳ [AwaitTheZone/192] ARMED pending ${analysis.signalType} at ${sameSideType} ${movedEntry.toFixed(1)} (reaction ${(targetZone.reactionStrength * 100).toFixed(0)}%, touches=${targetZone.touches}) — ZERO ${opposingType} zones in the map; routed to the shelf instead of emitting at market`);
              console.log(`   [AwaitTheZone/192] original entry=${entryPriceWithSlippage.toFixed(1)} → moved=${movedEntry.toFixed(1)} (${Math.abs(movedEntry - entryPriceWithSlippage).toFixed(1)} $ = ${(Math.abs(movedEntry - entryPriceWithSlippage) / Math.max(features.atr, 0.01)).toFixed(2)} ATR)`);
            }
            // Do NOT emit at current price — the pending entry converts to a
            // live signal when price reaches the zone (Item 104 conversion loop).
            this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'no-structure route: zero opposing zones -> await-the-zone at nearest same-side shelf', {
              entryPrice: movedEntry, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips,
            });
            this.recordFunnelRejection('AWAIT_ZONE_ARMED_NO_STRUCTURE');
            return null;
          }
          // No same-side shelf within the 3 ATR band either: NO structure
          // anywhere near price. Veto outright — do not emit into an
          // information vacuum.
          this.noStructureVetoes += 1;
          this.recordFunnelRejection('NO_STRUCTURE_VETO');
          console.log(`❌ REJECTED [NoStructureVeto]: ${analysis.signalType} at ${entryPriceWithSlippage.toFixed(1)} — ZERO ${opposingType} zones in the map and no ${sameSideType} shelf within 3 ATR. An empty opposing set is absence of information, not a clear path.`);
          console.log(`${'='.repeat(80)}\n`);
          this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'no-structure veto: zero opposing zones and no same-side shelf within 3 ATR', {
            entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips,
          });
          return null;
        }
      }
    }

    // ── PHASE C / C2 — BEHIND-ENTRY ARMING (ships OFF; see flag comment for gate) ──
    if (BEHIND_ENTRY_ARMING_ENABLED) {
      const c2OppType = analysis.signalType === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
      const c2SameType = analysis.signalType === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
      const behindZones = features.srZones
        .filter(z => z.type === c2OppType && ((analysis.signalType === 'BUY' && z.price < entryPriceWithSlippage) || (analysis.signalType === 'SELL' && z.price > entryPriceWithSlippage)))
        .sort((a, b) => Math.abs(a.price - entryPriceWithSlippage) - Math.abs(b.price - entryPriceWithSlippage));
      const nearestBehind = behindZones[0];
      const behindDistAtr = nearestBehind
        ? Math.abs(nearestBehind.price - entryPriceWithSlippage) / Math.max(features.atr, 0.01)
        : Infinity;
      const c2Shelf = features.srZones
        .filter(z => z.type === c2SameType && z.reactionStrength >= 0.3)
        .filter(z => {
          const d = Math.abs(z.price - entryPriceWithSlippage) / Math.max(features.atr, 0.01);
          return d <= 3.0 && d > 0.1;
        })
        .sort((a, b) => b.reactionStrength - a.reactionStrength);
      if (nearestBehind && behindDistAtr <= BEHIND_ENTRY_ARMING_MAX_ATR && c2Shelf.length > 0) {
        const targetZone = c2Shelf[0];
        const movedEntry = targetZone.price;
        this.behindEntryArmed += 1;
        const clusterId = `${analysis.signalType}_${movedEntry.toFixed(1)}`;
        const pendingTimeoutMs = 4 * 60 * 60 * 1000; // 4h expiry — same as the other arming routes
        const existing = this.pendingZoneEntries.get(clusterId);
        if (!existing) {
          this.pendingZoneEntries.set(clusterId, {
            direction: analysis.signalType,
            zonePrice: movedEntry,
            zoneClusterId: clusterId,
            armedAt: now,
            expiresAt: now + pendingTimeoutMs,
            signalParams: {
              confidence: tier0AdjustedConfidence,
              tp1, tp2, tp3, sl,
              originalEntry: entryPriceWithSlippage,
              slMultiplier: atrMultiplier,
              atr: features.atr,
              regime: features.marketRegime.type,
              rsi: features.rsi,
              topFeatures,
            },
          });
          console.log(`⏳ [AwaitTheZone/C2] ARMED pending ${analysis.signalType} at ${c2SameType} ${movedEntry.toFixed(1)} (reaction ${(targetZone.reactionStrength * 100).toFixed(0)}%) — nearest ${c2OppType} BEHIND entry at ${nearestBehind.price.toFixed(1)} (${behindDistAtr.toFixed(2)} ATR) instead of emitting at market`);
        }
        this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'behind-entry arming (C2): opposing zone behind entry within 1.0 ATR -> await the same-side shelf', {
          entryPrice: movedEntry, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips,
        });
        this.recordFunnelRejection('BEHIND_ENTRY_ARMED');
        return null;
      }
    }

    // ── ITEM 104: CHECK PENDING ZONE ENTRIES FOR CONVERSION ───────────
    // If current price has reached a pending entry's zone price, convert it
    // to a live signal. This runs BEFORE the dedup guard so the converted
    // signal is not blocked by its own pending entry.
    for (const [clusterId, pending] of this.pendingZoneEntries.entries()) {
      if (now > pending.expiresAt) {
        this.awaitZoneExpired += 1;
        this.pendingZoneEntries.delete(clusterId);
        console.log(`⏰ [AwaitTheZone] EXPIRED pending ${pending.direction} at ${pending.zonePrice.toFixed(1)} (4h timeout)`);
        continue;
      }
      const distToZone = Math.abs(this.currentPrice - pending.zonePrice);
      const atrForPending = Math.max(Number(pending.signalParams.atr ?? 1), 0.01);
      if (distToZone < atrForPending * 0.3) {
        // Price reached the zone — convert to live signal
        this.awaitZoneConverted += 1;
        this.pendingZoneEntries.delete(clusterId);
        console.log(`✅ [AwaitTheZone] CONVERTED pending ${pending.direction} at ${pending.zonePrice.toFixed(1)} — price reached zone`);
        // Re-derive the ladder from the zone price as the new entry
        const movedEntryPrice = pending.zonePrice;
        const movedRisk = Math.abs(movedEntryPrice - Number(pending.signalParams.sl));
        if (movedRisk <= 0) continue;
        // Use the pending signal's parameters with the moved entry
        entryPrice = movedEntryPrice;
        entryPriceWithSlippage = movedEntryPrice;
        // ITEM 109: Under user-pips ladder, TPs are ABSOLUTE pip distances from
        // the moved entry (not shifted by delta as under the old R-derived ladder).
        // SL distance is preserved from the original entry (risk-based).
        const p = pending.signalParams as any;
        const originalEntry = Number(p.originalEntry ?? entryPrice);
        const slDist = Math.abs(Number(p.sl) - originalEntry);
        const dirMult = analysis.signalType === 'BUY' ? 1 : -1;
        tp1 = movedEntryPrice + dirMult * settings.tp1Pips * pipValue;
        tp2 = movedEntryPrice + dirMult * settings.tp2Pips * pipValue;
        tp3 = movedEntryPrice + dirMult * settings.tp3Pips * pipValue;
        sl = movedEntryPrice - dirMult * slDist;
        // Break out — emit the signal at the moved entry
        break;
      }
    }

    // ── ITEM 105: CLUSTER-SCOPED DEDUP GUARD (replaces Item 97 time-window) ──
    // PRIMARY: suppress a same-direction signal while an ACTIVE signal exists
    // in the same zone cluster, regardless of elapsed time. A time window is
    // a proxy for "same zone cluster" and a worse one — the 30-min window let
    // the motivating 5-signal cluster through by 1 minute.
    // SECONDARY: time window as backstop (DEDUP_TIME_WINDOW_MS, currently 225 min
    // — see the constant's JSDoc; DEDUP_PRICE_BAND_ATR=4.0). ITEM 117(b): this
    // comment previously cited "210 min ... derived from the 15-signal cluster's
    // max gaps of 204.6 min / 3.59 ATR", which stopped matching the live constant
    // after Item 113(b) changed it to 1390 min. It is now derived from the
    // cluster-internal gap distribution (Item 118) — do not cite a bare number
    // here; read the constant.
    this.dedupChecks += 1;
    const atrForDedup = Math.max(features.atr, 0.01);
    // Check active signals in the same direction
    const activeSameDir = this.activeSignalsByDirection.get(analysis.signalType) ?? [];
    for (const active of activeSameDir) {
      const priceDist = Math.abs(this.currentPrice - active.price);
      const priceBandAtr = priceDist / Math.max(active.atr, atrForDedup);
      if (priceBandAtr < DEDUP_CLUSTER_BAND_ATR) {
        this.dedupBlocks += 1;
        this.recordFunnelRejection('CLUSTER_DEDUP');
        console.log(`❌ REJECTED [ClusterDedup]: ${analysis.signalType} @ ${this.currentPrice.toFixed(1)} within ${priceBandAtr.toFixed(2)} ATR of active ${active.signalId.slice(-9)} @ ${active.price.toFixed(1)}`);
        console.log(`   [ClusterDedup] cluster_band=${DEDUP_CLUSTER_BAND_ATR} ATR — active signal in same zone cluster`);
        console.log(`${'='.repeat(80)}\n`);
        this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'cluster-dedup: active signal in same zone cluster', {
          entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips,
        });
        return null;
      }
    }
    // Secondary: time window backstop
    if (this.lastEmittedSignal && this.lastEmittedSignal.direction === analysis.signalType) {
      const timeSinceLast = now - this.lastEmittedSignal.timestamp;
      const priceDist = Math.abs(this.currentPrice - this.lastEmittedSignal.price);
      const priceBandAtr = priceDist / atrForDedup;
      if (timeSinceLast < DEDUP_TIME_WINDOW_MS && priceBandAtr < DEDUP_PRICE_BAND_ATR) {
        this.dedupBlocks += 1;
        this.recordFunnelRejection('TIME_WINDOW_DEDUP');
        console.log(`❌ REJECTED [TimeWindowDedup]: ${analysis.signalType} @ ${this.currentPrice.toFixed(1)} within ${priceBandAtr.toFixed(2)} ATR / ${(timeSinceLast / 60000).toFixed(1)} min of last ${this.lastEmittedSignal.direction}`);
        console.log(`${'='.repeat(80)}\n`);
        this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'time-window-dedup: secondary backstop', {
          entryPrice: this.currentPrice, atr: features.atr, tp1Pips: settings.tp1Pips, tp2Pips: settings.tp2Pips, tp3Pips: settings.tp3Pips, slPips: settings.slPips,
        });
        return null;
      }
    }

    // ── ITEM P — BAND-PROXIMITY VETO (CONDITIONAL mode; services/bandProximityVeto.ts) ──
    // Shipped 2026-08-28 by the pre-registered P.1 gate cascade on the canonical
    // era-clean re-derivation (scripts/item241_fingerprint_conditional.ts, real
    // resolver, n=223): GATE-1 PASS (conditional cohort EV_net -0.2008R < -0.10R,
    // n=79, boot 95% CI [-0.3997, 0.0088]); GATE-2 PASS (fp-AND-vetoable
    // +0.1924R > 0, n=4). Veto iff [E.1 band rule fires] AND NOT [fingerprint
    // active]. All inputs are emission-time values from the same information set
    // as the annotation columns (own sr_zones_snapshot, features.rsi,
    // gold_m1_bars A.2 prior-4h move) — one information set, grep-verifiable.
    // Suppressed candidates: NOT emitted, NOT Telegram'd, NOT in live history;
    // written to shadow_candidates_v1 ('BAND_VETO_SUPPRESSED') and resolved
    // through the ONE canonical instrument.
    //
    // P.3 ABORT GATE (verbatim): suppressed signals resolve through the
    // canonical path (ONE instrument). At every forward n=30 decided suppressed
    // signals: if their EV_net > 0, set the flag false next round and report;
    // else the veto stands. No other condition modifies the flag.
    if (BAND_PROXIMITY_VETO_ENABLED) {
      const bandVeto = await evaluateBandProximityVeto({
        client: this.getDailyOhlcSupabaseClient(),
        direction: analysis.signalType,
        entry: entryPriceWithSlippage,
        sl,
        tp1,
        tp2,
        tp3,
        confidence: tier0AdjustedConfidence,
        rsi: features.rsi,
        zones: srZonesSnapshot,
        nowMs: now,
      });
      if (bandVeto.fires) {
        this.recordFunnelRejection('BAND_PROXIMITY_VETO');
        console.log(`🚫 REJECTED [BandProximityVeto/${bandVeto.mode}]: ${analysis.signalType} @ ${entryPriceWithSlippage.toFixed(1)} — qualifying zone ${bandVeto.qualifyingZone?.price} (touches=${bandVeto.qualifyingZone?.touches}, rs=${Number(bandVeto.qualifyingZone?.reactionStrength ?? 0).toFixed(3)}) in band; fingerprint=${bandVeto.fingerprintActive ? "ACTIVE (exempt)" : "not active"} -> suppressed as ${bandVeto.suppressedId}`);
        console.log(`${"=".repeat(80)}\n`);
        return null;
      }
    }

    this.emissionFunnelEmitted += 1;
    this.recordFunnelEmission();
    const emittedSignalId = `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // ITEM 52(b) — EMISSION PERSISTENCE. Fire-and-forget durable write of every
    // emitted signal to emitted_signals_v1, mirroring pushShadowSellRecord's
    // proven anon-key path. Placed here, at the single confirmed-emission return,
    // so it records exactly what the caller receives and nothing that was
    // rejected. Never awaited: it cannot block, delay, or alter generation.
    //
    // This is the prerequisite for durable resolution. Capture was 12.9% because
    // emission was never persisted server-side at all, so a replay resolver had
    // no population to replay.
    // ITEM 97(c)/105 — track the last emitted signal for the dedup guard.
    this.lastEmittedSignal = {
      direction: analysis.signalType,
      price: entryPriceWithSlippage,
      atr: features.atr,
      timestamp: now,
    };
    // ITEM 105 — track active signals per direction for cluster-scoped dedup.
    // Removed when the signal reaches a terminal status (in recordTradeOutcome).
    const dirList = this.activeSignalsByDirection.get(analysis.signalType) ?? [];
    dirList.push({ price: entryPriceWithSlippage, atr: features.atr, timestamp: now, signalId: emittedSignalId });
    this.activeSignalsByDirection.set(analysis.signalType, dirList);
    // ITEM 107 — session-liquidity telemetry: minutes to next session open.
    {
      const d = new Date(now);
      const currentMin = d.getUTCHours() * 60 + d.getUTCMinutes();
      const londonMin = SESSION_OPEN_LONDON_UTC_HOUR * 60;
      const nyMin = SESSION_OPEN_NY_UTC_HOUR * 60;
      let londonGap = londonMin - currentMin; if (londonGap < 0) londonGap += 24 * 60;
      let nyGap = nyMin - currentMin; if (nyGap < 0) nyGap += 24 * 60;
      const minToOpen = Math.min(londonGap, nyGap);
      const session = londonGap <= nyGap ? 'London' : 'NY';
      this.sessionTelemetry.push({ signalId: emittedSignalId, minutesToOpen: minToOpen, session });
      if (this.sessionTelemetry.length > 500) this.sessionTelemetry.shift();
    }

    pushEmittedSignalRecord({
      signalId: emittedSignalId,
      emittedAt: Date.now(),
      direction: analysis.signalType,
      entry: parseFloat(entryPriceWithSlippage.toFixed(1)),
      sl: parseFloat(sl.toFixed(1)),
      tp1: parseFloat(tp1.toFixed(1)),
      tp2: parseFloat(tp2.toFixed(1)),
      tp3: parseFloat(tp3.toFixed(1)),
      confidence: tier0AdjustedConfidence,
      rawConfidence: this.lastRawConfidence,
      strengthDiff: this.lastSignalStrengthDifference,
      slMultiplier: parseFloat(atrMultiplier.toFixed(2)),
      atr: features.atr,
      regime: features.marketRegime.type,
      sessionName: features.liquidityWindow?.sessionName ?? null,
      hourUtc: new Date().getUTCHours(),
      htfTrend: this.detectHTFTrend(features),
      ltfTrend: null,
      rsi: features.rsi,
      // ITEM 136(g): zone map age in minutes at emission time. NULL when
      // TIER_0 was not used (TIER_1_LOCAL fallback). This must never again
      // be invisible — a 20.9-hour-stale map caused signal [1] to enter $5
      // above a support it could not see.
      zoneMapAgeMinutes: this.tier0DegradedThisPass
        ? null
        : (this.tier0SRZonesFetchedAt > 0
            ? Math.round((now - this.tier0SRZonesFetchedAt) / 60000)
            : null),
      srZonesSnapshot,
      attentionScores: fullAttentionScores,
      nearestOppZoneBehindEntryPrice,
      nearestOppZoneBehindEntryType,
      nearestOppZoneBehindEntryDistAtr,
      drivingZoneTouches,
      source: 'LIVE',
    });

    // ITEM EA — the shadow strategy detectors were REMOVED from the emission
    // path: sidecar-on-emission gave them 7 evaluation opportunities in three
    // weeks. They now run on every closed M5 bar via runShadowStrategyScan()
    // (hooked after refreshBarSeries in the analysis flow), whether or not the
    // engine emits and whether or not any emission gate passes.
    return {
      id: emittedSignalId,
      timestamp: new Date(),
      type: analysis.signalType,
      entryPrice: parseFloat(entryPrice.toFixed(1)),
      entryPriceWithSlippage: parseFloat(entryPriceWithSlippage.toFixed(1)),
      tp1: parseFloat(tp1.toFixed(1)),
      tp2: parseFloat(tp2.toFixed(1)),
      tp3: parseFloat(tp3.toFixed(1)),
      sl: parseFloat(sl.toFixed(1)),
      slMultiplier: parseFloat(atrMultiplier.toFixed(2)),
      confidence: tier0AdjustedConfidence,
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
      }, counterTrendTelemetry, analysis.signalType),
      counterTrendTelemetry,
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

    // ITEM 63(d): the rangeContradiction gate (PHASE 2 A3) is REMOVED. It was
    // a post-scoring patch for the detector-level defect where both support and
    // resistance strength exceeded 0.8 simultaneously. Item 63(a) fixed the
    // detector: the strengthDecayDistance is now ATR-relative (atr*2 instead of
    // max(atr*5, price*0.015)), and mutual exclusion resolves to one side or
    // neither at the detector. Measured on 9,980 M1 bar windows, the dual-fire
    // rate (both > 0.8) dropped from 88.1% to 0.0% — the condition
    // `supportStrength > 0.8 && resistanceStrength > 0.8` can no longer be
    // true, so the gate is dead code. Confirmed fully redundant: the gate's
    // predicate is now structurally unreachable. Removed rather than left as a
    // dead partial patch.
    //
    // The RANGE_CONTRADICTION_MAX_CONFIDENCE constant is retained for reference
    // but is no longer read by any gate.
    // Note: srReaction is still used by the D18/D19 gates below.

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

      // ITEM 48(a) UNIT FIX. This constant was `10` and was compared directly
      // against `Math.abs(level.price - currentPrice)`, which is a DOLLAR
      // distance — so the gate was a $10 (= 100-pip) band while its name, its
      // log line and the user-facing tip all said "10 pips". At gold's 0.1
      // pip value, 10 pips is $1.00, not $10.00. The band was 10x too wide,
      // which is why the 6 Aug counter-trend SELLs at $3.20 and $1.70 from the
      // nearest resistance both passed a filter that was supposed to require a
      // genuine bounce off a level. Express the threshold in pips and convert
      // to dollars explicitly at the comparison site so the two can never
      // silently diverge again.
      const bounceThresholdPips = 10;
      const bouncePipValue = 0.1;
      const bounceThreshold = bounceThresholdPips * bouncePipValue;
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

      console.log(`   Bounce Threshold: ${bounceThresholdPips} pips ($${bounceThreshold.toFixed(2)})`);
      console.log(`   Near Major Level: ${nearMajorLevel ? 'YES' : 'NO'}`);
      if (nearMajorLevel) {
        console.log(`   Level: ${levelDescription}`);
      }

      if (!nearMajorLevel) {
        const reason = `COUNTER-TREND REJECTED: Not bouncing off a real, previously-tested structural level`;
        const tip = `Counter-trend signals require price within ${bounceThresholdPips} pips ($${bounceThreshold.toFixed(2)}) of a Bullish/Bearish OB, or an S/R zone with reaction strength >= 30% and at least 2 confirmed touches - not just a nearby arithmetic pivot.`;
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

    // ITEM 54(b): stamp the RAW confidence from the scoring run that produced
    // this rejection alongside the smoothed one. Read-only telemetry.
    const entry: NearMissEntry = { timestamp: Date.now(), signalType, confidence, strengthDiff, reason };
    if (this.lastRawConfidence !== null) {
      entry.rawConfidence = this.lastRawConfidence;
    }
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
      entry.tp1 = snapshot.entryPrice + dir * snapshot.tp1Pips * pipValue;
      entry.tp2 = snapshot.entryPrice + dir * snapshot.tp2Pips * pipValue;
      entry.tp3 = snapshot.entryPrice + dir * snapshot.tp3Pips * pipValue;
      entry.sl = snapshot.entryPrice - dir * slPips * pipValue;
    }

    this.nearMisses.push(entry);
    if (this.nearMisses.length > NEAR_MISS_MAX_ENTRIES) {
      this.nearMisses = this.nearMisses.slice(-NEAR_MISS_MAX_ENTRIES);
    }
    const rawLabel = entry.rawConfidence !== undefined
      ? ` (raw ${(entry.rawConfidence * 100).toFixed(1)}%)`
      : '';
    console.log(`🔍 NEAR-MISS logged: ${signalType} smoothed conf ${(confidence * 100).toFixed(1)}%${rawLabel} diff ${strengthDiff.toFixed(3)} - ${reason}`);
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
  /**
   * ITEM AG.2 — FORWARD INSTRUMENTATION for the counter-trend gates
   * (WRITE-ONLY — zero live behaviour change). Persists every rejected
   * counter-trend setup to shadow_candidates_v1 under the STRICT candidate_name
   * 'DRIFT_VETO_SUPPRESSED' / 'MID_RSI_SUPPRESSED' with full geometry, resolved
   * forward through the ONE canonical instrument (resolveSignalWithBars
   * fromScratch + lib/evCompute computeRNet, win predicate rNet > 0).
   *
   * ═══════════════════════════════════════════════════════════════════
   * ITEM AG.4 — PRE-REGISTERED PROMOTION GATE (verbatim):
   * A change to COUNTER_TREND_DRIFT_ATR_VETO or to the mid-RSI gate may be
   * proposed only when forward decided DRIFT_VETO_SUPPRESSED n >= 60 (and
   * MID_RSI_SUPPRESSED n >= 40 respectively) AND the cohort's canonical EV_net
   * 95% CI lower bound > 0 (the rejected trades would have been net winners).
   * Until then: observation only. RECOMMENDATION ONLY.
   * ═══════════════════════════════════════════════════════════════════
   *
   * GATE ISOLATION: strict candidate_name equality in every query — these rows
   * count toward NO existing gate (P.3 n=30 counts ONLY 'BAND_VETO_SUPPRESSED';
   * the exit gate counts ONLY 'EXIT_SHADOW_LADDER'; never a range, prefix
   * match, or name-omitted filter).
   *
   * Geometry mirrors recordNearMiss exactly (same ATR-scaled sizing, same
   * 1.4R-scalper SL floor) so forward rows are graded against the same ladder
   * a real signal would have received. A write failure never changes the veto
   * outcome — the veto is applied regardless.
   */
  private writeCounterTrendShadow(
    candidateName: 'DRIFT_VETO_SUPPRESSED' | 'MID_RSI_SUPPRESSED',
    signalType: SignalType,
    confidence: number,
    snapshot: { entryPrice: number; atr: number; tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number },
    extra: { driftAgainst: number | null; driftVetoThreshold: number | null; sweepReclaimConfirmed: boolean; rsi: number | null },
  ): void {
    const pipValue = 0.1;
    const atrMultiplier = Math.max(1.0, Math.min(1.6, 0.7 + snapshot.atr * 0.06));
    const atrFloorSlPips = (snapshot.atr * MIN_SL_ATR_MULTIPLE) / pipValue;
    const slPips = Math.max(snapshot.slPips * atrMultiplier, atrFloorSlPips);
    const dir = signalType === 'BUY' ? 1 : -1;
    const entry = snapshot.entryPrice;
    writeCounterTrendSuppression({
      candidateName,
      direction: signalType === 'SELL' ? 'SELL' : 'BUY',
      evaluatedAt: Date.now(),
      entry,
      sl: entry - dir * slPips * pipValue,
      tp1: entry + dir * snapshot.tp1Pips * pipValue,
      tp2: entry + dir * snapshot.tp2Pips * pipValue,
      tp3: entry + dir * snapshot.tp3Pips * pipValue,
      inputs: {
        atr: Math.round(snapshot.atr * 1000) / 1000,
        confidence: Math.round(confidence * 1000) / 1000,
        drift_against: extra.driftAgainst !== null ? Math.round(extra.driftAgainst * 100) / 100 : null,
        drift_veto_threshold: extra.driftVetoThreshold !== null ? Math.round(extra.driftVetoThreshold * 100) / 100 : null,
        drift_veto_atr_multiple: COUNTER_TREND_DRIFT_ATR_VETO,
        sweep_reclaim_confirmed: extra.sweepReclaimConfirmed,
        rsi: extra.rsi !== null ? Math.round(extra.rsi * 10) / 10 : null,
        veto_spec: candidateName === 'DRIFT_VETO_SUPPRESSED'
          ? `driftAgainst >= ATR x ${COUNTER_TREND_DRIFT_ATR_VETO} without a confirmed sweep reversal + >=${(COUNTER_TREND_DRIFT_OVERRIDE_CONFIDENCE * 100).toFixed(0)}% conviction override`
          : 'counter-trend at mid-range RSI without a confirmed 5-min candle or OB/QM/Sweep alternative confirmation',
      },
    });
  }

  /**
   * ITEMS BA/BB — runs both shadow strategy detectors on `this.barSeriesM5`
   * (the exact sealed M5 series the signal was scored on) and persists one row
   * per qualifying pattern to shadow_candidates_v1. Pure detection +
   * fire-and-forget persistence: never gates, delays, or alters the emission.
   *
   * `isReopen` is derived here (no engine state carries it): a 60–200 minute
   * gap between the last two M5 bars is the daily maintenance break, so the
   * entry bar is the first bar after the break, and `priorClose` is the close
   * of the bar before the gap. A null/uncomputable score is NEVER persisted —
   * no fabricated book entries.
   */
  /**
   * ITEM EA — independent shadow strategy scan on every CLOSED M5 bar. Moved
   * out of the emission path (sidecar-on-emission gave the detectors 7
   * evaluation opportunities in three weeks; the same 72h on a bar-close loop
   * produced 22 signals). Reuses the existing barSeriesM5 — NO second fetch.
   * Context inputs differ from the old emission-path call, deliberately:
   * entryPrice = last closed bar's close (the backtest fills at the NEXT
   * bar's open; the resolver reads bars from evaluated_at onward), rsi =
   * barRSI(14) on the SAME series (a null rsi would null DT's feat_rsi_aligned
   * → null score → its book would silently never accrue), signalId = null
   * (no emission exists; rows resolve via the Item DA resolver write-back,
   * like the suppressed books). Fire-and-forget at the call site (.catch):
   * a scan failure can never affect emission.
   */
  private async runShadowStrategyScan(): Promise<void> {
    const bars = this.barSeriesM5;
    if (!bars || bars.length < 2) return;

    // ITEM EA — double-scan guard: one scan per closed M5 bar, however often
    // the refresh flow calls this.
    const lastClosedTs = bars[bars.length - 1].timestamp;
    if (this.lastShadowScanBarTs === lastClosedTs) {
      console.log(`[ShadowScan] double-scan guard: bar ${new Date(lastClosedTs).toISOString()} already scanned — skipping`);
      return;
    }
    this.lastShadowScanBarTs = lastClosedTs;
    this.shadowScanCount += 1;

    const entryPrice = bars[bars.length - 1].close;
    const rsi = barRSI(bars, 14);
    console.log(`[ShadowScan] #${this.shadowScanCount} bar=${new Date(lastClosedTs).toISOString()} bars=${bars.length} entry=${entryPrice.toFixed(2)} rsi=${rsi !== null ? rsi.toFixed(1) : 'null'}`);

    // ITEM EC — swing-structure gate (report-only), computed ONCE per scan on
    // the same series the detectors consume. BUY is blocked when price sits
    // above the last confirmed swing high; SELL when below the last confirmed
    // swing low; tolerance $1.00 (train-derived, see shadowStrategies.ts).
    // Rows are written EITHER WAY (swingBlocked true/false) — both arms must
    // resolve so the gate can be judged on real forward outcomes. A throw from
    // the causality assertion aborts only this scan (call-site .catch).
    const swing = computeSwingStructure(bars);
    const currentBarIndex = bars.length - 1;
    const swingGateFor = (side: 'BUY' | 'SELL'): { swingBlocked: boolean; swingCausalGap: number | null } => {
      if (side === 'SELL') {
        if (swing.lastSwingLow === null || swing.confirmationBarLow === null) return { swingBlocked: false, swingCausalGap: null };
        return {
          swingBlocked: entryPrice < swing.lastSwingLow + SWING_TOLERANCE,
          swingCausalGap: currentBarIndex - swing.confirmationBarLow,
        };
      }
      if (swing.lastSwingHigh === null || swing.confirmationBarHigh === null) return { swingBlocked: false, swingCausalGap: null };
      return {
        swingBlocked: entryPrice > swing.lastSwingHigh - SWING_TOLERANCE,
        swingCausalGap: currentBarIndex - swing.confirmationBarHigh,
      };
    };

    // ITEM ED — concurrency cap (report-only): count open positions BEFORE the
    // detectors fire. null = unmeasured (rows still written, capSkipped null —
    // never a fake 0). Positions opened earlier in THIS scan count toward the
    // cap for subsequent persists in the same bar.
    const openAtSignal = await this.countOpenShadowPositions();
    let openedThisScan = 0;
    const capState = (): { capSkipped: boolean | null; openPositionsAtSignal: number | null } => {
      if (openAtSignal === null) return { capSkipped: null, openPositionsAtSignal: null };
      const total = openAtSignal + openedThisScan;
      const skipped = total >= SHADOW_CONCURRENCY_CAP;
      if (!skipped) openedThisScan += 1;
      return { capSkipped: skipped, openPositionsAtSignal: total };
    };

    const persist = (
      candidateName: 'SCORED_DT_SHORT' | 'SCORED_REOPEN_LONG' | 'ZONE_RETEST_LONG',
      direction: 'BUY' | 'SELL',
      score: number,
      scoreVerdict: 'ABOVE' | 'BELOW',
      metadata: Record<string, unknown>,
      swingGate: { swingBlocked: boolean; swingCausalGap: number | null },
      cap: { capSkipped: boolean | null; openPositionsAtSignal: number | null },
    ): void => {
      if (cap.capSkipped === true) {
        console.log(`[ShadowScan] CAP: ${candidateName} skipped (open=${cap.openPositionsAtSignal}, cap=${SHADOW_CONCURRENCY_CAP}) — row still written (report-only)`);
      }
      const client = this.getShadowStrategiesClient();
      if (!client) {
        console.warn('[ShadowStrategies] Supabase not configured — shadow strategy row NOT persisted (scan unaffected)');
        return;
      }
      void persistShadowStrategy({
        supabaseClient: client,
        signalId: null,
        candidateName,
        direction,
        entryPrice,
        emittedAt: new Date(lastClosedTs).toISOString(),
        score,
        scoreVerdict,
        metadata,
        swingBlocked: swingGate.swingBlocked,
        lastSwingHigh: swing.lastSwingHigh,
        lastSwingLow: swing.lastSwingLow,
        swingCausalGap: swingGate.swingCausalGap,
        capSkipped: cap.capSkipped,
        openPositionsAtSignal: cap.openPositionsAtSignal,
      }).catch((err: unknown) => {
        console.warn(`[ShadowStrategies] UNCAUGHT (defense-in-depth, scan unaffected): ${err instanceof Error ? err.message : String(err)}`);
      });
    };

    // SCORED_DT_SHORT — SELL-only double top at a session level, scored by the
    // 7 side-relative features. Detected-with-null-score (pattern real, scoring
    // unavailable) is deliberately NOT persisted.
    const dt = detectDoubleTop({ m5Bars: bars, entryPrice, direction: 'SELL', rsi });
    if (dt.detected && dt.score !== null && Number.isFinite(dt.score) && dt.scoreVerdict !== null) {
      persist('SCORED_DT_SHORT', 'SELL', dt.score, dt.scoreVerdict, {
        pattern: {
          swingHighPrice: dt.swingHighPrice,
          swingHighBar: dt.swingHighBar,
          pullbackDepth: dt.pullbackDepth,
          sessionLevelDistance: dt.sessionLevelDistance,
        },
        rsi,
      }, swingGateFor('SELL'), capState());
    }

    // ZONE_RETEST_LONG — long-only, first retest of a confirmed swing low
    // with a strong first reaction, trend-filtered. Causality asserted in
    // the detector (confirmationBar < retestBar on every signal).
    // NOTE (Item CA live-code discrepancy): BAR_M5_LOOKBACK caps the series
    // at 300 bars, so the tested 960-bar trend EMA is approximated by the
    // longest available span until the cap is raised. trendEmaSpanUsed is
    // recorded so the forward book can split the two regimes (CB reads it).
    const zr = detectZoneRetestLong({ m5Bars: bars, entryPrice, direction: 'BUY' });
    if (zr.detected && zr.scoreVerdict !== null) {
      persist('ZONE_RETEST_LONG', 'BUY', zr.scoreVerdict === 'ABOVE' ? 1 : 0, zr.scoreVerdict, {
        pattern: {
          swingLowPrice: zr.swingLowPrice,
          swingLowBar: zr.swingLowBar,
          confirmationBar: zr.confirmationBar,
          firstReaction: zr.firstReaction,
          pullbackHigh: zr.pullbackHigh,
          retestDistance: zr.retestDistance,
        },
        trendUp: zr.trendUp,
        emaStacked: zr.emaStacked,
        trendEmaSpanUsed: Math.min(960, bars.length - 1),
        barsInSeries: bars.length,
        rsi,
      }, swingGateFor('BUY'), capState());
    }

    // SCORED_REOPEN_LONG — LONG-only, first bar after the daily maintenance
    // break (60–200 minute gap between the last two M5 bars). ITEM EA: the
    // old emission path persisted the LIVE signal's direction for REOPEN rows
    // (a SELL emission could label a long-only detection SELL); the
    // independent scan writes the strategy's own side 'BUY'.
    const n = bars.length;
    const gapMs = bars[n - 1].timestamp - bars[n - 2].timestamp;
    const isReopen = gapMs > 60 * 60 * 1000 && gapMs < 200 * 60 * 1000;
    if (!isReopen) return;
    const priorClose = bars[n - 2].close;
    const reopen = detectScoredReopen({ m5Bars: bars, isReopen, entryPrice, priorClose });
    if (reopen.detected && reopen.score !== null && Number.isFinite(reopen.score) && reopen.scoreVerdict !== null) {
      persist('SCORED_REOPEN_LONG', 'BUY', reopen.score, reopen.scoreVerdict, {
        pattern: {
          ema20AboveEma50: reopen.ema20AboveEma50,
          gapDown: reopen.gapDown,
          priorDayBigMove: reopen.priorDayBigMove,
        },
        priorClose,
        gapMinutes: Math.round(gapMs / 60000),
        rsi,
      }, swingGateFor('BUY'), capState());
    }
  }

  /**
   * ITEM ED — count currently OPEN shadow positions (portfolio-wide across the
   * three strategy names). A position is open from evaluated_at until the Item
   * DA resolver writes resolvedOutcome, or its OWN inputs.geometry.timeStopBars
   * elapse (fallback: the longest window, ZONE's 192 bars). capSkipped rows are
   * EXCLUDED in-memory (they were never taken, so they must not fill the cap —
   * but the resolver still resolves them, so the filter cannot be a PostgREST
   * predicate without risking jsonb-operator drift). Returns null when Supabase
   * is unconfigured or the read fails — the cap is then UNMEASURED for that
   * scan (capSkipped written null, never a fabricated 0).
   */
  private async countOpenShadowPositions(): Promise<number | null> {
    const client = this.getShadowStrategiesClient();
    if (!client) return null;
    const windowMs = 192 * 5 * 60 * 1000; // ZONE T192 — the longest geometry window
    const fromIso = new Date(Date.now() - windowMs).toISOString();
    const { data, error } = await client
      .from('shadow_candidates_v1')
      .select('candidate_name, evaluated_at, inputs')
      .in('candidate_name', ['SCORED_DT_SHORT', 'SCORED_REOPEN_LONG', 'ZONE_RETEST_LONG'])
      .gte('evaluated_at', fromIso)
      .filter('inputs->>resolvedOutcome', 'is', null)
      .range(0, 999);
    if (error) {
      console.warn(`[ShadowScan] open-position count failed (cap UNMEASURED this scan): ${error.message}`);
      return null;
    }
    const now = Date.now();
    let open = 0;
    for (const row of (data ?? []) as Array<{ evaluated_at: string; inputs: { geometry?: { timeStopBars?: number } | null; capSkipped?: boolean | null } | null }>) {
      if (row.inputs?.capSkipped === true) continue;
      const timeStopBars = row.inputs?.geometry?.timeStopBars;
      const bars = typeof timeStopBars === 'number' && Number.isFinite(timeStopBars) ? timeStopBars : 192;
      const evaluatedAt = Date.parse(row.evaluated_at);
      if (Number.isFinite(evaluatedAt) && now - evaluatedAt < bars * 5 * 60 * 1000) open += 1;
    }
    return open;
  }

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
    const featureDriftMetrics = this.analyzeFeatureValueDrift();
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
      liveFeatureDrift: this.liveFeatureDrift,
      driftAlertLevel: this.driftAlertLevel,
      daysSinceRetrain: parseFloat(daysSinceRetrain.toFixed(1)),
      retrainingRecommended,
      retrainScheduled: this.retrainScheduled,
      retrainScheduledAtMs: this.retrainScheduledAtMs,
      retrainScheduledReason: this.retrainScheduledReason,
    };
  }

  async getMarketOutlook(): Promise<MarketOutlook> {
    await this.refreshRecentDailyOHLCFromHistory();

    const now = new Date();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    const dayOfWeek = now.getUTCDay();
    
    // GG.3a — consume the single-source-of-truth clock (identical semantics:
    // was isSaturday/isFridayClose/isSundayBeforeOpen/isDailyCloseBreak inline).
    const clock = getGoldMarketClock(now);
    const { isSaturday, isFridayClose, isSundayBeforeOpen, isDailyCloseBreak, isMarketOpen } = clock;
    
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
  async getRawModelWeightsForExport(): Promise<{ weights: [string, number][]; lastTrainingTime: number; corpusSizeAtTraining: number | null; hydrateUnavailableAtTraining: number | null; corpusTotal: number | null; corpusExcludedReconstruction: number | null; corpusExcludedReconstructionMarked: number | null; corpusExcludedReconstructionFingerprint: number | null; corpusUsedForTraining: number | null; architecture: string | null; fitIterations: number | null; fitFinalLoss: number | null; fitRowsUsed: number | null; fitExcludedNaN: number | null } | null> {
    try {
      const weightsData = await AsyncStorage.getItem(MODEL_WEIGHTS_KEY);
      if (!weightsData) return null;
      const parsed = JSON.parse(weightsData);
      const weights: [string, number][] = Array.isArray(parsed?.weights) ? parsed.weights : Array.isArray(parsed) ? parsed : [];
      const lastTrainingTime: number = typeof parsed?.lastTrainingTime === 'number' ? parsed.lastTrainingTime : 0;
      // ITEM 12: null (NOT 0) when the persisted vector predates this telemetry -
      // "provenance unknown" and "trained on zero outcomes" are different claims.
      const corpusSizeAtTraining: number | null = typeof parsed?.corpusSizeAtTraining === 'number' ? parsed.corpusSizeAtTraining : null;
      const hydrateUnavailableAtTraining: number | null = typeof parsed?.hydrateUnavailableAtTraining === 'number' ? parsed.hydrateUnavailableAtTraining : null;
      // ITEM AA: null when the persisted vector predates the corpus filter —
      // "provenance unknown" is not the same claim as excluded 0 rows.
      const corpusTotal: number | null = typeof parsed?.corpusTotal === 'number' ? parsed.corpusTotal : null;
      const corpusExcludedReconstruction: number | null = typeof parsed?.corpusExcludedReconstruction === 'number' ? parsed.corpusExcludedReconstruction : null;
      // ITEM AE: null when the persisted vector predates the fingerprint filter.
      const corpusExcludedReconstructionMarked: number | null = typeof parsed?.corpusExcludedReconstructionMarked === 'number' ? parsed.corpusExcludedReconstructionMarked : null;
      const corpusExcludedReconstructionFingerprint: number | null = typeof parsed?.corpusExcludedReconstructionFingerprint === 'number' ? parsed.corpusExcludedReconstructionFingerprint : null;
      const corpusUsedForTraining: number | null = typeof parsed?.corpusUsedForTraining === 'number' ? parsed.corpusUsedForTraining : null;
      // ITEM AC: null when the persisted vector predates the logistic fit.
      const architecture: string | null = typeof parsed?.architecture === 'string' ? parsed.architecture : null;
      const fitIterations: number | null = typeof parsed?.fitIterations === 'number' ? parsed.fitIterations : null;
      const fitFinalLoss: number | null = typeof parsed?.fitFinalLoss === 'number' ? parsed.fitFinalLoss : null;
      const fitRowsUsed: number | null = typeof parsed?.fitRowsUsed === 'number' ? parsed.fitRowsUsed : null;
      const fitExcludedNaN: number | null = typeof parsed?.fitExcludedNaN === 'number' ? parsed.fitExcludedNaN : null;
      if (weights.length === 0 && !lastTrainingTime) return null;
      return { weights, lastTrainingTime, corpusSizeAtTraining, hydrateUnavailableAtTraining, corpusTotal, corpusExcludedReconstruction, corpusExcludedReconstructionMarked, corpusExcludedReconstructionFingerprint, corpusUsedForTraining, architecture, fitIterations, fitFinalLoss, fitRowsUsed, fitExcludedNaN };
    } catch (error) {
      console.error('[SignalEngine] Failed to read raw model weights for export:', error);
      return null;
    }
  }

  /**
   * ITEM AD — MODEL SHADOW PERFORMANCE aggregates, computed from the resolved
   * corpus: every row carrying a modelVerdict (stamped at emission) and a
   * realised R. Scratches are excluded. The promotion gate is deliberately
   * conservative: INSUFFICIENT DATA until >= 100 eligible signals exist; then
   * MET only when AGREE EV > DISAGREE EV. READ-ONLY — nothing here
   * suppresses, filters, demotes or delays any signal.
   */
  getModelShadowStats(): {
    eligibleCount: number;
    agreeCount: number;
    disagreeCount: number;
    agreeWinRate: number | null;
    agreeEV: number | null;
    disagreeWinRate: number | null;
    disagreeEV: number | null;
    evDelta: number | null;
    gate: "INSUFFICIENT DATA" | "MET" | "NOT MET";
  } {
    const eligible = this.tradeOutcomes.filter(
      (o) =>
        (o.features?.modelVerdict === "AGREE" || o.features?.modelVerdict === "DISAGREE") &&
        o.isScratch !== true &&
        typeof o.realizedR === "number",
    );
    const agree = eligible.filter((o) => o.features.modelVerdict === "AGREE");
    const disagree = eligible.filter((o) => o.features.modelVerdict === "DISAGREE");
    const winRate = (rows: typeof agree): number | null =>
      rows.length > 0 ? rows.filter((o) => (o.realizedR ?? 0) > 0).length / rows.length : null;
    const ev = (rows: typeof agree): number | null =>
      rows.length > 0 ? rows.reduce((s, o) => s + (o.realizedR ?? 0), 0) / rows.length : null;
    const agreeEV = ev(agree);
    const disagreeEV = ev(disagree);
    const evDelta = agreeEV !== null && disagreeEV !== null ? agreeEV - disagreeEV : null;
    const gate: "INSUFFICIENT DATA" | "MET" | "NOT MET" =
      eligible.length < 100
        ? "INSUFFICIENT DATA"
        : evDelta !== null && evDelta > 0
          ? "MET"
          : "NOT MET";
    return {
      eligibleCount: eligible.length,
      agreeCount: agree.length,
      disagreeCount: disagree.length,
      agreeWinRate: winRate(agree),
      agreeEV,
      disagreeWinRate: winRate(disagree),
      disagreeEV,
      evDelta,
      gate,
    };
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
  // ITEM 17b: chart-bridge / WebSocket ticks are genuine live observations.
  lastRealPriceObservedAt = Date.now();
  lastRealPriceSource = source;

  signalEngine.pushExternalPrice(price, source);
}
