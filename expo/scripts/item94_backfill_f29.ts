/**
 * ITEM 94(c) — BACKFILL THE 73 CORRUPTED ROWS.
 *
 * F-29: the Edge Function's resolveFromBars had the post-TP1 lock at
 * breakeven (entry) instead of the 0.35R profit lock, so SL_AFTER_BE
 * exits produced realized_r ≈ 0 - cost < 0 and were written as LOSS.
 * This script re-derives each signal canonically, finds the corrupted
 * rows in trade_outcomes_v1, and corrects them in place.
 *
 * DATA-SOURCE RULE:
 *   - emitted_signals_v1, gold_m1_bars, trade_outcomes_v1 READS = anon key
 *   - trade_outcomes_v1 UPDATE (the repair) = service-role key
 *
 * READ-ONLY first pass, then WRITE only the rows that need correction.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

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

// Must mirror the Edge Function's NET R computation exactly.
const EXECUTION_COST_PER_TRADE_USD = 0.20;
const DOLLAR_PER_PRICE_UNIT = 1;
function costInR(riskPriceUnits: number): number {
  const riskUsd = riskPriceUnits * DOLLAR_PER_PRICE_UNIT;
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  return EXECUTION_COST_PER_TRADE_USD / riskUsd;
}

function toTradingSignal(row: Record<string, unknown>): TradingSignal {
  return {
    id: String(row.signal_id ?? ''),
    timestamp: new Date(String(row.emitted_at)),
    createdAt: new Date(String(row.emitted_at)).getTime(),
    type: String(row.direction) === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1 ?? 0),
    tp2: Number(row.tp2 ?? 0),
    tp3: Number(row.tp3 ?? 0),
    sl: Number(row.sl ?? 0),
    confidence: Number(row.confidence ?? 0),
    status: 'ACTIVE' as SignalStatus,
    targetsHit: 0,
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
    slPips: 70,
    tp1Pips: 49,
    tp2Pips: 74,
    tp3Pips: 98,
  } as unknown as TradingSignal;
}

async function fetchAllBarsInRange(
  client: ReturnType<typeof createClient>,
  fromMs: number,
  toMs: number,
): Promise<Bar[]> {
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
      out.push({
        timestamp: new Date(r.timestamp).getTime(),
        open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close),
      });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('ITEM 94(c) — F-29 BACKFILL: REPAIR CORRUPTED SL_AFTER_BE ROWS');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing anon credentials'); process.exit(1); }
  if (!serviceKey) { console.error('BLOCKER: missing service-role key for UPDATE'); process.exit(1); }

  const anonClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
  const adminClient = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // 1. Fetch all emitted_signals_v1 (anon)
  console.log('\n  1. Fetching emitted_signals_v1...');
  const allSignals: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await anonClient.from('emitted_signals_v1').select('*').order('emitted_at', { ascending: true }).range(offset, offset + 999);
    if (error) { console.error(`signal fetch failed: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as Record<string, unknown>[];
    allSignals.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`     ${allSignals.length} rows`);

  // 2. Fetch all gold_m1_bars into memory (anon)
  console.log('  2. Fetching gold_m1_bars...');
  const { data: barsStart } = await anonClient.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const { data: barsEnd } = await anonClient.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsFromMs = new Date(String(barsStart?.[0]?.timestamp)).getTime();
  const barsToMs = new Date(String(barsEnd?.[0]?.timestamp)).getTime();
  const allBars = await fetchAllBarsInRange(anonClient, barsFromMs, barsToMs);
  console.log(`     ${allBars.length} bars (${new Date(barsFromMs).toISOString()} -> ${new Date(barsToMs).toISOString()})`);
  const barsByMinute = new Map<number, Bar>();
  for (const b of allBars) barsByMinute.set(b.timestamp, b);
  const sortedTimestamps = allBars.map(b => b.timestamp).sort((a, b) => a - b);
  function barsInWindow(fromMs: number, toMs: number): Bar[] {
    const out: Bar[] = [];
    for (const ts of sortedTimestamps) {
      if (ts < fromMs) continue;
      if (ts > toMs) break;
      const b = barsByMinute.get(ts);
      if (b) out.push(b);
    }
    return out;
  }

  // 3. Resolve each signal canonically
  console.log('  3. Resolving all signals canonically (fromScratch: true)...');
  const canonicalResults = new Map<string, { status: string; outcomeResult: 'WIN' | 'LOSS' | null; exitPrice: number; entry: number; sl: number; direction: string }>();
  const origConsoleLog = console.log;
  for (const row of allSignals) {
    const sig = toTradingSignal(row);
    const sigTs = sig.createdAt!;
    const barsFrom = sigTs - 60_000;
    const barsTo = sigTs + 4 * 60 * 60 * 1000;
    const bars = barsInWindow(barsFrom, Math.min(barsTo, barsToMs));
    if (bars.length === 0) continue;
    const evalNowMs = Math.min(barsTo, barsToMs);
    try {
      console.log = () => {};
      const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs });
      console.log = origConsoleLog;
      canonicalResults.set(sig.id, {
        status: result.newStatus,
        outcomeResult: result.outcomeResult,
        exitPrice: result.exitPrice,
        entry: sig.entryPrice,
        sl: sig.sl,
        direction: sig.type,
      });
    } catch (err) {
      console.log = origConsoleLog;
    }
  }
  console.log = origConsoleLog;
  console.log(`     ${canonicalResults.size} signals resolved canonically`);

  // 4. Fetch all trade_outcomes_v1 (anon)
  console.log('  4. Fetching trade_outcomes_v1...');
  const { data: toRows } = await anonClient.from('trade_outcomes_v1').select('signal_id, direction, result, realized_r, entry_price, exit_price, pnl, is_scratch');
  const toAll = (toRows ?? []) as { signal_id: string; direction: string | null; result: string; realized_r: number | null; entry_price: number; exit_price: number; pnl: number; is_scratch: boolean | null }[];
  console.log(`     ${toAll.length} rows`);

  // 5. Find corrupted rows: canonical SL_AFTER_BE (WIN) but stored as LOSS or realized_r <= 0
  console.log('\n  5. FINDING CORRUPTED ROWS...');
  const corrupted: { signal_id: string; stored_result: string; stored_realized_r: number | null; canonical_exit: number; canonical_r_gross: number; canonical_r_net: number; entry: number; sl: number; direction: string }[] = [];
  let slAfterBeTotal = 0;
  let lockHonoured = 0;
  let lockOmitted = 0;
  let lockNullR = 0;

  for (const toRow of toAll) {
    const canonical = canonicalResults.get(toRow.signal_id);
    if (!canonical) continue;
    if (canonical.status !== 'SL_AFTER_BE') continue;
    slAfterBeTotal++;

    const risk = Math.abs(canonical.entry - canonical.sl);
    if (risk <= 0) continue;
    const rGross = canonical.direction === 'BUY'
      ? (canonical.exitPrice - canonical.entry) / risk
      : (canonical.entry - canonical.exitPrice) / risk;
    const rNet = rGross - costInR(risk);

    const storedR = toRow.realized_r === null ? null : Number(toRow.realized_r);
    const storedIsLoss = toRow.result === 'LOSS' || (storedR !== null && storedR <= 0);

    if (storedIsLoss) {
      lockOmitted++;
      corrupted.push({
        signal_id: toRow.signal_id,
        stored_result: toRow.result,
        stored_realized_r: storedR,
        canonical_exit: canonical.exitPrice,
        canonical_r_gross: rGross,
        canonical_r_net: rNet,
        entry: canonical.entry,
        sl: canonical.sl,
        direction: canonical.direction,
      });
    } else if (storedR === null) {
      lockNullR++;
    } else {
      lockHonoured++;
    }
  }

  console.log(`     Canonical SL_AFTER_BE rows matched in trade_outcomes_v1: ${slAfterBeTotal}`);
  console.log(`       lock HONOURED (WIN, R > 0)           : ${lockHonoured}`);
  console.log(`       lock OMITTED (LOSS or R <= 0) — TO FIX: ${lockOmitted}`);
  console.log(`       lock with NULL R (already correct label): ${lockNullR}`);
  console.log(`     CORRUPTED ROWS TO REPAIR: ${corrupted.length}`);

  // 6. BACKFILL: update the corrupted rows using the service-role key
  if (corrupted.length === 0) {
    console.log('\n  6. NO ROWS TO REPAIR. Done.');
    console.log(`\n${line}\nDONE — 0 rows corrected\n${line}\n`);
    return;
  }

  console.log(`\n  6. REPAIRING ${corrupted.length} ROWS via service-role UPDATE...`);

  // Report before/after for each row
  console.log('\n     BEFORE / AFTER:');
  let corrected = 0;
  let unchanged = 0;

  for (const c of corrupted) {
    const newPnl = c.direction === 'BUY'
      ? c.canonical_exit - c.entry
      : c.entry - c.canonical_exit;
    const newResult = 'WIN';
    const newRealizedR = parseFloat(c.canonical_r_net.toFixed(6));
    const newExitPrice = c.canonical_exit;

    console.log(
      `       ${c.signal_id.slice(-9)}: ` +
      `result ${c.stored_result} -> ${newResult}, ` +
      `realized_r ${c.stored_realized_r ?? 'null'} -> ${newRealizedR.toFixed(4)}, ` +
      `exit_price ${c.entry.toFixed(1)}(=entry) -> ${newExitPrice.toFixed(1)}(=lock), ` +
      `pnl -> ${newPnl.toFixed(2)}`,
    );

    const { error: updateErr } = await adminClient
      .from('trade_outcomes_v1')
      .update({
        result: newResult,
        realized_r: newRealizedR,
        exit_price: newExitPrice,
        pnl: newPnl,
      })
      .eq('signal_id', c.signal_id);

    if (updateErr) {
      console.error(`       UPDATE FAILED for ${c.signal_id}: ${updateErr.message}`);
      unchanged++;
    } else {
      corrected++;
    }
  }

  console.log(`\n  REPAIR SUMMARY:`);
  console.log(`    rows examined (canonical SL_AFTER_BE matched) : ${slAfterBeTotal}`);
  console.log(`    rows corrected                                  : ${corrected}`);
  console.log(`    rows unchanged (update failed)                  : ${unchanged}`);

  // 7. Re-read trade_outcomes_v1 and report the before/after book
  console.log('\n  7. BEFORE/AFTER BOOK (trade_outcomes_v1.realized_r):');
  const { data: toAfter } = await anonClient.from('trade_outcomes_v1').select('signal_id, result, realized_r');
  const toAfterRows = (toAfter ?? []) as { signal_id: string; result: string; realized_r: number | null }[];
  const usableAfter = toAfterRows.filter(r => r.realized_r !== null);
  const winsAfter = usableAfter.filter(r => Number(r.realized_r) > 0);
  const wrAfter = usableAfter.length > 0 ? (winsAfter.length / usableAfter.length) * 100 : 0;
  const evAfter = usableAfter.length > 0 ? usableAfter.reduce((s, r) => s + Number(r.realized_r), 0) / usableAfter.length : 0;

  // Before book (reconstruct from the corrupted list)
  const usableBefore = usableAfter.length; // same rows, different values
  // The before book had `lockOmitted` rows as LOSS/negative R instead of WIN/positive R
  const beforeWins = winsAfter.length - corrected; // subtract the ones we just made into wins
  const beforeWR = usableBefore > 0 ? (beforeWins / usableBefore) * 100 : 0;
  // Before EV: subtract the corrected rows' old contribution and add back the new
  let beforeEVSUM = usableAfter.reduce((s, r) => s + Number(r.realized_r), 0);
  for (const c of corrupted) {
    if (c.stored_realized_r !== null) {
      beforeEVSUM -= c.canonical_r_net; // remove the new (correct) value
      beforeEVSUM += c.stored_realized_r; // add back the old (corrupt) value
    } else {
      beforeEVSUM -= c.canonical_r_net; // remove the new value; old was null (0 contribution)
    }
  }
  const beforeEV = usableBefore > 0 ? beforeEVSUM / usableBefore : 0;

  console.log(`    BEFORE repair: n=${usableBefore}  WR=${beforeWR.toFixed(2)}%  EV=${beforeEV >= 0 ? '+' : ''}${beforeEV.toFixed(4)}R`);
  console.log(`    AFTER  repair: n=${usableAfter.length}  WR=${wrAfter.toFixed(2)}%  EV=${evAfter >= 0 ? '+' : ''}${evAfter.toFixed(4)}R`);

  console.log(`\n${line}\nDONE — ${corrected} rows corrected, ${unchanged} unchanged\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('item94 backfill failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
