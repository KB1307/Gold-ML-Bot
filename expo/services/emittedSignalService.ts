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

// ── ITEM 225 / B5 — STARTUP SCHEMA ASSERTION (the complement of the A1 guard) ──
//
// The A1 write-path guard above keeps the ROW alive when a column is missing, by
// dropping the FIELD. That is the right trade at write time, but it is SILENT:
// the Item 210/213 columns were dropped from every insert for ~8 hours on
// 2026-08-24 and the only trace was a console.warn nobody was watching, while
// three live emissions went missing (Item 225: signal_1787083581937_xr6mjtadq,
// signal_1787580401459_cpid69ppf, signal_1787587872040_446kz8aab).
//
// THE ITEM 149 FAILURE MODE, AVOIDED. The previous schema guard compared the DB
// against a HAND-MAINTAINED column list, so when code and DB drifted together
// away from that list it printed PASS for days. Here the expected set is derived
// from `toRow()` ITSELF, by calling it on a synthetic probe record and taking its
// keys. A column added to the code without the DB (or removed from the DB) is
// therefore caught by construction — the assertion cannot go stale, because it
// has no list of its own to fall behind.
//
// This is a READ plus logging only. It never blocks boot, never throws into the
// caller, and never writes: a broken assertion must not be able to stop live
// signal generation, which is the failure class it exists to protect.

/** Result of the boot-time schema assertion, surfaced in the diagnostics export. */
export interface EmittedSchemaAssertion {
  ok: boolean;
  checkedAt: string;
  /** Columns toRow() writes that the LIVE table does not have — these get dropped at write time. */
  missingInDb: string[];
  /** Columns the LIVE table has that toRow() never writes — informational, not a failure. */
  unwrittenInCode: string[];
  /** Set when the probe itself could not run (offline, RLS, empty table). */
  probeError: string | null;
}

let lastSchemaAssertion: EmittedSchemaAssertion | null = null;

/** Read-only accessor for the diagnostics export. Null until the assertion runs. */
export function getEmittedSchemaAssertion(): EmittedSchemaAssertion | null {
  return lastSchemaAssertion;
}

/**
 * A synthetic record used ONLY to enumerate toRow()'s key set. Never inserted.
 * Every optional field is given a value so no key can be omitted by a `??` path.
 */
const SCHEMA_PROBE_RECORD: EmittedSignalRecord = {
  signalId: '__schema_probe__',
  emittedAt: 0,
  direction: 'BUY',
  entry: 0, sl: 0, tp1: 0, tp2: 0, tp3: 0,
  confidence: 0,
  rawConfidence: 0,
  strengthDiff: 0,
  slMultiplier: 0,
  atr: 0,
  regime: '',
  sessionName: '',
  hourUtc: 0,
  htfTrend: '',
  ltfTrend: '',
  rsi: 0,
  zoneMapAgeMinutes: 0,
  srZonesSnapshot: null,
  attentionScores: null,
  nearestOppZoneBehindEntryPrice: 0,
  nearestOppZoneBehindEntryType: 'SUPPORT',
  nearestOppZoneBehindEntryDistAtr: 0,
  drivingZoneTouches: 0,
  source: 'LIVE',
};

/**
 * Assert at startup that the LIVE emitted_signals_v1 column set can accept every
 * field this code writes. Fire-and-forget: call it and do not await.
 *
 * Fails LOUDLY (console.error banner) rather than silently, because the silent
 * version of this check is exactly what cost three live emissions.
 */
export async function assertEmittedSchemaContract(): Promise<EmittedSchemaAssertion> {
  const checkedAt = new Date().toISOString();
  const expected = Object.keys(toRow(SCHEMA_PROBE_RECORD));
  const client = getEmittedClient();
  if (!client) {
    lastSchemaAssertion = { ok: false, checkedAt, missingInDb: [], unwrittenInCode: [], probeError: 'Supabase client unavailable (URL or anon key not configured)' };
    console.warn('[EmittedSignal] B5_SCHEMA_ASSERTION SKIPPED — Supabase not configured; emission persistence is OFF entirely.');
    return lastSchemaAssertion;
  }
  try {
    // select('*') limit 1 is the same probe the write-path guard uses, so the
    // assertion sees exactly what the guard will see.
    const { data, error } = await client.from('emitted_signals_v1').select('*').limit(1);
    if (error) {
      lastSchemaAssertion = { ok: false, checkedAt, missingInDb: [], unwrittenInCode: [], probeError: error.message };
      console.error(`[EmittedSignal] B5_SCHEMA_ASSERTION INCONCLUSIVE — live probe failed: ${error.message}. Treating as NOT verified.`);
      return lastSchemaAssertion;
    }
    if (!data || data.length === 0) {
      lastSchemaAssertion = { ok: false, checkedAt, missingInDb: [], unwrittenInCode: [], probeError: 'table empty — column set not observable via select *' };
      console.warn('[EmittedSignal] B5_SCHEMA_ASSERTION INCONCLUSIVE — emitted_signals_v1 is empty, so its columns cannot be enumerated this way.');
      return lastSchemaAssertion;
    }
    const live = new Set(Object.keys(data[0]));
    const missingInDb = expected.filter(k => !live.has(k));
    const unwrittenInCode = Array.from(live).filter(k => !expected.includes(k));
    const ok = missingInDb.length === 0;
    lastSchemaAssertion = { ok, checkedAt, missingInDb, unwrittenInCode, probeError: null };
    if (!ok) {
      console.error('='.repeat(78));
      console.error('[EmittedSignal] B5_SCHEMA_ASSERTION FAILED — CODE WRITES COLUMNS THE LIVE DB LACKS');
      console.error(`  missing in DB (${missingInDb.length}): ${missingInDb.join(', ')}`);
      console.error('  Consequence: the A1 write-path guard will DROP these fields from every insert.');
      console.error('  The ROW survives, so signal capture continues, but these measurements are being');
      console.error('  lost RIGHT NOW. An unapplied migration is the likely cause (see Item 225).');
      console.error('='.repeat(78));
    } else {
      console.log(`[EmittedSignal] B5_SCHEMA_ASSERTION PASS — all ${expected.length} written columns exist in the live schema${unwrittenInCode.length > 0 ? `; ${unwrittenInCode.length} live column(s) not written by this code: ${unwrittenInCode.join(', ')}` : ''}`);
    }
    return lastSchemaAssertion;
  } catch (err: unknown) {
    lastSchemaAssertion = { ok: false, checkedAt, missingInDb: [], unwrittenInCode: [], probeError: serializeError(err) };
    console.error(`[EmittedSignal] B5_SCHEMA_ASSERTION ERROR: ${serializeError(err)}`);
    return lastSchemaAssertion;
  }
}

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

      // ── ITEM A.2 / CHECKPOINT A.2 — WRITE-ONLY fade annotation ────────────
      // PRE-REGISTERED FORWARD GATE (must never drift): the fade condition may be
      // proposed as a LIVE FILTER only when, on signals emitted AFTER this
      // instrumentation ships (genuinely forward, not the historical sample), the
      // FADE cohort reaches n>=50 AND its EV_net 95% CI upper bound sits below the
      // WITH cohort's EV_net point estimate. Until then it is an observation,
      // NOT a lever.
      // Data-source rule: computed from gold_m1_bars ONLY (never priceHistory /
      // Yahoo GC=F / TwelveData). Bars unavailable -> NULL, never a default. The
      // engine emits byte-identically: this value is persisted and read by NOTHING
      // in any gating/scoring path this round (grep-verifiable).
      try {
        const ems = new Date(safeRecord.emittedAt).getTime();
        const { data: annBars } = await client.from('gold_m1_bars')
          .select('timestamp, close')
          .gte('timestamp', new Date(ems - 5 * 3600_000).toISOString())
          .lt('timestamp', new Date(ems).toISOString())
          .order('timestamp', { ascending: true }).limit(250);
        const ann = ((annBars ?? []) as { timestamp: string; close: number }[])
          .map(b => ({ ts: new Date(b.timestamp).getTime(), c: Number(b.close) }));
        if (ann.length >= 150) {
          let base = ann[0];
          for (const b of ann) {
            if (b.ts <= ann[ann.length - 1].ts - 4 * 3600_000) base = b; else break;
          }
          const delta = Math.round((ann[ann.length - 1].c - base.c) * 100) / 100;
          row.agrees_with_prior_4h_move = safeRecord.direction === 'BUY' ? delta > 0 : delta < 0;
          row.prior_4h_move_delta = delta;
          // ITEM I: pre_signal_drift — prior-4h close-vs-close drift $ figure
          // (the basis the telemetry drift display reports), persisted at emission.
          row.pre_signal_drift = delta;
          // ITEM I: chase_position — entry position in the running intraday range
          // (0=at low, 1=at high), close-based; NULL if range < $3. Forward labels
          // for the at-extreme class instead of re-litigating in-sample trades.
          const dayStartI = Date.UTC(new Date(ems).getUTCFullYear(), new Date(ems).getUTCMonth(), new Date(ems).getUTCDate());
          const dayCloses = ann.filter(b => b.ts >= dayStartI).map(b => b.c);
          if (dayCloses.length >= 30) {
            const dHi = Math.max(...dayCloses), dLo = Math.min(...dayCloses);
            row.chase_position = dHi - dLo >= 3 ? Math.round(((ann[ann.length - 1].c - dLo) / (dHi - dLo)) * 1000) / 1000 : null;
          } else row.chase_position = null;
        } else {
          row.agrees_with_prior_4h_move = null;
          row.prior_4h_move_delta = null;
          row.pre_signal_drift = null;
          row.chase_position = null;
        }
        // ITEM I + E.2-SHADOW: snapshot-derived annotations (write-only; the E.2
        // live gate FAILED 2026-08-27 — vetoed-cohort CI upper > 0 — so the band
        // veto ships as observation ONLY, never a filter).
        const snapZones = (Array.isArray(safeRecord.srZonesSnapshot) ? safeRecord.srZonesSnapshot : []) as { price: number; type?: string; touches?: number; reactionStrength?: number }[];
        if (snapZones.length > 0) {
          const opp = snapZones.filter(z => (safeRecord.direction === 'BUY' ? z.type === 'RESISTANCE' : z.type === 'SUPPORT')).length;
          row.opposing_zone_fraction = Math.round((opp / snapZones.length) * 1000) / 1000;
          const tp1d = Math.abs(Number(safeRecord.tp1) - Number(safeRecord.entry));
          const blo = safeRecord.direction === 'BUY' ? Number(safeRecord.entry) - 1.0 : Number(safeRecord.entry) - tp1d;
          const bhi = safeRecord.direction === 'BUY' ? Number(safeRecord.entry) + tp1d : Number(safeRecord.entry) + 1.0;
          const hit = snapZones.find(z => Number(z.touches) >= 10 && Number(z.reactionStrength) >= 0.5 && Number(z.price) >= blo && Number(z.price) <= bhi);
          row.band_veto_would_fire = !!hit;
          row.band_veto_zone_price = hit ? Number(hit.price) : null;
        } else {
          row.opposing_zone_fraction = null;
          row.band_veto_would_fire = null;
          row.band_veto_zone_price = null;
        }
      } catch (annErr: unknown) {
        console.warn(`[EmittedSignal] A2 annotation unavailable -> NULL (write-only): ${annErr instanceof Error ? annErr.message : String(annErr)}`);
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
