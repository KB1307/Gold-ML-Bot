import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * CHECKPOINT TEST — Part B: real tick-frequency + real spread as the order-flow signal.
 * Compares the new real-data-based calculateOrderFlow()/calculateVolumeProfile() against
 * what the OLD synthetic momentum-only formula would have produced for the same price
 * action, using injected (deterministic) tick-arrival/spread data via the new test seams.
 */

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

interface Engine {
  calculateOrderFlowForTest(injected: { tickTimestamps?: number[]; spreadHistory?: number[]; lastKnownSpreadPips?: number; priceHistory?: number[] }): OrderFlowData;
  calculateVolumeProfileForTest(injected: { tickPriceSamples?: { price: number; timestamp: number }[]; priceHistory?: number[] }): VolumeProfile;
}

interface Module {
  signalEngine: Engine;
}

async function loadEngine(): Promise<Module> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.partB.ts");
  const sourcePath = path.join(process.cwd(), "services", "signalEngine.ts");
  const source = await readFile(sourcePath, "utf8");

  const sandboxPrelude = `import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext } from "../../types/trading.ts";

const sandboxStorage = new Map<string, string>();
const AsyncStorage = {
  async getItem(key: string): Promise<string | null> { return sandboxStorage.get(key) ?? null; },
  async setItem(key: string, value: string): Promise<void> { sandboxStorage.set(key, value); },
  async removeItem(key: string): Promise<void> { sandboxStorage.delete(key); },
};
const trpcClient = {
  goldPrice: { getIntermarketData: { query: async () => ({ dxy: 103.5, us10y: 4.2, vix: 18 }) }, getSpotPrice: { query: async () => ({ price: 3250, source: "test" }) } },
  economicCalendar: { getUpcomingEvents: { query: async () => ({ events: [], source: "UNAVAILABLE" as const, cached: false, timestamp: Date.now() }) } },
} as any;
async function fetchHistoricalData(): Promise<any[]> { return []; }
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
`;

  const rewritten = source
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, "")
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/learningStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/diagnosticEventStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, "");

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<Module>;
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

// Replica of the OLD synthetic momentum-only calculateOrderFlow(), for side-by-side comparison only.
function oldSyntheticOrderFlow(priceHistory: number[]): OrderFlowData {
  if (priceHistory.length < 5) {
    return { bidVolume: 1000, askVolume: 1000, volumeImbalance: 0, largeOrdersDetected: false, institutionalFootprint: 0 };
  }
  const recentPrices = priceHistory.slice(-10);
  const priceChange = recentPrices[recentPrices.length - 1] - recentPrices[0];
  const range = Math.max(...recentPrices) - Math.min(...recentPrices);
  const momentum = priceChange / (range || 1);
  const baseVolume = 1000; // volatilityProxy omitted for a clean side-by-side (kept 0 contribution)
  let bidVolume = baseVolume;
  let askVolume = baseVolume;
  if (momentum > 0.2) bidVolume *= (1 + momentum);
  else if (momentum < -0.2) askVolume *= (1 + Math.abs(momentum));
  const midRange = (Math.max(...recentPrices) + Math.min(...recentPrices)) / 2;
  const currentPrice = recentPrices[recentPrices.length - 1];
  const positionInRange = (currentPrice - midRange) / (range || 1);
  bidVolume += baseVolume * 0.1 * Math.max(0, -positionInRange);
  askVolume += baseVolume * 0.1 * Math.max(0, positionInRange);
  const volumeImbalance = (bidVolume - askVolume) / (bidVolume + askVolume);
  const isAbsorption = Math.abs(momentum) < 0.3 && range > 5;
  const isAggression = Math.abs(momentum) > 0.8;
  const largeOrdersDetected = isAbsorption || isAggression;
  const institutionalFootprint = Math.abs(volumeImbalance) * (largeOrdersDetected ? 2 : 1);
  return {
    bidVolume: Math.floor(bidVolume),
    askVolume: Math.floor(askVolume),
    volumeImbalance: parseFloat(volumeImbalance.toFixed(3)),
    largeOrdersDetected,
    institutionalFootprint: parseFloat(institutionalFootprint.toFixed(2)),
  };
}

function buildPriceHistory(basePrice: number, netMove: number, samples = 10): number[] {
  const arr: number[] = [];
  for (let i = 0; i < samples; i++) {
    arr.push(parseFloat((basePrice + (netMove * (i / (samples - 1))) + (Math.sin(i) * 0.3)).toFixed(2)));
  }
  return arr;
}

async function main(): Promise<void> {
  const { signalEngine } = await loadEngine();
  const now = Date.now();

  console.log("\n=== Part B: Real tick-frequency + spread order-flow checkpoint ===\n");

  // Scenario 1: insufficient real data yet (very early in a session) — must clearly fall back
  // to a neutral baseline, not a fabricated synthetic value.
  const insufficientPriceHistory = buildPriceHistory(3250, 8);
  const insufficient = signalEngine.calculateOrderFlowForTest({
    tickTimestamps: [now - 5000, now - 2000], // only 2 ticks, way under MIN_BASELINE_TICKS/span
    spreadHistory: [],
    lastKnownSpreadPips: 0,
    priceHistory: insufficientPriceHistory,
  });
  check(
    "Insufficient real data -> neutral fallback (imbalance driven only by direction, not fabricated magnitude)",
    Math.abs(insufficient.volumeImbalance) < 0.01 && insufficient.largeOrdersDetected === false,
    `imbalance=${insufficient.volumeImbalance}, largeOrders=${insufficient.largeOrdersDetected}`
  );

  // Build a realistic "baseline" tick history: steady ~10 ticks/min over the last 10 minutes,
  // and a realistic baseline spread history around ~1.2 pips.
  const baselineTicks: number[] = [];
  for (let t = now - 10 * 60 * 1000; t <= now - 60 * 1000; t += 6000) baselineTicks.push(t); // ~10/min baseline
  const baselineSpreads = [1.1, 1.3, 1.2, 1.0, 1.4, 1.2, 1.1, 1.3];

  // Scenario 2: QUIET conditions — recent tick rate at/below baseline, spread at/above baseline.
  const quietTicks = [...baselineTicks, now - 55000, now - 40000]; // only 2 ticks in the last 60s (quieter than baseline ~10/min)
  const quietPriceHistory = buildPriceHistory(3250, 3); // mild net move
  const quiet = signalEngine.calculateOrderFlowForTest({
    tickTimestamps: quietTicks,
    spreadHistory: baselineSpreads,
    lastKnownSpreadPips: 1.8, // wider than baseline avg (~1.2)
    priceHistory: quietPriceHistory,
  });
  const quietOld = oldSyntheticOrderFlow(quietPriceHistory);
  console.log(`  QUIET   -> new: imbalance=${quiet.volumeImbalance}, footprint=${quiet.institutionalFootprint}, largeOrders=${quiet.largeOrdersDetected} | old(momentum-only): imbalance=${quietOld.volumeImbalance}, footprint=${quietOld.institutionalFootprint}, largeOrders=${quietOld.largeOrdersDetected}`);

  // Scenario 3: ACTIVE/BUSY conditions — genuine tick-frequency burst (many ticks in last 60s)
  // AND a genuinely tight spread (more liquid), same price action as the quiet case.
  const busyTicks = [...baselineTicks];
  for (let t = now - 55000; t <= now; t += 2000) busyTicks.push(t); // ~28 ticks in the last 60s (well above baseline ~10/min)
  const busyPriceHistory = buildPriceHistory(3250, 3); // SAME price action as quiet scenario
  const busy = signalEngine.calculateOrderFlowForTest({
    tickTimestamps: busyTicks,
    spreadHistory: baselineSpreads,
    lastKnownSpreadPips: 0.6, // tighter than baseline avg (~1.2)
    priceHistory: busyPriceHistory,
  });
  const busyOld = oldSyntheticOrderFlow(busyPriceHistory);
  console.log(`  BUSY    -> new: imbalance=${busy.volumeImbalance}, footprint=${busy.institutionalFootprint}, largeOrders=${busy.largeOrdersDetected} | old(momentum-only): imbalance=${busyOld.volumeImbalance}, footprint=${busyOld.institutionalFootprint}, largeOrders=${busyOld.largeOrdersDetected}`);

  check(
    "Same price action, different REAL activity level -> new values diverge (old momentum-only values are identical)",
    quietOld.volumeImbalance === busyOld.volumeImbalance && quiet.institutionalFootprint !== busy.institutionalFootprint,
    `old identical: ${quietOld.volumeImbalance === busyOld.volumeImbalance} | new footprints differ: ${quiet.institutionalFootprint} vs ${busy.institutionalFootprint}`
  );
  check(
    "BUSY (real tick burst + tight spread) -> largeOrdersDetected fires on real activity, not synthetic momentum",
    busy.largeOrdersDetected === true,
    `largeOrders=${busy.largeOrdersDetected}`
  );
  check(
    "BUSY institutionalFootprint > QUIET institutionalFootprint (tracks genuine activity level, not just direction)",
    busy.institutionalFootprint > quiet.institutionalFootprint,
    `busy=${busy.institutionalFootprint} > quiet=${quiet.institutionalFootprint}`
  );

  // Volume profile: real tick-price samples vs. priceHistory-only fallback.
  const tickPriceSamples = Array.from({ length: 50 }, (_, i) => ({ price: 3250 + (i % 5) * 0.5, timestamp: now - i * 1000 }));
  const profileFromTicks = signalEngine.calculateVolumeProfileForTest({ tickPriceSamples, priceHistory: [] });
  check(
    "Volume profile builds from real tick-price samples when available",
    profileFromTicks.pointOfControl > 0,
    `pointOfControl=${profileFromTicks.pointOfControl}, HVN=${profileFromTicks.highVolumeNodes.join(",")}`
  );
  const profileFallback = signalEngine.calculateVolumeProfileForTest({ tickPriceSamples: [], priceHistory: buildPriceHistory(3250, 5, 30) });
  check(
    "Volume profile falls back to priceHistory when real tick samples are insufficient (not silently broken)",
    profileFallback.pointOfControl > 0,
    `pointOfControl=${profileFallback.pointOfControl}`
  );

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Part B real tick-frequency + spread order-flow checkpoint verified."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
