/**
 * Phase A2 (CORRECTED) — sr_zones_v1 live state, read with the ANON key.
 *
 * The first A2 attempt failed with "column sr_zones_v1.created_at does not exist".
 * The real schema (from expo/backend/trpc/routes/srZones.ts upsertZones) is:
 *   id, price, type, touches, rejection_wicks, reaction_strength,
 *   source, confluence_score, last_touch_ts, updated_at
 *
 * This script proves, with live output:
 *   (1) whether ANON can SELECT sr_zones_v1 at all (required for the B2 repoint)
 *   (2) the actual current contents + freshness of the table
 *   (3) when rows were last written (updated_at) — answers B2(d)
 *   (4) whether the backend srZones.getZones route is reachable right now
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
const URL_ = env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !ANON) {
  console.error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}

const anonClient = createClient(URL_, ANON, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const svcClient = SERVICE
  ? createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

interface ZoneRow {
  id: number;
  price: number;
  type: string;
  touches: number;
  rejection_wicks: number;
  reaction_strength: number;
  source: string;
  confluence_score: number;
  last_touch_ts: string | null;
  updated_at: string | null;
}

async function main(): Promise<void> {
  console.log("Phase A2 (CORRECTED) — sr_zones_v1 live state");
  console.log(`Supabase URL: ${URL_}`);
  console.log(`Run time: ${new Date().toISOString()}`);

  // ── (1) ANON SELECT capability — the precondition for the B2 repoint ────
  console.log("\n" + "=".repeat(78));
  console.log("(1) ANON SELECT on sr_zones_v1 — precondition for B2(a) repoint");
  console.log("=".repeat(78));

  const anonRes = await anonClient
    .from("sr_zones_v1")
    .select("id, price, type, touches, rejection_wicks, reaction_strength, source, confluence_score, last_touch_ts, updated_at")
    .order("reaction_strength", { ascending: false })
    .limit(32);

  if (anonRes.error) {
    console.log(`ANON SELECT FAILED: ${anonRes.error.message} (code=${anonRes.error.code ?? "n/a"})`);
    console.log("  -> B2(a) CANNOT proceed as specified: anon SELECT is NOT enabled.");
  } else {
    console.log(`ANON SELECT OK — returned ${anonRes.data?.length ?? 0} row(s)`);
  }

  // ── (2) service-role control read (proves whether rows exist at all) ────
  console.log("\n" + "=".repeat(78));
  console.log("(2) SERVICE-ROLE control read (does the table have rows at all?)");
  console.log("=".repeat(78));

  let svcRows: ZoneRow[] = [];
  if (!svcClient) {
    console.log("SUPABASE_SERVICE_ROLE_KEY not present in .env — control read skipped");
  } else {
    const svcRes = await svcClient
      .from("sr_zones_v1")
      .select("id, price, type, touches, rejection_wicks, reaction_strength, source, confluence_score, last_touch_ts, updated_at")
      .order("reaction_strength", { ascending: false })
      .limit(64);
    if (svcRes.error) {
      console.log(`SERVICE SELECT FAILED: ${svcRes.error.message}`);
    } else {
      svcRows = (svcRes.data ?? []) as ZoneRow[];
      console.log(`SERVICE SELECT OK — ${svcRows.length} row(s)`);
    }
  }

  const anonRows = (anonRes.data ?? []) as ZoneRow[];
  console.log(`\nRow-count comparison:  anon=${anonRows.length}  service=${svcRows.length}`);
  if (svcRows.length > 0 && anonRows.length === 0) {
    console.log("  -> RLS is HIDING rows from anon. anon SELECT policy is MISSING or restrictive.");
  } else if (svcRows.length === anonRows.length && svcRows.length > 0) {
    console.log("  -> anon sees the same rows as service role. anon SELECT policy is PRESENT and permissive.");
  } else if (svcRows.length === 0 && anonRows.length === 0) {
    console.log("  -> TABLE IS EMPTY for both. Not an RLS problem — a WRITE/refresh problem.");
  }

  // ── (3) contents + freshness ────────────────────────────────────────────
  console.log("\n" + "=".repeat(78));
  console.log("(3) CONTENTS + FRESHNESS");
  console.log("=".repeat(78));

  const rows = svcRows.length > 0 ? svcRows : anonRows;
  if (rows.length === 0) {
    console.log("sr_zones_v1 is EMPTY right now.");
  } else {
    console.log("\nid | price | type | touches | rejWicks | reactStr | source | last_touch_ts | updated_at");
    for (const r of rows.slice(0, 40)) {
      console.log(
        `${String(r.id).padStart(4)} | ${String(r.price).padStart(7)} | ${r.type.padEnd(10)} | ${String(r.touches).padStart(7)} | ${String(r.rejection_wicks).padStart(8)} | ${String(r.reaction_strength).padStart(8)} | ${String(r.source).padEnd(13)} | ${r.last_touch_ts ?? "null"} | ${r.updated_at ?? "null"}`,
      );
    }

    const updatedAts = rows.map((r) => r.updated_at).filter((x): x is string => Boolean(x));
    if (updatedAts.length > 0) {
      const sorted = [...updatedAts].sort();
      const oldest = sorted[0];
      const newest = sorted[sorted.length - 1];
      const ageH = (Date.now() - new Date(newest).getTime()) / 3_600_000;
      console.log(`\nupdated_at range: ${oldest}  ->  ${newest}`);
      console.log(`Newest write age: ${ageH.toFixed(2)}h ago`);
      const distinct = [...new Set(updatedAts)];
      console.log(`Distinct updated_at values: ${distinct.length}`);
      console.log("  (delete-then-insert wholesale replace => ONE distinct value == ONE refresh run)");
      for (const d of distinct.sort()) {
        console.log(`    ${d}  x${updatedAts.filter((u) => u === d).length} rows`);
      }
    } else {
      console.log("\nNo updated_at values present.");
    }
  }

  // ── (4) backend reachability, both URLs ─────────────────────────────────
  console.log("\n" + "=".repeat(78));
  console.log("(4) BACKEND srZones.getZones REACHABILITY (the current TIER_0 read path)");
  console.log("=".repeat(78));

  const bases = [
    { name: "EXPO_PUBLIC_RORK_API_BASE_URL", url: env.EXPO_PUBLIC_RORK_API_BASE_URL },
    { name: "EXPO_PUBLIC_RORK_FUNCTIONS_URL", url: env.EXPO_PUBLIC_RORK_FUNCTIONS_URL },
  ];

  for (const b of bases) {
    if (!b.url) {
      console.log(`\n${b.name}: NOT SET`);
      continue;
    }
    const target = `${b.url.replace(/\/$/, "")}/api/trpc/srZones.getZones?input=${encodeURIComponent(JSON.stringify({}))}`;
    console.log(`\n${b.name}`);
    console.log(`  GET ${target}`);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const resp = await fetch(target, { signal: ctrl.signal });
      clearTimeout(timer);
      const body = await resp.text();
      console.log(`  HTTP ${resp.status} ${resp.statusText}`);
      console.log(`  body[0:400]: ${body.slice(0, 400)}`);
    } catch (e) {
      console.log(`  FETCH THREW: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log("Phase A2 (corrected) complete.");
  console.log("=".repeat(78));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
