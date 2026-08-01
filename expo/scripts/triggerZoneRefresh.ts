/**
 * ITEM 2 — TRIGGER THE sr_zones_v1 REFRESH WRITE AGAINST PRODUCTION.
 *
 * The B2(b) pagination fix lives on the backend WRITE path (srZones.refreshZones).
 * There is no scheduler, so it has never run against production. This script:
 *
 *   1. Reads the CURRENT sr_zones_v1 state directly from Supabase (anon + service
 *      control read) — row count, min/max last_touch_ts, count >= 0.3.
 *   2. Attempts the backend `srZones.refreshZones` mutation on EVERY configured
 *      base URL, pasting the raw HTTP status and body for each.
 *   3. Re-reads sr_zones_v1 and reports the post-refresh state.
 *
 * It does NOT silently substitute a local recompute for the backend trigger. If
 * the backend is unreachable, that is reported plainly as the result — because
 * "the fix cannot be triggered in production" is itself the finding that decides
 * whether B2(d) is urgent or advisory.
 *
 * DATA-SOURCE RULE: the zone READ is direct Supabase anon. The backend appears
 * here ONLY as the service-role WRITE trigger under test — never in a read path.
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
const SUPA_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPA_URL || !ANON) {
  console.error("Missing Supabase URL / anon key");
  process.exit(1);
}

const anon: SupabaseClient = createClient(SUPA_URL, ANON, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const svc: SupabaseClient | null = SERVICE
  ? createClient(SUPA_URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

const CONSUMER_THRESHOLD = 0.3;
const EXPIRY_HOURS = 96;
const ALWAYS_FRESH = new Set(["PIVOT", "PREV_DAY", "ASIAN_RANGE", "ORH_ORL", "WEEKLY", "SESSION_BLOCK"]);

interface ZoneRow {
  price: number;
  type: string;
  touches: number;
  reaction_strength: number;
  source: string;
  last_touch_ts: string | null;
  updated_at: string | null;
}

async function readZones(label: string, client: SupabaseClient): Promise<ZoneRow[]> {
  const res = await client
    .from("sr_zones_v1")
    .select("price, type, touches, reaction_strength, source, last_touch_ts, updated_at")
    .order("reaction_strength", { ascending: false })
    .limit(200);
  if (res.error) {
    console.log(`  [${label}] READ FAILED: ${res.error.message} (code=${res.error.code ?? "-"})`);
    return [];
  }
  return (res.data ?? []) as ZoneRow[];
}

function reportZones(rows: ZoneRow[]): void {
  const now = Date.now();
  console.log(`  row count = ${rows.length}`);
  if (rows.length === 0) {
    console.log("  (table empty)");
    return;
  }
  const ts = rows.map((r) => r.last_touch_ts).filter((t): t is string => typeof t === "string" && !!t);
  if (ts.length > 0) {
    ts.sort();
    console.log(`  min(last_touch_ts) = ${ts[0]}`);
    console.log(`  max(last_touch_ts) = ${ts[ts.length - 1]}`);
    const ageMin = (now - new Date(ts[ts.length - 1]).getTime()) / 3_600_000;
    const ageMax = (now - new Date(ts[0]).getTime()) / 3_600_000;
    console.log(`  age of NEWEST touch = ${ageMin.toFixed(2)}h   age of OLDEST = ${ageMax.toFixed(2)}h`);
  } else {
    console.log(`  min/max(last_touch_ts) = ALL NULL`);
  }
  const upd = rows.map((r) => r.updated_at).filter((t): t is string => typeof t === "string" && !!t).sort();
  if (upd.length > 0) {
    console.log(`  min/max(updated_at) = ${upd[0]} .. ${upd[upd.length - 1]}`);
  }

  const strong = rows.filter((r) => Number(r.reaction_strength) >= CONSUMER_THRESHOLD);
  const maxRs = Math.max(...rows.map((r) => Number(r.reaction_strength)));
  console.log(`  reactionStrength >= ${CONSUMER_THRESHOLD}: ${strong.length} of ${rows.length}   (max observed = ${maxRs.toFixed(3)})`);

  const unexpired = rows.filter((r) => {
    if (ALWAYS_FRESH.has(r.source)) return true;
    if (!r.last_touch_ts) return false;
    return (now - new Date(r.last_touch_ts).getTime()) / 3_600_000 <= EXPIRY_HOURS;
  });
  console.log(`  unexpired (EXPIRY_HOURS=${EXPIRY_HOURS} or always-fresh source): ${unexpired.length} of ${rows.length}`);
  const usable = unexpired.filter((r) => Number(r.reaction_strength) >= CONSUMER_THRESHOLD);
  console.log(`  USABLE by the engine (unexpired AND >= ${CONSUMER_THRESHOLD}): ${usable.length}`);

  console.log(`\n  ${"price".padStart(9)} ${"type".padEnd(11)} ${"src".padEnd(13)} ${"touch".padStart(6)} ${"rs".padStart(7)}  last_touch_ts`);
  for (const r of rows.slice(0, 20)) {
    console.log(
      `  ${String(r.price).padStart(9)} ${String(r.type).padEnd(11)} ${String(r.source).padEnd(13)} ${String(r.touches).padStart(6)} ${Number(r.reaction_strength).toFixed(3).padStart(7)}  ${r.last_touch_ts ?? "NULL"}`,
    );
  }
}

async function tryBackend(baseUrl: string): Promise<{ ok: boolean; status: number | string; body: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/trpc/srZones.refreshZones`;
  console.log(`\n  POST ${url}`);
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    console.log(`    HTTP ${res.status} ${res.statusText}  (${Date.now() - started}ms)`);
    console.log(`    body: ${text.slice(0, 600)}`);
    return { ok: res.ok, status: res.status, body: text };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`    NETWORK FAILURE after ${Date.now() - started}ms: ${msg}`);
    return { ok: false, status: "network-error", body: msg };
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(78));
  console.log("ITEM 2 — TRIGGER sr_zones_v1 REFRESH WRITE IN PRODUCTION");
  console.log(`run at ${new Date().toISOString()}`);
  console.log("=".repeat(78));

  console.log("\n[1] PRE-REFRESH STATE of sr_zones_v1 (direct Supabase, anon key)");
  const before = await readZones("anon", anon);
  reportZones(before);

  if (svc) {
    const beforeSvc = await readZones("service", svc);
    console.log(`\n  service-role control read: ${beforeSvc.length} rows (anon saw ${before.length}) -> ${beforeSvc.length === before.length ? "MATCH, anon is not filtered" : "MISMATCH"}`);
  }

  console.log("\n" + "=".repeat(78));
  console.log("[2] ATTEMPT THE BACKEND REFRESH WRITE (srZones.refreshZones)");
  console.log("=".repeat(78));

  const candidates: string[] = [];
  for (const key of ["EXPO_PUBLIC_RORK_API_BASE_URL", "EXPO_PUBLIC_RORK_FUNCTIONS_URL"]) {
    const v = env[key];
    if (v) {
      const norm = v.trim().replace(/\/+$/, "").replace(/\/api\/trpc$/, "").replace(/\/api$/, "");
      console.log(`  candidate from ${key}: ${norm}`);
      if (!candidates.includes(norm)) candidates.push(norm);
    } else {
      console.log(`  ${key} is NOT SET`);
    }
  }

  let anySuccess = false;
  const results: { url: string; status: number | string; body: string }[] = [];
  for (const base of candidates) {
    const r = await tryBackend(base);
    results.push({ url: base, status: r.status, body: r.body.slice(0, 300) });
    if (r.ok) anySuccess = true;
  }

  console.log("\n  BACKEND TRIGGER RESULT SUMMARY:");
  for (const r of results) {
    console.log(`    ${r.url} -> ${r.status}`);
  }
  console.log(`  ANY SUCCESS: ${anySuccess ? "YES" : "NO"}`);

  console.log("\n" + "=".repeat(78));
  console.log("[3] POST-REFRESH STATE of sr_zones_v1 (direct Supabase, anon key)");
  console.log("=".repeat(78));
  const after = await readZones("anon", anon);
  reportZones(after);

  console.log("\n" + "=".repeat(78));
  console.log("VERDICT");
  console.log("=".repeat(78));
  if (!anySuccess) {
    console.log("  The B2(b) pagination fix CANNOT be triggered in production:");
    console.log("  every configured backend base URL failed. sr_zones_v1 is unchanged.");
    console.log("  => B2(d) scheduling is URGENT, not advisory.");
  } else if (after.length === before.length && after.length > 0 && after[0].updated_at === before[0]?.updated_at) {
    console.log("  Backend responded OK but sr_zones_v1 did NOT change — investigate the");
    console.log("  route's internal failure path (compute returned null / upsert failed).");
  } else {
    console.log("  Backend refresh executed and sr_zones_v1 changed. See [3] for the new state.");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
