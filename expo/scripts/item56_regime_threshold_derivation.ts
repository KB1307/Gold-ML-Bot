/**
 * ITEM 56 — DERIVE AND VERIFY PERCENTILE-ANCHORED REGIME THRESHOLDS.
 *
 * METHOD: identical to Item 48(b). Measure the REAL distribution first, derive the
 * coefficient from it, then check the pre-registered gate. No guessed constants.
 *
 * WHY PRICE-RELATIVE AND NOT A NEW ABSOLUTE DOLLAR NUMBER. The defect being fixed
 * is that $11 / $8.5 were calibrated for a lower-priced gold era and never tracked
 * price. Replacing them with new absolute constants derived from today's p85/p25
 * would fix the symptom and re-arm the identical failure at the next price regime.
 * So the derived quantity is ATR-AS-A-FRACTION-OF-PRICE, and the live thresholds
 * are `price * coefficient`. Same structural fix Item 48 applied to zone width.
 *
 * PRE-REGISTERED GATES (fixed before any number below was seen):
 *   G56-1  Derive VOLATILE coefficient at p85 and QUIET coefficient at p25 of the
 *          real ATR/price distribution. PASS = both derived from n>=2000 samples.
 *   G56-2  Recompute the regime mix over the SAME 2,777-window real dataset under
 *          the new thresholds. PASS = TRENDING rises to a materially non-degenerate
 *          share. Pre-registered floor: TRENDING >= 15%.
 *   G56-3  RSI hard-blocks: recompute armed share (regime != TRENDING) and the
 *          share of tape actually rejected. Baseline 97.4% armed / 20.3% rejected.
 *          PASS = both fall materially.
 *   G56-4  VOLATILE and QUIET must both remain REACHABLE (neither degenerate to
 *          ~0% nor swallow the tape). PASS = each in [2%, 60%].
 *
 * READ-ONLY against Supabase. No writes.
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
  return 100 - 100 / (1 + avgGain / avgLoss);
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

/** One evaluated rolling window: exactly the inputs detectMarketRegimeBarBased sees. */
interface Sample {
  atr: number;
  price: number;
  volumeRatio: number;
  trendStrength: number;
  rsi: number | null;
}

type Regime = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'QUIET';

/** The live classifier, parameterised by the two thresholds under test. */
const classify = (s: Sample, volatileAtr: number, quietAtr: number): Regime => {
  if (s.atr > volatileAtr && s.volumeRatio > 1.1) return 'VOLATILE';
  if (s.atr < quietAtr && s.volumeRatio < 0.9) return 'QUIET';
  if (s.trendStrength > 0.6) return 'TRENDING';
  return 'RANGING';
};

const gates: { id: string; passed: boolean; detail: string }[] = [];
const record = (id: string, passed: boolean, detail: string): void => {
  gates.push({ id, passed, detail });
  console.log(`  ${passed ? '\u2705 PASS' : '\u274c FAIL'}  ${id}: ${detail}`);
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

  const line = '='.repeat(84);
  console.log(`\n${line}`);
  console.log('ITEM 56 — REGIME THRESHOLD DERIVATION (real gold_m1_bars, anon key)');
  console.log(line);

  // ── Load the SAME window Item 55 measured, so the comparison is like-for-like ──
  // `timestamp` is timestamptz — filter with an ISO string, exactly as Item 55 did,
  // so this measurement covers the identical window.
  const sinceMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const since = new Date(sinceMs).toISOString();
  const m1: Bar[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', since)
      .order('timestamp', { ascending: true })
      .range(from, from + pageSize - 1);
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
    if (rows.length < pageSize) break;
  }

  if (m1.length < 500) {
    console.error(`INSUFFICIENT DATA: only ${m1.length} M1 bars in window. Gate cannot close.`);
    process.exit(2);
  }

  const m5 = aggregateToM5(m1);
  console.log(`\n  M1 bars loaded : ${m1.length}`);
  console.log(`  M5 bars derived: ${m5.length}`);
  console.log(`  price range    : $${Math.min(...m1.map((b) => b.low)).toFixed(2)} .. $${Math.max(...m1.map((b) => b.high)).toFixed(2)}`);

  // ── Build the sample set: exactly detectMarketRegimeBarBased's inputs ──────
  const samples: Sample[] = [];
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

    const closes = window.slice(-20).map((b) => b.close);
    const netMove = Math.abs(closes[closes.length - 1] - closes[0]);
    let totalMove = 0;
    for (let i = 1; i < closes.length; i += 1) totalMove += Math.abs(closes[i] - closes[i - 1]);
    const trendStrength = totalMove === 0 ? 0 : Math.min(1.0, netMove / totalMove);

    samples.push({
      atr,
      price: window[window.length - 1].close,
      volumeRatio,
      trendStrength,
      rsi: rsiAt(window, window.length - 1, 14),
    });
  }

  console.log(`  rolling windows: ${samples.length}  (Item 55 measured 2777 on this same construction)`);

  // ── G56-1: derive the coefficients ────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('G56-1 — DERIVE COEFFICIENTS FROM THE REAL ATR/PRICE DISTRIBUTION');
  console.log(line);

  const ratios = samples.map((s) => s.atr / s.price).sort((a, b) => a - b);
  const atrsSorted = samples.map((s) => s.atr).sort((a, b) => a - b);
  const medianPrice = [...samples.map((s) => s.price)].sort((a, b) => a - b)[Math.floor(samples.length / 2)];

  console.log('\n  ATR(14) on M5, absolute dollars:');
  for (const q of [0.05, 0.25, 0.5, 0.75, 0.85, 0.95]) {
    console.log(`    p${String(Math.round(q * 100)).padStart(2, '0')}  $${quantile(atrsSorted, q).toFixed(3)}`);
  }
  console.log('\n  ATR(14) / price, dimensionless:');
  for (const q of [0.05, 0.25, 0.5, 0.75, 0.85, 0.95]) {
    console.log(`    p${String(Math.round(q * 100)).padStart(2, '0')}  ${quantile(ratios, q).toExponential(4)}`);
  }

  const volatileCoeff = quantile(ratios, 0.85);
  const quietCoeff = quantile(ratios, 0.25);
  console.log(`\n  DERIVED  VOLATILE coefficient (p85) = ${volatileCoeff.toExponential(4)}  -> $${(volatileCoeff * medianPrice).toFixed(3)} at price $${medianPrice.toFixed(2)}`);
  console.log(`  DERIVED  QUIET    coefficient (p25) = ${quietCoeff.toExponential(4)}  -> $${(quietCoeff * medianPrice).toFixed(3)} at price $${medianPrice.toFixed(2)}`);
  console.log(`\n  OLD absolute constants for contrast: VOLATILE $11.00, QUIET $8.50`);
  console.log(`  At the CURRENT median price those sit at percentile:`);
  const pctileOf = (v: number): string => `${((atrsSorted.filter((a) => a < v).length / atrsSorted.length) * 100).toFixed(1)}`;
  console.log(`    $11.00 -> p${pctileOf(11)}   (VOLATILE threshold was effectively off the top of the distribution)`);
  console.log(`    $ 8.50 -> p${pctileOf(8.5)}   (QUIET threshold swallowed nearly the whole distribution)`);

  record('G56-1', samples.length >= 2000, `coefficients derived from n=${samples.length} real windows`);

  // ── G56-2: regime mix, old vs new ─────────────────────────────────────────
  console.log(`\n${line}`);
  console.log('G56-2 — REGIME MIX, OLD vs NEW, SAME DATASET');
  console.log(line);

  const mixOf = (volAtr: (s: Sample) => number, quietAtr: (s: Sample) => number): Map<Regime, number> => {
    const counts = new Map<Regime, number>();
    for (const s of samples) {
      const r = classify(s, volAtr(s), quietAtr(s));
      counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    return counts;
  };

  const oldMix = mixOf(() => 11, () => 8.5);
  const newMix = mixOf((s) => s.price * volatileCoeff, (s) => s.price * quietCoeff);

  const order: Regime[] = ['RANGING', 'QUIET', 'TRENDING', 'VOLATILE'];
  console.log('\n  regime      OLD ($11/$8.5)        NEW (p85/p25 price-relative)');
  for (const r of order) {
    const o = oldMix.get(r) ?? 0;
    const n = newMix.get(r) ?? 0;
    console.log(`  ${r.padEnd(10)}  ${String(o).padStart(5)}  ${pct(o, samples.length).padStart(6)}        ${String(n).padStart(5)}  ${pct(n, samples.length).padStart(6)}`);
  }

  const newTrending = newMix.get('TRENDING') ?? 0;
  const trendingPct = (newTrending / samples.length) * 100;
  record('G56-2', trendingPct >= 15, `TRENDING ${pct(oldMix.get('TRENDING') ?? 0, samples.length)} -> ${trendingPct.toFixed(1)}% (pre-registered floor 15%)`);

  // ── G56-4: reachability of both branches ──────────────────────────────────
  const newVol = ((newMix.get('VOLATILE') ?? 0) / samples.length) * 100;
  const newQuiet = ((newMix.get('QUIET') ?? 0) / samples.length) * 100;
  record(
    'G56-4',
    newVol >= 2 && newVol <= 60 && newQuiet >= 2 && newQuiet <= 60,
    `VOLATILE ${newVol.toFixed(1)}%, QUIET ${newQuiet.toFixed(1)}% (both must be in [2%,60%])`,
  );

  // ── G56-3: RSI hard-block arming and rejection ────────────────────────────
  console.log(`\n${line}`);
  console.log('G56-3 — RSI HARD-BLOCK ARMING AND REJECTION');
  console.log(line);
  console.log('  signalEngine.ts:8120  BUY  blocked if rsi > 72 && regime != TRENDING');
  console.log('  signalEngine.ts:8128  SELL blocked if rsi < 28 && regime != TRENDING');
  console.log('  "Armed"    = regime != TRENDING (the block is live on this window).');
  console.log('  "Rejected" = armed AND rsi is in the blocking band, so a candidate of');
  console.log('               that direction WOULD be hard-blocked at this window.\n');

  const armedRejected = (volAtr: (s: Sample) => number, quietAtr: (s: Sample) => number) => {
    let armed = 0;
    let rejected = 0;
    let evaluated = 0;
    for (const s of samples) {
      if (s.rsi === null) continue;
      evaluated += 1;
      const regime = classify(s, volAtr(s), quietAtr(s));
      const isArmed = regime !== 'TRENDING';
      if (isArmed) armed += 1;
      if (isArmed && (s.rsi > 72 || s.rsi < 28)) rejected += 1;
    }
    return { armed, rejected, evaluated };
  };

  const oldAR = armedRejected(() => 11, () => 8.5);
  const newAR = armedRejected((s) => s.price * volatileCoeff, (s) => s.price * quietCoeff);

  console.log(`  OLD  armed ${oldAR.armed}/${oldAR.evaluated} = ${pct(oldAR.armed, oldAR.evaluated)}   rejected ${oldAR.rejected}/${oldAR.evaluated} = ${pct(oldAR.rejected, oldAR.evaluated)}`);
  console.log(`  NEW  armed ${newAR.armed}/${newAR.evaluated} = ${pct(newAR.armed, newAR.evaluated)}   rejected ${newAR.rejected}/${newAR.evaluated} = ${pct(newAR.rejected, newAR.evaluated)}`);

  const armedFell = newAR.armed < oldAR.armed;
  const rejFell = newAR.rejected < oldAR.rejected;
  record('G56-3', armedFell && rejFell, `armed ${pct(oldAR.armed, oldAR.evaluated)} -> ${pct(newAR.armed, newAR.evaluated)}, rejected ${pct(oldAR.rejected, oldAR.evaluated)} -> ${pct(newAR.rejected, newAR.evaluated)}`);

  // ── Emit the constants to paste into the engine ───────────────────────────
  console.log(`\n${line}`);
  console.log('CONSTANTS TO SHIP');
  console.log(line);
  console.log(`  REGIME_VOLATILE_ATR_PCT = ${volatileCoeff.toExponential(4)}   // p85 of ATR/price, n=${samples.length}`);
  console.log(`  REGIME_QUIET_ATR_PCT    = ${quietCoeff.toExponential(4)}   // p25 of ATR/price, n=${samples.length}`);

  const failures = gates.filter((g) => !g.passed).length;
  console.log(`\n${line}`);
  console.log(`ITEM 56 DERIVATION: ${gates.length - failures}/${gates.length} gates passed`);
  console.log(`${line}\n`);
  if (failures > 0) process.exit(3);
}

main().catch((err: unknown) => {
  console.error('item56 derivation failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
