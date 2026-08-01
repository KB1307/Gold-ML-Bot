/**
 * ITEM 1e: Verify the scheduled cron run wrote fresh zones to sr_zones_v1.
 * Checks updated_at timestamps and reaction_strength values.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): Record<string, string> {
  const raw = readFileSync(resolve(process.cwd(), "expo/.env"), "utf-8");
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
const anon = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  const { data: zones, error } = await anon
    .from("sr_zones_v1")
    .select("price, type, source, reaction_strength, last_touch_ts, updated_at")
    .order("reaction_strength", { ascending: false });
  
  if (error) {
    console.log("Error:", error.message);
    return;
  }

  console.log("=== sr_zones_v1 after scheduled cron run ===");
  console.log(`Row count: ${zones?.length ?? 0}`);
  
  if (zones && zones.length > 0) {
    const updated = zones.map(z => z.updated_at).sort().reverse();
    console.log(`max(updated_at): ${updated[0]}`);
    console.log(`min(updated_at): ${updated[updated.length - 1]}`);
    
    const ts = zones.map(z => z.last_touch_ts).filter((t): t is string => !!t).sort();
    console.log(`min(last_touch_ts): ${ts[0]}`);
    console.log(`max(last_touch_ts): ${ts[ts.length - 1]}`);
    
    const overThreshold = zones.filter(z => Number(z.reaction_strength) >= 0.3).length;
    console.log(`rows with reactionStrength >= 0.3: ${overThreshold}`);
    
    // Check if updated_at is recent (within last 5 minutes)
    const now = Date.now();
    const mostRecentUpdate = new Date(updated[0]).getTime();
    const ageMs = now - mostRecentUpdate;
    const ageMin = ageMs / 60000;
    console.log(`\nmost recent updated_at age: ${ageMin.toFixed(2)} minutes ago`);
    console.log(`now: ${new Date(now).toISOString()}`);
    
    // Show all zones
    console.log(`\n${"price".padStart(9)} ${"type".padEnd(11)} ${"src".padEnd(13)} ${"rs".padStart(6)} ${"last_touch_ts".padEnd(26)} ${"updated_at".padEnd(26)}`);
    for (const z of zones) {
      console.log(
        `  ${String(z.price).padStart(9)} ${z.type.padEnd(11)} ${z.source.padEnd(13)} ${Number(z.reaction_strength).toFixed(3).padStart(6)} ${(z.last_touch_ts ?? "null").padEnd(26)} ${(z.updated_at ?? "null").padEnd(26)}`
      );
    }
    
    // Count distinct updated_at values
    const distinctUpdates = new Set(zones.map(z => z.updated_at));
    console.log(`\ndistinct updated_at values: ${distinctUpdates.size}`);
    for (const u of [...distinctUpdates].sort().reverse()) {
      const count = zones.filter(z => z.updated_at === u).length;
      console.log(`  ${u}: ${count} rows`);
    }
  }
}

main().catch(console.error);
