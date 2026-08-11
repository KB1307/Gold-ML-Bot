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
  srZonesSnapshot?: unknown;
  attentionScores?: unknown;
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
  sr_zones_snapshot: (r.srZonesSnapshot ?? null) as Record<string, unknown> | null,
  attention_scores: (r.attentionScores ?? null) as Record<string, unknown> | null,
  source: r.source,
});

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

  void (async () => {
    try {
      const { error } = await client
        .from('emitted_signals_v1')
        .upsert(toRow(record), { onConflict: 'signal_id' });
      if (error) {
        emittedWriteFailures += 1;
        console.warn(`[EmittedSignal] EMISSION_WRITE_FAILED (fire-and-forget): ${serializeError(error)}`);
      } else {
        emittedWriteSuccesses += 1;
      }
    } catch (err: unknown) {
      emittedWriteFailures += 1;
      console.warn(`[EmittedSignal] EMISSION_WRITE_ERROR (fire-and-forget): ${serializeError(err)}`);
    }
  })();
}
