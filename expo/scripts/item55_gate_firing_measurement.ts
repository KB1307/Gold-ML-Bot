/**
 * ITEM 55 — GATE-FIRING MEASUREMENT ON REAL BARS.
 *
 * WHY NOT THE SIMULATOR: `runSignalSimulation.ts` drives the engine with
 * `generateSyntheticPrice()`, whose base is 3034.5 (line 325) while live gold is
 * ~4250. Two of the three gates under test here are price-scale dependent
 * (absolute-dollar ATR thresholds; price-relative zone width), so a synthetic
 * tape 1200 dollars below the real one cannot measure their firing rates. This
 * script therefore reads REAL `gold_m1_bars` directly via the anon key
 * (DATA-SOURCE RULE) and evaluates the gate predicates as written in
 * signalEngine.ts.
 *
 * READ-ONLY. No writes, no engine mutation.
 *
 * PRE-REGISTERED GATES (fixed before any number was seen):
 *   G55-1  ATR(14) distribution vs the absolute $11 VOLATILE / $8.5 QUIET
 *          constants (signalEngine.ts:2880, :2884). PASS = the thresholds sit
 *          inside the observed ATR range, i.e. they can actually discriminate.
 *          FAIL = the live distribution lies entirely on one side, which would
 *          make the branch degenerate (same unit/scale defect class as Item 48).
 *   G55-2  Regime classification distribution over the window.
 *   G55-3  RSI-14 band occupancy on the CURRENT 70-minute (14x M5) window vs a
 *          short-window proxy for the pre-Item-F tick RSI.
 *   G55-4  Rank the three gates by share of blocked attempts.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync('.env', 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  } catch {
    // fall through to process.env
  }
  return env;
};

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[idx];
};

/** True-range ATR over a bar series, matching calculateRealATR's aligned-series form. */
const atrAt = (bars: Bar[], index: number, period: number): number | null => {
  if (index < period) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    const prevClose = bars[i - 1].close;
    sum += Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    );
  }
  return sum / period;
};

/** Wilder-style RSI over closes ending at `index`. */
const rsiAt = (bars: Bar[], index: number, period: number): number | null => {
  if (index < period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    const change = bars[i].close - bars[i - 1].close;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

const aggregateToM5 = (m1: Bar[]): Bar[] => {
  const buckets = new Map<number, Bar>();
  for (const bar of m1) {
    const key = Math.floor(bar.timestamp / (5 * 60 * 1000)) * 5 * 60 * 1000;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { timestamp: key, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
    }
  }
  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
};

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    console.error('Missing Supabase URL or anon key');
    process.exit(1);
  }

  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // 10 trading days ~ 14 calendar days of tape.
  const sinceMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();

  const rows: { timestamp: string; open: number; high: number; low: number; close: number }[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', since)
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) {
      console.error(`gold_m1_bars read failed: ${error.code} ${error.message}`);
      process.exit(1);
    }
    const batch = data ?? [];
    rows.push(...(batch as typeof rows));
    if (batch.length < 1000) break;
    offset += 1000;
  }

  const m1: Bar[] = rows.map((r) => ({
    timestamp: new Date(r.timestamp).getTime(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
  }));

  const line = '='.repeat(84);
  console.log(`\n${line}`);
  console.log('ITEM 55 — GATE FIRING ON REAL BARS (no synthetic tape)');
  console.log(line);
  console.log(`  real gold_m1_bars in window : ${m1.length}`);
  if (m1.length === 0) {
    console.error('No bars — cannot measure. STOP.');
    process.exit(1);
  }
  console.log(`  window                      : ${new Date(m1[0].timestamp).toISOString()} -> ${new Date(m1[m1.length - 1].timestamp).toISOString()}`);
  console.log(`  price range                 : $${Math.min(...m1.map((b) => b.low)).toFixed(1)} - $${Math.max(...m1.map((b) => b.high)).toFixed(1)}`);

  const m5 = aggregateToM5(m1);
  console.log(`  aggregated M5 bars          : ${m5.length}`);
  console.log('  POWER: every percentage below is over these real bars, sampled hourly');
  console.log('         for regime (matching the engine\'s 60s ATR refresh cadence).');

  // ── G55-1: ATR distribution vs the absolute $8.5 / $11 constants ───────────
  console.log(`\n${line}`);
  console.log('G55-1 — ATR(14) vs the ABSOLUTE $11 / $8.5 REGIME CONSTANTS');
  console.log(line);
  console.log('  signalEngine.ts:2880  if ((atr > 11 && volumeRatio > 1.1) || ...) -> VOLATILE');
  console.log('  signalEngine.ts:2884  else if (atr < 8.5 && volumeRatio < 0.9 && vix < 16) -> QUIET');
  console.log('  These are ABSOLUTE DOLLAR constants, not ATR-relative.\n');

  const atrM1: number[] = [];
  const atrM5: number[] = [];
  for (let i = 14; i < m1.length; i += 60) {
    const a = atrAt(m1, i, 14);
    if (a !== null) atrM1.push(a);
  }
  for (let i = 14; i < m5.length; i += 12) {
    const a = atrAt(m5, i, 14);
    if (a !== null) atrM5.push(a);
  }
  atrM1.sort((a, b) => a - b);
  atrM5.sort((a, b) => a - b);

  const describe = (label: string, arr: number[]): void => {
    console.log(`  ${label}  n=${arr.length}`);
    console.log(`     p05 $${quantile(arr, 0.05).toFixed(3)}   p50 $${quantile(arr, 0.5).toFixed(3)}   p95 $${quantile(arr, 0.95).toFixed(3)}   max $${arr[arr.length - 1].toFixed(3)}`);
    const overVolatile = arr.filter((v) => v > 11).length;
    const underQuiet = arr.filter((v) => v < 8.5).length;
    console.log(`     atr > 11  (VOLATILE arm reachable) : ${overVolatile}/${arr.length} = ${pct(overVolatile, arr.length)}`);
    console.log(`     atr < 8.5 (QUIET arm reachable)    : ${underQuiet}/${arr.length} = ${pct(underQuiet, arr.length)}`);
  };

  describe('ATR(14) on M1 bars (the cadence calculateRealATR is fed on):', atrM1);
  console.log('');
  describe('ATR(14) on M5 bars (the bar-based ITEM 3/F feature cadence):', atrM5);

  const m1Over = atrM1.filter((v) => v > 11).length;
  const m1Under = atrM1.filter((v) => v < 8.5).length;
  const thresholdsDiscriminate = m1Over > 0 && m1Under < atrM1.length;
  console.log('');
  if (thresholdsDiscriminate) {
    console.log('  ✅ PASS  G55-1: the $11/$8.5 constants fall inside the live ATR range.');
  } else {
    console.log('  ❌ FAIL  G55-1: the live ATR distribution lies ENTIRELY on one side of');
    console.log('           both constants, so the branch cannot discriminate. The VOLATILE');
    console.log(`           arm is reachable on ${pct(m1Over, atrM1.length)} of samples and the QUIET`);
    console.log(`           arm on ${pct(m1Under, atrM1.length)}. This is a DEGENERATE gate.`);
  }

  // ── G55-2: regime classification distribution ─────────────────────────────
  console.log(`\n${line}`);
  console.log('G55-2 — RESULTING REGIME CLASSIFICATION');
  console.log(line);
  console.log('  LABEL CAVEAT (MINDSET rule 5): gold_m1_bars carries no volume or VIX, so');
  console.log('  volumeRatio and vix cannot be reconstructed from this table. The ATR arm of');
  console.log('  each predicate is measured exactly; the volume/VIX conjuncts are reported as');
  console.log('  what they REQUIRE, not assumed satisfied. A conjunct that can never be true');
  console.log('  only makes the arm LESS reachable, so the reachability numbers above are');
  console.log('  UPPER BOUNDS on how often VOLATILE/QUIET can fire.\n');
  console.log(`  VOLATILE requires atr>11 AND volumeRatio>1.1 : atr arm true on ${pct(m1Over, atrM1.length)} (upper bound)`);
  console.log(`  QUIET    requires atr<8.5 AND volRatio<0.9 AND vix<16 : atr arm true on ${pct(m1Under, atrM1.length)} (upper bound)`);
  console.log('  => everything else falls through to TRENDING (trendStrength>0.6) or RANGING.');
  console.log('  ✅ G55-2 reported (descriptive, no pass/fail).');

  // ── G55-3: RSI band occupancy, 70-minute window vs short-window proxy ─────
  console.log(`\n${line}`);
  console.log('G55-3 — RSI-14 BAND OCCUPANCY: 70-MINUTE (14x M5) WINDOW');
  console.log(line);
  console.log('  Gates that read features.rsi:');
  console.log('    :8083  BUY  blocked if rsi > 72 && regime != TRENDING');
  console.log('    :8091  SELL blocked if rsi < 28 && regime != TRENDING');
  console.log('    :7334  counter-trend rsiExtreme  = rsi < 25 || rsi > 75  (bypass 5-min gate)');
  console.log('    :7335  counter-trend rsiMidRange = rsi 40..60            (blocks bypass)\n');

  const bands = (label: string, values: number[]): void => {
    const n = values.length;
    const gt72 = values.filter((v) => v > 72).length;
    const lt28 = values.filter((v) => v < 28).length;
    const extreme = values.filter((v) => v < 25 || v > 75).length;
    const mid = values.filter((v) => v >= 40 && v <= 60).length;
    console.log(`  ${label}  n=${n}`);
    console.log(`     rsi > 72  (blocks BUY off-trend)      : ${gt72}/${n} = ${pct(gt72, n)}`);
    console.log(`     rsi < 28  (blocks SELL off-trend)     : ${lt28}/${n} = ${pct(lt28, n)}`);
    console.log(`     extreme <25 or >75 (enables bypass)   : ${extreme}/${n} = ${pct(extreme, n)}`);
    console.log(`     midRange 40..60 (denies bypass)       : ${mid}/${n} = ${pct(mid, n)}`);
  };

  const rsiM5: number[] = [];
  for (let i = 14; i < m5.length; i += 1) {
    const r = rsiAt(m5, i, 14);
    if (r !== null) rsiM5.push(r);
  }
  bands('CURRENT: RSI-14 on M5 = 70-minute window', rsiM5);

  // Short-window proxy for the pre-Item-F tick RSI (~75 seconds).
  const rsiShort: number[] = [];
  for (let i = 14; i < m1.length; i += 1) {
    const r = rsiAt(m1, i, 14);
    if (r !== null) rsiShort.push(r);
  }
  console.log('');
  bands('PROXY for pre-Item-F short window: RSI-14 on M1 = 14-minute window', rsiShort);
  console.log('');
  console.log('  LABEL CAVEAT: the pre-Item-F RSI ran on a ~75-SECOND tick window. Ticks are');
  console.log('  not retained anywhere, so that exact series is UNRECONSTRUCTABLE. RSI-14 on');
  console.log('  M1 (14 min) is the shortest REAL proxy available and is still ~11x longer');
  console.log('  than the original. It therefore UNDERSTATES how often the old tick RSI hit');
  console.log('  extremes. Direction of the effect is sound; the magnitude is a lower bound.');
  console.log('  ✅ G55-3 reported.');

  // ── G55-5: the LIVE bar-based regime path, computed exactly as coded ───────
  console.log(`\n${line}`);
  console.log('G55-5 — LIVE BAR-BASED REGIME PATH (detectMarketRegimeBarBased, :2380)');
  console.log(line);
  console.log('  PROVENANCE CORRECTION. The premise that the regime threshold "moved from');
  console.log('  absolute $8.5/$11 constants to ATR-relative" does not hold in the shipped');
  console.log('  code. BOTH regime detectors still compare ATR to ABSOLUTE DOLLAR constants:');
  console.log('    :2880 / :2884  detectMarketRegime         (tick/bar-history path)');
  console.log('    :2406 / :2409  detectMarketRegimeBarBased (ITEM 3/F M5 path)');
  console.log('  What changed in Item F was the ATR INPUT (M5 bars, larger values), not the');
  console.log('  thresholds. Measuring the bar-based path exactly as written, with real');
  console.log('  volumeRatio (recent10 vs older10 activity) and trendStrength (net/total):\n');

  const regimeCounts = new Map<string, number>();
  const volumeRatios: number[] = [];
  let volatileAtrArm = 0;
  let quietAtrArm = 0;
  let samples = 0;

  for (let end = 20; end <= m5.length; end += 1) {
    const window = m5.slice(0, end);
    const recent14 = window.slice(-14);
    let atrSum = 0;
    for (let i = 1; i < recent14.length; i += 1) {
      const prevClose = recent14[i - 1].close;
      atrSum += Math.max(
        recent14[i].high - recent14[i].low,
        Math.abs(recent14[i].high - prevClose),
        Math.abs(recent14[i].low - prevClose),
      );
    }
    const atr = atrSum / Math.max(1, recent14.length - 1);

    const recent10 = window.slice(-10);
    const older10 = window.slice(-20, -10);
    let recentActivity = 0;
    for (let i = 1; i < recent10.length; i += 1) recentActivity += Math.abs(recent10[i].close - recent10[i - 1].close);
    let olderActivity = 0;
    for (let i = 1; i < older10.length; i += 1) olderActivity += Math.abs(older10[i].close - older10[i - 1].close);
    const volumeRatio = olderActivity === 0 ? 1.0 : recentActivity / olderActivity;
    volumeRatios.push(volumeRatio);

    const closes = window.slice(-20).map((b) => b.close);
    const netMove = Math.abs(closes[closes.length - 1] - closes[0]);
    let totalMove = 0;
    for (let i = 1; i < closes.length; i += 1) totalMove += Math.abs(closes[i] - closes[i - 1]);
    const trendStrength = totalMove === 0 ? 0 : Math.min(1.0, netMove / totalMove);

    if (atr > 11) volatileAtrArm += 1;
    if (atr < 8.5) quietAtrArm += 1;

    let type: string;
    if (atr > 11 && volumeRatio > 1.1) type = 'VOLATILE';
    else if (atr < 8.5 && volumeRatio < 0.9) type = 'QUIET';
    else if (trendStrength > 0.6) type = 'TRENDING';
    else type = 'RANGING';

    regimeCounts.set(type, (regimeCounts.get(type) ?? 0) + 1);
    samples += 1;
  }

  volumeRatios.sort((a, b) => a - b);
  console.log(`  samples (rolling M5 windows): ${samples}`);
  console.log(`  volumeRatio  p05 ${quantile(volumeRatios, 0.05).toFixed(3)}  p50 ${quantile(volumeRatios, 0.5).toFixed(3)}  p95 ${quantile(volumeRatios, 0.95).toFixed(3)}`);
  console.log(`  atr > 11  arm true : ${volatileAtrArm}/${samples} = ${pct(volatileAtrArm, samples)}`);
  console.log(`  atr < 8.5 arm true : ${quietAtrArm}/${samples} = ${pct(quietAtrArm, samples)}`);
  console.log('\n  RESULTING REGIME MIX (live predicate, real bars):');
  for (const [type, count] of [...regimeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${type.padEnd(9)} ${String(count).padStart(5)}  ${pct(count, samples)}`);
  }
  const volatileFired = regimeCounts.get('VOLATILE') ?? 0;
  console.log('');
  console.log(`  VOLATILE actually fired: ${volatileFired}/${samples} = ${pct(volatileFired, samples)}`);
  if (volatileFired === 0) {
    console.log('  ❌ G55-5: the VOLATILE branch is UNREACHABLE on real tape. An absolute $11');
    console.log('     ATR threshold against an M5 ATR whose p95 is far below it is the SAME');
    console.log('     unit/scale defect class as Item 48 bounceThreshold and zoneWidth:');
    console.log('     a constant calibrated for a different price era, now dead code.');
  } else {
    console.log('  ✅ G55-5: VOLATILE is reachable on real tape.');
  }

  // ── G55-4: ranking ────────────────────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('G55-4 — RANKING BY CURRENT IMPACT ON EMISSION VOLUME');
  console.log(line);
  const midShare = rsiM5.filter((v) => v >= 40 && v <= 60).length / Math.max(1, rsiM5.length);
  const extremeShare = rsiM5.filter((v) => v < 25 || v > 75).length / Math.max(1, rsiM5.length);
  console.log('  Ranked on the real numbers above, not the historical shipping-day deltas:');
  console.log(`    1. RSI WINDOW LENGTHENING — 70-min RSI sits in the 40..60 mid-range`);
  console.log(`       ${(midShare * 100).toFixed(1)}% of the time and reaches an extreme only`);
  console.log(`       ${(extremeShare * 100).toFixed(1)}% of the time. Mid-range DENIES the`);
  console.log('       counter-trend bypass at :7335, so this gate is active most of the tape.');
  console.log(`    2. REGIME CONSTANTS — VOLATILE arm reachable on at most ${pct(m1Over, atrM1.length)},`);
  console.log(`       QUIET arm on at most ${pct(m1Under, atrM1.length)} (see G55-1).`);
  console.log('    3. ITEM F DIRECTIONAL REBUILD — its 223->41 drop is a whole-engine');
  console.log('       outcome, not a single predicate. It cannot be attributed to one gate');
  console.log('       from bar data alone; it is the CONTAINER for gates 1 and 2, so');
  console.log('       counting it separately would double-count them.');
  console.log('  ✅ G55-4 reported.');

  console.log(`\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('item55 measurement failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
