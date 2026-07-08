import { mkdir, readFile, writeFile as writeFileNode } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PART 2 — NOISE-FLOOR INVESTIGATION (read-only, no code changes)
 *
 * Samples ~15-20 attempts whose winningStrength landed in the 0.10-0.20
 * bucket during a 168h cold-start replay. For each sampled attempt, captures:
 *   - the full attentionScores breakdown (every feature that fired, its raw
 *     contribution, and which side it fed - BUY or SELL)
 *   - whether TREND_STACK_CAP (0.50) clipped anything in that attempt
 *   - features.marketRegime.type at the time of the attempt
 *
 * This does not touch signalEngine.ts. It only instruments the console
 * output already produced by generateSignalAnalysis() during a simulation
 * run, correlating lines that belong to the same attempt (each attempt's
 * lines are all emitted synchronously between one "SIGNAL STRENGTH
 * COMPARISON" header and the next).
 */

type SimulationSettings = {
  tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number;
  minConfidence: number; useDynamicSL: boolean; maxSLPips: number;
};

interface GeneratedSignalLike {
  id: string; type: "BUY" | "SELL"; status: string; targetsHit: number;
  timestamp: string; entryPrice: number; sl: number; tp1: number; tp2: number; tp3: number;
  exitTime?: string; exitPrice?: number;
}

const TERMINAL_STATUSES = ["CLOSED", "SL_HIT", "ALL_TARGETS_HIT", "PARTIAL_WIN_SL_HIT"];
const SIGNAL_EXPIRY_MS = 2 * 60 * 60 * 1000;

interface SandboxSignalEngine {
  loadPersistedLearningData(): Promise<unknown>;
  updateCurrentPrice(): Promise<number>;
  updateDailyOHLC(currentPrice: number): Promise<unknown>;
  getMarketOutlook(): Promise<{ isMarketOpen: boolean; currentSession: string }>;
  generateSignal(settings: SimulationSettings, accountBalance: number, activeSignals: GeneratedSignalLike[]): Promise<GeneratedSignalLike | null>;
  getSignalGenerationStats(): { attempts: number; successful: number; rate: number };
  recordTradeOutcome(
    signalId: string, entryPrice: number, exitPrice: number, result: "WIN" | "LOSS",
    features: unknown, misleadingFeatures?: unknown, signalDuration?: number,
  ): Promise<void>;
}

interface SandboxSignalEngineModule {
  signalEngine: SandboxSignalEngine;
  setExternalPrice(price: number, source: string): void;
}

declare global {
  var __SIGNAL_SIMULATION_CONTEXT__: { currentPrice: number; bars: SandboxBar[]; getIntermarketSnapshot: (t: number) => { dxy: number; us10y: number; vix: number } } | undefined;
}

interface SandboxBar { timestamp: number; open: number; high: number; low: number; close: number; }

const RealDate = Date;
let virtualNow = 0;

class MockDate extends RealDate {
  constructor(value?: string | number | Date) {
    if (value === undefined) { super(virtualNow); return; }
    super(value);
  }
  static now(): number { return virtualNow; }
  static parse(dateString: string): number { return RealDate.parse(dateString); }
  static UTC(y: number, m?: number, d?: number, h?: number, mi?: number, s?: number, ms?: number): number {
    return RealDate.UTC(y, m, d, h, mi, s, ms);
  }
}

const SIMULATION_START_MS = Date.UTC(2026, 2, 17, 20, 0, 0);
const WARMUP_DURATION_MS = 90 * 60 * 1000;
const OBSERVED_HOURS = Math.max(1, Number(process.env.SIGNAL_SIM_HOURS ?? "168"));
const OBSERVED_DURATION_MS = OBSERVED_HOURS * 60 * 60 * 1000;
const TOTAL_DURATION_MS = WARMUP_DURATION_MS + OBSERVED_DURATION_MS;
const STEP_MS = 30_000;
const BAR_INTERVAL_MS = 60_000;
const SANDBOX_SOURCE = "sandbox-noise-floor-investigation";
const TARGET_SAMPLE_COUNT = 18;

const originalConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

// ---- Per-attempt buffer state ----
interface AttemptRecord {
  index: number;
  buyStrength: number | null;
  sellStrength: number | null;
  winningStrength: number | null;
  regimeType: string | null;
  regimeStrength: number | null;
  trendStackClipped: boolean;
  trendBuyContribution: number | null;
  trendSellContribution: number | null;
  htfTrend: string | null;
  ltfTrend: string | null;
  ltfMomentum: number | null;
  ltfMomentumThreshold: number | null;
  ltfVolatility: number | null;
  rsi: number | null;
  attentionLines: { key: string; value: number }[];
  rawLines: string[];
}

let attemptIndex = 0;
let currentAttempt: AttemptRecord | null = null;
const allAttempts: AttemptRecord[] = [];

function newAttempt(): AttemptRecord {
  attemptIndex += 1;
  return {
    index: attemptIndex,
    buyStrength: null,
    sellStrength: null,
    winningStrength: null,
    regimeType: null,
    regimeStrength: null,
    trendStackClipped: false,
    trendBuyContribution: null,
    trendSellContribution: null,
    htfTrend: null,
    ltfTrend: null,
    ltfMomentum: null,
    ltfMomentumThreshold: null,
    ltfVolatility: null,
    rsi: null,
    attentionLines: [],
    rawLines: [],
  };
}

function finalizeCurrentAttempt(): void {
  if (currentAttempt && currentAttempt.winningStrength !== null) {
    allAttempts.push(currentAttempt);
  }
  currentAttempt = null;
}

function trackLine(line: string): void {
  if (line.includes("MULTI-TIMEFRAME ANALYSIS")) {
    finalizeCurrentAttempt();
    currentAttempt = newAttempt();
  }

  if (!currentAttempt) return;
  currentAttempt.rawLines.push(line);

  const buyMatch = line.match(/BUY Strength:\s*([\d.]+)/);
  if (buyMatch) currentAttempt.buyStrength = Number(buyMatch[1]);

  const sellMatch = line.match(/SELL Strength:\s*([\d.]+)/);
  if (sellMatch) currentAttempt.sellStrength = Number(sellMatch[1]);

  const winMatch = line.match(/Winning Strength:\s*([\d.]+)\s*\(Min:/);
  if (winMatch) currentAttempt.winningStrength = Number(winMatch[1]);

  const regimeMatch = line.match(/regime\s+(TRENDING|QUIET|RANGING|VOLATILE)\s+min/);
  if (regimeMatch) currentAttempt.regimeType = regimeMatch[1];

  const htfMatch = line.match(/HTF Trend \(Daily\):\s*(BULLISH|BEARISH|NEUTRAL)/);
  if (htfMatch) currentAttempt.htfTrend = htfMatch[1];

  const ltfMatch = line.match(/LTF Trend \(5min\):\s*(BULLISH|BEARISH|NEUTRAL)/);
  if (ltfMatch) currentAttempt.ltfTrend = ltfMatch[1];

  const ltfMomentumMatch = line.match(/LTF Momentum:\s*(-?[\d.]+)\s*vs threshold\s*([\d.]+)\s*\(volatility:\s*([\d.]+)\)/);
  if (ltfMomentumMatch) {
    currentAttempt.ltfMomentum = Number(ltfMomentumMatch[1]);
    currentAttempt.ltfMomentumThreshold = Number(ltfMomentumMatch[2]);
    currentAttempt.ltfVolatility = Number(ltfMomentumMatch[3]);
  }

  const rsiMatch = line.match(/📉 RSI:\s*([\d.]+)/);
  if (rsiMatch) currentAttempt.rsi = Number(rsiMatch[1]);

  const regimeMatch2 = line.match(/Market Regime:\s*(TRENDING|QUIET|RANGING|VOLATILE)\s*\(Strength:\s*(\d+)%/);
  if (regimeMatch2) {
    currentAttempt.regimeType = regimeMatch2[1];
    currentAttempt.regimeStrength = Number(regimeMatch2[2]);
  }

  const resultRegimeMatch = line.match(/Result:\s*(VOLATILE|QUIET|TRENDING|RANGING)\s+regime/);
  if (resultRegimeMatch) currentAttempt.regimeType = resultRegimeMatch[1];

  const trendStackMatch = line.match(/Trend Stack \(capped ([\d.]+)\): BUY\+([\d.]+) SELL\+([\d.]+)/);
  if (trendStackMatch) {
    const cap = Number(trendStackMatch[1]);
    const buyC = Number(trendStackMatch[2]);
    const sellC = Number(trendStackMatch[3]);
    currentAttempt.trendBuyContribution = buyC;
    currentAttempt.trendSellContribution = sellC;
    currentAttempt.trendStackClipped = buyC >= cap || sellC >= cap;
  }

  const attentionMatch = line.match(/📊 Attention Scores:\s*(.+)/);
  if (attentionMatch) {
    const entries = attentionMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
    for (const entry of entries) {
      const [key, valueStr] = entry.split(":").map((s) => s.trim());
      const value = Number(valueStr);
      if (key && Number.isFinite(value)) {
        currentAttempt.attentionLines.push({ key, value });
      }
    }
    return;
  }

  // Direct feature-fire detection: the "📊 Attention Scores:" summary dump only
  // executes on the success path (after the conviction/strength-difference gates
  // pass) - rejected attempts (which is exactly this investigation's target
  // bucket) return early and never reach it. So for a complete per-attempt
  // breakdown regardless of pass/fail, match the individual feature-fire log
  // lines directly (each one is emitted at the same point attentionScores.set()
  // is called in signalEngine.ts).
  const featurePatterns: { pattern: RegExp; key: string; side: "BUY" | "SELL" }[] = [
    { pattern: /BUY: HTF \+ LTF Bullish Alignment/, key: "htf_ltf_bullish_alignment (0.40)", side: "BUY" },
    { pattern: /BUY: Counter-trend Bounce Setup/, key: "counter_trend_bounce_setup (0.35)", side: "BUY" },
    { pattern: /SELL: Intraday Correction Setup/, key: "intraday_correction_in_uptrend (0.30)", side: "SELL" },
    { pattern: /SELL: HTF \+ LTF Bearish Alignment/, key: "htf_ltf_bearish_alignment (0.40)", side: "SELL" },
    { pattern: /SELL: Counter-trend Rejection Setup/, key: "counter_trend_rejection_setup (0.35)", side: "SELL" },
    { pattern: /BUY: Intraday Bounce Setup/, key: "intraday_bounce_in_downtrend (0.30)", side: "BUY" },
    { pattern: /SELL: Neutral HTF - Overbought Mean Reversion/, key: "neutral_htf_overbought_sell (0.35)", side: "SELL" },
    { pattern: /BUY: Neutral HTF - Oversold Mean Reversion/, key: "neutral_htf_oversold_buy (0.35)", side: "BUY" },
    { pattern: /BUY: LTF Momentum \(Neutral HTF\)/, key: "ltf_momentum_buy (0.25)", side: "BUY" },
    { pattern: /SELL: LTF Momentum \(Neutral HTF\)/, key: "ltf_momentum_sell (0.25)", side: "SELL" },
    { pattern: /BUY: Strong Uptrend Confirmed/, key: "strong_uptrend (0.15, trend-stack)", side: "BUY" },
    { pattern: /SELL: Strong Downtrend Confirmed/, key: "strong_downtrend (0.15, trend-stack)", side: "SELL" },
    { pattern: /BUY: Strong Support Proximity/, key: "strong_support_proximity (0.10)", side: "BUY" },
    { pattern: /SELL: Strong Resistance Proximity/, key: "strong_resistance_proximity (0.10)", side: "SELL" },
    { pattern: /BUY: S\/R Zone/, key: "sr_zone_reaction (variable strength)", side: "BUY" },
    { pattern: /SELL: S\/R Zone/, key: "sr_zone_reaction (variable strength)", side: "SELL" },
    { pattern: /BUY: Bullish EMA Crossover/, key: "bullish_ema_crossover (0.08)", side: "BUY" },
    { pattern: /SELL: Bearish EMA Crossover/, key: "bearish_ema_crossover (0.08)", side: "SELL" },
    { pattern: /BUY: Bullish MACD Momentum/, key: "bullish_macd_momentum (0.07)", side: "BUY" },
    { pattern: /SELL: Bearish MACD Momentum/, key: "bearish_macd_momentum (0.07)", side: "SELL" },
    { pattern: /BUY: Price [\d.]+ above VWAP/, key: "above_vwap (0.05)", side: "BUY" },
    { pattern: /SELL: Price [\d.]+ below VWAP/, key: "below_vwap (0.05)", side: "SELL" },
    { pattern: /ADX [\d.]+ confirms uptrend/, key: "adx_trend_strength (variable)", side: "BUY" },
    { pattern: /ADX [\d.]+ confirms downtrend/, key: "adx_trend_strength (variable)", side: "SELL" },
    { pattern: /BUY: Bollinger Squeeze \+ Bullish Breakout/, key: "bollinger_squeeze_bull_breakout (0.08)", side: "BUY" },
    { pattern: /SELL: Bollinger Squeeze \+ Bearish Breakout/, key: "bollinger_squeeze_bear_breakout (0.08)", side: "SELL" },
    { pattern: /SELL: Bearish Divergence Detected/, key: "bearish_divergence (0.20)", side: "SELL" },
    { pattern: /BUY: Bullish Divergence Detected/, key: "bullish_divergence (0.20)", side: "BUY" },
    { pattern: /BUY: Near Bullish Quasimodo Level/, key: "bullish_quasimodo (0.18)", side: "BUY" },
    { pattern: /SELL: Near Bearish Quasimodo Level/, key: "bearish_quasimodo (0.18)", side: "SELL" },
    { pattern: /BUY: .*Session Low Sweep Confirmed/, key: "session_low_sweep (0.35 x strength)", side: "BUY" },
    { pattern: /SELL: .*Session High Sweep Confirmed/, key: "session_high_sweep (0.35 x strength)", side: "SELL" },
    { pattern: /Price near Fibonacci Level/, key: "fibonacci_alignment (0.08, dominant side only)", side: "BUY" },
    { pattern: /DXY .* vs LONG gold bias/, key: "dxy_headwind (penalty, BUY side)", side: "BUY" },
    { pattern: /DXY .* vs SHORT gold bias/, key: "dxy_headwind (penalty, SELL side)", side: "SELL" },
  ];

  for (const { pattern, key, side } of featurePatterns) {
    if (pattern.test(line)) {
      currentAttempt.attentionLines.push({ key: `${key} [${side}]` as string, value: side === "SELL" ? -1 : 1 });
    }
  }

  // Context-only factors that are tracked in attentionScores but do NOT add
  // directional strength (kept separate so they don't get miscounted as
  // "features that fed a side").
  if (/High Liquidity Session/.test(line)) {
    currentAttempt.attentionLines.push({ key: "high_liquidity_session (0.10, context only - no directional add)", value: 0 });
  }
  if (/Order Flow context only/.test(line)) {
    currentAttempt.attentionLines.push({ key: "order_flow_context (context only - no directional add)", value: 0 });
  }
  if (/Price near High Volume Node/.test(line)) {
    currentAttempt.attentionLines.push({ key: "volume_node_support_resistance (context only - no directional add)", value: 0 });
  }
}

function installQuietConsole(): () => void {
  console.log = (...args: unknown[]) => { trackLine(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { trackLine(args.map(String).join(" ")); };
  return () => { console.log = originalConsole.log; console.warn = originalConsole.warn; };
}

function installVirtualClock(): () => void {
  globalThis.Date = MockDate as unknown as DateConstructor;
  return () => { globalThis.Date = RealDate; };
}

function interpolate(progress: number, start: number, end: number, from: number, to: number): number {
  if (progress <= start) return from;
  if (progress >= end) return to;
  return from + ((to - from) * ((progress - start) / (end - start)));
}
function getObservedProgress(timestamp: number): number {
  const elapsed = Math.max(0, timestamp - (SIMULATION_START_MS + WARMUP_DURATION_MS));
  return Math.max(0, Math.min(1, elapsed / OBSERVED_DURATION_MS));
}
function getTrendComponent(progress: number): number {
  if (progress < 0.18) return interpolate(progress, 0, 0.18, -2.5, 1.5);
  if (progress < 0.45) return interpolate(progress, 0.18, 0.45, 1.5, 16.5);
  if (progress < 0.68) return interpolate(progress, 0.45, 0.68, 16.5, -9.5);
  if (progress < 0.86) return interpolate(progress, 0.68, 0.86, -9.5, 7.5);
  return interpolate(progress, 0.86, 1, 7.5, 2.5);
}
function getVolatilityScale(progress: number): number {
  if (progress < 0.18) return 0.7;
  if (progress < 0.45) return 1.1;
  if (progress < 0.68) return 1.45;
  if (progress < 0.86) return 1.6;
  return 0.9;
}
function getShockComponent(progress: number): number {
  let shock = 0;
  if (progress >= 0.27 && progress <= 0.31) shock += Math.sin(((progress - 0.27) / 0.04) * Math.PI) * 2.4;
  if (progress >= 0.56 && progress <= 0.61) shock -= Math.sin(((progress - 0.56) / 0.05) * Math.PI) * 3.2;
  if (progress >= 0.73 && progress <= 0.77) shock += Math.sin(((progress - 0.73) / 0.04) * Math.PI) * 2.1;
  return shock;
}
function generateSyntheticPrice(timestamp: number): number {
  const elapsedMs = Math.max(0, timestamp - (SIMULATION_START_MS + WARMUP_DURATION_MS));
  const cycleMs = Math.min(OBSERVED_DURATION_MS, 24 * 60 * 60 * 1000);
  const cycleElapsedMs = elapsedMs % cycleMs;
  const progress = Math.max(0, Math.min(1, cycleElapsedMs / cycleMs));
  const volatilityScale = getVolatilityScale(progress);
  const base = 3034.5 + getTrendComponent(progress);
  const waveA = Math.sin(elapsedMs / (1000 * 60 * 14)) * 1.9 * volatilityScale;
  const waveB = Math.cos(elapsedMs / (1000 * 60 * 39)) * 1.2 * volatilityScale;
  const waveC = Math.sin(elapsedMs / (1000 * 60 * 4.5)) * 0.6 * volatilityScale;
  const shock = getShockComponent(progress);
  return Number((base + waveA + waveB + waveC + shock).toFixed(2));
}
function getIntermarketSnapshot(timestamp: number): { dxy: number; us10y: number; vix: number } {
  const elapsedMs = Math.max(0, timestamp - (SIMULATION_START_MS + WARMUP_DURATION_MS));
  const cycleMs = Math.min(OBSERVED_DURATION_MS, 24 * 60 * 60 * 1000);
  const progress = Math.max(0, Math.min(1, (elapsedMs % cycleMs) / cycleMs));
  const trend = getTrendComponent(progress);
  return {
    dxy: Number((100.6 - (trend * 0.18) + (Math.sin(timestamp / (1000 * 60 * 47)) * 0.15)).toFixed(3)),
    us10y: Number((4.18 - (trend * 0.01) + (Math.cos(timestamp / (1000 * 60 * 61)) * 0.04)).toFixed(3)),
    vix: Number((18.4 + (getVolatilityScale(progress) * 2.6) + (Math.sin(timestamp / (1000 * 60 * 29)) * 0.9)).toFixed(3)),
  };
}
function upsertHistoricalBars(context: { bars: SandboxBar[] }, timestamp: number, price: number): void {
  const barTimestamp = Math.floor(timestamp / BAR_INTERVAL_MS) * BAR_INTERVAL_MS;
  const lastBar = context.bars.length > 0 ? context.bars[context.bars.length - 1] : null;
  if (!lastBar || lastBar.timestamp !== barTimestamp) {
    context.bars.push({ timestamp: barTimestamp, open: price, high: price, low: price, close: price });
    if (context.bars.length > 4_000) context.bars.shift();
    return;
  }
  lastBar.high = Math.max(lastBar.high, price);
  lastBar.low = Math.min(lastBar.low, price);
  lastBar.close = price;
}

async function buildSandboxModule(): Promise<SandboxSignalEngineModule> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.noisefloor.ts");
  const sourcePath = path.join(process.cwd(), "services", "signalEngine.ts");
  const source = await readFile(sourcePath, "utf8");

  const sandboxPrelude = `import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC } from "../../types/trading.ts";

const sandboxStorage = new Map<string, string>();
interface SandboxBar { timestamp: number; open: number; high: number; low: number; close: number; }
interface SandboxContext { currentPrice: number; bars: SandboxBar[]; getIntermarketSnapshot: (timestamp: number) => { dxy: number; us10y: number; vix: number }; }
const getSandboxContext = (): SandboxContext => {
  const context = (globalThis as { __SIGNAL_SIMULATION_CONTEXT__?: SandboxContext }).__SIGNAL_SIMULATION_CONTEXT__;
  if (!context) { throw new Error("Signal simulation context not initialized"); }
  return context;
};
const AsyncStorage = {
  async getItem(key: string): Promise<string | null> { return sandboxStorage.get(key) ?? null; },
  async setItem(key: string, value: string): Promise<void> { sandboxStorage.set(key, value); },
  async removeItem(key: string): Promise<void> { sandboxStorage.delete(key); },
};
(globalThis as Record<string, unknown>).__SANDBOX_TRPC__ = {
  goldPrice: {
    getSpotPrice: { async query(): Promise<{ price: number; source: string }> { return { price: getSandboxContext().currentPrice, source: "sandbox-spot" }; } },
    getHistoricalData: { async query(input: { fromTime: number; toTime: number }): Promise<SandboxBar[]> { return getSandboxContext().bars.filter((bar) => bar.timestamp >= input.fromTime && bar.timestamp <= input.toTime); } },
    getIntermarketData: { async query(): Promise<{ dxy: number; us10y: number; vix: number }> { return getSandboxContext().getIntermarketSnapshot(Date.now()); } },
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
`;

  const stripImportFrom = (code: string, specifier: string): string => {
    const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^import\\s+(?:[\\w*]+\\s*,\\s*)?(?:\\{[^}]*\\}|[\\w*]+(?:\\s+as\\s+\\w+)?)\\s+from\\s+["']${escaped}["'];?\\r?\\n`, "m");
    return code.replace(pattern, "");
  };

  const rewritten = [
    "@/types/trading",
    "@react-native-async-storage/async-storage",
    "@/lib/trpc",
    "@/services/learningStore",
    "react-native",
  ].reduce(stripImportFrom, source);

  await mkdir(sandboxDir, { recursive: true });
  await writeFileNode(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<SandboxSignalEngineModule>;
}

async function reconcileSignals(
  signals: GeneratedSignalLike[], currentPrice: number, now: number, signalEngine: SandboxSignalEngine,
): Promise<void> {
  for (const signal of signals) {
    if (TERMINAL_STATUSES.includes(signal.status)) continue;
    const signalTimestamp = new RealDate(signal.timestamp).getTime();
    const signalAge = now - signalTimestamp;
    const previousStatus = signal.status;
    const previousTargetsHit = signal.targetsHit;

    if (signalAge > SIGNAL_EXPIRY_MS) {
      signal.status = "CLOSED";
      signal.exitTime = new RealDate(now).toISOString();
      continue;
    }

    if (signal.type === "BUY") {
      if (currentPrice <= signal.sl) signal.status = "SL_HIT";
      else if (currentPrice >= signal.tp3) { signal.status = "ALL_TARGETS_HIT"; signal.targetsHit = 3; }
      else if (currentPrice >= signal.tp2 && signal.targetsHit < 2) { signal.status = "TP2_HIT"; signal.targetsHit = 2; }
      else if (currentPrice >= signal.tp1 && signal.targetsHit < 1) { signal.status = "TP1_HIT"; signal.targetsHit = 1; }
    } else {
      if (currentPrice >= signal.sl) signal.status = "SL_HIT";
      else if (currentPrice <= signal.tp3) { signal.status = "ALL_TARGETS_HIT"; signal.targetsHit = 3; }
      else if (currentPrice <= signal.tp2 && signal.targetsHit < 2) { signal.status = "TP2_HIT"; signal.targetsHit = 2; }
      else if (currentPrice <= signal.tp1 && signal.targetsHit < 1) { signal.status = "TP1_HIT"; signal.targetsHit = 1; }
    }

    if (signal.status === previousStatus && signal.targetsHit === previousTargetsHit) continue;

    if (signal.status === "SL_HIT" || signal.status === "ALL_TARGETS_HIT") {
      signal.exitTime = new RealDate(now).toISOString();
      signal.exitPrice = signal.status === "ALL_TARGETS_HIT" ? signal.tp3 : signal.sl;
      const result = signal.status === "ALL_TARGETS_HIT" ? "WIN" : "LOSS";
      await signalEngine.recordTradeOutcome(signal.id, signal.entryPrice, signal.exitPrice, result, {}, undefined, signalAge);
    }
  }
}

function pickEvenlySpacedSample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = items.length / count;
  const result: T[] = [];
  for (let i = 0; i < count; i += 1) {
    result.push(items[Math.floor(i * step)]);
  }
  return result;
}

async function main(): Promise<void> {
  originalConsole.log(`\nPART 2 — NOISE-FLOOR INVESTIGATION — ${OBSERVED_HOURS}h cold-start replay\n`);
  originalConsole.log("=".repeat(72));

  const restoreClock = installVirtualClock();
  const restoreConsole = installQuietConsole();

  try {
    const sandboxModule = await buildSandboxModule();
    const signalEngine = sandboxModule.signalEngine;

    globalThis.__SIGNAL_SIMULATION_CONTEXT__ = { currentPrice: 0, bars: [], getIntermarketSnapshot };
    await signalEngine.loadPersistedLearningData();

    const signalHistory: GeneratedSignalLike[] = [];

    for (let offsetMs = 0; offsetMs <= TOTAL_DURATION_MS; offsetMs += STEP_MS) {
      const timestamp = SIMULATION_START_MS + offsetMs;
      virtualNow = timestamp;

      const syntheticPrice = generateSyntheticPrice(timestamp);
      globalThis.__SIGNAL_SIMULATION_CONTEXT__!.currentPrice = syntheticPrice;
      upsertHistoricalBars(globalThis.__SIGNAL_SIMULATION_CONTEXT__!, timestamp, syntheticPrice);

      sandboxModule.setExternalPrice(syntheticPrice, SANDBOX_SOURCE);
      await signalEngine.updateCurrentPrice();
      await signalEngine.updateDailyOHLC(syntheticPrice);
      await reconcileSignals(signalHistory, syntheticPrice, timestamp, signalEngine);

      const observedElapsedMs = timestamp - (SIMULATION_START_MS + WARMUP_DURATION_MS);
      if (observedElapsedMs <= 0) continue;

      const outlook = await signalEngine.getMarketOutlook();
      if (outlook.isMarketOpen) {
        const fullyActiveSignals = signalHistory.filter((s) => s.status === "ACTIVE");
        let canGenerate = true;
        if (fullyActiveSignals.length > 0) {
          const oldest = fullyActiveSignals[0];
          const signalAgeMs = timestamp - new RealDate(oldest.timestamp).getTime();
          const lockReleased = oldest.targetsHit >= 2;
          canGenerate = lockReleased || signalAgeMs > SIGNAL_EXPIRY_MS;
        }

        if (canGenerate) {
          const signal = await signalEngine.generateSignal(
            { tp1Pips: 30, tp2Pips: 60, tp3Pips: 90, slPips: 70, minConfidence: 0.85, useDynamicSL: true, maxSLPips: 90 },
            10_000,
            signalHistory,
          );
          if (signal) signalHistory.unshift(signal);
        }
      }
    }

    finalizeCurrentAttempt();

    const bucketAttempts = allAttempts.filter(
      (a) => a.winningStrength !== null && a.winningStrength >= 0.10 && a.winningStrength < 0.20,
    );

    originalConsole.log(`\nTotal attempts logged: ${allAttempts.length}`);
    originalConsole.log(`Attempts in 0.10-0.20 bucket: ${bucketAttempts.length}\n`);

    const sample = pickEvenlySpacedSample(bucketAttempts, TARGET_SAMPLE_COUNT);

    if (process.env.DEBUG_RAW === "1" && sample.length > 0) {
      originalConsole.log("\nDEBUG rawLines for sample #1 (" + sample[0].rawLines.length + " lines):\n" + sample[0].rawLines.join("\n"));
    }

    originalConsole.log(`\n1) SAMPLED ATTEMPTS (${sample.length} of ${bucketAttempts.length} in bucket)\n`);
    originalConsole.log("=".repeat(72));

    const regimeCounts = new Map<string, number>();
    let clippedCount = 0;

    sample.forEach((attempt, i) => {
      const regime = attempt.regimeType ?? "UNKNOWN";
      regimeCounts.set(regime, (regimeCounts.get(regime) ?? 0) + 1);
      if (attempt.trendStackClipped) clippedCount += 1;

      originalConsole.log(`\n--- Sample #${i + 1} (attempt #${attempt.index}) ---`);
      originalConsole.log(`  winningStrength: ${attempt.winningStrength?.toFixed(3)}`);
      originalConsole.log(`  buySignalStrength: ${attempt.buyStrength?.toFixed(3) ?? "n/a"} | sellSignalStrength: ${attempt.sellStrength?.toFixed(3) ?? "n/a"}`);
      originalConsole.log(`  marketRegime.type: ${regime}${attempt.regimeStrength !== null ? ` (strength ${attempt.regimeStrength}%)` : ""}`);
      originalConsole.log(`  htfTrend: ${attempt.htfTrend ?? "n/a"} | ltfTrend: ${attempt.ltfTrend ?? "n/a"} | rsi: ${attempt.rsi?.toFixed(1) ?? "n/a"}`);
      originalConsole.log(`  ltfMomentum: ${attempt.ltfMomentum?.toFixed(2) ?? "n/a"} vs threshold: ${attempt.ltfMomentumThreshold?.toFixed(2) ?? "n/a"} (volatility: ${attempt.ltfVolatility?.toFixed(2) ?? "n/a"})`);
      originalConsole.log(`  TREND_STACK_CAP clipped this attempt: ${attempt.trendStackClipped ? "YES" : "no"}${attempt.trendBuyContribution !== null ? ` (BUY+${attempt.trendBuyContribution.toFixed(2)} SELL+${attempt.trendSellContribution?.toFixed(2)})` : ""}`);
      if (attempt.attentionLines.length === 0) {
        originalConsole.log(`  attentionScores: (none fired)`);
      } else {
        originalConsole.log(`  attentionScores (${attempt.attentionLines.length} features fired):`);
        attempt.attentionLines.forEach(({ key, value }) => {
          originalConsole.log(`    - ${key}: ${value >= 0 ? "+" : ""}${value.toFixed(2)}`);
        });
      }
    });

    originalConsole.log(`\n\n2) TREND_STACK_CAP CLIPPING CHECK\n`);
    originalConsole.log("=".repeat(72));
    originalConsole.log(`  Attempts where TREND_STACK_CAP actually clipped a contribution: ${clippedCount} of ${sample.length}`);
    originalConsole.log(`  (If 0, the cap is not the mechanism suppressing these low-strength attempts — they simply never accumulated enough raw contribution to approach the 0.50 cap in the first place.)`);

    originalConsole.log(`\n\n3) MARKET REGIME CROSS-REFERENCE\n`);
    originalConsole.log("=".repeat(72));
    const regimeEntries = [...regimeCounts.entries()].sort((a, b) => b[1] - a[1]);
    regimeEntries.forEach(([regime, count]) => {
      originalConsole.log(`  ${regime}: ${count} (${((count / sample.length) * 100).toFixed(1)}%)`);
    });

    originalConsole.log(`\n\n4) FEATURE FREQUENCY ACROSS SAMPLE (how many sampled attempts had each feature fire)\n`);
    originalConsole.log("=".repeat(72));
    const featureFreq = new Map<string, number>();
    sample.forEach((attempt) => {
      const seen = new Set<string>();
      attempt.attentionLines.forEach(({ key }) => seen.add(key));
      seen.forEach((key) => featureFreq.set(key, (featureFreq.get(key) ?? 0) + 1));
    });
    [...featureFreq.entries()].sort((a, b) => b[1] - a[1]).forEach(([key, count]) => {
      originalConsole.log(`  ${key}: ${count}/${sample.length} attempts`);
    });

    const avgFeatureCount = sample.reduce((sum, a) => sum + a.attentionLines.length, 0) / Math.max(1, sample.length);
    originalConsole.log(`\n  Average number of features fired per sampled attempt: ${avgFeatureCount.toFixed(2)}`);
  } finally {
    restoreConsole();
    restoreClock();
    delete globalThis.__SIGNAL_SIMULATION_CONTEXT__;
  }

  originalConsole.log("\n" + "=".repeat(72));
  originalConsole.log(`END OF ${OBSERVED_HOURS}h NOISE-FLOOR SAMPLE\n`);
}

main().catch((error) => { originalConsole.error(error); process.exit(1); });
