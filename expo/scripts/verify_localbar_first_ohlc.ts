import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * LOCAL-BAR-FIRST OHLC FIX — verification.
 *
 * Confirms the new selection logic added to signalEngine.ts's
 * fetchAndUpdateOHLCHistory() / refreshRecentDailyOHLCFromHistory(): prefer
 * barStore.ts's chart-derived local 1m bars over the remote (TwelveData/
 * Yahoo, exhaustible-quota) tier whenever local bars DENSELY and FRESHLY
 * cover the requested window; fall back to remote otherwise (thin/sparse
 * coverage, stale local bars, or no local bars at all, e.g. right after a
 * fresh reload).
 *
 * This test exercises REAL production code on both sides of the fix, not
 * reimplementations:
 *   - signalEngine.ts is loaded via the same sandbox-rewrite pattern used by
 *     every other test_*.ts/verify_*.ts script in this repo (its two
 *     genuinely react-native-dependent imports -- AsyncStorage, Platform --
 *     are stubbed; everything else, including the NEW selection logic under
 *     test, is untouched real code). Each scenario loads a UNIQUELY-NAMED
 *     sandbox file so every scenario gets a genuinely fresh module instance
 *     (no shared remoteFetchCallCount/engine state across scenarios).
 *   - barStore.ts's REAL assessBarCoverage() is loaded via the SAME pattern
 *     (its one react-native import -- Platform -- is stubbed) and wired into
 *     signalEngine via the test-only setLocalBarCoverageAssessorForTest seam
 *     (production leaves it null and reaches barStore.ts directly via a
 *     dynamic import).
 *   - Local bars themselves are supplied via setLocalBarsProviderForTest,
 *     generated LAZILY INSIDE the callback anchored on the `toTime` argument
 *     the real fetchAndUpdateOHLCHistory/refreshRecentDailyOHLCFromHistory
 *     pass in (the actual Date.now()-derived value used for the freshness
 *     comparison) -- NOT a timestamp captured earlier in the test -- so
 *     freshness-boundary assertions are exact regardless of how much
 *     wall-clock time the surrounding sandbox-loading I/O consumes.
 *
 * A dedicated live check (documented, not reproduced by this script) already
 * confirmed WHY signalEngine.ts cannot statically or dynamically import the
 * real barStore.ts inside this sandboxed Node/bun environment: barStore.ts
 * transitively imports react-native's Platform, and react-native/index.js's
 * Flow-typed `import typeof * as ReactNativePublicAPI from './index.js.flow'`
 * line throws "Unexpected typeof" when bun tries to parse it outside Metro.
 * That is precisely why fetchLocalOHLCBars/assessLocalOHLCCoverage wrap their
 * dynamic import in try/catch (falls through to remote in THIS environment)
 * and why the test seams below exist -- to exercise the identical selection
 * logic here regardless.
 */

interface OhlcBarLike {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  source?: string;
}

interface Engine {
  setLocalBarsProviderForTest(fn: ((fromTime: number, toTime: number) => Promise<OhlcBarLike[]>) | null): void;
  setLocalBarCoverageAssessorForTest(fn: ((bars: { timestamp: number }[], fromTime: number, toTime: number) => { dense: boolean; reason: string }) | null): void;
  fetchAndUpdateOHLCHistoryForTest(): Promise<void>;
  refreshRecentDailyOHLCFromHistoryForTest(): Promise<void>;
  getOhlcSourceDetail(): string;
  getRealATRForTest(period?: number): number;
}

interface EngineModule {
  signalEngine: Engine;
  getRemoteFetchCallCountForTest(): number;
}

interface BarStoreModule {
  assessBarCoverage: (bars: { timestamp: number }[], fromTime: number, toTime: number) => { dense: boolean; reason: string };
}

let sandboxCallCounter = 0;

async function loadEngine(scenarioTag: string): Promise<EngineModule> {
  sandboxCallCounter += 1;
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  // Unique filename PER CALL (not just a cache-busting query) -- guarantees a
  // genuinely fresh ES module graph (fresh remoteFetchCallCount, fresh
  // signalEngine singleton) for every scenario, with zero ambiguity.
  const sandboxPath = path.join(sandboxDir, `signalEngine.localbarfirst.${scenarioTag}.${sandboxCallCounter}.ts`);
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
let remoteFetchCallCount = 0;
export function getRemoteFetchCallCountForTest(): number { return remoteFetchCallCount; }
async function fetchHistoricalData(_input: { fromTime: number; toTime: number; timeoutMs?: number }): Promise<any[]> {
  remoteFetchCallCount++;
  // Distinctive stub bars so a test can confirm the REMOTE tier's values were
  // the ones actually loaded (never confused with local-bar values).
  const now = Date.now();
  const bars: any[] = [];
  for (let i = 19; i >= 0; i--) {
    bars.push({ timestamp: now - i * 60_000, open: 9999, high: 9999.5, low: 9998.5, close: 9999, source: "stub-remote-test" });
  }
  return bars;
}
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
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, "")
    .replace(/^import\s+type\s+\{[^}]*\}\s+from\s+["']@\/services\/barStore["'];?\r?\n/m, "");

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, `${sandboxPrelude}\n${rewritten}`);

  const moduleUrl = pathToFileURL(sandboxPath).href;
  return import(moduleUrl) as Promise<EngineModule>;
}

/** Loads the REAL barStore.ts (only its one react-native import stubbed) so assessBarCoverage() under test is the genuine production function. */
async function loadBarStoreSandbox(): Promise<BarStoreModule> {
  const sandboxDir = path.join(process.cwd(), "scripts", "__sandbox__");
  const sandboxPath = path.join(sandboxDir, "barStore.localbarfirst.ts");
  const sourcePath = path.join(process.cwd(), "services", "barStore.ts");
  const source = await readFile(sourcePath, "utf8");

  const rewritten = source.replace(
    /^import\s+\{\s*Platform\s*\}\s+from\s+["']react-native["'];?\r?\n/m,
    "const Platform = { OS: 'web' as const };\n",
  );

  await mkdir(sandboxDir, { recursive: true });
  await writeFile(sandboxPath, rewritten);

  const moduleUrl = `${pathToFileURL(sandboxPath).href}?ts=${Date.now()}`;
  return import(moduleUrl) as Promise<BarStoreModule>;
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

/** Ground-truth ATR(14), genuine timestamp-matched prevClose -- same helper used by the Item 3 verification scripts. */
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

/**
 * Builds a synthetic local 1m bar series ending `skipLastMinutes` minutes
 * before `anchorToTime`, spanning `minutesBack` minutes, keeping every Nth
 * minute (deterministic, not random, so failures are always reproducible).
 * Callers MUST anchor this on the real `toTime` argument the provider
 * callback receives (the actual Date.now()-derived value the code under
 * test uses), not a value captured earlier in the test -- otherwise any
 * slow I/O between "capture time" and "the real call" corrupts freshness
 * assertions against the 90s threshold.
 */
function buildLocalBars(anchorToTime: number, minutesBack: number, opts: { newestBarAgeMinutes?: number; keepEveryNth?: number } = {}): OhlcBarLike[] {
  // newestBarAgeMinutes: how many whole minutes before anchorToTime the
  // NEWEST retained bar sits (1 => newest bar is 60s old, matches the
  // sqlite-ring-buffer convention elsewhere in this codebase). Bars are
  // generated in chronological order (oldest first) over
  // [newestBarAgeMinutes, newestBarAgeMinutes + minutesBack - 1] minutes old.
  const newestBarAgeMinutes = opts.newestBarAgeMinutes ?? 1;
  const keepEveryNth = opts.keepEveryNth ?? 1;
  const oldestAgeMinutes = newestBarAgeMinutes + minutesBack - 1;
  const bars: OhlcBarLike[] = [];
  let px = 4020.0;
  let idx = 0;
  for (let ageMinutes = oldestAgeMinutes; ageMinutes >= newestBarAgeMinutes; ageMinutes--) {
    const close = px + Math.sin(ageMinutes / 4) * 0.15;
    const open = px;
    const high = Math.max(open, close) + 0.15;
    const low = Math.min(open, close) - 0.15;
    px = close;
    if (idx % keepEveryNth === 0) {
      bars.push({ timestamp: anchorToTime - ageMinutes * 60_000, open, high, low, close });
    }
    idx++;
  }
  return bars;
}

async function main(): Promise<void> {
  console.log("\n=== Local-bar-first OHLC fix: verification (barStore.ts local bars preferred over remote tier when they densely+freshly cover the window) ===\n");

  const barStore = await loadBarStoreSandbox();

  // ------------------------------------------------------------------------
  // Scenario 1: DENSE + FRESH local bars (100 contiguous minutes, newest bar
  // effectively "now") -- the common-case win condition: local bars must be
  // used, remote must NOT be called at all (this is the whole point of the
  // fix -- removing load from the exhausted TwelveData quota).
  // ------------------------------------------------------------------------
  let scenario1GroundTruth = 0;
  {
    const { signalEngine, getRemoteFetchCallCountForTest } = await loadEngine("s1");
    signalEngine.setLocalBarCoverageAssessorForTest(barStore.assessBarCoverage);
    signalEngine.setLocalBarsProviderForTest(async (fromTime, toTime) => {
      const bars = buildLocalBars(toTime, 100, { newestBarAgeMinutes: 1 });
      scenario1GroundTruth = groundTruthATR(bars, 14);
      return bars.filter(b => b.timestamp >= fromTime && b.timestamp <= toTime);
    });

    await signalEngine.fetchAndUpdateOHLCHistoryForTest();
    const sourceDetail = signalEngine.getOhlcSourceDetail();
    const remoteCalls = getRemoteFetchCallCountForTest();
    const atr = signalEngine.getRealATRForTest(14);

    console.log("Scenario 1 -- dense+fresh local bars (100 contiguous minutes, newest bar 60s before now):");
    console.log(`  ohlcSourceDetail = "${sourceDetail}"`);
    console.log(`  remote fetch call count = ${remoteCalls}`);
    console.log(`  ATR(14) via real production code (local-bar path): $${atr.toFixed(2)} vs ground truth $${scenario1GroundTruth.toFixed(2)}\n`);

    check(
      "dense+fresh local bars are SELECTED (ohlcSourceDetail tags the local-chart-bar tier)",
      sourceDetail === "local-1m-chart-bars",
      `got "${sourceDetail}"`,
    );
    check(
      "remote (TwelveData/Yahoo) tier is NEVER called when local coverage is sufficient (the whole point of the fix -- protects the exhausted quota)",
      remoteCalls === 0,
      `remote fetch called ${remoteCalls} time(s), expected 0`,
    );
    check(
      "ATR computed from the local-bar path matches genuine ground truth (confirms Item 3's array-alignment fix and this local-bar-first fix compose correctly together)",
      Math.abs(atr - scenario1GroundTruth) <= 0.1,
      `local-path ATR=$${atr.toFixed(2)} vs ground-truth=$${scenario1GroundTruth.toFixed(2)}`,
    );
  }

  // ------------------------------------------------------------------------
  // Scenario 2: NO local bars at all -- the fresh-reload / cold-start case
  // (matches the confirmed in-memory-only/no-durability finding on web).
  // Must fall through cleanly to the remote tier exactly as before this fix.
  // ------------------------------------------------------------------------
  {
    const { signalEngine, getRemoteFetchCallCountForTest } = await loadEngine("s2");
    signalEngine.setLocalBarCoverageAssessorForTest(barStore.assessBarCoverage);
    signalEngine.setLocalBarsProviderForTest(async () => []);

    await signalEngine.fetchAndUpdateOHLCHistoryForTest();
    const sourceDetail = signalEngine.getOhlcSourceDetail();
    const remoteCalls = getRemoteFetchCallCountForTest();

    console.log("Scenario 2 -- no local bars at all (fresh reload / cold start):");
    console.log(`  ohlcSourceDetail = "${sourceDetail}"`);
    console.log(`  remote fetch call count = ${remoteCalls}\n`);

    check(
      "with zero local bars, generation falls through to the remote tier (stub bars carry the distinctive source tag)",
      sourceDetail === "stub-remote-test",
      `got "${sourceDetail}"`,
    );
    check(
      "remote WAS called exactly once in this cold-start case",
      remoteCalls === 1,
      `remote fetch called ${remoteCalls} time(s), expected 1`,
    );
  }

  // ------------------------------------------------------------------------
  // Scenario 3: SPARSE local bars (density well under the 70% threshold) --
  // must fall back to remote even though SOME local bars exist.
  // ------------------------------------------------------------------------
  {
    const { signalEngine, getRemoteFetchCallCountForTest } = await loadEngine("s3");
    signalEngine.setLocalBarCoverageAssessorForTest(barStore.assessBarCoverage);
    signalEngine.setLocalBarsProviderForTest(async (fromTime, toTime) => {
      const bars = buildLocalBars(toTime, 100, { keepEveryNth: 5 }); // ~20% density
      return bars.filter(b => b.timestamp >= fromTime && b.timestamp <= toTime);
    });

    await signalEngine.fetchAndUpdateOHLCHistoryForTest();
    const sourceDetail = signalEngine.getOhlcSourceDetail();
    const remoteCalls = getRemoteFetchCallCountForTest();

    console.log("Scenario 3 -- sparse local bars (~20% density, well under the 70% threshold):");
    console.log(`  ohlcSourceDetail = "${sourceDetail}"`);
    console.log(`  remote fetch call count = ${remoteCalls}\n`);

    check(
      "sparse local coverage is correctly REJECTED (falls back to remote, does not silently use thin data)",
      sourceDetail === "stub-remote-test" && remoteCalls === 1,
      `sourceDetail="${sourceDetail}", remoteCalls=${remoteCalls}`,
    );
  }

  // ------------------------------------------------------------------------
  // Scenario 4: DENSE but STALE local bars -- ticks stopped flowing 2 full
  // minutes ago (120s > the 90s freshness threshold), even though density
  // over the historical portion of the window is excellent. Must fall back
  // to remote (this is the freshness gate specific to the generation path,
  // distinct from the audit path's purely-historical density check).
  // ------------------------------------------------------------------------
  {
    const { signalEngine, getRemoteFetchCallCountForTest } = await loadEngine("s4");
    signalEngine.setLocalBarCoverageAssessorForTest(barStore.assessBarCoverage);
    signalEngine.setLocalBarsProviderForTest(async (fromTime, toTime) => {
      const bars = buildLocalBars(toTime, 100, { newestBarAgeMinutes: 2 });
      return bars.filter(b => b.timestamp >= fromTime && b.timestamp <= toTime);
    });

    await signalEngine.fetchAndUpdateOHLCHistoryForTest();
    const sourceDetail = signalEngine.getOhlcSourceDetail();
    const remoteCalls = getRemoteFetchCallCountForTest();

    console.log("Scenario 4 -- dense but STALE local bars (newest bar 120s old, threshold is 90s):");
    console.log(`  ohlcSourceDetail = "${sourceDetail}"`);
    console.log(`  remote fetch call count = ${remoteCalls}\n`);

    check(
      "dense-but-stale local bars are correctly REJECTED by the freshness gate (falls back to remote instead of feeding calculateRealATR a frozen snapshot)",
      sourceDetail === "stub-remote-test" && remoteCalls === 1,
      `sourceDetail="${sourceDetail}", remoteCalls=${remoteCalls}`,
    );
  }

  // ------------------------------------------------------------------------
  // Scenario 5: boundary check -- newest local bar exactly 60s old (inside
  // the 90s freshness threshold) with full density -- must be ACCEPTED.
  // ------------------------------------------------------------------------
  {
    const { signalEngine, getRemoteFetchCallCountForTest } = await loadEngine("s5");
    signalEngine.setLocalBarCoverageAssessorForTest(barStore.assessBarCoverage);
    signalEngine.setLocalBarsProviderForTest(async (fromTime, toTime) => {
      const bars = buildLocalBars(toTime, 100, { newestBarAgeMinutes: 1 });
      return bars.filter(b => b.timestamp >= fromTime && b.timestamp <= toTime);
    });

    await signalEngine.fetchAndUpdateOHLCHistoryForTest();
    const sourceDetail = signalEngine.getOhlcSourceDetail();
    const remoteCalls = getRemoteFetchCallCountForTest();

    console.log("Scenario 5 -- boundary: newest local bar 60s old (inside the 90s freshness threshold), full density:");
    console.log(`  ohlcSourceDetail = "${sourceDetail}"`);
    console.log(`  remote fetch call count = ${remoteCalls}\n`);

    check(
      "a local series just inside the freshness threshold is correctly ACCEPTED",
      sourceDetail === "local-1m-chart-bars" && remoteCalls === 0,
      `sourceDetail="${sourceDetail}", remoteCalls=${remoteCalls}`,
    );
  }

  // ------------------------------------------------------------------------
  // Scenario 6: refreshRecentDailyOHLCFromHistory's local-bar-first branch --
  // confirm the SAME wiring covers the 72h daily-bar refresh, not just the
  // 60s ATR-feeding refresh (both call sites were required by scope).
  // ------------------------------------------------------------------------
  {
    const { signalEngine, getRemoteFetchCallCountForTest } = await loadEngine("s6");
    signalEngine.setLocalBarCoverageAssessorForTest(barStore.assessBarCoverage);
    signalEngine.setLocalBarsProviderForTest(async (fromTime, toTime) => {
      const bars = buildLocalBars(toTime, 72 * 60, { newestBarAgeMinutes: 1 }); // 72h dense+fresh
      return bars.filter(b => b.timestamp >= fromTime && b.timestamp <= toTime);
    });

    const remoteCallsBefore = getRemoteFetchCallCountForTest();
    await signalEngine.refreshRecentDailyOHLCFromHistoryForTest();
    const remoteCallsAfter = getRemoteFetchCallCountForTest();

    console.log("Scenario 6 -- refreshRecentDailyOHLCFromHistory (72h daily-bar refresh) local-bar-first wiring:");
    console.log(`  remote fetch calls before=${remoteCallsBefore}, after=${remoteCallsAfter}\n`);

    check(
      "the 72h daily-OHLC refresh also skips the remote tier when local bars densely+freshly cover the window",
      remoteCallsAfter === remoteCallsBefore,
      `remote calls went from ${remoteCallsBefore} to ${remoteCallsAfter}, expected no change`,
    );
  }

  // ------------------------------------------------------------------------
  // Scenario 7: refreshRecentDailyOHLCFromHistory falls back to remote when
  // local bars are absent (mirrors Scenario 2, for the daily-refresh path).
  // ------------------------------------------------------------------------
  {
    const { signalEngine, getRemoteFetchCallCountForTest } = await loadEngine("s7");
    signalEngine.setLocalBarCoverageAssessorForTest(barStore.assessBarCoverage);
    signalEngine.setLocalBarsProviderForTest(async () => []);

    const remoteCallsBefore = getRemoteFetchCallCountForTest();
    await signalEngine.refreshRecentDailyOHLCFromHistoryForTest();
    const remoteCallsAfter = getRemoteFetchCallCountForTest();

    console.log("Scenario 7 -- refreshRecentDailyOHLCFromHistory with no local bars:");
    console.log(`  remote fetch calls before=${remoteCallsBefore}, after=${remoteCallsAfter}\n`);

    check(
      "the 72h daily-OHLC refresh falls back to remote when local bars are absent",
      remoteCallsAfter === remoteCallsBefore + 1,
      `remote calls went from ${remoteCallsBefore} to ${remoteCallsAfter}, expected +1`,
    );
  }

  console.log(`\n${pass}/${pass + fail} assertions passed.`);
  if (fail > 0) {
    console.error(`❌ ${fail} FAILED`);
    process.exit(1);
  } else {
    console.log("✅ Local-bar-first OHLC fix CONFIRMED using real production code on both sides (signalEngine.ts's actual selection logic + barStore.ts's actual assessBarCoverage): dense+fresh local bars are preferred and remote is skipped; empty/sparse/stale local bars correctly fall back to remote; the freshness boundary is exact; and the same wiring covers both the 60s ATR-feeding refresh and the 72h daily-bar refresh.");
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
