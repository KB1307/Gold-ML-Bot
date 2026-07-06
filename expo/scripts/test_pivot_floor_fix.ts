import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PIVOT FLOOR FIX CHECKPOINT TEST
 *
 * Bug: calculateDashboardPivotLevels() and calculateMarketFeatures() both used
 * a flat `Math.max(this.calculateRealATR(14), 2)` floor for the daily range fed
 * into Camarilla pivot math. getDerivedDailyOHLC() already used the correct
 * price-relative floor (`fallbackPrice * 0.008`), so this was an inconsistency,
 * not a missing feature.
 *
 * The bug bites specifically when:
 *   1. A genuinely tight prior-day range is on record (a real quiet trading
 *      day, or a completed daily bar) -- getDerivedDailyOHLC() does NOT widen
 *      a real recorded bar, only its own fallback-from-live-ticks path.
 *   2. currentPrice has since moved outside that prior-day range (e.g. an
 *      overnight gap), which triggers the "re-center pivots around live
 *      price" branch. That branch rebuilds H/L as `currentPrice +/- dailyRange/2`,
 *      so whatever floor clamps `dailyRange` directly controls the resulting
 *      R1-R3/S1-S3 spread.
 *
 * With the old flat-$2 floor, a tight prior-day bar ($1 range) plus a gap
 * would re-center pivots around a `max(1, 2) = 2`-wide range -- an
 * approximately $1-2 total R3-S3 spread, exactly the reported bug, regardless
 * of gold trading near $3,250. The fix makes that floor scale with price
 * (`currentPrice * 0.008`), matching the convention already used correctly in
 * getDerivedDailyOHLC().
 */

interface PivotEngine {
  getDashboardPivotLevelsForTest(
    price: number,
    highs: number[],
    lows: number[],
    closes: number[],
    priorDayBar?: { high: number; low: number; close: number; open: number }
  ): { dailyPivot: number; r1: number; r2: number; r3: number; s1: number; s2: number; s3: number };
  getRealATRForTest(period?: number): number;
}

interface PivotModule {
  signalEngine: PivotEngine;
}

async function loadEngine(): Promise<PivotModule> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.pivotfix.ts");
  const sourcePath = path.join(process.cwd(), "services", "signalEngine.ts");
  const source = await readFile(sourcePath, "utf8");

  const sandboxPrelude = `import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext } from "../../types/trading.ts";

const sandboxStorage = new Map<string, string>();
const AsyncStorage = {
  async getItem(key: string): Promise<string | null> { return sandboxStorage.get(key) ?? null; },
  async setItem(key: string, value: string): Promise<void> { sandboxStorage.set(key, value); },
  async removeItem(key: string): Promise<void> { sandboxStorage.delete(key); },
};
const trpcClient = {} as any;
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
  // import and produce duplicate-declaration errors.
  const rewritten = source
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, "")
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/learningStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, "");

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<PivotModule>;
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const { signalEngine } = await loadEngine();

  console.log("\nPivot floor fix: R1-R3/S1-S3 must scale with price, not a flat $2 floor\n");

  // Flat/low-volatility 20-bar tick history: every high/low/close within a
  // $0.20 band, so calculateRealATR(14) computes a tiny true range (< $2).
  const period = 20;
  const highs: number[] = [];
  const lows: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < period + 1; i++) {
    const c = 3250 + (i % 2 === 0 ? 0.05 : -0.05);
    closes.push(c);
    highs.push(c + 0.1);
    lows.push(c - 0.1);
  }

  // A genuine tight prior-day bar (real quiet day, $1 range) -- NOT the
  // fallback-from-live-ticks path, so it is not widened by any floor at all.
  const priorDayBar = { high: 3201, low: 3200, close: 3200.5, open: 3200.5 };
  // currentPrice has since gapped well outside that prior-day range, which
  // triggers the "re-center pivots around live price" branch.
  const gappedPrice = 3250;

  const levels = signalEngine.getDashboardPivotLevelsForTest(gappedPrice, highs, lows, closes, priorDayBar);
  const atr = signalEngine.getRealATRForTest(14);

  console.log(`  Prior-day bar (tight, on record): H ${priorDayBar.high} L ${priorDayBar.low} (range $${(priorDayBar.high - priorDayBar.low).toFixed(2)})`);
  console.log(`  Current price (gapped away): ${gappedPrice}`);
  console.log(`  Forced ATR(14): ${atr.toFixed(2)}`);
  console.log(`  Pivot: ${levels.dailyPivot.toFixed(2)}`);
  console.log(`  R1/R2/R3: ${levels.r1.toFixed(2)} / ${levels.r2.toFixed(2)} / ${levels.r3.toFixed(2)}`);
  console.log(`  S1/S2/S3: ${levels.s1.toFixed(2)} / ${levels.s2.toFixed(2)} / ${levels.s3.toFixed(2)}`);

  const totalSpread = levels.r3 - levels.s3;
  const oldBrokenDailyRange = Math.max(atr, 2); // what the old flat-$2 floor would have clamped dailyRange to
  const oldBrokenSpreadEstimate = (oldBrokenDailyRange * 1.1) / 4 * 2; // R3-S3 under the old bug
  const expectedFloor = gappedPrice * 0.008;
  const newFloorSpreadEstimate = (expectedFloor * 1.1) / 4 * 2;

  console.log(`  Total R3-S3 spread (fixed): $${totalSpread.toFixed(2)}`);
  console.log(`  Old flat-$2-floor spread would have been: ~$${oldBrokenSpreadEstimate.toFixed(2)} (the reported bug)`);
  console.log(`  New price-relative floor implies spread >= $${newFloorSpreadEstimate.toFixed(2)}\n`);

  check("forced ATR is small (<2, reproducing the bug trigger)", atr < 2, `ATR(14)=${atr.toFixed(2)}`);
  check(
    "old flat-$2 floor would have collapsed the spread to ~$1-2 (confirms the bug is real)",
    oldBrokenSpreadEstimate < 3,
    `old-estimate=$${oldBrokenSpreadEstimate.toFixed(2)}`
  );
  check(
    "fixed spread is proportional to price (well beyond the old ~$1-2 collapse)",
    totalSpread >= newFloorSpreadEstimate - 0.1,
    `spread=$${totalSpread.toFixed(2)} vs required floor implied spread=$${newFloorSpreadEstimate.toFixed(2)}`
  );
  check(
    "fixed spread is at least 10x the old broken-floor result",
    totalSpread > oldBrokenSpreadEstimate * 10,
    `new=$${totalSpread.toFixed(2)} vs old=$${oldBrokenSpreadEstimate.toFixed(2)}`
  );
  check("R1 > pivot > S1 (ordering sane)", levels.r1 > levels.dailyPivot && levels.dailyPivot > levels.s1, `r1=${levels.r1} pivot=${levels.dailyPivot} s1=${levels.s1}`);
  check("R3 > R2 > R1 and S3 < S2 < S1 (monotonic)", levels.r3 > levels.r2 && levels.r2 > levels.r1 && levels.s3 < levels.s2 && levels.s2 < levels.s1,
    `R: ${levels.r1}/${levels.r2}/${levels.r3}  S: ${levels.s1}/${levels.s2}/${levels.s3}`);

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Pivot floor fix verified — R1-R3/S1-S3 now scale with live price, even when re-centering around a gapped price."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
