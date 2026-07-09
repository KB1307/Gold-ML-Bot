import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * CHECKPOINT TEST — glitch-tick corroboration gate for Part B's real
 * tick-frequency order-flow signal. Confirms a burst of lone, uncorroborated
 * glitch ticks (same shape the bar-ingest spike gate in TradingContext.tsx
 * would reject) does NOT inflate the tick-frequency count recordTickArrival()
 * feeds into calculateOrderFlow(), while genuine sustained activity still does.
 */

interface Engine {
  pushTickForTest(price: number): number;
  resetTickFrequencyStateForTest(): void;
  calculateOrderFlowForTest(injected: { tickTimestamps?: number[]; spreadHistory?: number[]; lastKnownSpreadPips?: number; priceHistory?: number[] }): { volumeImbalance: number; institutionalFootprint: number; largeOrdersDetected: boolean };
}

interface Module {
  signalEngine: Engine;
}

async function loadEngine(): Promise<Module> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.tickgate.ts");
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
`;

  const rewritten = source
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, "")
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/learningStore["'];?\r?\n/m, "")
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

async function main(): Promise<void> {
  const { signalEngine } = await loadEngine();

  console.log("\n=== Glitch-tick corroboration gate checkpoint ===\n");

  // Scenario 1: a steady, plausible run of real ticks (small moves) — all should count.
  signalEngine.resetTickFrequencyStateForTest();
  let price = 3250.0;
  let lastCount = 0;
  for (let i = 0; i < 10; i++) {
    price += (i % 2 === 0 ? 0.3 : -0.2); // small, plausible moves well inside budget
    lastCount = signalEngine.pushTickForTest(price);
  }
  check(
    "Steady plausible ticks all counted toward real tick-frequency",
    lastCount === 10,
    `expected 10 retained ticks, got ${lastCount}`
  );

  // Scenario 2: a burst of LONE glitch ticks — each jumps far beyond the spike budget,
  // then immediately reverts (no second tick corroborates the new level). None should count.
  signalEngine.resetTickFrequencyStateForTest();
  const baseline = 3250.0;
  let countAfterBaseline = signalEngine.pushTickForTest(baseline); // seeds the gate, always accepted
  check("Baseline seed tick accepted", countAfterBaseline === 1, `count=${countAfterBaseline}`);

  // Each spike is a LONE glitch (never corroborated by a 2nd tick near it before the
  // next, unrelated push arrives) -- it must never itself increase the retained count.
  // The tick that reverts back to `baseline` right after is a SEPARATE, genuine tick
  // (it matches the last accepted real price, not the glitch) and legitimately counts --
  // the gate's job is only to exclude the glitch itself, not everything that follows it.
  let spikesThatInflatedCount = 0;
  let countBeforeSpike = countAfterBaseline;
  const glitchCounts: number[] = [];
  for (let i = 0; i < 5; i++) {
    const spikeCount = signalEngine.pushTickForTest(baseline + 4.0);
    if (spikeCount > countBeforeSpike) spikesThatInflatedCount++;
    const revertCount = signalEngine.pushTickForTest(baseline);
    countBeforeSpike = revertCount;
    glitchCounts.push(spikeCount, revertCount);
  }
  const finalGlitchCount = glitchCounts[glitchCounts.length - 1];
  check(
    "None of the 5 lone glitch spikes themselves inflate the real tick-frequency count",
    spikesThatInflatedCount === 0,
    `${spikesThatInflatedCount}/5 glitch spikes were incorrectly counted (sequence: ${glitchCounts.join(",")})`
  );
  check(
    "Only the genuine (non-glitch) reverts to the last real price are counted, not the glitches themselves",
    finalGlitchCount === 1 + 5,
    `expected 1 baseline + 5 genuine reverts = 6, got ${finalGlitchCount} (sequence: ${glitchCounts.join(",")})`
  );

  // Scenario 3: a genuine large move CORROBORATED by a second independent tick near the
  // new level within the confirm window — this should count (real move, not a glitch).
  signalEngine.resetTickFrequencyStateForTest();
  signalEngine.pushTickForTest(baseline); // seed
  const candidateCount = signalEngine.pushTickForTest(baseline + 4.0); // large jump, uncorroborated yet
  const corroboratedCount = signalEngine.pushTickForTest(baseline + 4.1); // 2nd tick near the new level -> corroborated
  check(
    "Uncorroborated large jump alone is excluded",
    candidateCount === 1,
    `count after 1st jump=${candidateCount}`
  );
  check(
    "Large jump confirmed by a 2nd independent tick near the same level IS counted (real move, not a glitch)",
    corroboratedCount === 2,
    `count after corroborating tick=${corroboratedCount}`
  );

  // Scenario 4: re-run the existing Part B QUIET vs BUSY differential using the injected-data
  // seam (unaffected by this gate, since it bypasses recordTickArrival by design) to confirm
  // the underlying differential signal itself is untouched by this fix.
  const now = Date.now();
  const baselineTicks: number[] = [];
  for (let t = now - 10 * 60 * 1000; t <= now - 60 * 1000; t += 6000) baselineTicks.push(t);
  const quietTicks = [...baselineTicks, now - 55000, now - 40000];
  const busyTicks = [...baselineTicks];
  for (let t = now - 55000; t <= now; t += 2000) busyTicks.push(t);
  const priceHistory = Array.from({ length: 10 }, (_, i) => parseFloat((3250 + 3 * (i / 9) + Math.sin(i) * 0.3).toFixed(2)));

  const quiet = signalEngine.calculateOrderFlowForTest({ tickTimestamps: quietTicks, spreadHistory: [1.1, 1.3, 1.2, 1.0, 1.4, 1.2, 1.1, 1.3], lastKnownSpreadPips: 1.8, priceHistory });
  const busy = signalEngine.calculateOrderFlowForTest({ tickTimestamps: busyTicks, spreadHistory: [1.1, 1.3, 1.2, 1.0, 1.4, 1.2, 1.1, 1.3], lastKnownSpreadPips: 0.6, priceHistory });
  check(
    "Part B QUIET vs BUSY differential still holds after the gate fix (genuine real activity still produces a different signal)",
    busy.institutionalFootprint > quiet.institutionalFootprint,
    `busy=${busy.institutionalFootprint} > quiet=${quiet.institutionalFootprint}`
  );

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Glitch-tick corroboration gate checkpoint verified."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
