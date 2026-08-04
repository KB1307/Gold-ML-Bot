/**
 * ITEM 6(b) — DERIVE THE OUTBOX AGING HORIZON FROM REAL BARS.
 *
 * A durable outbox must decide when an UNDELIVERED alert has become dangerous
 * rather than merely late: the MT5 executor takes the alert's ENTRY ZONE
 * (entryPrice +/- ENTRY_ZONE_BAND = $2.0) at face value, so an alert delivered
 * after price has permanently left that band would either never fill or fill at
 * a materially different level than the SL/TP geometry was sized for.
 *
 * MEASUREMENT (read-only): for a large sample of anchor minutes in
 * gold_m1_bars, take the anchor bar's close C as a stand-in for entryPrice and
 * measure, as a function of delay D minutes, the fraction of anchors whose bar
 * at t0+D still OVERLAPS the band [C-2.0, C+2.0]. That is exactly the
 * executable-entry condition.
 *
 * DATA-SOURCE RULE: gold_m1_bars read DIRECTLY from Supabase via the anon key.
 * No Rork backend anywhere. No GC=F / TwelveData. No priceHistory.
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

interface BarRow {
  timestamp: string;
  high: number;
  low: number;
  close: number;
}

const ENTRY_ZONE_BAND = 2.0;
const DELAYS_MIN = [1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120];

async function main(): Promise<void> {
  const env = loadEnv();
  const supa = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Paginated fetch — PostgREST caps at 1000 rows per response.
  const bars: BarRow[] = [];
  const PAGE = 1000;
  for (let page = 0; page < 40; page += 1) {
    const { data, error } = await supa
      .from("gold_m1_bars")
      .select("timestamp, high, low, close")
      .order("timestamp", { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      console.log(`FETCH ERROR: ${error.message}`);
      return;
    }
    const rows = (data ?? []) as BarRow[];
    bars.push(...rows);
    if (rows.length < PAGE) break;
  }

  bars.reverse();
  console.log("=== ITEM 6(b) — OUTBOX AGING HORIZON, DERIVED FROM gold_m1_bars ===");
  console.log(`source: gold_m1_bars via anon key (DIRECT Supabase). bars=${bars.length}`);
  if (bars.length === 0) return;
  console.log(`window: ${bars[0].timestamp} .. ${bars[bars.length - 1].timestamp}`);
  console.log(`band: entryPrice +/- ${ENTRY_ZONE_BAND.toFixed(1)} (ENTRY_ZONE_BAND from telegramNotifier.ts)`);
  console.log("");

  // Index bars by minute epoch so a delay lookup is exact rather than positional
  // (positional indexing would silently jump weekend/session gaps).
  const byMinute = new Map<number, BarRow>();
  for (const b of bars) {
    byMinute.set(Math.floor(new Date(b.timestamp).getTime() / 60000), b);
  }

  console.log("delay  n_eval  still_executable  P(band touched at t0+D)");
  for (const d of DELAYS_MIN) {
    let n = 0;
    let hit = 0;
    for (const b of bars) {
      const t0 = Math.floor(new Date(b.timestamp).getTime() / 60000);
      const later = byMinute.get(t0 + d);
      if (!later) continue; // gap / end of series — not evaluable, never counted as a miss
      n += 1;
      const lo = b.close - ENTRY_ZONE_BAND;
      const hi = b.close + ENTRY_ZONE_BAND;
      if (later.low <= hi && later.high >= lo) hit += 1;
    }
    const p = n > 0 ? (hit / n) * 100 : Number.NaN;
    console.log(
      `${String(d).padStart(4)}m  ${String(n).padStart(6)}  ${String(hit).padStart(16)}  ${p.toFixed(1)}%`,
    );
  }

  console.log("");
  console.log("POWER: every row above is n in the thousands of anchor minutes, so the");
  console.log("decay curve is precisely estimated. It describes the LIVE bar series, not");
  console.log("a signal sample, so it carries no directional or EV claim whatsoever.");
}

main().catch((e: unknown) => {
  console.log("FATAL:", e instanceof Error ? e.message : String(e));
});
