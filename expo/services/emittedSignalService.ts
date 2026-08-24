/**
 * ITEM 52(b) — EMISSION PERSISTENCE.
 *
 * Corpus capture is 12.9% (51 durable rows / 396 emitted signals). Item 49
 * assumed client-side RESOLUTION was the cause. It was not. Direct interrogation
 * of the source system found no server-side record of emitted signals at all:
 *
 *   signals              PGRST205 Could not find the table 'public.signals'
 *   signals_v1           PGRST205 Could not find the table 'public.signals_v1'
 *   emitted_signals_v1   PGRST205 (before migration 004)
 *
 * The 396-signal population lives only inside a client-side diagnostics export,
 * so a replay resolver had nothing to replay. Persisting every emission is the
 * prerequisite for durable resolution.
 *
 * DESIGN: deliberately a copy of shadowSignalService.ts's proven path — anon key,
 * direct Supabase insert, fire-and-forget, in-memory success/failure counters
 * surfaced in the export. That path has written 413 rows reliably from the live
 * client since 2026-07-31, so it is the one durable client->Supabase pattern with
 * evidence behind it. No Rork backend anywhere (both API base and functions URLs
 * are confirmed 503).
 *
 * ALL calls are fire-and-forget — they must never block, delay, or alter live
 * signal generation. Callers must not await this.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Provenance of a persisted emission. Recorded at write time, never inferred. */
export type EmittedSignalSource = 'LIVE' | 'SIMULATION' | 'BACKFILL';

export interface EmittedSignalRecord {
  signalId: string;
  emittedAt: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  /** Smoothed confidence — the value the gates compared against. */
  confidence: number;
  /** ITEM 54(b): raw pre-smoothing confidence, telemetry only. */
  rawConfidence?: number | null;
  strengthDiff?: number | null;
  slMultiplier?: number | null;
  atr?: number | null;
  regime?: string | null;
  sessionName?: string | null;
  hourUtc?: number | null;
  htfTrend?: string | null;
  ltfTrend?: string | null;
  rsi?: number | null;
  /** ITEM 136(g): minutes between the zone map's last successful fetch and signal emission. NULL if TIER_0 was not used. */
  zoneMapAgeMinutes?: number | null;
  srZonesSnapshot?: unknown;
  attentionScores?: unknown;
  /**
   * ITEM 210 — entry-backing annotation: nearest opposing zone BEHIND the entry.
   * For a BUY this is the nearest RESISTANCE below entry; for a SELL the nearest
   * SUPPORT above entry. Distance in ATR units. NULL if no such zone exists.
   */
  nearestOppZoneBehindEntryPrice?: number | null;
  nearestOppZoneBehindEntryType?: 'SUPPORT' | 'RESISTANCE' | null;
  nearestOppZoneBehindEntryDistAtr?: number | null;
  /**
   * ITEM 213 — reaction-strength admission annotation: touch count of the zone
   * that actually drives the path-to-target gate (nearest opposing zone AHEAD of
   * entry). NULL if no such zone exists.
   */
  drivingZoneTouches?: number | null;
  source: EmittedSignalSource;
}

let emittedClient: SupabaseClient | null = null;
let emittedWriteFailures = 0;
let emittedWriteSuccesses = 0;

/** Emission-write failures since process start. Surfaced in the diagnostics export. */
export function getEmittedWriteFailures(): number {
  return emittedWriteFailures;
}

/** Emission-writes that landed since process start. Paired with the failure count. */
export function getEmittedWriteSuccesses(): number {
  return emittedWriteSuccesses;
}

const getEmittedClient = (): SupabaseClient | null => {
  if (emittedClient) return emittedClient;

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.log('[EmittedSignal] Supabase URL or anon key not configured — skipping durable push');
    return null;
  }

  emittedClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return emittedClient;
};

/**
 * Serialize a PostgrestError (a plain object, NOT an Error) into a readable line.
 * Without this, String(error) yields '[object Object]' and a broken write path
 * becomes invisible — the same defect the shadow service already fixed.
 */
const serializeError = (err: unknown): string => {
  if (err === null || err === undefined) return 'null';
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [`message="${e.message}"`];
    if (typeof e.code === 'string' && e.code) parts.push(`code=${e.code}`);
    if (typeof e.details === 'string' && e.details) parts.push(`details=${e.details}`);
    if (typeof e.hint === 'string' && e.hint) parts.push(`hint=${e.hint}`);
    return parts.join(' ');
  }
  try { return JSON.stringify(err); } catch { return String(err); }
};

const toRow = (r: EmittedSignalRecord): Record<string, unknown> => ({
  signal_id: r.signalId,
  emitted_at: new Date(r.emittedAt).toISOString(),
  direction: r.direction,
  entry: r.entry,
  sl: r.sl,
  tp1: r.tp1,
  tp2: r.tp2,
  tp3: r.tp3,
  confidence: r.confidence,
  raw_confidence: r.rawConfidence ?? null,
  strength_diff: r.strengthDiff ?? null,
  sl_multiplier: r.slMultiplier ?? null,
  atr: r.atr ?? null,
  regime: r.regime ?? null,
  session_name: r.sessionName ?? null,
  hour_utc: r.hourUtc ?? null,
  htf_trend: r.htfTrend ?? null,
  ltf_trend: r.ltfTrend ?? null,
  rsi: r.rsi ?? null,
  zone_map_age_minutes: r.zoneMapAgeMinutes ?? null,
  sr_zones_snapshot: (r.srZonesSnapshot ?? null) as unknown,
  attention_scores: (r.attentionScores ?? null) as unknown,
  nearest_opp_zone_behind_entry_price: r.nearestOppZoneBehindEntryPrice ?? null,
  nearest_opp_zone_behind_entry_type: r.nearestOppZoneBehindEntryType ?? null,
  nearest_opp_zone_behind_entry_dist_atr: r.nearestOppZoneBehindEntryDistAtr ?? null,
  driving_zone_touches: r.drivingZoneTouches ?? null,
  source: r.source,
});

// ── PHASE A / A1 — WRITE-PATH GUARD (drop the FIELD, never the ROW) ──────────
// Evidence (verifySchemaContractLive.ts, 2026-08-24T16:14Z): the Item 210/213
// columns did not exist in production while the code already wrote them — an
// unapplied migration would make PostgREST reject the ENTIRE insert, killing
// live signal capture (F-1 class). The guard: probe the live column set once,
// prune the row to it before sending, and on a PGRST204 "Could not find the
// column" error strip the named column and retry. A missing annotation column
// costs one measurement field; a rejected insert costs the whole row.

/** PostgREST unknown-column error, e.g.:
 *  "Could not find the 'nearest_opp_zone_behind_entry_price' column of
 *   'emitted_signals_v1' in the schema cache" */
const MISSING_COLUMN_RE = /Could not find the '([a-z0-9_]+)' column/i;

let emittedTableColumns: Set<string> | null = null;

/** Fetch the live column set once per process (select * limit 1 → keys). */
const resolveEmittedTableColumns = async (client: SupabaseClient): Promise<Set<string> | null> => {
  if (emittedTableColumns) return emittedTableColumns;
  try {
    const { data } = await client.from('emitted_signals_v1').select('*').limit(1);
    if (data && data.length > 0) {
      emittedTableColumns = new Set(Object.keys(data[0]));
      return emittedTableColumns;
    }
  } catch {
    // Fall through — probe failure is not fatal; the retry path below still guards.
  }
  return null;
};

/** Remove fields the live table lacks. Returns the pruned row and the dropped names. */
const pruneRowToLiveColumns = (
  row: Record<string, unknown>,
  columns: Set<string> | null,
): { row: Record<string, unknown>; dropped: string[] } => {
  if (!columns) return { row, dropped: [] };
  const pruned: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const key of Object.keys(row)) {
    if (columns.has(key)) {
      pruned[key] = row[key];
    } else {
      dropped.push(key);
    }
  }
  return { row: pruned, dropped };
};

/**
 * Persist an emitted signal to emitted_signals_v1. Fire-and-forget: errors are
 * counted and logged, never propagated to the caller.
 *
 * Uses upsert on signal_id (ITEM 52(e)) so a re-emission or a resolver-side
 * touch of the same signal can never create duplicate or conflicting rows.
 */
export function pushEmittedSignalRecord(record: EmittedSignalRecord): void {
  const client = getEmittedClient();
  if (!client) return;

  // ITEM 139(c): ATR range guard. The backfill atr column held values up to
  // 124.20 (impossible for 1-min gold at ~$4,400). The migration adds a CHECK
  // constraint at the DB level; this client-side guard prevents a write failure
  // from blocking the fire-and-forget path by clamping before send.
  const safeRecord: EmittedSignalRecord = {
    ...record,
    atr: record.atr !== null && record.atr !== undefined
      ? (Math.max(0, Math.min(20, record.atr)))
      : null,
  };

  void (async () => {
    try {
      const columns = await resolveEmittedTableColumns(client);
      const { row, dropped } = pruneRowToLiveColumns(toRow(safeRecord), columns);
      if (dropped.length > 0) {
        console.warn(`[EmittedSignal] A1_GUARD: dropped ${dropped.length} column(s) absent from live schema: ${dropped.join(', ')} — ROW preserved`);
      }
      // Self-healing retry: if the schema cache shifted between probe and write,
      // strip the offending column and retry. Max 5 attempts so a pathological
      // error can never loop.
      let attempt = 0;
      for (;;) {
        const { error } = await client
          .from('emitted_signals_v1')
          .upsert(row, { onConflict: 'signal_id' });
        if (!error) {
          emittedWriteSuccesses += 1;
          return;
        }
        const m = error.message.match(MISSING_COLUMN_RE);
        if (m && attempt < 5) {
          const missing = m[1];
          delete row[missing];
          attempt += 1;
          console.warn(`[EmittedSignal] A1_GUARD: column '${missing}' rejected by live schema — dropped the FIELD, retrying (attempt ${attempt}/5). ROW preserved.`);
          continue;
        }
        emittedWriteFailures += 1;
        console.warn(`[EmittedSignal] EMISSION_WRITE_FAILED (fire-and-forget): ${serializeError(error)}`);
        return;
      }
    } catch (err: unknown) {
      emittedWriteFailures += 1;
      console.warn(`[EmittedSignal] EMISSION_WRITE_ERROR (fire-and-forget): ${serializeError(err)}`);
    }
  })();
}
