import * as z from "zod";
import { createTRPCRouter, publicProcedure } from "../create-context";
import { createClient } from "@supabase/supabase-js";

/**
 * Shadow SELL signal routes — durable persistence of suppressed SELL signals.
 *
 * When allowShortSignals is false, the engine still fully scores and geometry-
 * computes every qualifying SELL but does NOT emit it. This route stores the
 * would-be signal in shadow_signals_v1 (service-role writes, RLS SELECT-only
 * for anon/authenticated) so the suppression decision stays monitorable.
 */

function getServiceRoleClient() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const shadowRecordSchema = z.object({
  signalId: z.string(),
  createdAt: z.number(),
  direction: z.literal('SELL'),
  entry: z.number(),
  sl: z.number(),
  tp1: z.number(),
  tp2: z.number(),
  tp3: z.number(),
  confidence: z.number(),
  entryShifted: z.number(),
  slShifted: z.number(),
  tp1Shifted: z.number(),
  tp2Shifted: z.number(),
  tp3Shifted: z.number(),
  slMultiplier: z.number(),
  atr: z.number(),
  regime: z.string(),
  sessionName: z.string(),
  hourUtc: z.number(),
  srZonesSnapshot: z.unknown(),
  attentionScores: z.unknown(),
  htfTrend: z.string().nullable(),
  ltfTrend: z.string().nullable(),
  rsi: z.number().nullable(),
});

export const shadowRouter = createTRPCRouter({
  /**
   * Push a shadow SELL record. Service-role write (fire-and-forget from client).
   */
  push: publicProcedure
    .input(z.object({ json: shadowRecordSchema }))
    .mutation(async ({ input }) => {
      const client = getServiceRoleClient();
      if (!client) {
        return { ok: false as const, error: 'service role not configured' };
      }
      const r = input.json;
      const { error } = await client.from('shadow_signals_v1').insert({
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
      if (error) {
        console.error('[ShadowSignals] insert failed:', error.message);
        return { ok: false as const, error: error.message };
      }
      return { ok: true as const };
    }),

  /**
   * Recent shadow SELL records (newest first, limited count).
   */
  recent: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(100).default(10) }))
    .query(async ({ input }) => {
      const client = getServiceRoleClient();
      if (!client) return [];
      const { data, error } = await client
        .from('shadow_signals_v1')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(input.limit);
      if (error) {
        console.error('[ShadowSignals] recent query failed:', error.message);
        return [];
      }
      return data ?? [];
    }),

  /**
   * Summary statistics for the diagnostics export shadow-SELL section.
   */
  summary: publicProcedure
    .input(z.object({ days: z.number().min(1).max(90).default(30) }))
    .query(async ({ input }) => {
      const client = getServiceRoleClient();
      if (!client) {
        return { count: 0, dateRange: null, sessionBreakdown: {}, htfBreakdown: {}, avgGeometry: null, recent: [] };
      }
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await client
        .from('shadow_signals_v1')
        .select('created_at, session_name, hour_utc, htf_trend, entry, sl, tp1, tp2, tp3, atr, confidence, regime')
        .gte('created_at', since)
        .order('created_at', { ascending: false });
      if (error) {
        console.error('[ShadowSignals] summary query failed:', error.message);
        return { count: 0, dateRange: null, sessionBreakdown: {}, htfBreakdown: {}, avgGeometry: null, recent: [] };
      }
      const rows = data ?? [];
      if (rows.length === 0) {
        return { count: 0, dateRange: null, sessionBreakdown: {}, htfBreakdown: {}, avgGeometry: null, recent: [] };
      }

      const sessionBreakdown: Record<string, number> = {};
      const htfBreakdown: Record<string, number> = {};
      let sumEntry = 0, sumSl = 0, sumTp1 = 0, sumTp2 = 0, sumTp3 = 0, sumAtr = 0, sumConf = 0;
      for (const r of rows) {
        const s = r.session_name as string;
        sessionBreakdown[s] = (sessionBreakdown[s] ?? 0) + 1;
        const h = (r.htf_trend as string) ?? 'UNKNOWN';
        htfBreakdown[h] = (htfBreakdown[h] ?? 0) + 1;
        sumEntry += Number(r.entry);
        sumSl += Number(r.sl);
        sumTp1 += Number(r.tp1);
        sumTp2 += Number(r.tp2);
        sumTp3 += Number(r.tp3);
        sumAtr += Number(r.atr);
        sumConf += Number(r.confidence);
      }
      const n = rows.length;
      const oldest = rows[rows.length - 1].created_at as string;
      const newest = rows[0].created_at as string;

      return {
        count: n,
        dateRange: { oldest, newest },
        sessionBreakdown,
        htfBreakdown,
        avgGeometry: {
          entry: sumEntry / n,
          sl: sumSl / n,
          tp1: sumTp1 / n,
          tp2: sumTp2 / n,
          tp3: sumTp3 / n,
          atr: sumAtr / n,
          confidence: sumConf / n,
        },
        recent: rows.slice(0, 10),
      };
    }),
});
