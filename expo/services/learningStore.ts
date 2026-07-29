import { Platform } from 'react-native';
import { trpcClient } from '@/lib/trpc';

/**
 * Step 3 — persisted learning memory storage.
 *
 * DURABILITY UPGRADE (Supabase-backed): the local tier below (SQLite on native,
 * in-memory on web) is now a CACHE in front of the durable `trade_outcomes_v1`
 * table, reached through the backend `learning.*` tRPC routes (service-role
 * writes; the table only exposes a public SELECT policy).
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
  backfilled: number;
  total: number;
}> {
  await ensureLearningStoreReady();
  const local = await getAllOutcomes();

  if (!remoteSyncEnabled) {
    return { available: false, pulled: 0, merged: 0, backfilled: 0, total: local.length };
  }

  let remote: StoredTradeOutcome[] = [];
  let available = false;
  try {
    const response = await trpcClient.learning.getOutcomes.query({ limit: options?.limit ?? 300 });
    available = response.available;
    remote = (response.outcomes ?? []) as unknown as StoredTradeOutcome[];
  } catch (err) {
    console.warn('⚠️ [LearningStore] Remote hydrate failed, keeping local corpus:', err instanceof Error ? err.message : err);
    return { available: false, pulled: 0, merged: 0, backfilled: 0, total: local.length };
  }

  const localIds = new Set(local.map(o => o.signalId));
  const remoteIds = new Set(remote.map(o => o.signalId));
  const newFromRemote = remote.filter(o => !localIds.has(o.signalId));

  let merged = 0;
  if (newFromRemote.length > 0) {
    const cap = options?.cap ?? 500;
    const combined = [...local, ...newFromRemote]
      .sort((a, b) => toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp))
      .slice(-cap);
    await replaceAllOutcomes(combined);
    merged = newFromRemote.length;
  }

  const missingRemotely = local.filter(o => !remoteIds.has(o.signalId));
  let backfilled = 0;
  if (missingRemotely.length > 0) {
    const pushResult = await pushOutcomesToRemote(missingRemotely);
    backfilled = pushResult.upserted;
  }

  const total = await getOutcomeCount();
  console.log(`🔄 [LearningStore] Remote hydrate: pulled ${remote.length}, merged ${merged} new, backfilled ${backfilled} local-only, total ${total}`);
  return { available, pulled: remote.length, merged, backfilled, total };
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
