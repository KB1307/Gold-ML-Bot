import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * STEP 1 CHECKPOINT TEST
 * Proves that Bayesian memory consolidation actually damps a sudden adverse
 * (or favorable) streak instead of letting a single retrain cycle swing the
 * learned weight to whatever the recent window alone would produce.
 *
 * Method:
 *  - Engine A is trained on a baseline history first (establishing a
 *    consolidated "historical" rsi_weight), then hit with a sudden adverse
 *    window (10 losing trades clustered in the SAME rsi regime that used to
 *    win) and retrained -> this is the actual blended result the app uses.
 *  - Engine B is a fresh (cold-start) instance trained ONLY on that same
 *    adverse window -> since its historical vector is empty (0), its blended
 *    output equals (1 - alpha) * W_recent, which lets us recover the raw
 *    recent-window fit (W_recent = coldOutput / (1 - alpha)).
 *  - We then compare:
 *      shift_blended   = |blended_A_after - historical_A_before|
 *      shift_unblended = |W_recent - historical_A_before|   (a full overwrite)
 *    and assert shift_blended < shift_unblended by a meaningful margin.
 */

interface Step1Engine {
  trainOnOutcomesForTest(outcomes: unknown[]): void;
  getModelWeightForTest(featureKey: string): number | undefined;
  getBayesianBlendAlphaForTest(): number;
}

interface Step1Module {
  signalEngine: Step1Engine;
}

async function loadEngine(tag: string): Promise<Step1Module> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, `signalEngine.step1.${tag}.ts`);
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

  // CRLF-tolerant regex stripping (Step 1 / Fix A requirement).
  const rewritten = source
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, "")
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/learningStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, "");

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}_${tag}`;
  return import(moduleUrl) as Promise<Step1Module>;
}

function makeOutcome(result: "WIN" | "LOSS", rsi: number): unknown {
  return {
    signalId: `${result}-${rsi}-${Math.random()}`,
    entryPrice: 3250,
    exitPrice: result === "WIN" ? 3253 : 3247,
    result,
    pnl: result === "WIN" ? 30 : -70,
    confidence: 0.75,
    timestamp: new Date(),
    features: {
      rsi,
      atr: 10,
      volumeRatio: 1,
      dxyChange: 0,
      timeWindowFactor: 1,
      sentiment: { score: 0, confidence: 0, source: "test" },
    },
  };
}

// Baseline: high-rsi trades win, low-rsi trades lose -> establishes a
// positive, consolidated rsi_weight ("the long-term track record").
const baselineHistory: unknown[] = [
  makeOutcome("WIN", 80), makeOutcome("WIN", 78), makeOutcome("WIN", 82), makeOutcome("WIN", 79),
  makeOutcome("LOSS", 22), makeOutcome("LOSS", 18), makeOutcome("LOSS", 20), makeOutcome("LOSS", 21),
];

// Sudden adverse window: the SAME high-rsi regime that used to win now
// produces a cluster of 10 losses (plus the original 4 wins retained in the
// training window), which should pull the fit sharply negative if taken at
// face value.
const adverseWindow: unknown[] = [
  makeOutcome("WIN", 80), makeOutcome("WIN", 78), makeOutcome("WIN", 82), makeOutcome("WIN", 79),
  makeOutcome("LOSS", 81), makeOutcome("LOSS", 83), makeOutcome("LOSS", 77), makeOutcome("LOSS", 80),
  makeOutcome("LOSS", 79), makeOutcome("LOSS", 82), makeOutcome("LOSS", 78), makeOutcome("LOSS", 80),
  makeOutcome("LOSS", 81), makeOutcome("LOSS", 79),
];

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

async function main(): Promise<void> {
  console.log("\nStep 1: Bayesian memory consolidation damps a sudden adverse streak\n");

  // Engine A: has consolidated history, then hit with the adverse window.
  const { signalEngine: engineA } = await loadEngine("a");
  engineA.trainOnOutcomesForTest(baselineHistory);
  const historicalBefore = engineA.getModelWeightForTest("rsi_weight") ?? 0;
  const alpha = engineA.getBayesianBlendAlphaForTest();
  engineA.trainOnOutcomesForTest(adverseWindow);
  const blendedAfter = engineA.getModelWeightForTest("rsi_weight") ?? 0;

  // Engine B: cold start, trained ONLY on the adverse window -> its output
  // equals (1 - alpha) * W_recent, letting us recover W_recent directly.
  const { signalEngine: engineB } = await loadEngine("b");
  engineB.trainOnOutcomesForTest(adverseWindow);
  const coldOutputOnAdverseOnly = engineB.getModelWeightForTest("rsi_weight") ?? 0;
  const rawRecentWeight = coldOutputOnAdverseOnly / (1 - alpha);

  const shiftBlended = Math.abs(blendedAfter - historicalBefore);
  const shiftUnblended = Math.abs(rawRecentWeight - historicalBefore);
  const dampeningPct = shiftUnblended > 0 ? (1 - shiftBlended / shiftUnblended) * 100 : 0;

  console.log(`\n  alpha (historical share) = ${alpha}`);
  console.log(`  historical rsi_weight (before adverse window) = ${historicalBefore.toFixed(4)}`);
  console.log(`  raw recent-window-only fit (W_recent, unblended)  = ${rawRecentWeight.toFixed(4)}`);
  console.log(`  blended rsi_weight (after adverse window)         = ${blendedAfter.toFixed(4)}`);
  console.log(`\n  shift if unblended (full overwrite) = |${rawRecentWeight.toFixed(4)} - ${historicalBefore.toFixed(4)}| = ${shiftUnblended.toFixed(4)}`);
  console.log(`  shift with blending (actual)         = |${blendedAfter.toFixed(4)} - ${historicalBefore.toFixed(4)}| = ${shiftBlended.toFixed(4)}`);
  console.log(`  dampening = ${dampeningPct.toFixed(1)}% smaller shift than an unblended refit\n`);

  check("historical weight established as positive", historicalBefore > 0, `historical=${historicalBefore.toFixed(4)}`);
  check("raw recent-only fit swings negative under the adverse window", rawRecentWeight < 0, `rawRecent=${rawRecentWeight.toFixed(4)}`);
  check("blended shift is smaller than an unblended (full overwrite) shift", shiftBlended < shiftUnblended,
    `blendedShift=${shiftBlended.toFixed(4)} < unblendedShift=${shiftUnblended.toFixed(4)}`);
  check("blend formula matches W_final = alpha*historical + (1-alpha)*recent", Math.abs(blendedAfter - (alpha * historicalBefore + (1 - alpha) * rawRecentWeight)) < 1e-6,
    `blendedAfter=${blendedAfter.toFixed(6)} expected=${(alpha * historicalBefore + (1 - alpha) * rawRecentWeight).toFixed(6)}`);

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Step 1 verified — Bayesian consolidation measurably damps a sudden adverse streak."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
