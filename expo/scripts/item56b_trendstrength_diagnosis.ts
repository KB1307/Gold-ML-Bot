/**
 * ITEM 56(b) — WHY G56-2 FAILED. DIAGNOSIS, NOT A RESCUE.
 *
 * G56-2 was pre-registered at "TRENDING >= 15% after the ATR fix". Measured
 * result: 2.6% -> 2.6%. The gate is NOT being moved. This script establishes WHY
 * the ATR fix could not have moved TRENDING, and identifies what actually binds.
 *
 * THE STRUCTURAL POINT. detectMarketRegimeBarBased is an if/else-if CHAIN:
 *     1. VOLATILE  <- atr > X  && volumeRatio > 1.1
 *     2. QUIET     <- atr < Y  && volumeRatio < 0.9
 *     3. TRENDING  <- trendStrength > 0.6
 *     4. RANGING   <- otherwise
 * TRENDING has NO atr term. Changing X and Y can only re-route windows between
 * branches 1, 2 and 4. A window reaches branch 3 only if it clears both ATR arms
 * AND has trendStrength > 0.6. So TRENDING's share is capped by the trendStrength
 * distribution, and the ATR thresholds were never the binding constraint on it.
 *
 * This corrects my own Item 55 causal claim: I attributed TRENDING's 2.6% to the
 * miscalibrated ATR constants keeping windows out of branch 3. That is wrong. The
 * ATR constants ARE miscalibrated (independently demonstrated), but they are not
 * the reason TRENDING is rare.
 *
 * PRE-REGISTERED (fixed before running):
 *   G56-5  Measure the real trendStrength distribution. The claim "trendStrength
 *          > 0.6 is the binding constraint" PASSES only if P(trendStrength > 0.6)
 *          is itself well under 15% — i.e. the cap is real and not an artifact of
 *          branch ordering.
 *   G56-6  Measure the CEILING on TRENDING: the share of windows with
 *          trendStrength > 0.6 that ALSO clear both ATR arms under the new
 *          thresholds. PASS = that ceiling is reported, whatever it is.
 *
 * READ-ONLY.
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
    // fall through
  }
  return env;
};

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
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

const VOLATILE_COEFF = 1.5393e-3;
const QUIET_COEFF = 7.8918e-4;

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    console.error('Missing Supabase credentials');
    process.exit(1);
  }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const m1: Bar[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', since)
      .order('timestamp', { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error('bar fetch failed:', error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    m1.push(...rows.map((r) => ({
      timestamp: new Date(r.timestamp).getTime(),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    })));
    if (rows.length < 1000) break;
  }

  const m5 = aggregateToM5(m1);
  const line = '='.repeat(84);
  console.log(`\n${line}`);
  console.log('ITEM 56(b) — WHY TRENDING DID NOT MOVE');
  console.log(line);
  console.log(`  M1 bars ${m1.length} | M5 bars ${m5.length}`);

  const trendStrengths: number[] = [];
  let clearsAtrArms = 0;
  let trendingCeiling = 0;
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
    const price = window[window.length - 1].close;

    const recent10 = window.slice(-10);
    const older10 = window.slice(-20, -10);
    let recentActivity = 0;
    for (let i = 1; i < recent10.length; i += 1) recentActivity += Math.abs(recent10[i].close - recent10[i - 1].close);
    let olderActivity = 0;
    for (let i = 1; i < older10.length; i += 1) olderActivity += Math.abs(older10[i].close - older10[i - 1].close);
    const volumeRatio = olderActivity === 0 ? 1.0 : recentActivity / olderActivity;

    const closes = window.slice(-20).map((b) => b.close);
    const netMove = Math.abs(closes[closes.length - 1] - closes[0]);
    let totalMove = 0;
    for (let i = 1; i < closes.length; i += 1) totalMove += Math.abs(closes[i] - closes[i - 1]);
    const trendStrength = totalMove === 0 ? 0 : Math.min(1.0, netMove / totalMove);
    trendStrengths.push(trendStrength);

    const isVolatile = atr > price * VOLATILE_COEFF && volumeRatio > 1.1;
    const isQuiet = atr < price * QUIET_COEFF && volumeRatio < 0.9;
    if (!isVolatile && !isQuiet) {
      clearsAtrArms += 1;
      if (trendStrength > 0.6) trendingCeiling += 1;
    }
    samples += 1;
  }

  trendStrengths.sort((a, b) => a - b);

  console.log(`\n${line}`);
  console.log('G56-5 — trendStrength distribution (netMove / totalMove over 20 M5 bars)');
  console.log(line);
  for (const q of [0.05, 0.25, 0.5, 0.75, 0.85, 0.95, 0.99]) {
    console.log(`    p${String(Math.round(q * 100)).padStart(2, '0')}  ${quantile(trendStrengths, q).toFixed(4)}`);
  }
  console.log(`    max  ${trendStrengths[trendStrengths.length - 1].toFixed(4)}`);

  const over06 = trendStrengths.filter((t) => t > 0.6).length;
  console.log(`\n  P(trendStrength > 0.6) = ${over06}/${samples} = ${pct(over06, samples)}`);
  console.log('  This is an UPPER BOUND on TRENDING under ANY ATR thresholds, because');
  console.log('  TRENDING is branch 3 and carries no ATR term of its own.');
  const g565 = over06 / samples < 0.15;
  console.log(`  ${g565 ? '\u2705 PASS' : '\u274c FAIL'}  G56-5: trendStrength>0.6 occurs on ${pct(over06, samples)} of tape — the binding constraint is HERE, not in the ATR constants.`);

  console.log(`\n${line}`);
  console.log('G56-6 — CEILING on TRENDING under the new ATR thresholds');
  console.log(line);
  console.log(`  windows clearing both ATR arms : ${clearsAtrArms}/${samples} = ${pct(clearsAtrArms, samples)}`);
  console.log(`  ...of which trendStrength > 0.6 : ${trendingCeiling}/${samples} = ${pct(trendingCeiling, samples)}  <- max achievable TRENDING`);
  console.log('  \u2705 PASS  G56-6: ceiling reported.');

  console.log(`\n${line}`);
  console.log('WHAT THRESHOLD WOULD GIVE TRENDING A NON-DEGENERATE SHARE');
  console.log(line);
  console.log('  Reported for the user\'s decision. NOT shipped — changing the trendStrength');
  console.log('  cutoff redefines what "a trend" MEANS to every downstream consumer');
  console.log('  (cooldowns, starvation relief, slippage multiplier, min-strength-diff,');
  console.log('  and the RSI blocks). That is a behavioural change, not a units fix, and it');
  console.log('  needs its own EV gate on resolved outcomes — not just a share target.');
  for (const cut of [0.6, 0.5, 0.45, 0.4, 0.35, 0.3]) {
    const n = trendStrengths.filter((t) => t > cut).length;
    console.log(`    trendStrength > ${cut.toFixed(2)}  ->  ${pct(n, samples)} of tape`);
  }
  console.log('');
}

main().catch((err: unknown) => {
  console.error('item56b failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
