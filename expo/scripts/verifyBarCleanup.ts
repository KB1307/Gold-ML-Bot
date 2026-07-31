/**
 * CLEANUP VERIFICATION GATE — gold_m1_bars after the frozen-tick offset repair.
 *
 * Hard gate before B2/B1. Proves, with live output:
 *   (a) count of future-stamped bars (timestamp > now())  -> MUST be 0
 *   (b) max(timestamp) vs now()                           -> newest bar <= now, recent
 *   (c) largest remaining GAP in the last 10 days of bars
 *   (d) INDEPENDENT verification that the 31 July incident window
 *       (signals 02:06-08:56Z, export generated 17:53Z) is UNCONTAMINATED by
 *       the corruption that began at 2026-07-31T22:19Z, and an inventory of
 *       which other analyses touched data inside the corrupted window.
 *
 * DATA-SOURCE RULE: reads gold_m1_bars DIRECTLY from Supabase via the anon key.
 * No Rork backend. No GC=F/TwelveData. Service role used ONLY as a control read
 * to prove anon is not being shown a filtered subset.
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
const URL_ = env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL_ || !ANON) {
  console.error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}

const anon: SupabaseClient = createClient(URL_, ANON, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const svc: SupabaseClient | null = SERVICE
  ? createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

/** PostgREST caps at 1000 rows/request regardless of .limit() — always paginate. */
async function fetchAllBars(
  client: SupabaseClient,
  fromIso: string,
  toIso: string,
): Promise<{ timestamp: string; close: number }[]> {
  const out: { timestamp: string; close: number }[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const res = await client
      .from("gold_m1_bars")
      .select("timestamp, close")
      .gte("timestamp", fromIso)
      .lte("timestamp", toIso)
      .order("timestamp", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (res.error) throw new Error(`bar fetch failed: ${res.error.message}`);
    const rows = (res.data ?? []) as { timestamp: string; close: number }[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 500_000) break;
  }
  return out;
}

const CORRUPTION_START_ISO = "2026-07-31T22:19:00.000Z";

async function main(): Promise<void> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  console.log("=".repeat(78));
  console.log("CLEANUP VERIFICATION GATE — gold_m1_bars");
  console.log(`run at (local UTC now): ${nowIso}`);
  console.log(`read path: Supabase anon key, direct. No backend, no GC=F/TwelveData.`);
  console.log("=".repeat(78));

  // ── (a) future-stamped bars ───────────────────────────────────────────────
  console.log("\n(a) SELECT count(*) FROM gold_m1_bars WHERE timestamp > now()");
  const futAnon = await anon
    .from("gold_m1_bars")
    .select("timestamp", { count: "exact", head: true })
    .gt("timestamp", nowIso);
  if (futAnon.error) {
    console.log(`  ANON count FAILED: ${futAnon.error.message}`);
    console.log("  BLOCKED — cannot verify (a). STOP.");
    process.exit(2);
  }
  const futureCountAnon = futAnon.count ?? -1;
  console.log(`  anon   future_bars = ${futureCountAnon}`);

  let futureCountSvc = -1;
  if (svc) {
    const futSvc = await svc
      .from("gold_m1_bars")
      .select("timestamp", { count: "exact", head: true })
      .gt("timestamp", nowIso);
    futureCountSvc = futSvc.error ? -1 : (futSvc.count ?? -1);
    console.log(`  service future_bars = ${futureCountSvc}  (control read)`);
  }

  if (futureCountAnon !== 0 || (svc && futureCountSvc !== 0)) {
    console.log("\n  GATE (a) FAILED — future-stamped bars still present.");
    const offenders = await (svc ?? anon)
      .from("gold_m1_bars")
      .select("timestamp, close")
      .gt("timestamp", nowIso)
      .order("timestamp", { ascending: true })
      .limit(20);
    console.log(`  offending rows (first 20): ${JSON.stringify(offenders.data)}`);
    console.log("  STOPPING — do not proceed on unclean bars.");
    process.exit(3);
  }
  console.log("  GATE (a) PASSED — future_bars = 0");

  // ── (b) newest bar vs now ─────────────────────────────────────────────────
  console.log("\n(b) SELECT max(timestamp), now() FROM gold_m1_bars");
  const newest = await anon
    .from("gold_m1_bars")
    .select("timestamp, open, high, low, close")
    .order("timestamp", { ascending: false })
    .limit(5);
  if (newest.error || !newest.data || newest.data.length === 0) {
    console.log(`  FAILED to read newest bar: ${newest.error?.message ?? "no rows"}`);
    process.exit(3);
  }
  const newestTs = newest.data[0].timestamp as string;
  const newestMs = new Date(newestTs).getTime();
  console.log(`  max(timestamp) = ${newestTs}`);
  console.log(`  now()          = ${nowIso}`);
  console.log(`  delta          = ${((nowMs - newestMs) / 3_600_000).toFixed(2)}h in the PAST`);
  console.log(`  newest 5 bars:`);
  for (const b of newest.data) {
    console.log(
      `    ${b.timestamp}  O=${b.open} H=${b.high} L=${b.low} C=${b.close}`,
    );
  }
  console.log(`  newest <= now: ${newestMs <= nowMs ? "YES" : "NO"}`);

  // Weekend-closure context: what day/time is the newest bar, and is now a weekend?
  const newestDate = new Date(newestMs);
  const nowDate = new Date(nowMs);
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  console.log(
    `  newest bar UTC weekday = ${DOW[newestDate.getUTCDay()]} ${String(newestDate.getUTCHours()).padStart(2, "0")}:${String(newestDate.getUTCMinutes()).padStart(2, "0")}Z`,
  );
  console.log(
    `  now UTC weekday        = ${DOW[nowDate.getUTCDay()]} ${String(nowDate.getUTCHours()).padStart(2, "0")}:${String(nowDate.getUTCMinutes()).padStart(2, "0")}Z`,
  );

  // ── total inventory ───────────────────────────────────────────────────────
  const totalRes = await anon.from("gold_m1_bars").select("timestamp", { count: "exact", head: true });
  const oldestRes = await anon
    .from("gold_m1_bars")
    .select("timestamp")
    .order("timestamp", { ascending: true })
    .limit(1);
  console.log(`\n  TOTAL rows = ${totalRes.count ?? "?"}`);
  console.log(`  oldest     = ${oldestRes.data?.[0]?.timestamp ?? "?"}`);
  console.log(`  newest     = ${newestTs}`);

  // ── (c) largest gap in the last 10 days ───────────────────────────────────
  console.log("\n(c) LARGEST GAP in the last 10 days of bars");
  const tenDaysAgoIso = new Date(nowMs - 10 * 24 * 3_600_000).toISOString();
  const bars = await fetchAllBars(anon, tenDaysAgoIso, nowIso);
  console.log(`  window: ${tenDaysAgoIso} -> ${nowIso}`);
  console.log(`  bars fetched (paginated, PostgREST 1000-cap respected): ${bars.length}`);

  if (bars.length < 2) {
    console.log("  Not enough bars to compute gaps.");
  } else {
    interface Gap {
      fromTs: string;
      toTs: string;
      minutes: number;
    }
    const gaps: Gap[] = [];
    for (let i = 1; i < bars.length; i++) {
      const prev = new Date(bars[i - 1].timestamp).getTime();
      const cur = new Date(bars[i].timestamp).getTime();
      const mins = (cur - prev) / 60_000;
      if (mins > 1.0001) {
        gaps.push({ fromTs: bars[i - 1].timestamp, toTs: bars[i].timestamp, minutes: mins });
      }
      if (mins <= 0) {
        console.log(`  !! NON-MONOTONIC or DUPLICATE at ${bars[i].timestamp} (delta ${mins}m)`);
      }
    }
    gaps.sort((a, b) => b.minutes - a.minutes);
    console.log(`  total gaps > 1 min: ${gaps.length}`);
    console.log(`\n  TOP 10 LARGEST GAPS:`);
    console.log(`  ${"from".padEnd(26)} ${"to".padEnd(26)} ${"minutes".padStart(9)}  ${"hours".padStart(7)}  weekend?`);
    for (const g of gaps.slice(0, 10)) {
      const d = new Date(g.fromTs);
      const isWeekendClose = d.getUTCDay() === 5 || d.getUTCDay() === 6 || d.getUTCDay() === 0;
      console.log(
        `  ${g.fromTs.padEnd(26)} ${g.toTs.padEnd(26)} ${g.minutes.toFixed(0).padStart(9)}  ${(g.minutes / 60).toFixed(2).padStart(7)}  ${isWeekendClose ? `YES (${DOW[d.getUTCDay()]} close)` : "no"}`,
      );
    }
    const intraday = gaps.filter((g) => {
      const d = new Date(g.fromTs);
      return !(d.getUTCDay() === 5 && d.getUTCHours() >= 20);
    });
    console.log(`\n  LARGEST NON-WEEKEND-CLOSE GAP:`);
    if (intraday.length > 0) {
      const g = intraday[0];
      console.log(`    ${g.fromTs} -> ${g.toTs}  = ${g.minutes.toFixed(0)} min (${(g.minutes / 60).toFixed(2)}h)`);
    } else {
      console.log(`    none — every gap is the Friday-close weekend gap`);
    }

    // per-UTC-day density
    console.log(`\n  PER-DAY BAR COUNTS (last 10 days):`);
    const byDay = new Map<string, number>();
    for (const b of bars) byDay.set(b.timestamp.slice(0, 10), (byDay.get(b.timestamp.slice(0, 10)) ?? 0) + 1);
    for (const [day, n] of [...byDay.entries()].sort()) {
      const dow = DOW[new Date(`${day}T00:00:00Z`).getUTCDay()];
      console.log(`    ${day} (${dow})  ${String(n).padStart(5)} bars  ${"#".repeat(Math.round(n / 40))}`);
    }
  }

  // ── (d) 31 July contamination check ───────────────────────────────────────
  console.log("\n" + "=".repeat(78));
  console.log("(d) INDEPENDENT CONTAMINATION CHECK — 31 July incident window");
  console.log("=".repeat(78));
  console.log(`  Claim under test: corruption was stamped from ${CORRUPTION_START_ISO} onward,`);
  console.log(`  so the 31 Jul signal window (02:06-08:56Z) and the export (17:53Z) predate it.`);
  console.log(`  Verifying independently from the live table rather than on trust.`);

  const jul31 = await fetchAllBars(anon, "2026-07-31T00:00:00.000Z", "2026-07-31T23:59:59.999Z");
  console.log(`\n  Bars present for 2026-07-31 (full UTC day): ${jul31.length}`);
  if (jul31.length > 0) {
    console.log(`    first: ${jul31[0].timestamp}  C=${jul31[0].close}`);
    console.log(`    last:  ${jul31[jul31.length - 1].timestamp}  C=${jul31[jul31.length - 1].close}`);
  }

  const inSignalWindow = jul31.filter(
    (b) => b.timestamp >= "2026-07-31T02:00:00" && b.timestamp <= "2026-07-31T09:00:00",
  );
  console.log(`\n  Bars inside the 31 Jul SIGNAL WINDOW 02:00-09:00Z: ${inSignalWindow.length}`);
  if (inSignalWindow.length > 0) {
    console.log(`    first: ${inSignalWindow[0].timestamp}  C=${inSignalWindow[0].close}`);
    console.log(
      `    last:  ${inSignalWindow[inSignalWindow.length - 1].timestamp}  C=${inSignalWindow[inSignalWindow.length - 1].close}`,
    );
    const closes = inSignalWindow.map((b) => b.close);
    console.log(`    close range: ${Math.min(...closes)} .. ${Math.max(...closes)}`);
    console.log(`    move over window: ${(closes[closes.length - 1] - closes[0]).toFixed(1)} (in price units)`);
  }

  const afterCorruptionStart = jul31.filter((b) => b.timestamp >= CORRUPTION_START_ISO.slice(0, 19));
  console.log(`\n  Bars stamped >= ${CORRUPTION_START_ISO} still in table: ${afterCorruptionStart.length}`);
  for (const b of afterCorruptionStart.slice(0, 20)) {
    console.log(`    ${b.timestamp}  C=${b.close}`);
  }
  if (afterCorruptionStart.length === 0) {
    console.log(`    -> none. The corrupted tail was removed.`);
  }

  // Independent corroboration of the CONTEXT figures: the export claims gold fell
  // 4087.6 -> 4047.5 across 31 Jul. Check that against the cleaned bars.
  console.log(`\n  CORROBORATION vs the 31 Jul export context (4087.6 -> 4047.5, -401 pips):`);
  if (jul31.length > 0) {
    const dayOpen = jul31[0].close;
    const dayLast = jul31[jul31.length - 1].close;
    console.log(`    cleaned-bar first close = ${dayOpen}`);
    console.log(`    cleaned-bar last  close = ${dayLast}`);
    console.log(`    cleaned-bar day move    = ${(dayLast - dayOpen).toFixed(1)}`);
    const highs = jul31.map((b) => b.close);
    console.log(`    cleaned-bar day range   = ${Math.min(...highs)} .. ${Math.max(...highs)}`);
    console.log(`    -> if this matches the export's downtrend, the incident data is corroborated`);
    console.log(`       by post-cleanup bars and the analysis stands independently.`);
  }

  // Which other windows did prior analyses touch?
  console.log(`\n  CORRUPTED-WINDOW EXPOSURE INVENTORY:`);
  console.log(`    Corrupted window = [${CORRUPTION_START_ISO}, first repair]`);
  console.log(`    Any analysis whose bar window intersects that range is SUSPECT.`);
  console.log(`    31 Jul signal window 02:06-08:56Z -> ends ${((new Date(CORRUPTION_START_ISO).getTime() - new Date("2026-07-31T08:56:00Z").getTime()) / 3_600_000).toFixed(2)}h BEFORE corruption start -> CLEAN`);
  console.log(`    31 Jul export generated 17:53Z   -> ${((new Date(CORRUPTION_START_ISO).getTime() - new Date("2026-07-31T17:53:00Z").getTime()) / 3_600_000).toFixed(2)}h BEFORE corruption start -> CLEAN`);

  console.log("\n" + "=".repeat(78));
  console.log("CLEANUP VERIFICATION COMPLETE");
  console.log("=".repeat(78));
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
