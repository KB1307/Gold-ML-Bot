/**
 * TwelveData quota-exhaustion fallback frequency investigation.
 *
 * The getHistoricalData backend route tries TwelveData XAU/USD spot first,
 * then falls back to Yahoo GC=F futures when TwelveData's daily quota is
 * exhausted. Phase 0 found ~$59 median basis between GC=F and Vantage bars.
 * This script investigates:
 *
 *   1. How often the fallback actually fires (quota exhaustion frequency)
 *   2. The actual basis delta between GC=F and Vantage for a recent window
 *   3. The actual basis delta between TwelveData spot and Vantage for the same window
 *   4. How much ATR / SL sizing would differ between the two sources
 *   5. The estimated daily quota budget and when it runs out
 *
 * Usage: bunx tsx expo/scripts/analyzeTwelveDataFallback.ts
 */
import { createClient } from '@supabase/supabase-js';

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
const TWELVEDATA_API_KEY = process.env.EXPO_PUBLIC_TWELVEDATA_API_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const PIP = 0.1;
const TWELVEDATA_FREE_TIER_DAILY_LIMIT = 800; // per the comment in goldPrice.ts:8-9

// ─── Helpers ────────────────────────────────────────────────────────────────

interface OhlcBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  source: string;
}

async function fetchTwelveDataHistory(fromTime: number, toTime: number): Promise<OhlcBar[]> {
  if (!TWELVEDATA_API_KEY) {
    console.log('[TwelveData] No API key configured');
    return [];
  }

  const startDate = new Date(fromTime).toISOString().slice(0, 19);
  const endDate = new Date(toTime).toISOString().slice(0, 19);
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&start_date=${startDate}&end_date=${endDate}&outputsize=500&timezone=UTC&apikey=${TWELVEDATA_API_KEY}`;

  console.log(`[TwelveData] Fetching ${new Date(fromTime).toISOString()} to ${new Date(toTime).toISOString()}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });

  if (response.status === 429) {
    console.warn('[TwelveData] 429 — quota exhausted RIGHT NOW');
    return [];
  }

  if (!response.ok) {
    console.log(`[TwelveData] HTTP ${response.status}`);
    return [];
  }

  const data = await response.json() as Record<string, unknown>;
  if (data?.status === 'error') {
    const message = typeof data?.message === 'string' ? data.message : '';
    console.warn(`[TwelveData] API error: ${message}`);
    // Check for quota exhaustion in the error message
    if (/credit|quota|limit/i.test(message)) {
      console.warn('[TwelveData] QUOTA EXHAUSTED in error body');
    }
    return [];
  }

  // Check if there's usage info in the response
  if (data?._status || data?.usage) {
    console.log(`[TwelveData] Usage info: ${JSON.stringify(data._status ?? data.usage)}`);
  }

  const values = data?.values as Array<{ datetime: string; open: string; high: string; low: string; close: string }> | undefined;
  if (!Array.isArray(values) || values.length === 0) {
    console.log('[TwelveData] No values returned');
    return [];
  }

  const bars: OhlcBar[] = [];
  for (const v of values) {
    const ts = new Date(v.datetime + 'Z').getTime();
    const open = parseFloat(v.open);
    const high = parseFloat(v.high);
    const low = parseFloat(v.low);
    const close = parseFloat(v.close);
    if (!isNaN(ts) && !isNaN(open) && open > 1000) {
      if (ts >= fromTime && ts <= toTime) {
        bars.push({ timestamp: ts, open, high, low, close, source: 'twelvedata-spot' });
      }
    }
  }

  bars.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`[TwelveData] Success: ${bars.length} bars`);
  return bars;
}

async function fetchYahooGCFHistory(fromTime: number, toTime: number): Promise<OhlcBar[]> {
  const period1 = Math.floor(fromTime / 1000);
  const period2 = Math.floor(toTime / 1000) + 120;
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/GC=F?interval=1m&period1=${period1}&period2=${period2}`;
      console.log(`[Yahoo GC=F] Fetching from ${host}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });

      if (!response.ok) {
        console.log(`[Yahoo GC=F] ${host} returned ${response.status}`);
        continue;
      }

      const data = await response.json() as {
        chart?: {
          result?: Array<{
            timestamp: number[];
            indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[] }> };
          }>;
        };
      };

      const result = data?.chart?.result?.[0];
      if (!result?.timestamp) {
        console.log(`[Yahoo GC=F] Invalid data from ${host}`);
        continue;
      }

      const timestamps = result.timestamp;
      const quotes = result.indicators.quote[0];
      const bars: OhlcBar[] = [];

      for (let i = 0; i < timestamps.length; i++) {
        const barTime = timestamps[i] * 1000;
        if (barTime >= fromTime && barTime <= toTime) {
          const open = quotes.open[i];
          const high = quotes.high[i];
          const low = quotes.low[i];
          const close = quotes.close[i];
          if (open !== null && high !== null && low !== null && close !== null) {
            bars.push({ timestamp: barTime, open, high, low, close, source: 'yahoo-futures-fallback' });
          }
        }
      }

      console.log(`[Yahoo GC=F] Success: ${bars.length} bars from ${host}`);
      return bars;
    } catch (e) {
      console.warn(`[Yahoo GC=F] ${host} error: ${e instanceof Error ? e.message : 'unknown'}`);
      continue;
    }
  }
  return [];
}

async function fetchVantageBars(fromTime: number, toTime: number): Promise<OhlcBar[]> {
  const fromIso = new Date(fromTime).toISOString();
  const toIso = new Date(toTime).toISOString();

  const { data, error } = await supabase
    .from('gold_m1_bars')
    .select('timestamp, open, high, low, close')
    .gte('timestamp', fromIso)
    .lte('timestamp', toIso)
    .order('timestamp', { ascending: true });

  if (error) {
    console.error('[Vantage] Query error:', error.message);
    return [];
  }

  const bars: OhlcBar[] = (data ?? []).map((row) => ({
    timestamp: new Date(row.timestamp as string).getTime(),
    open: row.open as number,
    high: row.high as number,
    low: row.low as number,
    close: row.close as number,
    source: 'vantage-mt5',
  }));

  console.log(`[Vantage] Success: ${bars.length} bars`);
  return bars;
}

function computeATR(bars: OhlcBar[], period: number = 14): number {
  if (bars.length < 2) return 0;
  const trueRanges: number[] = [];
  for (let i = 1; i < Math.min(bars.length, period + 1); i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }
  return trueRanges.reduce((s, v) => s + v, 0) / Math.max(trueRanges.length, 1);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  TWELVEDATA QUOTA-EXHAUSTION FALLBACK INVESTIGATION');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  // ── Part 1: Check TwelveData current quota status ─────────────────────
  console.log('━━━ PART 1: TwelveData quota status ━━━\n');

  // Try to check the account/api usage endpoint
  if (TWELVEDATA_API_KEY) {
    try {
      const usageUrl = `https://api.twelvedata.com/api_usage?apikey=${TWELVEDATA_API_KEY}`;
      console.log('Checking TwelveData API usage...');
      const resp = await fetch(usageUrl, { signal: AbortSignal.timeout(5000) });
      const usageData = await resp.json() as Record<string, unknown>;
      console.log(`  HTTP ${resp.status}`);
      console.log(`  Response: ${JSON.stringify(usageData, null, 2)}`);
    } catch (e) {
      console.log(`  Usage check failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }

  // ── Part 2: Quota exhaustion math ─────────────────────────────────────
  console.log('\n━━━ PART 2: Quota exhaustion timing math ━━━\n');

  // fetchAndUpdateOHLCHistory is throttled to 60s and called on every tick.
  // Each call to getHistoricalData uses 1 TwelveData credit (outputsize=500).
  // Free tier limit = 800 credits/day (per the comment in goldPrice.ts).
  const callsPerHour = 60; // every 60 seconds
  const callsPerDay = callsPerHour * 24;
  const dailyLimit = TWELVEDATA_FREE_TIER_DAILY_LIMIT;
  const hoursUntilExhaustion = dailyLimit / callsPerHour;
  const fallbackHoursPerDay = 24 - hoursUntilExhaustion;
  const fallbackFraction = fallbackHoursPerDay / 24;

  console.log(`  TwelveData free-tier daily limit: ${dailyLimit} credits`);
  console.log(`  getHistoricalData call rate: ${callsPerHour}/hour (every 60s)`);
  console.log(`  Daily call volume: ${callsPerDay}`);
  console.log(`  Credits exhausted after: ${hoursUntilExhaustion.toFixed(1)} hours (~${Math.floor(hoursUntilExhaustion)}h ${Math.round((hoursUntilExhaustion % 1) * 60)}m)`);
  console.log(`  Fallback to Yahoo GC=F for: ${fallbackHoursPerDay.toFixed(1)} hours/day`);
  console.log(`  Fallback fraction: ${(fallbackFraction * 100).toFixed(1)}% of the day`);
  console.log(`  → SL/TP sizing runs on GC=F futures for ~${(fallbackFraction * 100).toFixed(0)}% of trading hours`);

  // ── Part 3: Measure actual basis deltas ──────────────────────────────
  console.log('\n━━━ PART 3: Actual basis delta measurement ━━━\n');

  // Use a 2-hour recent window to get enough bars for meaningful ATR
  const toTime = Date.now();
  const fromTime = toTime - 2 * 60 * 60 * 1000; // 2 hours back

  console.log(`Window: ${new Date(fromTime).toISOString()} to ${new Date(toTime).toISOString()}`);
  console.log('');

  const [twelveBars, yahooBars, vantageBars] = await Promise.all([
    fetchTwelveDataHistory(fromTime, toTime),
    fetchYahooGCFHistory(fromTime, toTime),
    fetchVantageBars(fromTime, toTime),
  ]);

  // ── Part 3a: Pair 1 — TwelveData spot vs Vantage ─────────────────────
  console.log('\n── Pair 1: TwelveData spot vs Vantage (ATR-sizing primary vs audit) ──\n');

  const pair1Deltas: number[] = [];
  const vantageByTs = new Map<number, OhlcBar>();
  for (const b of vantageBars) {
    vantageByTs.set(b.timestamp, b);
  }
  for (const t of twelveBars) {
    const v = vantageByTs.get(t.timestamp);
    if (v) {
      pair1Deltas.push(t.close - v.close);
    }
  }

  if (pair1Deltas.length > 0) {
    const absDeltas = pair1Deltas.map(Math.abs);
    console.log(`  Matched bars: n=${pair1Deltas.length}`);
    console.log(`  Median delta: $${median(pair1Deltas).toFixed(2)} (${(median(pair1Deltas) / PIP).toFixed(0)} pips)`);
    console.log(`  Median |delta|: $${median(absDeltas).toFixed(2)} (${(median(absDeltas) / PIP).toFixed(0)} pips)`);
    console.log(`  Mean delta: $${mean(pair1Deltas).toFixed(2)}`);
    console.log(`  Std dev: $${stdDev(pair1Deltas).toFixed(2)}`);
    console.log(`  Max |delta|: $${Math.max(...absDeltas).toFixed(2)} (${(Math.max(...absDeltas) / PIP).toFixed(0)} pips)`);
    console.log(`  P90 |delta|: $${percentile(absDeltas, 90).toFixed(2)}`);
    console.log(`  P95 |delta|: $${percentile(absDeltas, 95).toFixed(2)}`);
  } else {
    console.log('  No overlapping bars between TwelveData and Vantage');
    console.log('  → This likely means TwelveData quota IS exhausted right now (no bars returned)');
  }

  // ── Part 3b: Pair 2 — Yahoo GC=F vs Vantage (the fallback) ───────────
  console.log('\n── Pair 2: Yahoo GC=F futures vs Vantage (fallback ATR-sizing vs audit) ──\n');

  const pair2Deltas: number[] = [];
  for (const y of yahooBars) {
    const v = vantageByTs.get(y.timestamp);
    if (v) {
      pair2Deltas.push(y.close - v.close);
    }
  }

  if (pair2Deltas.length > 0) {
    const absDeltas2 = pair2Deltas.map(Math.abs);
    console.log(`  Matched bars: n=${pair2Deltas.length}`);
    console.log(`  Median delta: $${median(pair2Deltas).toFixed(2)} (${(median(pair2Deltas) / PIP).toFixed(0)} pips)`);
    console.log(`  Median |delta|: $${median(absDeltas2).toFixed(2)} (${(median(absDeltas2) / PIP).toFixed(0)} pips)`);
    console.log(`  Mean delta: $${mean(pair2Deltas).toFixed(2)}`);
    console.log(`  Std dev: $${stdDev(pair2Deltas).toFixed(2)}`);
    console.log(`  Max |delta|: $${Math.max(...absDeltas2).toFixed(2)} (${(Math.max(...absDeltas2) / PIP).toFixed(0)} pips)`);
    console.log(`  P90 |delta|: $${percentile(absDeltas2, 90).toFixed(2)}`);
    console.log(`  P95 |delta|: $${percentile(absDeltas2, 95).toFixed(2)}`);
  } else {
    console.log('  No overlapping bars between Yahoo GC=F and Vantage');
  }

  // ── Part 3c: Pair 3 — TwelveData vs Yahoo GC=F (primary vs fallback) ─
  console.log('\n── Pair 3: TwelveData spot vs Yahoo GC=F (primary vs fallback) ──\n');

  const pair3Deltas: number[] = [];
  const yahooByTs = new Map<number, OhlcBar>();
  for (const y of yahooBars) {
    yahooByTs.set(y.timestamp, y);
  }
  for (const t of twelveBars) {
    const y = yahooByTs.get(t.timestamp);
    if (y) {
      pair3Deltas.push(t.close - y.close);
    }
  }

  if (pair3Deltas.length > 0) {
    const absDeltas3 = pair3Deltas.map(Math.abs);
    console.log(`  Matched bars: n=${pair3Deltas.length}`);
    console.log(`  Median delta: $${median(pair3Deltas3).toFixed(2)} (${(median(pair3Deltas3) / PIP).toFixed(0)} pips)`);
    console.log(`  Median |delta|: $${median(absDeltas3).toFixed(2)} (${(median(absDeltas3) / PIP).toFixed(0)} pips)`);
    console.log(`  Mean delta: $${mean(pair3Deltas3).toFixed(2)}`);
    console.log(`  Max |delta|: $${Math.max(...absDeltas3).toFixed(2)}`);
  } else {
    console.log('  No overlapping bars between TwelveData and Yahoo GC=F');
  }

  // ── Part 4: ATR / SL sizing impact ───────────────────────────────────
  console.log('\n━━━ PART 4: ATR / SL sizing impact ━━━\n');

  const atrTwelve = computeATR(twelveBars, 14);
  const atrYahoo = computeATR(yahooBars, 14);
  const atrVantage = computeATR(vantageBars, 14);

  console.log(`  ATR (14-period):`);
  console.log(`    TwelveData spot:  ${atrTwelve.toFixed(4)} ($${(atrTwelve / PIP).toFixed(1)} pips)`);
  console.log(`    Yahoo GC=F:       ${atrYahoo.toFixed(4)} ($${(atrYahoo / PIP).toFixed(1)} pips)`);
  console.log(`    Vantage MT5:      ${atrVantage.toFixed(4)} ($${(atrVantage / PIP).toFixed(1)} pips)`);
  console.log('');

  // Simulate SL sizing: the engine uses atrMultiplier = max(1.0, min(1.6, 0.7 + atr*0.06))
  // and dynamicSlPips = max(configuredSlPips * atrMultiplier, atrFloorSlPips)
  // where atrFloorSlPips = (atr * 1.2) / pipValue
  function simulateSizing(atr: number, slPips: number, maxSLPips: number): { multiplier: number; slPips: number; atrFloorPips: number } {
    const pipValue = 0.1;
    const atrMultiplier = Math.max(1.0, Math.min(1.6, 0.7 + atr * 0.06));
    const configuredSlPips = slPips * atrMultiplier;
    const atrFloorSlPips = (atr * 1.2) / pipValue;
    const rawSlPips = Math.max(configuredSlPips, atrFloorSlPips);
    const dynamicSlPips = Math.min(rawSlPips, maxSLPips);
    return { multiplier: atrMultiplier, slPips: dynamicSlPips, atrFloorPips: atrFloorSlPips };
  }

  const baseSlPips = 70;
  const maxSLPips = 90;

  const sizingTwelve = simulateSizing(atrTwelve, baseSlPips, maxSLPips);
  const sizingYahoo = simulateSizing(atrYahoo, baseSlPips, maxSLPips);
  const sizingVantage = simulateSizing(atrVantage, baseSlPips, maxSLPips);

  console.log(`  SL sizing (base=${baseSlPips}p, maxSLPips=${maxSLPips}):`);
  console.log(`    TwelveData spot:  multiplier=${sizingTwelve.multiplier.toFixed(2)} SL=${sizingTwelve.slPips.toFixed(1)}p (atrFloor=${sizingTwelve.atrFloorPips.toFixed(1)}p)`);
  console.log(`    Yahoo GC=F:       multiplier=${sizingYahoo.multiplier.toFixed(2)} SL=${sizingYahoo.slPips.toFixed(1)}p (atrFloor=${sizingYahoo.atrFloorPips.toFixed(1)}p)`);
  console.log(`    Vantage MT5:      multiplier=${sizingVantage.multiplier.toFixed(2)} SL=${sizingVantage.slPips.toFixed(1)}p (atrFloor=${sizingVantage.atrFloorPips.toFixed(1)}p)`);
  console.log('');

  const slDeltaTwelveVsVantage = Math.abs(sizingTwelve.slPips - sizingVantage.slPips);
  const slDeltaYahooVsVantage = Math.abs(sizingYahoo.slPips - sizingVantage.slPips);
  const slDeltaTwelveVsYahoo = Math.abs(sizingTwelve.slPips - sizingYahoo.slPips);

  console.log(`  SL delta (pips):`);
  console.log(`    TwelveData vs Vantage: ${slDeltaTwelveVsVantage.toFixed(1)}p (${(slDeltaTwelveVsVantage * PIP).toFixed(2)} $)`);
  console.log(`    Yahoo GC=F vs Vantage: ${slDeltaYahooVsVantage.toFixed(1)}p (${(slDeltaYahooVsVantage * PIP).toFixed(2)} $)`);
  console.log(`    TwelveData vs Yahoo:   ${slDeltaTwelveVsYahoo.toFixed(1)}p (${(slDeltaTwelveVsYahoo * PIP).toFixed(2)} $)`);

  // ── Part 5: Summary & verdict ────────────────────────────────────────
  console.log('\n━━━ PART 5: Summary & risk assessment ━━━\n');

  const twelveReturnedBars = twelveBars.length > 0;
  const yahooBasisMedian = pair2Deltas.length > 0 ? median(pair2Deltas.map(Math.abs)) : 0;
  const twelveBasisMedian = pair1Deltas.length > 0 ? median(pair1Deltas.map(Math.abs)) : 0;

  console.log(`  TwelveData quota status RIGHT NOW: ${twelveReturnedBars ? 'WORKING (bars returned)' : 'EXHAUSTED or erroring (no bars)'}`);
  console.log(`  Estimated fallback fraction: ~${(fallbackFraction * 100).toFixed(0)}% of trading hours/day`);
  console.log(`  GC=F vs Vantage basis (median |delta|): $${yahooBasisMedian.toFixed(2)} (${(yahooBasisMedian / PIP).toFixed(0)} pips)`);
  console.log(`  TwelveData vs Vantage basis (median |delta|): $${twelveBasisMedian.toFixed(2)} (${(twelveBasisMedian / PIP).toFixed(0)} pips)`);
  console.log('');

  if (!twelveReturnedBars) {
    console.log('  ⚠️  CRITICAL: TwelveData is NOT returning bars right now.');
    console.log('      This means live SL/TP sizing is CURRENTLY running on Yahoo GC=F futures,');
    console.log('      which has a ~$' + yahooBasisMedian.toFixed(0) + ' basis vs the Vantage bars that audit trades.');
    console.log('      This is a live data-quality defect, not a theoretical risk.');
  }

  if (yahooBasisMedian > 0.5) {
    console.log(`  ⚠️  MATERIAL BASIS: GC=F futures vs Vantage spot has a $${yahooBasisMedian.toFixed(2)} median basis.`);
    console.log('      When the fallback fires (~' + (fallbackFraction * 100).toFixed(0) + '% of the day), SL/TP is sized on a price');
    console.log('      ~' + (yahooBasisMedian / PIP).toFixed(0) + ' pips from the bars that will audit the trade outcome.');
    console.log('      This means:');
    console.log('      - ATR is computed on the wrong instrument → SL may be too tight or too wide');
    console.log('      - The 1.2x ATR noise floor is measured on futures volatility, not spot');
    console.log('      - Session highs/lows and pivots are off by ~' + (yahooBasisMedian / PIP).toFixed(0) + ' pips');
    console.log('      - Every trade generated during fallback hours has risk sized on the wrong price scale');
  }

  if (slDeltaYahooVsVantage > 3) {
    console.log(`  ⚠️  SL SIZING MISMATCH: Yahoo GC=F produces a ${slDeltaYahooVsVantage.toFixed(1)}p different SL than Vantage would.`);
    console.log('      This is the real risk mis-sizing — a stop placed on GC=F volatility may be triggered');
    console.log('      prematurely (or too late) relative to the actual spot price action on Vantage.');
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('  INVESTIGATION COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
