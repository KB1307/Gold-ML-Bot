/**
 * ITEM 1a: Confirm pg_cron AND pg_net are genuinely installed on the live DB.
 * Do not assume — query pg_extension and pg_available_extensions directly.
 * Also report current sr_zones_v1 and gold_m1_bars state.
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
const url = env.EXPO_PUBLIC_SUPABASE_URL as string;
const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY as string;

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createClient(url, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function main() {
  console.log("=".repeat(78));
  console.log("ITEM 1a — VERIFY pg_cron AND pg_net INSTALLED ON LIVE DB");
  console.log(`run at ${new Date().toISOString()}`);
  console.log("=".repeat(78));

  // 1. pg_extension — what's actually installed
  const { data: extData, error: extError } = await admin
    .from("pg_extension")
    .select("extname, extversion")
    .in("extname", ["pg_cron", "pg_net"]);
  console.log("\n=== pg_extension (installed extensions) ===");
  if (extError) {
    console.log("Error:", extError.message);
  } else {
    console.log(JSON.stringify(extData, null, 2));
  }

  // 2. pg_available_extensions — versions available + installed
  const { data: availData, error: availError } = await admin
    .from("pg_available_extensions")
    .select("name, default_version, installed_version")
    .in("name", ["pg_cron", "pg_net"]);
  console.log("\n=== pg_available_extensions ===");
  if (availError) {
    console.log("Error:", availError.message);
  } else {
    console.log(JSON.stringify(availData, null, 2));
  }

  // 3. Try cron_jobs table (Supabase exposes cron.jobs via PostgREST)
  const { data: cronJobs, error: cronJobsError } = await admin
    .from("cron_jobs")
    .select("*")
    .limit(10);
  console.log("\n=== cron.jobs (existing scheduled jobs) ===");
  if (cronJobsError) {
    console.log("Error:", cronJobsError.message);
  } else {
    console.log(JSON.stringify(cronJobs, null, 2));
  }

  // 4. Try cron_job_run_details
  const { data: cronRuns, error: cronRunsError } = await admin
    .from("cron_job_run_details")
    .select("*")
    .limit(5);
  console.log("\n=== cron.job_run_details (recent runs) ===");
  if (cronRunsError) {
    console.log("Error:", cronRunsError.message);
  } else {
    console.log(JSON.stringify(cronRuns, null, 2));
  }

  // 5. sr_zones_v1 current state
  const { data: zones, error: zonesError } = await anon
    .from("sr_zones_v1")
    .select("price, type, source, reaction_strength, last_touch_ts, updated_at")
    .order("reaction_strength", { ascending: false });
  console.log("\n=== sr_zones_v1 (anon read) ===");
  if (zonesError) {
    console.log("Error:", zonesError.message);
  } else {
    console.log(`Row count: ${zones?.length ?? 0}`);
    if (zones && zones.length > 0) {
      const ts = zones.map((z) => z.last_touch_ts).filter((t): t is string => !!t).sort();
      console.log(`min(last_touch_ts): ${ts[0]}`);
      console.log(`max(last_touch_ts): ${ts[ts.length - 1]}`);
      console.log(`rows with reactionStrength >= 0.3: ${zones.filter((z) => Number(z.reaction_strength) >= 0.3).length}`);
      const ua = zones.map((z) => z.updated_at).sort().reverse();
      console.log(`max(updated_at): ${ua[0]}`);
    }
  }

  // 6. gold_m1_bars current state
  const { count: totalBars } = await anon
    .from("gold_m1_bars")
    .select("timestamp", { count: "exact", head: true });
  console.log("\n=== gold_m1_bars ===");
  console.log(`Total rows: ${totalBars}`);

  const { data: firstBar } = await anon
    .from("gold_m1_bars")
    .select("timestamp")
    .order("timestamp", { ascending: true })
    .limit(1);
  const { data: lastBar } = await anon
    .from("gold_m1_bars")
    .select("timestamp")
    .order("timestamp", { ascending: false })
    .limit(1);
  if (firstBar && firstBar.length > 0) console.log(`min(timestamp): ${firstBar[0].timestamp}`);
  if (lastBar && lastBar.length > 0) console.log(`max(timestamp): ${lastBar[0].timestamp}`);

  const { count: futureBars } = await anon
    .from("gold_m1_bars")
    .select("timestamp", { count: "exact", head: true })
    .gt("timestamp", new Date().toISOString());
  console.log(`future_bars: ${futureBars}`);
  console.log(`now(): ${new Date().toISOString()}`);

  // 7. Check if net.http_get exists (pg_net function)
  const { data: netFn, error: netFnError } = await admin.rpc("net_http_get", {
    url: "https://httpbin.org/get",
  }).catch(() => Promise.resolve({ data: null, error: { message: "net.http_get not callable via RPC" } }));
  console.log("\n=== net.http_get test ===");
  console.log(JSON.stringify({ data: netFn, error: netFnError }, null, 2));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
