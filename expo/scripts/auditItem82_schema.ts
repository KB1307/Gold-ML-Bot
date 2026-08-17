/**
 * ITEM 82 — read the ACTUAL live column names. Repo migrations are not evidence;
 * this project has proven repo-vs-production drift twice.
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

async function main(): Promise<void> {
  const env = loadEnv();
  const sb = createClient(env.EXPO_PUBLIC_SUPABASE_URL ?? "", env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "", {
    auth: { persistSession: false },
  });
  for (const t of ["gold_m1_bars", "trade_outcomes_v1", "emitted_signals_v1", "shadow_signals_v1", "sr_zones_v1"]) {
    const { data, error } = await sb.from(t).select("*").limit(1);
    console.log(`\n=== ${t} ===`);
    if (error) {
      console.log(`  ERROR ${error.code ?? ""} ${error.message}`);
      continue;
    }
    const row = (data ?? [])[0] as Record<string, unknown> | undefined;
    if (!row) {
      console.log("  (no rows)");
      continue;
    }
    for (const [k, v] of Object.entries(row)) {
      const t2 = v === null ? "null" : typeof v;
      const preview = typeof v === "object" ? "[obj]" : String(v).slice(0, 60);
      console.log(`  ${k.padEnd(28)} ${t2.padEnd(8)} ${preview}`);
    }
  }
}

main().catch((e: unknown) => console.log(`FATAL: ${e instanceof Error ? e.message : String(e)}`));
