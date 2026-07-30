import { Platform } from 'react-native';

/**
 * Item 3 — durable, structured, on-device diagnostic event log.
 *
 * This investigation was partly blocked by ephemeral dev-log retention (the
 * runtime log stream only retains ~2h, so the client-side price reads/gate
 * decisions for a signal's exact resolution window couldn't be reconstructed
 * after the fact). Rather than depending on wider platform log retention
 * (which may not be configurable, and may not even be the stream client-side
 * resolution events flow into), this stores one row per MEANINGFUL resolution
 * event directly on-device — the same SQLite pattern already used by
 * barStore.ts (bars) and learningStore.ts (trade outcomes).
 *
 * This is ADDITIVE OBSERVABILITY ONLY: appendEvent() calls are fire-and-forget
 * and never gate, delay, or change any resolution/gating/generation decision.
 */

export type DiagnosticEventType =
  | 'PATH3_TP_CANDIDATE'
  | 'PATH3_TP_CONFIRMED'
  | 'PATH3_SL_CANDIDATE'
  | 'PATH3_SL_CONFIRMED'
  | 'LIVE_TICK_SL_CANDIDATE'
  | 'LIVE_TICK_SL_HIT'
  /**
   * STEP 2 (GC=F/spot investigation): fired whenever the bar-resolver
   * (resolveSignalWithBars) produces a terminal or changed outcome during
   * catch-up reconciliation or an audit pass -- records which real bar
   * source/instrument fed the decision (see detail.barSource) so a future
   * investigation never again has to reverse-engineer this from indirect
   * evidence.
   */
  | 'RESOLUTION_OUTCOME'
  /**
   * STEP 2: fired on every real OHLC refresh in LIVE GENERATION (throttled to
   * once/60s, matching fetchAndUpdateOHLCHistory's own throttle) -- records
   * which instrument/tier actually fed highHistory/lowHistory/barCloseHistory
   * for this cycle (see detail.ohlcSourceDetail). Not tied to a specific
   * signal, so signalId uses the '__generation__' sentinel.
   */
  | 'GENERATION_OHLC_SOURCE'
  /**
   * SELL suppression: fired when a qualifying SELL is suppressed by
   * allowShortSignals=false. The durable record of truth is the
   * shadow_signals_v1 Supabase table; this event provides a local
   * in-memory trace for the rolling 24h diagnostic log.
   */
  | 'SHADOW_SELL_SUPPRESSED';

export interface DiagnosticEvent {
  ts: number;
  signalId: string;
  eventType: DiagnosticEventType;
  price: number;
  detail?: Record<string, unknown>;
}

// Rolling 24h window — matches the daily audit sweep's own cadence, and this
// system is "somewhat HFT" (many signals/day), so anything worth catching
// should be catchable within a day, same reasoning as barStore.ts's retention.
const RETENTION_MS = 24 * 60 * 60 * 1000;
// Row cap mirrors barStore.ts's MAX_BARS pattern — a generous ceiling so a
// pathological burst of events can't grow storage unbounded even if the time
// based prune is delayed for some reason.
const MAX_ROWS = 20_000;

type SqliteDatabase = {
  execAsync: (sql: string) => Promise<void>;
  runAsync: (sql: string, params?: unknown[]) => Promise<void>;
  getAllAsync: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
};

let db: SqliteDatabase | null = null;
let initPromise: Promise<void> | null = null;

// Web (and any environment without expo-sqlite) falls back to an in-memory
// array, mirroring barStore.ts/learningStore.ts's webStore pattern.
let webEvents: DiagnosticEvent[] = [];

async function initDb(): Promise<void> {
  if (Platform.OS === 'web') return;
  if (db) return;
  try {
    const SQLite = await import('expo-sqlite');
    const opened = await SQLite.openDatabaseAsync('diagnostic_events.db');
    db = opened as unknown as SqliteDatabase;
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS resolution_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        signal_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        price REAL NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_resolution_events_ts ON resolution_events(ts);
      CREATE INDEX IF NOT EXISTS idx_resolution_events_signal ON resolution_events(signal_id);
    `);
    console.log('🗄️ [DiagnosticEventStore] sqlite initialized');
  } catch (err) {
    console.warn('⚠️ [DiagnosticEventStore] sqlite init failed, falling back to memory:', err);
    db = null;
  }
}

export function ensureDiagnosticEventStoreReady(): Promise<void> {
  if (!initPromise) initPromise = initDb();
  return initPromise;
}

/**
 * Append one diagnostic event row. Fire-and-forget by design (callers should
 * `.catch()` and never `await` in a way that blocks a resolution decision) —
 * this must never be able to slow down or alter live gating/generation.
 */
export async function appendDiagnosticEvent(event: DiagnosticEvent): Promise<void> {
  await ensureDiagnosticEventStoreReady();
  if (Platform.OS === 'web' || !db) {
    webEvents.push(event);
    if (webEvents.length > MAX_ROWS) webEvents = webEvents.slice(-MAX_ROWS);
    return;
  }
  try {
    await db.runAsync(
      'INSERT INTO resolution_events (ts, signal_id, event_type, price, detail) VALUES (?, ?, ?, ?, ?)',
      [event.ts, event.signalId, event.eventType, event.price, event.detail ? JSON.stringify(event.detail) : null],
    );
  } catch (err) {
    console.warn('⚠️ [DiagnosticEventStore] appendDiagnosticEvent failed:', err);
  }
}

/** Delete rows older than the rolling 24h retention window, then enforce the row cap. */
export async function pruneOldDiagnosticEvents(): Promise<void> {
  await ensureDiagnosticEventStoreReady();
  const cutoff = Date.now() - RETENTION_MS;
  if (Platform.OS === 'web' || !db) {
    webEvents = webEvents.filter(e => e.ts >= cutoff);
    if (webEvents.length > MAX_ROWS) webEvents = webEvents.slice(-MAX_ROWS);
    return;
  }
  try {
    await db.runAsync('DELETE FROM resolution_events WHERE ts < ?', [cutoff]);
    await db.runAsync(
      'DELETE FROM resolution_events WHERE id NOT IN (SELECT id FROM resolution_events ORDER BY id DESC LIMIT ?)',
      [MAX_ROWS],
    );
  } catch (err) {
    console.warn('⚠️ [DiagnosticEventStore] pruneOldDiagnosticEvents failed:', err);
  }
}

/** Returns every stored event within the retention window, newest first. */
export async function getRecentDiagnosticEvents(limit: number = 500): Promise<DiagnosticEvent[]> {
  await ensureDiagnosticEventStoreReady();
  const cutoff = Date.now() - RETENTION_MS;
  if (Platform.OS === 'web' || !db) {
    return webEvents
      .filter(e => e.ts >= cutoff)
      .slice(-limit)
      .reverse()
      .map(e => ({ ...e }));
  }
  try {
    const rows = await db.getAllAsync<{ ts: number; signal_id: string; event_type: DiagnosticEventType; price: number; detail: string | null }>(
      'SELECT ts, signal_id, event_type, price, detail FROM resolution_events WHERE ts >= ? ORDER BY id DESC LIMIT ?',
      [cutoff, limit],
    );
    return rows.map(r => ({
      ts: r.ts,
      signalId: r.signal_id,
      eventType: r.event_type,
      price: r.price,
      detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : undefined,
    }));
  } catch (err) {
    console.warn('⚠️ [DiagnosticEventStore] getRecentDiagnosticEvents failed:', err);
    return [];
  }
}

export async function getDiagnosticEventCount(): Promise<number> {
  await ensureDiagnosticEventStoreReady();
  if (Platform.OS === 'web' || !db) return webEvents.length;
  try {
    const rows = await db.getAllAsync<{ cnt: number }>('SELECT COUNT(*) as cnt FROM resolution_events');
    return rows[0]?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/** Test-only helper: wipes all rows so tests start from a clean slate. */
export async function clearAllDiagnosticEventsForTest(): Promise<void> {
  await ensureDiagnosticEventStoreReady();
  if (Platform.OS === 'web' || !db) {
    webEvents = [];
    return;
  }
  try {
    await db.runAsync('DELETE FROM resolution_events');
  } catch (err) {
    console.warn('⚠️ [DiagnosticEventStore] clearAllDiagnosticEventsForTest failed:', err);
  }
}
