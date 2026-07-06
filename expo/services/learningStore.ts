import { Platform } from 'react-native';

/**
 * Step 3 — persisted learning memory storage.
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
