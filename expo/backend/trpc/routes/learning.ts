import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../create-context";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/src/integrations/supabase/types";

/**
 * DURABLE LEARNING MEMORY (server side).
 *
 * Before this route, resolved trade outcomes lived ONLY on-device:
 *   - native: expo-sqlite (`learning.db`) — durable per install, but per install
 *     only, so a second device (or a reinstall) started the model from zero;
 *   - web/preview: an in-memory array in learningStore.ts — wiped on every
 *     browser reload, which is where the engine is actually being exercised
 *     today, so the "self-learning" memory was effectively ephemeral there.
 *
 * `trade_outcomes_v1` makes the outcome corpus durable and shared across every
 * device/session. Writes go through the service-role key on the backend (the
 * table only exposes a public SELECT policy) so a client can never poison or
 * delete the training corpus directly.
 *
 * MERGE SEMANTICS: `signal_id` is the primary key and pushes are UPSERTs, so
 * re-pushing the same resolved signal is idempotent — it never duplicates a
 * row and never double-counts a trade in win-rate/expectancy.
 */

const FEATURE_SCHEMA_VERSION = 2;
const MAX_PULL_ROWS = 500;

function getServiceRoleClient() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const outcomeSchema = z.object({
  signalId: z.string().min(1),
  timestamp: z.union([z.string(), z.number()]),
  entryPrice: z.number(),
  exitPrice: z.number(),
  result: z.enum(["WIN", "LOSS"]),
  pnl: z.number(),
  confidence: z.number().optional(),
  direction: z.enum(["BUY", "SELL"]).optional(),
  realizedR: z.number().optional(),
  isScratch: z.boolean().optional(),
  signalDuration: z.number().optional(),
  features: z.unknown().optional(),
  misleadingFeatures: z.unknown().optional(),
  featureSchemaVersion: z.number().optional(),
  deviceId: z.string().optional(),
});

export type SyncableOutcome = z.infer<typeof outcomeSchema>;

function toIso(ts: string | number): string {
  const ms = typeof ts === "number" ? ts : new Date(ts).getTime();
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

export const learningRouter = createTRPCRouter({
  /** Push resolved outcomes into the durable corpus. Idempotent per signalId. */
  pushOutcomes: publicProcedure
    .input(z.object({ outcomes: z.array(outcomeSchema).max(200) }))
    .mutation(async ({ input }) => {
      const client = getServiceRoleClient();
      if (!client) {
        return { success: false, reason: "not-configured" as const, upserted: 0 };
      }
      if (input.outcomes.length === 0) {
        return { success: true, reason: "empty" as const, upserted: 0 };
      }

      const nowIso = new Date().toISOString();
      const rows = input.outcomes.map((o) => ({
        signal_id: o.signalId,
        ts: toIso(o.timestamp),
        direction: o.direction ?? null,
        result: o.result,
        entry_price: o.entryPrice,
        exit_price: o.exitPrice,
        pnl: o.pnl,
        confidence: o.confidence ?? null,
        realized_r: o.realizedR ?? null,
        is_scratch: o.isScratch ?? null,
        signal_duration_ms: o.signalDuration ?? null,
        feature_schema_version: o.featureSchemaVersion ?? FEATURE_SCHEMA_VERSION,
        features: (o.features ?? {}) as Database["public"]["Tables"]["trade_outcomes_v1"]["Insert"]["features"],
        misleading_features: (o.misleadingFeatures ?? null) as Database["public"]["Tables"]["trade_outcomes_v1"]["Insert"]["misleading_features"],
        device_id: o.deviceId ?? null,
        updated_at: nowIso,
      }));

      const { error } = await client
        .from("trade_outcomes_v1")
        .upsert(rows, { onConflict: "signal_id" });

      if (error) {
        console.error("[LEARNING] pushOutcomes upsert failed:", error.message);
        return { success: false, reason: "upsert-failed" as const, upserted: 0 };
      }

      console.log(`[LEARNING] Upserted ${rows.length} outcome(s) into trade_outcomes_v1`);
      return { success: true, reason: "ok" as const, upserted: rows.length };
    }),

  /** Pull the most recent durable outcomes, oldest-first (matches local store order). */
  getOutcomes: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(MAX_PULL_ROWS).optional() }).optional())
    .query(async ({ input }) => {
      const client = getServiceRoleClient();
      if (!client) {
        return { outcomes: [], available: false as const };
      }

      const limit = input?.limit ?? 200;
      const { data, error } = await client
        .from("trade_outcomes_v1")
        .select("*")
        .order("ts", { ascending: false })
        .limit(limit);

      if (error) {
        console.error("[LEARNING] getOutcomes failed:", error.message);
        return { outcomes: [], available: false as const };
      }

      const outcomes = (data ?? [])
        .slice()
        .reverse()
        .map((row) => ({
          signalId: row.signal_id,
          timestamp: row.ts,
          entryPrice: Number(row.entry_price),
          exitPrice: Number(row.exit_price),
          result: row.result === "WIN" ? ("WIN" as const) : ("LOSS" as const),
          pnl: Number(row.pnl),
          confidence: row.confidence === null ? 0.72 : Number(row.confidence),
          direction: (row.direction ?? undefined) as "BUY" | "SELL" | undefined,
          realizedR: row.realized_r === null ? undefined : Number(row.realized_r),
          isScratch: row.is_scratch ?? undefined,
          signalDuration: row.signal_duration_ms === null ? undefined : Number(row.signal_duration_ms),
          features: row.features,
          misleadingFeatures: row.misleading_features ?? undefined,
          featureSchemaVersion: row.feature_schema_version,
        }));

      return { outcomes, available: true as const };
    }),

  /** Corpus health: row count + newest/oldest timestamps + schema-version spread. */
  stats: publicProcedure.query(async () => {
    const client = getServiceRoleClient();
    if (!client) return { available: false as const, count: 0 };

    const { count, error: countError } = await client
      .from("trade_outcomes_v1")
      .select("signal_id", { count: "exact", head: true });

    if (countError) {
      console.error("[LEARNING] stats count failed:", countError.message);
      return { available: false as const, count: 0 };
    }

    const { data: newest } = await client
      .from("trade_outcomes_v1")
      .select("ts, feature_schema_version")
      .order("ts", { ascending: false })
      .limit(1);
    const { data: oldest } = await client
      .from("trade_outcomes_v1")
      .select("ts")
      .order("ts", { ascending: true })
      .limit(1);

    return {
      available: true as const,
      count: count ?? 0,
      newestTs: newest?.[0]?.ts ?? null,
      oldestTs: oldest?.[0]?.ts ?? null,
      newestSchemaVersion: newest?.[0]?.feature_schema_version ?? null,
    };
  }),
});
