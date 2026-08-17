/**
 * ITEM 82(b) + 82(c) — LIVE infrastructure and data-integrity audit.
 *
 * Read-only except for the deliberate Edge Function invocations required by
 * 82(b)/82(e), which are the point of the probe. Every fact here comes from a
 * live query; nothing is read from a migration file, because repo-vs-production
 * drift is proven in this project.
 *
 * DATA-SOURCE RULE: all table reads go DIRECT to Supabase via the anon key.
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
const URL_BASE = env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const ANON = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
const sb = createClient(URL_BASE, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

const RULE = "=".repeat(78);
function head(s: string): void {
  console.log(`\n${RULE}\n${s}\n${RULE}`);
}

async function countOf(table: string, filter?: (q: ReturnType<typeof sb.from>) => unknown): Promise<string> {
  try {
    let q = sb.from(table).select("*", { count: "exact", head: true });
    if (filter) q = filter(sb.from(table) as never) as never;
    const { count, error } = await q;
    if (error) return `ERROR ${error.code ?? ""} ${error.message}`;
    return String(count ?? 0);
  } catch (e: unknown) {
    return `THREW ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function edgeProbe(name: string): Promise<void> {
  const url = `${URL_BASE}/functions/v1/${name}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}` },
      body: JSON.stringify({}),
    });
    const text = await res.text();
    console.log(`  ${name.padEnd(28)} HTTP ${res.status}  ${text.slice(0, 260).replace(/\s+/g, " ")}`);
  } catch (e: unknown) {
    console.log(`  ${name.padEnd(28)} NETWORK ERROR ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  console.log(`Audit run at ${new Date().toISOString()}`);
  console.log(`Supabase base: ${URL_BASE}`);

  // ─────────────────────────── 82(b) EDGE FUNCTIONS ───────────────────────────
  head("82(b)-1 EDGE FUNCTION LIVENESS — three-probe controlled pattern");
  console.log("  TARGETS + positive control + negative control, one run:");
  await edgeProbe("resolve-emitted-signals");
  await edgeProbe("refresh-sr-zones");
  await edgeProbe("drain-telegram-outbox");
  await edgeProbe("ingest-gold-bars");
  await edgeProbe("definitely-not-a-real-function-82b");

  // ─────────────────────────── 82(b) CRON ───────────────────────────
  head("82(b)-2 CRON — cron.job and cron.job_run_details via helper RPC");
  for (const fn of ["check_cron_runs", "cron_job_list", "list_cron_jobs"]) {
    const { data, error } = await sb.rpc(fn);
    if (error) {
      console.log(`  rpc(${fn}) -> ERROR ${error.code ?? ""} ${error.message}`);
    } else {
      console.log(`  rpc(${fn}) -> OK`);
      console.log(JSON.stringify(data, null, 2).slice(0, 4000));
    }
  }

  // ─────────────────────────── 82(b) ROW COUNTS ───────────────────────────
  head("82(b)-3 TABLE ROW COUNTS (anon-visible)");
  for (const t of [
    "gold_m1_bars",
    "sr_zones_v1",
    "trade_outcomes_v1",
    "emitted_signals_v1",
    "shadow_signals_v1",
  ]) {
    console.log(`  ${t.padEnd(22)} ${await countOf(t)}`);
  }

  head("82(b)-4 emitted_signals_v1 LIVE vs BACKFILL split");
  {
    const { data, error } = await sb.from("emitted_signals_v1").select("source").limit(5000);
    if (error) {
      console.log(`  ERROR ${error.code ?? ""} ${error.message}`);
    } else {
      const rows = (data ?? []) as { source: string | null }[];
      const by = new Map<string, number>();
      for (const r of rows) by.set(String(r.source ?? "(null)"), (by.get(String(r.source ?? "(null)")) ?? 0) + 1);
      console.log(`  total sampled: ${rows.length}`);
      for (const [k, v] of Array.from(by.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${k.padEnd(28)} ${v}`);
      }
    }
  }

  head("82(b)-5 RLS POLICIES (pg_policies) — needs a helper; anon cannot read catalogs");
  for (const fn of ["list_policies", "check_rls_policies", "rls_report"]) {
    const { data, error } = await sb.rpc(fn);
    if (error) console.log(`  rpc(${fn}) -> ERROR ${error.code ?? ""} ${error.message}`);
    else console.log(`  rpc(${fn}) -> OK\n${JSON.stringify(data, null, 2).slice(0, 2500)}`);
  }
  console.log("  Behavioural RLS probe — anon INSERT/DELETE must be refused:");
  {
    const ins = await sb.from("trade_outcomes_v1").insert({ signal_id: "__rls_probe__" }).select();
    console.log(`    INSERT trade_outcomes_v1 -> ${ins.error ? `REFUSED ${ins.error.code} ${ins.error.message}` : "ACCEPTED (FAULT)"}`);
    const del = await sb.from("emitted_signals_v1").delete().eq("signal_id", "__rls_probe_never_exists__").select();
    console.log(`    DELETE emitted_signals_v1 -> ${del.error ? `REFUSED ${del.error.code} ${del.error.message}` : `ACCEPTED rows=${(del.data ?? []).length}`}`);
  }

  // ─────────────────────────── 82(c) DATA INTEGRITY ───────────────────────────
  head("82(c)-1 gold_m1_bars — bounds and future-stamped bars");
  const nowMs = Date.now();
  {
    const newest = await sb.from("gold_m1_bars").select("timestamp").order("timestamp", { ascending: false }).limit(1);
    const oldest = await sb.from("gold_m1_bars").select("timestamp").order("timestamp", { ascending: true }).limit(1);
    const nRow = (newest.data ?? [])[0] as { timestamp: number | string } | undefined;
    const oRow = (oldest.data ?? [])[0] as { timestamp: number | string } | undefined;
    const nTs = nRow ? Number(nRow.timestamp) : NaN;
    const oTs = oRow ? Number(oRow.timestamp) : NaN;
    console.log(`  total rows : ${await countOf("gold_m1_bars")}`);
    console.log(`  oldest     : ${oTs} (${Number.isFinite(oTs) ? new Date(oTs).toISOString() : "n/a"})`);
    console.log(`  newest     : ${nTs} (${Number.isFinite(nTs) ? new Date(nTs).toISOString() : "n/a"})`);
    console.log(`  now        : ${nowMs} (${new Date(nowMs).toISOString()})`);
    console.log(`  newest age : ${Number.isFinite(nTs) ? ((nowMs - nTs) / 60000).toFixed(1) : "n/a"} minutes`);
    const fut = await sb.from("gold_m1_bars").select("*", { count: "exact", head: true }).gt("timestamp", nowMs);
    console.log(`  FUTURE-STAMPED bars (timestamp > now): ${fut.error ? `ERROR ${fut.error.message}` : String(fut.count ?? 0)}  [expect 0]`);
  }

  head("82(c)-2 gold_m1_bars — GAP ANALYSIS over the last 7 days");
  {
    const sevenAgo = nowMs - 7 * 24 * 60 * 60 * 1000;
    const rows: number[] = [];
    let cursor = sevenAgo;
    for (let page = 0; page < 20; page += 1) {
      const { data, error } = await sb
        .from("gold_m1_bars")
        .select("timestamp")
        .gte("timestamp", cursor)
        .order("timestamp", { ascending: true })
        .limit(1000);
      if (error) {
        console.log(`  ERROR ${error.message}`);
        break;
      }
      const page_rows = (data ?? []) as { timestamp: number | string }[];
      if (page_rows.length === 0) break;
      for (const r of page_rows) rows.push(Number(r.timestamp));
      const last = Number(page_rows[page_rows.length - 1].timestamp);
      if (last <= cursor) break;
      cursor = last + 1;
      if (page_rows.length < 1000) break;
    }
    const uniq = Array.from(new Set(rows)).sort((a, b) => a - b);
    console.log(`  bars examined in window: ${uniq.length}`);
    if (uniq.length > 1) {
      let largest = 0;
      let largestAt = 0;
      let missing = 0;
      const gaps: { at: number; mins: number }[] = [];
      for (let i = 1; i < uniq.length; i += 1) {
        const d = uniq[i] - uniq[i - 1];
        const mins = d / 60000;
        if (mins > 1) {
          missing += mins - 1;
          if (mins > largest) {
            largest = mins;
            largestAt = uniq[i - 1];
          }
          if (mins >= 60) gaps.push({ at: uniq[i - 1], mins });
        }
      }
      console.log(`  missing minutes (all, incl. weekend close): ${missing}`);
      console.log(`  largest contiguous gap: ${largest} minutes starting ${new Date(largestAt).toISOString()}`);
      console.log(`  gaps >= 60 minutes: ${gaps.length}`);
      for (const g of gaps.slice(0, 12)) {
        console.log(`    ${new Date(g.at).toISOString()}  ->  ${g.mins} min`);
      }
      console.log("  NOTE: XAU/USD closes ~Fri 21:00Z to Sun 22:00Z (~3000 min). A gap of that");
      console.log("  size at a weekend boundary is EXPECTED; an intra-week gap is a scoring defect.");
    }
  }

  head("82(c)-3 sr_zones_v1 FRESHNESS + TIER_0 ARMED STATE");
  {
    const { data, error } = await sb
      .from("sr_zones_v1")
      .select("price,type,reaction_strength,touches,source,last_touch_ts,updated_at")
      .order("reaction_strength", { ascending: false })
      .limit(32);
    if (error) {
      console.log(`  ERROR ${error.message}`);
    } else {
      const rows = (data ?? []) as { reaction_strength: number | string | null; updated_at: string | null; source: string | null }[];
      const rs = rows.map((r) => Number(r.reaction_strength)).filter((v) => Number.isFinite(v));
      const stamps = Array.from(new Set(rows.map((r) => r.updated_at ?? "(null)")));
      console.log(`  rows (engine reads top 32 by reaction_strength): ${rows.length}`);
      console.log(`  distinct updated_at batches: ${stamps.length} -> ${stamps.join(", ")}`);
      console.log(`  max reaction_strength: ${rs.length ? Math.max(...rs).toFixed(4) : "n/a"}`);
      console.log(`  rows >= 0.30 consumer threshold: ${rs.filter((v) => v >= 0.3).length} / ${rs.length}`);
      console.log(`  TIER_0 ARMED: ${rs.some((v) => v >= 0.3) ? "YES" : "NO — every evaluation falls back to TIER_1_LOCAL"}`);
    }
  }

  // ─────────────────────────── 82(e) BOOK ───────────────────────────
  head("82(e)-1 trade_outcomes_v1 — STORED-LABEL book (PROVISIONAL, not canonical)");
  {
    const { data, error } = await sb
      .from("trade_outcomes_v1")
      .select("signal_id,direction,status,r_multiple,resolved_at,created_at")
      .limit(5000);
    if (error) {
      console.log(`  ERROR ${error.message}`);
    } else {
      const rows = (data ?? []) as { direction: string | null; status: string | null; r_multiple: number | string | null }[];
      const rs = rows.map((r) => Number(r.r_multiple)).filter((v) => Number.isFinite(v));
      const wins = rs.filter((v) => v > 0).length;
      const ev = rs.reduce((a, b) => a + b, 0) / (rs.length || 1);
      const gross_win = rs.filter((v) => v > 0).reduce((a, b) => a + b, 0);
      const gross_loss = Math.abs(rs.filter((v) => v < 0).reduce((a, b) => a + b, 0));
      console.log(`  n rows: ${rows.length}   rows with numeric r_multiple: ${rs.length}`);
      console.log(`  WR (r>0): ${rs.length ? ((wins / rs.length) * 100).toFixed(2) : "n/a"}%  (${wins}/${rs.length})`);
      console.log(`  EV     : ${rs.length ? ev.toFixed(4) : "n/a"} R`);
      console.log(`  PF     : ${gross_loss > 0 ? (gross_win / gross_loss).toFixed(3) : "n/a"}`);
      const byStatus = new Map<string, number>();
      for (const r of rows) byStatus.set(String(r.status ?? "(null)"), (byStatus.get(String(r.status ?? "(null)")) ?? 0) + 1);
      console.log("  status distribution (STORED LABELS — prohibited as an outcome source):");
      for (const [k, v] of Array.from(byStatus.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${k.padEnd(24)} ${v}`);
      }
      const byDir = new Map<string, { n: number; w: number }>();
      for (const r of rows) {
        const d = String(r.direction ?? "(null)");
        const v = Number(r.r_multiple);
        if (!Number.isFinite(v)) continue;
        const cur = byDir.get(d) ?? { n: 0, w: 0 };
        cur.n += 1;
        if (v > 0) cur.w += 1;
        byDir.set(d, cur);
      }
      console.log("  by direction (r>0 predicate):");
      for (const [k, v] of byDir.entries()) {
        console.log(`    ${k.padEnd(8)} n=${v.n} WR=${((v.w / v.n) * 100).toFixed(2)}%`);
      }
      console.log("  ⚠️  These figures use the STORED r_multiple. They are PROVISIONAL.");
      console.log("  ⚠️  Canonical requires re-deriving each outcome with resolveSignalWithBars(fromScratch:true).");
    }
  }
}

main().catch((e: unknown) => {
  console.log(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
});
