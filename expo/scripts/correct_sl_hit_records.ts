/**
 * ONE-SHOT CORRECTION — the 4 wrong SL_HIT/0-TP records in trade_outcomes_v1
 * (signals 901, 906, 907, 908), per the 2026-09-01 investigation
 * (checkpoint_sl_hit_no_tp_investigation.txt): the real gold_m1_bars tape shows
 * TPs touched well before the stop bar; the recorded LOSS@SL rows came from the
 * live tick monitor (exit_ts = SL bar + 36-66s tick-confirmation latency).
 *
 * For each signal:
 *   1. re-resolve fromScratch with the REAL resolver over the REAL tape
 *      (identical basis to the canonical replay, item_ai2_by_hour.ts),
 *   2. gate through the REAL shouldApplyBarEvidenceCorrection (stored state =
 *      the SL_HIT/0-banked-targets fingerprint the recorded LOSS@raw-SL row is),
 *   3. gate AGAINST the stored row: only result='LOSS' rows are touched, so the
 *      run is idempotent and can never flip a WIN,
 *   4. write result/exit_price/pnl/realized_r/is_scratch/ts/signal_duration_ms
 *      using the app's own recordTradeOutcome conventions (pnl=|exit-entry| for
 *      WIN, realized_r=pnl/stopDistance 4dp, ts=terminal bar) so the app's
 *      P-1 re-push lands on identical values,
 *   5. read back and print before/after.
 *
 * Writes ONLY these 4 rows via the anon key (migration 005 RLS: anon UPDATE on
 * trade_outcomes_v1). Everything else read-only.
 */
import { resolveSignalWithBars, shouldApplyBarEvidenceCorrection } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface SignalRow { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number }
interface OutcomeRow { signal_id: string; result: string | null; entry_price: number | null; exit_price: number | null; realized_r: number | null; ts: string | null; created_at: string | null }

const SIGNAL_IDS = [
  'signal_1787931941249_x1pgth2n5', // 901
  'signal_1788204958964_qnql740dk', // 906
  'signal_1788205623383_ekszhbsv8', // 907
  'signal_1788238829929_hva9po2xe', // 908
];

const WINDOW_MS = 8 * 60 * 60 * 1000;
const SAFE_BAR_OFFSET_MS = 60_000;
const HORIZON_MS = 9 * 60 * 60 * 1000;

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readEnvLines()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return env;
}
function readEnvLines(): string[] {
  try { return readFileSync('.env', 'utf8').split('\n'); } catch { return []; }
}

function toTradingSignal(row: SignalRow): TradingSignal {
  return {
    id: row.signal_id,
    timestamp: new Date(row.emitted_at),
    createdAt: new Date(row.emitted_at).getTime(),
    type: row.direction === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1),
    tp2: Number(row.tp2),
    tp3: Number(row.tp3),
    sl: Number(row.sl),
    confidence: Number(row.confidence),
    status: 'ACTIVE' as SignalStatus,
    targetsHit: 0,
    breakevenReached: false,
  } as unknown as TradingSignal;
}

function lowerBound(bars: Bar[], t: number): number {
  let lo = 0; let hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].timestamp < t) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(bars: Bar[], t: number): number {
  let lo = 0; let hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].timestamp <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false, storageKey: 'rork-svc-correct-sl' } });

  const { data: sigRows, error: sigErr } = await client.from('emitted_signals_v1')
    .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence')
    .in('signal_id', SIGNAL_IDS).order('emitted_at', { ascending: true });
  if (sigErr) throw new Error(`emitted fetch failed: ${sigErr.message}`);
  const signals = (sigRows ?? []) as SignalRow[];

  const { data: outRows, error: outErr } = await client.from('trade_outcomes_v1')
    .select('signal_id, result, entry_price, exit_price, realized_r, ts, created_at')
    .in('signal_id', SIGNAL_IDS);
  if (outErr) throw new Error(`outcomes fetch failed: ${outErr.message}`);
  const outcomes = new Map<string, OutcomeRow>(((outRows ?? []) as OutcomeRow[]).map(r => [r.signal_id, r]));

  const minEmit = Math.min(...signals.map(s => new Date(s.emitted_at).getTime()));
  const maxEmit = Math.max(...signals.map(s => new Date(s.emitted_at).getTime()));
  const allBars: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(minEmit - 120_000).toISOString())
      .lte('timestamp', new Date(maxEmit + HORIZON_MS).toISOString())
      .order('timestamp', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`gold_m1_bars fetch failed: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) allBars.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }
  console.log(`\n${line}\nONE-SHOT CORRECTION — 4 wrong SL_HIT/0-TP records vs the REAL tape (${allBars.length} bars loaded)\n${line}`);

  for (const row of signals) {
    const sig = toTradingSignal(row);
    const emittedMs = sig.createdAt ?? 0;
    const o = outcomes.get(row.signal_id);
    console.log(`\n— ${row.signal_id.slice(-14)} ${row.direction} emitted ${new Date(emittedMs).toISOString()}`);

    if (!o) { console.log('  NO outcome row — skip'); continue; }
    if (o.result !== 'LOSS') {
      console.log(`  stored result=${o.result} (already corrected / not a LOSS) — idempotent skip`);
      continue;
    }

    const windowEnd = Math.min(emittedMs + WINDOW_MS, allBars.length ? allBars[allBars.length - 1].timestamp : emittedMs);
    const bars = allBars.slice(lowerBound(allBars, emittedMs - SAFE_BAR_OFFSET_MS), upperBound(allBars, windowEnd));
    const origLog = console.log; console.log = () => {};
    const replay = bars.length ? resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: windowEnd }) : null;
    console.log = origLog;

    if (!replay) { console.log('  NO BARS for replay — skip (never guess)'); continue; }
    // Stored state = the corruption fingerprint the recorded row is: result LOSS
    // at the raw SL with zero banked targets ≡ stored SL_HIT / targetsHit 0.
    const stored = { status: 'SL_HIT' as SignalStatus, targetsHit: 0 };
    if (!shouldApplyBarEvidenceCorrection(stored, replay)) {
      console.log(`  gate REFUSES correction (replay ${replay.newStatus}/${replay.outcomeResult} agrees with stored or is not a banked-target WIN) — row left untouched`);
      continue;
    }
    if (replay.resolvedAtBarTs === undefined) { console.log('  replay has no terminal bar ts — skip'); continue; }

    const exitPrice = replay.exitPrice as number;
    const entryPrice = Number(o.entry_price ?? row.entry);
    const risk = Math.abs(Number(row.entry) - Number(row.sl));
    const pnl = Math.abs(exitPrice - entryPrice); // recordTradeOutcome WIN convention (:7970)
    const realizedR = parseFloat((pnl / risk).toFixed(4)); // :8049-8051
    const isScratch = Math.abs(realizedR) < 0.15;
    const terminalTs = new Date(replay.resolvedAtBarTs).toISOString();
    const durationMs = replay.resolvedAtBarTs - emittedMs;

    console.log(`  BEFORE: result=${o.result} exit=${o.exit_price} r=${o.realized_r} ts=${o.ts}`);
    console.log(`  AFTER : result=WIN exit=${exitPrice} pnl=${pnl.toFixed(2)} r=${realizedR} scratch=${isScratch} ts=${terminalTs} dur_ms=${durationMs} (replay ${replay.newStatus}, targetsHit=${replay.targetsHit})`);

    const { error: updErr } = await client.from('trade_outcomes_v1')
      .update({
        result: 'WIN',
        exit_price: exitPrice,
        pnl: parseFloat(pnl.toFixed(4)),
        realized_r: realizedR,
        is_scratch: isScratch,
        ts: terminalTs,
        signal_duration_ms: durationMs,
      })
      .eq('signal_id', row.signal_id)
      .eq('result', 'LOSS'); // atomically refuses to touch a row that is no longer a LOSS
    if (updErr) { console.error(`  UPDATE FAILED: ${updErr.message}`); continue; }

    const { data: back } = await client.from('trade_outcomes_v1')
      .select('result, exit_price, realized_r, ts, signal_duration_ms')
      .eq('signal_id', row.signal_id).limit(1);
    const rb = (back ?? [])[0] as { result: string; exit_price: number; realized_r: number; ts: string; signal_duration_ms: number } | undefined;
    console.log(`  READBACK: result=${rb?.result} exit=${rb?.exit_price} r=${rb?.realized_r} ts=${rb?.ts} dur=${rb?.signal_duration_ms} — ${rb?.result === 'WIN' && Math.abs((rb?.exit_price ?? 0) - exitPrice) < 1e-9 ? 'VERIFIED' : 'MISMATCH'}`);
  }
  console.log(`\n${line}\nDONE (rows touched only where the gate fired; LOSS-guard makes the run idempotent)\n${line}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
