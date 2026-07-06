import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * MODEL HEALTH / DRIFT SYNC BUG CHECKPOINT
 *
 * Bug: loadPersistedLearningData() restored conceptDriftScore/driftAlertLevel from
 * storage via loadFeatureDriftHistory() but never called updateModelHealthScore()
 * afterward, so modelHealthScore stayed at its default (100) until some unrelated
 * event (a trade outcome, a feature-correlation check, or a retrain) triggered a
 * recompute. This produced a contradictory dashboard state: Model Health 100/100
 * simultaneously with a HIGH concept-drift alert.
 *
 * Fix: call `this.updateModelHealthScore();` immediately after
 * `await this.loadFeatureDriftHistory();` inside loadPersistedLearningData().
 *
 * This test seeds a persisted drift state (conceptDriftScore = 1.95, HIGH alert)
 * directly into the sandboxed AsyncStorage BEFORE calling loadPersistedLearningData(),
 * then asserts modelHealthScore already reflects the drift penalty immediately after
 * load returns -- with no trade outcome, correlation check, or retrain in between.
 */

interface HealthEngine {
  loadPersistedLearningData(): Promise<unknown>;
  getModelHealthMetrics(): {
    modelHealthScore: number;
    conceptDriftScore: number;
    driftAlertLevel: string;
  };
}

interface HealthModule {
  signalEngine: HealthEngine;
}

interface SandboxStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface HealthSandboxModule extends HealthModule {
  __AsyncStorage: SandboxStorage;
}

const FEATURE_DRIFT_STORAGE_KEY = "feature_drift_history_v1";

/**
 * Load services/signalEngine.ts under Node/Bun with the same CRLF-tolerant,
 * target-based import stripping used by the other sandbox scripts. The sandbox
 * AsyncStorage is exported (as __AsyncStorage) so this test can seed persisted
 * state before calling loadPersistedLearningData().
 */
async function loadEngine(): Promise<HealthSandboxModule> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.healthsync.ts");
  const sourcePath = path.join(process.cwd(), "services", "signalEngine.ts");
  const source = await readFile(sourcePath, "utf8");

  const sandboxPrelude = `import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext } from "../../types/trading.ts";

const sandboxStorage = new Map<string, string>();
const AsyncStorage = {
  async getItem(key: string): Promise<string | null> { return sandboxStorage.get(key) ?? null; },
  async setItem(key: string, value: string): Promise<void> { sandboxStorage.set(key, value); },
  async removeItem(key: string): Promise<void> { sandboxStorage.delete(key); },
};
export const __AsyncStorage = AsyncStorage;
const trpcClient = {} as any;
const Platform = { OS: "web" as const };
`;

  // Regex-based stripping: match by module specifier (not exact string), tolerant
  // of CRLF line endings, so this can't silently fail on the next engine edit.
  const rewritten = source
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, "")
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, "");

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<HealthSandboxModule>;
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const mod = await loadEngine();
  const { signalEngine, __AsyncStorage } = mod;

  console.log("\nModel Health / Drift Sync Bug Checkpoint\n");

  // Metrics before any load: fresh engine defaults (health=100, drift=0).
  const before = signalEngine.getModelHealthMetrics();
  console.log(`  Before load: health=${before.modelHealthScore}, drift=${before.conceptDriftScore}, alert=${before.driftAlertLevel}`);

  // Seed a persisted drift state directly into storage, simulating a prior
  // session that recorded a HIGH concept-drift alert.
  await __AsyncStorage.setItem(FEATURE_DRIFT_STORAGE_KEY, JSON.stringify({
    featureDistributionHistory: [],
    conceptDriftScore: 1.95,
    driftAlertLevel: "HIGH",
    lastDriftCheck: Date.now(),
  }));

  // Load persisted state -- this is the ONLY thing that runs. No trade outcome,
  // no feature-correlation check, no retrain fires in between.
  await signalEngine.loadPersistedLearningData();

  const after = signalEngine.getModelHealthMetrics();
  console.log(`  After load:  health=${after.modelHealthScore}, drift=${after.conceptDriftScore}, alert=${after.driftAlertLevel}`);

  check("drift score restored from storage", after.conceptDriftScore === 1.95, `conceptDriftScore=${after.conceptDriftScore}`);
  check("drift alert level restored from storage", after.driftAlertLevel === "HIGH", `driftAlertLevel=${after.driftAlertLevel}`);
  check(
    "health score reflects drift penalty immediately after load (no other trigger fired)",
    after.modelHealthScore < 100 && after.modelHealthScore <= 76,
    `modelHealthScore=${after.modelHealthScore} (expected <=76, drift penalty = min(25, 1.95*50)=25 off a base of 100)`
  );
  check(
    "no more contradictory 100/100 health alongside a HIGH drift alert",
    !(after.modelHealthScore === 100 && after.driftAlertLevel === "HIGH"),
    `health=${after.modelHealthScore}, alert=${after.driftAlertLevel}`
  );

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Model health now syncs with restored drift state immediately after load."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
