/**
 * Step 2b verification: proves fetchHistoricalData now sources OHLC from
 * gold_m1_bars (Vantage MT5) as PRIMARY, and the matched-minute basis vs
 * the audit venue is now ~$0 (same table).
 *
 * Usage: bunx tsx expo/scripts/verifyBasisClosed.ts
 */
import { fetchHistoricalData } from "../lib/trpc";
import { createClient } from "@supabase/supabase-js";

async function main(): Promise<void> {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
  const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
  if (!url || !anon) {
    console.error("Missing env vars");
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  STEP 2b VERIFICATION — BASIS CLOSED (gold_m1_bars as PRIMARY)");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const toTime = Date.now();
  const fromTime = toTime - 2 * 60 * 60 * 1000; // 2h window

  // 1. Call the real fetchHistoricalData (now Supabase-primary)
  console.log("1. Calling fetchHistoricalData() (now Supabase-primary)...");
  const bars = await fetchHistoricalData({ fromTime, toTime, timeoutMs: 15000 });
  console.log(`   Returned ${bars.length} bars`);
  if (bars.length === 0) {
    console.error("❌ No bars returned — cannot verify");
    process.exit(1);
  }
  const sources = new Set(bars.map((b) => b.source ?? "untagged"));
  console.log(`   Source tags: ${[...sources].join(", ")}`);

  const primarySource = bars[0].source ?? "untagged";
  const isSupabasePrimary = primarySource === "vantage-mt5-supabase";
  console.log(`   Primary source: ${primarySource}`);
  console.log(`   ✅ Supabase (gold_m1_bars) is PRIMARY: ${isSupabasePrimary ? "YES" : "NO"}`);

  if (!isSupabasePrimary) {
    console.error(`❌ FAIL: fetchHistoricalData did NOT source from gold_m1_bars — got "${primarySource}"`);
    process.exit(1);
  }
  console.log("   ✅ PASS: live generation now sources OHLC from gold_m1_bars (Vantage MT5)\n");

  // 2. Query gold_m1_bars directly (the audit venue) and compare matched-minute closes
  console.log("2. Comparing matched-minute basis vs audit venue (gold_m1_bars direct)...");
  const supabase = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await supabase
    .from("gold_m1_bars")
    .select("timestamp, close")
    .gte("timestamp", new Date(fromTime).toISOString())
    .lte("timestamp", new Date(toTime).toISOString())
    .order("timestamp", { ascending: true });

  if (error) {
    console.error(`❌ Audit query failed: ${error.message}`);
    process.exit(1);
  }

  const auditByTs = new Map<number, number>();
  for (const row of data ?? []) {
    auditByTs.set(new Date(row.timestamp).getTime(), row.close);
  }

  const deltas: number[] = [];
  for (const b of bars) {
    const auditClose = auditByTs.get(b.timestamp);
    if (auditClose !== undefined) {
      deltas.push(b.close - auditClose);
    }
  }

  if (deltas.length === 0) {
    console.error("❌ No matched bars to compare");
    process.exit(1);
  }

  const absDeltas = deltas.map(Math.abs);
  const sorted = [...absDeltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  const mean = absDeltas.reduce((s, v) => s + v, 0) / absDeltas.length;

  console.log(`   Matched bars: n=${deltas.length}`);
  console.log(`   Median |delta|: $${median.toFixed(4)} (${(median / 0.1).toFixed(1)} pips)`);
  console.log(`   Mean |delta|:   $${mean.toFixed(4)}`);
  console.log(`   Max |delta|:    $${max.toFixed(4)} (${(max / 0.1).toFixed(1)} pips)`);

  const basisClosed = median < 0.01; // < $0.01 = < 0.1 pips
  console.log(`\n   ✅ Basis vs audit: ${basisClosed ? "~$0 (CLOSED)" : "MATERIAL — not closed"}`);

  if (!basisClosed) {
    console.error("❌ FAIL: basis is not ~$0 — something is wrong");
    process.exit(1);
  }

  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("  BASIS CLOSED: generation + audit now share gold_m1_bars (Vantage MT5)");
  console.log("  GC=F/TwelveData demoted to fallback (Supabase unreachable / stale gap)");
  console.log("═══════════════════════════════════════════════════════════════════");
}

main().catch((err: unknown) => {
  console.error("FATAL:", err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
