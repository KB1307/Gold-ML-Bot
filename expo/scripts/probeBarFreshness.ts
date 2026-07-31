/**
 * Probe: gold_m1_bars freshness + density, and an emulation of the exact
 * query srZones.computeZonesFromBars() issues (120h lookback, asc, limit 10000).
 *
 * Purpose: explain why every sr_zones_v1 row written at 2026-07-31T21:27:32Z
 * carries a last_touch_ts of 2026-07-27/28 — i.e. whether the zone compute
 * window is actually reaching recent bars or is being truncated by the
 * `.limit(10000)` on an ascending order.
 */

import { createClient } from "@supabase/supabase-js";
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
const client = createClient(env.EXPO_PUBLIC_SUPABASE_URL as string, env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main(): Promise<void> {
  const now = Date.now();
  console.log(`now = ${new Date(now).toISOString()}`);

  const newest = await client
    .from("gold_m1_bars")
    .select("timestamp, close")
    .order("timestamp", { ascending: false })
    .limit(3);
  console.log(`NEWEST gold_m1_bars: ${JSON.stringify(newest.data)}`);
  if (newest.data && newest.data.length > 0) {
    const ageMin = (now - new Date(newest.data[0].timestamp as string).getTime()) / 60_000;
    console.log(`Newest bar age: ${ageMin.toFixed(1)} min`);
  }

  const from120 = new Date(now - 120 * 3_600_000).toISOString();
  const cnt = await client
    .from("gold_m1_bars")
    .select("timestamp", { count: "exact", head: true })
    .gte("timestamp", from120);
  console.log(`\nRows in last 120h (since ${from120}): ${cnt.count}`);
  console.log(`srZones LOOKBACK_HOURS=120 with .limit(10000) -> ${(cnt.count ?? 0) > 10000 ? "TRUNCATED" : "not truncated"}`);

  const asc = await client
    .from("gold_m1_bars")
    .select("timestamp")
    .gte("timestamp", from120)
    .order("timestamp", { ascending: true })
    .limit(10000);
  const rows = asc.data ?? [];
  console.log(`\nEmulated compute query returned ${rows.length} row(s)`);
  if (rows.length > 0) {
    const first = rows[0].timestamp as string;
    const last = rows[rows.length - 1].timestamp as string;
    console.log(`  first: ${first}`);
    console.log(`  last:  ${last}`);
    const gapH = (now - new Date(last).getTime()) / 3_600_000;
    console.log(`  compute window ENDS ${gapH.toFixed(2)}h before now`);
    if (gapH > 1) {
      console.log("  -> The zone compute NEVER SEES the most recent bars. This is why every");
      console.log("     zone's last_touch_ts is days old and reaction_strength decays to ~0.");
    }
  }

  // PostgREST default max-rows check: does .limit(10000) actually yield 10000?
  console.log(`\nPostgREST row cap check: requested limit=10000, received=${rows.length}`);
  if (rows.length < (cnt.count ?? 0) && rows.length < 10000) {
    console.log("  -> Server-side max-rows cap is LOWER than the requested limit.");
    console.log(`  -> Effective cap = ${rows.length} rows.`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
