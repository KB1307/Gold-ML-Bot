/**
 * ITEM 82(c) + 82(e) — corrected probe.
 *
 * The first pass wrongly assumed `gold_m1_bars.timestamp` was epoch-ms and got
 * "date/time field value out of range". It is a timestamptz. Fixed here by
 * comparing ISO strings. Also lists trade_outcomes_v1 columns, since that table
 * has no `status` column (the first pass assumed one).
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
  const RULE = "=".repeat(78);
  const nowIso = new Date().toISOString();
  console.log(`probe at ${nowIso}`);

  console.log(`\n${RULE}\n82(c)-1 gold_m1_bars bounds + FUTURE-STAMPED count\n${RULE}`);
  {
    const newest = await sb.from("gold_m1_bars").select("timestamp").order("timestamp", { ascending: false }).limit(1);
    const oldest = await sb.from("gold_m1_bars").select("timestamp").order("timestamp", { ascending: true }).limit(1);
    console.log(`  newest: ${JSON.stringify((newest.data ?? [])[0] ?? null)}  err=${newest.error?.message ?? "none"}`);
    console.log(`  oldest: ${JSON.stringify((oldest.data ?? [])[0] ?? null)}  err=${oldest.error?.message ?? "none"}`);
    const fut = await sb.from("gold_m1_bars").select("*", { count: "exact", head: true }).gt("timestamp", nowIso);
    console.log(`  FUTURE-STAMPED (timestamp > now): ${fut.error ? `ERROR ${fut.error.message}` : String(fut.count ?? 0)}   [expect 0]`);
    const nRow = (newest.data ?? [])[0] as { timestamp: string } | undefined;
    if (nRow) {
      const ageMin = (Date.now() - new Date(nRow.timestamp).getTime()) / 60000;
      console.log(`  newest bar age: ${ageMin.toFixed(1)} minutes`);
    }
  }

  console.log(`\n${RULE}\n82(c)-2 GAP ANALYSIS last 7 days (intra-week gaps are scoring defects)\n${RULE}`);
  {
    const sinceIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const stamps: number[] = [];
    let cursor = sinceIso;
    for (let page = 0; page < 15; page += 1) {
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
      const rows = (data ?? []) as { timestamp: string }[];
      if (rows.length === 0) break;
      for (const r of rows) stamps.push(new Date(r.timestamp).getTime());
      const last = rows[rows.length - 1].timestamp;
      if (last === cursor) break;
      cursor = new Date(new Date(last).getTime() + 1).toISOString();
      if (rows.length < 1000) break;
    }
    const uniq = Array.from(new Set(stamps)).sort((a, b) => a - b);
    console.log(`  bars examined: ${uniq.length}`);
    console.log(`  window start : ${sinceIso}`);
    if (uniq.length > 1) {
      console.log(`  first bar    : ${new Date(uniq[0]).toISOString()}`);
      console.log(`  last bar     : ${new Date(uniq[uniq.length - 1]).toISOString()}`);
      let missing = 0;
      let largest = 0;
      let largestAt = 0;
      const big: { at: number; mins: number }[] = [];
      for (let i = 1; i < uniq.length; i += 1) {
        const mins = (uniq[i] - uniq[i - 1]) / 60000;
        if (mins > 1) {
          missing += mins - 1;
          if (mins > largest) {
            largest = mins;
            largestAt = uniq[i - 1];
          }
          if (mins >= 30) big.push({ at: uniq[i - 1], mins });
        }
      }
      console.log(`  total missing minutes: ${missing}`);
      console.log(`  largest gap: ${largest} min starting ${new Date(largestAt).toISOString()}`);
      console.log(`  gaps >= 30 min: ${big.length}`);
      for (const g of big.slice(0, 15)) {
        const d = new Date(g.at);
        console.log(`    ${d.toISOString()} (UTC dow=${d.getUTCDay()}) -> ${g.mins} min`);
      }
      console.log("  Weekend close (Fri ~21:00Z -> Sun ~22:00Z, ~3000 min) is EXPECTED.");
    }
  }

  console.log(`\n${RULE}\n82(e) trade_outcomes_v1 — real columns, then book\n${RULE}`);
  {
    const one = await sb.from("trade_outcomes_v1").select("*").limit(1);
    if (one.error) {
      console.log(`  ERROR ${one.error.message}`);
    } else {
      const row = (one.data ?? [])[0] as Record<string, unknown> | undefined;
      console.log(`  columns: ${row ? Object.keys(row).join(", ") : "(no rows)"}`);
    }
    const all = await sb.from("trade_outcomes_v1").select("*").limit(5000);
    if (all.error) {
      console.log(`  ERROR ${all.error.message}`);
      return;
    }
    const rows = (all.data ?? []) as Record<string, unknown>[];
    console.log(`  n rows: ${rows.length}`);
    const rKey = ["realized_r", "r_multiple", "r", "rMultiple", "net_r"].find((k) => rows.some((x) => x[k] !== undefined));
    console.log(`  R column detected: ${rKey ?? "NONE FOUND"}`);
    if (rKey) {
      const rs = rows.map((x) => Number(x[rKey])).filter((v) => Number.isFinite(v));
      const wins = rs.filter((v) => v > 0).length;
      const ev = rs.reduce((a, b) => a + b, 0) / (rs.length || 1);
      const gw = rs.filter((v) => v > 0).reduce((a, b) => a + b, 0);
      const gl = Math.abs(rs.filter((v) => v < 0).reduce((a, b) => a + b, 0));
      console.log(`  numeric R rows: ${rs.length}`);
      console.log(`  WR (R>0): ${((wins / (rs.length || 1)) * 100).toFixed(2)}% (${wins}/${rs.length})`);
      console.log(`  EV      : ${ev.toFixed(4)} R`);
      console.log(`  PF      : ${gl > 0 ? (gw / gl).toFixed(3) : "n/a"}`);
      console.log("  ⚠️  PROVISIONAL — derived from the STORED R column, not re-derived");
      console.log("  ⚠️  with resolveSignalWithBars(fromScratch:true). Canonical requires that.");
    }
    const resKey = "result";
    const byRes = new Map<string, number>();
    for (const x of rows) byRes.set(String(x[resKey] ?? "(null)"), (byRes.get(String(x[resKey] ?? "(null)")) ?? 0) + 1);
    console.log("  stored `result` label distribution (PROHIBITED as an outcome source):");
    for (const [k, v] of Array.from(byRes.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(24)} ${v}`);
    }
    const scratch = rows.filter((x) => x.is_scratch === true).length;
    console.log(`  is_scratch=true rows: ${scratch}`);
    const dirKey = ["direction", "side", "signal_type"].find((k) => rows.some((x) => x[k] !== undefined));
    if (dirKey && rKey) {
      const by = new Map<string, { n: number; w: number; sum: number }>();
      for (const x of rows) {
        const v = Number(x[rKey]);
        if (!Number.isFinite(v)) continue;
        const d = String(x[dirKey] ?? "(null)");
        const c = by.get(d) ?? { n: 0, w: 0, sum: 0 };
        c.n += 1;
        c.sum += v;
        if (v > 0) c.w += 1;
        by.set(d, c);
      }
      console.log("  by direction:");
      for (const [k, v] of by.entries()) {
        console.log(`    ${k.padEnd(8)} n=${v.n} WR=${((v.w / v.n) * 100).toFixed(2)}% EV=${(v.sum / v.n).toFixed(4)}R`);
      }
    }
  }
}

main().catch((e: unknown) => console.log(`FATAL: ${e instanceof Error ? e.message : String(e)}`));
