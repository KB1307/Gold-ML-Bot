/**
 * B2(b) MEASUREMENT — does paginating the bar fetch actually fix TIER_0 zones?
 *
 * MEASURE BEFORE BUILDING. This script does NOT write anything. It replicates
 * expo/backend/trpc/routes/srZones.ts computeZonesFromBars() EXACTLY, twice:
 *
 *   RUN A "capped"    — .limit(10000) with no pagination, i.e. the code as it
 *                       ships today. PostgREST silently caps at 1000 rows and
 *                       ascending order means the compute sees only the OLDEST
 *                       1000 bars of the 120h window.
 *   RUN B "paginated" — .range() pagination, retrieving the full window.
 *
 * It then reports, for both runs, the decisive number: how many zones clear the
 * >= 0.3 reactionStrength threshold that every downstream consumer in
 * signalEngine.ts applies (lines 7030, 7059, 7120, 7131, 7488, 7495).
 *
 * If RUN B still yields zero zones over 0.3, pagination is NOT sufficient and
 * the decay/threshold calibration is a SEPARATE defect — which is itself the
 * finding, and must be reported rather than papered over.
 *
 * DATA-SOURCE RULE: reads gold_m1_bars DIRECTLY from Supabase (anon key for the
 * read-path proof, service key only as a control). No Rork backend involved.
 * No GC=F / TwelveData. Nothing else can feed this.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): Record<string, string> {
  const raw = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}

const env = loadEnv();
const anon: SupabaseClient = createClient(
  env.EXPO_PUBLIC_SUPABASE_URL as string,
  env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── constants copied verbatim from srZones.ts ─────────────────────────────────
const LOOKBACK_HOURS = 120;
const ZONE_STALENESS_HALF_LIFE_HOURS = 18;
const CONSUMER_THRESHOLD = 0.3;

type ZoneSource = "PRICE_ACTION" | "PIVOT" | "PREV_DAY" | "ASIAN_RANGE" | "ORH_ORL" | "WEEKLY" | "SESSION_BLOCK";

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
  rawReactionStrength: number;
  recencyDecayFactor: number;
  ageHours: number;
  source: ZoneSource;
  confluenceScore: number;
  lastTouchTs: string | null;
}

/** RUN A: exactly what srZones.ts:71-76 does today. */
async function fetchBarsCapped(fromTs: string): Promise<Bar[]> {
  const { data, error } = await anon
    .from("gold_m1_bars")
    .select("timestamp, open, high, low, close")
    .gte("timestamp", fromTs)
    .order("timestamp", { ascending: true })
    .limit(10000);
  if (error) throw new Error(error.message);
  return (data ?? []) as Bar[];
}

/** RUN B: the same window, but paginated past the PostgREST 1000-row cap. */
async function fetchBarsPaginated(fromTs: string): Promise<Bar[]> {
  const out: Bar[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await anon
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromTs)
      .order("timestamp", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Bar[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 200_000) break;
  }
  return out;
}

/** Verbatim port of computeZonesFromBars()'s maths, instrumented. */
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
  const zoneWidth = Math.max(atr * 0.3, currentPrice * 0.0015);

  type Candidate = { price: number; source: ZoneSource; alwaysAdmit?: boolean };
  const candidates: Candidate[] = [];

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

  const dayMs = 24 * 60 * 60 * 1000;
  const todayStartUtc = Math.floor(now / dayMs) * dayMs;
  const yesterdayStartUtc = todayStartUtc - dayMs;
  const yesterdayIdx = timestamps.map((ts, i) => ({ ts, i })).filter((t) => t.ts >= yesterdayStartUtc && t.ts < todayStartUtc);
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
        rawReactionStrength: parseFloat(rawReactionStrength.toFixed(3)),
        recencyDecayFactor: parseFloat(recencyDecayFactor.toFixed(4)),
        ageHours: parseFloat(ageHours.toFixed(2)),
        source: cluster.source,
        confluenceScore,
        lastTouchTs: lastTouchTs > 0 ? new Date(lastTouchTs).toISOString() : null,
      });
    }
  }

  zones.sort((a, b) => b.reactionStrength - a.reactionStrength);
  return zones.slice(0, 32);
}

function report(label: string, bars: Bar[], zones: ServerSRZone[], now: number): number {
  console.log(`\n${"=".repeat(96)}`);
  console.log(`${label}`);
  console.log("=".repeat(96));
  console.log(`  bars fetched: ${bars.length}`);
  if (bars.length > 0) {
    const first = bars[0].timestamp;
    const last = bars[bars.length - 1].timestamp;
    const endsAgoH = (now - new Date(last).getTime()) / 3_600_000;
    console.log(`  bar window:   ${first}  ->  ${last}`);
    console.log(`  window ENDS ${endsAgoH.toFixed(2)}h before now`);
  }
  console.log(`  zones computed: ${zones.length}`);
  const clearing = zones.filter((z) => z.reactionStrength >= CONSUMER_THRESHOLD);
  console.log(`  zones with reactionStrength >= ${CONSUMER_THRESHOLD} (the consumer threshold): ${clearing.length}`);

  if (zones.length > 0) {
    console.log(`\n  ${"price".padStart(8)} ${"type".padEnd(10)} ${"tch".padStart(4)} ${"wick".padStart(4)} ${"RAW".padStart(6)} ${"decay".padStart(7)} ${"ageH".padStart(7)} ${"FINAL".padStart(6)}  ${"src".padEnd(12)} clears0.3?`);
    for (const z of zones.slice(0, 20)) {
      console.log(
        `  ${String(z.price).padStart(8)} ${z.type.padEnd(10)} ${String(z.touches).padStart(4)} ${String(z.rejectionWicks).padStart(4)} ${z.rawReactionStrength.toFixed(3).padStart(6)} ${z.recencyDecayFactor.toFixed(4).padStart(7)} ${z.ageHours.toFixed(1).padStart(7)} ${z.reactionStrength.toFixed(3).padStart(6)}  ${z.source.padEnd(12)} ${z.reactionStrength >= CONSUMER_THRESHOLD ? "YES" : "no"}`,
      );
    }
    const maxRs = Math.max(...zones.map((z) => z.reactionStrength));
    const maxRaw = Math.max(...zones.map((z) => z.rawReactionStrength));
    console.log(`\n  max FINAL reactionStrength: ${maxRs.toFixed(3)}`);
    console.log(`  max RAW   reactionStrength: ${maxRaw.toFixed(3)}  (before recency decay)`);
    const minAge = Math.min(...zones.filter((z) => z.ageHours > 0).map((z) => z.ageHours));
    console.log(`  freshest zone lastTouch age: ${Number.isFinite(minAge) ? minAge.toFixed(2) : "n/a"}h`);
  }
  return clearing.length;
}

async function main(): Promise<void> {
  const now = Date.now();
  console.log("=".repeat(96));
  console.log("B2(b) MEASUREMENT — TIER_0 zone compute: capped vs paginated");
  console.log(`run at: ${new Date(now).toISOString()}`);
  console.log(`source: Supabase gold_m1_bars, ANON key, direct. No backend. No GC=F/TwelveData.`);
  console.log(`consumer threshold under test: reactionStrength >= ${CONSUMER_THRESHOLD}`);
  console.log("=".repeat(96));

  const fromTs = new Date(now - LOOKBACK_HOURS * 3_600_000).toISOString();
  console.log(`\nLOOKBACK_HOURS=${LOOKBACK_HOURS} -> fromTs = ${fromTs}`);

  const cappedBars = await fetchBarsCapped(fromTs);
  const pagedBars = await fetchBarsPaginated(fromTs);

  console.log(`\nPostgREST cap proof: requested .limit(10000), received ${cappedBars.length}`);
  console.log(`Paginated .range() over the same window received ${pagedBars.length}`);
  console.log(`-> ${pagedBars.length - cappedBars.length} bars were INVISIBLE to the shipping compute.`);

  const cappedZones = computeZones(cappedBars, now);
  const pagedZones = computeZones(pagedBars, now);

  const cappedClearing = report("RUN A — CAPPED (.limit(10000), the code as it ships today)", cappedBars, cappedZones, now);
  const pagedClearing = report("RUN B — PAGINATED (.range() pagination, the B2(b) fix)", pagedBars, pagedZones, now);

  console.log(`\n${"=".repeat(96)}`);
  console.log("VERDICT");
  console.log("=".repeat(96));
  console.log(`  zones clearing ${CONSUMER_THRESHOLD}:  capped=${cappedClearing}   paginated=${pagedClearing}`);
  if (pagedClearing > 0) {
    console.log(`  -> Pagination ALONE is SUFFICIENT. TIER_0 becomes usable. Implement B2(b) as specified.`);
  } else {
    console.log(`  -> Pagination is NECESSARY BUT NOT SUFFICIENT.`);
    console.log(`     Even with the full window, ZERO zones clear the ${CONSUMER_THRESHOLD} consumer threshold.`);
    console.log(`     This is a SEPARATE defect in the decay/threshold calibration and must be`);
    console.log(`     reported as its own finding, not silently absorbed into B2(b).`);
  }
  console.log("=".repeat(96));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
