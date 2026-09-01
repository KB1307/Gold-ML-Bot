/**
 * INVESTIGATION — "last 5-7 signals show SL_HIT with no TP hits though they
 * went to TP2+" (user report, 2026-09-01).
 *
 * READ-ONLY. For the 8 newest emitted signals this script:
 *   1. pulls the REAL gold_m1_bars tape covering emission -> emission+9h,
 *   2. reports bar continuity (gaps) so a data hole can be ruled in/out,
 *   3. scans the M1 tape for the FIRST touch of TP1/TP2/TP3 and of the raw SL
 *      and prints the touch ORDER (the user's actual complaint),
 *   4. re-resolves each signal with the REAL resolveSignalWithBars
 *      (fromScratch, same 8h window / safeBarStart semantics as the canonical
 *      replay in item_ai2_by_hour.ts) and prints the result next to the
 *      outcome the server book actually recorded,
 *   5. prints the recorded outcome row (ts / created_at) for the
 *      write-before-exit anomaly seen on signals 902/903/906/907.
 *
 * DATA-SOURCE RULE: Supabase DIRECT via anon key. Nothing is written anywhere.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }

interface SignalRow {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  source: string;
}

interface OutcomeRow {
  signal_id: string;
  result: string | null;
  exit_price: number | null;
  realized_r: number | null;
  ts: string | null;
  created_at: string | null;
  max_favourable_target_reached_before_exit: number | null;
  max_favourable_excursion_before_exit_r: number | null;
}

const WINDOW_MS = 8 * 60 * 60 * 1000;
const SAFE_BAR_OFFSET_MS = 60_000;
const HORIZON_MS = 9 * 60 * 60 * 1000;

const SIGNAL_IDS = [
  'signal_1788238829929_hva9po2xe',
  'signal_1788205623383_ekszhbsv8',
  'signal_1788204958964_qnql740dk',
  'signal_1788187315390_f0vgz8bxt',
  'signal_1788162389260_olbf8kacb',
  'signal_1787947213766_xvq6c5mls',
  'signal_1787939295209_w5vfg4t09',
  'signal_1787931941249_x1pgth2n5',
];

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
  try { return require('node:fs').readFileSync('.env', 'utf8').split('\n'); }
  catch { return []; }
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

/** First-touch scan on the RAW M1 tape. BUY: TP when high >= level, SL when low <= sl. */
function firstTouches(bars: Bar[], dir: 'BUY' | 'SELL', entry: number, sl: number, tp1: number, tp2: number, tp3: number) {
  const touch: Record<string, number | null> = { TP1: null, TP2: null, TP3: null, SL: null };
  for (const b of bars) {
    const hi = b.high; const lo = b.low;
    const hitTP = (lvl: number): boolean => (dir === 'BUY' ? hi >= lvl : lo <= lvl);
    const hitSL = dir === 'BUY' ? lo <= sl : hi >= sl;
    if (touch.SL === null && hitSL) touch.SL = b.timestamp;
    if (touch.TP1 === null && hitTP(tp1)) touch.TP1 = b.timestamp;
    if (touch.TP2 === null && hitTP(tp2)) touch.TP2 = b.timestamp;
    if (touch.TP3 === null && hitTP(tp3)) touch.TP3 = b.timestamp;
    if (touch.SL !== null && touch.TP3 !== null) break;
  }
  void entry;
  return touch;
}

function fmt(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function rel(ms: number | null, fromMs: number): string {
  if (ms === null) return 'never';
  const d = (ms - fromMs) / 60000;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}m`;
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
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false, storageKey: 'rork-svc-invest-sl' } });

  const { data: sigRows, error: sigErr } = await client.from('emitted_signals_v1')
    .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, source')
    .in('signal_id', SIGNAL_IDS).order('emitted_at', { ascending: true });
  if (sigErr) throw new Error(`emitted fetch failed: ${sigErr.message}`);
  const signals = (sigRows ?? []) as SignalRow[];
  console.log(`\n${line}\nINVESTIGATION — SL_HIT/no-TP complaint: last 8 signals vs the REAL M1 tape\n${line}`);

  const { data: outRows, error: outErr } = await client.from('trade_outcomes_v1')
    .select('signal_id, result, exit_price, realized_r, ts, created_at, max_favourable_target_reached_before_exit, max_favourable_excursion_before_exit_r')
    .in('signal_id', SIGNAL_IDS);
  if (outErr) throw new Error(`outcomes fetch failed: ${outErr.message}`);
  const outcomes = new Map<string, OutcomeRow>(((outRows ?? []) as OutcomeRow[]).map(r => [r.signal_id, r]));

  // Tape fetch: min emission - 2min -> max emission + 9h
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
  console.log(`tape: ${allBars.length} M1 bars ${fmt(allBars[0]?.timestamp ?? null)} -> ${fmt(allBars[allBars.length - 1]?.timestamp ?? null)}\n`);

  for (const row of signals) {
    const sig = toTradingSignal(row);
    const emittedMs = sig.createdAt ?? 0;
    const dir: 'BUY' | 'SELL' = row.direction === 'SELL' ? 'SELL' : 'BUY';
    const risk = Math.abs(sig.entryPrice - sig.sl);

    // continuity check within this signal's horizon
    const lo0 = lowerBound(allBars, emittedMs - 120_000);
    const hi0 = upperBound(allBars, emittedMs + HORIZON_MS);
    const tape = allBars.slice(lo0, hi0);
    const gaps: string[] = [];
    for (let i = 1; i < tape.length; i++) {
      const dt = tape[i].timestamp - tape[i - 1].timestamp;
      if (dt > 3 * 60_000) gaps.push(`${fmt(tape[i - 1].timestamp)} -> ${fmt(tape[i].timestamp)} (${(dt / 60000).toFixed(0)}m)`);
    }

    const touch = firstTouches(tape, dir, sig.entryPrice, sig.sl, sig.tp1, sig.tp2, sig.tp3);

    // canonical replay (mirrors item_ai2_by_hour.ts exactly)
    const windowEnd = Math.min(emittedMs + WINDOW_MS, tape.length ? tape[tape.length - 1].timestamp : emittedMs);
    const lo = lowerBound(tape, emittedMs - SAFE_BAR_OFFSET_MS);
    const bars = tape.slice(lo, upperBound(tape, windowEnd));
    const origLog = console.log; console.log = () => {};
    const result = bars.length ? resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: windowEnd }) : null;
    console.log = origLog;

    const o = outcomes.get(row.signal_id);
    console.log(`\n— ${row.signal_id.slice(-14)} ${dir} emitted ${fmt(emittedMs)}  entry ${row.entry} sl ${row.sl} tp1 ${row.tp1} tp2 ${row.tp2} tp3 ${row.tp3} (risk ${risk})`);
    console.log(`  tape bars in horizon: ${tape.length}${gaps.length ? `  GAPS: ${gaps.join(' | ')}` : '  (no gaps > 3m)'}`);
    console.log(`  FIRST TOUCH (raw M1): TP1 ${fmt(touch.TP1)} (${rel(touch.TP1, emittedMs)})  TP2 ${fmt(touch.TP2)} (${rel(touch.TP2, emittedMs)})  TP3 ${fmt(touch.TP3)} (${rel(touch.TP3, emittedMs)})  SL ${fmt(touch.SL)} (${rel(touch.SL, emittedMs)})`);
    const order: string[] = [];
    const t: [string, number | null][] = [['TP1', touch.TP1], ['TP2', touch.TP2], ['TP3', touch.TP3], ['SL', touch.SL]];
    for (const [k, v] of t) if (v !== null) order.push(`${k}@${rel(v, emittedMs)}`);
    console.log(`  touch order: ${order.length ? order.join(' -> ') : 'no touch in horizon'}`);
    console.log(`  REPLAY (real resolver, 8h window, ${bars.length} bars): ${result ? `status=${result.newStatus} outcome=${result.outcomeResult} exit=${result.exitPrice}${result.targetsHit !== undefined ? ` targetsHit=${result.targetsHit}` : ''}${result.breakevenReached ? ' beReached' : ''}` : 'NO BARS'}`);
    console.log(`  RECORDED (trade_outcomes_v1): ${o ? `result=${o.result} exit=${o.exit_price} r=${o.realized_r} exit_ts=${o.ts} written=${o.created_at} mfeTarget=${o.max_favourable_target_reached_before_exit} mfeR=${o.max_favourable_excursion_before_exit_r}` : 'NO ROW'}`);
  }
  console.log(`\n${line}\nEND (read-only)\n${line}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
