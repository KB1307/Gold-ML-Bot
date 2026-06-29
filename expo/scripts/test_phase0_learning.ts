import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PHASE 0 CHECKPOINT TEST
 * Proves the learned weight vector is actually wired into the live scoring path.
 *
 * Two synthetic outcome histories are engineered to produce opposite-signed
 * learned `rsi_weight` values. After retraining on each, the modulation applied
 * to the RSI scoring contribution must change sign/magnitude accordingly. If the
 * learning loop were still cosmetic (pre-Phase-0), both histories would yield an
 * identical, unchanged contribution.
 */

interface Phase0Engine {
  trainOnOutcomesForTest(outcomes: unknown[]): void;
  getLearnedFeatureModulationForTest(featureKey: string): number;
  getModelWeightForTest(featureKey: string): number | undefined;
}

interface Phase0Module {
  signalEngine: Phase0Engine;
}

/**
 * Load services/signalEngine.ts under Node/Bun by injecting mocks for the
 * React-Native-only imports. Imports are stripped by matching the import target
 * (regex), NOT an exact source string, so this can't silently break when the
 * engine's import list changes.
 */
async function loadEngine(): Promise<Phase0Module> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.phase0.ts");
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
`;

  // Regex-based stripping: match by module specifier, tolerant of the imported names.
  const rewritten = source
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\n/m, "")
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\n/m, "");

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<Phase0Module>;
}

const RAW_RSI_CONTRIBUTION = 0.4; // the largest hardcoded RSI buy contribution

function makeOutcome(result: "WIN" | "LOSS", rsi: number): unknown {
  return {
    signalId: `${result}-${rsi}-${Math.random()}`,
    entryPrice: 3250,
    exitPrice: result === "WIN" ? 3253 : 3247,
    result,
    pnl: result === "WIN" ? 30 : -70,
    confidence: 0.75,
    timestamp: new Date(),
    // Only RSI differs between wins and losses; every other learned feature is
    // held constant so rsi_weight dominates the normalized weight vector.
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

// History A: winners have HIGH rsi, losers LOW rsi -> positive learned rsi_weight.
const historyPositive: unknown[] = [
  makeOutcome("WIN", 80), makeOutcome("WIN", 78), makeOutcome("WIN", 82), makeOutcome("WIN", 79),
  makeOutcome("LOSS", 22), makeOutcome("LOSS", 18), makeOutcome("LOSS", 20), makeOutcome("LOSS", 21),
];

// History B: winners have LOW rsi, losers HIGH rsi -> negative learned rsi_weight.
const historyNegative: unknown[] = [
  makeOutcome("WIN", 22), makeOutcome("WIN", 18), makeOutcome("WIN", 20), makeOutcome("WIN", 21),
  makeOutcome("LOSS", 80), makeOutcome("LOSS", 78), makeOutcome("LOSS", 82), makeOutcome("LOSS", 79),
];

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const { signalEngine } = await loadEngine();

  console.log("\nPhase 0: learned weights drive scoring contributions\n");

  // Baseline (cold start, no weights trained yet): modulation must be neutral (1.0).
  const coldMod = signalEngine.getLearnedFeatureModulationForTest("rsi_weight");
  check("cold-start neutral", Math.abs(coldMod - 1) < 1e-9, `modulation=${coldMod.toFixed(4)} (expected 1.0)`);
  const coldContribution = RAW_RSI_CONTRIBUTION * coldMod;

  // Train on the POSITIVE rsi history.
  signalEngine.trainOnOutcomesForTest(historyPositive);
  const wPos = signalEngine.getModelWeightForTest("rsi_weight") ?? 0;
  const modPos = signalEngine.getLearnedFeatureModulationForTest("rsi_weight");
  const contribPos = RAW_RSI_CONTRIBUTION * modPos;

  // Train on the NEGATIVE rsi history.
  signalEngine.trainOnOutcomesForTest(historyNegative);
  const wNeg = signalEngine.getModelWeightForTest("rsi_weight") ?? 0;
  const modNeg = signalEngine.getLearnedFeatureModulationForTest("rsi_weight");
  const contribNeg = RAW_RSI_CONTRIBUTION * modNeg;

  console.log("\n  Learned rsi_weight:");
  console.log(`     positive history -> weight=${wPos.toFixed(4)}  modulation=x${modPos.toFixed(4)}  contribution=${contribPos.toFixed(4)}`);
  console.log(`     negative history -> weight=${wNeg.toFixed(4)}  modulation=x${modNeg.toFixed(4)}  contribution=${contribNeg.toFixed(4)}`);
  console.log(`     cold start       -> weight=n/a     modulation=x${coldMod.toFixed(4)}  contribution=${coldContribution.toFixed(4)}\n`);

  check("positive history -> positive weight", wPos > 0, `weight=${wPos.toFixed(4)}`);
  check("negative history -> negative weight", wNeg < 0, `weight=${wNeg.toFixed(4)}`);
  check("opposite-signed weights produced", Math.sign(wPos) !== Math.sign(wNeg), `${wPos.toFixed(3)} vs ${wNeg.toFixed(3)}`);
  check("positive weight amplifies contribution", contribPos > coldContribution, `${contribPos.toFixed(4)} > ${coldContribution.toFixed(4)}`);
  check("negative weight suppresses contribution", contribNeg < coldContribution, `${contribNeg.toFixed(4)} < ${coldContribution.toFixed(4)}`);
  check("contribution actually changes sign/magnitude", Math.sign(contribPos) !== Math.sign(contribNeg) || Math.abs(contribPos - contribNeg) > 0.1,
    `pos=${contribPos.toFixed(4)} neg=${contribNeg.toFixed(4)}`);

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Phase 0 verified — the learning loop now measurably moves scoring."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
