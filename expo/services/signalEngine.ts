import { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext } from "@/types/trading";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchHistoricalData, trpcClient } from "@/lib/trpc";
import { Platform } from "react-native";
import { appendOutcome as appendOutcomeToStore, getAllOutcomes as getAllOutcomesFromStore, getOutcomeCount as getOutcomeCountFromStore, migrateLegacyOutcomesIfEmpty, pruneToCap as pruneOutcomeStoreToCap, type StoredTradeOutcome } from "@/services/learningStore";

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
}

interface SRZone {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  touches: number;
  lastTouch: number;
  rejectionWicks: number;
  avgRejectionSize: number;
  reactionStrength: number;
  source: 'PRICE_ACTION' | 'PIVOT' | 'FIBONACCI' | 'VOLUME_NODE';
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

const TIME_WEIGHTS = {
  LOW_LIQUIDITY: 0.5,
  MODERATE_LIQUIDITY: 1.0,
  EUROPE_OPEN: 1.5,
  POWER_HOUR: 2.0,
};

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
    const dxyChange = calculateRealChange(intermarketHistory.dxyPrices);
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

  const dxyChange = calculateRealChange(intermarketHistory.dxyPrices);
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
  private nearMisses: { timestamp: number; signalType: SignalType; confidence: number; strengthDiff: number; reason: string }[] = [];
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
  private srZones: SRZone[] = [];
  private srZoneProximityThreshold: number = 5;
  private asianSessionHigh: number = 0;
  private asianSessionLow: number = Infinity;
  private londonSessionHigh: number = 0;
  private londonSessionLow: number = Infinity;
  private nySessionHigh: number = 0;
  private nySessionLow: number = Infinity;
  private lastSessionUpdate: number = 0;
  private lastOHLCFetchTime: number = 0;
  private ohlcDataSource: string = 'estimated';
  private lastDailyOHLCRefreshAt: number = 0;
  
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
        this.ohlcDataSource = 'real-ohlc';
        console.log(`✅ OHLC: Loaded ${bars.length} real 1-min bars (H/L from Yahoo)`);
        return;
      }
    } catch (error) {
      console.log('⚠️ OHLC fetch failed, using 5-min candle fallback:', error instanceof Error ? error.message : 'Unknown');
    }
    
    if (this.fiveMinCandles.length >= 5) {
      this.highHistory = this.fiveMinCandles.map(c => c.high);
      this.lowHistory = this.fiveMinCandles.map(c => c.low);
      this.ohlcDataSource = '5min-candles';
      console.log(`📊 OHLC: Using ${this.fiveMinCandles.length} locally-built 5-min candles for H/L`);
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
    
    if (this.highHistory.length > 100) {
      this.highHistory.shift();
      this.lowHistory.shift();
    }
    this.ohlcDataSource = 'estimated';
  }
  
  private syncCurrentPrice(price: number, source: string): void {
    const now = Date.now();
    const previousPrice = this.currentPrice;
    const priceChangedMeaningfully = previousPrice <= 0 || Math.abs(price - previousPrice) >= MIN_PRICE_HISTORY_CHANGE;
    const shouldSampleHistory = priceChangedMeaningfully || (now - this.lastPriceHistorySampleAt) >= MIN_PRICE_HISTORY_SAMPLE_INTERVAL_MS;

    this.currentPrice = price;
    lastPriceSource = source;

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

    const recentPrices = this.priceHistory.slice(-10);
    const priceChange = recentPrices[recentPrices.length - 1] - recentPrices[0];
    const range = Math.max(...recentPrices) - Math.min(...recentPrices);
    const momentum = priceChange / (range || 1);

    const volatilityProxy = this.calculateRealTimeVolatility();
    const baseVolume = 1000 + (volatilityProxy * 50);
    let bidVolume = baseVolume;
    let askVolume = baseVolume;

    if (momentum > 0.2) {
      bidVolume *= (1 + momentum);
    } else if (momentum < -0.2) {
      askVolume *= (1 + Math.abs(momentum));
    }

    if (recentPrices.length >= 5) {
      const midRange = (Math.max(...recentPrices) + Math.min(...recentPrices)) / 2;
      const currentPrice = recentPrices[recentPrices.length - 1];
      const positionInRange = (currentPrice - midRange) / (range || 1);
      bidVolume += baseVolume * 0.1 * Math.max(0, -positionInRange);
      askVolume += baseVolume * 0.1 * Math.max(0, positionInRange);
    }

    const volumeImbalance = (bidVolume - askVolume) / (bidVolume + askVolume);
    
    // Large orders detected if momentum is high but range is low (absorption)
    // or if momentum is extremely high (aggression)
    const isAbsorption = Math.abs(momentum) < 0.3 && range > 5; // Lots of movement but little net change
    const isAggression = Math.abs(momentum) > 0.8;
    const largeOrdersDetected = isAbsorption || isAggression;

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
    // Synthetic Volume Profile based on recent price history
    if (this.priceHistory.length < 20) {
      // Fallback if not enough data
      return {
        highVolumeNodes: [this.currentPrice],
        lowVolumeNodes: [this.currentPrice - 10, this.currentPrice + 10],
        pointOfControl: this.currentPrice,
        valueAreaHigh: this.currentPrice + 5,
        valueAreaLow: this.currentPrice - 5
      };
    }

    const lookback = Math.min(100, this.priceHistory.length);
    const prices = this.priceHistory.slice(-lookback);
    
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

  private detectSessionSweeps(): SessionSweep[] {
    const now = Date.now();
    const currentPrice = this.currentPrice;
    const hour = new Date().getUTCHours();

    if (now - this.lastSessionUpdate < 60000) {
      return this.sessionSweeps;
    }
    this.lastSessionUpdate = now;

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
      this.londonSessionHigh = Math.max(this.londonSessionHigh, currentPrice);
      this.londonSessionLow = Math.min(this.londonSessionLow, currentPrice);

      if (this.asianSessionHigh > 0 && currentPrice > this.asianSessionHigh + 2) {
        const sweepExists = this.sessionSweeps.some(
          s => s.type === 'HIGH_SWEEP' && s.sessionType === 'ASIAN' && Math.abs(s.sweepPrice - this.asianSessionHigh) < 5
        );

        if (!sweepExists) {
          const reversalConfirmed = this.priceHistory.length > 5 && 
            this.priceHistory[this.priceHistory.length - 1] < this.priceHistory[this.priceHistory.length - 3];
          
          const strength = reversalConfirmed ? 0.85 : 0.65;
          
          this.sessionSweeps.push({
            type: 'HIGH_SWEEP',
            sessionType: 'ASIAN',
            sweepPrice: this.asianSessionHigh,
            reversalConfirmed,
            timestamp: now,
            strength,
          });

          console.log(`🚨 ASIAN HIGH SWEEP DETECTED!`);
          console.log(`   Sweep Price: ${this.asianSessionHigh.toFixed(1)}`);
          console.log(`   Current Price: ${currentPrice.toFixed(1)} (+${(currentPrice - this.asianSessionHigh).toFixed(1)} pips)`);
          console.log(`   Reversal Confirmed: ${reversalConfirmed ? 'YES' : 'PENDING'}`);
          console.log(`   Strength: ${(strength * 100).toFixed(0)}%`);
          console.log(`   → Liquidity grab detected - potential SHORT setup`);
        }
      }

      if (this.asianSessionLow < Infinity && currentPrice < this.asianSessionLow - 2) {
        const sweepExists = this.sessionSweeps.some(
          s => s.type === 'LOW_SWEEP' && s.sessionType === 'ASIAN' && Math.abs(s.sweepPrice - this.asianSessionLow) < 5
        );

        if (!sweepExists) {
          const reversalConfirmed = this.priceHistory.length > 5 && 
            this.priceHistory[this.priceHistory.length - 1] > this.priceHistory[this.priceHistory.length - 3];
          
          const strength = reversalConfirmed ? 0.85 : 0.65;
          
          this.sessionSweeps.push({
            type: 'LOW_SWEEP',
            sessionType: 'ASIAN',
            sweepPrice: this.asianSessionLow,
            reversalConfirmed,
            timestamp: now,
            strength,
          });

          console.log(`🚨 ASIAN LOW SWEEP DETECTED!`);
          console.log(`   Sweep Price: ${this.asianSessionLow.toFixed(1)}`);
          console.log(`   Current Price: ${currentPrice.toFixed(1)} (${(currentPrice - this.asianSessionLow).toFixed(1)} pips)`);
          console.log(`   Reversal Confirmed: ${reversalConfirmed ? 'YES' : 'PENDING'}`);
          console.log(`   Strength: ${(strength * 100).toFixed(0)}%`);
          console.log(`   → Liquidity grab detected - potential LONG setup`);
        }
      }

      console.log(`London Session - High: ${this.londonSessionHigh.toFixed(1)}, Low: ${this.londonSessionLow.toFixed(1)}`);
    } else if (isNYSession) {
      this.nySessionHigh = Math.max(this.nySessionHigh, currentPrice);
      this.nySessionLow = Math.min(this.nySessionLow, currentPrice);

      if (this.londonSessionHigh > 0 && currentPrice > this.londonSessionHigh + 2) {
        const sweepExists = this.sessionSweeps.some(
          s => s.type === 'HIGH_SWEEP' && s.sessionType === 'LONDON' && Math.abs(s.sweepPrice - this.londonSessionHigh) < 5
        );

        if (!sweepExists) {
          const reversalConfirmed = this.priceHistory.length > 5 && 
            this.priceHistory[this.priceHistory.length - 1] < this.priceHistory[this.priceHistory.length - 3];
          
          const strength = reversalConfirmed ? 0.90 : 0.70;
          
          this.sessionSweeps.push({
            type: 'HIGH_SWEEP',
            sessionType: 'LONDON',
            sweepPrice: this.londonSessionHigh,
            reversalConfirmed,
            timestamp: now,
            strength,
          });

          console.log(`🚨 LONDON HIGH SWEEP DETECTED!`);
          console.log(`   Sweep Price: ${this.londonSessionHigh.toFixed(1)}`);
          console.log(`   Current Price: ${currentPrice.toFixed(1)} (+${(currentPrice - this.londonSessionHigh).toFixed(1)} pips)`);
          console.log(`   Reversal Confirmed: ${reversalConfirmed ? 'YES' : 'PENDING'}`);
          console.log(`   Strength: ${(strength * 100).toFixed(0)}%`);
          console.log(`   → High liquidity grab - potential SHORT setup`);
        }
      }

      if (this.londonSessionLow < Infinity && currentPrice < this.londonSessionLow - 2) {
        const sweepExists = this.sessionSweeps.some(
          s => s.type === 'LOW_SWEEP' && s.sessionType === 'LONDON' && Math.abs(s.sweepPrice - this.londonSessionLow) < 5
        );

        if (!sweepExists) {
          const reversalConfirmed = this.priceHistory.length > 5 && 
            this.priceHistory[this.priceHistory.length - 1] > this.priceHistory[this.priceHistory.length - 3];
          
          const strength = reversalConfirmed ? 0.90 : 0.70;
          
          this.sessionSweeps.push({
            type: 'LOW_SWEEP',
            sessionType: 'LONDON',
            sweepPrice: this.londonSessionLow,
            reversalConfirmed,
            timestamp: now,
            strength,
          });

          console.log(`🚨 LONDON LOW SWEEP DETECTED!`);
          console.log(`   Sweep Price: ${this.londonSessionLow.toFixed(1)}`);
          console.log(`   Current Price: ${currentPrice.toFixed(1)} (${(currentPrice - this.londonSessionLow).toFixed(1)} pips)`);
          console.log(`   Reversal Confirmed: ${reversalConfirmed ? 'YES' : 'PENDING'}`);
          console.log(`   Strength: ${(strength * 100).toFixed(0)}%`);
          console.log(`   → High liquidity grab - potential LONG setup`);
        }
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

    const oneHourAgo = now - (60 * 60 * 1000);
    this.sessionSweeps = this.sessionSweeps
      .filter(sweep => sweep.timestamp > oneHourAgo)
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 10);

    if (this.sessionSweeps.length > 0) {
      console.log(`📊 Active Session Sweeps: ${this.sessionSweeps.length} (last hour, top 10)`);
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
    
    const resistanceStrength = Math.max(0, Math.min(1, 1 - (distanceToResistance / 50)));
    const supportStrength = Math.max(0, Math.min(1, 1 - (distanceToSupport / 50)));
    
    return {
      supportStrength: parseFloat(supportStrength.toFixed(2)),
      resistanceStrength: parseFloat(resistanceStrength.toFixed(2)),
    };
  }

  private detectSRZones(): SRZone[] {
    const now = Date.now();
    const currentPrice = this.currentPrice;
    const zones: SRZone[] = [];
    const atr = this.calculateRealATR(14);
    const zoneWidth = Math.max(2, atr * 0.3);

    if (this.priceHistory.length < 20 || this.highHistory.length < 20 || this.lowHistory.length < 20) {
      console.log('⚠️ S/R Zones: Insufficient data for zone detection');
      return this.srZones;
    }

    const candidateLevels: { price: number; source: 'PRICE_ACTION' | 'PIVOT' | 'FIBONACCI' | 'VOLUME_NODE' }[] = [];

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
    const dailyRange = Math.max(ohlc.yesterdayHigh - ohlc.yesterdayLow, atr);
    const zoneStep = dailyRange / 12;
    candidateLevels.push({ price: dailyPivot, source: 'PIVOT' });
    candidateLevels.push({ price: ohlc.yesterdayClose + zoneStep, source: 'PIVOT' });
    candidateLevels.push({ price: ohlc.yesterdayClose - zoneStep, source: 'PIVOT' });
    candidateLevels.push({ price: ohlc.yesterdayClose + zoneStep * 2, source: 'PIVOT' });
    candidateLevels.push({ price: ohlc.yesterdayClose - zoneStep * 2, source: 'PIVOT' });

    const clustered: { price: number; source: 'PRICE_ACTION' | 'PIVOT' | 'FIBONACCI' | 'VOLUME_NODE'; count: number }[] = [];
    for (const level of candidateLevels) {
      const existing = clustered.find(c => Math.abs(c.price - level.price) < zoneWidth);
      if (existing) {
        existing.count++;
        existing.price = (existing.price + level.price) / 2;
        if (level.source === 'PRICE_ACTION') existing.source = level.source;
      } else {
        clustered.push({ ...level, count: 1 });
      }
    }

    for (const cluster of clustered) {
      let touches = 0;
      let rejectionWicks = 0;
      let totalRejectionSize = 0;
      let lastTouch = 0;
      const isResistance = cluster.price > currentPrice;

      for (let i = 0; i < this.priceHistory.length; i++) {
        const price = this.priceHistory[i];
        const high = this.highHistory[i] ?? price;
        const low = this.lowHistory[i] ?? price;

        if (Math.abs(price - cluster.price) < zoneWidth) {
          touches++;
          lastTouch = now - ((this.priceHistory.length - i) * 5000);
        }

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

      const touchScore = Math.min(1, touches / 6);
      const rejectionScore = Math.min(1, rejectionWicks / 4);
      const avgRejectionSize = rejectionWicks > 0 ? totalRejectionSize / rejectionWicks : 0;
      const rejectionSizeScore = Math.min(1, avgRejectionSize / (atr * 0.5));
      const clusterScore = Math.min(1, cluster.count / 3);
      const reactionStrength = (touchScore * 0.30) + (rejectionScore * 0.30) + (rejectionSizeScore * 0.20) + (clusterScore * 0.20);

      if (touches >= 2 || rejectionWicks >= 1 || cluster.count >= 2) {
        zones.push({
          price: parseFloat(cluster.price.toFixed(1)),
          type: isResistance ? 'RESISTANCE' : 'SUPPORT',
          touches,
          lastTouch,
          rejectionWicks,
          avgRejectionSize: parseFloat(avgRejectionSize.toFixed(2)),
          reactionStrength: parseFloat(reactionStrength.toFixed(3)),
          source: cluster.source,
        });
      }
    }

    zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
    this.srZones = zones.slice(0, 12);

    if (this.srZones.length > 0) {
      console.log('\n📊 S/R ZONE DETECTION:');
      console.log('='.repeat(60));
      for (const zone of this.srZones.slice(0, 6)) {
        console.log(`   ${zone.type} @ ${zone.price.toFixed(1)} | Touches: ${zone.touches} | Wick Rejections: ${zone.rejectionWicks} | Reaction: ${(zone.reactionStrength * 100).toFixed(0)}% | Source: ${zone.source}`);
      }
      console.log('='.repeat(60));
    }

    return this.srZones;
  }

  private detectActiveSRReaction(features: MarketFeatures): SRZoneReaction | null {
    const currentPrice = this.currentPrice;
    const atr = features.atr || this.calculateRealATR(14);
    const proximityThreshold = Math.max(3, atr * 0.25);

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
    const atrFloor = Math.max(this.calculateRealATR(14), 2);
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
    const range = H - L;
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
    let asianHigh = currentPrice;
    let asianLow = currentPrice;
    
    if (this.priceHistory.length > 20) {
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
    const atrFloorFeatures = Math.max(this.calculateRealATR(14), 2);
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

    const camRange = pivotH - pivotL;
    const r1 = pivotC + (camRange * 1.1) / 12;
    const s1 = pivotC - (camRange * 1.1) / 12;
    const r2 = pivotC + (camRange * 1.1) / 6;
    const s2 = pivotC - (camRange * 1.1) / 6;
    const r3 = pivotC + (camRange * 1.1) / 4;
    const s3 = pivotC - (camRange * 1.1) / 4;
    
    const rsi = this.calculateRealRSI(14);
    const atr = this.calculateRealATR(14);
    const volumeRatio = this.calculateRealVolumeRatio();
    
    const weeklyPivot = dailyPivot;
    
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

  private detectMacroEvents(): MacroEvent | undefined {
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
      console.log(`⏰ Next Drift Check in ${hoursRemaining}h (scheduled: ${nextCheck.toLocaleTimeString()})`);
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

  /** Step 1 test seam: read the Bayesian blend alpha (historical-weight share) used by retrainModel. */
  public getBayesianBlendAlphaForTest(): number {
    return BAYESIAN_BLEND_ALPHA;
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

    const rsiModulation = this.getFeatureModulation('rsi_weight');
    buySignalStrength += rsiBuyContribution * rsiModulation;
    sellSignalStrength += rsiSellContribution * rsiModulation;
    if (rsiBuyContribution > 0 || rsiSellContribution > 0) {
      attentionScores.set('rsi_learned_modulation', rsiModulation);
      console.log(`🧠 Learned RSI modulation x${rsiModulation.toFixed(3)} → BUY+${(rsiBuyContribution * rsiModulation).toFixed(3)} SELL+${(rsiSellContribution * rsiModulation).toFixed(3)} (raw BUY+${rsiBuyContribution.toFixed(2)} SELL+${rsiSellContribution.toFixed(2)})`);
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
    if (calibrationPenalty > 0) {
      console.log(`⚠️ Calibration penalty (capped at ${(MAX_CALIBRATION_PENALTY * 100).toFixed(0)}%): -${(calibrationPenalty * 100).toFixed(1)}%`);
    }

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
  
  private detectHTFTrend(features: MarketFeatures): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const priceVsPivot = this.currentPrice - features.dailyPivot;
    const trendStrength = this.calculateTrendStrength();
    const emaSignal = this.priceHistory.length >= 21 ? this.calculateEMA(this.priceHistory, 9) - this.calculateEMA(this.priceHistory, 21) : 0;
    
    const bullishScore = (priceVsPivot > 10 ? 1 : 0) + (trendStrength > 0.4 && this.detectPriceDirection() > 0 ? 1 : 0) + (emaSignal > 0 ? 0.5 : 0);
    const bearishScore = (priceVsPivot < -10 ? 1 : 0) + (trendStrength > 0.4 && this.detectPriceDirection() < 0 ? 1 : 0) + (emaSignal < 0 ? 0.5 : 0);
    
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
    const momentumThreshold = Math.max(0.8, Math.min(2.5, volatility * 0.9));
    
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
    if (this.highHistory.length < period || this.lowHistory.length < period || this.priceHistory.length < period) {
      console.log('⚠️ ATR: Insufficient data, using default value 10');
      return 10;
    }

    const trueRanges: number[] = [];
    const highs = this.highHistory.slice(-period);
    const lows = this.lowHistory.slice(-period);
    const closes = this.priceHistory.slice(-(period + 1));

    for (let i = 0; i < period; i++) {
      const high = highs[i];
      const low = lows[i];
      const prevClose = closes[i];

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    const atr = trueRanges.reduce((sum, tr) => sum + tr, 0) / period;
    console.log(`✅ ATR (${period}): ${atr.toFixed(1)} (True Range avg)`);
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
  
  async recordTradeOutcome(signalId: string, entryPrice: number, exitPrice: number, result: 'WIN' | 'LOSS', features?: Partial<SignalLearningContext>, misleadingFeatures?: FeatureConfidence[], signalDuration?: number, confidence?: number): Promise<void> {
    const pnl = result === 'WIN' ? Math.abs(exitPrice - entryPrice) : -Math.abs(exitPrice - entryPrice);
    const normalizedConfidence = Math.max(0.42, Math.min(0.95, confidence ?? this.performanceMetrics.avgConfidence ?? 0.72));
    const defaultContext = createDefaultLearningContext();
    const normalizedFeatures: SignalLearningContext = {
      rsi: typeof features?.rsi === 'number' ? features.rsi : defaultContext.rsi,
      atr: typeof features?.atr === 'number' ? features.atr : defaultContext.atr,
      volumeRatio: typeof features?.volumeRatio === 'number' ? features.volumeRatio : defaultContext.volumeRatio,
      dxyChange: typeof features?.dxyChange === 'number' ? features.dxyChange : defaultContext.dxyChange,
      timeWindowFactor: typeof features?.timeWindowFactor === 'number' ? features.timeWindowFactor : defaultContext.timeWindowFactor,
      sentiment: features?.sentiment ?? defaultContext.sentiment,
    };
    
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
    };
    
    this.tradeOutcomes.push(outcome);
    
    if (this.tradeOutcomes.length > MAX_STORED_OUTCOMES) {
      this.tradeOutcomes = this.tradeOutcomes.slice(-MAX_STORED_OUTCOMES);
    }
    
    const recentOutcomes = this.tradeOutcomes.slice(-20);
    const wins = recentOutcomes.filter(o => o.result === 'WIN').length;
    const losses = recentOutcomes.filter(o => o.result === 'LOSS').length;
    const winPnl = recentOutcomes.filter(o => o.result === 'WIN').reduce((sum, o) => sum + o.pnl, 0);
    const lossPnl = Math.abs(recentOutcomes.filter(o => o.result === 'LOSS').reduce((sum, o) => sum + o.pnl, 0));
    
    this.performanceMetrics.recentWinRate = wins / (wins + losses);
    this.performanceMetrics.profitFactor = lossPnl > 0 ? winPnl / lossPnl : 2.0;
    this.performanceMetrics.avgConfidence = recentOutcomes.reduce((sum, o) => sum + o.confidence, 0) / recentOutcomes.length;
    
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
      console.error('Failed to persist trade outcome to SQLite learning store:', error);
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
    
    const winningData = normalizedData.filter(d => d.outcome.result === 'WIN');
    const losingData = normalizedData.filter(d => d.outcome.result === 'LOSS');
    const weightedWinningData = winningData.length > 0 ? winningData : normalizedData;
    const weightedLosingData = losingData.length > 0 ? losingData : normalizedData;

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
    console.log(`   Sum of Absolute Weights: ${sumAbsoluteWeights.toFixed(4)}`);
    
    const recentWeights = new Map<string, number>();
    if (sumAbsoluteWeights > 0) {
      Object.entries(rawWeights).forEach(([key, value]) => {
        const normalizedWeight = value / sumAbsoluteWeights;
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
    settings: { tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number; minConfidence: number; useDynamicSL?: boolean; maxSLPips?: number },
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
    
    const htfTrend = this.detectHTFTrend(features);
    const isCounterTrendSignal = (
      (analysis.signalType === 'BUY' && htfTrend === 'BEARISH') ||
      (analysis.signalType === 'SELL' && htfTrend === 'BULLISH') ||
      (analysis.signalType === 'BUY' && htfTrend === 'NEUTRAL' && features.rsi < 35) ||
      (analysis.signalType === 'SELL' && htfTrend === 'NEUTRAL' && features.rsi > 65)
    );
    
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
            this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'counter-trend mid-RSI unconfirmed');
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
      effectiveMinConfidence = Math.max(effectiveMinConfidence, requestedMinConfidence + 0.05);
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
    const tentativeAtrMultiplier = Math.max(0.8, Math.min(1.4, 0.6 + features.atr * 0.06));
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
      this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, `below threshold ${(effectiveMinConfidence * 100).toFixed(0)}%`);
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
        this.recordNearMiss(analysis.signalType, analysis.confidence, this.lastSignalStrengthDifference, 'conflict with last signal type');
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
    
    // F30: Continuous ATR-to-SL mapping
    const useDynamicSL = settings.useDynamicSL !== false;
    const maxSLPips = settings.maxSLPips ?? 90;
    const atrMultiplier = useDynamicSL
      ? parseFloat(Math.max(0.8, Math.min(1.4, 0.6 + features.atr * 0.06)).toFixed(2))
      : 1.0;
    const rawSlPips = settings.slPips * atrMultiplier;
    let dynamicSlPips = Math.min(rawSlPips, maxSLPips);
    if (rawSlPips > maxSLPips) {
      console.log(`🛡️ SL capped at maxSLPips ${maxSLPips} (would have been ${rawSlPips.toFixed(1)})`);
    }
    // Preliminary RR guard against the configured TP3 setting. Final RR is
    // re-checked below against the actual (widened) TP3 distance so the live
    // reward-to-risk ratio is never < 1:1 regardless of the TP widen factor.
    const preliminaryMaxSlByRR = Math.max(1, settings.tp3Pips);
    if (dynamicSlPips > preliminaryMaxSlByRR) {
      console.log(`🛡️ SL tightened to ${preliminaryMaxSlByRR} pips to preserve 1:1 RR vs base TP3 ${settings.tp3Pips} (was ${dynamicSlPips.toFixed(1)})`);
      dynamicSlPips = preliminaryMaxSlByRR;
    }
    
    const volatilityLabel = features.atr > 10 ? "High Volatility" : features.atr < 8 ? "Low Volatility" : "Normal Volatility";
    const riskJustification = `SL Multiplier: ${atrMultiplier.toFixed(2)}x (${volatilityLabel} | ATR: ${features.atr.toFixed(1)})`;
    
    let tp1Distance = settings.tp1Pips;
    let tp2Distance = settings.tp2Pips;
    let tp3Distance = settings.tp3Pips;
    
    // F29: Scale TP widening by ATR-relative room to nearest S/R
    const roomToSR = this.computeRoomToSR(analysis.signalType, features);
    const atrUnits = roomToSR / Math.max(features.atr, 1);
    let widenFactor = 1.0;
    if (analysis.confidence >= 0.89 && atrUnits >= 3) widenFactor = 1.15;
    else if (analysis.confidence >= 0.89) widenFactor = 1.05;
    else if (analysis.confidence >= 0.82 && atrUnits >= 2.5) widenFactor = 1.08;
    else if (analysis.confidence >= 0.82) widenFactor = 1.03;
    else if (analysis.confidence < 0.70) widenFactor = 0.88;
    tp2Distance = settings.tp2Pips * widenFactor;
    tp3Distance = settings.tp3Pips * widenFactor;
    if (analysis.confidence < 0.70) tp1Distance = settings.tp1Pips * 0.92;
    console.log(`🎯 TP widening factor ${widenFactor.toFixed(2)}x (room-to-SR ${roomToSR.toFixed(0)}p / ATR ${atrUnits.toFixed(1)}u)`);

    // Final 1:1 RR enforcement against the ACTUAL widened TP3 distance. If the
    // widen factor shrank TP3 below the current SL, tighten SL so reward >= risk.
    if (dynamicSlPips > tp3Distance) {
      const tightened = Math.max(1, Math.floor(tp3Distance));
      console.log(`🛡️ Post-widen SL tightened from ${dynamicSlPips.toFixed(1)} -> ${tightened} pips to preserve >=1:1 RR vs actual TP3 ${tp3Distance.toFixed(1)}`);
      dynamicSlPips = tightened;
    }
    console.log(`⚖️ Final RR check: TP1 ${tp1Distance.toFixed(1)}p | TP2 ${tp2Distance.toFixed(1)}p | TP3 ${tp3Distance.toFixed(1)}p | SL ${dynamicSlPips.toFixed(1)}p -> RR@TP3 ${(tp3Distance / Math.max(dynamicSlPips, 1)).toFixed(2)}:1`);
    
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
      macroWarning: macroEvent,
      riskJustification,
      learningContext: {
        rsi: features.rsi,
        atr: features.atr,
        volumeRatio: features.volumeRatio,
        dxyChange: features.dxyChange,
        timeWindowFactor: features.timeWindowFactor,
        sentiment: features.sentiment ?? { score: 0, confidence: 0, source: 'engine-default' },
      },
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
        console.log(`   Time: ${new Date(previousCandle.timestamp).toLocaleTimeString()}`);
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

    const isCounterTrend = (
      (signalType === 'BUY' && htfTrend === 'BEARISH') ||
      (signalType === 'SELL' && htfTrend === 'BULLISH') ||
      (signalType === 'BUY' && htfTrend === 'NEUTRAL' && features.rsi < 35) ||
      (signalType === 'SELL' && htfTrend === 'NEUTRAL' && features.rsi > 65)
    );

    console.log(`Classification: ${isPrimaryTrend ? 'PRIMARY TREND' : isCounterTrend ? 'COUNTER-TREND' : 'NEUTRAL'}`);

    if (isPrimaryTrend) {
      console.log('\n🎯 PRIMARY TREND FILTER: Checking Runway to Barriers');

      const tp2Distance = settings.tp2Pips;
      const tp3Distance = settings.tp3Pips;
      const requiredRunway = Math.max(tp2Distance * 0.95, settings.slPips * 0.7);
      const tp2Target = signalType === 'BUY' ? currentPrice + (tp2Distance * pipValue) : currentPrice - (tp2Distance * pipValue);

      console.log(`   Fixed SL Risk: ${settings.slPips} pips`);
      console.log(`   TP2 Target: ${tp2Target.toFixed(1)} (${tp2Distance} pips away)`);
      console.log(`   TP3 Stretch Target: ${tp3Distance.toFixed(0)} pips`);
      console.log(`   Required Runway: ${requiredRunway.toFixed(0)} pips (TP2 clearance + managed-runner protection)`);

      let nearestBarrierDistance = Infinity;
      let barrierType = 'None';

      if (signalType === 'BUY') {
        const bearishOBs = features.orderBlocks.filter(ob => ob.type === 'BEARISH' && ob.price > currentPrice);
        const resistanceLevels = [features.r1, features.r2, features.r3].filter(r => r > currentPrice);

        bearishOBs.forEach(ob => {
          const distance = (ob.price - currentPrice) / pipValue;
          if (distance < nearestBarrierDistance) {
            nearestBarrierDistance = distance;
            barrierType = `Bearish OB @ ${ob.price.toFixed(1)}`;
          }
        });

        resistanceLevels.forEach(level => {
          const distance = (level - currentPrice) / pipValue;
          if (distance < nearestBarrierDistance) {
            nearestBarrierDistance = distance;
            barrierType = `Resistance @ ${level.toFixed(1)}`;
          }
        });
      } else {
        const bullishOBs = features.orderBlocks.filter(ob => ob.type === 'BULLISH' && ob.price < currentPrice);
        const supportLevels = [features.s1, features.s2, features.s3].filter(s => s < currentPrice);

        bullishOBs.forEach(ob => {
          const distance = (currentPrice - ob.price) / pipValue;
          if (distance < nearestBarrierDistance) {
            nearestBarrierDistance = distance;
            barrierType = `Bullish OB @ ${ob.price.toFixed(1)}`;
          }
        });

        supportLevels.forEach(level => {
          const distance = (currentPrice - level) / pipValue;
          if (distance < nearestBarrierDistance) {
            nearestBarrierDistance = distance;
            barrierType = `Support @ ${level.toFixed(1)}`;
          }
        });
      }

      console.log(`   Nearest Barrier: ${barrierType} (${nearestBarrierDistance.toFixed(1)} pips away)`);

      if (nearestBarrierDistance < requiredRunway) {
        const reason = `PRIMARY TREND REJECTED: Insufficient runway (${nearestBarrierDistance.toFixed(0)} pips < ${requiredRunway.toFixed(0)} pips required)`;
        const tip = `Price must have ${requiredRunway.toFixed(0)} pips clear space to ${barrierType} so TP2 remains achievable before the next barrier. Market is still too compressed.`;
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

      if (signalType === 'BUY') {
        const bullishOBs = features.orderBlocks.filter(ob => ob.type === 'BULLISH' && Math.abs(ob.price - currentPrice) < bounceThreshold);
        const supportLevels = [features.s2, features.s3].filter(s => Math.abs(s - currentPrice) < bounceThreshold);

        if (bullishOBs.length > 0) {
          nearMajorLevel = true;
          levelDescription = `Bullish OB @ ${bullishOBs[0].price.toFixed(1)} (Strength: ${(bullishOBs[0].strength * 100).toFixed(0)}%)`;
        } else if (supportLevels.length > 0) {
          nearMajorLevel = true;
          levelDescription = `Support Level @ ${supportLevels[0].toFixed(1)}`;
        }
      } else {
        const bearishOBs = features.orderBlocks.filter(ob => ob.type === 'BEARISH' && Math.abs(ob.price - currentPrice) < bounceThreshold);
        const resistanceLevels = [features.r2, features.r3].filter(r => Math.abs(r - currentPrice) < bounceThreshold);

        if (bearishOBs.length > 0) {
          nearMajorLevel = true;
          levelDescription = `Bearish OB @ ${bearishOBs[0].price.toFixed(1)} (Strength: ${(bearishOBs[0].strength * 100).toFixed(0)}%)`;
        } else if (resistanceLevels.length > 0) {
          nearMajorLevel = true;
          levelDescription = `Resistance Level @ ${resistanceLevels[0].toFixed(1)}`;
        }
      }

      console.log(`   Bounce Threshold: ${bounceThreshold} pips`);
      console.log(`   Near Major Level: ${nearMajorLevel ? 'YES' : 'NO'}`);
      if (nearMajorLevel) {
        console.log(`   Level: ${levelDescription}`);
      }

      if (!nearMajorLevel) {
        const reason = `COUNTER-TREND REJECTED: Not bouncing off major structural level`;
        const tip = `Counter-trend signals require price within ${bounceThreshold} pips of Bullish/Bearish OB or major S2/R2/S3/R3 pivot.`;
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

  private recordNearMiss(signalType: SignalType, confidence: number, strengthDiff: number, reason: string): void {
    // Proposal #11: Setup brewing telemetry
    const inConfBand = confidence >= NEAR_MISS_CONFIDENCE_LOW && confidence < NEAR_MISS_CONFIDENCE_HIGH;
    const inDiffBand = strengthDiff >= NEAR_MISS_DIFF_LOW && strengthDiff < NEAR_MISS_DIFF_HIGH;
    if (!inConfBand && !inDiffBand) return;
    this.nearMisses.push({ timestamp: Date.now(), signalType, confidence, strengthDiff, reason });
    if (this.nearMisses.length > NEAR_MISS_MAX_ENTRIES) {
      this.nearMisses = this.nearMisses.slice(-NEAR_MISS_MAX_ENTRIES);
    }
    console.log(`🔍 NEAR-MISS logged: ${signalType} conf ${(confidence * 100).toFixed(1)}% diff ${strengthDiff.toFixed(3)} - ${reason}`);
  }

  getRecentNearMisses(): { timestamp: number; signalType: SignalType; confidence: number; strengthDiff: number; reason: string }[] {
    return [...this.nearMisses].reverse();
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

  private computeRoomToSR(signalType: SignalType, features: MarketFeatures): number {
    const price = this.currentPrice;
    const pip = 0.1;
    if (signalType === 'BUY') {
      const barriers = [features.r1, features.r2, features.r3, ...features.orderBlocks.filter(o => o.type === 'BEARISH').map(o => o.price)].filter(p => p > price);
      if (barriers.length === 0) return 200;
      return (Math.min(...barriers) - price) / pip;
    } else {
      const barriers = [features.s1, features.s2, features.s3, ...features.orderBlocks.filter(o => o.type === 'BULLISH').map(o => o.price)].filter(p => p < price);
      if (barriers.length === 0) return 200;
      return (price - Math.max(...barriers)) / pip;
    }
  }

  setLastKnownSpread(spreadPips: number): void {
    if (spreadPips > 0 && spreadPips < 20) {
      this.lastKnownSpreadPips = spreadPips;
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
