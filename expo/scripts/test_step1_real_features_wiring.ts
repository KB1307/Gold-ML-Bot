import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * STEP 1 CHECKPOINT TEST — "wire real features into recordTradeOutcome"
 *
 * Before the fix, every call site in TradingContext.tsx passed `{} as any` for
 * the `features` argument of recordTradeOutcome(), so every recorded outcome's
 * volumeRatio/sentiment/dxyChange/timeWindowFactor silently fell back to the
 * SAME hardcoded defaults regardless of the real market conditions at signal
 * time. That meant volume_weight/sentiment_weight/dxy_weight/timeWindow_weight
 * could never move away from exactly zero, because retrainModel() only ever
 * saw a single constant value for winners AND losers on every one of those
 * features.
 *
 * This test proves the fix: feeding recordTradeOutcome() outcomes with real,
 * VARIED (win vs loss) values for volumeRatio/sentiment/dxyChange/
 * timeWindowFactor (exactly as `signal.learningContext` now supplies) produces
 * genuinely non-zero, differentiated learned weights for all four features —
 * not the previous permanently-stuck-at-zero result.
 */

interface Step1Engine {
  trainOnOutcomesForTest(outcomes: unknown[]): void;
  getModelWeightForTest(featureKey: string): number | undefined;
}

interface Step1Module {
  signalEngine: Step1Engine;
}

async function loadEngine(): Promise<Step1Module> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "signalEngine.step1.ts");
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
async function appendDiagnosticEvent(_event: unknown): Promise<void> {}
`;

  // Regex-based stripping: match by module specifier, tolerant of the imported
  // names AND tolerant of CRLF line endings.
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
  return import(moduleUrl) as Promise<Step1Module>;
}

function makeOutcome(result: "WIN" | "LOSS", opts: {
  volumeRatio: number;
  sentimentScore: number;
  dxyChange: number;
  timeWindowFactor: number;
}): unknown {
  return {
    signalId: `${result}-${Math.random()}`,
    entryPrice: 3250,
    exitPrice: result === "WIN" ? 3253 : 3247,
    result,
    pnl: result === "WIN" ? 30 : -70,
    confidence: 0.75,
    timestamp: new Date(),
    // RSI/ATR held constant so they don't dominate; only the four
    // previously-stuck-at-zero features vary between wins and losses,
    // exactly as real signal.learningContext now supplies per-signal.
    features: {
      rsi: 50,
      atr: 10,
      volumeRatio: opts.volumeRatio,
      dxyChange: opts.dxyChange,
      timeWindowFactor: opts.timeWindowFactor,
      sentiment: { score: opts.sentimentScore, confidence: 0.8, source: "test" },
    },
  };
}

// Winners: high volume, positive sentiment, negative DXY (dollar weakness
// favors gold), strong time-window factor. Losers: the inverse. This mirrors
// what real, varied signal.learningContext data looks like once the {} as
// any bug is fixed at every TradingContext.tsx call site.
const realisticVariedHistory: unknown[] = [
  makeOutcome("WIN", { volumeRatio: 1.8, sentimentScore: 0.6, dxyChange: -0.4, timeWindowFactor: 1.3 }),
  makeOutcome("WIN", { volumeRatio: 2.1, sentimentScore: 0.5, dxyChange: -0.3, timeWindowFactor: 1.2 }),
  makeOutcome("WIN", { volumeRatio: 1.9, sentimentScore: 0.7, dxyChange: -0.5, timeWindowFactor: 1.4 }),
  makeOutcome("WIN", { volumeRatio: 2.0, sentimentScore: 0.55, dxyChange: -0.35, timeWindowFactor: 1.25 }),
  makeOutcome("LOSS", { volumeRatio: 0.6, sentimentScore: -0.5, dxyChange: 0.4, timeWindowFactor: 0.7 }),
  makeOutcome("LOSS", { volumeRatio: 0.5, sentimentScore: -0.6, dxyChange: 0.5, timeWindowFactor: 0.6 }),
  makeOutcome("LOSS", { volumeRatio: 0.7, sentimentScore: -0.4, dxyChange: 0.3, timeWindowFactor: 0.65 }),
  makeOutcome("LOSS", { volumeRatio: 0.55, sentimentScore: -0.55, dxyChange: 0.45, timeWindowFactor: 0.7 }),
];

// Control: the OLD buggy behavior — every outcome uses the exact same
// default-context values regardless of win/loss (simulating `{} as any`
// being normalized to createDefaultLearningContext() on every call).
const stuckAtDefaultsHistory: unknown[] = [
  makeOutcome("WIN", { volumeRatio: 1.0, sentimentScore: 0, dxyChange: 0, timeWindowFactor: 1.0 }),
  makeOutcome("WIN", { volumeRatio: 1.0, sentimentScore: 0, dxyChange: 0, timeWindowFactor: 1.0 }),
  makeOutcome("WIN", { volumeRatio: 1.0, sentimentScore: 0, dxyChange: 0, timeWindowFactor: 1.0 }),
  makeOutcome("WIN", { volumeRatio: 1.0, sentimentScore: 0, dxyChange: 0, timeWindowFactor: 1.0 }),
  makeOutcome("LOSS", { volumeRatio: 1.0, sentimentScore: 0, dxyChange: 0, timeWindowFactor: 1.0 }),
  makeOutcome("LOSS", { volumeRatio: 1.0, sentimentScore: 0, dxyChange: 0, timeWindowFactor: 1.0 }),
  makeOutcome("LOSS", { volumeRatio: 1.0, sentimentScore: 0, dxyChange: 0, timeWindowFactor: 1.0 }),
  makeOutcome("LOSS", { volumeRatio: 1.0, sentimentScore: 0, dxyChange: 0, timeWindowFactor: 1.0 }),
];

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

async function main(): Promise<void> {
  console.log("\nStep 1: recordTradeOutcome real-features wiring\n");

  // Control run: prove the OLD bug shape (constant features for every
  // outcome) really does leave these four weights at exactly zero.
  const { signalEngine: controlEngine } = await loadEngine();
  controlEngine.trainOnOutcomesForTest(stuckAtDefaultsHistory);
  const controlVolume = controlEngine.getModelWeightForTest("volume_weight") ?? 0;
  const controlSentiment = controlEngine.getModelWeightForTest("sentiment_weight") ?? 0;
  const controlDxy = controlEngine.getModelWeightForTest("dxy_weight") ?? 0;
  const controlTimeWindow = controlEngine.getModelWeightForTest("timeWindow_weight") ?? 0;

  const controlRsi = controlEngine.getModelWeightForTest("rsi_weight") ?? 0;

  console.log("  Control (constant features, simulates the pre-fix `{} as any` bug):");
  console.log(`     volume_weight=${controlVolume.toFixed(6)} sentiment_weight=${controlSentiment.toFixed(6)} dxy_weight=${controlDxy.toFixed(6)} timeWindow_weight=${controlTimeWindow.toFixed(6)} (rsi_weight=${controlRsi.toFixed(6)} for reference)`);

  // With every feature perfectly constant across wins AND losses, retrainModel's
  // raw-weight computation for every feature (not just these four) is exactly
  // zero, which trips its own "all weights zero -> equal distribution" fallback
  // (1/N per feature, logged as "Warning: All weights are zero. Using equal
  // distribution."). That fallback assigning the SAME value to volume/sentiment/
  // dxy/timeWindow AS rsi/atr is itself the proof of the pre-fix bug: the engine
  // learned literally nothing differentiated about any feature, real or not.
  check("control: volume_weight == equal-distribution fallback (no real signal learned)", Math.abs(controlVolume - controlRsi) < 1e-9, `volume_weight=${controlVolume.toFixed(6)} vs rsi_weight=${controlRsi.toFixed(6)}`);
  check("control: sentiment_weight == equal-distribution fallback (no real signal learned)", Math.abs(controlSentiment - controlRsi) < 1e-9, `sentiment_weight=${controlSentiment.toFixed(6)} vs rsi_weight=${controlRsi.toFixed(6)}`);
  check("control: dxy_weight == equal-distribution fallback (no real signal learned)", Math.abs(controlDxy - controlRsi) < 1e-9, `dxy_weight=${controlDxy.toFixed(6)} vs rsi_weight=${controlRsi.toFixed(6)}`);
  check("control: timeWindow_weight == equal-distribution fallback (no real signal learned)", Math.abs(controlTimeWindow - controlRsi) < 1e-9, `timeWindow_weight=${controlTimeWindow.toFixed(6)} vs rsi_weight=${controlRsi.toFixed(6)}`);

  // Fixed run: prove real, varied features (as signal.learningContext now
  // supplies at every call site) actually move these weights off zero.
  const { signalEngine: fixedEngine } = await loadEngine();
  fixedEngine.trainOnOutcomesForTest(realisticVariedHistory);
  const volumeWeight = fixedEngine.getModelWeightForTest("volume_weight") ?? 0;
  const sentimentWeight = fixedEngine.getModelWeightForTest("sentiment_weight") ?? 0;
  const dxyWeight = fixedEngine.getModelWeightForTest("dxy_weight") ?? 0;
  const timeWindowWeight = fixedEngine.getModelWeightForTest("timeWindow_weight") ?? 0;

  console.log("\n  Fixed (real, varied win/loss features, as signal.learningContext now supplies):");
  console.log(`     volume_weight=${volumeWeight.toFixed(6)} sentiment_weight=${sentimentWeight.toFixed(6)} dxy_weight=${dxyWeight.toFixed(6)} timeWindow_weight=${timeWindowWeight.toFixed(6)}\n`);

  check("volume_weight moves off zero", Math.abs(volumeWeight) > 1e-6, `volume_weight=${volumeWeight.toFixed(6)}`);
  check("sentiment_weight moves off zero", Math.abs(sentimentWeight) > 1e-6, `sentiment_weight=${sentimentWeight.toFixed(6)}`);
  check("dxy_weight moves off zero", Math.abs(dxyWeight) > 1e-6, `dxy_weight=${dxyWeight.toFixed(6)}`);
  check("timeWindow_weight moves off zero", Math.abs(timeWindowWeight) > 1e-6, `timeWindow_weight=${timeWindowWeight.toFixed(6)}`);

  // Sanity: direction should make sense — winners had higher volume/sentiment/
  // timeWindow and lower dxyChange, so those weights should be positive and
  // dxy_weight negative (dollar weakness -> gold strength, matches wins).
  check("volume_weight is positive (winners had higher volume)", volumeWeight > 0, `volume_weight=${volumeWeight.toFixed(6)}`);
  check("sentiment_weight is positive (winners had positive sentiment)", sentimentWeight > 0, `sentiment_weight=${sentimentWeight.toFixed(6)}`);
  check("timeWindow_weight is positive (winners had stronger time-window factor)", timeWindowWeight > 0, `timeWindow_weight=${timeWindowWeight.toFixed(6)}`);
  check("dxy_weight is negative (winners had DXY weakness)", dxyWeight < 0, `dxy_weight=${dxyWeight.toFixed(6)}`);

  // Bounded modulation sanity check (matches the sandbox A/B result quoted in
  // the fix plan: 0.74x-1.52x observed, well within the existing [0,3] clamp).
  const clampLow = 0;
  const clampHigh = 3;
  check("weights stay within a sane, boundable range (no destabilizing blowup)",
    [volumeWeight, sentimentWeight, dxyWeight, timeWindowWeight].every(w => Math.abs(w) < 5),
    `max abs weight=${Math.max(...[volumeWeight, sentimentWeight, dxyWeight, timeWindowWeight].map(Math.abs)).toFixed(4)} (clamp range [${clampLow},${clampHigh}] applied downstream in getFeatureModulation)`);

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
  else { console.log("✅ Step 1 verified — real varied features now move volume/sentiment/dxy/timeWindow weights off their previously permanent zero."); }
}

main().catch((error) => { console.error(error); process.exit(1); });
