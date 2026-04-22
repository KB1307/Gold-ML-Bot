import { Platform } from 'react-native';

export interface OhlcBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type Timeframe = '1m' | '5m' | '1h';

const TF_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
};

const RETENTION_MS: Record<Timeframe, number> = {
  '1m': 24 * 60 * 60 * 1000,
  '5m': 3 * 24 * 60 * 60 * 1000,
  '1h': 14 * 24 * 60 * 60 * 1000,
};

const MAX_BARS: Record<Timeframe, number> = {
  '1m': 1440,
  '5m': 864,
  '1h': 336,
};

type SqliteDatabase = {
  execAsync: (sql: string) => Promise<void>;
  runAsync: (sql: string, params?: any[]) => Promise<void>;
  getAllAsync: <T = unknown>(sql: string, params?: any[]) => Promise<T[]>;
};

let db: SqliteDatabase | null = null;
let initPromise: Promise<void> | null = null;

const webStore: Record<Timeframe, OhlcBar[]> = { '1m': [], '5m': [], '1h': [] };

async function initDb(): Promise<void> {
  if (Platform.OS === 'web') return;
  if (db) return;
  try {
    const SQLite = await import('expo-sqlite');
    const opened = await SQLite.openDatabaseAsync('goldbars.db');
    db = opened as unknown as SqliteDatabase;
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS bars (
        tf TEXT NOT NULL,
        ts INTEGER NOT NULL,
        o REAL NOT NULL,
        h REAL NOT NULL,
        l REAL NOT NULL,
        c REAL NOT NULL,
        v REAL,
        PRIMARY KEY (tf, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_bars_tf_ts ON bars(tf, ts);
    `);
    console.log('🗄️ [BarStore] sqlite initialized');
  } catch (err) {
    console.warn('⚠️ [BarStore] sqlite init failed, falling back to memory:', err);
    db = null;
  }
}

export function ensureBarStoreReady(): Promise<void> {
  if (!initPromise) initPromise = initDb();
  return initPromise;
}

function floorTsTo(tf: Timeframe, ts: number): number {
  return Math.floor(ts / TF_MS[tf]) * TF_MS[tf];
}

export async function upsertBar(tf: Timeframe, bar: OhlcBar): Promise<void> {
  await ensureBarStoreReady();
  const ts = floorTsTo(tf, bar.timestamp);
  if (Platform.OS === 'web' || !db) {
    const arr = webStore[tf];
    const idx = arr.findIndex(b => b.timestamp === ts);
    if (idx >= 0) arr[idx] = { ...bar, timestamp: ts };
    else arr.push({ ...bar, timestamp: ts });
    arr.sort((a, b) => a.timestamp - b.timestamp);
    if (arr.length > MAX_BARS[tf]) webStore[tf] = arr.slice(-MAX_BARS[tf]);
    return;
  }
  try {
    await db.runAsync(
      'INSERT OR REPLACE INTO bars (tf, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tf, ts, bar.open, bar.high, bar.low, bar.close, bar.volume ?? null],
    );
  } catch (err) {
    console.warn('⚠️ [BarStore] upsertBar failed:', err);
  }
}

export async function upsertBars(tf: Timeframe, bars: OhlcBar[]): Promise<void> {
  if (bars.length === 0) return;
  await ensureBarStoreReady();
  if (Platform.OS === 'web' || !db) {
    for (const b of bars) await upsertBar(tf, b);
    return;
  }
  try {
    await db.execAsync('BEGIN');
    for (const bar of bars) {
      const ts = floorTsTo(tf, bar.timestamp);
      await db.runAsync(
        'INSERT OR REPLACE INTO bars (tf, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [tf, ts, bar.open, bar.high, bar.low, bar.close, bar.volume ?? null],
      );
    }
    await db.execAsync('COMMIT');
  } catch (err) {
    try { await db.execAsync('ROLLBACK'); } catch {}
    console.warn('⚠️ [BarStore] upsertBars failed:', err);
  }
}

export async function ingestTick(tf: Timeframe, price: number, ts: number = Date.now()): Promise<void> {
  await ensureBarStoreReady();
  const bucket = floorTsTo(tf, ts);
  if (Platform.OS === 'web' || !db) {
    const arr = webStore[tf];
    const existing = arr.find(b => b.timestamp === bucket);
    if (existing) {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
    } else {
      arr.push({ timestamp: bucket, open: price, high: price, low: price, close: price });
      arr.sort((a, b) => a.timestamp - b.timestamp);
      if (arr.length > MAX_BARS[tf]) webStore[tf] = arr.slice(-MAX_BARS[tf]);
    }
    return;
  }
  try {
    const rows = await db.getAllAsync<{ o: number; h: number; l: number }>(
      'SELECT o, h, l FROM bars WHERE tf = ? AND ts = ? LIMIT 1',
      [tf, bucket],
    );
    if (rows.length > 0) {
      const cur = rows[0];
      const h = Math.max(cur.h, price);
      const l = Math.min(cur.l, price);
      await db.runAsync(
        'UPDATE bars SET h = ?, l = ?, c = ? WHERE tf = ? AND ts = ?',
        [h, l, price, tf, bucket],
      );
    } else {
      await db.runAsync(
        'INSERT OR REPLACE INTO bars (tf, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [tf, bucket, price, price, price, price, null],
      );
    }
  } catch (err) {
    console.warn('⚠️ [BarStore] ingestTick failed:', err);
  }
}

export async function ingestTickAllTimeframes(price: number, ts: number = Date.now()): Promise<void> {
  await Promise.all([
    ingestTick('1m', price, ts),
    ingestTick('5m', price, ts),
    ingestTick('1h', price, ts),
  ]);
}

export async function getBars(tf: Timeframe, fromTs: number, toTs: number): Promise<OhlcBar[]> {
  await ensureBarStoreReady();
  if (Platform.OS === 'web' || !db) {
    return webStore[tf]
      .filter(b => b.timestamp >= fromTs && b.timestamp <= toTs)
      .map(b => ({ ...b }));
  }
  try {
    const rows = await db.getAllAsync<{ ts: number; o: number; h: number; l: number; c: number; v: number | null }>(
      'SELECT ts, o, h, l, c, v FROM bars WHERE tf = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC',
      [tf, fromTs, toTs],
    );
    return rows.map(r => ({
      timestamp: r.ts,
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v ?? undefined,
    }));
  } catch (err) {
    console.warn('⚠️ [BarStore] getBars failed:', err);
    return [];
  }
}

export async function getRecentBars(tf: Timeframe, count: number): Promise<OhlcBar[]> {
  await ensureBarStoreReady();
  if (Platform.OS === 'web' || !db) {
    return webStore[tf].slice(-count).map(b => ({ ...b }));
  }
  try {
    const rows = await db.getAllAsync<{ ts: number; o: number; h: number; l: number; c: number; v: number | null }>(
      'SELECT ts, o, h, l, c, v FROM bars WHERE tf = ? ORDER BY ts DESC LIMIT ?',
      [tf, count],
    );
    return rows
      .map(r => ({
        timestamp: r.ts,
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        volume: r.v ?? undefined,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    console.warn('⚠️ [BarStore] getRecentBars failed:', err);
    return [];
  }
}

export async function pruneOldBars(): Promise<void> {
  await ensureBarStoreReady();
  const now = Date.now();
  if (Platform.OS === 'web' || !db) {
    (Object.keys(webStore) as Timeframe[]).forEach(tf => {
      const cutoff = now - RETENTION_MS[tf];
      webStore[tf] = webStore[tf].filter(b => b.timestamp >= cutoff);
      if (webStore[tf].length > MAX_BARS[tf]) {
        webStore[tf] = webStore[tf].slice(-MAX_BARS[tf]);
      }
    });
    return;
  }
  try {
    for (const tf of Object.keys(RETENTION_MS) as Timeframe[]) {
      const cutoff = now - RETENTION_MS[tf];
      await db.runAsync('DELETE FROM bars WHERE tf = ? AND ts < ?', [tf, cutoff]);
    }
  } catch (err) {
    console.warn('⚠️ [BarStore] pruneOldBars failed:', err);
  }
}

export async function getBarStoreStats(): Promise<Record<Timeframe, { count: number; oldest: number | null; newest: number | null }>> {
  await ensureBarStoreReady();
  const out: Record<Timeframe, { count: number; oldest: number | null; newest: number | null }> = {
    '1m': { count: 0, oldest: null, newest: null },
    '5m': { count: 0, oldest: null, newest: null },
    '1h': { count: 0, oldest: null, newest: null },
  };
  if (Platform.OS === 'web' || !db) {
    (Object.keys(webStore) as Timeframe[]).forEach(tf => {
      const arr = webStore[tf];
      out[tf] = {
        count: arr.length,
        oldest: arr.length > 0 ? arr[0].timestamp : null,
        newest: arr.length > 0 ? arr[arr.length - 1].timestamp : null,
      };
    });
    return out;
  }
  try {
    for (const tf of Object.keys(out) as Timeframe[]) {
      const rows = await db.getAllAsync<{ cnt: number; mn: number | null; mx: number | null }>(
        'SELECT COUNT(*) as cnt, MIN(ts) as mn, MAX(ts) as mx FROM bars WHERE tf = ?',
        [tf],
      );
      const r = rows[0];
      if (r) out[tf] = { count: r.cnt ?? 0, oldest: r.mn ?? null, newest: r.mx ?? null };
    }
  } catch (err) {
    console.warn('⚠️ [BarStore] getBarStoreStats failed:', err);
  }
  return out;
}

export async function getLatestBarTimestamp(tf: Timeframe): Promise<number | null> {
  await ensureBarStoreReady();
  if (Platform.OS === 'web' || !db) {
    const arr = webStore[tf];
    return arr.length > 0 ? arr[arr.length - 1].timestamp : null;
  }
  try {
    const rows = await db.getAllAsync<{ mx: number | null }>(
      'SELECT MAX(ts) as mx FROM bars WHERE tf = ?',
      [tf],
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}
