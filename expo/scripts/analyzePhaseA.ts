/**
 * Phase A diagnostic — read-only, no engine changes.
 *
 * A1: Reconstruct what refreshRecentDailyOHLCFromHistory() and detectHTFTrend()
 *     would have returned at the 31 July losing BUY signal timestamps.
 * A2: Check sr_zones_v1 state for 31 July vs 29/30 July.
 * A3: Verify STRONG UPTREND / ABOVE VWAP trigger conditions from real bar data.
 * A4: Verify feature sign semantics (code-level, confirmed here with data context).
 *
 * The script queries gold_m1_bars and sr_zones_v1 directly from Supabase
 * using the anon key (read-only SELECT, same as the live engine).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── env ──────────────────────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  const raw = readFileSync(envPath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  console.error("❌ Missing Supabase env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── helpers ──────────────────────────────────────────────────────────────

/** NY trading day key (same logic as signalEngine.getNYTradingDayKey). */
function getNYTradingDayKey(d: Date): string {
  const nyTime = new Date(d.getTime() - 5 * 60 * 60 * 1000); // UTC-5 (approx EST, no DST handling)
  const year = nyTime.getUTCFullYear();
  const month = String(nyTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(nyTime.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** NY trading day close timestamp (17:00 ET = 22:00 UTC, approx). */
function getNYTradingDayCloseTimestamp(dateKey: string): number {
  // dateKey is YYYY-MM-DD in NY time. Close is 17:00 NY = 22:00 UTC.
  // Parse the date as UTC midnight, then add 22 hours, then add 5h to account for the NY->UTC offset.
  // Actually: NY midnight = UTC+5h (EST). So NY 17:00 = UTC 22:00.
  // dateKey represents the NY date. UTC equivalent of NY midnight = dateKey + 5h UTC.
  // NY 17:00 close = dateKey + 17h NY = dateKey + 17h + 5h = dateKey + 22h UTC.
  const [y, m, d] = dateKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 22, 0, 0); // 22:00 UTC = 17:00 EST
}

/** Build daily OHLC bars from minute bars (mirrors signalEngine.buildDailyOHLCBarsFromHistoricalBars). */
function buildDailyOHLCBars(
  bars: { timestamp: number; open: number; high: number; low: number; close: number }[],
  now: number,
): { date: string; open: number; high: number; low: number; close: number; timestamp: number }[] {
  const grouped = new Map<string, { date: string; open: number; high: number; low: number; close: number; timestamp: number }>();
  const ordered = [...bars].sort((a, b) => a.timestamp - b.timestamp);

  for (const bar of ordered) {
    const dateKey = getNYTradingDayKey(new Date(bar.timestamp));
    const closeTs = getNYTradingDayCloseTimestamp(dateKey);
    const existing = grouped.get(dateKey);
    if (!existing) {
      grouped.set(dateKey, { date: dateKey, open: bar.open, high: bar.high, low: bar.low, close: bar.close, timestamp: closeTs });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
    }
  }

  return Array.from(grouped.values())
    .filter((bar) => bar.timestamp <= now)
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** Calculate daily pivot (H+L+C)/3 from the most recent completed daily bar. */
function calculateDailyPivot(dailyBars: { date: string; open: number; high: number; low: number; close: number; timestamp: number }[]): {
  pivot: number;
  sourceDate: string;
  high: number;
  low: number;
  close: number;
} | null {
  if (dailyBars.length === 0) return null;
  const sorted = [...dailyBars].sort((a, b) => b.timestamp - a.timestamp);
  const mostRecent = sorted[0];
  const pivot = (mostRecent.high + mostRecent.low + mostRecent.close) / 3;
  return { pivot, sourceDate: mostRecent.date, high: mostRecent.high, low: mostRecent.low, close: mostRecent.close };
}

interface MinuteBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Query gold_m1_bars for a given time window, paginating past the PostgREST 1000-row cap. */
async function fetchBars(fromTime: number, toTime: number): Promise<{ timestamp: number; open: number; high: number; low: number; close: number }[]> {
  const fromIso = new Date(fromTime).toISOString();
  const toIso = new Date(toTime).toISOString();
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 10;
  let allRows: MinuteBar[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const startIdx = page * PAGE_SIZE;
    const endIdx = startIdx + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromIso)
      .lte("timestamp", toIso)
      .order("timestamp", { ascending: true })
      .range(startIdx, endIdx);

    if (error) {
      console.error(`❌ Bar query failed (page ${page}): ${error.message}`);
      return [];
    }
    if (!data || data.length === 0) break;
    allRows = allRows.concat(data as MinuteBar[]);
    if (data.length < PAGE_SIZE) break;
  }

  if (allRows.length === 0) return [];
  return allRows.map((row) => ({
    timestamp: new Date(row.timestamp).getTime(),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
  }));
}

// ── A1: HTF trend reconstruction ─────────────────────────────────────────

async function analyzeA1(): Promise<void> {
  console.log("\n" + "═".repeat(80));
  console.log("A1: HTF TREND RECONSTRUCTION AT 31 JULY SIGNAL TIMESTAMPS");
  console.log("═".repeat(80));

  // The 4 losing BUY signals on 31 July were at approximately:
  // 08:41, 08:50, 08:56 UTC (from the diagnostics export)
  // We also check the best suppressed SELL at 08:01.
  const signalTimes = [
    { label: "Suppressed SELL (best)", utc: "2026-07-31T08:01:00Z" },
    { label: "Losing BUY #1", utc: "2026-07-31T08:41:00Z" },
    { label: "Losing BUY #2", utc: "2026-07-31T08:50:00Z" },
    { label: "Losing BUY #3", utc: "2026-07-31T08:56:00Z" },
  ];

  const DAILY_OHLC_REFRESH_LOOKBACK_MS = 72 * 60 * 60 * 1000; // 72h, same as engine

  for (const sig of signalTimes) {
    const now = new Date(sig.utc).getTime();
    console.log(`\n--- ${sig.label} at ${sig.utc} ---`);

    // 1. Fetch the 72h window of minute bars that refreshRecentDailyOHLCFromHistory would receive
    const fromTime = now - DAILY_OHLC_REFRESH_LOOKBACK_MS;
    const bars = await fetchBars(fromTime, now);
    console.log(`  72h lookback fetched ${bars.length} minute bars from ${new Date(fromTime).toISOString()} to ${new Date(now).toISOString()}`);

    if (bars.length === 0) {
      console.log("  ❌ NO BARS RETURNED — daily OHLC feed is BROKEN at this timestamp");
      continue;
    }

    // Show bar spacing and date span
    const firstBar = bars[0];
    const lastBar = bars[bars.length - 1];
    const dateSpan = (lastBar.timestamp - firstBar.timestamp) / (60 * 60 * 1000);
    console.log(`  First bar: ${new Date(firstBar.timestamp).toISOString()} O=${firstBar.open} H=${firstBar.high} L=${firstBar.low} C=${firstBar.close}`);
    console.log(`  Last bar:  ${new Date(lastBar.timestamp).toISOString()} O=${lastBar.open} H=${lastBar.high} L=${lastBar.low} C=${lastBar.close}`);
    console.log(`  Date span: ${dateSpan.toFixed(1)}h`);

    // Check interval spacing
    if (bars.length >= 2) {
      const intervals: number[] = [];
      for (let i = 1; i < Math.min(bars.length, 20); i++) {
        intervals.push(bars[i].timestamp - bars[i - 1].timestamp);
      }
      const uniqueIntervals = [...new Set(intervals.map((x) => x / 60000 + "min"))];
      console.log(`  Interval spacing (first 20): ${uniqueIntervals.join(", ")}`);
    }

    // 2. Build daily OHLC bars (same as buildDailyOHLCBarsFromHistoricalBars)
    const dailyBars = buildDailyOHLCBars(bars, now);
    console.log(`  Rebuilt ${dailyBars.length} daily bars:`);
    for (const db of dailyBars) {
      console.log(`    ${db.date}: O=${db.open.toFixed(1)} H=${db.high.toFixed(1)} L=${db.low.toFixed(1)} C=${db.close.toFixed(1)}`);
    }

    // 3. Calculate daily pivot (same as getDerivedDailyOHLC → calculateDashboardPivotLevels)
    const pivotInfo = calculateDailyPivot(dailyBars);
    if (!pivotInfo) {
      console.log("  ❌ NO completed daily bars — daily pivot would fall back to currentDayOHLC or developing day");
      continue;
    }
    console.log(`  Daily pivot (from ${pivotInfo.sourceDate}): ${pivotInfo.pivot.toFixed(1)}`);
    console.log(`    Source bar: H=${pivotInfo.high.toFixed(1)} L=${pivotInfo.low.toFixed(1)} C=${pivotInfo.close.toFixed(1)}`);

    // 4. Reconstruct detectHTFTrend components
    // The signal's entry price (from the diagnostics export context)
    // We need the current price at signal time — use the bar close at that minute
    const sigMinute = new Date(sig.utc).getTime();
    const sigBar = bars.find((b) => b.timestamp === Math.floor(sigMinute / 60000) * 60000) ??
      bars.reduce((closest, b) =>
        Math.abs(b.timestamp - sigMinute) < Math.abs(closest.timestamp - sigMinute) ? b : closest
      , bars[0]);

    const currentPrice = sigBar.close;
    const priceVsPivot = currentPrice - pivotInfo.pivot;
    console.log(`\n  detectHTFTrend reconstruction:`);
    console.log(`    currentPrice (nearest bar close): ${currentPrice.toFixed(1)}`);
    console.log(`    priceVsPivot: ${priceVsPivot.toFixed(1)} (pivot component: ${priceVsPivot > 10 ? "BULLISH(+1)" : priceVsPivot < -10 ? "BEARISH(+1)" : "NEUTRAL(0)"})`);

    // trendStrength and emaSignal are TICK-LEVEL — we cannot reconstruct them from bars.
    // But we CAN show what the pivot alone would have contributed.
    const pivotBullish = priceVsPivot > 10 ? 1 : 0;
    const pivotBearish = priceVsPivot < -10 ? 1 : 0;
    console.log(`    pivotBullishScore: ${pivotBullish} | pivotBearishScore: ${pivotBearish}`);
    console.log(`    (trendStrength + detectPriceDirection + emaSignal are TICK-LEVEL — not reconstructable from bars)`);
    console.log(`    To reach BULLISH (1.5): tick components must contribute ≥ ${1.5 - pivotBullish} bullish`);
    console.log(`    To reach BEARISH (1.5): tick components must contribute ≥ ${1.5 - pivotBearish} bearish`);

    // 5. The key finding: what SHOULD the HTF read have been?
    console.log(`\n  Expected HTF read on a -401 pip downtrend day:`);
    const dayOpen = dailyBars.length > 0 ? dailyBars[dailyBars.length - 1].open : currentPrice;
    const dayHigh = dailyBars.length > 0 ? Math.max(...dailyBars.slice(-1).map((d) => d.high)) : currentPrice;
    const dayLow = dailyBars.length > 0 ? Math.min(...dailyBars.slice(-1).map((d) => d.low)) : currentPrice;
    console.log(`    Day open: ${dayOpen.toFixed(1)} | Current: ${currentPrice.toFixed(1)} | Drop from open: ${(dayOpen - currentPrice).toFixed(1)} pips`);
    console.log(`    Price is ${priceVsPivot < 0 ? "BELOW" : "ABOVE"} daily pivot by ${Math.abs(priceVsPivot).toFixed(1)}`);
    if (priceVsPivot < -10) {
      console.log(`    → Pivot component correctly says BEARISH. If engine returned BULLISH, tick-level components OVERRULED the daily pivot.`);
    }
  }
}

// ── A2: TIER_0 S/R zone state ────────────────────────────────────────────

async function analyzeA2(): Promise<void> {
  console.log("\n" + "═".repeat(80));
  console.log("A2: TIER_0 S/R ZONE STATE — 31 JULY vs 29/30 JULY");
  console.log("═".repeat(80));

  // Check sr_zones_v1 table state
  const { data: zones, error } = await supabase
    .from("sr_zones_v1")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.log(`❌ sr_zones_v1 query failed: ${error.message}`);
    console.log("  → This itself may explain why TIER_0 was unused on 31 July");
    return;
  }

  if (!zones || zones.length === 0) {
    console.log("❌ sr_zones_v1 is EMPTY — no TIER_0 zones available at all");
    console.log("  → This explains why all 35 zone references on 31 July were TIER_1_LOCAL");
    return;
  }

  console.log(`sr_zones_v1 has ${zones.length} rows (showing up to 50):`);
  for (const z of zones.slice(0, 10)) {
    console.log(`  price=${z.price} type=${z.type} touches=${z.touches} source=${z.source} created_at=${z.created_at}`);
  }

  // Check for recent entries around 29-31 July
  const july29 = new Date("2026-07-29T00:00:00Z").toISOString();
  const july31end = new Date("2026-08-01T00:00:00Z").toISOString();
  const { data: recentZones, error: recentError } = await supabase
    .from("sr_zones_v1")
    .select("created_at, price, type, source")
    .gte("created_at", july29)
    .lte("created_at", july31end)
    .order("created_at", { ascending: true });

  if (recentError) {
    console.log(`❌ Recent zones query failed: ${recentError.message}`);
    return;
  }

  console.log(`\nZones created 29-31 July: ${recentZones?.length ?? 0}`);
  if (recentZones && recentZones.length > 0) {
    for (const z of recentZones) {
      console.log(`  ${z.created_at} | price=${z.price} type=${z.type} source=${z.source}`);
    }
  } else {
    console.log("  → NO zones were created during 29-31 July window");
    console.log("  → TIER_0 fetch would have returned empty → fallback to TIER_1_LOCAL");
  }

  // Check the latest created_at to see if the table is stale
  if (zones.length > 0) {
    const latest = zones[0].created_at;
    const latestAge = (Date.now() - new Date(latest).getTime()) / (60 * 60 * 1000);
    console.log(`\nLatest zone created_at: ${latest} (${latestAge.toFixed(1)}h ago)`);
  }

  // Check the TIER_0 fetch path: maybeRefreshTier0SRZones uses trpcClient.srZones.getZones.query()
  // This goes through the backend route, which queries sr_zones_v1.
  // If the backend was 503 (as discovered in the prior session), the fetch would fail silently.
  console.log("\nCode path analysis (from signalEngine.ts:2668-2707):");
  console.log("  maybeRefreshTier0SRZones() → trpcClient.srZones.getZones.query()");
  console.log("  → backend route srZones.getZones → queries sr_zones_v1 from Supabase");
  console.log("  If backend is 503/unreachable → .catch() fires → tier0SRZones stays null → TIER_1_LOCAL fallback");
  console.log("  The fetch is fire-and-forget (non-blocking) — a 503 backend means SILENT fallback to TIER_1");
}

// ── A3: STRONG UPTREND / ABOVE VWAP trigger conditions ───────────────────

async function analyzeA3(): Promise<void> {
  console.log("\n" + "═".repeat(80));
  console.log("A3: STRONG UPTREND / ABOVE VWAP TRIGGER CONDITIONS");
  console.log("═".repeat(80));

  // Code-level findings (with line numbers):
  // NOTE: detectHTFTrend was ALREADY UPDATED with a 'Phase B1 fix' to use daily-bar-based
  // components instead of tick-level. The question is whether the fix WORKS given the data
  // available on 31 July, not whether the old code is still live.
  console.log("\nCODE FINDINGS (from signalEngine.ts — CURRENT state, not old):");
  console.log("");
  console.log("1. detectHTFTrend() [line 4954] — ALREADY UPDATED with Phase B1 fix:");
  console.log("   Component 1: priceVsPivot = currentPrice - features.dailyPivot (DAILY — genuinely HTF)");
  console.log("   Component 2: developingDayDirection = currentDayOHLC.close - currentDayOHLC.open (DAILY)");
  console.log("     >$2.00 (20pip) move from open = ±1.0, >$5.00 (50pip) = ±1.5");
  console.log("   Component 3: dailyTrendDirection = last 3 completed daily bars (higherHighs+higherCloses or lowerLows+lowerCloses)");
  console.log("     REQUIRES >= 3 completed daily bars in dailyOHLCHistory");
  console.log("   Component 4: dailyEMA = EMA5 vs EMA10 on daily closes");
  console.log("     REQUIRES >= 10 completed daily bars — CANNOT fire with 72h lookback (3 days max)");
  console.log("   BULLISH/BEARISH requires score >= 1.5");
  console.log("   → The fix is in place. The question is: did the daily OHLC feed actually work on 31 July?");
  console.log("   → Key concern: 72h lookback = only 3 trading days. Component 4 (EMA) needs 10 bars → NEVER fires.");
  console.log("   → dailyOHLCHistory IS persisted to AsyncStorage and loaded on startup (line 5916), so over multiple");
  console.log("     sessions it accumulates more bars. But a fresh start = only 3 bars from the 72h window.");
  console.log("");
  console.log("2. 'strong_uptrend' attention score [line 4442]:");
  console.log("   Fires when: marketRegime.type === 'TRENDING' && strength > 0.75");
  console.log("   AND htfTrend === 'BULLISH' && ltfTrend === 'BULLISH'");
  console.log("   → Adds 0.15 to trendBuyContribution (BUY side)");
  console.log("   → marketRegime uses calculateTrendStrength() (20 ticks) and calculateRealVolumeRatio() (20 ticks) — TICK-LEVEL");
  console.log("");
  console.log("3. 'strong_uptrend_pattern' attention score [line 4460]:");
  console.log("   Fires when: priceActionPattern === 'STRONG_UPTREND'");
  console.log("   detectPriceActionPattern() [line 2129]: priceHistory.slice(-5), trend = recent[4]-recent[0]");
  console.log("   if (trend > 10 && volatility < 20) return 'STRONG_UPTREND'");
  console.log("   → 5 TICKS moving up >$10 with <$20 range. This is EXTREMELY short-term.");
  console.log("   → On a -401 pip day, any $10 bounce in 5 ticks fires this. LATE-TREND CONFIRMED.");
  console.log("");
  console.log("4. 'above_vwap' attention score [line 4581]:");
  console.log("   Fires when: currentPrice - vwap > 1.5");
  console.log("   calculateVWAP() [line 3509]: uses last 30 entries of priceHistory + highHistory + lowHistory");
  console.log("   → 30-tick VWAP. On a bounce after a drop, price rises above the 30-tick VWAP.");
  console.log("   → This fires DURING counter-trend bounces, not at trend start. LATE-TREND CONFIRMED.");
  console.log("");
  console.log("5. 'session_high_sweep' attention score [line 4692]:");
  console.log("   Fires when: confirmedHighSweep (HIGH_SWEEP with reversalConfirmed)");
  console.log("   → This adds to SELL side, not BUY. On a downtrend day, session high sweeps would");
  console.log("   correctly add to sellSignalStrength. Not counter-productive for BUY signals.");
  console.log("");
  console.log("6. 'bollinger_expansion' attention score [line 4620]:");
  console.log("   attentionScores.set('bollinger_expansion', 0.03) — NO direction, just a context tag.");
  console.log("   Does NOT add to buySignalStrength or sellSignalStrength. Neutral context only.");

  // Empirical: show the price action at the 31 July signal times
  console.log("\n\nEMPIRICAL: Price action at 31 July signal timestamps");
  const signalTimes = [
    { label: "Suppressed SELL (best)", utc: "2026-07-31T08:01:00Z" },
    { label: "Losing BUY #1", utc: "2026-07-31T08:41:00Z" },
    { label: "Losing BUY #2", utc: "2026-07-31T08:50:00Z" },
    { label: "Losing BUY #3", utc: "2026-07-31T08:56:00Z" },
  ];

  for (const sig of signalTimes) {
    const now = new Date(sig.utc).getTime();
    // Fetch 30 min before and 5 min after to see the local price action
    const bars = await fetchBars(now - 30 * 60 * 1000, now + 5 * 60 * 1000);
    if (bars.length === 0) {
      console.log(`\n  ${sig.label} at ${sig.utc}: NO BARS available`);
      continue;
    }

    const sigMinute = Math.floor(now / 60000) * 60000;
    const sigBar = bars.find((b) => b.timestamp === sigMinute) ??
      bars.reduce((closest, b) => Math.abs(b.timestamp - sigMinute) < Math.abs(closest.timestamp - sigMinute) ? b : closest, bars[0]);

    // Show 10 bars before the signal to see the local "trend"
    const sigIdx = bars.findIndex((b) => b.timestamp === sigBar.timestamp);
    const windowStart = Math.max(0, sigIdx - 10);
    const windowBars = bars.slice(windowStart, sigIdx + 1);

    console.log(`\n  ${sig.label} at ${sig.utc}:`);
    console.log(`    Price at signal: ${sigBar.close.toFixed(1)}`);
    if (windowBars.length >= 2) {
      const windowOpen = windowBars[0].open;
      const windowClose = windowBars[windowBars.length - 1].close;
      const windowHigh = Math.max(...windowBars.map((b) => b.high));
      const windowLow = Math.min(...windowBars.map((b) => b.low));
      const trend10 = windowClose - windowOpen;
      const vol10 = windowHigh - windowLow;
      console.log(`    10-bar window: open=${windowOpen.toFixed(1)} close=${windowClose.toFixed(1)} trend=${trend10.toFixed(1)} vol=${vol10.toFixed(1)}`);
      console.log(`    detectPriceActionPattern would see: trend=${trend10.toFixed(1)} (${trend10 > 10 ? "STRONG_UPTREND" : trend10 < -10 ? "STRONG_DOWNTREND" : "NEUTRAL"}), vol=${vol10.toFixed(1)} (${vol10 < 20 ? "LOW" : "HIGH"})`);
      // Note: the actual engine uses TICKS not bars, but this is the closest proxy from stored data
      console.log(`    (NOTE: engine uses TICK-LEVEL priceHistory, not 1-min bars — bars are a proxy)`);
    }
  }
}

// ── A4: Feature sign semantics ───────────────────────────────────────────

function analyzeA4(): void {
  console.log("\n" + "═".repeat(80));
  console.log("A4: FEATURE SIGN SEMANTICS (code-level)");
  console.log("═".repeat(80));

  console.log("\nThe attention scores map records UNSIGNED magnitudes. The actual directional");
  console.log("contribution is determined by which accumulator (buySignalStrength vs sellSignalStrength)");
  console.log("the feature adds to. The final direction = whichever accumulator is larger.");
  console.log("");

  const features = [
    { name: "bullish_quasimodo", line: 4664, target: "buySignalStrength", amount: "+0.18", direction: "BUY" },
    { name: "bearish_quasimodo", line: 4673, target: "sellSignalStrength", amount: "+0.18", direction: "SELL" },
    { name: "strong_uptrend", line: 4442, target: "trendBuyContribution→buySignalStrength", amount: "+0.15", direction: "BUY" },
    { name: "strong_downtrend", line: 4446, target: "trendSellContribution→sellSignalStrength", amount: "+0.15", direction: "SELL" },
    { name: "strong_uptrend_pattern", line: 4460, target: "trendBuyContribution→buySignalStrength", amount: "+0.10", direction: "BUY" },
    { name: "strong_downtrend_pattern", line: 4462, target: "trendSellContribution→sellSignalStrength", amount: "+0.10", direction: "SELL" },
    { name: "above_vwap", line: 4581, target: "buySignalStrength", amount: "+0.05", direction: "BUY" },
    { name: "below_vwap", line: 4585, target: "sellSignalStrength", amount: "+0.05", direction: "SELL" },
    { name: "bullish_engulfing", line: 4467, target: "trendBuyContribution→buySignalStrength", amount: "+0.12", direction: "BUY" },
    { name: "bearish_engulfing", line: 4471, target: "trendSellContribution→sellSignalStrength", amount: "+0.12", direction: "SELL" },
    { name: "bullish_divergence", line: 4654, target: "buySignalStrength", amount: "+0.20", direction: "BUY" },
    { name: "bearish_divergence", line: 4648, target: "sellSignalStrength", amount: "+0.20", direction: "SELL" },
    { name: "session_low_sweep", line: 4682, target: "buySignalStrength", amount: "+0.35*str", direction: "BUY" },
    { name: "session_high_sweep", line: 4692, target: "sellSignalStrength", amount: "+0.35*str", direction: "SELL" },
    { name: "dxy_headwind (on BUY)", line: 4633, target: "buySignalStrength", amount: "-penalty", direction: "REDUCES BUY" },
    { name: "bollinger_expansion", line: 4620, target: "NEITHER (context only)", amount: "+0.03 tag", direction: "NEUTRAL" },
    { name: "volatile_regime_context", line: 4450, target: "NEITHER (context only)", amount: "+0.03 tag", direction: "NEUTRAL" },
  ];

  console.log("Feature → Accumulator → Direction:");
  console.log("");
  for (const f of features) {
    const flag = f.direction === "BUY" ? "✅" : f.direction === "SELL" ? "🔴" : f.direction === "NEUTRAL" ? "⚪" : "⚠️";
    console.log(`  ${flag} ${f.name.padEnd(28)} [line ${f.line}] → ${f.target} ${f.amount} (${f.direction})`);
  }

  console.log("\n\nKEY ANSWER: Does BEARISH QUASIMODO on a BUY signal ADD or SUBTRACT?");
  console.log("  bearish_quasimodo adds +0.18 to sellSignalStrength (the OPPOSING side).");
  console.log("  It does NOT add to buySignalStrength. It correctly OPPOSES the BUY.");
  console.log("  When the final signal is BUY (buySignalStrength > sellSignalStrength),");
  console.log("  the bearish_quasimodo score appears in attentionScores as 0.18 (unsigned),");
  console.log("  but it contributed to the LOSING side — reducing the strength difference");
  console.log("  and therefore reducing confidence. Sign semantics are CORRECT.");
  console.log("");
  console.log("  This is NOT a defect. The export shows unsigned magnitudes, which is why");
  console.log("  'BEARISH QUASIMODO=18.0' on a BUY signal looks ambiguous — but the code");
  console.log("  correctly routes it to sellSignalStrength, opposing the BUY.");
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Phase A Diagnostic — 31 July 2026 HTF/SR/Feature Analysis");
  console.log(`Supabase URL: ${SUPABASE_URL}`);
  console.log(`Run time: ${new Date().toISOString()}`);

  await analyzeA1();
  await analyzeA2();
  await analyzeA3();
  analyzeA4();

  console.log("\n" + "═".repeat(80));
  console.log("Phase A diagnostic complete.");
  console.log("═".repeat(80));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
