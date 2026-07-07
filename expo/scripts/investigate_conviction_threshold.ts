import { mkdir, readFile, writeFile as writeFileNode } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * CONVICTION THRESHOLD (MIN_SIGNAL_CONVICTION_THRESHOLD = 0.55) INVESTIGATION
 *
 * Read-only investigation. Reuses the same cold-start synthetic-price sandbox
 * harness as investigate_part2_countertrend_gate.ts, but instruments EVERY
 * `generateSignalAnalysis` attempt's `winningStrength` (logged unconditionally
 * before the 0.55 gate check fires, whether the attempt passes or fails that
 * gate) to build a full histogram, not just pass/fail counts. Also separately
 * tallies Quality Gate rejections (evaluateQualityGate reasons) so its
 * contribution can be reported apart from the conviction gate's.
 *
 * No code changes to signalEngine.ts are made by this script.
 */

interface GeneratedSignalLike {
  id: string;
  type: "BUY" | "SELL";
  status: string;
  targetsHit: number;
  timestamp: string;
  entryPrice: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  exitTime?: string;
  exitPrice?: number;
}

type SimulationSettings = {
  tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number;
  minConfidence: number; useDynamicSL: boolean; maxSLPips: number;
};

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
const SANDBOX_SOURCE = "sandbox-conviction-threshold-investigation";

const originalConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

// ---- Histogram / breakdown state ----
const winningStrengthSamples: number[] = []; // every attempt, pass or fail
let maxWinningStrength = 0;
let conviction_pass = 0, conviction_fail = 0;
let qualityGateRejections = 0;
const qualityGateReasonCounts = new Map<string, number>();
let confidenceBelowThresholdRejections = 0;
let confidenceBelowFloorRejections = 0;
let structuralValidationRejections = 0;
const rejectionCounts = new Map<string, number>();
let pendingWinningStrength: number | null = null; // last logged winning strength, consumed by the next terminal outcome line

function normalizeRejectionReason(line: string): string | null {
  if (!line.includes("REJECTED") && !line.includes("rejected")) return null;
  if (line.includes("Dynamic cooldown active")) return "Dynamic cooldown active";
  if (line.includes("Winning strength") && line.includes("below conviction threshold")) return "Conviction gate (0.55)";
  if (line.includes("Strength difference") && line.includes("too small")) return "Strength-difference gate (direction ambiguity)";
  if (line.includes("below engine floor")) return "Confidence below engine floor";
  if (line.includes("below threshold") && line.includes("Confidence")) return "Confidence below effective threshold";
  if (line.includes("Quality Gate")) return "Quality Gate";
  if (line.includes("Structural Validation Failed")) return "Structural validation failed";
  if (line.includes("COUNTER-TREND REJECTED")) return "Counter-trend: no qualifying zone/OB";
  if (line.includes("Counter-trend signal requires") || line.includes("5-min candle")) return "Missing 5-minute candle confirmation";
  if (line.includes("Price Proximity Filter Block")) return "Price proximity filter block";
  if (line.includes("Macro event suppression")) return "Macro event suppression";
  if (line.includes("Signal conflict prevention")) return "Signal conflict prevention";
  if (line.includes("No valid price available yet")) return "No valid price available";
  if (line.includes("BASELINE OPPOSING-STRUCTURE VETO")) return "Step 3 opposing-structure veto";
  if (line.includes("Daily market-close break")) return "Daily market-close break";
  return line.replace(/\s+/g, " ").trim().slice(0, 90);
}

function trackLine(line: string): void {
  const winningStrengthMatch = line.match(/Winning Strength:\s*([\d.]+)\s*\(Min:\s*([\d.]+)\)/);
  if (winningStrengthMatch) {
    const value = Number(winningStrengthMatch[1]);
    if (Number.isFinite(value)) {
      winningStrengthSamples.push(value);
      maxWinningStrength = Math.max(maxWinningStrength, value);
      pendingWinningStrength = value;
      if (value < 0.55) conviction_fail += 1; else conviction_pass += 1;
    }
    return; // this line is not itself a rejection reason
  }

  if (line.includes("REJECTED: Quality Gate")) {
    qualityGateRejections += 1;
    const reasonMatch = line.match(/REJECTED: Quality Gate — (.+)/);
    const reason = reasonMatch ? reasonMatch[1].trim() : "unknown";
    // Bucket into families for readability
    let bucket = reason;
    if (reason.startsWith("ATR too low")) bucket = "ATR too low (insufficient volatility)";
    else if (reason.startsWith("Low participation")) bucket = "Low participation (volume ratio)";
    else if (reason.startsWith("QUIET regime")) bucket = "QUIET regime, weak directional strength";
    else if (reason.startsWith("RANGING regime")) bucket = "RANGING regime, no confirmed S/R reaction";
    else if (reason.includes("reaction not confirmed")) bucket = "S/R reaction not confirmed";
    else if (reason.startsWith("BUY blocked") || reason.startsWith("SELL blocked")) bucket = "RSI extreme outside trending regime";
    qualityGateReasonCounts.set(bucket, (qualityGateReasonCounts.get(bucket) ?? 0) + 1);
  }
  if (line.includes("REJECTED: Confidence") && line.includes("below threshold")) confidenceBelowThresholdRejections += 1;
  if (line.includes("REJECTED: Confidence") && line.includes("below engine floor")) confidenceBelowFloorRejections += 1;
  if (line.includes("REJECTED: Structural Validation Failed")) structuralValidationRejections += 1;

  const reason = normalizeRejectionReason(line);
  if (reason) rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
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
  const sandboxPath = path.join(sandboxDir, "signalEngine.convictionthreshold.ts");
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
  signals: GeneratedSignalLike[],
  currentPrice: number,
  now: number,
  signalEngine: SandboxSignalEngine,
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

function histogram(samples: number[]): { bucket: string; count: number; pct: string }[] {
  const buckets = [
    [0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5],
    [0.5, 0.55], [0.55, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.5],
  ] as const;
  const total = samples.length;
  return buckets.map(([lo, hi]) => {
    const count = samples.filter(v => v >= lo && v < hi).length;
    return { bucket: `${lo.toFixed(2)}-${hi.toFixed(2)}`, count, pct: total > 0 ? ((count / total) * 100).toFixed(2) + "%" : "0%" };
  });
}

async function main(): Promise<void> {
  originalConsole.log(`\nCONVICTION THRESHOLD (0.55) INVESTIGATION — ${OBSERVED_HOURS}h cold-start replay\n`);
  originalConsole.log("=".repeat(72));

  const restoreClock = installVirtualClock();
  const restoreConsole = installQuietConsole();
  let signalCount = 0, buyCount = 0, sellCount = 0;

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
          if (signal) {
            signalHistory.unshift(signal);
            signalCount += 1;
            if (signal.type === "BUY") buyCount += 1; else sellCount += 1;
          }
        }
      }
    }

    const stats = signalEngine.getSignalGenerationStats();

    originalConsole.log(`\n1) WINNING STRENGTH DISTRIBUTION (all ${winningStrengthSamples.length} logged attempts)\n`);
    const hist = histogram(winningStrengthSamples);
    hist.forEach(h => originalConsole.log(`  [${h.bucket}): ${h.count} (${h.pct})`));
    originalConsole.log(`\n  Fraction of ALL attempts >= 0.55: ${winningStrengthSamples.length > 0 ? ((conviction_pass / winningStrengthSamples.length) * 100).toFixed(2) : "n/a"}%`);
    originalConsole.log(`  Max winningStrength observed across full run: ${maxWinningStrength.toFixed(4)}`);
    originalConsole.log(`  Conviction gate pass count: ${conviction_pass} | fail count: ${conviction_fail}`);

    originalConsole.log(`\n2) SIGNAL GENERATION SUMMARY\n`);
    originalConsole.log(`  Duration: ${OBSERVED_HOURS}h observed (+90m warmup)`);
    originalConsole.log(`  Engine attempts: ${stats.attempts} | successful: ${stats.successful} | rate: ${(stats.rate * 100).toFixed(2)}%`);
    originalConsole.log(`  Signals generated: ${signalCount} (${buyCount} BUY / ${sellCount} SELL)`);

    originalConsole.log(`\n3) GATE CONTRIBUTION BREAKDOWN (all rejection reasons, ranked)\n`);
    const topRejections = [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1]);
    const totalRejections = topRejections.reduce((sum, [, c]) => sum + c, 0);
    topRejections.forEach(([reason, count]) => {
      originalConsole.log(`  - ${reason}: ${count} (${totalRejections > 0 ? ((count / totalRejections) * 100).toFixed(2) : "0"}% of all rejections)`);
    });

    originalConsole.log(`\n4) QUALITY GATE BREAKDOWN (separate from conviction gate)\n`);
    originalConsole.log(`  Quality Gate total rejections: ${qualityGateRejections}`);
    const qgReasons = [...qualityGateReasonCounts.entries()].sort((a, b) => b[1] - a[1]);
    qgReasons.forEach(([reason, count]) => originalConsole.log(`    - ${reason}: ${count}`));

    originalConsole.log(`\n5) CONVICTION GATE vs QUALITY GATE vs OTHERS, SIDE BY SIDE\n`);
    const convictionRejections = rejectionCounts.get("Conviction gate (0.55)") ?? 0;
    originalConsole.log(`  Conviction gate (0.55) rejections: ${convictionRejections} (${totalRejections > 0 ? ((convictionRejections / totalRejections) * 100).toFixed(2) : "0"}% of all rejections)`);
    originalConsole.log(`  Quality Gate rejections: ${qualityGateRejections} (${totalRejections > 0 ? ((qualityGateRejections / totalRejections) * 100).toFixed(2) : "0"}% of all rejections)`);
    originalConsole.log(`  ATR-specific Quality Gate rejections ("ATR too low"): ${qualityGateReasonCounts.get("ATR too low (insufficient volatility)") ?? 0}`);
    originalConsole.log(`  Confidence-below-threshold rejections: ${confidenceBelowThresholdRejections}`);
    originalConsole.log(`  Confidence-below-floor rejections: ${confidenceBelowFloorRejections}`);
    originalConsole.log(`  Structural validation rejections: ${structuralValidationRejections}`);
  } finally {
    restoreConsole();
    restoreClock();
    delete globalThis.__SIGNAL_SIMULATION_CONTEXT__;
  }

  originalConsole.log("\n" + "=".repeat(72));
  originalConsole.log(`END OF ${OBSERVED_HOURS}h RUN\n`);
}

main().catch((error) => { originalConsole.error(error); process.exit(1); });
