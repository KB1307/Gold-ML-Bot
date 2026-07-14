import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * ITEM 3 follow-up — cold-start boundary test for the `period + 1` minimum-data
 * requirement introduced by the ATR array-misalignment fix.
 *
 * Before the fix: calculateRealATR(period) required `highHistory.length >= period`
 * (14 for the default period) before computing a real value, else it returned the
 * hardcoded fallback (10).
 * After the fix: it requires `>= period + 1` (15) on highHistory, lowHistory, AND
 * barCloseHistory, because every one of the `period` true-range calculations needs
 * a genuine previous bar to read prevClose from.
 *
 * This is a genuine (small) behavior change: there is now one additional bar's
 * worth of cold-start/early-startup time (exactly 14 bars available, previously
 * sufficient, now insufficient) during which calculateRealATR falls back to the
 * default value 10 instead of computing a real number. This was reasoned about as
 * "shouldn't cause practical issues" but had NOT been exercised by any existing
 * test (verify_item3_atr_array_misalignment.ts, test_pivot_floor_fix.ts, and
 * test_srzone_floor_fix.ts all build history arrays well above the boundary —
 * 20, 21, and 60 entries respectively). This script closes that gap with a
 * dedicated boundary test using the real production code path
 * (pushBarRefreshForTest -> calculateRealATR via getRealATRForTest), not a
 * reimplementation.
 */

interface Engine {
  pushBarRefreshForTest(bars: { high: number; low: number; close: number }[]): void;
  getRealATRForTest(period?: number): number;
}

interface Module {
  signalEngine: Engine;
}

async function loadEngine(): Promise<Module> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.coldstart.ts");
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

/** Genuine timestamp-matched ground-truth ATR, same helper logic as verify_item3_atr_array_misalignment.ts. */
function groundTruthATR(bars: { high: number; low: number; close: number }[], period: number): number {
  const recent = bars.slice(-period - 1);
  const trueRanges: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const bar = recent[i];
    const prevClose = recent[i - 1].close;
    const tr = Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    trueRanges.push(tr);
  }
  return trueRanges.reduce((s, v) => s + v, 0) / trueRanges.length;
}

function buildBars(count: number): { high: number; low: number; close: number }[] {
  const bars: { high: number; low: number; close: number }[] = [];
  let px = 4010.0;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 3) * 0.15;
    const open = px;
    const close = open + drift;
    const high = Math.max(open, close) + 0.15;
    const low = Math.min(open, close) - 0.15;
    bars.push({ high, low, close });
    px = close;
  }
  return bars;
}

async function main(): Promise<void> {
  const period = 14;
  console.log(`\n=== Item 3 follow-up: cold-start boundary test for calculateRealATR's period+1 minimum-data requirement (period=${period}) ===\n`);

  // ------------------------------------------------------------------------
  // Case 1: EXACTLY `period` (14) bars available -- the real early-startup
  // moment where the OLD code would have computed a (misaligned) real value,
  // but the FIXED code must fall back to the hardcoded default (10), since
  // every one of the `period` true-range calculations needs a genuine
  // previous bar (i.e. period+1 = 15 bars minimum).
  // ------------------------------------------------------------------------
  {
    const { signalEngine } = await loadEngine();
    const bars = buildBars(period); // exactly 14 bars
    signalEngine.pushBarRefreshForTest(bars);
    const atr = signalEngine.getRealATRForTest(period);
    console.log(`Case 1 -- exactly ${period} bars (one short of the period+1=${period + 1} requirement):`);
    console.log(`  calculateRealATR(${period}) = ${atr}`);
    check(
      `with exactly ${period} bars, calculateRealATR falls back to the default value (10), not a computed (and potentially misaligned/undersized) real number`,
      atr === 10,
      `got ${atr}, expected fallback default 10`
    );
  }

  // ------------------------------------------------------------------------
  // Case 2: EXACTLY `period + 1` (15) bars available -- the first moment the
  // FIXED code can compute a real value. Must match ground truth (computed
  // independently via genuine timestamp-matched prevClose on the SAME bar
  // series), confirming the boundary transition itself is correct, not just
  // "does it produce a number".
  // ------------------------------------------------------------------------
  {
    const { signalEngine } = await loadEngine();
    const bars = buildBars(period + 1); // exactly 15 bars
    const gt = groundTruthATR(bars, period);
    signalEngine.pushBarRefreshForTest(bars);
    const atr = signalEngine.getRealATRForTest(period);
    console.log(`\nCase 2 -- exactly ${period + 1} bars (the minimum the fixed code needs):`);
    console.log(`  Ground-truth ATR(${period}): $${gt.toFixed(2)}`);
    console.log(`  calculateRealATR(${period}) = $${atr.toFixed(2)}`);
    check(
      `with exactly ${period + 1} bars, calculateRealATR now computes a REAL value (not the fallback default 10)`,
      atr !== 10,
      `got ${atr}`
    );
    check(
      `that real value matches genuine timestamp-matched ground truth (confirms the boundary itself, not just "a number came out")`,
      Math.abs(atr - gt) <= 0.05,
      `reproduced=$${atr.toFixed(2)} vs ground-truth=$${gt.toFixed(2)}`
    );
  }

  // ------------------------------------------------------------------------
  // Case 3: incremental cold-start growth -- simulates the real production
  // "estimated" single-bar-at-a-time fallback path bar-by-bar (1, 2, ... 15
  // bars), confirming the fallback default holds throughout the ENTIRE
  // sub-threshold climb (not just at the period=14 boundary checked above)
  // and only flips to a real value the instant the 15th bar lands.
  // ------------------------------------------------------------------------
  {
    const { signalEngine } = await loadEngine();
    const allBars = buildBars(period + 1);
    let sawEarlyRealValue = false;
    let firstRealValueAtCount = -1;
    for (let n = 1; n <= allBars.length; n++) {
      signalEngine.pushBarRefreshForTest(allBars.slice(0, n));
      const atr = signalEngine.getRealATRForTest(period);
      if (atr !== 10 && firstRealValueAtCount === -1) {
        firstRealValueAtCount = n;
      }
      if (atr !== 10 && n < period + 1) {
        sawEarlyRealValue = true;
      }
    }
    console.log(`\nCase 3 -- incremental cold-start growth (1..${period + 1} bars, one at a time):`);
    console.log(`  First bar count at which a real (non-fallback) ATR value appeared: ${firstRealValueAtCount}`);
    check(
      `no premature real value appears before ${period + 1} bars are available`,
      !sawEarlyRealValue,
      sawEarlyRealValue ? "a real value leaked through before the threshold" : "fallback held throughout the entire sub-threshold climb"
    );
    check(
      `the fallback default correctly flips to a real value at EXACTLY ${period + 1} bars, not earlier or later`,
      firstRealValueAtCount === period + 1,
      `first real value at bar count ${firstRealValueAtCount}, expected ${period + 1}`
    );
  }

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) {
    console.error(`❌ ${fail} FAILED`);
    process.exit(1);
  } else {
    console.log("✅ Cold-start ATR boundary CONFIRMED with real production code (pushBarRefreshForTest -> calculateRealATR via getRealATRForTest): the fallback default correctly covers the entire sub-(period+1) startup window with no premature or delayed transition, and the first real value at the boundary matches genuine ground truth.");
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
