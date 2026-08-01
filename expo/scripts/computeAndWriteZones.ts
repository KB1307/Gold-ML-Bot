/**
 * B2(b) VERIFICATION + B2(d) OPTION-3 FEASIBILITY PROOF.
 *
 * The backend `srZones.refreshZones` mutation is 503 on every configured base
 * URL, so the pagination fix cannot be exercised through it. This script does
 * NOT pretend to be that trigger. It does two separate, explicitly-labelled
 * things:
 *
 *   MEASUREMENT (B2(b)): replays computeZonesFromBars() verbatim against live
 *   production gold_m1_bars, twice — once with the old capped fetch and once
 *   with pagination — and reports whether the paginated zones actually clear
 *   the 0.3 consumer threshold with recent last_touch_ts. If they do not, that
 *   is reported as a SEPARATE finding (decay/threshold miscalibration).
 *
 *   FEASIBILITY (B2(d) option 3): performs the zone WRITE directly against
 *   sr_zones_v1 with the service-role key, no Rork backend in the path. This
 *   is exactly the architecture under evaluation for the Python host, so
 *   running it here is the empirical test of whether that option is viable.
 *
 * Pass --write to perform the write. Without it, the script is read-only.
 *
 * DATA-SOURCE RULE: bars are read from Supabase gold_m1_bars directly. No Rork
 * backend, no GC=F/TwelveData. The service-role key is used only for the write
 * and only in this Node-side script — it is never shipped to the client.
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
const svc: SupabaseClient | null = env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(env.EXPO_PUBLIC_SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

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

/** Verbatim port of srZones.ts computeZonesFromBars() maths, instrumented. */
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
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
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
      touchScore * 0.3 +
        rejectionScore * 0.3 +
        rejectionSizeScore * 0.2 +
        Math.min(1, confluenceScore / 3) * (hasEarnedEvidence ? 0.2 : 0) +
        effectiveConfluenceBonus,
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

/**
 * DEFECT FOUND LIVE: computeZonesFromBars() can emit two zones with the SAME
 * (price, type) pair — cluster prices are rounded to 1 decimal at
 * `parseFloat(cluster.price.toFixed(1))`, so two distinct clusters less than
 * 0.05 apart collapse onto one stored price. sr_zones_v1 has a UNIQUE
 * constraint on (price, type), so the wholesale insert fails with 23505 —
 * AFTER the delete has already run, leaving the cache EMPTY.
 *
 * Dedupe keeps the strongest zone per (price, type).
 */
function dedupeByPriceType(zones: ServerSRZone[]): { kept: ServerSRZone[]; dropped: ServerSRZone[] } {
  const seen = new Map<string, ServerSRZone>();
  const dropped: ServerSRZone[] = [];
  for (const z of zones) {
    const key = `${z.price}|${z.type}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, z);
    } else if (z.reactionStrength > prev.reactionStrength) {
      dropped.push(prev);
      seen.set(key, z);
    } else {
      dropped.push(z);
    }
  }
  return { kept: [...seen.values()].sort((a, b) => b.reactionStrength - a.reactionStrength), dropped };
}

function summarize(label: string, bars: Bar[], zones: ServerSRZone[], now: number): void {
  console.log(`\n── ${label} ──`);
  console.log(`  bars fetched: ${bars.length}`);
  if (bars.length > 0) {
    const endAge = (now - new Date(bars[bars.length - 1].timestamp).getTime()) / 3_600_000;
    console.log(`  window: ${bars[0].timestamp} -> ${bars[bars.length - 1].timestamp}`);
    console.log(`  compute window ENDS ${endAge.toFixed(2)}h before now`);
  }
  console.log(`  zones produced: ${zones.length}`);
  const over = zones.filter((z) => z.reactionStrength >= CONSUMER_THRESHOLD);
  console.log(`  zones with reactionStrength >= ${CONSUMER_THRESHOLD}: ${over.length}`);
  if (zones.length > 0) {
    console.log(`  max reactionStrength: ${zones[0].reactionStrength.toFixed(3)}`);
    const lts = zones.map((z) => z.lastTouchTs).filter((t): t is string => !!t).sort();
    if (lts.length > 0) {
      console.log(`  last_touch_ts range: ${lts[0]} .. ${lts[lts.length - 1]}`);
      console.log(`  newest touch age: ${((now - new Date(lts[lts.length - 1]).getTime()) / 3_600_000).toFixed(2)}h`);
    }
    console.log(`\n  ${"price".padStart(9)} ${"type".padEnd(11)} ${"src".padEnd(13)} ${"tch".padStart(4)} ${"raw".padStart(6)} ${"decay".padStart(7)} ${"ageH".padStart(7)} ${"rs".padStart(6)}`);
    for (const z of zones.slice(0, 15)) {
      console.log(
        `  ${String(z.price).padStart(9)} ${z.type.padEnd(11)} ${z.source.padEnd(13)} ${String(z.touches).padStart(4)} ${z.rawReactionStrength.toFixed(3).padStart(6)} ${z.recencyDecayFactor.toFixed(4).padStart(7)} ${z.ageHours.toFixed(1).padStart(7)} ${z.reactionStrength.toFixed(3).padStart(6)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const doWrite = process.argv.includes("--write");
  const now = Date.now();
  const fromTs = new Date(now - LOOKBACK_HOURS * 3_600_000).toISOString();

  console.log("=".repeat(78));
  console.log("B2(b) PAGINATION VERIFICATION + B2(d) DIRECT-WRITE FEASIBILITY");
  console.log(`run at ${new Date(now).toISOString()}   lookback from ${fromTs}`);
  console.log(`mode: ${doWrite ? "MEASURE + WRITE (service role, no backend)" : "MEASURE ONLY (read-only)"}`);
  console.log("=".repeat(78));

  const cappedBars = await fetchBarsCapped(fromTs);
  const capped = computeZones(cappedBars, now);
  summarize("RUN A — current backend behaviour BEFORE pagination (.limit(10000), PostgREST caps at 1000)", cappedBars, capped, now);

  const pagedBars = await fetchBarsPaginated(fromTs);
  const paged = computeZones(pagedBars, now);
  summarize("RUN B — B2(b) FIX: paginated fetch", pagedBars, paged, now);

  const overA = capped.filter((z) => z.reactionStrength >= CONSUMER_THRESHOLD).length;
  const overB = paged.filter((z) => z.reactionStrength >= CONSUMER_THRESHOLD).length;

  console.log("\n" + "=".repeat(78));
  console.log("B2(b) VERDICT");
  console.log("=".repeat(78));
  console.log(`  capped   : ${cappedBars.length} bars -> ${capped.length} zones, ${overA} clear the ${CONSUMER_THRESHOLD} threshold`);
  console.log(`  paginated: ${pagedBars.length} bars -> ${paged.length} zones, ${overB} clear the ${CONSUMER_THRESHOLD} threshold`);
  if (overB > 0) {
    console.log(`  => pagination fix WORKS on live data: ${overB} usable TIER_0 zone(s).`);
  } else {
    console.log(`  => SEPARATE FINDING: even paginated, ZERO zones clear ${CONSUMER_THRESHOLD}.`);
    console.log(`     The decay/threshold calibration is ALSO wrong, independently of pagination.`);
    const maxRs = paged.length > 0 ? Math.max(...paged.map((z) => z.reactionStrength)) : 0;
    const maxRaw = paged.length > 0 ? Math.max(...paged.map((z) => z.rawReactionStrength)) : 0;
    console.log(`     max reactionStrength=${maxRs.toFixed(3)} (max RAW before decay=${maxRaw.toFixed(3)})`);
  }

  if (!doWrite) {
    console.log("\n  (read-only run — pass --write to exercise the direct service-role write)");
    return;
  }

  console.log("\n" + "=".repeat(78));
  console.log("B2(d) OPTION-3 FEASIBILITY — DIRECT service-role WRITE to sr_zones_v1 (no Rork backend)");
  console.log("=".repeat(78));
  if (!svc) {
    console.log("  SUPABASE_SERVICE_ROLE_KEY not available — cannot test the direct write.");
    return;
  }

  const del = await svc.from("sr_zones_v1").delete().gt("id", 0);
  if (del.error) {
    console.log(`  DELETE failed: ${del.error.message} (code=${del.error.code ?? "-"})`);
    return;
  }
  console.log("  DELETE of stale cache: OK");

  const { kept, dropped } = dedupeByPriceType(paged);
  console.log(`  dedupe by (price,type): ${paged.length} computed -> ${kept.length} unique, ${dropped.length} dropped as duplicates`);
  for (const d of dropped) {
    console.log(`    dropped duplicate: price=${d.price} type=${d.type} rs=${d.reactionStrength.toFixed(3)}`);
  }

  const rows = kept.map((z) => ({
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
  const ins = await svc.from("sr_zones_v1").insert(rows);
  if (ins.error) {
    console.log(`  INSERT failed: ${ins.error.message} (code=${ins.error.code ?? "-"} details=${ins.error.details ?? "-"})`);
    console.log("  NOTE: the table is now EMPTY — this is the non-atomic delete-then-insert defect.");
    return;
  }
  console.log(`  INSERT of ${rows.length} zone(s): OK`);

  const verify = await anon
    .from("sr_zones_v1")
    .select("price, type, source, reaction_strength, last_touch_ts")
    .order("reaction_strength", { ascending: false })
    .limit(200);
  const vrows = (verify.data ?? []) as { reaction_strength: number; last_touch_ts: string | null }[];
  console.log(`\n  ANON re-read after write: ${vrows.length} row(s)`);
  const ts = vrows.map((r) => r.last_touch_ts).filter((t): t is string => !!t).sort();
  if (ts.length > 0) {
    console.log(`  min(last_touch_ts) = ${ts[0]}`);
    console.log(`  max(last_touch_ts) = ${ts[ts.length - 1]}`);
  }
  console.log(`  rows with reactionStrength >= ${CONSUMER_THRESHOLD}: ${vrows.filter((r) => Number(r.reaction_strength) >= CONSUMER_THRESHOLD).length}`);
  console.log("\n  => a Python host holding the service key CAN write sr_zones_v1 with zero Rork backend involvement.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
