import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PART 2 COUNTER-TREND GATE INVESTIGATION
 *
 * Distinguishes between two hypotheses for why the counter-trend branch
 * (reactionStrength >= 0.3 AND touches >= 2, no Camarilla fallback) appears
 * to be starving signal generation:
 *
 * (A) GENUINE DESIGN PROBLEM — the threshold/no-fallback design is
 *     miscalibrated even given plenty of time for zones to legitimately
 *     qualify.
 * (B) SIMULATION-DURATION ARTIFACT — a 24h synthetic replay starting from a
 *     cold/empty zone history simply isn't enough time for zones to
 *     legitimately accumulate 2 real touches under the now-honest
 *     (post-earned-evidence-gate) scoring.
 *
 * This script:
 *  1. Tracks, at checkpoints, the MAX reactionStrength + touch count for the
 *     nearest SUPPORT zone (BUY side) and nearest RESISTANCE zone (SELL
 *     side) near current price, so we can see whether zones are CLOSE to
 *     qualifying (e.g. 0.25-0.29 @ 1 touch) or nowhere near (capped ~0.1).
 *  2. Runs the SAME cold-start simulation for a configurable duration
 *     (SIGNAL_SIM_HOURS env var, default 24) so it can be re-run at 24h,
 *     72h, and 168h (7d) to see whether zone qualification / signal count
 *     recovers as more session history accumulates.
 *  3. Tracks counter-trend branch outcomes specifically (REJECTED vs
 *     BOUNCE CONFIRMED) via console interception, plus overall signal
 *     count/type breakdown.
 *
 * Step 3's veto is intentionally left untouched/unexamined here (per
 * instructions) — it's a confirmed zero-effect bystander while upstream
 * signal volume is starved.
 */

interface InvestigationSRZone {
  price: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  lastTouch: number;
  rejectionWicks: number;
  reactionStrength: number;
  source: string;
  confluenceScore: number;
}

type SimulationSettings = {
  tp1Pips: number; tp2Pips: number; tp3Pips: number; slPips: number;
  minConfidence: number; useDynamicSL: boolean; maxSLPips: number;
};

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

const TERMINAL_STATUSES = ["CLOSED", "SL_HIT", "ALL_TARGETS_HIT", "PARTIAL_WIN_SL_HIT"];
const SIGNAL_EXPIRY_MS = 2 * 60 * 60 * 1000;

interface SandboxSignalEngine {
  loadPersistedLearningData(): Promise<unknown>;
  updateCurrentPrice(): Promise<number>;
  updateDailyOHLC(currentPrice: number): Promise<unknown>;
  getMarketOutlook(): Promise<{ isMarketOpen: boolean; currentSession: string }>;
  generateSignal(settings: SimulationSettings, accountBalance: number, activeSignals: GeneratedSignalLike[]): Promise<GeneratedSignalLike | null>;
  getCurrentSRZonesForTest(): InvestigationSRZone[];
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
const OBSERVED_HOURS = Math.max(1, Number(process.env.SIGNAL_SIM_HOURS ?? "24"));
const OBSERVED_DURATION_MS = OBSERVED_HOURS * 60 * 60 * 1000;
const TOTAL_DURATION_MS = WARMUP_DURATION_MS + OBSERVED_DURATION_MS;
const STEP_MS = 30_000;
const BAR_INTERVAL_MS = 60_000;
const SANDBOX_SOURCE = "sandbox-part2-countertrend-investigation";
const BOUNCE_THRESHOLD = 10; // matches the real counter-trend branch's proximity check
// Checkpoint cadence: dense (every 6h) for <=24h runs, coarser (every 24h) for
// longer runs so output stays readable for 72h/168h.
const CHECKPOINT_STEP_HOURS = OBSERVED_HOURS <= 24 ? 6 : 24;
const CHECKPOINT_HOURS: number[] = [];
for (let h = CHECKPOINT_STEP_HOURS; h <= OBSERVED_HOURS; h += CHECKPOINT_STEP_HOURS) {
  CHECKPOINT_HOURS.push(h);
}
if (CHECKPOINT_HOURS[CHECKPOINT_HOURS.length - 1] !== OBSERVED_HOURS) {
  CHECKPOINT_HOURS.push(OBSERVED_HOURS);
}

const originalConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

let counterTrendRejections = 0;
let counterTrendConfirmations = 0;
const counterTrendRejectionSamples: string[] = [];
const counterTrendConfirmationSamples: string[] = [];
let primaryTrendCount = 0, counterTrendCount = 0, neutralCount = 0;
const rejectionCounts = new Map<string, number>();

function normalizeRejectionReason(line: string): string | null {
  if (!line.includes("REJECTED") && !line.includes("rejected")) return null;
  if (line.includes("Dynamic cooldown active")) return "Dynamic cooldown active";
  if (line.includes("below threshold") || line.includes("below absolute minimum")) return "Confidence below threshold";
  if (line.includes("Structural Validation Failed")) return "Structural validation failed";
  if (line.includes("COUNTER-TREND REJECTED")) return "Counter-trend: no qualifying zone/OB";
  if (line.includes("Counter-trend signal requires 5-minute candle confirmation")) return "Missing 5-minute candle confirmation";
  if (line.includes("Price Proximity Filter Block")) return "Price proximity filter block";
  if (line.includes("Macro event suppression")) return "Macro event suppression";
  if (line.includes("Signal conflict prevention")) return "Signal conflict prevention";
  if (line.includes("No valid price available yet")) return "No valid price available";
  if (line.includes("BASELINE OPPOSING-STRUCTURE VETO")) return "Step 3 opposing-structure veto";
  return line.replace(/\s+/g, " ").trim().slice(0, 90);
}

function trackRejectionReason(line: string): void {
  const reason = normalizeRejectionReason(line);
  if (!reason) return;
  rejectionCounts.set(reason, (rejectionCounts.get(reason) ?? 0) + 1);
}

function stringifyLogValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function trackCounterTrendLine(line: string): void {
  trackRejectionReason(line);
  if (line.includes("COUNTER-TREND REJECTED: Not bouncing off a real")) {
    counterTrendRejections += 1;
    if (counterTrendRejectionSamples.length < 8) counterTrendRejectionSamples.push(line.trim());
  } else if (line.includes("BOUNCE CONFIRMED: Counter-trend from")) {
    counterTrendConfirmations += 1;
    if (counterTrendConfirmationSamples.length < 8) counterTrendConfirmationSamples.push(line.trim());
  } else if (line.startsWith("Classification: PRIMARY TREND")) {
    primaryTrendCount += 1;
  } else if (line.startsWith("Classification: COUNTER-TREND")) {
    counterTrendCount += 1;
  } else if (line.startsWith("Classification: NEUTRAL")) {
    neutralCount += 1;
  }
}

function installQuietConsole(): () => void {
  console.log = (...args: unknown[]) => { trackCounterTrendLine(args.map(stringifyLogValue).join(" ")); };
  console.warn = (...args: unknown[]) => { trackCounterTrendLine(args.map(stringifyLogValue).join(" ")); };
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
// For runs longer than 24h, the base synthetic-price cycle (progress in
// [0,1] mapped to OBSERVED_HOURS) is repeated so a 72h/168h run isn't just a
// stretched-out single cycle with no additional distinct price action — each
// wrapped 24h block re-runs the same intraday shape (trend/vol/shock) which
// is a reasonable proxy for "more days like this one", while still letting
// zone/touch history accumulate across the full elapsed time (zones are
// keyed by price level, not by day).
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
  const sandboxPath = path.join(sandboxDir, "signalEngine.part2countertrend.ts");
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
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<SandboxSignalEngineModule>;
}

interface NearestZoneInfo {
  found: boolean;
  distance: number;
  reactionStrength: number;
  touches: number;
  qualifies: boolean;
}

interface ZoneCheckpoint {
  hours: number;
  price: number;
  nearestSupport: NearestZoneInfo;
  nearestResistance: NearestZoneInfo;
  maxSupportRS: { reactionStrength: number; touches: number };
  maxResistanceRS: { reactionStrength: number; touches: number };
  qualifyingSupportCount: number;
  qualifyingResistanceCount: number;
}

function nearestZone(zones: InvestigationSRZone[], type: "SUPPORT" | "RESISTANCE", price: number): NearestZoneInfo {
  const candidates = zones.filter(z => z.type === type && Math.abs(z.price - price) < BOUNCE_THRESHOLD);
  if (candidates.length === 0) return { found: false, distance: NaN, reactionStrength: NaN, touches: NaN, qualifies: false };
  candidates.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  const nearest = candidates[0];
  return {
    found: true,
    distance: Math.abs(nearest.price - price),
    reactionStrength: nearest.reactionStrength,
    touches: nearest.touches,
    qualifies: nearest.reactionStrength >= 0.3 && nearest.touches >= 2,
  };
}

function maxRS(zones: InvestigationSRZone[], type: "SUPPORT" | "RESISTANCE"): { reactionStrength: number; touches: number } {
  const side = zones.filter(z => z.type === type);
  if (side.length === 0) return { reactionStrength: 0, touches: 0 };
  const best = side.reduce((a, b) => (b.reactionStrength > a.reactionStrength ? b : a));
  return { reactionStrength: best.reactionStrength, touches: best.touches };
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

async function main(): Promise<void> {
  originalConsole.log(`\nPART 2 COUNTER-TREND GATE INVESTIGATION — ${OBSERVED_HOURS}h cold-start replay\n`);
  originalConsole.log("=".repeat(72));

  const restoreClock = installVirtualClock();
  const restoreConsole = installQuietConsole();
  const checkpoints: ZoneCheckpoint[] = [];
  let signalCount = 0, buyCount = 0, sellCount = 0;
  const seenHours = new Set<number>();

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

      const observedHoursElapsed = observedElapsedMs / (60 * 60 * 1000);
      for (const hours of CHECKPOINT_HOURS) {
        if (!seenHours.has(hours) && observedHoursElapsed >= hours) {
          seenHours.add(hours);
          const zones = signalEngine.getCurrentSRZonesForTest();
          checkpoints.push({
            hours,
            price: syntheticPrice,
            nearestSupport: nearestZone(zones, "SUPPORT", syntheticPrice),
            nearestResistance: nearestZone(zones, "RESISTANCE", syntheticPrice),
            maxSupportRS: maxRS(zones, "SUPPORT"),
            maxResistanceRS: maxRS(zones, "RESISTANCE"),
            qualifyingSupportCount: zones.filter(z => z.type === "SUPPORT" && z.reactionStrength >= 0.3 && z.touches >= 2).length,
            qualifyingResistanceCount: zones.filter(z => z.type === "RESISTANCE" && z.reactionStrength >= 0.3 && z.touches >= 2).length,
          });
        }
      }
    }

    const stats = signalEngine.getSignalGenerationStats();

    originalConsole.log(`\n1) ZONE PROXIMITY/QUALIFICATION TRACE (nearest zone within ${BOUNCE_THRESHOLD} of price, each side)\n`);
    for (const cp of checkpoints) {
      originalConsole.log(`--- ${cp.hours}h checkpoint (price=${cp.price.toFixed(2)}) ---`);
      originalConsole.log(`  Nearest SUPPORT (BUY-side):    ${cp.nearestSupport.found ? `dist=${cp.nearestSupport.distance.toFixed(2)} RS=${(cp.nearestSupport.reactionStrength * 100).toFixed(1)}% touches=${cp.nearestSupport.touches} qualifies=${cp.nearestSupport.qualifies}` : "none within threshold"}`);
      originalConsole.log(`  Nearest RESISTANCE (SELL-side): ${cp.nearestResistance.found ? `dist=${cp.nearestResistance.distance.toFixed(2)} RS=${(cp.nearestResistance.reactionStrength * 100).toFixed(1)}% touches=${cp.nearestResistance.touches} qualifies=${cp.nearestResistance.qualifies}` : "none within threshold"}`);
      originalConsole.log(`  MAX RS anywhere - SUPPORT:    ${(cp.maxSupportRS.reactionStrength * 100).toFixed(1)}% @ touches=${cp.maxSupportRS.touches}`);
      originalConsole.log(`  MAX RS anywhere - RESISTANCE: ${(cp.maxResistanceRS.reactionStrength * 100).toFixed(1)}% @ touches=${cp.maxResistanceRS.touches}`);
      originalConsole.log(`  Qualifying (>=0.3 & touches>=2) zone count: SUPPORT=${cp.qualifyingSupportCount} RESISTANCE=${cp.qualifyingResistanceCount}`);
      originalConsole.log("");
    }

    originalConsole.log("2) SIGNAL GENERATION SUMMARY\n");
    originalConsole.log(`  Duration: ${OBSERVED_HOURS}h observed (+90m warmup)`);
    originalConsole.log(`  Engine attempts: ${stats.attempts} | successful: ${stats.successful} | rate: ${(stats.rate * 100).toFixed(2)}%`);
    originalConsole.log(`  Signals generated: ${signalCount} (${buyCount} BUY / ${sellCount} SELL)`);
    originalConsole.log(`  Structural classification counts: PRIMARY=${primaryTrendCount} COUNTER=${counterTrendCount} NEUTRAL=${neutralCount}`);
    originalConsole.log(`  Counter-trend branch: REJECTED=${counterTrendRejections} | CONFIRMED=${counterTrendConfirmations}`);
    originalConsole.log(`  Step 3 veto explicit count: ${rejectionCounts.get("Step 3 opposing-structure veto") ?? 0}`);
    originalConsole.log(`  Counter-trend zone-gate explicit count: ${rejectionCounts.get("Counter-trend: no qualifying zone/OB") ?? 0}`);
    const topRejections = [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (topRejections.length > 0) {
      originalConsole.log("  Top rejection reasons (all gates, not just counter-trend):");
      topRejections.forEach(([reason, count]) => originalConsole.log(`    - ${reason}: ${count}`));
    }
    if (counterTrendRejectionSamples.length > 0) {
      originalConsole.log("  Sample rejections:");
      counterTrendRejectionSamples.forEach(s => originalConsole.log(`    - ${s}`));
    }
    if (counterTrendConfirmationSamples.length > 0) {
      originalConsole.log("  Sample confirmations:");
      counterTrendConfirmationSamples.forEach(s => originalConsole.log(`    - ${s}`));
    }
  } finally {
    restoreConsole();
    restoreClock();
    delete globalThis.__SIGNAL_SIMULATION_CONTEXT__;
  }

  originalConsole.log("\n" + "=".repeat(72));
  originalConsole.log(`END OF ${OBSERVED_HOURS}h RUN\n`);
}

main().catch((error) => { originalConsole.error(error); process.exit(1); });
