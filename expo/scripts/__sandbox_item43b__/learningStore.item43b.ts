const Platform = { OS: "web" as const };
const AsyncStorage = { async getItem(): Promise<string | null> { return null; }, async setItem(): Promise<void> {} } as { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
const trpcClient = { learning: { pushOutcomes: { async mutate(): Promise<{ success: boolean; upserted: number; reason?: string }> { return { success: true, upserted: 0 }; } } } };

/**
 * Step 3 — persisted learning memory storage.
 *
 * ── ITEM 12 (2026-08-04) — THE READ IS OFF THE RORK BACKEND ────────────────
 * `hydrateFromRemote()` used to pull the durable corpus through
 * `trpcClient.learning.getOutcomes` — the Rork backend, which FLAPS 503 on the
 * `EXPO_PUBLIC_RORK_API_BASE_URL` origin and is permanently "no bundle
 * deployed" on the FUNCTIONS_URL origin. On web the local tier is an in-memory
 * array wiped on every reload, so a flap at startup meant the model could train
 * on an EMPTY or TRUNCATED corpus with no log, no counter and nothing in the
 * export.
 *
 * DATA-SOURCE RULE as enforced here:
 *   - the READ (`trade_outcomes_v1`) goes DIRECTLY to Supabase via the PUBLIC
 *     anon key (SELECT is RLS-permitted; verified all 51 rows readable), and is
 *     PAGINATED so the 1000-row PostgREST cap can never silently truncate it;
 *   - the WRITE (`pushOutcomesToRemote`) DELIBERATELY stays on the service-role
 *     backend route, so the training corpus cannot be poisoned by anyone
 *     holding the public anon key. Writes are untouched by Item 12;
 *   - every unavailable read increments a DURABLE counter surfaced in the
 *     diagnostics export, so a silent truncation is no longer possible.
 *
 * DURABILITY UPGRADE (Supabase-backed): the local tier below (SQLite on native,
 * in-memory on web) is a CACHE in front of the durable `trade_outcomes_v1`
 * table.
 *
 * Why: SQLite made the corpus durable per install but never shared it, and on
 * web/preview the store was purely in-memory, so every browser reload reset the
 * "self-learning" memory to zero. With the remote tier:
 *   - every resolved outcome is upserted server-side, keyed by signalId, so a
 *     re-push is idempotent and can never double-count a trade;
 *   - `hydrateFromRemote()` merges the durable corpus back into the local tier
 *     on startup (union by signalId, re-sorted by timestamp), so a fresh device
 *     or a reloaded browser tab starts with the full history, not an empty one.
 * Remote failures are non-fatal: the local tier keeps working offline and
 * unsynced rows are retried on the next append/hydrate.
 *
 * Previously trade outcomes lived entirely in a single AsyncStorage JSON blob
 * (`trade_outcomes_learning`), capped at 100 entries in-memory. That has two
 * problems: (1) AsyncStorage round-trips the ENTIRE history on every single
 * write (one win/loss recorded -> the whole blob re-serialized and rewritten),
 * and (2) a flat 100-entry cap throws away real trading history far sooner
 * than necessary for a system that retrains on a 14-day rolling window.
 *
 * This module moves outcome storage to expo-sqlite (the pattern already used
 * by barStore.ts for price bars): each outcome is an append-only row, so
 * writes are O(1) instead of O(n), and the retention cap is enforced with a
 * single DELETE rather than a full in-memory slice + full rewrite.
 */

export interface StoredTradeOutcome {
  signalId: string;
  entryPrice: number;
  exitPrice: number;
  result: 'WIN' | 'LOSS';
  pnl: number;
  confidence: number;
  features: unknown;
  timestamp: string | number | Date;
  misleadingFeatures?: unknown;
  signalDuration?: number;
  direction?: 'BUY' | 'SELL';
  realizedR?: number;
  isScratch?: boolean;
  /** Feature-vector schema version of `features` (1 = legacy 6-scalar, 2 = wide). */
  featureSchemaVersion?: number;
}

/** Outcomes queued for the remote corpus because a push failed (or was offline). */
let pendingRemotePush: StoredTradeOutcome[] = [];
const MAX_PENDING_REMOTE_PUSH = 200;
let remoteSyncEnabled = true;

/** Test seam: disables the remote tier so unit tests exercise the local store only. */
export function setRemoteSyncEnabledForTest(enabled: boolean): void {
  remoteSyncEnabled = enabled;
}

function toRemotePayload(outcome: StoredTradeOutcome) {
  return {
    signalId: outcome.signalId,
    timestamp: typeof outcome.timestamp === 'number'
      ? outcome.timestamp
      : new Date(outcome.timestamp).toISOString(),
    entryPrice: outcome.entryPrice,
    exitPrice: outcome.exitPrice,
    result: outcome.result,
    pnl: outcome.pnl,
    confidence: outcome.confidence,
    direction: outcome.direction,
    realizedR: outcome.realizedR,
    isScratch: outcome.isScratch,
    signalDuration: outcome.signalDuration,
    features: outcome.features ?? {},
    misleadingFeatures: outcome.misleadingFeatures ?? undefined,
    featureSchemaVersion: outcome.featureSchemaVersion,
  };
}

/**
 * Best-effort push of one or more outcomes into the durable corpus. Never
 * throws: on failure the rows are queued and retried on the next push/hydrate.
 */
export async function pushOutcomesToRemote(outcomes: StoredTradeOutcome[]): Promise<{ upserted: number; queued: number }> {
  if (!remoteSyncEnabled) return { upserted: 0, queued: 0 };
  const batch = [...pendingRemotePush, ...outcomes];
  if (batch.length === 0) return { upserted: 0, queued: 0 };

  try {
    const result = await trpcClient.learning.pushOutcomes.mutate({
      outcomes: batch.slice(-MAX_PENDING_REMOTE_PUSH).map(toRemotePayload),
    });
    if (result.success) {
      pendingRemotePush = [];
      return { upserted: result.upserted, queued: 0 };
    }
    pendingRemotePush = batch.slice(-MAX_PENDING_REMOTE_PUSH);
    console.warn(`⚠️ [LearningStore] Remote push rejected (${result.reason}) - ${pendingRemotePush.length} outcome(s) queued`);
    return { upserted: 0, queued: pendingRemotePush.length };
  } catch (err) {
    pendingRemotePush = batch.slice(-MAX_PENDING_REMOTE_PUSH);
    console.warn('⚠️ [LearningStore] Remote push failed, outcomes queued for retry:', err instanceof Error ? err.message : err);
    return { upserted: 0, queued: pendingRemotePush.length };
  }
}

export function getPendingRemotePushCount(): number {
  return pendingRemotePush.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 12(a)(b) — DIRECT, PAGINATED anon read of `trade_outcomes_v1`.
// No Rork backend on this path. No fallback venue: a failed read returns a
// typed unavailable result and the caller keeps the local corpus untouched.
// ─────────────────────────────────────────────────────────────────────────────

const OUTCOMES_TABLE = 'trade_outcomes_v1';
/** PostgREST caps a single response at 1000 rows; page well under it. */
const OUTCOMES_PAGE_SIZE = 500;
/** Hard stop so a runaway table can never spin the loop forever. */
const OUTCOMES_MAX_PAGES = 40;

let outcomesClient: SupabaseClient | null = null;

/** Dedicated anon client for the corpus READ. The service-role key is never
 *  referenced here and is never shipped to the client. */
function getOutcomesClient(): SupabaseClient | null {
  if (outcomesClient) return outcomesClient;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  outcomesClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return outcomesClient;
}

/** Serialize a PostgrestError (a plain object, not an Error) readably. */
function serializeOutcomeError(err: unknown): string {
  if (err === null || err === undefined) return 'null';
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [`message="${String(e.message)}"`];
    if (typeof e.code === 'string' && e.code) parts.push(`code=${e.code}`);
    if (typeof e.details === 'string' && e.details) parts.push(`details=${e.details}`);
    return parts.join(' ');
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

interface RemoteOutcomeRow {
  signal_id: string;
  ts: string;
  direction: string | null;
  result: string;
  entry_price: number | string;
  exit_price: number | string;
  pnl: number | string;
  confidence: number | string | null;
  realized_r: number | string | null;
  is_scratch: boolean | null;
  signal_duration_ms: number | string | null;
  feature_schema_version: number | null;
  features: unknown;
  misleading_features: unknown;
}

function mapRemoteRow(row: RemoteOutcomeRow): StoredTradeOutcome {
  return {
    signalId: row.signal_id,
    timestamp: row.ts,
    entryPrice: Number(row.entry_price),
    exitPrice: Number(row.exit_price),
    result: row.result === 'WIN' ? 'WIN' : 'LOSS',
    pnl: Number(row.pnl),
    confidence: row.confidence === null ? 0.72 : Number(row.confidence),
    direction: row.direction === 'BUY' || row.direction === 'SELL' ? row.direction : undefined,
    realizedR: row.realized_r === null ? undefined : Number(row.realized_r),
    isScratch: row.is_scratch ?? undefined,
    signalDuration: row.signal_duration_ms === null ? undefined : Number(row.signal_duration_ms),
    features: row.features ?? {},
    misleadingFeatures: row.misleading_features ?? undefined,
    featureSchemaVersion: row.feature_schema_version ?? undefined,
  };
}

export interface RemoteOutcomesReadResult {
  available: boolean;
  outcomes: StoredTradeOutcome[];
  /** Number of PostgREST pages actually fetched. Proof the pagination ran. */
  pages: number;
  /** True when `limit` cut the pull short (i.e. the corpus is larger). */
  truncatedByLimit: boolean;
  reason: 'OK' | 'NOT_CONFIGURED' | 'READ_ERROR';
  detail: string | null;
}

/**
 * Reads the durable corpus DIRECTLY from Supabase via the anon key, newest-first
 * internally and returned OLDEST-FIRST to match the local store's ordering.
 * Paginated: the caller's `limit` is honoured across pages, never by truncating
 * a single 1000-row response.
 */
export async function fetchRemoteOutcomesDirect(limit: number): Promise<RemoteOutcomesReadResult> {
  const client = getOutcomesClient();
  if (!client) {
    return {
      available: false,
      outcomes: [],
      pages: 0,
      truncatedByLimit: false,
      reason: 'NOT_CONFIGURED',
      detail: 'EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY is missing',
    };
  }

  const collected: StoredTradeOutcome[] = [];
  let pages = 0;
  let offset = 0;
  let sawFullPage = false;

  while (pages < OUTCOMES_MAX_PAGES && collected.length < limit) {
    const pageSize = Math.min(OUTCOMES_PAGE_SIZE, limit - collected.length);
    try {
      const res = await client
        .from(OUTCOMES_TABLE)
        .select(
          'signal_id, ts, direction, result, entry_price, exit_price, pnl, confidence, realized_r, is_scratch, signal_duration_ms, feature_schema_version, features, misleading_features',
        )
        .order('ts', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (res.error) {
        console.warn(`[LearningStore] CORPUS_READ_UNAVAILABLE reason=READ_ERROR ${serializeOutcomeError(res.error)}`);
        return {
          available: false,
          outcomes: [],
          pages,
          truncatedByLimit: false,
          reason: 'READ_ERROR',
          detail: serializeOutcomeError(res.error),
        };
      }
      const rows = (res.data ?? []) as unknown as RemoteOutcomeRow[];
      pages += 1;
      for (const row of rows) collected.push(mapRemoteRow(row));
      sawFullPage = rows.length === pageSize;
      if (rows.length < pageSize) break;
      offset += pageSize;
    } catch (err: unknown) {
      console.warn(`[LearningStore] CORPUS_READ_UNAVAILABLE reason=READ_ERROR ${serializeOutcomeError(err)}`);
      return {
        available: false,
        outcomes: [],
        pages,
        truncatedByLimit: false,
        reason: 'READ_ERROR',
        detail: serializeOutcomeError(err),
      };
    }
  }

  // Truncation is PROVEN, not inferred: when the pull filled the caller's limit,
  // probe for ONE more row. Inferring it from "the last page was full" reports a
  // corpus that exactly drains the limit as truncated, which is a false alarm.
  let truncatedByLimit = false;
  if (collected.length >= limit && sawFullPage) {
    try {
      const probe = await client
        .from(OUTCOMES_TABLE)
        .select('signal_id')
        .order('ts', { ascending: false })
        .range(offset, offset);
      truncatedByLimit = !probe.error && (probe.data?.length ?? 0) > 0;
    } catch {
      // A failed probe is not evidence either way; leave the flag false.
      truncatedByLimit = false;
    }
  }

  // Reverse to oldest-first, matching getAllOutcomes()'s contract.
  collected.reverse();
  return {
    available: true,
    outcomes: collected,
    pages,
    truncatedByLimit,
    reason: 'OK',
    detail: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 12(d) — DURABLE hydration counters.
//
// Item 4 established that process-lifetime counters reset on reload and capture
// nothing across a trading day, so these are persisted to AsyncStorage exactly
// like the telegram delivery counters. A corpus read that came back
// `available:false` must be visible in the export forever, not just until the
// next reload.
// ─────────────────────────────────────────────────────────────────────────────

const LEARNING_CORPUS_COUNTERS_KEY = 'learning_corpus_counters_v1';
const CORPUS_COUNTER_FLUSH_INTERVAL_MS = 15_000;

export interface LearningCorpusStats {
  /** hydrateFromRemote() calls that reached the read path. */
  hydrateAttempts: number;
  /** Calls where the direct Supabase read returned rows (available === true). */
  hydrateSuccesses: number;
  /** Calls where the corpus was UNAVAILABLE — the silent-truncation counter. */
  hydrateUnavailableCount: number;
  /** Rows pulled on the most recent successful hydrate. */
  lastPulled: number | null;
  /** Local-tier total after the most recent hydrate. */
  lastTotal: number | null;
  /** PostgREST pages fetched on the most recent successful hydrate. */
  lastPages: number | null;
  /** True if the last successful pull hit the caller's limit (corpus is bigger). */
  lastTruncatedByLimit: boolean;
  lastUnavailableReason: string | null;
  lastUnavailableAt: number | null;
  lastSuccessAt: number | null;
  /** True once the counters have been rehydrated from durable storage. */
  hydrated: boolean;
}

const corpusStats: LearningCorpusStats = {
  hydrateAttempts: 0,
  hydrateSuccesses: 0,
  hydrateUnavailableCount: 0,
  lastPulled: null,
  lastTotal: null,
  lastPages: null,
  lastTruncatedByLimit: false,
  lastUnavailableReason: null,
  lastUnavailableAt: null,
  lastSuccessAt: null,
  hydrated: false,
};

type PersistedCorpusStats = Omit<LearningCorpusStats, 'hydrated'>;
let corpusHydrationPromise: Promise<void> | null = null;
let corpusLastFlushAt = 0;

/** Rehydrates the corpus counters from AsyncStorage. Reads at most once. */
export function hydrateLearningCorpusStats(): Promise<void> {
  if (corpusHydrationPromise) return corpusHydrationPromise;
  corpusHydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(LEARNING_CORPUS_COUNTERS_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          const p = parsed as Partial<PersistedCorpusStats>;
          // ADD rather than assign: a hydrate can complete before these counters
          // finish loading, and assignment would silently discard that count.
          corpusStats.hydrateAttempts += p.hydrateAttempts ?? 0;
          corpusStats.hydrateSuccesses += p.hydrateSuccesses ?? 0;
          corpusStats.hydrateUnavailableCount += p.hydrateUnavailableCount ?? 0;
          corpusStats.lastPulled = corpusStats.lastPulled ?? p.lastPulled ?? null;
          corpusStats.lastTotal = corpusStats.lastTotal ?? p.lastTotal ?? null;
          corpusStats.lastPages = corpusStats.lastPages ?? p.lastPages ?? null;
          corpusStats.lastUnavailableReason = corpusStats.lastUnavailableReason ?? p.lastUnavailableReason ?? null;
          corpusStats.lastUnavailableAt = corpusStats.lastUnavailableAt ?? p.lastUnavailableAt ?? null;
          corpusStats.lastSuccessAt = corpusStats.lastSuccessAt ?? p.lastSuccessAt ?? null;
        }
      }
    } catch (error: unknown) {
      console.warn(
        '[LearningStore] Failed to rehydrate corpus counters:',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      corpusStats.hydrated = true;
    }
  })();
  return corpusHydrationPromise;
}

function persistCorpusStats(force: boolean): void {
  if (!corpusStats.hydrated) return;
  const now = Date.now();
  if (!force && now - corpusLastFlushAt < CORPUS_COUNTER_FLUSH_INTERVAL_MS) return;
  corpusLastFlushAt = now;
  const payload: PersistedCorpusStats = {
    hydrateAttempts: corpusStats.hydrateAttempts,
    hydrateSuccesses: corpusStats.hydrateSuccesses,
    hydrateUnavailableCount: corpusStats.hydrateUnavailableCount,
    lastPulled: corpusStats.lastPulled,
    lastTotal: corpusStats.lastTotal,
    lastPages: corpusStats.lastPages,
    lastTruncatedByLimit: corpusStats.lastTruncatedByLimit,
    lastUnavailableReason: corpusStats.lastUnavailableReason,
    lastUnavailableAt: corpusStats.lastUnavailableAt,
    lastSuccessAt: corpusStats.lastSuccessAt,
  };
  AsyncStorage.setItem(LEARNING_CORPUS_COUNTERS_KEY, JSON.stringify(payload)).catch((error: unknown) => {
    console.warn(
      '[LearningStore] Failed to persist corpus counters:',
      error instanceof Error ? error.message : String(error),
    );
  });
}

/** Snapshot of the durable corpus-hydration counters, for the diagnostics export. */
export function getLearningCorpusStats(): LearningCorpusStats {
  return { ...corpusStats };
}

/** Test-only: reset the in-memory counters (does NOT touch AsyncStorage). */
export function __resetLearningCorpusStatsForTest(): void {
  corpusStats.hydrateAttempts = 0;
  corpusStats.hydrateSuccesses = 0;
  corpusStats.hydrateUnavailableCount = 0;
  corpusStats.lastPulled = null;
  corpusStats.lastTotal = null;
  corpusStats.lastPages = null;
  corpusStats.lastTruncatedByLimit = false;
  corpusStats.lastUnavailableReason = null;
  corpusStats.lastUnavailableAt = null;
  corpusStats.lastSuccessAt = null;
}

type SqliteDatabase = {
  execAsync: (sql: string) => Promise<void>;
  runAsync: (sql: string, params?: unknown[]) => Promise<void>;
  getAllAsync: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
};

let db: SqliteDatabase | null = null;
let initPromise: Promise<void> | null = null;

// Web (and any environment without expo-sqlite) falls back to an in-memory
// array, mirroring barStore.ts's webStore pattern. Order is insertion order,
// which matches SQLite's rowid-ordered `ORDER BY id ASC`.
let webOutcomes: StoredTradeOutcome[] = [];

async function initDb(): Promise<void> {
  if (Platform.OS === 'web') return;
  if (db) return;
  try {
    const SQLite = await import('expo-sqlite');
    const opened = await SQLite.openDatabaseAsync('learning.db');
    db = opened as unknown as SqliteDatabase;
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS trade_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trade_outcomes_ts ON trade_outcomes(ts);
    `);
    console.log('🗄️ [LearningStore] sqlite initialized');
  } catch (err) {
    console.warn('⚠️ [LearningStore] sqlite init failed, falling back to memory:', err);
    db = null;
  }
}

export function ensureLearningStoreReady(): Promise<void> {
  if (!initPromise) initPromise = initDb();
  return initPromise;
}

function toTimestampMs(ts: string | number | Date): number {
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  const parsed = new Date(ts).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Append one outcome row. O(1) — does not touch any other row. */
export async function appendOutcome(outcome: StoredTradeOutcome): Promise<void> {
  await ensureLearningStoreReady();
  const ts = toTimestampMs(outcome.timestamp);
  if (Platform.OS === 'web' || !db) {
    webOutcomes.push(outcome);
    return;
  }
  await db.runAsync(
    'INSERT INTO trade_outcomes (ts, data) VALUES (?, ?)',
    [ts, JSON.stringify(outcome)],
  );
}

/**
 * Replaces the entire local tier with `outcomes` (already in the desired order).
 * Used by hydrateFromRemote() so a merged local+remote corpus can be written
 * back in true timestamp order rather than accidental insertion order.
 */
async function replaceAllOutcomes(outcomes: StoredTradeOutcome[]): Promise<void> {
  await ensureLearningStoreReady();
  if (Platform.OS === 'web' || !db) {
    webOutcomes = outcomes.map(o => ({ ...o }));
    return;
  }
  await db.runAsync('DELETE FROM trade_outcomes');
  for (const outcome of outcomes) {
    await db.runAsync(
      'INSERT INTO trade_outcomes (ts, data) VALUES (?, ?)',
      [toTimestampMs(outcome.timestamp), JSON.stringify(outcome)],
    );
  }
}

/**
 * Merges the durable Supabase corpus into the local tier.
 *
 * - union by `signalId` (remote rows the local tier has never seen are added;
 *   a signalId already present locally is left untouched, so a local record is
 *   never clobbered by a remote copy of the same trade);
 * - the merged set is re-sorted by timestamp and rewritten, so `getAllOutcomes()`
 *   stays genuinely oldest-first after a merge;
 * - any local rows missing from the remote corpus are pushed up, so an existing
 *   on-device history is backfilled into Supabase on first run.
 *
 * Never throws — a remote failure leaves the local tier exactly as it was.
 */
export async function hydrateFromRemote(options?: { limit?: number; cap?: number }): Promise<{
  available: boolean;
  pulled: number;
  merged: number;
  /** ITEM 43(b): local rows whose stored label was corrected from the durable corpus. */
  refreshed: number;
  backfilled: number;
  total: number;
}> {
  await ensureLearningStoreReady();
  const local = await getAllOutcomes();

  if (!remoteSyncEnabled) {
    // Test seam only — deliberately NOT counted as an unavailable corpus read.
    return { available: false, pulled: 0, merged: 0, refreshed: 0, backfilled: 0, total: local.length };
  }

  // ITEM 12(d): count the attempt BEFORE the read, so an unavailable read is
  // always attributable (attempts - successes === unavailable).
  await hydrateLearningCorpusStats();
  corpusStats.hydrateAttempts += 1;

  // ITEM 12(a)(b): DIRECT, PAGINATED Supabase read via the anon key. The Rork
  // backend is NOT on this path. There is deliberately no fallback source.
  const read = await fetchRemoteOutcomesDirect(options?.limit ?? 300);
  if (!read.available) {
    corpusStats.hydrateUnavailableCount += 1;
    corpusStats.lastUnavailableReason = `${read.reason}${read.detail ? `: ${read.detail}` : ''}`;
    corpusStats.lastUnavailableAt = Date.now();
    persistCorpusStats(true);
    console.warn(
      `⚠️ [LearningStore] CORPUS_UNAVAILABLE reason=${read.reason} — keeping local corpus (${local.length} outcome(s)); the model may train on a TRUNCATED set`,
    );
    return { available: false, pulled: 0, merged: 0, refreshed: 0, backfilled: 0, total: local.length };
  }

  const remote: StoredTradeOutcome[] = read.outcomes;
  const available = true;
  corpusStats.hydrateSuccesses += 1;
  corpusStats.lastPulled = remote.length;
  corpusStats.lastPages = read.pages;
  corpusStats.lastTruncatedByLimit = read.truncatedByLimit;
  corpusStats.lastSuccessAt = Date.now();
  if (read.truncatedByLimit) {
    console.warn(
      `⚠️ [LearningStore] Corpus pull hit the limit (${remote.length}) across ${read.pages} page(s) — the durable corpus is LARGER than the pull window`,
    );
  }

  const localIds = new Set(local.map(o => o.signalId));
  const remoteById = new Map(remote.map(o => [o.signalId, o]));
  const remoteIds = new Set(remoteById.keys());
  const newFromRemote = remote.filter(o => !localIds.has(o.signalId));

  // ── ITEM 43(b) — THE DURABLE STORE IS AUTHORITATIVE ON A LABEL CONFLICT ────
  // This used to be a pure union: a signalId already present locally was left
  // untouched, on the reasoning that "a local record is never clobbered by a
  // remote copy of the same trade". That reasoning is wrong for the one case
  // that matters. `trade_outcomes_v1` is the corpus of record and is the ONLY
  // tier that can be corrected — Item 43 rewrote 17 rows there to their
  // bar-verified truth. Under the old union those corrections could never reach
  // a device that already held the stale row, so the model would keep training
  // on labels the durable store no longer agrees with, with nothing in the logs
  // to show it.
  //
  // A local row is only ever a CACHE of a durable row (learningStore's own
  // contract, see the header), so on a genuine conflict the remote value wins.
  // Local-only rows are still never discarded — they are backfilled upward
  // below, exactly as before.
  const refreshedRows: { signalId: string; from: string; to: string }[] = [];
  const reconciledLocal = local.map(o => {
    const r = remoteById.get(o.signalId);
    if (!r) return o;
    const labelChanged = r.result !== o.result;
    const rChanged = (r.realizedR ?? null) !== (o.realizedR ?? null);
    if (!labelChanged && !rChanged) return o;
    if (labelChanged) {
      refreshedRows.push({ signalId: o.signalId, from: o.result, to: r.result });
    }
    return { ...r };
  });

  let merged = 0;
  if (newFromRemote.length > 0 || refreshedRows.length > 0 || reconciledLocal.some((o, i) => o !== local[i])) {
    const cap = options?.cap ?? 500;
    const combined = [...reconciledLocal, ...newFromRemote]
      .sort((a, b) => toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp))
      .slice(-cap);
    await replaceAllOutcomes(combined);
    merged = newFromRemote.length;
  }
  if (refreshedRows.length > 0) {
    console.log(
      `🩹 [LearningStore] ${refreshedRows.length} local outcome(s) relabelled from the durable corpus: ` +
        refreshedRows.map(r => `${r.signalId.slice(-6)} ${r.from}->${r.to}`).join(', '),
    );
  }

  const missingRemotely = local.filter(o => !remoteIds.has(o.signalId));
  let backfilled = 0;
  if (missingRemotely.length > 0) {
    const pushResult = await pushOutcomesToRemote(missingRemotely);
    backfilled = pushResult.upserted;
  }

  const total = await getOutcomeCount();
  corpusStats.lastTotal = total;
  persistCorpusStats(true);
  console.log(`🔄 [LearningStore] Remote hydrate (direct Supabase, ${read.pages} page(s)): pulled ${remote.length}, merged ${merged} new, relabelled ${refreshedRows.length}, backfilled ${backfilled} local-only, total ${total}`);
  return { available, pulled: remote.length, merged, refreshed: refreshedRows.length, backfilled, total };
}

/** Delete the oldest rows beyond `cap`, keeping the most recent `cap` by insertion order. */
export async function pruneToCap(cap: number): Promise<void> {
  await ensureLearningStoreReady();
  if (Platform.OS === 'web' || !db) {
    if (webOutcomes.length > cap) webOutcomes = webOutcomes.slice(-cap);
    return;
  }
  await db.runAsync(
    'DELETE FROM trade_outcomes WHERE id NOT IN (SELECT id FROM trade_outcomes ORDER BY id DESC LIMIT ?)',
    [cap],
  );
}

/** Returns every stored outcome, oldest first (matches prior array-push ordering). */
export async function getAllOutcomes(): Promise<StoredTradeOutcome[]> {
  await ensureLearningStoreReady();
  if (Platform.OS === 'web' || !db) {
    return webOutcomes.map(o => ({ ...o }));
  }
  const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM trade_outcomes ORDER BY id ASC');
  return rows.map(r => JSON.parse(r.data) as StoredTradeOutcome);
}

export async function getOutcomeCount(): Promise<number> {
  await ensureLearningStoreReady();
  if (Platform.OS === 'web' || !db) return webOutcomes.length;
  const rows = await db.getAllAsync<{ cnt: number }>('SELECT COUNT(*) as cnt FROM trade_outcomes');
  return rows[0]?.cnt ?? 0;
}

/**
 * One-time migration path: if the SQLite store is empty but legacy
 * AsyncStorage data exists, copy every legacy outcome in (preserving order)
 * and return how many rows were migrated. Idempotent — if the store already
 * has rows (from a prior migration or fresh SQLite-native writes) this is a
 * no-op and returns 0, so it's safe to call on every app start.
 */
export async function migrateLegacyOutcomesIfEmpty(legacyOutcomes: StoredTradeOutcome[]): Promise<number> {
  await ensureLearningStoreReady();
  const existing = await getOutcomeCount();
  if (existing > 0) return 0;
  if (!Array.isArray(legacyOutcomes) || legacyOutcomes.length === 0) return 0;
  for (const outcome of legacyOutcomes) {
    await appendOutcome(outcome);
  }
  return legacyOutcomes.length;
}

/** Test-only helper: wipes all rows so migration tests start from a clean slate. */
export async function clearAllOutcomesForTest(): Promise<void> {
  await ensureLearningStoreReady();
  if (Platform.OS === 'web' || !db) {
    webOutcomes = [];
    return;
  }
  await db.runAsync('DELETE FROM trade_outcomes');
}
