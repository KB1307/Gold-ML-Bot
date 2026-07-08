import { readFile, writeFile as writeFileNode, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * FOLLOW-UP VALIDATION (read-only, no code changes)
 *
 * Validates the new detectLTFTrend() momentum threshold
 * (currentPrice * 0.00005 / currentPrice * 0.0005 / volatility * 0.3) against
 * a genuinely FLAT/RANGING period, to check for false-positive BULLISH/BEARISH
 * classifications now that the threshold dropped ~5x from the old flat
 * $0.80/$2.50 floor/cap.
 *
 * Rather than pick an arbitrary calendar slice, this samples every attempt
 * across the full 168h run whose ACTUAL features.marketRegime.type was
 * QUIET or RANGING (the engine's own "flat market" classification, driven by
 * ATR/volume/VIX/trend-strength — not a synthetic-data guess) and reports the
 * ltfTrend distribution + false-positive rate within that population.
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
const SANDBOX_SOURCE = "sandbox-ltf-flat-validation";
const TARGET_SAMPLE_COUNT = 20;

const originalConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

interface AttemptRecord {
  index: number;
  regimeType: string | null;
  regimeStrength: number | null;
  htfTrend: string | null;
  ltfTrend: string | null;
  ltfMomentum: number | null;
  ltfMomentumThreshold: number | null;
  ltfVolatility: number | null;
  atr: number | null;
  rsi: number | null;
}

let attemptIndex = 0;
let currentAttempt: AttemptRecord | null = null;
const allAttempts: AttemptRecord[] = [];

function newAttempt(): AttemptRecord {
  attemptIndex += 1;
  return {
    index: attemptIndex,
    regimeType: null,
    regimeStrength: null,
    htfTrend: null,
    ltfTrend: null,
    ltfMomentum: null,
    ltfMomentumThreshold: null,
    ltfVolatility: null,
    atr: null,
    rsi: null,
  };
}

function finalizeCurrentAttempt(): void {
  if (currentAttempt && currentAttempt.ltfTrend !== null) {
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

  const atrMatch = line.match(/ATR \(14\):\s*([\d.]+)/);
  if (atrMatch) currentAttempt.atr = Number(atrMatch[1]);

  const regimeMatch2 = line.match(/Market Regime:\s*(TRENDING|QUIET|RANGING|VOLATILE)\s*\(Strength:\s*(\d+)%/);
  if (regimeMatch2) {
    currentAttempt.regimeType = regimeMatch2[1];
    currentAttempt.regimeStrength = Number(regimeMatch2[2]);
  }
  const resultRegimeMatch = line.match(/Result:\s*(VOLATILE|QUIET|TRENDING|RANGING)\s+regime/);
  if (resultRegimeMatch) currentAttempt.regimeType = resultRegimeMatch[1];
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
  const sandboxPath = path.join(sandboxDir, "signalEngine.ltfflat.ts");
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
  originalConsole.log(`\nLTF TREND THRESHOLD — FLAT/RANGING FALSE-POSITIVE VALIDATION — ${OBSERVED_HOURS}h cold-start replay\n`);
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

    originalConsole.log(`\nTotal attempts logged: ${allAttempts.length}`);

    const flatAttempts = allAttempts.filter((a) => a.regimeType === "QUIET" || a.regimeType === "RANGING");
    originalConsole.log(`Attempts classified QUIET or RANGING by the engine's own marketRegime detector: ${flatAttempts.length}\n`);

    const ltfCounts = new Map<string, number>();
    flatAttempts.forEach((a) => {
      const key = a.ltfTrend ?? "n/a";
      ltfCounts.set(key, (ltfCounts.get(key) ?? 0) + 1);
    });

    originalConsole.log(`\n1) LTF TREND DISTRIBUTION DURING QUIET/RANGING REGIME (${flatAttempts.length} attempts)\n`);
    originalConsole.log("=".repeat(72));
    [...ltfCounts.entries()].sort((a, b) => b[1] - a[1]).forEach(([key, count]) => {
      originalConsole.log(`  ${key}: ${count} (${((count / Math.max(1, flatAttempts.length)) * 100).toFixed(2)}%)`);
    });
    const falsePositives = flatAttempts.filter((a) => a.ltfTrend === "BULLISH" || a.ltfTrend === "BEARISH").length;
    originalConsole.log(`\n  FALSE-POSITIVE RATE (ltfTrend fired BULLISH/BEARISH while regime=QUIET/RANGING): ${falsePositives}/${flatAttempts.length} = ${((falsePositives / Math.max(1, flatAttempts.length)) * 100).toFixed(2)}%`);

    const sample = pickEvenlySpacedSample(flatAttempts, TARGET_SAMPLE_COUNT);
    originalConsole.log(`\n\n2) SAMPLED FLAT-PERIOD ATTEMPTS (${sample.length} of ${flatAttempts.length})\n`);
    originalConsole.log("=".repeat(72));
    sample.forEach((a, i) => {
      originalConsole.log(`--- Sample #${i + 1} (attempt #${a.index}) ---`);
      originalConsole.log(`  regime: ${a.regimeType} (strength ${a.regimeStrength}%) | htfTrend: ${a.htfTrend} | ltfTrend: ${a.ltfTrend}`);
      originalConsole.log(`  ltfMomentum: ${a.ltfMomentum?.toFixed(3) ?? "n/a"} vs threshold: ${a.ltfMomentumThreshold?.toFixed(3) ?? "n/a"} (volatility: ${a.ltfVolatility?.toFixed(2) ?? "n/a"}) | atr: ${a.atr?.toFixed(2) ?? "n/a"} | rsi: ${a.rsi?.toFixed(1) ?? "n/a"}`);
    });

    // Distribution of raw |momentum| values seen during QUIET/RANGING, to
    // show how close/far actual momentum sits from the new threshold.
    const momentumAbs = flatAttempts
      .filter((a) => a.ltfMomentum !== null && a.ltfMomentumThreshold !== null)
      .map((a) => ({ abs: Math.abs(a.ltfMomentum as number), threshold: a.ltfMomentumThreshold as number }));
    if (momentumAbs.length > 0) {
      const avgAbsMomentum = momentumAbs.reduce((s, m) => s + m.abs, 0) / momentumAbs.length;
      const maxAbsMomentum = Math.max(...momentumAbs.map((m) => m.abs));
      const avgThreshold = momentumAbs.reduce((s, m) => s + m.threshold, 0) / momentumAbs.length;
      originalConsole.log(`\n\n3) MOMENTUM MAGNITUDE DURING QUIET/RANGING\n`);
      originalConsole.log("=".repeat(72));
      originalConsole.log(`  avg |momentum|: ${avgAbsMomentum.toFixed(4)} | max |momentum|: ${maxAbsMomentum.toFixed(4)} | avg threshold: ${avgThreshold.toFixed(4)}`);
    }
  } finally {
    restoreConsole();
    restoreClock();
    delete globalThis.__SIGNAL_SIMULATION_CONTEXT__;
  }

  originalConsole.log("\n" + "=".repeat(72));
  originalConsole.log(`END OF ${OBSERVED_HOURS}h LTF FLAT-PERIOD VALIDATION\n`);
}

main().catch((error) => { originalConsole.error(error); process.exit(1); });
