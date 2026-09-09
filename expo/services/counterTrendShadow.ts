/**
 * ITEM AG.2 — FORWARD INSTRUMENTATION for the counter-trend gates
 * (WRITE-ONLY telemetry; ZERO live behaviour change).
 *
 * WHY THIS EXISTS: 374 of 1,441 attempts (2026-08-31T15:25Z export, SECTION 10
 * DURABLE) died on the two counter-trend gates — COUNTER_TREND_DRIFT_VETO 307
 * (21.3%) + COUNTER_TREND_MID_RSI_UNCONFIRMED 67 (4.6%). The drift veto was
 * previously found OVER-FIRING on the short side, and has NEVER been measured
 * on BUYs. Rejected setups leave no durable record (the near-miss store is
 * 40 entries, in-memory), so "is the drift veto a gate or a leak" is
 * unanswerable from history. This module persists every counter-trend gate
 * rejection to shadow_candidates_v1 so a FORWARD book accrues under the ONE
 * canonical resolution instrument (resolveSignalWithBars fromScratch +
 * lib/evCompute computeRNet, win predicate rNet > 0) — the same instrument the
 * BAND_VETO_SUPPRESSED rows resolve through.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * ITEM AG.4 — PRE-REGISTERED PROMOTION GATE (verbatim):
 * A change to COUNTER_TREND_DRIFT_ATR_VETO or to the mid-RSI gate may be
 * proposed only when forward decided DRIFT_VETO_SUPPRESSED n >= 60 (and
 * MID_RSI_SUPPRESSED n >= 40 respectively) AND the cohort's canonical EV_net
 * 95% CI lower bound > 0 (the rejected trades would have been net winners).
 * Until then: observation only. RECOMMENDATION ONLY.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * GATE ISOLATION: strict candidate_name equality in every query. These rows
 * count toward NO existing gate: the P.3 abort counter counts ONLY
 * candidate_name = 'BAND_VETO_SUPPRESSED' rows toward n=30; the exit-ladder
 * gate counts ONLY 'EXIT_SHADOW_LADDER' rows toward n=60; never a range,
 * prefix match, or name-omitted filter.
 *
 * Fired from signalEngine at the COUNTER_TREND_DRIFT_VETO and
 * COUNTER_TREND_MID_RSI_UNCONFIRMED exit paths, fire-and-forget: the async
 * insert never blocks or throws to the caller, and a write failure NEVER
 * changes the veto outcome (the veto is applied regardless).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const DRIFT_VETO_SUPPRESSED = "DRIFT_VETO_SUPPRESSED" as const;
export const MID_RSI_SUPPRESSED = "MID_RSI_SUPPRESSED" as const;

export type CounterTrendCandidateName = typeof DRIFT_VETO_SUPPRESSED | typeof MID_RSI_SUPPRESSED;

export interface CounterTrendSuppressionInput {
  candidateName: CounterTrendCandidateName;
  direction: "BUY" | "SELL";
  evaluatedAt: number;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  inputs: Record<string, unknown>;
}

let client: SupabaseClient | null = null;
let writeSuccesses: number = 0;
let writeFailures: number = 0;

function getClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.warn("[CounterTrendShadow] Supabase URL or anon key not configured — suppressed counter-trend setup NOT persisted (veto still applied)");
    return null;
  }
  // OO.2 — distinct storageKey: this client never contends on the shared
  // GoTrue lock name (same pattern as rork-svc-shadow-signals).
  client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, storageKey: "rork-svc-counter-trend-shadow" },
  });
  return client;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Fire-and-forget durable write of ONE rejected counter-trend setup to
 * shadow_candidates_v1 (column shape copied verbatim from
 * bandProximityVeto.writeSuppressedCandidate / 'BAND_VETO_SUPPRESSED').
 */
export function writeCounterTrendSuppression(input: CounterTrendSuppressionInput): void {
  const c = getClient();
  if (!c) return;
  void (async () => {
    try {
      const { error } = await c.from("shadow_candidates_v1").insert({
        candidate_name: input.candidateName,
        evaluated_at: new Date(input.evaluatedAt).toISOString(),
        direction: input.direction,
        entry: r2(input.entry),
        sl: r2(input.sl),
        tp1: r2(input.tp1),
        tp2: r2(input.tp2),
        tp3: r2(input.tp3),
        inputs: {
          ...input.inputs,
          // ITEM DD — resolver prerequisite: the Item DA shadow resolver only
          // resolves rows carrying geometryVersion >= 2 and grades them against
          // the row's OWN flat geometry (inputs.geometry {sl, tp, timeStopBars}).
          // Without these keys the two counter-trend suppressed books
          // (DRIFT_VETO_SUPPRESSED, MID_RSI_SUPPRESSED) can never accrue decided
          // outcomes — SECTION 12 rendered them with no EV and no gate status.
          geometryVersion: 2,
          geometry: { sl: 12, tp: 10, timeStopBars: 96 },
        },
      });
      if (error) {
        writeFailures += 1;
        console.warn(`[CounterTrendShadow] WRITE_FAILED (fire-and-forget, veto still applied): ${error.message}`);
      } else {
        writeSuccesses += 1;
        console.log(`[CounterTrendShadow] ${input.candidateName} row persisted (writeSuccesses=${writeSuccesses})`);
      }
    } catch (err: unknown) {
      writeFailures += 1;
      console.warn(`[CounterTrendShadow] WRITE_ERROR (fire-and-forget, veto still applied): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

/** Write counters for the diagnostics export / round evidence. */
export function getCounterTrendShadowWriteStats(): { writeSuccesses: number; writeFailures: number } {
  return { writeSuccesses, writeFailures };
}
