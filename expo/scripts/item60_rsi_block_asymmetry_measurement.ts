/**
 * ITEM 60 — RSI HARD-BLOCK ASYMMETRY MEASUREMENT.
 *
 * MINDSET: measure before building. This script is READ-ONLY against Supabase.
 *
 * The live predicates (signalEngine.ts:8120, :8128) are:
 *   BUY  blocked if features.rsi > 72  && regime.type !== 'TRENDING'
 *   SELL blocked if features.rsi < 28  && regime.type !== 'TRENDING'
 *
 * (a) Confirm the asymmetry: how often is each block armed (regime != TRENDING),
 *     and of armed windows, how often is rsi in the blocking band?
 * (b) On the canonical bar-verified set (trade_outcomes_v1), measure outcomes
 *     for signals that WOULD have been blocked by each rule, split by direction.
 *     State POWER first.
 *
 * DATA-SOURCE RULE: direct Supabase anon read of trade_outcomes_v1.
 * No writes. No engine mutation.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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

interface RemoteOutcomeRow {
  signal_id: string;
  ts: string;
  direction: string | null;
  result: string;
  entry_price: number | string;
  exit_price: number | string;
  pnl: number | string;
  confidence: number | string | null;
  realized_r: number | string | null;
  is_scratch: boolean | null;
  features: unknown;
}

interface FeatureBag {
  rsi?: number;
  marketRegime?: { type?: string };
  atr?: number;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error('Missing Supabase env vars');
    process.exit(1);
  }

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Pull the full durable corpus ──────────────────────────────────────────
  const collected: RemoteOutcomeRow[] = [];
  let offset = 0;
  const pageSize = 500;
  while (true) {
    const res = await client
      .from('trade_outcomes_v1')
      .select('signal_id, ts, direction, result, entry_price, exit_price, pnl, confidence, realized_r, is_scratch, features')
      .order('ts', { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (res.error) {
      console.error('Supabase read error:', res.error.message);
      process.exit(1);
    }
    const rows = (res.data ?? []) as unknown as RemoteOutcomeRow[];
    collected.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  console.log('═'.repeat(80));
  console.log('ITEM 60 — RSI HARD-BLOCK ASYMMETRY MEASUREMENT');
  console.log('═'.repeat(80));
  console.log(`  durable corpus: ${collected.length} rows from trade_outcomes_v1\n`);

  // ── Parse features ────────────────────────────────────────────────────────
  type Parsed = {
    signalId: string;
    direction: 'BUY' | 'SELL' | null;
    result: 'WIN' | 'LOSS';
    rsi: number | null;
    regimeType: string | null;
    realizedR: number | null;
    isScratch: boolean;
  };

  const parsed: Parsed[] = collected.map(r => {
    const f = r.features as FeatureBag;
    const regimeType = f?.marketRegime?.type ?? null;
    return {
      signalId: r.signal_id,
      direction: r.direction === 'BUY' || r.direction === 'SELL' ? r.direction : null,
      result: r.result === 'WIN' ? 'WIN' : 'LOSS',
      rsi: typeof f?.rsi === 'number' ? f.rsi : null,
      regimeType,
      realizedR: r.realized_r !== null ? Number(r.realized_r) : null,
      isScratch: r.is_scratch ?? false,
    };
  });

  // ── (a) Confirm the asymmetry on the durable corpus ──────────────────────
  const withRsi = parsed.filter(p => p.rsi !== null);
  const withDir = withRsi.filter(p => p.direction !== null);
  console.log('  rows with rsi in features:  ', withRsi.length);
  console.log('  rows with direction + rsi:  ', withDir.length);
  console.log('  rows without rsi (null):    ', parsed.length - withRsi.length);
  console.log();

  // Count how many rows have each RSI band, split by direction
  const buys = withDir.filter(p => p.direction === 'BUY');
  const sells = withDir.filter(p => p.direction === 'SELL');

  const buyRsiGt72 = buys.filter(p => (p.rsi ?? 0) > 72);
  const sellRsiLt28 = sells.filter(p => (p.rsi ?? 100) < 28);

  // Regime-armed check: block is armed when regime != TRENDING
  const buyBlockedArmed = buyRsiGt72.filter(p => p.regimeType !== 'TRENDING');
  const sellBlockedArmed = sellRsiLt28.filter(p => p.regimeType !== 'TRENDING');

  console.log('  ── RSI band occupancy by direction (durable corpus) ──');
  console.log(`     BUY  signals: ${buys.length}`);
  console.log(`       rsi > 72  (would block BUY):  ${buyRsiGt72.length}   ${pct(buyRsiGt72.length, buys.length)}`);
  console.log(`         of those, regime != TRENDING (armed):  ${buyBlockedArmed.length}   ${pct(buyBlockedArmed.length, buys.length)}`);
  console.log(`     SELL signals: ${sells.length}`);
  console.log(`       rsi < 28  (would block SELL): ${sellRsiLt28.length}   ${pct(sellRsiLt28.length, sells.length)}`);
  console.log(`         of those, regime != TRENDING (armed):  ${sellBlockedArmed.length}   ${pct(sellBlockedArmed.length, sells.length)}`);
  console.log();

  // ── (b) Outcomes for blocked vs not-blocked, split by direction ──────────
  // POWER STATEMENT (before any result):
  //   n_durable = 51. Subsamples: buyBlocked armed is likely ~5, sellBlocked armed ~1.
  //   At n=5, MDE for a two-proportion WR test (alpha=0.05, power=0.80) is ~47pp.
  //   At n=51 total, MDE is ~25pp. These are UNDERPOWERED for a causal claim.
  //   The structural asymmetry (3x firing rate) needs no power — it is a count.
  console.log('  ── POWER STATEMENT ──');
  console.log(`     n_durable = ${parsed.length}. Subsamples (blocked armed) expected < 10.`);
  console.log(`     MDE at n=10 (alpha=0.05, power=0.80) ≈ 40pp.`);
  console.log(`     MDE at n=51 (alpha=0.05, power=0.80) ≈ 25pp.`);
  console.log(`     The WR comparison is UNDERPOWERED. The asymmetry in firing rate is structural.`);
  console.log();

  // Non-scratch outcomes only (scratch = |R| too small to label)
  const labelled = withDir.filter(p => !p.isScratch);

  const buysLabelled = labelled.filter(p => p.direction === 'BUY');
  const sellsLabelled = labelled.filter(p => p.direction === 'SELL');

  const buyWouldBlock = buysLabelled.filter(p => (p.rsi ?? 0) > 72 && p.regimeType !== 'TRENDING');
  const buyWouldPass = buysLabelled.filter(p => !((p.rsi ?? 0) > 72 && p.regimeType !== 'TRENDING'));

  const sellWouldBlock = sellsLabelled.filter(p => (p.rsi ?? 100) < 28 && p.regimeType !== 'TRENDING');
  const sellWouldPass = sellsLabelled.filter(p => !((p.rsi ?? 100) < 28 && p.regimeType !== 'TRENDING'));

  const wr = (arr: Parsed[]): string => {
    if (arr.length === 0) return 'n/a (n=0)';
    const wins = arr.filter(p => p.result === 'WIN').length;
    return `${pct(wins, arr.length)} (n=${arr.length}, W=${wins}, L=${arr.length - wins})`;
  };

  const avgR = (arr: Parsed[]): string => {
    const withR = arr.filter(p => p.realizedR !== null);
    if (withR.length === 0) return 'n/a';
    const avg = withR.reduce((s, p) => s + (p.realizedR ?? 0), 0) / withR.length;
    return `${avg.toFixed(4)}R (n=${withR.length})`;
  };

  console.log('  ── BUY direction: would-block vs would-pass ──');
  console.log(`     would-block (rsi>72, armed):   WR ${wr(buyWouldBlock)}   EV ${avgR(buyWouldBlock)}`);
  console.log(`     would-pass:                    WR ${wr(buyWouldPass)}   EV ${avgR(buyWouldPass)}`);
  console.log();

  console.log('  ── SELL direction: would-block vs would-pass ──');
  console.log(`     would-block (rsi<28, armed):   WR ${wr(sellWouldBlock)}   EV ${avgR(sellWouldBlock)}`);
  console.log(`     would-pass:                    WR ${wr(sellWouldPass)}   EV ${avgR(sellWouldPass)}`);
  console.log();

  // ── RSI distribution by direction ─────────────────────────────────────────
  console.log('  ── RSI distribution by direction ──');
  const rsiStats = (arr: Parsed[]): string => {
    const vals = arr.map(p => p.rsi ?? 0).sort((a, b) => a - b);
    if (vals.length === 0) return 'n/a';
    const q = (q: number): number => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(vals.length * q)))];
    return `n=${vals.length}  p25=${q(0.25).toFixed(1)}  p50=${q(0.5).toFixed(1)}  p75=${q(0.75).toFixed(1)}  p95=${q(0.95).toFixed(1)}`;
  };
  console.log(`     BUY:  ${rsiStats(buys)}`);
  console.log(`     SELL: ${rsiStats(sells)}`);
  console.log();

  // ── Regime distribution ───────────────────────────────────────────────────
  console.log('  ── Regime distribution (all labelled) ──');
  const regimeCounts = new Map<string, number>();
  for (const p of labelled) {
    const r = p.regimeType ?? 'null';
    regimeCounts.set(r, (regimeCounts.get(r) ?? 0) + 1);
  }
  for (const [r, c] of Array.from(regimeCounts.entries()).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${r}: ${c}  ${pct(c, labelled.length)}`);
  }
  console.log();

  console.log('═'.repeat(80));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
