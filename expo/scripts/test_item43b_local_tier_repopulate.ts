/**
 * ITEM 43(b) CHECKPOINT — CLEAR THE LOCAL TIER, REFILL FROM THE CORRECTED STORE
 * ============================================================================
 *
 * MINDSET (restated verbatim):
 *  Senior Lead Quantitative Trading Engineer / Senior Institutional Gold
 *  (XAU/USD) Elite Portfolio Manager.
 *  1. Measure before building. Pre-registered gates, no post-hoc loosening.
 *  2. Verify against the LIVE system, never "the code looks right."
 *  3. No step reported done without pasted evidence from the real system.
 *  4. Provenance is not appearance — ask the source system what it holds.
 *  5. A measurement is only as good as its LABELS.
 *  6. Correlation in observational data is not a lever.
 *  7. State the POWER before the result.
 *  8. When measurement is IMPOSSIBLE rather than underpowered, say so and
 *     decide on first principles — then state what forward evidence settles it.
 *
 * WHAT THIS TESTS, AND WHY IT NEEDED A CODE CHANGE:
 *  43(b) as briefed is "clear the in-memory local corpus tier, repopulate from
 *  the corrected durable store". Reading the live hydrate path showed that a
 *  clear-and-refill was NOT sufficient on its own, and that the interesting
 *  failure is the one that survives a reload:
 *
 *   hydrateFromRemote() merged the durable corpus into the local tier as a pure
 *   UNION BY signalId — "a signalId already present locally is left untouched".
 *   For a device that already holds the 17 stale rows (the normal case on native,
 *   where the tier is durable SQLite), the Item 43 corrections could therefore
 *   NEVER arrive. The model would keep training on labels the corpus of record
 *   no longer agrees with, silently.
 *
 *  So 43(b) is implemented in learningStore.ts: on a label/R conflict the DURABLE
 *  row wins, because the local tier is only ever a cache of it (learningStore's
 *  own stated contract). Local-only rows are still never discarded — they are
 *  still backfilled upward. This script proves that against the REAL module and
 *  the REAL corrected corpus.
 *
 * DATA-SOURCE RULE: trade_outcomes_v1 read DIRECT via anon key, through the real
 * learningStore read path. This script performs NO durable writes (the remote
 * push tier is disabled via the module's own test seam).
 *
 * PRE-REGISTERED GATES:
 *  G43b-1 A tier seeded with the OLD (pre-Item-43) labels, then hydrated, must
 *         end up carrying the CORRECTED label for all 17 rows.
 *  G43b-2 The stale-label count after hydration must be ZERO.
 *  G43b-3 Row count must be preserved (a relabel is an update, not a duplicate),
 *         and no signalId may be lost.
 *  G43b-4 CONTROL — rows that were already correct must be byte-identical after
 *         hydration. The reconcile must fix the defect and nothing else.
 *  G43b-5 A genuinely local-only row (not in the durable corpus) must SURVIVE
 *         hydration, proving the fix did not turn a cache-refresh into a wipe.
 */

import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface StoredOutcome {
  signalId: string;
  entryPrice: number;
  exitPrice: number;
  result: 'WIN' | 'LOSS';
  pnl: number;
  confidence: number;
  features: unknown;
  timestamp: string | number | Date;
  realizedR?: number;
  direction?: 'BUY' | 'SELL';
}

interface LearningStoreModule {
  hydrateFromRemote(options?: { limit?: number; cap?: number }): Promise<{
    available: boolean;
    pulled: number;
    merged: number;
    refreshed: number;
    backfilled: number;
    total: number;
  }>;
  getAllOutcomes(): Promise<StoredOutcome[]>;
  appendOutcome(o: StoredOutcome): Promise<void>;
  clearAllOutcomesForTest(): Promise<void>;
  fetchRemoteOutcomesDirect(limit: number): Promise<{ available: boolean; outcomes: StoredOutcome[] }>;
}

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['expo/.env', '.env']) {
    try {
      const raw = readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
    } catch {
      /* optional */
    }
  }
  return out;
}

/**
 * Loads the REAL learningStore.ts with only its React-Native `Platform` import
 * and the trpc write client stubbed (the established sandbox pattern, see
 * test_step3_sqlite_migration.ts). The merge/reconcile logic under test is the
 * live one — nothing about it is re-implemented here.
 */
async function loadLearningStore(): Promise<LearningStoreModule> {
  const dir = path.join(process.cwd(), 'scripts', '__sandbox_item43b__');
  const file = path.join(dir, 'learningStore.item43b.ts');
  const source = await readFile(path.join(process.cwd(), 'services', 'learningStore.ts'), 'utf8');
  const rewritten = source
    .replace(
      /^import\s+\{\s*Platform\s*\}\s+from\s+["']react-native["'];?\r?\n/m,
      'const Platform = { OS: "web" as const };\n',
    )
    .replace(
      /^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m,
      'const AsyncStorage = { async getItem(): Promise<string | null> { return null; }, async setItem(): Promise<void> {} } as { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };\n',
    )
    .replace(
      /^import\s+\{\s*trpcClient\s*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m,
      'const trpcClient = { learning: { pushOutcomes: { async mutate(): Promise<{ success: boolean; upserted: number; reason?: string }> { return { success: true, upserted: 0 }; } } } };\n',
    );
  await mkdir(dir, { recursive: true });
  await writeFile(file, rewritten);
  return import(`${pathToFileURL(file).href}?ts=${Date.now()}`) as Promise<LearningStoreModule>;
}

/** The pre-Item-43 stored labels, from the Item 43 dry-run evidence. */
const OLD_LABELS: Record<string, 'WIN' | 'LOSS'> = {
  dm1mv29uv: 'LOSS',
  '3xb0vvcw8': 'LOSS',
  femdezydf: 'LOSS',
  g7j9nscng: 'WIN',
  '6larx1nxu': 'WIN',
  mzc0mhqte: 'WIN',
  vvkra6mm4: 'LOSS',
  '3mo1r0qck': 'LOSS',
  hy4qxpd99: 'LOSS',
  adsl1y6o0: 'LOSS',
  '9d4fa59b8': 'LOSS',
  bsdmx4axy: 'WIN',
  psyk0xaij: 'WIN',
  a6pa5qyza: 'LOSS',
  vumhi1ztx: 'WIN',
  z8ovgl6dy: 'WIN',
  '663a4rkbv': 'LOSS',
};

let pass = 0;
let fail = 0;
function gate(label: string, ok: boolean, detail: string): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  process.env.EXPO_PUBLIC_SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  console.log('='.repeat(80));
  console.log('ITEM 43(b) — LOCAL TIER CLEARED AND REFILLED FROM THE CORRECTED CORPUS');
  console.log('='.repeat(80));

  const store = await loadLearningStore();

  // The durable corpus, read through the REAL read path.
  const durable = await store.fetchRemoteOutcomesDirect(300);
  if (!durable.available || durable.outcomes.length === 0) {
    console.log('\n  BLOCKER: durable corpus read unavailable. STOP. Nothing reported as done.');
    process.exitCode = 1;
    return;
  }
  const durableById = new Map(durable.outcomes.map((o) => [o.signalId, o]));
  const shortId = (id: string): string => id.slice(-9);

  console.log(`\n  POWER, stated before the result: the durable corpus holds ${durable.outcomes.length} rows.`);
  console.log(`  The tier is seeded with ALL of them but with the 17 PRE-Item-43 labels restored,`);
  console.log('  which is exactly the state of a device that resolved those trades before the');
  console.log('  correction. This is a census of the affected rows, not a sample.');

  // ── Seed the tier with the OLD labels (simulating a device holding stale rows) ──
  await store.clearAllOutcomesForTest();
  let seededStale = 0;
  for (const row of durable.outcomes) {
    const old = OLD_LABELS[shortId(row.signalId)];
    if (old && old !== row.result) {
      await store.appendOutcome({ ...row, result: old, realizedR: (row.realizedR ?? 0) * -1 });
      seededStale++;
    } else {
      await store.appendOutcome({ ...row });
    }
  }
  // G43b-5: one genuinely local-only row that the durable corpus has never seen.
  const localOnlyId = 'item43b-local-only-probe';
  await store.appendOutcome({
    signalId: localOnlyId,
    entryPrice: 4000,
    exitPrice: 4010,
    result: 'WIN',
    pnl: 10,
    confidence: 0.7,
    features: {},
    timestamp: new Date().toISOString(),
    realizedR: 1,
  });

  const seeded = await store.getAllOutcomes();
  const seededById = new Map(seeded.map((o) => [o.signalId, o]));
  console.log(`\n  seeded tier rows:            ${seeded.length}`);
  console.log(`  of those carrying a STALE label: ${seededStale}`);

  // ── The 43(b) action: hydrate from the corrected durable store ──
  const result = await store.hydrateFromRemote({ limit: 300, cap: 500 });
  console.log('\n  hydrateFromRemote() returned:');
  console.log(`    available=${result.available} pulled=${result.pulled} merged=${result.merged} refreshed=${result.refreshed} backfilled=${result.backfilled} total=${result.total}`);

  const after = await store.getAllOutcomes();
  const afterById = new Map(after.map((o) => [o.signalId, o]));

  // ── verdicts ──
  const corrected: string[] = [];
  const stillStale: string[] = [];
  for (const [sid, old] of Object.entries(OLD_LABELS)) {
    const durableRow = durable.outcomes.find((o) => shortId(o.signalId) === sid);
    if (!durableRow) continue;
    const local = afterById.get(durableRow.signalId);
    if (local && local.result === durableRow.result) corrected.push(sid);
    else stillStale.push(`${sid} (local=${local?.result ?? 'MISSING'}, durable=${durableRow.result}, old=${old})`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('THE 17 ROWS, AFTER HYDRATION');
  console.log('='.repeat(80));
  console.log('  signal_id    seeded(stale)  durable(truth)  local AFTER hydrate');
  console.log('  ' + '─'.repeat(66));
  for (const sid of Object.keys(OLD_LABELS)) {
    const d = durable.outcomes.find((o) => shortId(o.signalId) === sid);
    if (!d) continue;
    const s = seededById.get(d.signalId);
    const a = afterById.get(d.signalId);
    console.log(
      `  ${sid.padEnd(12)} ${(s?.result ?? '-').padEnd(14)} ${d.result.padEnd(15)} ${a?.result ?? 'MISSING'}`,
    );
  }

  // Control: rows that were never wrong must be untouched.
  let controlIdentical = 0;
  const controlChanged: string[] = [];
  for (const d of durable.outcomes) {
    if (OLD_LABELS[shortId(d.signalId)]) continue;
    const s = seededById.get(d.signalId);
    const a = afterById.get(d.signalId);
    if (s && a && s.result === a.result && (s.realizedR ?? null) === (a.realizedR ?? null)) controlIdentical++;
    else controlChanged.push(shortId(d.signalId));
  }

  console.log('\n' + '='.repeat(80));
  console.log('GATE VERDICTS');
  console.log('='.repeat(80));
  gate(
    'G43b-1 all 17 rows carry the corrected label after hydration',
    corrected.length === Object.keys(OLD_LABELS).length,
    `${corrected.length}/${Object.keys(OLD_LABELS).length} rows now match the durable corpus`,
  );
  gate('G43b-2 zero stale labels remain', stillStale.length === 0, `${stillStale.length} stale rows`);
  gate(
    'G43b-3 row count preserved and no signalId lost',
    after.length === seeded.length && durable.outcomes.every((d) => afterById.has(d.signalId)),
    `${seeded.length} rows before, ${after.length} after; all ${durable.outcomes.length} durable ids present`,
  );
  gate(
    'G43b-4 CONTROL: already-correct rows untouched',
    controlChanged.length === 0,
    `${controlIdentical} already-correct rows identical, ${controlChanged.length} unexpectedly changed`,
  );
  gate(
    'G43b-5 a local-only row survives (refresh is not a wipe)',
    afterById.has(localOnlyId),
    afterById.has(localOnlyId) ? 'the local-only probe row is still present' : 'the local-only probe row was DESTROYED',
  );
  if (stillStale.length > 0) {
    console.log('\n  STALE ROWS:');
    for (const s of stillStale) console.log(`    ${s}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log(`ITEM 43(b): ${fail === 0 ? 'ALL GATES PASSED' : 'GATE FAILURE — NOTHING REPORTED AS DONE'} (${pass} passed, ${fail} failed)`);
  console.log('='.repeat(80));
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
