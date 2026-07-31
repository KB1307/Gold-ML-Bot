/**
 * Single-scenario TIER_0 failure driver, run as an ISOLATED child process.
 *
 * Module-level state (the cached Supabase client and the counters) cannot be
 * reset by re-importing within one process — an earlier attempt to do that with
 * a `?bust=` query string silently returned the SAME module instance, so the
 * env overrides had no effect and the "forced failure" scenarios were really
 * just re-running the happy path. Each scenario therefore gets its own process.
 *
 * Usage: bun x tsx scripts/tier0FailureCase.ts <happy|readerror|notconfigured>
 *
 * DATA-SOURCE RULE: the service under test reads sr_zones_v1 DIRECTLY from
 * Supabase via the anon key. No Rork backend. No GC=F/TwelveData fallback.
 */

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

const scenario = process.argv[2] ?? "happy";
const fileEnv = loadEnv();

// Configure the environment BEFORE the service module is imported, so the
// module-level client is constructed against the scenario's config.
if (scenario === "happy") {
  process.env.EXPO_PUBLIC_SUPABASE_URL = fileEnv.EXPO_PUBLIC_SUPABASE_URL;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = fileEnv.EXPO_PUBLIC_SUPABASE_ANON_KEY;
} else if (scenario === "readerror") {
  process.env.EXPO_PUBLIC_SUPABASE_URL = fileEnv.EXPO_PUBLIC_SUPABASE_URL;
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = "this-is-not-a-valid-anon-key";
} else if (scenario === "notconfigured") {
  delete process.env.EXPO_PUBLIC_SUPABASE_URL;
  delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
}

async function main(): Promise<void> {
  const svc = await import("../services/srZoneTier0Service");
  const result = await svc.fetchTier0SRZones();

  console.log(`  scenario       = ${scenario}`);
  console.log(`  result.ok      = ${result.ok}`);
  console.log(`  result.reason  = ${result.reason ?? "null"}`);
  console.log(`  result.detail  = ${result.detail ?? "null"}`);
  console.log(`  usable zones   = ${result.zones.length}`);
  console.log(`  weak zones     = ${result.weakZoneCount}`);
  if (result.zones.length > 0) {
    for (const z of result.zones.slice(0, 5)) {
      console.log(
        `    ${z.type.padEnd(10)} @ ${String(z.price).padStart(8)}  reaction=${z.reactionStrength.toFixed(3)}  touches=${z.touches}  src=${z.source}`,
      );
    }
  }
  const c = svc.getTier0Counters();
  console.log(
    `  counters: reads=${c.reads} successes=${c.successes} failures=${c.failures} notConfigured=${c.notConfigured} readErrors=${c.readErrors} emptyTable=${c.emptyTable} allExpired=${c.allExpired} belowThreshold=${c.belowThreshold}`,
  );
  const detail = result.detail ?? "";
  if (!result.ok) {
    console.log(
      `  detail human-readable (not [object Object]): ${detail.length > 0 && !detail.includes("[object Object]") ? "YES" : "NO"}`,
    );
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
