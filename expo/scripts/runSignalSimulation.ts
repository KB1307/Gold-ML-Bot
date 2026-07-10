import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Settings, SignalStatus, TradingSignal } from "../types/trading";

type SimulationSettings = Pick<Settings, "tp1Pips" | "tp2Pips" | "tp3Pips" | "slPips" | "minConfidence" | "useDynamicSL" | "maxSLPips">;
type TerminalStatus = Extract<SignalStatus, "CLOSED" | "SL_HIT" | "ALL_TARGETS_HIT" | "PARTIAL_WIN_SL_HIT">;

interface SimulationBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface SimulationContext {
  currentPrice: number;
  bars: SimulationBar[];
  getIntermarketSnapshot: (timestamp: number) => { dxy: number; us10y: number; vix: number };
}

interface SandboxSignalEngine {
  loadPersistedLearningData(): Promise<unknown>;
  updateCurrentPrice(): Promise<number>;
  updateDailyOHLC(currentPrice: number): Promise<unknown>;
  getMarketOutlook(): Promise<{ isMarketOpen: boolean; currentSession: string }>;
  generateSignal(settings: SimulationSettings, accountBalance: number, activeSignals: TradingSignal[]): Promise<TradingSignal | null>;
  getSignalGenerationStats(): { attempts: number; successful: number; rate: number };
  getPerformanceMetrics(): { recentWinRate: number; profitFactor: number; avgConfidence: number; recentWinningConfidences: number[] };
  recordTradeOutcome(
    signalId: string,
    entryPrice: number,
    exitPrice: number,
    result: "WIN" | "LOSS",
    features: unknown,
    misleadingFeatures?: unknown,
    signalDuration?: number,
  ): Promise<void>;
}

interface SandboxSignalEngineModule {
  signalEngine: SandboxSignalEngine;
  setExternalPrice(price: number, source: string): void;
}

interface SimulationSummary {
  marketOpenChecks: number;
  marketClosedChecks: number;
  appLockBlocks: number;
  generatedSignals: number;
  generatedBuySignals: number;
  generatedSellSignals: number;
  closedWins: number;
  closedLosses: number;
  expiredSignals: number;
  firstSignalTimestamp: number | null;
  lastSignalTimestamp: number | null;
  signalTimestamps: number[];
}

interface RejectionSummaryEntry {
  reason: string;
  count: number;
}

declare global {
  var __SIGNAL_SIMULATION_CONTEXT__: SimulationContext | undefined;
}

const TERMINAL_STATUSES: TerminalStatus[] = ["CLOSED", "SL_HIT", "ALL_TARGETS_HIT", "PARTIAL_WIN_SL_HIT"];
const OBSERVED_HOURS = Math.max(1, Number(process.env.SIGNAL_SIM_HOURS ?? "24"));
const VERBOSE_SIMULATION = process.env.SIGNAL_SIM_VERBOSE === "1";
const DEFAULT_SETTINGS: SimulationSettings = {
  tp1Pips: 20,
  tp2Pips: 40,
  tp3Pips: 60,
  slPips: 25,
  minConfidence: 0.85,
  useDynamicSL: true,
  maxSLPips: 60,
};
const ACCOUNT_BALANCE = 10_000;
const STEP_MS = 30_000;
const BAR_INTERVAL_MS = 60_000;
const WARMUP_DURATION_MS = 90 * 60 * 1000;
const OBSERVED_DURATION_MS = OBSERVED_HOURS * 60 * 60 * 1000;
const TOTAL_DURATION_MS = WARMUP_DURATION_MS + OBSERVED_DURATION_MS;
const SIGNAL_EXPIRY_MS = 2 * 60 * 60 * 1000;
const SIMULATION_START_MS = Date.UTC(2026, 2, 17, 20, 0, 0);
const SANDBOX_SOURCE = "sandbox-accelerated-24h";

const RealDate = Date;
const rejectionCounts = new Map<string, number>();
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let virtualNow = SIMULATION_START_MS;

class MockDate extends RealDate {
  constructor(value?: string | number | Date) {
    if (value === undefined) {
      super(virtualNow);
      return;
    }

    super(value);
  }

  static now(): number {
    return virtualNow;
  }

  static parse(dateString: string): number {
    return RealDate.parse(dateString);
  }

  static UTC(
    year: number,
    monthIndex?: number,
    date?: number,
    hours?: number,
    minutes?: number,
    seconds?: number,
    ms?: number,
  ): number {
    return RealDate.UTC(year, monthIndex, date, hours, minutes, seconds, ms);
  }
}

function print(message: string): void {
  originalConsole.log(message);
}

function normalizeRejectionReason(line: string): string | null {
  if (!line.includes("❌ REJECTED")) {
    return null;
  }

  if (line.includes("Dynamic cooldown active")) {
    return "Dynamic cooldown active";
  }

  if (line.includes("below threshold") || line.includes("below absolute minimum")) {
    return "Confidence below threshold";
  }

  if (line.includes("Structural Validation Failed")) {
    return "Structural validation failed";
  }

  if (line.includes("Counter-trend signal requires 5-minute candle confirmation")) {
    return "Missing 5-minute candle confirmation";
  }

  if (line.includes("Price Proximity Filter Block")) {
    return "Price proximity filter block";
  }

  if (line.includes("Macro event suppression")) {
    return "Macro event suppression";
  }

  if (line.includes("Signal conflict prevention")) {
    return "Signal conflict prevention";
  }

  if (line.includes("No valid price available yet")) {
    return "No valid price available";
  }

  return line.replace(/\s+/g, " ").trim();
}

function trackDiagnosticLine(line: string): void {
  const rejectionReason = normalizeRejectionReason(line);
  if (!rejectionReason) {
    return;
  }

  rejectionCounts.set(rejectionReason, (rejectionCounts.get(rejectionReason) ?? 0) + 1);
}

function installQuietConsole(): () => void {
  console.log = (...args: unknown[]) => {
    const line = args.map(stringifyLogValue).join(" ");
    trackDiagnosticLine(line);
    if (VERBOSE_SIMULATION) {
      originalConsole.log(line);
    }
  };

  console.warn = (...args: unknown[]) => {
    const line = args.map(stringifyLogValue).join(" ");
    trackDiagnosticLine(line);
    if (VERBOSE_SIMULATION) {
      originalConsole.warn(line);
    }
  };

  console.error = (...args: unknown[]) => {
    const line = args.map(stringifyLogValue).join(" ");
    trackDiagnosticLine(line);
    originalConsole.error(line);
  };

  return () => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  };
}

function stringifyLogValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function setVirtualNow(timestamp: number): void {
  virtualNow = timestamp;
}

function installVirtualClock(): () => void {
  globalThis.Date = MockDate as unknown as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

function interpolate(progress: number, start: number, end: number, from: number, to: number): number {
  if (progress <= start) {
    return from;
  }

  if (progress >= end) {
    return to;
  }

  const normalized = (progress - start) / (end - start);
  return from + ((to - from) * normalized);
}

function getObservedProgress(timestamp: number): number {
  const observedElapsedMs = Math.max(0, timestamp - (SIMULATION_START_MS + WARMUP_DURATION_MS));
  return Math.max(0, Math.min(1, observedElapsedMs / OBSERVED_DURATION_MS));
}

function getTrendComponent(progress: number): number {
  if (progress < 0.18) {
    return interpolate(progress, 0, 0.18, -2.5, 1.5);
  }

  if (progress < 0.45) {
    return interpolate(progress, 0.18, 0.45, 1.5, 16.5);
  }

  if (progress < 0.68) {
    return interpolate(progress, 0.45, 0.68, 16.5, -9.5);
  }

  if (progress < 0.86) {
    return interpolate(progress, 0.68, 0.86, -9.5, 7.5);
  }

  return interpolate(progress, 0.86, 1, 7.5, 2.5);
}

function getVolatilityScale(progress: number): number {
  if (progress < 0.18) {
    return 0.7;
  }

  if (progress < 0.45) {
    return 1.1;
  }

  if (progress < 0.68) {
    return 1.45;
  }

  if (progress < 0.86) {
    return 1.6;
  }

  return 0.9;
}

function getShockComponent(progress: number): number {
  let shock = 0;

  if (progress >= 0.27 && progress <= 0.31) {
    shock += Math.sin(((progress - 0.27) / 0.04) * Math.PI) * 2.4;
  }

  if (progress >= 0.56 && progress <= 0.61) {
    shock -= Math.sin(((progress - 0.56) / 0.05) * Math.PI) * 3.2;
  }

  if (progress >= 0.73 && progress <= 0.77) {
    shock += Math.sin(((progress - 0.73) / 0.04) * Math.PI) * 2.1;
  }

  return shock;
}

function generateSyntheticPrice(timestamp: number): number {
  const progress = getObservedProgress(timestamp);
  const observedElapsedMs = Math.max(0, timestamp - (SIMULATION_START_MS + WARMUP_DURATION_MS));
  const volatilityScale = getVolatilityScale(progress);
  const base = 3034.5 + getTrendComponent(progress);
  const waveA = Math.sin(observedElapsedMs / (1000 * 60 * 14)) * 1.9 * volatilityScale;
  const waveB = Math.cos(observedElapsedMs / (1000 * 60 * 39)) * 1.2 * volatilityScale;
  const waveC = Math.sin(observedElapsedMs / (1000 * 60 * 4.5)) * 0.6 * volatilityScale;
  const shock = getShockComponent(progress);
  return Number((base + waveA + waveB + waveC + shock).toFixed(2));
}

function getIntermarketSnapshot(timestamp: number): { dxy: number; us10y: number; vix: number } {
  const progress = getObservedProgress(timestamp);
  const trend = getTrendComponent(progress);
  const dxy = Number((100.6 - (trend * 0.18) + (Math.sin(timestamp / (1000 * 60 * 47)) * 0.15)).toFixed(3));
  const us10y = Number((4.18 - (trend * 0.01) + (Math.cos(timestamp / (1000 * 60 * 61)) * 0.04)).toFixed(3));
  const vix = Number((18.4 + (getVolatilityScale(progress) * 2.6) + (Math.sin(timestamp / (1000 * 60 * 29)) * 0.9)).toFixed(3));
  return { dxy, us10y, vix };
}

function upsertHistoricalBars(context: SimulationContext, timestamp: number, price: number): void {
  const barTimestamp = Math.floor(timestamp / BAR_INTERVAL_MS) * BAR_INTERVAL_MS;
  const lastBar = context.bars.length > 0 ? context.bars[context.bars.length - 1] : null;

  if (!lastBar || lastBar.timestamp !== barTimestamp) {
    context.bars.push({
      timestamp: barTimestamp,
      open: price,
      high: price,
      low: price,
      close: price,
    });

    if (context.bars.length > 2_000) {
      context.bars.shift();
    }

    return;
  }

  lastBar.high = Math.max(lastBar.high, price);
  lastBar.low = Math.min(lastBar.low, price);
  lastBar.close = price;
}

async function buildSandboxModule(): Promise<SandboxSignalEngineModule> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.sandbox.ts");
  const sourcePath = path.join(process.cwd(), "services", "signalEngine.ts");
  const source = await readFile(sourcePath, "utf8");

  const sandboxPrelude = `import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC } from "../../types/trading.ts";

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
`;

  // Regex-based stripping: match by module specifier, tolerant of the imported
  // names AND tolerant of CRLF line endings (source files in this repo may be
  // saved with either \n or \r\n) so this can't silently fail to strip an
  // import and produce duplicate-declaration errors. This must not silently
  // break when signalEngine.ts's import list changes (e.g. a new named import
  // added to an existing module specifier).
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
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<SandboxSignalEngineModule>;
}

function formatTimestamp(timestamp: number): string {
  return new RealDate(timestamp).toISOString();
}

function isObservedTick(timestamp: number): boolean {
  return timestamp >= SIMULATION_START_MS + WARMUP_DURATION_MS;
}

async function reconcileSignals(
  signals: TradingSignal[],
  currentPrice: number,
  now: number,
  signalEngine: SandboxSignalEngine,
  summary: SimulationSummary,
): Promise<void> {
  for (const signal of signals) {
    if (TERMINAL_STATUSES.includes(signal.status as TerminalStatus)) {
      continue;
    }

    const signalTimestamp = new RealDate(signal.timestamp).getTime();
    const signalAge = now - signalTimestamp;
    const previousStatus = signal.status;
    const previousTargetsHit = signal.targetsHit;

    if (signalAge > SIGNAL_EXPIRY_MS) {
      signal.status = "CLOSED";
      signal.exitTime = formatTimestamp(now);
      summary.expiredSignals += 1;
      continue;
    }

    if (signal.type === "BUY") {
      if (currentPrice <= signal.sl) {
        signal.status = "SL_HIT";
      } else if (currentPrice >= signal.tp3) {
        signal.status = "ALL_TARGETS_HIT";
        signal.targetsHit = 3;
      } else if (currentPrice >= signal.tp2 && signal.targetsHit < 2) {
        signal.status = "TP2_HIT";
        signal.targetsHit = 2;
      } else if (currentPrice >= signal.tp1 && signal.targetsHit < 1) {
        signal.status = "TP1_HIT";
        signal.targetsHit = 1;
      }
    } else {
      if (currentPrice >= signal.sl) {
        signal.status = "SL_HIT";
      } else if (currentPrice <= signal.tp3) {
        signal.status = "ALL_TARGETS_HIT";
        signal.targetsHit = 3;
      } else if (currentPrice <= signal.tp2 && signal.targetsHit < 2) {
        signal.status = "TP2_HIT";
        signal.targetsHit = 2;
      } else if (currentPrice <= signal.tp1 && signal.targetsHit < 1) {
        signal.status = "TP1_HIT";
        signal.targetsHit = 1;
      }
    }

    if (signal.status === previousStatus && signal.targetsHit === previousTargetsHit) {
      continue;
    }

    if (signal.status === "SL_HIT" || signal.status === "ALL_TARGETS_HIT") {
      signal.exitTime = formatTimestamp(now);
      signal.exitPrice = signal.status === "ALL_TARGETS_HIT" ? signal.tp3 : signal.sl;

      const result = signal.status === "ALL_TARGETS_HIT" ? "WIN" : "LOSS";
      await signalEngine.recordTradeOutcome(
        signal.id,
        signal.entryPrice,
        signal.exitPrice,
        result,
        {},
        undefined,
        signalAge,
      );

      if (result === "WIN") {
        summary.closedWins += 1;
      } else {
        summary.closedLosses += 1;
      }
    }
  }
}

function getTopRejectionReasons(limit: number): RejectionSummaryEntry[] {
  return [...rejectionCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
}

function getMaxGapHours(signalTimestamps: number[]): number {
  if (signalTimestamps.length < 2) {
    return 0;
  }

  let maxGap = 0;
  for (let index = 1; index < signalTimestamps.length; index += 1) {
    maxGap = Math.max(maxGap, signalTimestamps[index] - signalTimestamps[index - 1]);
  }

  return Number((maxGap / (60 * 60 * 1000)).toFixed(2));
}

async function run(): Promise<void> {
  rejectionCounts.clear();

  const restoreClock = installVirtualClock();
  const restoreConsole = installQuietConsole();

  try {
    const sandboxModule = await buildSandboxModule();
    const signalEngine = sandboxModule.signalEngine;

    globalThis.__SIGNAL_SIMULATION_CONTEXT__ = {
      currentPrice: 0,
      bars: [],
      getIntermarketSnapshot,
    };

    await signalEngine.loadPersistedLearningData();

    const signalHistory: TradingSignal[] = [];
    const summary: SimulationSummary = {
      marketOpenChecks: 0,
      marketClosedChecks: 0,
      appLockBlocks: 0,
      generatedSignals: 0,
      generatedBuySignals: 0,
      generatedSellSignals: 0,
      closedWins: 0,
      closedLosses: 0,
      expiredSignals: 0,
      firstSignalTimestamp: null,
      lastSignalTimestamp: null,
      signalTimestamps: [],
    };

    print(`🧪 Running accelerated ${OBSERVED_HOURS}h signal simulation from ${formatTimestamp(SIMULATION_START_MS)} with 90m warmup...`);

    for (let offsetMs = 0; offsetMs <= TOTAL_DURATION_MS; offsetMs += STEP_MS) {
      const timestamp = SIMULATION_START_MS + offsetMs;
      setVirtualNow(timestamp);

      const syntheticPrice = generateSyntheticPrice(timestamp);
      globalThis.__SIGNAL_SIMULATION_CONTEXT__.currentPrice = syntheticPrice;
      upsertHistoricalBars(globalThis.__SIGNAL_SIMULATION_CONTEXT__, timestamp, syntheticPrice);

      sandboxModule.setExternalPrice(syntheticPrice, SANDBOX_SOURCE);
      await signalEngine.updateCurrentPrice();
      await signalEngine.updateDailyOHLC(syntheticPrice);
      await reconcileSignals(signalHistory, syntheticPrice, timestamp, signalEngine, summary);

      if (!isObservedTick(timestamp)) {
        continue;
      }

      const observedElapsedMs = timestamp - (SIMULATION_START_MS + WARMUP_DURATION_MS);
      if (observedElapsedMs > 0 && observedElapsedMs % (6 * 60 * 60 * 1000) === 0) {
        const openSignals = signalHistory.filter((signal) => !TERMINAL_STATUSES.includes(signal.status as TerminalStatus)).length;
        print(`⏱️ ${String(observedElapsedMs / (60 * 60 * 1000)).padStart(2, "0")}h | price=${syntheticPrice.toFixed(2)} | totalSignals=${signalHistory.length} | openSignals=${openSignals}`);
      }

      const outlook = await signalEngine.getMarketOutlook();
      if (!outlook.isMarketOpen) {
        summary.marketClosedChecks += 1;
        continue;
      }

      summary.marketOpenChecks += 1;

      const fullyActiveSignals = signalHistory.filter((signal) => signal.status === "ACTIVE");
      if (fullyActiveSignals.length > 0) {
        const oldestActiveSignal = fullyActiveSignals[0];
        const signalAgeMs = timestamp - new RealDate(oldestActiveSignal.timestamp).getTime();
        const lockReleased = oldestActiveSignal.targetsHit >= 2;
        const canGenerateNewSignal = lockReleased || signalAgeMs > SIGNAL_EXPIRY_MS;

        if (!canGenerateNewSignal) {
          summary.appLockBlocks += 1;
          continue;
        }
      }

      const signal = await signalEngine.generateSignal(DEFAULT_SETTINGS, ACCOUNT_BALANCE, signalHistory);
      if (!signal) {
        continue;
      }

      signalHistory.unshift(signal);
      summary.generatedSignals += 1;
      summary.signalTimestamps.push(timestamp);
      summary.firstSignalTimestamp = summary.firstSignalTimestamp ?? timestamp;
      summary.lastSignalTimestamp = timestamp;

      if (signal.type === "BUY") {
        summary.generatedBuySignals += 1;
      } else {
        summary.generatedSellSignals += 1;
      }

      print(`✅ Signal ${summary.generatedSignals} | ${signal.type} | ${formatTimestamp(timestamp)} | entry=${signal.entryPrice.toFixed(2)} | confidence=${(signal.confidence * 100).toFixed(1)}%`);
    }

    const openSignals = signalHistory.filter((signal) => !TERMINAL_STATUSES.includes(signal.status as TerminalStatus)).length;
    const engineStats = signalEngine.getSignalGenerationStats();
    const performanceMetrics = signalEngine.getPerformanceMetrics();
    const maxGapHours = getMaxGapHours(summary.signalTimestamps);

    print(`\n📈 Accelerated ${OBSERVED_HOURS}h simulation summary`);
    print(`   Market-open checks: ${summary.marketOpenChecks}`);
    print(`   Market-closed checks: ${summary.marketClosedChecks}`);
    print(`   App-level lock blocks: ${summary.appLockBlocks}`);
    print(`   Engine attempts: ${engineStats.attempts}`);
    print(`   Engine successful: ${engineStats.successful}`);
    print(`   Signals generated: ${summary.generatedSignals} (${summary.generatedBuySignals} BUY / ${summary.generatedSellSignals} SELL)`);
    print(`   Terminal wins/losses: ${summary.closedWins}/${summary.closedLosses}`);
    print(`   Expired signals: ${summary.expiredSignals}`);
    print(`   Open signals at end: ${openSignals}`);
    print(`   Max gap between generated signals: ${maxGapHours}h`);
    print(`   First signal: ${summary.firstSignalTimestamp ? formatTimestamp(summary.firstSignalTimestamp) : "none"}`);
    print(`   Last signal: ${summary.lastSignalTimestamp ? formatTimestamp(summary.lastSignalTimestamp) : "none"}`);
    print(`   Engine win rate: ${(performanceMetrics.recentWinRate * 100).toFixed(1)}%`);
    print(`   Engine profit factor: ${performanceMetrics.profitFactor.toFixed(2)}`);

    const topRejectionReasons = getTopRejectionReasons(5);
    if (topRejectionReasons.length > 0) {
      print("   Top rejection reasons:");
      topRejectionReasons.forEach((entry) => {
        print(`     - ${entry.reason}: ${entry.count}`);
      });
    }

    if (summary.generatedSignals === 0) {
      print(`❌ Simulation result: no signals were generated in the observed ${OBSERVED_HOURS}h replay.`);
      return;
    }

    print(`✅ Simulation result: the signal generation engine produced signals in the observed ${OBSERVED_HOURS}h replay.`);
  } finally {
    restoreConsole();
    restoreClock();
    delete globalThis.__SIGNAL_SIMULATION_CONTEXT__;
  }
}

run().catch((error: unknown) => {
  originalConsole.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
