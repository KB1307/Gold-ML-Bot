/**
 * ITEM 12 CHECKPOINT TEST — the durable learning corpus READ is off the Rork
 * backend, is PAGINATED, and every unavailable read is DURABLY counted.
 *
 * What is verified against the REAL production modules (only the platform
 * imports are stubbed — `Platform` -> web, AsyncStorage -> in-memory map,
 * `@supabase/supabase-js` -> a fake PostgREST that enforces the 500-row page
 * contract and can be forced to error):
 *
 *   12a  hydrateFromRemote() no longer touches trpcClient.learning.getOutcomes.
 *        Proven structurally (grep of the shipped source) AND behaviourally
 *        (the fake trpc getOutcomes route is never called during a hydrate).
 *   12b  pagination: a corpus LARGER than one page is pulled in full, across
 *        multiple `.range()` calls, in oldest-first order with no duplicates,
 *        and a pull that hits the caller's limit is flagged truncatedByLimit.
 *   12c  the WRITE path still goes through the service-role backend route.
 *   12d  an unavailable read increments a DURABLE counter, is greppable, and
 *        leaves the local corpus untouched; the counters survive a "reload"
 *        (fresh module instance reading the same AsyncStorage payload).
 *   12e  SECTION 2 of the REAL diagnostics export renders corpusSizeAtTraining,
 *        hydrateUnavailableCount, and prints UNKNOWN (not 0) for a weight vector
 *        that predates the telemetry.
 *
 * Usage: bun run scripts/test_item12_learning_corpus_direct_read.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildDiagnosticsExportText } from "../services/diagnosticsExport";
import type { PerformanceMetrics } from "../types/trading";

const SANDBOX_DIR = path.join(process.cwd(), "scripts", "__sandbox_item12__");

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}: ${detail}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}: ${detail}`);
  }
}

interface FakeCorpus {
  rows: { signalId: string; ts: string }[];
  rangeCalls: { from: number; to: number }[];
  failNextRead: boolean;
  trpcGetOutcomesCalls: number;
  trpcPushCalls: number;
  storage: Map<string, string>;
}

interface Sandbox {
  hydrateFromRemote(o?: { limit?: number; cap?: number }): Promise<{
    available: boolean; pulled: number; merged: number; backfilled: number; total: number;
  }>;
  fetchRemoteOutcomesDirect(limit: number): Promise<{
    available: boolean; outcomes: { signalId: string }[]; pages: number;
    truncatedByLimit: boolean; reason: string; detail: string | null;
  }>;
  getAllOutcomes(): Promise<{ signalId: string }[]>;
  getOutcomeCount(): Promise<number>;
  clearAllOutcomesForTest(): Promise<void>;
  pushOutcomesToRemote(o: unknown[]): Promise<{ upserted: number; queued: number }>;
  getLearningCorpusStats(): {
    hydrateAttempts: number; hydrateSuccesses: number; hydrateUnavailableCount: number;
    lastPulled: number | null; lastTotal: number | null; lastPages: number | null;
    lastTruncatedByLimit: boolean; lastUnavailableReason: string | null;
    lastUnavailableAt: number | null; lastSuccessAt: number | null; hydrated: boolean;
  };
  hydrateLearningCorpusStats(): Promise<void>;
  __corpus: FakeCorpus;
}

/**
 * Sandboxed copy of the REAL services/learningStore.ts. Every line of pagination,
 * merge and counter logic under test is production code; only the three platform
 * imports are replaced.
 */
async function loadSandbox(sharedStorage?: Map<string, string>): Promise<Sandbox> {
  const src = await readFile(path.join(process.cwd(), "services", "learningStore.ts"), "utf8");

  const rewritten = src
    .replace(
      /^import\s+\{\s*Platform\s*\}\s+from\s+["']react-native["'];?\r?\n/m,
      'const Platform = { OS: "web" as const };\n',
    )
    .replace(
      /^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m,
      `
const __corpus: any = {
  rows: [],
  rangeCalls: [],
  failNextRead: false,
  trpcGetOutcomesCalls: 0,
  trpcPushCalls: 0,
  storage: new Map<string, string>(),
};
export const __corpusStore = __corpus;
const AsyncStorage = {
  async getItem(key: string): Promise<string | null> { return __corpus.storage.get(key) ?? null; },
  async setItem(key: string, value: string): Promise<void> { __corpus.storage.set(key, value); },
  async removeItem(key: string): Promise<void> { __corpus.storage.delete(key); },
};
`,
    )
    .replace(
      /^import\s+\{\s*createClient,\s*type\s+SupabaseClient\s*\}\s+from\s+["']@supabase\/supabase-js["'];?\r?\n/m,
      `
type SupabaseClient = any;
/** Fake PostgREST. Enforces the real contract: a .range() window is inclusive
 *  and a response NEVER exceeds the requested window size. */
function createClient(_url: string, _key: string, _opts?: any): any {
  return {
    from(_t: string) {
      return {
        select(_c: string) {
          const q: any = {
            order(_col: string, _o?: any) { return q; },
            async range(from: number, to: number) {
              if (__corpus.failNextRead) {
                __corpus.failNextRead = false;
                return { data: null, error: { message: 'simulated corpus outage', code: 'PGRST999' } };
              }
              __corpus.rangeCalls.push({ from, to });
              const sorted = [...__corpus.rows].sort(
                (a: any, b: any) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
              );
              const page = sorted.slice(from, to + 1).map((r: any) => ({
                signal_id: r.signalId,
                ts: r.ts,
                direction: 'BUY',
                result: 'WIN',
                entry_price: 4000,
                exit_price: 4004,
                pnl: 4,
                confidence: 0.8,
                realized_r: 0.5,
                is_scratch: false,
                signal_duration_ms: 60000,
                feature_schema_version: 2,
                features: {},
                misleading_features: null,
              }));
              return { data: page, error: null };
            },
          };
          return q;
        },
      };
    },
  };
}
`,
    )
    .replace(
      /^import\s+\{\s*trpcClient\s*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m,
      `
const trpcClient = {
  learning: {
    pushOutcomes: {
      async mutate(input: { outcomes: any[] }) {
        __corpus.trpcPushCalls += 1;
        return { success: true, reason: 'ok', upserted: input.outcomes.length };
      },
    },
    getOutcomes: {
      async query(_i?: { limit?: number }) {
        __corpus.trpcGetOutcomesCalls += 1;
        return { outcomes: [], available: true };
      },
    },
  },
} as any;
`,
    );

  await mkdir(SANDBOX_DIR, { recursive: true });
  const outPath = path.join(SANDBOX_DIR, "learningStore.item12.ts");
  await writeFile(outPath, rewritten);
  const mod = (await import(`${pathToFileURL(outPath).href}?ts=${Date.now()}-${Math.random()}`)) as unknown as
    Record<string, unknown>;
  const sandbox = { ...mod, __corpus: (mod as { __corpusStore: FakeCorpus }).__corpusStore } as unknown as Sandbox;
  if (sharedStorage) {
    // Simulate a RELOAD: a brand-new module instance reading the SAME durable payload.
    sandbox.__corpus.storage = sharedStorage;
  }
  return sandbox;
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  ITEM 12 — DIRECT PAGINATED CORPUS READ + DURABLE COUNTERS");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  // ── 12a — structural: the shipped source has no backend on the READ path ────
  console.log("── 12a — the READ path no longer references the Rork backend ──");
  const shipped = await readFile(path.join(process.cwd(), "services", "learningStore.ts"), "utf8");
  // Strip comments first: the doc header NAMES the retired route deliberately, and
  // a grep that cannot tell a comment from a call would pass on the wrong evidence.
  const shippedCode = shipped
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  check(
    "12a shipped learningStore CODE has NO learning.getOutcomes call",
    !shippedCode.includes("learning.getOutcomes"),
    `code occurrences=${(shippedCode.match(/learning\.getOutcomes/g) ?? []).length} (comment mentions=${(shipped.match(/learning\.getOutcomes/g) ?? []).length})`,
  );
  check(
    "12c the WRITE path still uses the service-role backend route",
    shipped.includes("trpcClient.learning.pushOutcomes.mutate"),
    "trpcClient.learning.pushOutcomes.mutate present (writes deliberately unchanged)",
  );

  const store = await loadSandbox();

  // ── 12b — pagination across a corpus larger than one page ──────────────────
  console.log("\n── 12b — pagination (page size 500) ──");
  const base = Date.UTC(2026, 7, 1, 0, 0, 0);
  store.__corpus.rows = Array.from({ length: 1200 }, (_, i) => ({
    signalId: `sig-${String(i).padStart(4, "0")}`,
    ts: new Date(base + i * 60_000).toISOString(),
  }));

  const full = await store.fetchRemoteOutcomesDirect(2000);
  check(
    "12b a 1200-row corpus is pulled IN FULL (past the single-response cap)",
    full.available && full.outcomes.length === 1200,
    `available=${full.available} pulled=${full.outcomes.length}`,
  );
  check(
    "12b the pull genuinely paginated",
    full.pages === 3 && store.__corpus.rangeCalls.length === 3,
    `pages=${full.pages} rangeCalls=${JSON.stringify(store.__corpus.rangeCalls)}`,
  );
  check(
    "12b no page ever exceeded 500 rows",
    store.__corpus.rangeCalls.every((c) => c.to - c.from + 1 <= 500),
    store.__corpus.rangeCalls.map((c) => `${c.to - c.from + 1}`).join(","),
  );
  const ids = full.outcomes.map((o) => o.signalId);
  check(
    "12b result is OLDEST-FIRST with no duplicates",
    ids[0] === "sig-0000" && ids[ids.length - 1] === "sig-1199" && new Set(ids).size === ids.length,
    `first=${ids[0]} last=${ids[ids.length - 1]} unique=${new Set(ids).size}/${ids.length}`,
  );

  store.__corpus.rangeCalls = [];
  const capped = await store.fetchRemoteOutcomesDirect(300);
  check(
    "12b a limit-capped pull stops at the limit and FLAGS truncation",
    capped.outcomes.length === 300 && capped.truncatedByLimit,
    `pulled=${capped.outcomes.length} truncatedByLimit=${capped.truncatedByLimit}`,
  );
  const exact = await store.fetchRemoteOutcomesDirect(1200);
  check(
    "12b a pull that exactly drains the corpus is NOT flagged truncated",
    exact.outcomes.length === 1200 && !exact.truncatedByLimit,
    `pulled=${exact.outcomes.length} truncatedByLimit=${exact.truncatedByLimit}`,
  );

  // ── 12a behavioural — hydrate never calls the backend read route ───────────
  console.log("\n── 12a — hydrate is backend-free at runtime ──");
  await store.clearAllOutcomesForTest();
  const hydrate = await store.hydrateFromRemote({ limit: 300, cap: 500 });
  check(
    "12a hydrate restored the corpus without the backend read route",
    hydrate.available && hydrate.pulled === 300 && store.__corpus.trpcGetOutcomesCalls === 0,
    `available=${hydrate.available} pulled=${hydrate.pulled} trpcGetOutcomesCalls=${store.__corpus.trpcGetOutcomesCalls}`,
  );
  const statsAfterOk = store.getLearningCorpusStats();
  check(
    "12d a successful hydrate is counted and dated",
    statsAfterOk.hydrateSuccesses === 1 &&
      statsAfterOk.hydrateUnavailableCount === 0 &&
      statsAfterOk.lastPulled === 300 &&
      statsAfterOk.lastSuccessAt !== null,
    `successes=${statsAfterOk.hydrateSuccesses} unavailable=${statsAfterOk.hydrateUnavailableCount} lastPulled=${statsAfterOk.lastPulled} pages=${statsAfterOk.lastPages}`,
  );
  check(
    "12d the limit-capped pull is reported as truncated in the counters",
    statsAfterOk.lastTruncatedByLimit,
    `lastTruncatedByLimit=${statsAfterOk.lastTruncatedByLimit} (corpus 1200 > limit 300)`,
  );

  // ── 12d — an unavailable read is counted, local corpus untouched ───────────
  console.log("\n── 12d — an UNAVAILABLE read is counted, never silent ──");
  const localBefore = await store.getOutcomeCount();
  store.__corpus.failNextRead = true;
  const outage = await store.hydrateFromRemote({ limit: 300, cap: 500 });
  const localAfter = await store.getOutcomeCount();
  const statsAfterFail = store.getLearningCorpusStats();
  check(
    "12d an unavailable read returns available:false and pulls nothing",
    !outage.available && outage.pulled === 0,
    `available=${outage.available} pulled=${outage.pulled}`,
  );
  check(
    "12d the local corpus is left exactly as it was",
    localAfter === localBefore,
    `local ${localBefore} -> ${localAfter}`,
  );
  check(
    "12d hydrateUnavailableCount incremented with a reason and a timestamp",
    statsAfterFail.hydrateUnavailableCount === 1 &&
      (statsAfterFail.lastUnavailableReason ?? "").includes("READ_ERROR") &&
      statsAfterFail.lastUnavailableAt !== null,
    `unavailable=${statsAfterFail.hydrateUnavailableCount} reason=${statsAfterFail.lastUnavailableReason}`,
  );
  check(
    "12d attempts reconcile mechanically: attempts = successes + unavailable",
    statsAfterFail.hydrateAttempts === statsAfterFail.hydrateSuccesses + statsAfterFail.hydrateUnavailableCount,
    `attempts=${statsAfterFail.hydrateAttempts} successes=${statsAfterFail.hydrateSuccesses} unavailable=${statsAfterFail.hydrateUnavailableCount}`,
  );

  // ── 12d — DURABILITY: counters survive a reload ────────────────────────────
  console.log("\n── 12d — counters are DURABLE across a reload ──");
  const sharedStorage = store.__corpus.storage;
  const reloaded = await loadSandbox(sharedStorage);
  await reloaded.hydrateLearningCorpusStats();
  const reloadedStats = reloaded.getLearningCorpusStats();
  check(
    "12d a fresh process rehydrates the durable unavailable count",
    reloadedStats.hydrateUnavailableCount === 1 && reloadedStats.hydrateAttempts >= 2,
    `after reload: attempts=${reloadedStats.hydrateAttempts} successes=${reloadedStats.hydrateSuccesses} unavailable=${reloadedStats.hydrateUnavailableCount}`,
  );
  check(
    "12d the reloaded counters are marked hydrated",
    reloadedStats.hydrated,
    `hydrated=${reloadedStats.hydrated}`,
  );

  // ── 12e — the REAL export renders the provenance ───────────────────────────
  console.log("\n── 12e — SECTION 2 renders corpus provenance (real export writer) ──");
  const emptyMetrics = {
    totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, profitFactor: 0,
    sharpeRatio: 0, expectancy: 0, averageWin: 0, averageLoss: 0, totalProfit: 0,
    totalLoss: 0, maxDrawdown: 0, currentDrawdown: 0,
  } as unknown as PerformanceMetrics;
  const modelHealth = {
    modelHealthScore: 85, featureCorrelationStatus: "HEALTHY", confidenceDegradation: 0,
    conceptDriftScore: 0, driftAlertLevel: "NONE", daysSinceRetrain: 0,
    retrainingRecommended: false, retrainScheduled: false, featureImportanceDrift: [],
  } as unknown as Parameters<typeof buildDiagnosticsExportText>[0]["modelHealth"];

  const instrumented = buildDiagnosticsExportText({
    signalHistory: [],
    modelWeights: { weights: [["rsi", 0.2]], lastTrainingTime: Date.now(), corpusSizeAtTraining: 51, hydrateUnavailableAtTraining: 2 },
    modelHealth,
    performanceMetrics: emptyMetrics,
    learningCorpusStats: reloadedStats,
  });
  check(
    "12e corpusSizeAtTraining is printed",
    instrumented.includes("Corpus size at training: 51 outcome(s)"),
    "found 'Corpus size at training: 51 outcome(s)'",
  );
  check(
    "12e the unavailable count at training is printed",
    instrumented.includes("Corpus-unavailable count at training: 2"),
    "found 'Corpus-unavailable count at training: 2'",
  );
  check(
    "12e the durable corpus counters are printed with the unavailable alert",
    instrumented.includes("Hydrate UNAVAILABLE: 1") && instrumented.includes("CORPUS WAS UNAVAILABLE"),
    "found 'Hydrate UNAVAILABLE: 1' and the alert block",
  );

  const legacy = buildDiagnosticsExportText({
    signalHistory: [],
    modelWeights: { weights: [["rsi", 0.2]], lastTrainingTime: Date.now() },
    modelHealth,
    performanceMetrics: emptyMetrics,
  });
  check(
    "12e a pre-telemetry weight vector prints UNKNOWN, never 0",
    legacy.includes("Corpus size at training: UNKNOWN") && !legacy.includes("Corpus size at training: 0"),
    "found 'Corpus size at training: UNKNOWN (...)'",
  );
  check(
    "12e a caller that supplies no counters renders NOT INSTRUMENTED, not zeros",
    legacy.includes("NOT INSTRUMENTED - caller did not supply learningCorpusStats"),
    "found the NOT INSTRUMENTED line",
  );

  console.log(`\n${passed}/${passed + failed} assertions passed.`);
  if (failed > 0) {
    console.log("❌ ITEM 12 checkpoint FAILED.");
    process.exit(1);
  }
  console.log("✅ ITEM 12: direct paginated corpus read + durable counters verified.");
}

void main();
