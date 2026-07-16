import { createTRPCRouter, publicProcedure } from "../create-context";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/src/integrations/supabase/types";

/**
 * Server-side S/R zone computation + durable persistence (Option A).
 *
 * WHY THIS EXISTS: the client-only detectSRZones() in signalEngine.ts only ever
 * sees ~100 in-memory samples (reset to zero on every browser refresh), so
 * accumulated touch/reaction evidence for a level could never survive a
 * session. This route instead computes zones from the DURABLE gold_m1_bars
 * table (real Vantage MT5 bars, days of history), so the evidence itself
 * never resets - only the derived cache below is periodically recomputed.
 *
 * DESIGN: each refreshZones() call recomputes the full zone set fresh from a
 * multi-day lookback window of gold_m1_bars and replaces the sr_zones_v1
 * cache wholesale (delete-then-insert). This is intentionally simpler than
 * incremental merge-by-price-match across refreshes: since the underlying
 * bars are durable and the lookback window is wide (LOOKBACK_HOURS), touches/
 * reactionStrength are already the full accumulated picture on every
 * recompute - there is nothing incremental to preserve. What actually
 * persists across a browser refresh is the CACHE ROW ITSELF (read via
 * getZones), not any particular row's row-id.
 *
 * EXPIRY: a zone is only returned by getZones() if it was touched within
 * EXPIRY_HOURS, OR it is one of the "always structurally significant"
 * source types (PREV_DAY/ASIAN_RANGE/ORH_ORL/WEEKLY/SESSION_BLOCK/PIVOT),
 * which are recomputed fresh every refresh from the current window and are
 * never stale by construction.
 */

const LOOKBACK_HOURS = 120; // 5 days of durable M1 bars
const EXPIRY_HOURS = 96; // untouched PRICE_ACTION zones older than this are dropped at read time
const ZONE_STALENESS_HALF_LIFE_HOURS = 18; // longer half-life than the local (6h) tier - server zones represent a multi-day evidence base, so a single quiet day shouldn't halve them the way a single quiet in-memory session does locally

type ZoneSource = "PRICE_ACTION" | "PIVOT" | "PREV_DAY" | "ASIAN_RANGE" | "ORH_ORL" | "WEEKLY" | "SESSION_BLOCK";
const ALWAYS_FRESH_SOURCES = new Set<ZoneSource>(["PIVOT", "PREV_DAY", "ASIAN_RANGE", "ORH_ORL", "WEEKLY", "SESSION_BLOCK"]);

export interface ServerSRZone {
  price: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  rejectionWicks: number;
  reactionStrength: number;
  source: ZoneSource;
  confluenceScore: number;
  lastTouchTs: string | null;
}

function getServiceRoleClient() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    return null;
  }
  return createClient<Database>(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function computeZonesFromBars(): Promise<ServerSRZone[] | null> {
  const client = getServiceRoleClient();
  if (!client) {
    console.log("[SR-ZONES] Service role Supabase client not configured - skipping compute");
    return null;
  }

  const now = Date.now();
  const fromTs = new Date(now - LOOKBACK_HOURS * 60 * 60 * 1000).toISOString();

  const { data: bars, error } = await client
    .from("gold_m1_bars")
    .select("timestamp, open, high, low, close")
    .gte("timestamp", fromTs)
    .order("timestamp", { ascending: true })
    .limit(10000);

  if (error) {
    console.error("[SR-ZONES] gold_m1_bars fetch failed:", error.message);
    return null;
  }
  if (!bars || bars.length < 50) {
    console.log(`[SR-ZONES] Not enough durable bars yet (${bars?.length ?? 0}) - skipping compute`);
    return null;
  }

  const highs = bars.map((b) => Number(b.high));
  const lows = bars.map((b) => Number(b.low));
  const closes = bars.map((b) => Number(b.close));
  const timestamps = bars.map((b) => new Date(b.timestamp).getTime());
  const currentPrice = closes[closes.length - 1];

  // Real ATR14 over the M1 closes (simple true-range approximation).
  let atrSum = 0;
  let atrCount = 0;
  for (let i = Math.max(1, closes.length - 14); i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    atrSum += tr;
    atrCount++;
  }
  const atr = atrCount > 0 ? atrSum / atrCount : currentPrice * 0.001;
  const zoneWidth = Math.max(atr * 0.3, currentPrice * 0.0015);

  type Candidate = { price: number; source: ZoneSource; alwaysAdmit?: boolean };
  const candidates: Candidate[] = [];

  // Fractal swing highs/lows across the whole durable window.
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      candidates.push({ price: highs[i], source: "PRICE_ACTION" });
    }
  }
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      candidates.push({ price: lows[i], source: "PRICE_ACTION" });
    }
  }

  // Previous UTC day's H/L/O/close (structurally significant, always admitted).
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStartUtc = Math.floor(now / dayMs) * dayMs;
  const yesterdayStartUtc = todayStartUtc - dayMs;
  const yesterdayIdx = timestamps
    .map((ts, i) => ({ ts, i }))
    .filter((t) => t.ts >= yesterdayStartUtc && t.ts < todayStartUtc);
  if (yesterdayIdx.length > 0) {
    const yHigh = Math.max(...yesterdayIdx.map((t) => highs[t.i]));
    const yLow = Math.min(...yesterdayIdx.map((t) => lows[t.i]));
    const yOpen = closes[yesterdayIdx[0].i];
    const yClose = closes[yesterdayIdx[yesterdayIdx.length - 1].i];
    candidates.push({ price: yHigh, source: "PREV_DAY", alwaysAdmit: true });
    candidates.push({ price: yLow, source: "PREV_DAY", alwaysAdmit: true });
    candidates.push({ price: yOpen, source: "PREV_DAY", alwaysAdmit: true });
    const dailyPivot = (yHigh + yLow + yClose) / 3;
    const dailyRange = Math.max(yHigh - yLow, atr, currentPrice * 0.008);
    const zoneStep = dailyRange / 12;
    candidates.push({ price: dailyPivot, source: "PIVOT" });
    candidates.push({ price: yClose + zoneStep, source: "PIVOT" });
    candidates.push({ price: yClose - zoneStep, source: "PIVOT" });
  }

  // Genuine weekly high/low over the lookback window.
  const weekMs = 7 * dayMs;
  const weekStart = now - weekMs;
  const weekIdx = timestamps.map((ts, i) => ({ ts, i })).filter((t) => t.ts >= weekStart);
  if (weekIdx.length > 0) {
    candidates.push({ price: Math.max(...weekIdx.map((t) => highs[t.i])), source: "WEEKLY", alwaysAdmit: true });
    candidates.push({ price: Math.min(...weekIdx.map((t) => lows[t.i])), source: "WEEKLY", alwaysAdmit: true });
  }

  const clustered: { price: number; source: ZoneSource; sources: Set<ZoneSource>; alwaysAdmit: boolean }[] = [];
  for (const c of candidates) {
    const existing = clustered.find((cl) => Math.abs(cl.price - c.price) < zoneWidth);
    if (existing) {
      existing.price = (existing.price + c.price) / 2;
      existing.sources.add(c.source);
      existing.alwaysAdmit = existing.alwaysAdmit || !!c.alwaysAdmit;
      if (c.source === "PRICE_ACTION") existing.source = c.source;
    } else {
      clustered.push({ price: c.price, source: c.source, sources: new Set([c.source]), alwaysAdmit: !!c.alwaysAdmit });
    }
  }

  const zones: ServerSRZone[] = [];
  for (const cluster of clustered) {
    let touches = 0;
    let rejectionWicks = 0;
    let totalRejectionSize = 0;
    let lastTouchTs = 0;
    const isResistance = cluster.price > currentPrice;

    for (let i = 0; i < closes.length; i++) {
      const price = closes[i];
      const high = highs[i];
      const low = lows[i];

      if (Math.abs(price - cluster.price) < zoneWidth) {
        touches++;
        lastTouchTs = timestamps[i];
      }
      if (isResistance && high >= cluster.price - zoneWidth && price < cluster.price) {
        const wickSize = high - Math.max(price, closes[Math.max(0, i - 1)]);
        if (wickSize > zoneWidth * 0.3) {
          rejectionWicks++;
          totalRejectionSize += wickSize;
        }
      }
      if (!isResistance && low <= cluster.price + zoneWidth && price > cluster.price) {
        const wickSize = Math.min(price, closes[Math.max(0, i - 1)]) - low;
        if (wickSize > zoneWidth * 0.3) {
          rejectionWicks++;
          totalRejectionSize += wickSize;
        }
      }
    }

    const touchScore = Math.min(1, touches / 6);
    const rejectionScore = Math.min(1, rejectionWicks / 4);
    const avgRejectionSize = rejectionWicks > 0 ? totalRejectionSize / rejectionWicks : 0;
    const rejectionSizeScore = Math.min(1, avgRejectionSize / (atr * 0.5));
    const confluenceScore = cluster.sources.size;
    const confluenceBonus = Math.min(1, confluenceScore * 0.25);
    const hasEarnedEvidence = touches >= 1 || rejectionWicks >= 1;
    const effectiveConfluenceBonus = hasEarnedEvidence ? confluenceBonus : 0;
    const rawReactionStrength = Math.min(
      1,
      touchScore * 0.3 + rejectionScore * 0.3 + rejectionSizeScore * 0.2 + Math.min(1, confluenceScore / 3) * (hasEarnedEvidence ? 0.2 : 0) + effectiveConfluenceBonus,
    );

    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / (60 * 60 * 1000) : 0;
    const recencyDecayFactor = lastTouchTs > 0 ? Math.pow(0.5, ageHours / ZONE_STALENESS_HALF_LIFE_HOURS) : 1;
    const reactionStrength = Math.min(1, rawReactionStrength * recencyDecayFactor);

    if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1) {
      zones.push({
        price: parseFloat(cluster.price.toFixed(1)),
        type: isResistance ? "RESISTANCE" : "SUPPORT",
        touches,
        rejectionWicks,
        reactionStrength: parseFloat(reactionStrength.toFixed(3)),
        source: cluster.source,
        confluenceScore,
        lastTouchTs: lastTouchTs > 0 ? new Date(lastTouchTs).toISOString() : null,
      });
    }
  }

  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
  return zones.slice(0, 32);
}

async function upsertZones(zones: ServerSRZone[]): Promise<{ inserted: number } | null> {
  const client = getServiceRoleClient();
  if (!client) return null;

  // Wholesale replace: this table is a single-purpose derived cache computed
  // fresh from the durable gold_m1_bars window each refresh (see design note
  // above) - delete-then-insert avoids fragile price-drift matching across
  // refreshes while keeping the cache correct and current.
  const { error: deleteError } = await client.from("sr_zones_v1").delete().gt("id", 0);
  if (deleteError) {
    console.error("[SR-ZONES] Failed to clear stale cache:", deleteError.message);
    return null;
  }

  if (zones.length === 0) return { inserted: 0 };

  const rows = zones.map((z) => ({
    price: z.price,
    type: z.type,
    touches: z.touches,
    rejection_wicks: z.rejectionWicks,
    reaction_strength: z.reactionStrength,
    source: z.source,
    confluence_score: z.confluenceScore,
    last_touch_ts: z.lastTouchTs,
    updated_at: new Date().toISOString(),
  }));

  const { error: insertError } = await client.from("sr_zones_v1").insert(rows);
  if (insertError) {
    console.error("[SR-ZONES] Failed to insert refreshed zones:", insertError.message);
    return null;
  }
  return { inserted: rows.length };
}

export const srZonesRouter = createTRPCRouter({
  /**
   * TIER 0 read: durable, server-computed zones from gold_m1_bars, filtered
   * by the expiry rule (touched recently, or structurally always-fresh).
   */
  getZones: publicProcedure.query(async () => {
    const client = getServiceRoleClient();
    if (!client) {
      return { zones: [] as ServerSRZone[], tier: "TIER_0_SERVER" as const, available: false };
    }

    const { data, error } = await client
      .from("sr_zones_v1")
      .select("*")
      .order("reaction_strength", { ascending: false })
      .limit(32);

    if (error) {
      console.error("[SR-ZONES] getZones failed:", error.message);
      return { zones: [] as ServerSRZone[], tier: "TIER_0_SERVER" as const, available: false };
    }

    const now = Date.now();
    const zones: ServerSRZone[] = (data ?? [])
      .filter((row) => {
        const source = row.source as ZoneSource;
        if (ALWAYS_FRESH_SOURCES.has(source)) return true;
        if (!row.last_touch_ts) return false;
        const ageHours = (now - new Date(row.last_touch_ts).getTime()) / (60 * 60 * 1000);
        return ageHours <= EXPIRY_HOURS;
      })
      .map((row) => ({
        price: Number(row.price),
        type: row.type as "SUPPORT" | "RESISTANCE",
        touches: row.touches,
        rejectionWicks: row.rejection_wicks,
        reactionStrength: Number(row.reaction_strength),
        source: row.source as ZoneSource,
        confluenceScore: row.confluence_score,
        lastTouchTs: row.last_touch_ts,
      }));

    return { zones, tier: "TIER_0_SERVER" as const, available: true };
  }),

  /**
   * Recomputes zones from the durable gold_m1_bars window and refreshes the
   * sr_zones_v1 cache. Called periodically by the client (fire-and-forget,
   * throttled) rather than on a Supabase-side cron, keeping this on the
   * existing Cloudflare/Hono backend instead of adding a separate Supabase
   * Edge Function per the project's "prefer Cloudflare for code" convention.
   */
  refreshZones: publicProcedure.mutation(async () => {
    const zones = await computeZonesFromBars();
    if (zones === null) {
      return { success: false, reason: "no-data-or-not-configured" };
    }
    const result = await upsertZones(zones);
    if (!result) {
      return { success: false, reason: "upsert-failed" };
    }
    console.log(`[SR-ZONES] Refreshed cache: ${result.inserted} zone(s) computed from durable gold_m1_bars`);
    return { success: true, zoneCount: result.inserted };
  }),
});
