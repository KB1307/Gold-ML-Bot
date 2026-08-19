// Supabase Edge Function: refresh-sr-zones
//
// Scheduled S/R zone refresh — runs the zone compute from gold_m1_bars
// and writes fresh zones to sr_zones_v1. NO Rork backend anywhere.
//
// Scheduled by pg_cron via pg_net (see migration for the schedule SQL).
// Can also be invoked manually via POST.
//
// Carries ALL three fixes from the B2 workstream:
//   (a) Reads sr_zones_v1 + gold_m1_bars DIRECTLY from Supabase (no backend).
//   (b) Paginates the bar fetch (PostgREST caps at 1000 rows per response).
//   (c) Dedupes by (price, type) before upsert, then upsert-then-prune
//       (not delete-then-insert) so a failed write leaves the cache intact.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ── Constants (mirrors expo/backend/trpc/routes/srZones.ts) ──────────────────

const LOOKBACK_HOURS = 24; // ITEM 99: 24h trailing window. Gate passed: short-horizon reversal persistence
// is positive at all three tested horizons (4h=+0.3644, 8h=+0.4117, 12h=+0.4507,
// all with tight CIs). The 120h window produced 9S/2R (dense, overlapping); 24h
// produces a more balanced 7S/10R map. User requirement.
const ZONE_STALENESS_HALF_LIFE_HOURS = 18;
const CONSUMER_THRESHOLD = 0.3;
// B22 REVERTED 2026-08-17 (CORRECTION 19). The 0.12 narrowing shipped last round is
// REMOVED for two measured reasons, both from scripts/analyzeRound3B.ts:
//
//  1. IT WAS INERT. The effective width is Math.max(atr * mult, currentPrice *
//     0.0001). At ATR 1.3421 / price ~4419 the floor is 0.4419 while atr*0.12 is
//     0.1611, so the FLOOR dominated and the narrowing never took effect. Measured:
//     the 0.30 arm and the 0.12 arm produced an IDENTICAL touchWidth of 0.4419 and
//     an identical touches-per-bar of 0.2276. Shipping 0.12 changed nothing except
//     the appearance of having acted.
//  2. ITS AUTHORIZING NUMBER IS NOT REPRODUCIBLE. B22 was derived from
//     touches-per-bar = 2.26. Recomputing over 4187 real bars gives 0.2276 — a 10x
//     disagreement. The two are not the same population (B20 scored the 22 rows in
//     the live sr_zones_v1 table; this recomputes 32 zones offline), so 2.26 is not
//     refuted — but a width constant may not rest on a number nobody can reproduce.
//
// Restored to the pre-round value. Re-deriving requires ONE touches-per-bar
// definition, over a NAMED zone population, that both paths reproduce — and the
// price-proportional floor must be lowered in the same change or any narrowing
// below atr*0.1 is inert again.
const ZONE_TOUCH_WIDTH_ATR = 0.3;
// Cluster merge stays WIDER than the touch width so nearby candidates merge into one
// zone rather than fragmenting. Retained from B22 — this half was not inert.
const CLUSTER_MERGE_WIDTH_ATR = 0.5;

type ZoneSource =
  | "PRICE_ACTION"
  | "PIVOT"
  | "PREV_DAY"
  | "ASIAN_RANGE"
  | "ORH_ORL"
  | "WEEKLY"
  | "SESSION_BLOCK";

interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface ServerSRZone {
  price: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  rejectionWicks: number;
  reactionStrength: number;
  source: ZoneSource;
  confluenceScore: number;
  lastTouchTs: string | null;
}

// ── Supabase client (inline — no external deps needed in Edge Functions) ─────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ── Paginated bar fetch (B2(b) fix) ──────────────────────────────────────────

async function fetchBarsPaginated(
  client: ReturnType<typeof createClient>,
  fromTs: string,
): Promise<Bar[]> {
  const out: Bar[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await client
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromTs)
      .order("timestamp", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Bar fetch error: ${error.message}`);
    const rows = (data ?? []) as Bar[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 200_000) break; // hard ceiling
  }
  return out;
}

// ── computeZonesFromBars (verbatim port from srZones.ts) ──────────────────────

function computeZones(bars: Bar[], now: number): ServerSRZone[] {
  if (bars.length < 50) return [];

  const highs = bars.map((b) => Number(b.high));
  const lows = bars.map((b) => Number(b.low));
  const closes = bars.map((b) => Number(b.close));
  const timestamps = bars.map((b) => new Date(b.timestamp).getTime());
  const currentPrice = closes[closes.length - 1];

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
  // B22: touch/rejection width NARROWED from atr*0.3 to atr*0.12 (derived from B20).
  const zoneWidth = Math.max(atr * ZONE_TOUCH_WIDTH_ATR, currentPrice * 0.0001);
  // B22: cluster merge width is SEPARATE and WIDER so zones don't fragment.
  const clusterMergeWidth = Math.max(atr * CLUSTER_MERGE_WIDTH_ATR, currentPrice * 0.0001);

  type Candidate = { price: number; source: ZoneSource; alwaysAdmit?: boolean };
  const candidates: Candidate[] = [];

  // Fractal swing highs/lows
  for (let i = 2; i < highs.length - 2; i++) {
    if (
      highs[i] > highs[i - 1] &&
      highs[i] > highs[i - 2] &&
      highs[i] > highs[i + 1] &&
      highs[i] > highs[i + 2]
    ) {
      candidates.push({ price: highs[i], source: "PRICE_ACTION" });
    }
  }
  for (let i = 2; i < lows.length - 2; i++) {
    if (
      lows[i] < lows[i - 1] &&
      lows[i] < lows[i - 2] &&
      lows[i] < lows[i + 1] &&
      lows[i] < lows[i + 2]
    ) {
      candidates.push({ price: lows[i], source: "PRICE_ACTION" });
    }
  }

  // Previous UTC day's H/L/O/close
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

  // Weekly high/low
  const weekMs = 7 * dayMs;
  const weekStart = now - weekMs;
  const weekIdx = timestamps
    .map((ts, i) => ({ ts, i }))
    .filter((t) => t.ts >= weekStart);
  if (weekIdx.length > 0) {
    candidates.push({
      price: Math.max(...weekIdx.map((t) => highs[t.i])),
      source: "WEEKLY",
      alwaysAdmit: true,
    });
    candidates.push({
      price: Math.min(...weekIdx.map((t) => lows[t.i])),
      source: "WEEKLY",
      alwaysAdmit: true,
    });
  }

  // Cluster candidates
  // ITEM 150: count tracks how many candidate levels merged — needed for
  // clusterScore in the corrected reactionStrength formula.
  const clustered: {
    price: number;
    source: ZoneSource;
    sources: Set<ZoneSource>;
    alwaysAdmit: boolean;
    count: number;
  }[] = [];
  for (const c of candidates) {
    const existing = clustered.find((cl) => Math.abs(cl.price - c.price) < clusterMergeWidth);
    if (existing) {
      existing.price = (existing.price + c.price) / 2;
      existing.sources.add(c.source);
      existing.alwaysAdmit = existing.alwaysAdmit || !!c.alwaysAdmit;
      existing.count += 1;
      if (c.source === "PRICE_ACTION") existing.source = c.source;
    } else {
      clustered.push({
        price: c.price,
        source: c.source,
        sources: new Set([c.source]),
        alwaysAdmit: !!c.alwaysAdmit,
        count: 1,
      });
    }
  }

  // Score each cluster
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

    // ITEM 150 FIX (2026-08-19): confluence was DOUBLE-COUNTED in the old
    // formula. It appeared as BOTH `Math.min(1, confluenceScore / 3) * 0.2`
    // AND `effectiveConfluenceBonus` (up to 0.75 for 3 sources). Total
    // confluence contribution could reach 0.95, allowing a zero-touch zone
    // with 2 wicks and confluence=3 to score RS=1.0 — maximum strength with
    // zero touch evidence. Census of the live map found 3 such zones.
    //
    // FIX: ported the local engine's weighted formula (signalEngine.ts:4241-4246)
    // which has confluence contributing ONCE (0.12 weight) and weights summing
    // to exactly 1.00. Added clusterScore (0.16 weight) which the backend was
    // missing entirely. Zero-touch zones now score at most ~0.47 (wicks +
    // confluence) instead of 1.0.
    const touchScore = Math.min(1, touches / 6);
    const rejectionScore = Math.min(1, rejectionWicks / 4);
    const avgRejectionSize = rejectionWicks > 0 ? totalRejectionSize / rejectionWicks : 0;
    const rejectionSizeScore = Math.min(1, avgRejectionSize / (atr * 0.5));
    const clusterScore = Math.min(1, cluster.count / 3);
    const confluenceScore = cluster.sources.size;
    const confluenceBonus = Math.min(1, confluenceScore * 0.25);
    const hasEarnedEvidence = touches >= 1 || rejectionWicks >= 1;
    const effectiveClusterScore = hasEarnedEvidence ? clusterScore : 0;
    const effectiveConfluenceBonus = hasEarnedEvidence ? confluenceBonus : 0;
    // Weights sum to exactly 1.00: 0.28 + 0.28 + 0.16 + 0.16 + 0.12
    const rawReactionStrength =
      (touchScore * 0.28) +
      (rejectionScore * 0.28) +
      (rejectionSizeScore * 0.16) +
      (effectiveClusterScore * 0.16) +
      (effectiveConfluenceBonus * 0.12);
    const rawLegacyReactionStrength =
      (touchScore * 0.28) +
      (rejectionScore * 0.28) +
      (rejectionSizeScore * 0.16) +
      (effectiveClusterScore * 0.16) +
      (effectiveConfluenceBonus * 0.12);

    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / (60 * 60 * 1000) : 0;
    const recencyDecayFactor = lastTouchTs > 0
      ? Math.pow(0.5, ageHours / ZONE_STALENESS_HALF_LIFE_HOURS)
      : 1;
    // ITEM 150 FIX (2026-08-19): zero-touch zones capped below 0.3 threshold.
    // See signalEngine.ts:4267 for the same fix on the local engine path.
    const uncappedRS = Math.min(1, rawReactionStrength * recencyDecayFactor);
    const uncappedLegacyRS = Math.min(1, rawLegacyReactionStrength * recencyDecayFactor);
    const reactionStrength = touches === 0 ? Math.min(uncappedRS, 0.29) : uncappedRS;
    const legacyReactionStrength = touches === 0 ? Math.min(uncappedLegacyRS, 0.29) : uncappedLegacyRS;

    if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1) {
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
      });
    }
  }

  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
  return zones.slice(0, 32);
}

// ── Dedupe by (price, type) — B2(c) fix ──────────────────────────────────────

function dedupeByPriceType(zones: ServerSRZone[]): ServerSRZone[] {
  const seen = new Map<string, ServerSRZone>();
  for (const z of zones) {
    const key = `${z.price}|${z.type}`;
    const prev = seen.get(key);
    if (!prev || z.reactionStrength > prev.reactionStrength) {
      seen.set(key, z);
    }
  }
  return [...seen.values()].sort((a, b) => b.reactionStrength - a.reactionStrength);
}

// ── Upsert-then-prune — B2(c) fix (not delete-then-insert) ───────────────────

async function upsertThenPrune(
  client: ReturnType<typeof createClient>,
  zones: ServerSRZone[],
): Promise<{ upserted: number; pruned: number; error: string | null }> {
  if (zones.length === 0) {
    console.warn("[SR-ZONES] TIER0_REFRESH_EMPTY — leaving existing cache intact");
    return { upserted: 0, pruned: 0, error: null };
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
    updated_at: runTs,
  }));

  // Upsert first — if this fails, the previous cache is left intact
  const { error: upsertError } = await client
    .from("sr_zones_v1")
    .upsert(rows, { onConflict: "price,type" });

  if (upsertError) {
    console.error(
      `[SR-ZONES] TIER0_REFRESH_WRITE_FAILED upsert: ${upsertError.message} (code=${upsertError.code ?? "-"}) — previous cache left INTACT`,
    );
    return { upserted: 0, pruned: 0, error: upsertError.message };
  }

  // Only now prune rows that this run did not refresh
  const { error: pruneError } = await client
    .from("sr_zones_v1")
    .delete()
    .lt("updated_at", runTs);

  const pruned = pruneError ? -1 : 1; // can't get exact count from PostgREST delete
  if (pruneError) {
    console.warn(`[SR-ZONES] TIER0_REFRESH_PRUNE_FAILED ${pruneError.message} — fresh zones still written`);
  }

  return { upserted: rows.length, pruned, error: null };
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();
  console.log(`[SR-ZONES] Edge function invoked at ${new Date(startTime).toISOString()}`);

  try {
    const client = getAdminClient();
    const now = Date.now();
    const fromTs = new Date(now - LOOKBACK_HOURS * 3_600_000).toISOString();

    // B2(b): Paginated fetch — must retrieve >>1000 bars
    const bars = await fetchBarsPaginated(client, fromTs);
    console.log(
      `[SR-ZONES] Fetched ${bars.length} bars from ${bars[0]?.timestamp} to ${bars[bars.length - 1]?.timestamp}`,
    );

    if (bars.length < 50) {
      console.warn(`[SR-ZONES] Not enough bars (${bars.length}) — skipping compute`);
      return new Response(
        JSON.stringify({ success: false, reason: "not-enough-bars", barCount: bars.length }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Compute zones
    const rawZones = computeZones(bars, now);
    console.log(`[SR-ZONES] Computed ${rawZones.length} raw zones`);

    // B2(c): Dedupe by (price, type)
    const deduped = dedupeByPriceType(rawZones);
    if (deduped.length !== rawZones.length) {
      console.warn(
        `[SR-ZONES] ZONE_DEDUPE_APPLIED dropped ${rawZones.length - deduped.length} duplicate(s)`,
      );
    }

    // B2(c): Upsert-then-prune
    const writeResult = await upsertThenPrune(client, deduped);
    if (writeResult.error) {
      return new Response(
        JSON.stringify({
          success: false,
          reason: "upsert-failed",
          error: writeResult.error,
          barsFetched: bars.length,
          rawZones: rawZones.length,
          dedupedZones: deduped.length,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Report how many clear the consumer threshold
    const overThreshold = deduped.filter((z) => z.reactionStrength >= CONSUMER_THRESHOLD).length;
    const lastTouchTsValues = deduped
      .map((z) => z.lastTouchTs)
      .filter((t): t is string => !!t)
      .sort();
    const minTouch = lastTouchTsValues[0] ?? null;
    const maxTouch = lastTouchTsValues[lastTouchTsValues.length - 1] ?? null;

    const elapsed = Date.now() - startTime;
    console.log(
      `[SR-ZONES] Refresh complete: ${writeResult.upserted} zones written, ${overThreshold} >= ${CONSUMER_THRESHOLD}, elapsed ${elapsed}ms`,
    );

    return new Response(
      JSON.stringify({
        success: true,
        barsFetched: bars.length,
        rawZones: rawZones.length,
        dedupedZones: deduped.length,
        upserted: writeResult.upserted,
        overThreshold,
        minLastTouchTs: minTouch,
        maxLastTouchTs: maxTouch,
        elapsedMs: elapsed,
        runAt: new Date(startTime).toISOString(),
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SR-ZONES] FATAL after ${elapsed}ms: ${msg}`);
    return new Response(
      JSON.stringify({ success: false, reason: "fatal", error: msg, elapsedMs: elapsed }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
