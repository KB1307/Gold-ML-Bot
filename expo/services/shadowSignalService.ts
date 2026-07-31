/**
 * Shadow SELL signal service — fire-and-forget push of suppressed SELL records
 * to the durable shadow_signals_v1 Supabase table.
 *
 * DESIGN B (verified 2026-07-31): writes DIRECTLY to Supabase via the anon key
 * + RLS INSERT policy. This removes the dependency on the backend tRPC server
 * (EXPO_PUBLIC_RORK_API_BASE_URL / EXPO_PUBLIC_RORK_FUNCTIONS_URL), both of
 * which are confirmed 503 ("no bundle deployed"). The anon key is public by
 * design (already in the client bundle); the service key is NEVER shipped to
 * the browser.
 *
 * RLS policy: anon/authenticated have INSERT (WITH CHECK true) and SELECT.
 * No UPDATE/DELETE for anon — junk rows cannot modify existing data. The
 * table has a CHECK constraint enforcing direction = 'SELL'. This is
 * acceptable for a diagnostic-only table with zero operational impact on
 * signal generation or trade execution.
 *
 * When allowShortSignals is false, the engine still fully scores and geometry-
 * computes every qualifying SELL, but does NOT emit it as a live signal. This
 * service pushes the would-be signal (plus the tested +40pip/70-pip-SL/30-60-90
 * variant) to shadow_signals_v1 so the suppression decision stays monitorable
 * against real forward data.
 *
 * ALL calls are fire-and-forget — they must never block, delay, or alter
 * live signal generation. Callers should not await this.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface ShadowSellRecord {
  signalId: string;
  createdAt: number;
  direction: 'SELL';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  /** +40pip shifted entry variant (77% fill rate in counterfactual) */
  entryShifted: number;
  slShifted: number;
  tp1Shifted: number;
  tp2Shifted: number;
  tp3Shifted: number;
  slMultiplier: number;
  atr: number;
  regime: string;
  sessionName: string;
  hourUtc: number;
  srZonesSnapshot: unknown;
  attentionScores: unknown;
  htfTrend: string | null;
  ltfTrend: string | null;
  rsi: number | null;
}

/**
 * Singleton anon-key Supabase client for shadow writes.
 * Uses the PUBLIC anon key (EXPO_PUBLIC_SUPABASE_ANON_KEY) — never the
 * service key. The anon key is already in the client bundle; it's public
 * by design and guarded by RLS.
 */
let shadowClient: SupabaseClient | null = null;

/**
 * Lightweight in-memory counter of shadow-write failures since process start.
 * Incremented every time a Supabase insert fails or throws. Surfaced in the
 * diagnostics export (SECTION 6) so a broken shadow path is VISIBLE in a
 * future export rather than silent. Reset only on full app reload.
 */
let shadowWriteFailures = 0;

/**
 * Returns the number of shadow-write failures since process start.
 * Used by the diagnostics export to surface a broken write path.
 */
export function getShadowWriteFailures(): number {
  return shadowWriteFailures;
}

/**
 * Returns the number of shadow records successfully pushed since process start.
 * Paired with the failure counter so the export shows success:failure ratio.
 */
let shadowWriteSuccesses = 0;
export function getShadowWriteSuccesses(): number {
  return shadowWriteSuccesses;
}

const getShadowClient = (): SupabaseClient | null => {
  if (shadowClient) return shadowClient;

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.log('[ShadowSell] Supabase URL or anon key not configured — skipping durable push');
    return null;
  }

  shadowClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return shadowClient;
};

/**
 * Map camelCase ShadowSellRecord fields to the snake_case columns in
 * shadow_signals_v1. This mirrors the column mapping the backend tRPC
 * handler used (shadowSignals.ts), so the wire format is identical.
 */
const toRow = (r: ShadowSellRecord): Record<string, unknown> => ({
  signal_id: r.signalId,
  created_at: new Date(r.createdAt).toISOString(),
  direction: 'SELL',
  entry: r.entry,
  sl: r.sl,
  tp1: r.tp1,
  tp2: r.tp2,
  tp3: r.tp3,
  confidence: r.confidence,
  entry_shifted: r.entryShifted,
  sl_shifted: r.slShifted,
  tp1_shifted: r.tp1Shifted,
  tp2_shifted: r.tp2Shifted,
  tp3_shifted: r.tp3Shifted,
  sl_multiplier: r.slMultiplier,
  atr: r.atr,
  regime: r.regime,
  session_name: r.sessionName,
  hour_utc: r.hourUtc,
  sr_zones_snapshot: r.srZonesSnapshot as Record<string, unknown>,
  attention_scores: r.attentionScores as Record<string, unknown>,
  htf_trend: r.htfTrend,
  ltf_trend: r.ltfTrend,
  rsi: r.rsi,
});

/**
 * Push a shadow SELL record directly to shadow_signals_v1 via the anon
 * Supabase client (RLS INSERT policy). Fire-and-forget — errors are logged
 * and swallowed, never propagate to the caller.
 *
 * DESIGN B: no backend tRPC dependency. The write goes straight to Supabase
 * via the public anon key, which is RLS-permitted for INSERT on this table.
 */
/**
 * Serialize a Supabase/Postgres error (or any thrown value) into a readable
 * single-line string for the greppable warning log. Supabase's PostgrestError
 * is a plain object (NOT an Error instance), so String(error) yields
 * '[object Object]' — this extracts .message/.code/.details/.hint explicitly.
 */
const serializeShadowError = (err: unknown): string => {
  if (err === null || err === undefined) return 'null';
  if (err instanceof Error) return err.message;
  // Supabase PostgrestError shape: { message, code, details, hint, name }
  if (typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [`message="${e.message}"`];
    if (typeof e.code === 'string' && e.code) parts.push(`code=${e.code}`);
    if (typeof e.details === 'string' && e.details) parts.push(`details=${e.details}`);
    if (typeof e.hint === 'string' && e.hint) parts.push(`hint=${e.hint}`);
    return parts.join(' ');
  }
  // Last resort: stringify so we never print [object Object]
  try { return JSON.stringify(err); } catch { return String(err); }
};

export function pushShadowSellRecord(record: ShadowSellRecord): void {
  const client = getShadowClient();
  if (!client) {
    // Already logged in getShadowClient
    return;
  }

  // Fire-and-forget — the async insert runs in the background and never
  // blocks or throws to the caller. Wrap in a void IIFE so the .then/.catch
  // chain is fully self-contained and never reaches the caller.
  void (async () => {
    try {
      const { error } = await client
        .from('shadow_signals_v1')
        .insert(toRow(record));
      if (error) {
        shadowWriteFailures += 1;
        console.warn(
          `[ShadowSell] SHADOW_WRITE_FAILED (fire-and-forget): ${serializeShadowError(error)}`,
        );
      } else {
        shadowWriteSuccesses += 1;
      }
    } catch (err: unknown) {
      shadowWriteFailures += 1;
      console.warn(
        `[ShadowSell] SHADOW_WRITE_ERROR (fire-and-forget): ${serializeShadowError(err)}`,
      );
    }
  })();
}
