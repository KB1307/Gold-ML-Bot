import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * STEP 3 PRE-FLIGHT INVESTIGATION — always-admitted zone hypothesis
 *
 * Before touching OPPOSING_ZONE_VETO_PROXIMITY / OPPOSING_ZONE_VETO_MIN_REACTION,
 * this script checks whether always-admitted structural sources (PREV_DAY,
 * ASIAN_RANGE, ORH_ORL, WEEKLY, PIVOT) reach reactionStrength >= 0.3 "for free"
 * (i.e. with zero touches/rejection wicks) and then sit there undecayed all day
 * (lastTouch === 0 is explicitly exempted from the Step 2 recency decay), which
 * would make the veto fire almost everywhere regardless of its proximity/
 * threshold constants — a zone-density problem, not a threshold-tuning problem.
 *
 * This runs the SAME accelerated 24h simulation as runSignalSimulation.ts (same
 * synthetic price path, same warmup, same sandboxing approach) but additionally
 * samples the live this.srZones snapshot (via the new getCurrentSRZonesForTest
 * seam) at 6h/12h/18h/24h observed-time checkpoints and breaks it down by
 * source + lastTouch===0 vs. genuinely touched, plus reports price-gap density
 * among qualifying (>=0.3) zones.
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

interface SandboxSignalEngine {
  loadPersistedLearningData(): Promise<unknown>;
  updateCurrentPrice(): Promise<number>;
  updateDailyOHLC(currentPrice: number): Promise<unknown>;
  getMarketOutlook(): Promise<{ isMarketOpen: boolean; currentSession: string }>;
  generateSignal(settings: SimulationSettings, accountBalance: number, activeSignals: unknown[]): Promise<unknown | null>;
  getCurrentSRZonesForTest(): InvestigationSRZone[];
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
const OBSERVED_HOURS = 24;
const OBSERVED_DURATION_MS = OBSERVED_HOURS * 60 * 60 * 1000;
const TOTAL_DURATION_MS = WARMUP_DURATION_MS + OBSERVED_DURATION_MS;
const STEP_MS = 30_000;
const BAR_INTERVAL_MS = 60_000;
const SANDBOX_SOURCE = "sandbox-zone-density-investigation";
const CHECKPOINT_HOURS = [6, 12, 18, 24];

const originalConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

function installQuietConsole(): () => void {
  console.log = () => {};
  console.warn = () => {};
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
  const progress = getObservedProgress(timestamp);
  const elapsed = Math.max(0, timestamp - (SIMULATION_START_MS + WARMUP_DURATION_MS));
  const volatilityScale = getVolatilityScale(progress);
  const base = 3034.5 + getTrendComponent(progress);
  const waveA = Math.sin(elapsed / (1000 * 60 * 14)) * 1.9 * volatilityScale;
  const waveB = Math.cos(elapsed / (1000 * 60 * 39)) * 1.2 * volatilityScale;
  const waveC = Math.sin(elapsed / (1000 * 60 * 4.5)) * 0.6 * volatilityScale;
  const shock = getShockComponent(progress);
  return Number((base + waveA + waveB + waveC + shock).toFixed(2));
}
function getIntermarketSnapshot(timestamp: number): { dxy: number; us10y: number; vix: number } {
  const progress = getObservedProgress(timestamp);
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
    if (context.bars.length > 2_000) context.bars.shift();
    return;
  }
  lastBar.high = Math.max(lastBar.high, price);
  lastBar.low = Math.min(lastBar.low, price);
  lastBar.close = price;
}

async function buildSandboxModule(): Promise<SandboxSignalEngineModule> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.zonedensity.ts");
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

interface CheckpointBreakdown {
  hours: number;
  totalQualifying: number;
  bySource: Record<string, number>;
  neverTouchedQualifying: number;
  genuinelyTouchedQualifying: number;
  zones: InvestigationSRZone[];
}

function summarizeGaps(zones: InvestigationSRZone[]): { minGap: number; avgGap: number; medianGap: number } {
  const prices = [...new Set(zones.map(z => z.price))].sort((a, b) => a - b);
  if (prices.length < 2) return { minGap: NaN, avgGap: NaN, medianGap: NaN };
  const gaps: number[] = [];
  for (let i = 1; i < prices.length; i++) gaps.push(prices[i] - prices[i - 1]);
  gaps.sort((a, b) => a - b);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const median = gaps[Math.floor(gaps.length / 2)];
  return { minGap: gaps[0], avgGap: avg, medianGap: median };
}

async function main(): Promise<void> {
  originalConsole.log("\nSTEP 3 PRE-FLIGHT INVESTIGATION — always-admitted zone density hypothesis\n");
  originalConsole.log("=".repeat(70));

  const restoreClock = installVirtualClock();
  const restoreConsole = installQuietConsole();
  const checkpoints: CheckpointBreakdown[] = [];

  try {
    const sandboxModule = await buildSandboxModule();
    const signalEngine = sandboxModule.signalEngine;

    globalThis.__SIGNAL_SIMULATION_CONTEXT__ = { currentPrice: 0, bars: [], getIntermarketSnapshot };
    await signalEngine.loadPersistedLearningData();

    const seenHours = new Set<number>();

    for (let offsetMs = 0; offsetMs <= TOTAL_DURATION_MS; offsetMs += STEP_MS) {
      const timestamp = SIMULATION_START_MS + offsetMs;
      virtualNow = timestamp;

      const syntheticPrice = generateSyntheticPrice(timestamp);
      globalThis.__SIGNAL_SIMULATION_CONTEXT__!.currentPrice = syntheticPrice;
      upsertHistoricalBars(globalThis.__SIGNAL_SIMULATION_CONTEXT__!, timestamp, syntheticPrice);

      sandboxModule.setExternalPrice(syntheticPrice, SANDBOX_SOURCE);
      await signalEngine.updateCurrentPrice();
      await signalEngine.updateDailyOHLC(syntheticPrice);

      const observedElapsedMs = timestamp - (SIMULATION_START_MS + WARMUP_DURATION_MS);
      if (observedElapsedMs <= 0) continue;

      const outlook = await signalEngine.getMarketOutlook();
      if (outlook.isMarketOpen) {
        await signalEngine.generateSignal(
          { tp1Pips: 30, tp2Pips: 60, tp3Pips: 90, slPips: 70, minConfidence: 0.85, useDynamicSL: true, maxSLPips: 90 },
          10_000,
          [],
        );
      }

      const observedHoursElapsed = observedElapsedMs / (60 * 60 * 1000);
      for (const hours of CHECKPOINT_HOURS) {
        if (!seenHours.has(hours) && observedHoursElapsed >= hours) {
          seenHours.add(hours);
          const zones = signalEngine.getCurrentSRZonesForTest();
          const qualifying = zones.filter(z => z.reactionStrength >= 0.3);
          const bySource: Record<string, number> = {};
          for (const z of qualifying) bySource[z.source] = (bySource[z.source] ?? 0) + 1;
          checkpoints.push({
            hours,
            totalQualifying: qualifying.length,
            bySource,
            neverTouchedQualifying: qualifying.filter(z => z.lastTouch === 0).length,
            genuinelyTouchedQualifying: qualifying.filter(z => z.lastTouch !== 0).length,
            zones: qualifying,
          });
        }
      }
    }
  } finally {
    restoreConsole();
    restoreClock();
    delete globalThis.__SIGNAL_SIMULATION_CONTEXT__;
  }

  originalConsole.log("\n1) QUALIFYING (reactionStrength >= 0.3) ZONE BREAKDOWN BY SOURCE / LASTTOUCH\n");
  for (const cp of checkpoints) {
    originalConsole.log(`--- ${cp.hours}h checkpoint ---`);
    originalConsole.log(`  Total qualifying zones: ${cp.totalQualifying}`);
    originalConsole.log(`  Never-touched (lastTouch===0, undecayed by design): ${cp.neverTouchedQualifying} (${cp.totalQualifying > 0 ? ((cp.neverTouchedQualifying / cp.totalQualifying) * 100).toFixed(0) : 0}%)`);
    originalConsole.log(`  Genuinely touched (subject to Step 2 decay): ${cp.genuinelyTouchedQualifying} (${cp.totalQualifying > 0 ? ((cp.genuinelyTouchedQualifying / cp.totalQualifying) * 100).toFixed(0) : 0}%)`);
    originalConsole.log(`  By source: ${JSON.stringify(cp.bySource)}`);
    for (const z of cp.zones) {
      originalConsole.log(`    ${z.type} @ ${z.price.toFixed(1)} | RS=${(z.reactionStrength * 100).toFixed(0)}% | touches=${z.touches} | lastTouch=${z.lastTouch === 0 ? "NEVER" : "yes"} | source=${z.source} | confluence=${z.confluenceScore}`);
    }
    originalConsole.log("");
  }

  originalConsole.log("2) ZONE DENSITY (gap between qualifying zone prices, in $)\n");
  for (const cp of checkpoints) {
    const gaps = summarizeGaps(cp.zones);
    originalConsole.log(`  ${cp.hours}h: minGap=${gaps.minGap.toFixed(2)} avgGap=${gaps.avgGap.toFixed(2)} medianGap=${gaps.medianGap.toFixed(2)} (n=${cp.zones.length} distinct-price zones)`);
  }

  originalConsole.log("\n3) BASELINE REACTIONSTRENGTH FOR A ZERO-TOUCH, SINGLE-SOURCE ALWAYS-ADMIT ZONE (formula trace)\n");
  originalConsole.log("  With touches=0, rejectionWicks=0, cluster.count=1, sources.size=1:");
  const touchScore = 0, rejectionScore = 0, rejectionSizeScore = 0;
  const clusterScore = Math.min(1, 1 / 3);
  const confluenceBonus = Math.min(1, 1 * 0.25);
  const raw = Math.min(1, touchScore * 0.30 + rejectionScore * 0.30 + rejectionSizeScore * 0.20 + clusterScore * 0.20 + confluenceBonus);
  originalConsole.log(`    clusterScore=${clusterScore.toFixed(3)} (weight 0.20 -> ${(clusterScore * 0.2).toFixed(3)})`);
  originalConsole.log(`    confluenceBonus=${confluenceBonus.toFixed(3)} (weight 1.0 -> ${confluenceBonus.toFixed(3)})`);
  originalConsole.log(`    rawReactionStrength (zero evidence) = ${raw.toFixed(3)}  <-- ${raw >= 0.3 ? "ALREADY ABOVE the 0.3 gating threshold with ZERO touches/rejections" : "below threshold"}`);
  originalConsole.log(`    lastTouch===0 for this zone -> Step 2 decay factor is exempted (fixed at 1) -> this ${raw >= 0.3 ? "persists at this strength ALL DAY" : "does not qualify"}.`);

  originalConsole.log("\n" + "=".repeat(70));
  originalConsole.log("CONCLUSION");
  const totalQualAtEnd = checkpoints[checkpoints.length - 1]?.totalQualifying ?? 0;
  const neverTouchedAtEnd = checkpoints[checkpoints.length - 1]?.neverTouchedQualifying ?? 0;
  const neverTouchedShare = totalQualAtEnd > 0 ? neverTouchedAtEnd / totalQualAtEnd : 0;
  if (raw >= 0.3 && neverTouchedShare >= 0.3) {
    originalConsole.log("HYPOTHESIS CONFIRMED: always-admitted structural sources (PREV_DAY/ASIAN_RANGE/ORH_ORL/WEEKLY/PIVOT)");
    originalConsole.log("reach reactionStrength >= 0.3 from confluenceBonus + clusterScore ALONE (no touches/rejections required),");
    originalConsole.log("and because lastTouch===0 exempts them from Step 2's decay, they sit at that strength indefinitely.");
    originalConsole.log("This is a genuine zone-density/admission-scoring problem distinct from Step 3's proximity/threshold constants —");
    originalConsole.log("loosening OPPOSING_ZONE_VETO_PROXIMITY or raising OPPOSING_ZONE_VETO_MIN_REACTION would NOT fix this,");
    originalConsole.log("since the veto would still find an always-admitted, artificially-qualifying zone nearby most of the time.");
  } else {
    originalConsole.log("Hypothesis not fully confirmed by these numbers — see breakdown above for actual observed values.");
  }
}

main().catch((error) => { originalConsole.error(error); process.exit(1); });
