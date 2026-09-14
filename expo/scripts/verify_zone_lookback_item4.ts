/**
 * ITEM 4 (five-fix prompt, 2026-09-14) — offline acceptance for the zone
 * lookback extension 24h → 96h.
 *
 * Runs the refresh-sr-zones edge function's EXACT zone computation offline
 * (verbatim mirror of backend/functions/refresh-sr-zones/index.ts @ the ITEM 4
 * edit) at BOTH lookbacks against TIER 0 gold_m1_bars (anon key):
 *   - per-page fetch counts (pagination evidence: 96h ≈ 5,760 bars = 6 pages),
 *   - zone count + over-threshold count at 24h vs 96h,
 *   - full zone maps for comparison,
 *   - which 48–72h-old zones survive the decay + CONSUMER_THRESHOLD cut.
 *
 * MEASUREMENT ONLY — this script writes NOTHING (no sr_zones_v1 upsert/prune).
 * The deployed edge function itself picks up LOOKBACK_HOURS = 96 on its next
 * deploy; this harness is the acceptance evidence.
 * Run: cd expo && bun scripts/verify_zone_lookback_item4.ts
 */
import { createClient } from "@supabase/supabase-js";

// ── VERBATIM constants (backend/functions/refresh-sr-zones/index.ts) ─────────
const ZONE_STALENESS_HALF_LIFE_HOURS = 18;
const CONSUMER_THRESHOLD = 0.3;
const ZONE_TOUCH_WIDTH_ATR = 0.3;
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
  legacyReactionStrength: number;
  source: ZoneSource;
  confluenceScore: number;
  lastTouchTs: string | null;
  strengthPrice: number;
  entryEdgePrice: number;
  legacyType: "SUPPORT" | "RESISTANCE";
  rejectionsFromBelow: number;
  rejectionsFromAbove: number;
}

type Client = ReturnType<typeof createClient>;

// ── VERBATIM paginated fetch (anon client instead of the service-role one) ──
async function fetchBarsPaginated(
  client: Client,
  fromTs: string,
  pageLog: number[],
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
    pageLog.push(rows.length);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 200_000) break; // hard ceiling
  }
  return out;
}

// ── VERBATIM computeZones (mirror of the edge function @ the ITEM 4 edit) ────
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
  const zoneWidth = Math.max(atr * ZONE_TOUCH_WIDTH_ATR, currentPrice * 0.0001);
  const clusterMergeWidth = Math.max(atr * CLUSTER_MERGE_WIDTH_ATR, currentPrice * 0.0001);

  type Candidate = { price: number; source: ZoneSource; alwaysAdmit?: boolean };
  const candidates: Candidate[] = [];

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

  const clustered: {
    price: number;
    source: ZoneSource;
    sources: Set<ZoneSource>;
    alwaysAdmit: boolean;
    count: number;
    memberPrices: number[];
  }[] = [];
  for (const c of candidates) {
    const existing = clustered.find((cl) => Math.abs(cl.price - c.price) < clusterMergeWidth);
    if (existing) {
      existing.price = (existing.price + c.price) / 2;
      existing.sources.add(c.source);
      existing.alwaysAdmit = existing.alwaysAdmit || !!c.alwaysAdmit;
      existing.count += 1;
      existing.memberPrices.push(c.price);
      if (c.source === "PRICE_ACTION") existing.source = c.source;
    } else {
      clustered.push({
        price: c.price,
        source: c.source,
        sources: new Set([c.source]),
        alwaysAdmit: !!c.alwaysAdmit,
        count: 1,
        memberPrices: [c.price],
      });
    }
  }

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
    const raw =
      (touchScore * 0.28) +
      (rejectionScore * 0.28) +
      (rejectionSizeScore * 0.16) +
      (hasEarnedEvidence ? Math.min(1, 1 / 3) * 0.16 : 0) +
      (hasEarnedEvidence ? Math.min(1, 0.25) * 0.12 : 0);
    const ageHours = lastTouchTs > 0 ? Math.max(0, now - lastTouchTs) / (60 * 60 * 1000) : 0;
    const decay = lastTouchTs > 0 ? Math.pow(0.5, ageHours / ZONE_STALENESS_HALF_LIFE_HOURS) : 1;
    const uncapped = Math.min(1, raw * decay);
    return touches === 0 ? Math.min(uncapped, 0.29) : uncapped;
  };

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
    const clusterScore = Math.min(1, cluster.count / 3);
    const confluenceScore = cluster.sources.size;
    const confluenceBonus = Math.min(1, confluenceScore * 0.25);
    const hasEarnedEvidence = touches >= 1 || rejectionWicks >= 1;
    const effectiveClusterScore = hasEarnedEvidence ? clusterScore : 0;
    const effectiveConfluenceBonus = hasEarnedEvidence ? confluenceBonus : 0;
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
    const uncappedRS = Math.min(1, rawReactionStrength * recencyDecayFactor);
    const uncappedLegacyRS = Math.min(1, rawLegacyReactionStrength * recencyDecayFactor);
    const reactionStrength = touches === 0 ? Math.min(uncappedRS, 0.29) : uncappedRS;
    const legacyReactionStrength = touches === 0 ? Math.min(uncappedLegacyRS, 0.29) : uncappedLegacyRS;

    if (cluster.alwaysAdmit || touches >= 2 || rejectionWicks >= 1) {
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
  return zones.slice(0, 32);
}

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

async function runLookback(client: Client, lookbackHours: number): Promise<{ zones: ServerSRZone[]; bars: number }> {
  const now = Date.now();
  const fromTs = new Date(now - lookbackHours * 3_600_000).toISOString();
  const pageLog: number[] = [];
  const bars = await fetchBarsPaginated(client, fromTs, pageLog);
  console.log(`\n${'='.repeat(76)}`);
  console.log(`LOOKBACK ${lookbackHours}h — from ${fromTs}`);
  console.log(`PAGINATION: ${pageLog.length} page(s), per-page counts: [${pageLog.join(", ")}] — total ${bars.length} bars`);
  const raw = computeZones(bars, now);
  const deduped = dedupeByPriceType(raw);
  const overThreshold = deduped.filter((z) => z.reactionStrength >= CONSUMER_THRESHOLD).length;
  console.log(`ZONES: raw ${raw.length} → deduped ${deduped.length} → ${overThreshold} >= CONSUMER_THRESHOLD ${CONSUMER_THRESHOLD}`);
  const ages = deduped
    .map((z) => (z.lastTouchTs ? (now - Date.parse(z.lastTouchTs)) / 3_600_000 : null))
    .filter((a): a is number => a !== null);
  if (ages.length > 0) {
    console.log(`last-touch age: min ${Math.min(...ages).toFixed(1)}h / max ${Math.max(...ages).toFixed(1)}h`);
  }
  console.log(`\nZONE MAP @ ${lookbackHours}h (price | type | RS | touches | wicks | lastTouch):`);
  for (const z of deduped) {
    console.log(`  ${z.price.toFixed(1).padStart(7)} | ${z.type.padEnd(11)} | RS ${z.reactionStrength.toFixed(3)} | t${z.touches} w${z.rejectionWicks} | ${z.lastTouchTs ?? 'never'} | ${z.source}`);
  }
  // ITEM 4 acceptance: 48–72h-old zones surviving the threshold.
  const survivors = deduped.filter((z) => {
    if (!z.lastTouchTs) return false;
    const ageH = (now - Date.parse(z.lastTouchTs)) / 3_600_000;
    return ageH >= 48 && ageH <= 72 && z.reactionStrength >= CONSUMER_THRESHOLD;
  });
  console.log(`\n48–72h-old zones SURVIVING decay + threshold: ${survivors.length}`);
  for (const z of survivors) {
    const ageH = ((now - Date.parse(z.lastTouchTs!)) / 3_600_000).toFixed(1);
    console.log(`  ${z.price.toFixed(1)} ${z.type} RS ${z.reactionStrength.toFixed(3)} (age ${ageH}h, touches ${z.touches}, wicks ${z.rejectionWicks})`);
  }
  return { zones: deduped, bars: bars.length };
}

async function main(): Promise<void> {
  const client = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL!,
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  console.log('── ITEM 4 — offline zone-map comparison, 24h vs 96h (read-only) ──');
  const at24 = await runLookback(client, 24);
  const at96 = await runLookback(client, 96);
  const prices24 = new Set(at24.zones.map(z => `${z.price}|${z.type}`));
  const gained = at96.zones.filter(z => !prices24.has(`${z.price}|${z.type}`));
  console.log(`\n${'='.repeat(76)}`);
  console.log(`SUMMARY: bars 24h=${at24.bars} vs 96h=${at96.bars}; zones 24h=${at24.zones.length} vs 96h=${at96.zones.length}`);
  console.log(`Zones ADDED by the 96h window: ${gained.length}`);
  for (const z of gained) {
    const ageH = z.lastTouchTs ? ((Date.now() - Date.parse(z.lastTouchTs)) / 3_600_000).toFixed(1) : '?';
    console.log(`  + ${z.price.toFixed(1)} ${z.type} RS ${z.reactionStrength.toFixed(3)} (last touch ${ageH}h ago, touches ${z.touches}, wicks ${z.rejectionWicks}, ${z.source})`);
  }
  console.log('NOTE: measurement only — the deployed edge function still runs 24h until its next deploy.');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
