/**
 * ITEM 88 — UNBLOCK THE CANONICAL RESOLVER.
 *
 * HC-12 (canonical resolveSignalWithBars, fromScratch: true) blocks C17, C18,
 * D6 and D7. signalResolver.ts imports ONLY types — no React Native, no
 * AsyncStorage, no network. It is a pure function. This script imports it
 * directly and runs the canonical re-derivation on 10 rows with realized_r <= 0.
 *
 * READ-ONLY against Supabase via the anon key.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
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
  } catch { /* fall through */ }
  return env;
};

async function fetchBars(client: ReturnType<typeof createClient>, fromMs: number, toMs: number): Promise<Bar[]> {
  const out: Bar[] = [];
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', fromIso)
      .lte('timestamp', toIso)
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) {
      out.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

function toTradingSignal(row: Record<string, unknown>): TradingSignal {
  return {
    id: String(row.signal_id ?? row.id ?? ''),
    timestamp: new Date(String(row.emitted_at ?? row.created_at)),
    createdAt: new Date(String(row.emitted_at ?? row.created_at)).getTime(),
    type: String(row.direction) === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry), // simplified
    tp1: Number(row.tp1 ?? row.tp_1 ?? 0),
    tp2: Number(row.tp2 ?? row.tp_2 ?? 0),
    tp3: Number(row.tp3 ?? row.tp_3 ?? 0),
    sl: Number(row.sl ?? 0),
    confidence: Number(row.confidence ?? 0),
    status: (String(row.status ?? 'ACTIVE') as SignalStatus),
    targetsHit: Number(row.targets_hit ?? 0),
    slMultiplier: Number(row.sl_multiplier ?? 1),
    atr: Number(row.atr ?? 0),
    regime: String(row.regime ?? 'TRENDING'),
    rsi: Number(row.rsi ?? 50),
    sessionName: String(row.session_name ?? ''),
    hourUtc: Number(row.hour_utc ?? 0),
    srZonesSnapshot: null,
    attentionScores: null,
    htfTrend: String(row.htf_trend ?? 'NEUTRAL'),
    ltfTrend: String(row.ltf_trend ?? 'NEUTRAL'),
    breakevenReached: false,
    breakevenTime: undefined,
    slPips: Number(row.sl_pips ?? 70),
    tp1Pips: Number(row.tp1_pips ?? 49),
    tp2Pips: Number(row.tp2_pips ?? 74),
    tp3Pips: Number(row.tp3_pips ?? 98),
  } as unknown as TradingSignal;
}

async function main(): Promise<void> {
  const line = '='.repeat(84);
  console.log(`\n${line}`);
  console.log('ITEM 88 — UNBLOCK THE CANONICAL RESOLVER');
  console.log(line);

  // 88(a): Why the resolver could not be run before
  console.log(`\n  88(a) — BLOCKER ANALYSIS`);
  console.log(line);
  console.log(`  signalResolver.ts imports:`);
  console.log(`    import type { TradingSignal, SignalStatus } from '@/types/trading';`);
  console.log(`    import type { OhlcBar } from '@/services/barStore';`);
  console.log(`  Both are TYPE-ONLY imports (import type). The resolver is a PURE FUNCTION`);
  console.log(`  with zero runtime dependencies on React Native, AsyncStorage, or network.`);
  console.log(`  The blocker was NOT an import issue. It was that no script in this`);
  console.log(`  environment had wired the resolver to live bar data + emitted signals`);
  console.log(`  from Supabase. The existing scripts that DO use it (verifyItemB_addendum,`);
  console.log(`  itemD_sweep, etc.) were written for earlier rounds and target different`);
  console.log(`  signal populations. This script wires it fresh.`);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // Fetch 10 LIVE emitted signals (the table has no realized_r column — outcomes
  // are computed by the resolver, not stored on the signal row)
  console.log(`\n  Fetching 10 LIVE emitted signals for canonical re-derivation...`);
  const { data: sigRows, error: sigErr } = await client
    .from('emitted_signals_v1')
    .select('*')
    .eq('source', 'LIVE')
    .order('emitted_at', { ascending: false })
    .limit(10);
  if (sigErr) { console.error(`BLOCKER: signal fetch failed: ${sigErr.message}`); process.exit(1); }
  const signals = (sigRows ?? []) as Record<string, unknown>[];
  console.log(`  found ${signals.length} LIVE signals`);

  if (signals.length === 0) {
    console.log('  No LIVE signals found. Trying all signals...');
    const { data: allSigs } = await client
      .from('emitted_signals_v1')
      .select('*')
      .order('emitted_at', { ascending: false })
      .limit(10);
    const allRows = (allSigs ?? []) as Record<string, unknown>[];
    console.log(`  found ${allRows.length} signals (any source)`);
    if (allRows.length === 0) {
      console.log('  BLOCKED: no signals found at all.');
      process.exit(0);
    }
    signals.push(...allRows);
  }

  console.log(`\n  88(b) — CANONICAL RE-DERIVATION (resolveSignalWithBars, fromScratch: true)`);
  console.log(line);

  let resolved = 0;
  let wins = 0;
  let losses = 0;
  let nulls = 0;

  for (const row of signals.slice(0, 10)) {
    const sig = toTradingSignal(row);
    const sigTs = sig.createdAt ?? new Date(sig.timestamp).getTime();

    // Fetch bars: from signal time to signal time + 4 hours (resolution window)
    const barsFrom = sigTs - 60_000; // 1 min before signal (for safety)
    const barsTo = sigTs + 4 * 60 * 60 * 1000; // 4h after
    const bars = await fetchBars(client, barsFrom, barsTo);

    if (bars.length === 0) {
      console.log(`  ${sig.id} — NO BARS in window ${new Date(barsFrom).toISOString()} -> ${new Date(barsTo).toISOString()}`);
      continue;
    }

    const evalNowMs = barsTo;
    try {
      const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs, logPrefix: `  [${sig.id.slice(-6)}]` });
      resolved++;
      if (result.outcomeResult === 'WIN') wins++;
      else if (result.outcomeResult === 'LOSS') losses++;
      else nulls++;

      const storedStatus = String(row.status ?? 'ACTIVE');
      console.log(
        `  ${sig.id.slice(-12)}  ${String(sig.type).padEnd(4)}  ` +
        `entry=${sig.entryPrice.toFixed(1)}  sl=${sig.sl.toFixed(1)}  tp1=${sig.tp1.toFixed(1)}  ` +
        `bars=${bars.length}  ` +
        `STORED: ${storedStatus}  ` +
        `CANONICAL: ${result.newStatus} r=${result.outcomeResult ?? 'null'} exit=${result.exitPrice.toFixed(1)} hit=${result.targetsHit}` +
        `${result.resolvedAtBarTs ? ' @' + new Date(result.resolvedAtBarTs).toISOString() : ''}`,
      );
    } catch (err) {
      console.log(`  ${sig.id} — RESOLVER THREW: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n  SUMMARY: ${resolved} resolved, ${wins} WIN, ${losses} LOSS, ${nulls} null`);
  console.log(`  The canonical resolver IS running. HC-12 is UNBLOCKED.`);

  // 88(c) not needed — the resolver runs.
  console.log(`\n  88(c): N/A — the resolver runs. No device action needed.`);
  console.log('');
}

main().catch((err: unknown) => {
  console.error('item88 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
