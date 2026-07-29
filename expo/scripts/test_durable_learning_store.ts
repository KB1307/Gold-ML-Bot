import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * CHECKPOINT TEST — durable (Supabase-backed) learning memory + widened feature vector.
 *
 * Part 1 — durability/merge semantics of learningStore.ts against a fake remote
 * that behaves exactly like `trade_outcomes_v1` (primary key = signal_id, writes
 * are UPSERTs):
 *   1a. every appended outcome reaches the remote corpus;
 *   1b. re-pushing the same signalId is IDEMPOTENT (no duplicate row, no
 *       double-counted trade) — the single property the whole design rests on;
 *   1c. a fresh device / reloaded web session (empty local tier) hydrates the
 *       full remote corpus back in;
 *   1d. hydrate is a UNION, not a replace: local-only rows survive AND get
 *       backfilled upward, remote-only rows get merged down, and the merged
 *       local corpus comes back in true timestamp order;
 *   1e. a remote outage is non-fatal: the local tier is untouched and the failed
 *       rows are queued for retry.
 *
 * Part 2 — the widened (v2) feature vector:
 *   2a. buildLearningContext() emits the wide vector from real MarketFeatures,
 *       with the six v1 scalars unchanged in meaning;
 *   2b. recordTradeOutcome() round-trips every wide field into the store and
 *       stamps featureSchemaVersion=2;
 *   2c. a legacy six-scalar context still records cleanly and is stamped
 *       schemaVersion=1 (no invented values back-filled).
 */

interface RemoteRow {
  signalId: string;
  timestamp: string | number;
  entryPrice: number;
  exitPrice: number;
  result: "WIN" | "LOSS";
  pnl: number;
  confidence?: number;
  features?: unknown;
  featureSchemaVersion?: number;
}

interface FakeRemote {
  rows: Map<string, RemoteRow>;
  pushCalls: number;
  failNext: boolean;
}

interface LearningStoreModule {
  appendOutcome(o: unknown): Promise<void>;
  getAllOutcomes(): Promise<any[]>;
  getOutcomeCount(): Promise<number>;
  clearAllOutcomesForTest(): Promise<void>;
  pushOutcomesToRemote(o: unknown[]): Promise<{ upserted: number; queued: number }>;
  hydrateFromRemote(options?: { limit?: number; cap?: number }): Promise<{
    available: boolean; pulled: number; merged: number; backfilled: number; total: number;
  }>;
  getPendingRemotePushCount(): number;
  __remote: FakeRemote;
}

interface EngineModule {
  signalEngine: any;
  __learningStore: LearningStoreModule;
}

const SANDBOX_DIR = path.join(process.cwd(), "scripts", "__sandbox__");

/**
 * Sandboxed copy of the REAL learningStore.ts: only the two platform-specific
 * imports are stubbed (`Platform` -> web branch, `@/lib/trpc` -> in-memory fake
 * remote with genuine upsert-by-primary-key semantics). All merge/ordering/queue
 * logic under test is the production code itself.
 */
async function writeLearningStoreSandbox(): Promise<string> {
  const src = await readFile(path.join(process.cwd(), "services", "learningStore.ts"), "utf8");
  const rewritten = src
    .replace(
      /^import\s+\{\s*Platform\s*\}\s+from\s+["']react-native["'];?\r?\n/m,
      'const Platform = { OS: "web" as const };\n',
    )
    .replace(
      /^import\s+\{\s*trpcClient\s*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m,
      `
const __remote = { rows: new Map<string, any>(), pushCalls: 0, failNext: false };
export const __remoteStore = __remote;
const trpcClient = {
  learning: {
    pushOutcomes: {
      async mutate(input: { outcomes: any[] }) {
        __remote.pushCalls++;
        if (__remote.failNext) {
          __remote.failNext = false;
          throw new Error("simulated remote outage");
        }
        // Mirrors the Postgres upsert on the signal_id primary key.
        for (const o of input.outcomes) __remote.rows.set(o.signalId, { ...o });
        return { success: true, reason: "ok", upserted: input.outcomes.length };
      },
    },
    getOutcomes: {
      async query(_input?: { limit?: number }) {
        const outcomes = Array.from(__remote.rows.values()).sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        return { outcomes, available: true };
      },
    },
  },
} as any;
`,
    );
  await mkdir(SANDBOX_DIR, { recursive: true });
  const outPath = path.join(SANDBOX_DIR, "learningStore.durable.ts");
  await writeFile(outPath, rewritten);
  return outPath;
}

async function loadEngine(): Promise<EngineModule> {
  const learningStorePath = await writeLearningStoreSandbox();
  const learningStoreUrl = `${pathToFileURL(learningStorePath).href}?ts=${Date.now()}`;
  const source = await readFile(path.join(process.cwd(), "services", "signalEngine.ts"), "utf8");

  const prelude = `import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext, DetectedSRZone } from "../../types/trading.ts";
import * as __learningStoreModule from "${learningStoreUrl}";

const sandboxStorage = new Map<string, string>();
const AsyncStorage = {
  async getItem(key: string): Promise<string | null> { return sandboxStorage.get(key) ?? null; },
  async setItem(key: string, value: string): Promise<void> { sandboxStorage.set(key, value); },
  async removeItem(key: string): Promise<void> { sandboxStorage.delete(key); },
};
export const __learningStore = { ...__learningStoreModule, __remote: (__learningStoreModule as any).__remoteStore };
const trpcClient = {} as any;
async function fetchHistoricalData(): Promise<any[]> { return []; }
const Platform = { OS: "web" as const };
type StoredTradeOutcome = any;
const appendOutcomeToStore = __learningStoreModule.appendOutcome;
const getAllOutcomesFromStore = __learningStoreModule.getAllOutcomes;
const getOutcomeCountFromStore = __learningStoreModule.getOutcomeCount;
const pruneOutcomeStoreToCap = __learningStoreModule.pruneToCap;
const migrateLegacyOutcomesIfEmpty = __learningStoreModule.migrateLegacyOutcomesIfEmpty;
const pushOutcomesToRemote = __learningStoreModule.pushOutcomesToRemote;
const hydrateLearningStoreFromRemote = __learningStoreModule.hydrateFromRemote;
async function appendDiagnosticEvent(_event: unknown): Promise<void> {}
async function resolveSignalWithBars(): Promise<any> { return null; }
`;

  const rewritten = source
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, "")
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/learningStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/diagnosticEventStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/signalResolver["'];?\r?\n/m, "")
    .replace(/^import\s+type\s+\{[^}]*\}\s+from\s+["']@\/services\/barStore["'];?\r?\n/m, "")
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, "");

  const sandboxPath = path.join(SANDBOX_DIR, "signalEngine.durable.ts");
  await writeFile(sandboxPath, `${prelude}\n${rewritten}`);
  return import(`${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`) as Promise<EngineModule>;
}

function makeOutcome(id: string, hoursAgo: number, result: "WIN" | "LOSS"): RemoteRow {
  return {
    signalId: id,
    timestamp: new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString(),
    entryPrice: 3300,
    exitPrice: result === "WIN" ? 3307 : 3293,
    result,
    pnl: result === "WIN" ? 7 : -7,
    confidence: 0.8,
    features: { rsi: 55, atr: 9, volumeRatio: 1, dxyChange: 0, timeWindowFactor: 1, sentiment: { score: 0, confidence: 0, source: "test" } },
    featureSchemaVersion: 2,
  };
}

/** Minimal-but-complete MarketFeatures shaped exactly as the engine builds it. */
function makeMarketFeatures(): any {
  return {
    asianHigh: 3320, asianLow: 3290, dailyPivot: 3305,
    r1: 3315, r2: 3325, r3: 3335, s1: 3295, s2: 3285, s3: 3275,
    rsi: 62.5, atr: 8.4, dxyChange: -0.12, volumeRatio: 1.35,
    weeklyPivot: 3300, fractalResistance: 3322, fractalSupport: 3288,
    macdHistogram: 0.42, emaCrossover: 0.61,
    sessionVolatilityIndex: 1.22, timeToSessionEnd: 96,
    fibonacci: [],
    sentiment: { score: 0.21, confidence: 0.5, source: "test-feed" },
    orderFlow: { bidVolume: 120, askVolume: 180, volumeImbalance: 0.2, largeOrdersDetected: true, institutionalFootprint: 0.44 },
    volumeProfile: { highVolumeNodes: [3302], lowVolumeNodes: [3288], pointOfControl: 3301.5, valueAreaHigh: 3312, valueAreaLow: 3292 },
    marketRegime: { type: "TRENDING", strength: 0.78, confidence: 0.88 },
    priceActionPattern: "STRONG_UPTREND",
    candlestickPattern: "BULLISH_ENGULFING",
    supportStrength: 0.72, resistanceStrength: 0.41,
    srZones: [
      { price: 3296, type: "SUPPORT", touches: 4, lastTouch: Date.now(), rejectionWicks: 2, avgRejectionSize: 1.2, reactionStrength: 0.62, source: "PRICE_ACTION", confluenceScore: 2 },
      { price: 3330, type: "RESISTANCE", touches: 2, lastTouch: Date.now(), rejectionWicks: 1, avgRejectionSize: 0.9, reactionStrength: 0.35, source: "PIVOT", confluenceScore: 1 },
    ],
    activeSRReaction: {
      zone: { price: 3296, type: "SUPPORT", touches: 4, lastTouch: Date.now(), rejectionWicks: 2, avgRejectionSize: 1.2, reactionStrength: 0.62, source: "PRICE_ACTION", confluenceScore: 2 },
      reactionType: "BOUNCE", strength: 0.58, confirmed: true,
    },
    intermarketData: { dxyPrice: 103.2, dxyChange: -0.12, dxyVelocity: -0.01, us10yYield: 4.18, us10yChange: -0.03, vixPrice: 17.4, vixChange: 0.6, goldDxyCorrelation: -0.72, goldYieldCorrelation: -0.41 },
    liquidityWindow: { score: 0.85, sessionName: "NY_LONDON_OVERLAP", isHighLiquidity: true },
    timeWindowFactor: 2.0,
    orderBlocks: [{ price: 3298, type: "BULLISH", strength: 0.5, timestamp: Date.now() }],
    quasimodolLevels: [{ price: 3294, type: "BULLISH_QM", strength: 0.4 }],
    sessionSweeps: [{ type: "LOW_SWEEP", sessionType: "ASIAN", sweepPrice: 3289, reversalConfirmed: true, timestamp: Date.now(), strength: 0.66, penetrationDepth: 1.8, reclaimLatencyMs: 240000 }],
    vwap: 3303.2, adx: 27.5,
    bollingerSqueeze: false, bollingerExpansion: true, bollingerBandwidth: 0.014,
  };
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const { signalEngine, __learningStore: store } = await loadEngine();
  const remote = store.__remote;

  console.log("\n=== PART 1 — durable corpus: push idempotency, hydrate merge, outage tolerance ===\n");

  await store.clearAllOutcomesForTest();
  remote.rows.clear();

  // 1a: appended outcomes reach the remote corpus.
  const a = makeOutcome("sig-A", 5, "WIN");
  const b = makeOutcome("sig-B", 4, "LOSS");
  await store.appendOutcome(a);
  await store.appendOutcome(b);
  await store.pushOutcomesToRemote([a, b]);
  check("1a appended outcomes land in the durable corpus", remote.rows.size === 2, `remote rows=${remote.rows.size}`);

  // 1b: re-pushing the same signalIds is idempotent (upsert on primary key).
  await store.pushOutcomesToRemote([a, b, { ...a, pnl: 9 }]);
  check("1b re-push is idempotent — no duplicate rows", remote.rows.size === 2, `remote rows after 3 more pushes=${remote.rows.size}`);
  check("1b upsert keeps latest values for the same signalId", remote.rows.get("sig-A")?.pnl === 9, `sig-A pnl=${remote.rows.get("sig-A")?.pnl}`);

  // 1c: fresh device / reloaded browser tab — empty local tier, full remote pull.
  await store.clearAllOutcomesForTest();
  check("1c local tier starts empty (simulated reload)", (await store.getOutcomeCount()) === 0, "local count=0");
  const freshHydrate = await store.hydrateFromRemote({ limit: 100, cap: 100 });
  const afterFresh = await store.getAllOutcomes();
  check("1c hydrate restores the corpus after a wipe", afterFresh.length === 2, `local count=${afterFresh.length} (pulled ${freshHydrate.pulled}, merged ${freshHydrate.merged})`);
  check("1c restored rows are the real records", afterFresh.map(o => o.signalId).sort().join(",") === "sig-A,sig-B", `ids=${afterFresh.map(o => o.signalId).join(",")}`);

  // 1d: union semantics + timestamp ordering + upward backfill of local-only rows.
  const localOnly = makeOutcome("sig-LOCAL", 1, "WIN");   // newest
  const remoteOnly = makeOutcome("sig-REMOTE", 3, "LOSS"); // between B and LOCAL
  await store.appendOutcome(localOnly);
  remote.rows.set(remoteOnly.signalId, remoteOnly);
  const merge = await store.hydrateFromRemote({ limit: 100, cap: 100 });
  const merged = await store.getAllOutcomes();
  const ids = merged.map(o => o.signalId);
  check("1d remote-only row merged down into the local tier", ids.includes("sig-REMOTE"), `ids=${ids.join(",")}`);
  check("1d local-only row survived the merge (union, not replace)", ids.includes("sig-LOCAL"), `ids=${ids.join(",")}`);
  check("1d local-only row backfilled up into the durable corpus", remote.rows.has("sig-LOCAL"), `remote has sig-LOCAL=${remote.rows.has("sig-LOCAL")}`);
  const tsOrdered = merged.every((o, i) => i === 0 || new Date(merged[i - 1].timestamp).getTime() <= new Date(o.timestamp).getTime());
  check("1d merged corpus is in true timestamp order", tsOrdered, `order=${ids.join(" -> ")}`);
  check("1d no duplicates after merge", new Set(ids).size === ids.length, `unique=${new Set(ids).size} of ${ids.length} (merged ${merge.merged}, backfilled ${merge.backfilled})`);

  // 1e: remote outage — local tier untouched, rows queued for retry.
  const beforeOutage = (await store.getAllOutcomes()).length;
  remote.failNext = true;
  const outageOutcome = makeOutcome("sig-OFFLINE", 0.5, "WIN");
  await store.appendOutcome(outageOutcome);
  const outagePush = await store.pushOutcomesToRemote([outageOutcome]);
  const afterOutage = await store.getAllOutcomes();
  check("1e remote outage does not lose the local write", afterOutage.length === beforeOutage + 1, `local count ${beforeOutage} -> ${afterOutage.length}`);
  check("1e failed push is queued for retry", outagePush.queued > 0 && store.getPendingRemotePushCount() > 0, `queued=${store.getPendingRemotePushCount()}`);
  const retry = await store.pushOutcomesToRemote([]);
  check("1e queued row is flushed on the next push", remote.rows.has("sig-OFFLINE") && store.getPendingRemotePushCount() === 0, `remote has sig-OFFLINE=${remote.rows.has("sig-OFFLINE")}, upserted=${retry.upserted}`);

  console.log("\n=== PART 2 — widened (v2) feature vector ===\n");

  const features = makeMarketFeatures();
  const ctx = (signalEngine as any).buildLearningContext(features, {
    entryPrice: 3305.4,
    slDistance: 10.5,
    tp1Distance: 7.35,
    confidence: 0.842,
  });

  const v1Intact =
    ctx.rsi === features.rsi &&
    ctx.atr === features.atr &&
    ctx.volumeRatio === features.volumeRatio &&
    ctx.dxyChange === features.dxyChange &&
    ctx.timeWindowFactor === features.timeWindowFactor &&
    ctx.sentiment?.score === features.sentiment.score;
  check("2a the six v1 scalars are unchanged in the wide vector", v1Intact, `rsi=${ctx.rsi} atr=${ctx.atr} volRatio=${ctx.volumeRatio} dxy=${ctx.dxyChange} timeW=${ctx.timeWindowFactor}`);
  check("2a vector is stamped schemaVersion=2", ctx.schemaVersion === 2, `schemaVersion=${ctx.schemaVersion}`);

  const wideKeys = Object.keys(ctx).filter(k => ctx[k] !== undefined);
  check("2a wide vector is materially bigger than the old 6-scalar record", wideKeys.length >= 40, `populated fields=${wideKeys.length} (was 6)`);

  const moduleBCoverage: [string, unknown][] = [
    ["regimeType", ctx.regimeType],
    ["regimeStrength", ctx.regimeStrength],
    ["candlestickPattern", ctx.candlestickPattern],
    ["priceActionPattern", ctx.priceActionPattern],
    ["srZoneCount", ctx.srZoneCount],
    ["nearestZoneDistanceAtr", ctx.nearestZoneDistanceAtr],
    ["activeSRReactionType", ctx.activeSRReactionType],
    ["confirmedSweepType", ctx.confirmedSweepType],
    ["sweepPenetrationDepth", ctx.sweepPenetrationDepth],
    ["orderFlowImbalance", ctx.orderFlowImbalance],
    ["adx", ctx.adx],
    ["vwapDelta", ctx.vwapDelta],
    ["bollingerBandwidth", ctx.bollingerBandwidth],
    ["atrPercentOfPrice", ctx.atrPercentOfPrice],
    ["sessionName", ctx.sessionName],
    ["liquidityScore", ctx.liquidityScore],
    ["hourUtc", ctx.hourUtc],
    ["us10yChange", ctx.us10yChange],
    ["vixChange", ctx.vixChange],
    ["goldDxyCorrelation", ctx.goldDxyCorrelation],
    ["slDistance", ctx.slDistance],
    ["plannedRR", ctx.plannedRR],
    ["confidenceAtEntry", ctx.confidenceAtEntry],
    ["htfTrend", ctx.htfTrend],
  ];
  const missing = moduleBCoverage.filter(([, v]) => v === undefined || v === null).map(([k]) => k);
  check("2a every Module-B diagnostic field is populated from real features", missing.length === 0, missing.length === 0 ? "all present" : `missing: ${missing.join(", ")}`);

  const derivedOk =
    Math.abs((ctx.vwapDelta ?? 0) - (3305.4 - features.vwap)) < 0.02 &&
    Math.abs((ctx.nearestZoneDistanceAtr ?? 0) - (Math.abs(3305.4 - 3296) / features.atr)) < 0.01 &&
    Math.abs((ctx.plannedRR ?? 0) - (7.35 / 10.5)) < 0.001;
  check("2a derived fields are arithmetically correct", derivedOk, `vwapDelta=${ctx.vwapDelta} nearestZoneAtr=${ctx.nearestZoneDistanceAtr} plannedRR=${ctx.plannedRR}`);

  // 2b: wide vector survives the full recordTradeOutcome -> store round trip.
  await store.clearAllOutcomesForTest();
  remote.rows.clear();
  await signalEngine.recordTradeOutcome("sig-WIDE", 3305.4, 3312.75, "WIN", ctx, undefined, 1_800_000, 0.842, 10.5);
  const storedWide = (await store.getAllOutcomes()).find(o => o.signalId === "sig-WIDE");
  check("2b wide outcome persisted locally", storedWide !== undefined, `found=${storedWide !== undefined}`);
  const storedKeys = storedWide ? Object.keys(storedWide.features).filter(k => storedWide.features[k] !== undefined) : [];
  check("2b every wide field round-tripped through the store", storedKeys.length === wideKeys.length, `stored fields=${storedKeys.length} vs built=${wideKeys.length}`);
  check("2b outcome row is stamped featureSchemaVersion=2", storedWide?.featureSchemaVersion === 2, `featureSchemaVersion=${storedWide?.featureSchemaVersion}`);
  check("2b wide outcome also reached the durable corpus", remote.rows.has("sig-WIDE"), `remote has sig-WIDE=${remote.rows.has("sig-WIDE")}`);
  const remoteFeatures = remote.rows.get("sig-WIDE")?.features as any;
  check("2b durable corpus carries the wide vector (not just the 6 scalars)", remoteFeatures && Object.keys(remoteFeatures).length >= 40, `remote feature count=${remoteFeatures ? Object.keys(remoteFeatures).length : 0}`);

  // 2c: a legacy 6-scalar context still records, stamped as schema v1.
  await signalEngine.recordTradeOutcome("sig-LEGACY", 3300, 3293, "LOSS", {
    rsi: 48, atr: 9.1, volumeRatio: 1.02, dxyChange: 0.05, timeWindowFactor: 1,
    sentiment: { score: 0, confidence: 0, source: "legacy" },
  }, undefined, 900_000, 0.71, 9.5);
  const storedLegacy = (await store.getAllOutcomes()).find(o => o.signalId === "sig-LEGACY");
  check("2c legacy 6-scalar context still records", storedLegacy !== undefined, `found=${storedLegacy !== undefined}`);
  check("2c legacy record stamped schemaVersion=1 (no invented wide values)", storedLegacy?.featureSchemaVersion === 1 && storedLegacy?.features?.regimeType === undefined, `featureSchemaVersion=${storedLegacy?.featureSchemaVersion}, regimeType=${storedLegacy?.features?.regimeType}`);

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) {
    console.error(`❌ ${fail} FAILED`);
    process.exit(1);
  }
  console.log("✅ Durable Supabase-backed learning memory + widened v2 feature vector verified.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
