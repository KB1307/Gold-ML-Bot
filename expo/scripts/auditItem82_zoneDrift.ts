/**
 * PART A / Correction 6 — did the TIER_0 zone cache change between the
 * G80-1-CORRECTED run (Aug 14) and the Correction-5 re-run (Aug 16)?
 *
 * The engine reads `sr_zones_v1` LIVE via the anon key on every evaluation
 * (srZoneTier0Service.ts:255). The harness does NOT pin zones. So a refresh
 * of that table between two runs silently changes every zone-dependent gate
 * (reaction strength, bounce threshold, winning-strength) even when the engine
 * source and the tape-end are byte-identical.
 *
 * Read-only. No writes.
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

interface ZoneRow {
  price: number | string;
  type: string | null;
  reaction_strength: number | string | null;
  touches: number | null;
  source: string | null;
  last_touch_ts: string | null;
  updated_at: string | null;
}

function num(v: number | string | null): number {
  if (v === null) return NaN;
  return typeof v === "number" ? v : Number(v);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    console.log("MISSING SUPABASE ENV — cannot run");
    return;
  }
  const sb = createClient(url, anon, { auth: { persistSession: false } });

  const RULE = "=".repeat(78);
  console.log(RULE);
  console.log("PART A / CORRECTION 6 — sr_zones_v1 LIVE-READ DRIFT PROBE");
  console.log(RULE);

  const { data, error } = await sb
    .from("sr_zones_v1")
    .select("price,type,reaction_strength,touches,source,last_touch_ts,updated_at")
    .order("updated_at", { ascending: false })
    .limit(5000);

  if (error) {
    console.log(`READ ERROR: ${error.message}`);
    return;
  }
  const rows = (data ?? []) as ZoneRow[];
  console.log(`\nTotal zone rows visible to anon: ${rows.length}`);
  if (rows.length === 0) {
    console.log("⚠️  sr_zones_v1 is EMPTY — TIER_0 unavailable, engine falls back to TIER_1_LOCAL.");
    return;
  }

  const stamps = rows
    .map((r) => r.updated_at)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  const uniq = Array.from(new Set(stamps)).sort();
  console.log(`Distinct updated_at stamps: ${uniq.length}`);
  console.log(`  earliest: ${uniq[0]}`);
  console.log(`  latest  : ${uniq[uniq.length - 1]}`);

  console.log("\n--- rows per refresh batch (updated_at) ---");
  const byStamp = new Map<string, number>();
  for (const s of stamps) byStamp.set(s, (byStamp.get(s) ?? 0) + 1);
  const ordered = Array.from(byStamp.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  for (const [s, n] of ordered.slice(0, 15)) {
    console.log(`  ${s}  ->  ${n} rows`);
  }

  const rs = rows.map((r) => num(r.reaction_strength)).filter((v) => Number.isFinite(v));
  rs.sort((a, b) => a - b);
  const mean = rs.reduce((a, b) => a + b, 0) / (rs.length || 1);
  console.log("\n--- reaction_strength distribution (current live cache) ---");
  console.log(`  n=${rs.length} min=${rs[0]?.toFixed(4)} max=${rs[rs.length - 1]?.toFixed(4)} mean=${mean.toFixed(4)}`);
  console.log(`  p50=${rs[Math.floor(rs.length * 0.5)]?.toFixed(4)} p90=${rs[Math.floor(rs.length * 0.9)]?.toFixed(4)}`);
  const above03 = rs.filter((v) => v >= 0.3).length;
  console.log(`  rows with reaction_strength >= 0.30 (TIER0 consumer threshold): ${above03} / ${rs.length}`);
  if (above03 === 0) {
    console.log("  ⚠️  NO zone clears the 0.30 consumer threshold — every evaluation logs TIER0_UNAVAILABLE.");
  }

  // Is the refresh recent relative to the two harness runs?
  const latest = uniq[uniq.length - 1];
  const latestMs = latest ? new Date(latest).getTime() : NaN;
  const g80Ms = new Date("2026-08-14T18:00:00Z").getTime();
  const c5Ms = new Date("2026-08-16T21:00:00Z").getTime();
  console.log("\n--- refresh timing vs the two runs ---");
  console.log(`  G80-1-CORRECTED run ~ 2026-08-14T18:00Z`);
  console.log(`  Correction-5 re-run ~ 2026-08-16T21:00Z`);
  console.log(`  latest zone refresh = ${latest}`);
  if (Number.isFinite(latestMs)) {
    console.log(`  refresh AFTER G80-1 run?  ${latestMs > g80Ms ? "YES" : "no"}`);
    console.log(`  refresh AFTER Corr-5 run? ${latestMs > c5Ms ? "YES" : "no"}`);
    if (latestMs > g80Ms) {
      console.log("  => zone cache moved between the runs: LIVE-READ DRIFT is a real mechanism.");
    }
  }
}

main().catch((e: unknown) => {
  console.log(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
});
