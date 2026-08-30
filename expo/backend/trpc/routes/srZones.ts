import { createTRPCRouter, publicProcedure } from "../create-context";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/src/integrations/supabase/types";
import { readRuntimeEnv } from "../../runtimeEnv";

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

const LOOKBACK_HOURS = 24; // ITEM 99: 24h trailing window (was 120h). Gate passed:
// short-horizon reversal persistence positive at all 3 tested horizons
// (4h=+0.3644, 8h=+0.4117, 12h=+0.4507). 24h map is more balanced (7S/10R)
// vs 120h (9S/2R). User requirement.
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
  /** B21: legacy touch-frequency-based metric, preserved for audit comparability. */
  legacyReactionStrength: number;
  source: ZoneSource;
  confluenceScore: number;
  lastTouchTs: string | null;
  /** PHASE A/A2 (ITEM 212): price of the cluster's strongest member. Equals `price` for single-member clusters. */
  strengthPrice: number;
  /** PHASE A/A2 (ITEM 212): outermost member in the risk direction (SUPPORT -> lowest, RESISTANCE -> highest). Equals `price` for single-member clusters. */
  entryEdgePrice: number;
  /** PHASE A/A3 (ITEM 191): spot-relative typing. Equals `type` while REJECTION_DIRECTED_ZONES_ENABLED is off. */
  legacyType: "SUPPORT" | "RESISTANCE";
  /** PHASE A/A3 (ITEM 191): approaches from below rejected back down (resistance behaviour). Evidence only. */
  rejectionsFromBelow: number;
  /** PHASE A/A3 (ITEM 191): approaches from above rejected back up (support behaviour). Evidence only. */
  rejectionsFromAbove: number;
}

function getServiceRoleClient() {
  const url = readRuntimeEnv("EXPO_PUBLIC_SUPABASE_URL");
  const serviceKey = readRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY");
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

  // B2(b) FIX — PostgREST caps every response at 1000 rows regardless of the
  // requested .limit(). The previous `.limit(10000)` therefore returned only
  // 1000 rows, and because the order is ASCENDING those were the OLDEST 1000
  // bars of the 120h window - the compute window ended ~103h before now, so
  // every zone's last_touch_ts was days stale and the 18h-half-life recency
  // decay crushed reactionStrength to ~0.02, far under the 0.3 threshold every
  // downstream consumer requires. Measured live: capped=1000 bars -> 0 zones
  // over 0.3; paginated=7040 bars -> 20 zones over 0.3 (max 0.902).
  // Paginate explicitly so the compute actually sees the most recent bars.
  const bars: { timestamp: string; open: number; high: number; low: number; close: number }[] = [];
  const PAGE_SIZE = 1000;
  let pageOffset = 0;
  for (;;) {
    const { data: page, error } = await client
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromTs)
      .order("timestamp", { ascending: true })
      .range(pageOffset, pageOffset + PAGE_SIZE - 1);

    if (error) {
      console.error("[SR-ZONES] gold_m1_bars fetch failed:", error.message);
      return null;
    }
    const rows = (page ?? []) as typeof bars;
    bars.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    pageOffset += PAGE_SIZE;
    // Hard ceiling: 120h of M1 bars is at most 7200 rows. This guards against
    // an unbounded loop if the range semantics ever change.
    if (pageOffset > 20000) {
      console.warn("[SR-ZONES] pagination ceiling hit at 20000 rows - stopping");
      break;
    }
  }

  if (bars.length < 50) {
    console.log(`[SR-ZONES] Not enough durable bars yet (${bars.length}) - skipping compute`);
    return null;
  }
  console.log(
    `[SR-ZONES] Fetched ${bars.length} durable bar(s) across ${Math.ceil(bars.length / PAGE_SIZE)} page(s); window ${bars[0].timestamp} -> ${bars[bars.length - 1].timestamp}`,
  );

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
  // B22 REVERTED 2026-08-17 (CORRECTION 19) — mirrors the Edge Function.
  // The atr*0.12 narrowing shipped last round was INERT: the effective width is
  // Math.max(atr * mult, currentPrice * 0.0001), and at ATR 1.3421 / price ~4419 the
  // FLOOR is 0.4419 while atr*0.12 is 0.1611, so the floor dominated. Measured in
  // scripts/analyzeRound3B.ts: the 0.30 arm and the 0.12 arm produced an IDENTICAL
  // touchWidth (0.4419) and an identical touches-per-bar (0.2276). It changed nothing.
  // Its authorizing number (touches-per-bar 2.26) also does not reproduce offline
  // (0.2276 over 4187 bars, a 10x disagreement on a different zone population).
  // Restored to the pre-round value pending ONE reproducible touches-per-bar
  // definition; any future narrowing must lower the floor in the same change.
  const atr = atrCount > 0 ? atrSum / atrCount : currentPrice * 0.001;
  const zoneWidth = Math.max(atr * 0.3, currentPrice * 0.0001);
  // Cluster merge width is SEPARATE and WIDER so zones don't fragment. Retained
  // from B22 — this half was not inert.
  const clusterMergeWidth = Math.max(atr * 0.5, currentPrice * 0.0001);

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

  // PHASE A/A2 (ITEM 212): memberPrices tracks every candidate level that
  // merged into the cluster, so strength_price and entry_edge_price can be
  // derived here too — previously only the edge function computed them, so
  // rows written via this route left those columns NULL.
  const clustered: { price: number; source: ZoneSource; sources: Set<ZoneSource>; alwaysAdmit: boolean; memberPrices: number[] }[] = [];
  for (const c of candidates) {
    const existing = clustered.find((cl) => Math.abs(cl.price - c.price) < clusterMergeWidth);
    if (existing) {
      existing.price = (existing.price + c.price) / 2;
      existing.sources.add(c.source);
      existing.alwaysAdmit = existing.alwaysAdmit || !!c.alwaysAdmit;
      existing.memberPrices.push(c.price);
      if (c.source === "PRICE_ACTION") existing.source = c.source;
    } else {
      clustered.push({ price: c.price, source: c.source, sources: new Set([c.source]), alwaysAdmit: !!c.alwaysAdmit, memberPrices: [c.price] });
    }
  }

  // PHASE A/A2 helper: per-member comparison score (cluster count = 1,
  // confluence = single source) used ONLY to pick the strongest member's
  // price. Uses THIS FILE's B21-reverted formula so the mirror stays
  // internally consistent; the zone's own reactionStrength is unchanged.
  const memberScore = (memberPrice: number, isResistance: boolean): number => {
    let touches = 0;
    let rejectionWicks = 0;
    let totalRejectionSize = 0;
    let lastTouchTs = 0;
    for (let i = 0; i < closes.length; i++) {
      const price = closes[i];
      const high = highs[i];
      const low = lows[i];
      if (Math.abs(price - memberPrice) < zoneWidth) {
        touches++;
        lastTouchTs = timestamps[i];
      }
      if (isResistance && high >= memberPrice - zoneWidth && price < memberPrice) {
        const wickSize = high - Math.max(price, closes[Math.max(0, i - 1)]);
        if (wickSize > zoneWidth * 0.3) {
          rejectionWicks++;
          totalRejectionSize += wickSize;
        }
      }
      if (!isResistance && low <= memberPrice + zoneWidth && price > memberPrice) {
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
    const hasEarnedEvidence = touches >= 1 || rejectionWicks >= 1;
    const raw = Math.min(
      1,
      touchScore * 0.3 + rejectionScore * 0.3 + rejectionSizeScore * 0.2 + Math.min(1, 1 / 3) * (hasEarnedEvidence ? 0.2 : 0) + (hasEarnedEvidence ? Math.min(1, 0.25) : 0),
    );
    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / (60 * 60 * 1000) : 0;
    const decay = lastTouchTs > 0 ? Math.pow(0.5, ageHours / ZONE_STALENESS_HALF_LIFE_HOURS) : 1;
    return Math.min(1, raw * decay);
  };

  // PHASE A/A3 helper (ITEM 191): directed rejection counts over the full
  // 24h window — same direction-agnostic wick tests as the client's
  // applyRejectionDirectedTyping(). LABEL NOTE: counts over 24h of bars, not
  // the client's ~100-sample in-memory window; never mix the instruments.
  const directedCounts = (zonePrice: number): { below: number; above: number } => {
    let below = 0;
    let above = 0;
    for (let i = 0; i < closes.length; i++) {
      const price = closes[i];
      const high = highs[i];
      const low = lows[i];
      if (high >= zonePrice - zoneWidth && price < zonePrice) {
        const wickSize = high - Math.max(price, closes[Math.max(0, i - 1)]);
        if (wickSize > zoneWidth * 0.3) below++;
      }
      if (low <= zonePrice + zoneWidth && price > zonePrice) {
        const wickSize = Math.min(price, closes[Math.max(0, i - 1)]) - low;
        if (wickSize > zoneWidth * 0.3) above++;
      }
    }
    return { below, above };
  };

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
    // B21 REVERTED 2026-08-17 (ITEM 90). Item 85 measured held-out correlations:
    //   corr(legacy reaction_strength, W2 trueRate) = +0.3613 (POSITIVE)
    //   corr(B21    reaction_strength, W2 trueRate) = +0.1612 (weaker)
    // B21's only advantage was discrimination range (0.819-0.866 vs 0.945-0.999),
    // but the engine's zoneMultiplier = Math.min(1.5, 0.8 + rs) clamps to 1.5 for
    // BOTH formulas (0.8 + 0.819 = 1.619 > 1.5), so the discrimination is unused.
    // Legacy has a better held-out correlation AND the same effective multiplier.
    // Reverted to legacy as the primary reactionStrength.
    const rawReactionStrength = Math.min(
      1,
      touchScore * 0.3 + rejectionScore * 0.3 + rejectionSizeScore * 0.2 + Math.min(1, confluenceScore / 3) * (hasEarnedEvidence ? 0.2 : 0) + effectiveConfluenceBonus,
    );
    const legacyRawReactionStrength = Math.min(
      1,
      touchScore * 0.3 + rejectionScore * 0.3 + rejectionSizeScore * 0.2 + Math.min(1, confluenceScore / 3) * (hasEarnedEvidence ? 0.2 : 0) + effectiveConfluenceBonus,
    );

    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / (60 * 60 * 1000) : 0;
    const recencyDecayFactor = lastTouchTs > 0 ? Math.pow(0.5, ageHours / ZONE_STALENESS_HALF_LIFE_HOURS) : 1;
    const reactionStrength = Math.min(1, rawReactionStrength * recencyDecayFactor);
    const legacyReactionStrength = Math.min(1, legacyRawReactionStrength * recencyDecayFactor);

    if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1) {
      // PHASE A/A2 (ITEM 212): strongest member + outermost edge.
      let strengthPrice = cluster.price;
      if (cluster.memberPrices.length > 1) {
        let bestScore = -1;
        for (const mp of cluster.memberPrices) {
          const s = memberScore(mp, isResistance);
          if (s > bestScore) {
            bestScore = s;
            strengthPrice = mp;
          }
        }
      }
      const entryEdgePrice = isResistance
        ? Math.max(...cluster.memberPrices)
        : Math.min(...cluster.memberPrices);
      // PHASE A/A3 (ITEM 191): evidence only — `type` stays spot-relative.
      const directed = directedCounts(cluster.price);
      zones.push({
        price: parseFloat(cluster.price.toFixed(1)),
        type: isResistance ? "RESISTANCE" : "SUPPORT",
        touches,
        rejectionWicks,
        reactionStrength: parseFloat(reactionStrength.toFixed(3)),
        legacyReactionStrength: parseFloat(legacyReactionStrength.toFixed(3)),
        source: cluster.source,
        confluenceScore,
        lastTouchTs: lastTouchTs > 0 ? new Date(lastTouchTs).toISOString() : null,
        strengthPrice: parseFloat(strengthPrice.toFixed(1)),
        entryEdgePrice: parseFloat(entryEdgePrice.toFixed(1)),
        legacyType: isResistance ? "RESISTANCE" : "SUPPORT",
        rejectionsFromBelow: directed.below,
        rejectionsFromAbove: directed.above,
      });
    }
  }

  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);

  // DEFECT FIX (found live, 2026-08-01): cluster prices are rounded to one
  // decimal at write time, so two distinct clusters closer than 0.05 apart
  // collapse onto the SAME (price, type) pair. sr_zones_v1 carries a UNIQUE
  // constraint on (price, type), so the wholesale insert failed with 23505
  // AFTER the delete had already run - leaving the cache EMPTY. Observed live:
  // 25 computed zones contained a duplicate (4050.5, RESISTANCE).
  // Keep the strongest zone per (price, type).
  const deduped = new Map<string, ServerSRZone>();
  for (const z of zones) {
    const key = `${z.price}|${z.type}`;
    const prev = deduped.get(key);
    if (!prev || z.reactionStrength > prev.reactionStrength) {
      deduped.set(key, z);
    }
  }
  const uniqueZones = [...deduped.values()].sort((a, b) => b.reactionStrength - a.reactionStrength);
  if (uniqueZones.length !== zones.length) {
    console.warn(
      `[SR-ZONES] ZONE_DEDUPE_APPLIED dropped ${zones.length - uniqueZones.length} duplicate (price,type) zone(s)`,
    );
  }
  return uniqueZones.slice(0, 32);
}

async function upsertZones(zones: ServerSRZone[]): Promise<{ inserted: number } | null> {
  const client = getServiceRoleClient();
  if (!client) return null;

  // DEFECT FIX (found live, 2026-08-01): the previous implementation did
  // delete-then-insert. When the insert failed for ANY reason (it failed live
  // on the (price,type) unique constraint), the delete had already committed,
  // so the cache was left EMPTY and every subsequent TIER_0 read fell back to
  // TIER_1_LOCAL micro-zones - the exact silent failure this whole workstream
  // exists to eliminate. An empty cache is strictly worse than a stale one.
  //
  // New order: UPSERT the fresh set first, and only once that has succeeded
  // delete the rows this run did not refresh. A failed write now leaves the
  // previous cache intact rather than destroying it.
  if (zones.length === 0) {
    console.warn("[SR-ZONES] TIER0_REFRESH_EMPTY compute produced 0 zones - leaving existing cache intact");
    return { inserted: 0 };
  }

  const runTs = new Date().toISOString();
  const rows = zones.map((z) => ({
    price: z.price,
    type: z.type,
    touches: z.touches,
    rejection_wicks: z.rejectionWicks,
    reaction_strength: z.reactionStrength,
    legacy_reaction_strength: z.legacyReactionStrength,
    source: z.source,
    confluence_score: z.confluenceScore,
    last_touch_ts: z.lastTouchTs,
    // PHASE A/A2 + A3 (ITEMS 212/191): the mirror now writes these too —
    // columns added live by migrations 010/012.
    strength_price: z.strengthPrice,
    entry_edge_price: z.entryEdgePrice,
    legacy_type: z.legacyType,
    rejections_from_below: z.rejectionsFromBelow,
    rejections_from_above: z.rejectionsFromAbove,
    updated_at: runTs,
  }));

  const { error: upsertError } = await client
    .from("sr_zones_v1")
    .upsert(rows, { onConflict: "price,type" });
  if (upsertError) {
    console.error(
      `[SR-ZONES] TIER0_REFRESH_WRITE_FAILED upsert failed: ${upsertError.message} (code=${upsertError.code ?? "-"}) - previous cache left INTACT`,
    );
    return null;
  }

  // Only now remove zones that this recompute did not produce.
  const { error: pruneError } = await client.from("sr_zones_v1").delete().lt("updated_at", runTs);
  if (pruneError) {
    // Non-fatal: the fresh zones are already in place; stale extras simply
    // linger until the next refresh and are filtered by the expiry rule.
    console.warn(`[SR-ZONES] TIER0_REFRESH_PRUNE_FAILED ${pruneError.message} - fresh zones still written`);
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
        // B21: legacy_reaction_strength column may not exist yet on older schema.
        // Fall back to reaction_strength so reads never break before the migration lands.
        legacyReactionStrength: Number((row as Record<string, unknown>).legacy_reaction_strength ?? row.reaction_strength),
        source: row.source as ZoneSource,
        confluenceScore: row.confluence_score,
        lastTouchTs: row.last_touch_ts,
        // PHASE A/A2 + A3 (ITEMS 212/191): read-path mapping. Columns exist live
        // (migrations 010/012, applied 2026-08-24); ?? fallbacks keep reads safe
        // against any row predating them.
        strengthPrice: Number((row as Record<string, unknown>).strength_price ?? row.price),
        entryEdgePrice: Number((row as Record<string, unknown>).entry_edge_price ?? row.price),
        legacyType:
          (row as Record<string, unknown>).legacy_type === "RESISTANCE" || (row as Record<string, unknown>).legacy_type === "SUPPORT"
            ? ((row as Record<string, unknown>).legacy_type as "SUPPORT" | "RESISTANCE")
            : (row.type as "SUPPORT" | "RESISTANCE"),
        rejectionsFromBelow: Number((row as Record<string, unknown>).rejections_from_below ?? 0),
        rejectionsFromAbove: Number((row as Record<string, unknown>).rejections_from_above ?? 0),
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
