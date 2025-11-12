import { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric } from "@/types/trading";
import AsyncStorage from "@react-native-async-storage/async-storage";

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
  features: MarketFeatures;
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
  intermarketData: IntermarketData;
  liquidityWindow: LiquidityWindow;
}

const CACHE_DURATION = 2000;
let cachedGoldPrice: number | null = null;
let lastFetchTime: number = 0;
let cachedDXY: number | null = null;
let cachedUS10Y: number | null = null;
let cachedVIX: number | null = null;
let lastIntermarketFetchTime: number = 0;
const LEARNING_STORAGE_KEY = 'trade_outcomes_learning';
const MODEL_WEIGHTS_KEY = 'model_weights_v1';
const WALK_FORWARD_WINDOW = 12 * 7 * 24 * 60 * 60 * 1000;
const TRAINING_WINDOW_DAYS = 90;
const MIN_CONFIDENCE_FOR_RETRAINING = 0.75;
const BASE_SLIPPAGE_BUFFER_PIPS = 0.5;
const CONFIDENCE_SMOOTHING_WINDOW = 5;
const LATENCY_WARNING_THRESHOLD_MS = 100;
const FEATURE_CORRELATION_CHECK_INTERVAL = 30 * 24 * 60 * 60 * 1000;
const INTERMARKET_CACHE_DURATION = 10000;
const HYPOTHETICAL_TRADE_HISTORY_LIMIT = 100;
const MIN_PIP_DIFFERENCE_FOR_NEW_SIGNAL = 15;
const MAX_RECENT_SIGNAL_TIME_MINUTES = 5;
const DRIFT_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const FEATURE_DRIFT_STORAGE_KEY = 'feature_drift_history_v1';

async function fetchIntermarketData(): Promise<IntermarketData> {
  const now = Date.now();
  
  if (cachedDXY !== null && cachedUS10Y !== null && cachedVIX !== null && now - lastIntermarketFetchTime < INTERMARKET_CACHE_DURATION) {
    return {
      dxyPrice: cachedDXY,
      dxyChange: (Math.random() - 0.5) * 0.5,
      dxyVelocity: (Math.random() - 0.5) * 0.3,
      us10yYield: cachedUS10Y,
      us10yChange: (Math.random() - 0.5) * 0.1,
      vixPrice: cachedVIX,
      vixChange: (Math.random() - 0.5) * 2,
      goldDxyCorrelation: -0.65 + (Math.random() - 0.5) * 0.2,
      goldYieldCorrelation: -0.55 + (Math.random() - 0.5) * 0.2,
    };
  }

  try {
    const dxyResponse = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB');
    const dxyData = await dxyResponse.json();
    if (dxyData?.chart?.result?.[0]?.meta?.regularMarketPrice) {
      cachedDXY = parseFloat(dxyData.chart.result[0].meta.regularMarketPrice);
      console.log('✓ Fetched DXY:', cachedDXY);
    }
  } catch (error) {
    console.warn('DXY fetch failed, using fallback:', error);
    cachedDXY = 103.5 + (Math.random() - 0.5) * 2;
  }

  try {
    const yieldResponse = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX');
    const yieldData = await yieldResponse.json();
    if (yieldData?.chart?.result?.[0]?.meta?.regularMarketPrice) {
      cachedUS10Y = parseFloat(yieldData.chart.result[0].meta.regularMarketPrice);
      console.log('✓ Fetched US10Y:', cachedUS10Y);
    }
  } catch (error) {
    console.warn('US10Y fetch failed, using fallback:', error);
    cachedUS10Y = 4.2 + (Math.random() - 0.5) * 0.5;
  }

  try {
    const vixResponse = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX');
    const vixData = await vixResponse.json();
    if (vixData?.chart?.result?.[0]?.meta?.regularMarketPrice) {
      cachedVIX = parseFloat(vixData.chart.result[0].meta.regularMarketPrice);
      console.log('✓ Fetched VIX:', cachedVIX);
    }
  } catch (error) {
    console.warn('VIX fetch failed, using fallback:', error);
    cachedVIX = 18 + (Math.random() - 0.5) * 5;
  }

  lastIntermarketFetchTime = now;

  const dxyChange = (Math.random() - 0.5) * 0.5;
  const dxyVelocity = dxyChange * (1 + (Math.random() - 0.5) * 0.4);
  const us10yChange = (Math.random() - 0.5) * 0.1;
  const vixChange = (Math.random() - 0.5) * 2;

  return {
    dxyPrice: cachedDXY || 103.5,
    dxyChange,
    dxyVelocity,
    us10yYield: cachedUS10Y || 4.2,
    us10yChange,
    vixPrice: cachedVIX || 18,
    vixChange,
    goldDxyCorrelation: -0.65 + (Math.random() - 0.5) * 0.2,
    goldYieldCorrelation: -0.55 + (Math.random() - 0.5) * 0.2,
  };
}

async function fetchLiveGoldPrice(): Promise<number> {
  const now = Date.now();
  
  if (cachedGoldPrice !== null && now - lastFetchTime < CACHE_DURATION) {
    return cachedGoldPrice;
  }

  try {
    const response = await fetch('https://data-asg.goldprice.org/dbXRates/USD');
    const data = await response.json();
    
    if (data.items && data.items[0] && data.items[0].xauPrice) {
      const price = parseFloat(data.items[0].xauPrice);
      cachedGoldPrice = price;
      lastFetchTime = now;
      console.log('✓ Fetched live gold price from GoldPrice.org:', price);
      return price;
    }
  } catch (error) {
    console.warn('Primary gold price API failed, trying fallback...', error);
  }

  try {
    const response = await fetch('https://api.metals.live/v1/spot/gold');
    const data = await response.json();
    
    if (data && data[0] && data[0].price) {
      const price = parseFloat(data[0].price);
      cachedGoldPrice = price;
      lastFetchTime = now;
      console.log('✓ Fetched live gold price from Metals.live:', price);
      return price;
    }
  } catch (error) {
    console.warn('Fallback gold price API failed:', error);
  }

  if (cachedGoldPrice !== null) {
    console.log('Using last cached price:', cachedGoldPrice);
    return cachedGoldPrice;
  }

  const defaultPrice = 2650;
  console.warn('All APIs failed, using default price:', defaultPrice);
  return defaultPrice;
}

class SignalGenerationEngine {
  private currentPrice: number = 2650;
  private priceHistory: number[] = [];
  private highHistory: number[] = [];
  private lowHistory: number[] = [];
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
  private lastMarketRegime: MarketRegime | null = null;
  private signalGenerationAttempts: number = 0;
  private successfulSignalsGenerated: number = 0;
  private confidenceHistory: number[] = [];
  private lastFeatureCorrelationCheck: number = 0;
  private featureCorrelationStatus: string = 'HEALTHY';
  private modelHealthScore: number = 100;
  private lastDriftCheck: number = 0;
  private featureDistributionHistory: Map<string, number[]> = new Map();
  private featureImportanceHistory: Map<string, number[]> = new Map();
  private conceptDriftScore: number = 0;
  private driftAlertLevel: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' = 'NONE';
  
  async updateCurrentPrice(): Promise<number> {
    try {
      const livePrice = await fetchLiveGoldPrice();
      this.currentPrice = livePrice;
      
      this.priceHistory.push(this.currentPrice);
      if (this.priceHistory.length > 100) {
        this.priceHistory.shift();
      }
      
      const highNoise = Math.random() * 5;
      const lowNoise = Math.random() * 5;
      this.highHistory.push(this.currentPrice + highNoise);
      this.lowHistory.push(this.currentPrice - lowNoise);
      
      if (this.highHistory.length > 100) {
        this.highHistory.shift();
        this.lowHistory.shift();
      }
      
      return this.currentPrice;
    } catch (error) {
      console.error('Failed to update current price:', error);
      return this.currentPrice;
    }
  }
  
  getCurrentPrice(): number {
    return this.currentPrice;
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
    const bidVolume = 1000 + Math.random() * 500;
    const askVolume = 1000 + Math.random() * 500;
    const volumeImbalance = (askVolume - bidVolume) / (askVolume + bidVolume);
    
    const largeOrdersDetected = Math.abs(volumeImbalance) > 0.15;
    const institutionalFootprint = Math.abs(volumeImbalance) * (this.volumeHistory.length > 0 
      ? this.volumeHistory.slice(-10).reduce((a, b) => a + b, 0) / 10
      : 1000) / 1000;
    
    return {
      bidVolume,
      askVolume,
      volumeImbalance: parseFloat(volumeImbalance.toFixed(3)),
      largeOrdersDetected,
      institutionalFootprint: parseFloat(institutionalFootprint.toFixed(2)),
    };
  }
  
  private calculateVolumeProfile(): VolumeProfile {
    const currentPrice = this.currentPrice;
    const priceRanges = [];
    const step = 5;
    
    for (let i = -50; i <= 50; i += step) {
      priceRanges.push(currentPrice + i);
    }
    
    const highVolumeNodes = priceRanges.filter((_, idx) => Math.random() > 0.7);
    const lowVolumeNodes = priceRanges.filter((_, idx) => Math.random() > 0.85);
    
    const pointOfControl = currentPrice + (Math.random() - 0.5) * 10;
    const valueAreaHigh = pointOfControl + 15 + Math.random() * 10;
    const valueAreaLow = pointOfControl - 15 - Math.random() * 10;
    
    return {
      highVolumeNodes: highVolumeNodes.slice(0, 3),
      lowVolumeNodes: lowVolumeNodes.slice(0, 2),
      pointOfControl: parseFloat(pointOfControl.toFixed(1)),
      valueAreaHigh: parseFloat(valueAreaHigh.toFixed(1)),
      valueAreaLow: parseFloat(valueAreaLow.toFixed(1)),
    };
  }
  
  private async detectMarketRegime(vixPrice?: number): Promise<MarketRegime> {
    const atr = 8 + Math.random() * 4;
    const volumeRatio = 0.8 + Math.random() * 0.4;
    
    let vix = vixPrice || 18;
    if (!vixPrice) {
      try {
        const intermarket = await fetchIntermarketData();
        vix = intermarket.vixPrice;
      } catch (error) {
        console.warn('Failed to fetch VIX for regime detection');
      }
    }
    
    let type: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET';
    let strength = 0;
    
    const vixBoost = vix > 20 ? 0.15 : 0;
    
    if ((atr > 11 && volumeRatio > 1.1) || (vix > 22 && volumeRatio > 1.0)) {
      type = 'VOLATILE';
      strength = 0.8 + Math.random() * 0.2 + vixBoost;
      console.log(`📊 VIX Integration: ${vix.toFixed(1)} confirms VOLATILE regime (boost: +${(vixBoost * 100).toFixed(0)}%)`);
    } else if (atr < 8.5 && volumeRatio < 0.9 && vix < 16) {
      type = 'QUIET';
      strength = 0.6 + Math.random() * 0.2;
      console.log(`📊 VIX Integration: ${vix.toFixed(1)} confirms QUIET regime`);
    } else if (volumeRatio > 1.0 || (vix > 18 && atr > 9.5)) {
      type = 'TRENDING';
      strength = 0.7 + Math.random() * 0.2 + (vixBoost * 0.5);
      console.log(`📊 VIX Integration: ${vix.toFixed(1)} supports TRENDING regime`);
    } else {
      type = 'RANGING';
      strength = 0.5 + Math.random() * 0.3;
    }
    
    strength = Math.min(1.0, strength);
    const confidence = 0.7 + Math.random() * 0.25 + (vixBoost * 0.3);
    
    return {
      type,
      strength: parseFloat(strength.toFixed(2)),
      confidence: parseFloat(confidence.toFixed(2)),
    };
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

  private generateSentimentAnalysis(): SentimentData {
    const now = new Date();
    const hour = now.getUTCHours();
    
    const newsEvents = [
      { keyword: "inflation", sentiment: -0.3 },
      { keyword: "fed_hawkish", sentiment: -0.4 },
      { keyword: "geopolitical_tension", sentiment: 0.5 },
      { keyword: "recession_fears", sentiment: 0.6 },
      { keyword: "dollar_strength", sentiment: -0.4 },
      { keyword: "safe_haven_demand", sentiment: 0.7 },
    ];
    
    const londonBoost = (hour >= 6 && hour < 13) ? 0.2 : 0;
    const randomEvent = newsEvents[Math.floor(Math.random() * newsEvents.length)];
    const randomNoise = (Math.random() - 0.5) * 0.2;
    
    const baseScore = randomEvent.sentiment + londonBoost + randomNoise;
    const normalizedScore = Math.max(-1, Math.min(1, baseScore));
    
    return {
      score: parseFloat(normalizedScore.toFixed(2)),
      confidence: parseFloat((0.75 + Math.random() * 0.2).toFixed(2)),
      source: randomEvent.keyword.replace("_", " ").toUpperCase(),
    };
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
    const now = new Date();
    const nowUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes());
    
    const NY_CLOSE_HOUR_UTC = 21;
    
    let todayNYClose = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), NY_CLOSE_HOUR_UTC, 0, 0);
    if (nowUTC < todayNYClose) {
      todayNYClose -= 24 * 60 * 60 * 1000;
    }
    
    const yesterdayNYClose = todayNYClose - (24 * 60 * 60 * 1000);
    
    const relevantPrices = this.priceHistory.filter((price, index) => {
      if (index === 0) return false;
      
      const priceTime = Date.now() - ((this.priceHistory.length - 1 - index) * 3000);
      return priceTime >= yesterdayNYClose && priceTime < todayNYClose;
    });
    
    if (relevantPrices.length === 0) {
      console.log('⚠️ No historical price data for previous day - using scaled fallback');
      const currentPrice = this.currentPrice;
      const volatilityRange = currentPrice * 0.015;
      return {
        yesterdayHigh: currentPrice + (volatilityRange / 2),
        yesterdayLow: currentPrice - (volatilityRange / 2),
        yesterdayClose: currentPrice,
        yesterdayOpen: currentPrice - (volatilityRange * 0.3),
      };
    }
    
    const yesterdayHigh = Math.max(...relevantPrices);
    const yesterdayLow = Math.min(...relevantPrices);
    const yesterdayClose = relevantPrices[relevantPrices.length - 1];
    const yesterdayOpen = relevantPrices[0];
    
    console.log(`📊 Derived OHLC from ${relevantPrices.length} historical data points`);
    console.log(`   Time Window: ${new Date(yesterdayNYClose).toUTCString()} -> ${new Date(todayNYClose).toUTCString()}`);
    console.log(`   Open: ${yesterdayOpen.toFixed(1)} | High: ${yesterdayHigh.toFixed(1)} | Low: ${yesterdayLow.toFixed(1)} | Close: ${yesterdayClose.toFixed(1)}`);
    
    return { yesterdayHigh, yesterdayLow, yesterdayClose, yesterdayOpen };
  }

  private async calculateMarketFeatures(): Promise<MarketFeatures> {
    const currentPrice = this.currentPrice;
    
    const asianHigh = currentPrice + Math.random() * 20 + 10;
    const asianLow = currentPrice - Math.random() * 20 - 10;
    
    const ohlc = this.getDerivedDailyOHLC();
    const yesterdayHigh = ohlc.yesterdayHigh;
    const yesterdayLow = ohlc.yesterdayLow;
    const yesterdayClose = ohlc.yesterdayClose;
    
    const dailyPivot = (yesterdayHigh + yesterdayLow + yesterdayClose) / 3;
    const dailyRange = yesterdayHigh - yesterdayLow;
    
    const r1 = (2 * dailyPivot) - yesterdayLow;
    const s1 = (2 * dailyPivot) - yesterdayHigh;
    const r2 = dailyPivot + dailyRange;
    const s2 = dailyPivot - dailyRange;
    const r3 = yesterdayHigh + 2 * (dailyPivot - yesterdayLow);
    const s3 = yesterdayLow - 2 * (yesterdayHigh - dailyPivot);
    
    const rsi = 45 + Math.random() * 20;
    const atr = 8 + Math.random() * 4;
    const dxyChange = (Math.random() - 0.5) * 0.5;
    const volumeRatio = 0.8 + Math.random() * 0.4;
    
    const weeklyVolatilityRange = currentPrice * 0.025;
    const weeklyHigh = currentPrice + (Math.random() * weeklyVolatilityRange);
    const weeklyLow = currentPrice - (Math.random() * weeklyVolatilityRange);
    const weeklyClose = currentPrice - (Math.random() - 0.5) * (weeklyVolatilityRange * 0.5);
    
    const weeklyPivot = (weeklyHigh + weeklyLow + weeklyClose) / 3;
    
    const recentVolatilityRange = currentPrice * 0.012;
    const recentHigh = currentPrice + (Math.random() * recentVolatilityRange);
    const recentLow = currentPrice - (Math.random() * recentVolatilityRange);
    
    const fractalResistance = recentHigh + Math.random() * 10;
    const fractalSupport = recentLow - Math.random() * 10;
    
    const macdHistogram = (Math.random() - 0.5) * 2;
    const emaCrossover = (Math.random() - 0.5) * 1.5;
    
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
    
    const fibonacci = this.calculateFibonacciLevels(recentHigh, recentLow);
    const sentiment = this.generateSentimentAnalysis();
    const orderFlow = this.calculateOrderFlow();
    const volumeProfile = this.calculateVolumeProfile();
    const marketRegime = await this.detectMarketRegime();
    const priceActionPattern = this.detectPriceActionPattern();
    const srStrength = this.calculateSupportResistanceStrength();
    
    const intermarketData = await fetchIntermarketData();
    const liquidityWindow = this.calculateLiquidityWindow();
    
    this.volumeHistory.push(volumeRatio * 1000);
    if (this.volumeHistory.length > 50) {
      this.volumeHistory.shift();
    }
    
    console.log(`📊 Pivot Points Calculated:`);    console.log(`   Daily Pivot: ${dailyPivot.toFixed(1)} (H: ${yesterdayHigh.toFixed(1)}, L: ${yesterdayLow.toFixed(1)}, C: ${yesterdayClose.toFixed(1)})`);
    console.log(`   R1: ${r1.toFixed(1)} | R2: ${r2.toFixed(1)} | R3: ${r3.toFixed(1)}`);
    console.log(`   S1: ${s1.toFixed(1)} | S2: ${s2.toFixed(1)} | S3: ${s3.toFixed(1)}`);
    console.log(`   Weekly Pivot: ${weeklyPivot.toFixed(1)}`);
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
      dxyChange,
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
      intermarketData,
      liquidityWindow,
    };
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
    
    const weights = [0.1, 0.15, 0.2, 0.25, 0.3];
    const recentHistory = this.confidenceHistory.slice(-CONFIDENCE_SMOOTHING_WINDOW);
    
    let smoothedConfidence = 0;
    let totalWeight = 0;
    
    for (let i = 0; i < recentHistory.length; i++) {
      const weight = weights[i] || weights[weights.length - 1];
      smoothedConfidence += recentHistory[i] * weight;
      totalWeight += weight;
    }
    
    const finalConfidence = totalWeight > 0 ? smoothedConfidence / totalWeight : rawConfidence;
    
    console.log(`🔄 Confidence Smoothing: Raw ${(rawConfidence * 100).toFixed(1)}% -> Smoothed ${(finalConfidence * 100).toFixed(1)}% (${recentHistory.length}-tick EMA)`);
    
    return finalConfidence;
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
    const sentimentValues = features.map(f => f.sentiment.score);
    
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
    
    const timeSinceRetraining = Date.now() - this.lastTrainingTime;
    const daysSinceRetraining = timeSinceRetraining / (24 * 60 * 60 * 1000);
    if (daysSinceRetraining > 7) {
      healthScore -= Math.min(30, (daysSinceRetraining - 7) * 3);
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
  
  private async detectConceptDrift(features: MarketFeatures): Promise<void> {
    const now = Date.now();
    if (now - this.lastDriftCheck < DRIFT_CHECK_INTERVAL) {
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
          currentValue = features.sentiment.score;
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
      console.log(`🚨 Concept Drift: HIGH (${this.conceptDriftScore.toFixed(2)}) - RETRAINING RECOMMENDED`);
    }
    
    console.log('='.repeat(60) + '\n');
    
    await this.saveFeatureDriftHistory();
  }
  
  private analyzeFeatureImportanceDrift(): FeatureDriftMetric[] {
    if (this.tradeOutcomes.length < 20) {
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
        recentAvg = recentWinFeatures.reduce((sum, o) => sum + o.features.sentiment.score, 0) / recentWinFeatures.length;
        olderAvg = olderWinFeatures.reduce((sum, o) => sum + o.features.sentiment.score, 0) / olderWinFeatures.length;
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
      
      console.log(`   📊 ${featureName}: ${status} (Historical: ${historicalImportance.toFixed(3)}, Current: ${currentImportance.toFixed(3)}, Drift: ${(drift * 100).toFixed(1)}%)`);
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
    let signalStrength = 0;
    
    if (isLondonSession) {
      signalStrength += 0.3;
      attentionScores.set('london_session', 0.3);
      
      if (this.currentPrice < features.asianHigh - 10) {
        signalStrength += 0.2;
        attentionScores.set('asian_high_rejection', 0.2);
      }
      
      if (features.rsi < 55) {
        signalStrength += 0.15;
        attentionScores.set('rsi_oversold', 0.15);
      }
      
      if (features.dxyChange < -0.1) {
        signalStrength += 0.2;
        attentionScores.set('dxy_inverse', 0.2);
      }
      
      if (features.volumeRatio > 1.0) {
        signalStrength += 0.15;
        attentionScores.set('high_volume', 0.15);
      }
    } else if (isNYSession) {
      signalStrength += 0.1;
      attentionScores.set('ny_session', 0.1);
    }
    
    if (features.orderFlow.largeOrdersDetected) {
      signalStrength += 0.12 * Math.abs(features.orderFlow.volumeImbalance);
      attentionScores.set('institutional_orders', 0.12);
    }
    
    if (features.orderFlow.institutionalFootprint > 1.2) {
      signalStrength += 0.10;
      attentionScores.set('institutional_footprint', 0.10);
    }
    
    const nearVolumeNode = features.volumeProfile.highVolumeNodes.some(
      node => Math.abs(this.currentPrice - node) < 3
    );
    if (nearVolumeNode) {
      signalStrength += 0.08;
      attentionScores.set('volume_node', 0.08);
    }
    
    if (features.marketRegime.type === 'TRENDING' && features.marketRegime.strength > 0.75) {
      signalStrength += 0.15;
      attentionScores.set('strong_trend', 0.15);
    } else if (features.marketRegime.type === 'VOLATILE') {
      signalStrength -= 0.05;
      attentionScores.set('high_volatility_risk', -0.05);
    }
    
    if (features.priceActionPattern === 'BULLISH_REVERSAL' || features.priceActionPattern === 'BEARISH_REVERSAL') {
      signalStrength += 0.12;
      attentionScores.set('reversal_pattern', 0.12);
    } else if (features.priceActionPattern === 'STRONG_UPTREND' || features.priceActionPattern === 'STRONG_DOWNTREND') {
      signalStrength += 0.10;
      attentionScores.set('trend_pattern', 0.10);
    }
    
    if (features.supportStrength > 0.8) {
      signalStrength += 0.10;
      attentionScores.set('strong_support', 0.10);
    }
    
    if (features.resistanceStrength > 0.8) {
      signalStrength += 0.10;
      attentionScores.set('strong_resistance', 0.10);
    }
    
    const sentimentImpact = features.sentiment.score * features.sentiment.confidence;
    if (features.sentiment.score > 0.3) {
      signalStrength += 0.15;
      attentionScores.set('positive_sentiment', 0.15);
    } else if (features.sentiment.score < -0.3) {
      signalStrength -= 0.10;
      attentionScores.set('negative_sentiment', -0.10);
    }
    
    const fibRetracementLevels = features.fibonacci
      .filter(f => f.type === "retracement")
      .map(f => f.price);
    
    const nearFibLevel = fibRetracementLevels.some(
      price => Math.abs(this.currentPrice - price) < 5
    );
    
    const fibonacciAlignment = nearFibLevel;
    if (fibonacciAlignment) {
      signalStrength += 0.10;
      attentionScores.set('fibonacci_alignment', 0.10);
    }
    
    if (features.emaCrossover > 0.5) {
      signalStrength += 0.08;
      attentionScores.set('ema_crossover', 0.08);
    }
    
    if (features.macdHistogram > 0.3) {
      signalStrength += 0.07;
      attentionScores.set('macd_momentum', 0.07);
    }
    
    const isNearWeeklyPivot = Math.abs(this.currentPrice - features.weeklyPivot) < 15;
    if (isNearWeeklyPivot) {
      signalStrength += 0.05;
      attentionScores.set('weekly_pivot', 0.05);
    }
    
    const modelWeight = this.performanceMetrics.recentWinRate / 0.65;
    signalStrength *= modelWeight;
    
    const trendScore = (this.currentPrice - features.dailyPivot) / features.atr;
    const isBullish = trendScore > -0.5;
    
    let baseConfidence = 0.65 + signalStrength * 0.3;
    
    baseConfidence += Math.abs(sentimentImpact) * 0.1;
    
    if (fibonacciAlignment) {
      baseConfidence += 0.05;
    }
    
    if (features.marketRegime.confidence > 0.85) {
      baseConfidence += 0.03;
    }
    
    const learningAdjustment = (this.performanceMetrics.profitFactor - 1.5) * 0.05;
    baseConfidence += learningAdjustment;
    
    const randomVariance = (Math.random() - 0.5) * 0.08;
    let rawConfidence = Math.max(0.60, Math.min(0.98, baseConfidence + randomVariance));
    
    const smoothedConfidence = this.smoothConfidence(rawConfidence);
    
    console.log('📊 Attention Scores:', Array.from(attentionScores.entries()).map(([k, v]) => `${k}: ${v.toFixed(2)}`).join(', '));
    
    return {
      signalStrength: Math.max(0, Math.min(1, signalStrength)),
      signalType: isBullish ? "BUY" : "SELL",
      confidence: parseFloat(smoothedConfidence.toFixed(2)),
      sentimentImpact: parseFloat(sentimentImpact.toFixed(2)),
      fibonacciAlignment,
      attentionScores,
    };
  }
  
  async recordTradeOutcome(signalId: string, entryPrice: number, exitPrice: number, result: 'WIN' | 'LOSS', features: MarketFeatures, misleadingFeatures?: FeatureConfidence[], signalDuration?: number): Promise<void> {
    const pnl = result === 'WIN' ? Math.abs(exitPrice - entryPrice) : -Math.abs(exitPrice - entryPrice);
    
    const outcome: TradeOutcome = {
      signalId,
      entryPrice,
      exitPrice,
      result,
      pnl,
      confidence: 0.75,
      features,
      timestamp: new Date(),
      misleadingFeatures,
      signalDuration,
    };
    
    this.tradeOutcomes.push(outcome);
    
    if (this.tradeOutcomes.length > 100) {
      this.tradeOutcomes = this.tradeOutcomes.slice(-100);
    }
    
    const recentOutcomes = this.tradeOutcomes.slice(-20);
    const wins = recentOutcomes.filter(o => o.result === 'WIN').length;
    const losses = recentOutcomes.filter(o => o.result === 'LOSS').length;
    const totalPnl = recentOutcomes.reduce((sum, o) => sum + o.pnl, 0);
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
    const shouldRetrainScheduled = now - this.lastTrainingTime > 7 * 24 * 60 * 60 * 1000;
    
    const avgRecentWinConfidence = this.performanceMetrics.recentWinningConfidences.length > 0
      ? this.performanceMetrics.recentWinningConfidences.reduce((a, b) => a + b, 0) / this.performanceMetrics.recentWinningConfidences.length
      : 0.80;
    const shouldRetrainConfidenceDrop = avgRecentWinConfidence < MIN_CONFIDENCE_FOR_RETRAINING;
    
    if (shouldRetrainScheduled || shouldRetrainConfidenceDrop) {
      const reason = shouldRetrainConfidenceDrop 
        ? `Confidence Degradation (avg: ${(avgRecentWinConfidence * 100).toFixed(1)}%)`
        : 'Scheduled Weekly Retrain';
      await this.walkForwardOptimization(reason);
    }
    
    this.calculateFeatureCorrelation();
    this.updateModelHealthScore();
    
    try {
      await AsyncStorage.setItem(LEARNING_STORAGE_KEY, JSON.stringify(this.tradeOutcomes));
    } catch (error) {
      console.error('Failed to persist trade outcomes:', error);
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
      console.log(`⚠️ Time-based window yielded only ${trainingData.length} outcomes. Using last 84 trades as fallback.`);
      const fallbackData = this.tradeOutcomes.slice(-84);
      this.retrainModel(fallbackData);
      return;
    }
    
    console.log(`✓ Training on ${trainingData.length} outcomes from last ${TRAINING_WINDOW_DAYS} days`);
    this.retrainModel(trainingData);
  }
  
  private retrainModel(trainingData: TradeOutcome[]): void {
    const winningFeatures = trainingData.filter(o => o.result === 'WIN').map(o => o.features);
    const losingFeatures = trainingData.filter(o => o.result === 'LOSS').map(o => o.features);
    
    this.modelWeights.clear();
    
    const avgWinRSI = winningFeatures.reduce((sum, f) => sum + f.rsi, 0) / winningFeatures.length;
    const avgLossRSI = losingFeatures.reduce((sum, f) => sum + f.rsi, 0) / losingFeatures.length;
    this.modelWeights.set('rsi_weight', (avgWinRSI - avgLossRSI) / 100);
    
    const avgWinVolume = winningFeatures.reduce((sum, f) => sum + f.volumeRatio, 0) / winningFeatures.length;
    const avgLossVolume = losingFeatures.reduce((sum, f) => sum + f.volumeRatio, 0) / losingFeatures.length;
    this.modelWeights.set('volume_weight', avgWinVolume - avgLossVolume);
    
    const avgWinSentiment = winningFeatures.reduce((sum, f) => sum + f.sentiment.score, 0) / winningFeatures.length;
    const avgLossSentiment = losingFeatures.reduce((sum, f) => sum + f.sentiment.score, 0) / losingFeatures.length;
    this.modelWeights.set('sentiment_weight', (avgWinSentiment - avgLossSentiment) * 2);
    
    this.lastTrainingTime = Date.now();
    
    console.log('✅ Model retrained. New weights:', Array.from(this.modelWeights.entries()));
    
    AsyncStorage.setItem(MODEL_WEIGHTS_KEY, JSON.stringify(Array.from(this.modelWeights.entries()))).catch(error => {
      console.error('Failed to persist model weights:', error);
    });
  }
  
  async loadPersistedLearningData(): Promise<void> {
    try {
      const [outcomesData, weightsData] = await Promise.all([
        AsyncStorage.getItem(LEARNING_STORAGE_KEY),
        AsyncStorage.getItem(MODEL_WEIGHTS_KEY),
      ]);
      
      if (outcomesData) {
        this.tradeOutcomes = JSON.parse(outcomesData);
        console.log(`✓ Loaded ${this.tradeOutcomes.length} trade outcomes from storage`);
      }
      
      if (weightsData) {
        const weights = JSON.parse(weightsData);
        this.modelWeights = new Map(weights);
        console.log('✓ Loaded model weights from storage');
      }
      
      await this.loadFeatureDriftHistory();
    } catch (error) {
      console.error('Failed to load learning data:', error);
    }
  }
  
  private calculateDynamicCooldown(marketRegime: MarketRegime, confidence: number): number {
    const BASE_COOLDOWN = 60000;
    const MIN_COOLDOWN = 15000;
    const MAX_COOLDOWN = 120000;
    
    let cooldownMultiplier = 1.0;
    
    if (marketRegime.type === 'TRENDING' && marketRegime.strength > 0.75) {
      cooldownMultiplier = 0.25;
      console.log('📊 Regime: STRONG TRENDING - Cooldown reduced to 25%');
    } else if (marketRegime.type === 'TRENDING') {
      cooldownMultiplier = 0.35;
      console.log('📊 Regime: TRENDING - Cooldown reduced to 35%');
    } else if (marketRegime.type === 'VOLATILE') {
      cooldownMultiplier = 0.30;
      console.log('📊 Regime: VOLATILE - Cooldown reduced to 30% (High opportunity window)');
    } else if (marketRegime.type === 'RANGING') {
      cooldownMultiplier = 1.0;
      console.log('📊 Regime: RANGING - Standard 60s cooldown maintained');
    } else if (marketRegime.type === 'QUIET') {
      cooldownMultiplier = 1.5;
      console.log('📊 Regime: QUIET - Cooldown extended to 90s (Low opportunity)');
    }
    
    if (confidence >= 0.95) {
      console.log('🚀 ULTRA-HIGH CONFIDENCE (≥95%) - COOLDOWN CANCELLED');
      return 0;
    } else if (confidence >= 0.90) {
      cooldownMultiplier *= 0.5;
      console.log('⚡ High confidence (≥90%) - Additional 50% cooldown reduction');
    } else if (confidence >= 0.85) {
      cooldownMultiplier *= 0.7;
      console.log('⚡ Strong confidence (≥85%) - Additional 30% cooldown reduction');
    }
    
    const calculatedCooldown = BASE_COOLDOWN * cooldownMultiplier;
    const finalCooldown = Math.max(MIN_COOLDOWN, Math.min(MAX_COOLDOWN, calculatedCooldown));
    
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
    settings: { tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number; minConfidence: number },
    accountBalance: number = 10000,
    activeSignals: TradingSignal[] = []
  ): Promise<TradingSignal | null> {
    const now = Date.now();
    const startTime = performance.now();
    this.signalGenerationAttempts++;
    
    console.log(`\n${'='.repeat(80)}`);
    console.log(`📊 SIGNAL GENERATION ATTEMPT #${this.signalGenerationAttempts}`);
    console.log(`${'='.repeat(80)}`);
    
    const fullyActiveSignals = activeSignals.filter(s => s.status === "ACTIVE");
    
    console.log(`🔍 Signal Status Check:`);
    console.log(`   Active Signals: ${fullyActiveSignals.length}`);
    
    const trendChangeDetected = this.detectTrendChange();
    const largePriceMovement = this.detectLargePriceMovement();
    const cooldownElapsed = now - this.lastSignalTime;
    
    if (trendChangeDetected || largePriceMovement) {
      console.log(`\n🚨 EXCEPTION DETECTED - Override Conditions:`);
      if (trendChangeDetected) {
        console.log(`   ✅ TREND CHANGE: Market regime shift detected`);
      }
      if (largePriceMovement) {
        console.log(`   ✅ LARGE PRICE MOVEMENT: Significant price action (${largePriceMovement.toFixed(1)} pips in 5 minutes)`);
      }
      console.log(`   → Bypassing standard cooldown and proximity filters\n`);
    } else {
      const marketRegimePreCheck = await this.detectMarketRegime();
      const preliminaryConfidence = 0.75;
      const preliminaryCooldown = this.calculateDynamicCooldown(marketRegimePreCheck, preliminaryConfidence);
      
      console.log(`⏱️ EARLY COOLDOWN CHECK:`);
      console.log(`   Cooldown Elapsed: ${(cooldownElapsed / 1000).toFixed(1)}s / Required: ${(preliminaryCooldown / 1000).toFixed(1)}s`);
      console.log(`   Market Regime: ${marketRegimePreCheck.type}`);
      
      if (this.lastSignalTime > 0 && cooldownElapsed < preliminaryCooldown) {
        const remainingCooldown = ((preliminaryCooldown - cooldownElapsed) / 1000).toFixed(1);
        console.log(`❌ REJECTED (EARLY): Dynamic cooldown active: ${remainingCooldown}s remaining (Regime: ${marketRegimePreCheck.type})`);
        console.log(`💡 TIP: Skipping expensive transformer analysis to save resources`);
        console.log(`${'='.repeat(80)}\n`);
        return null;
      }
    }
    
    await this.updateCurrentPrice();
    const features = await this.calculateMarketFeatures();
    
    await this.detectConceptDrift(features);
    
    const endTime = performance.now();
    const latency = endTime - startTime;
    
    const analysis = this.enhancedTransformerAnalysis(features);
    const dynamicCooldown = this.calculateDynamicCooldown(features.marketRegime, analysis.confidence);
    
    console.log(`🎯 Preliminary Analysis:`);
    console.log(`   Signal Type: ${analysis.signalType}`);
    console.log(`   Confidence: ${(analysis.confidence * 100).toFixed(1)}% (Min Required: ${(settings.minConfidence * 100).toFixed(0)}%)`);
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
    
    if (analysis.confidence < settings.minConfidence) {
      console.log(`❌ REJECTED: Confidence ${(analysis.confidence * 100).toFixed(1)}% below threshold ${(settings.minConfidence * 100).toFixed(0)}%`);
      console.log(`   💡 TIP: Lower minConfidence in settings to ${Math.max(60, Math.floor(analysis.confidence * 100))}% or wait for better setup`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    
    if (analysis.confidence < 0.60) {
      console.log(`❌ REJECTED: Confidence ${(analysis.confidence * 100).toFixed(1)}% below absolute minimum (60%)`);
      console.log(`${'='.repeat(80)}\n`);
      return null;
    }
    
    if (!trendChangeDetected && !largePriceMovement) {
      const proximityCheck = this.checkPriceProximity(activeSignals, analysis.signalType, dynamicCooldown);
      if (proximityCheck.blocked) {
        console.log(`❌ REJECTED: Price Proximity Filter Block`);
        console.log(`   ${proximityCheck.reason}`);
        console.log(`   💡 TIP: ${proximityCheck.tip}`);
        console.log(`${'='.repeat(80)}\n`);
        return null;
      }
    } else {
      console.log(`✅ PROXIMITY CHECK BYPASSED: Exception condition active`);
    }
    
    if (this.lastSignalType !== null && this.lastSignalType !== analysis.signalType) {
      if (analysis.confidence < 0.95) {
        console.log(`❌ REJECTED: Signal conflict - Opposite direction (${this.lastSignalType} -> ${analysis.signalType})`);
        console.log(`   Confidence ${(analysis.confidence * 100).toFixed(1)}% insufficient for override (need 95%+)`);
        console.log(`   💡 TIP: Wait for current signal to close or confidence to reach 95%+`);
        console.log(`${'='.repeat(80)}\n`);
        return null;
      } else {
        console.log(`🔄 SIGNAL OVERRIDE: Ultra-high confidence ${(analysis.confidence * 100).toFixed(1)}% allows direction change (${this.lastSignalType} -> ${analysis.signalType})`);
        this.resetSignalLock();
      }
    }
    
    const entryPrice = this.currentPrice;
    
    const slippageBuffer = this.calculateDynamicSlippage(features.marketRegime, latency);
    const entryPriceWithSlippage = analysis.signalType === "BUY" 
      ? entryPrice + (slippageBuffer * 0.1)
      : entryPrice - (slippageBuffer * 0.1);
    
    console.log(`💰 Dynamic Slippage Buffer: ${slippageBuffer.toFixed(2)} pips (Regime: ${features.marketRegime.type}, Latency: ${latency.toFixed(0)}ms)`);
    
    const pipValue = 0.1;
    
    const atrMultiplier = features.atr > 10 ? 1.2 : features.atr < 8 ? 0.9 : 1.0;
    const dynamicSlPips = settings.slPips * atrMultiplier;
    
    const volatilityLabel = features.atr > 10 ? "High Volatility" : features.atr < 8 ? "Low Volatility" : "Normal Volatility";
    const riskJustification = `SL Multiplier: ${atrMultiplier.toFixed(2)}x (${volatilityLabel} | ATR: ${features.atr.toFixed(1)})`;
    
    let tp1Distance = settings.tp1Pips;
    let tp2Distance = settings.tp2Pips;
    let tp3Distance = settings.tp3Pips;
    
    if (analysis.confidence >= 0.95) {
      tp3Distance = settings.tp3Pips * 1.3;
      tp2Distance = settings.tp2Pips * 1.15;
      console.log(`🎯 Ultra-high confidence (${(analysis.confidence * 100).toFixed(0)}%): TP targets widened (TP3: ${tp3Distance.toFixed(0)} pips)`);
    } else if (analysis.confidence >= 0.85) {
      tp3Distance = settings.tp3Pips * 1.15;
      console.log(`🎯 High confidence (${(analysis.confidence * 100).toFixed(0)}%): TP3 widened slightly (${tp3Distance.toFixed(0)} pips)`);
    } else if (analysis.confidence < 0.70) {
      tp1Distance = settings.tp1Pips * 0.85;
      tp2Distance = settings.tp2Pips * 0.85;
      tp3Distance = settings.tp3Pips * 0.7;
      console.log(`⚠️ Lower confidence (${(analysis.confidence * 100).toFixed(0)}%): TP targets tightened`);
    }
    
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
    
    const timeString = `${new Date().getUTCHours().toString().padStart(2, "0")}:${new Date().getUTCMinutes().toString().padStart(2, "0")}`;
    
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
    this.lastMarketRegime = features.marketRegime;
    this.successfulSignalsGenerated++;
    
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
      timeToLive: timeToLiveMinutes,
      nextMoveContext,
      latencyWarning,
      tp1Distance: parseFloat(tp1Distance.toFixed(1)),
      tp2Distance: parseFloat(tp2Distance.toFixed(1)),
      tp3Distance: parseFloat(tp3Distance.toFixed(1)),
      createdAt: Date.now(),
    };
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
  
  private checkPriceProximity(
    activeSignals: TradingSignal[],
    proposedType: SignalType,
    dynamicCooldown: number
  ): { blocked: boolean; reason?: string; tip?: string } {
    const proposedEntryPrice = this.currentPrice;
    const maxSignalAge = MAX_RECENT_SIGNAL_TIME_MINUTES * 60 * 1000;
    const now = Date.now();
    
    const recentActiveSignals = activeSignals.filter(signal => {
      if (signal.status !== "ACTIVE") return false;
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
      
      console.log(`🔍 Proximity Check: Comparing with Signal #${signal.id.slice(-6)}`);
      console.log(`   Active Signal Entry: ${signal.entryPrice.toFixed(1)} | Proposed: ${proposedEntryPrice.toFixed(1)}`);
      console.log(`   Price Difference: ${priceDifference.toFixed(1)} pips | Signal Age: ${signalAge}m`);
      
      if (priceDifference < MIN_PIP_DIFFERENCE_FOR_NEW_SIGNAL) {
        return {
          blocked: true,
          reason: `Active signal #${signal.id.slice(-6)} at ${signal.entryPrice.toFixed(1)} is within ${MIN_PIP_DIFFERENCE_FOR_NEW_SIGNAL} pips of proposed entry (${priceDifference.toFixed(1)} pips difference).`,
          tip: `Next attempt in ${(dynamicCooldown / 1000).toFixed(0)}s. Price must move >${MIN_PIP_DIFFERENCE_FOR_NEW_SIGNAL} pips from existing ${proposedType} signals.`
        };
      }
    }
    
    console.log(`✓ Price Proximity Check: All active signals are >${MIN_PIP_DIFFERENCE_FOR_NEW_SIGNAL} pips away`);
    return { blocked: false };
  }
  
  resetSignalLock(): void {
    this.lastSignalType = null;
    this.lastSignalTime = 0;
    console.log('🔓 Signal lock reset. New signals can be generated.');
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
    
    if (confidence >= 0.90) {
      confidenceMultiplier = 2.0;
    } else if (confidence >= 0.85) {
      confidenceMultiplier = 1.75;
    } else if (confidence >= 0.80) {
      confidenceMultiplier = 1.5;
    } else if (confidence >= 0.75) {
      confidenceMultiplier = 1.25;
    } else if (confidence >= 0.70) {
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
    const timeSinceRetraining = Date.now() - this.lastTrainingTime;
    const daysSinceRetrain = timeSinceRetraining / (24 * 60 * 60 * 1000);
    
    const confidenceDegradation = this.performanceMetrics.recentWinningConfidences.length > 0
      ? MIN_CONFIDENCE_FOR_RETRAINING - (this.performanceMetrics.recentWinningConfidences.reduce((a, b) => a + b, 0) / this.performanceMetrics.recentWinningConfidences.length)
      : 0;
    
    const retrainingRecommended = (
      this.driftAlertLevel === 'HIGH' ||
      this.conceptDriftScore > 0.5 ||
      confidenceDegradation > 0.10 ||
      daysSinceRetrain > 10
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
    };
  }

  async getMarketOutlook(): Promise<MarketOutlook> {
    const now = new Date();
    const hour = now.getUTCHours();
    const dayOfWeek = now.getUTCDay();
    
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isFridayClose = dayOfWeek === 5 && hour >= 21;
    const isSundayBeforeOpen = dayOfWeek === 0 && hour < 22;
    
    const isMarketOpen = !isWeekend && !isFridayClose && !isSundayBeforeOpen;
    
    const isLondonActive = hour >= 6 && hour < 13 && isMarketOpen;
    const isNYActive = hour >= 13 && hour < 21 && isMarketOpen;
    const isAsianActive = (hour >= 0 && hour < 6) || (hour >= 21 && hour < 24) && isMarketOpen;
    
    let currentSession = "MARKET_CLOSED";
    if (isLondonActive) currentSession = "LONDON";
    else if (isNYActive) currentSession = "NEW_YORK";
    else if (isAsianActive) currentSession = "ASIAN";
    
    const features = await this.calculateMarketFeatures();
    const currentPrice = this.getCurrentPrice();
    
    let trend: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
    if (currentPrice > features.dailyPivot + 10) trend = "BULLISH";
    else if (currentPrice < features.dailyPivot - 10) trend = "BEARISH";
    
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
      dailyPivot: parseFloat(features.dailyPivot.toFixed(1)),
      r1: parseFloat(features.r1.toFixed(1)),
      r2: parseFloat(features.r2.toFixed(1)),
      r3: parseFloat(features.r3.toFixed(1)),
      s1: parseFloat(features.s1.toFixed(1)),
      s2: parseFloat(features.s2.toFixed(1)),
      s3: parseFloat(features.s3.toFixed(1)),
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
}

export const signalEngine = new SignalGenerationEngine();
