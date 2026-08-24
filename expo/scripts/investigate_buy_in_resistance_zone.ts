/**
 * INVESTIGATION: why did a BUY signal fire inside a resistance zone?
 *
 * Reads emitted_signals_v1 for 2026-08-24, prints every BUY with its
 * sr_zones_snapshot, attention_scores, and — when a trade_outcomes_v1 row
 * exists — the realised result. Replays the signal through the real resolver
 * against gold_m1_bars to see what actually happened after emission.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

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
  sr_zones_snapshot: unknown;
  attention_scores: unknown;
  htf_trend: string | null;
  ltf_trend: string | null;
  regime: string | null;
  atr: number | null;
  rsi: number | null;
  hour_utc: number | null;
  session_name: string | null;
  sl_multiplier: number | null;
  strength_diff: number | null;
  raw_confidence: number | null;
}

interface OutcomeRow {
  signal_id: string;
  ts: string;
  result: string;
  exit_price: number | null;
  realized_r: number | null;
  pnl: number | null;
}

const DAY_START_MS = Date.parse('2026-08-24T00:00:00Z');
const DAY_END_MS = Date.parse('2026-08-25T00:00:00Z');
const WINDOW_MS = 8 * 60 * 60 * 1000;

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

const env = loadEnv();
const supabaseUrl = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error('Supabase not configured');
const supabase = createClient(supabaseUrl, supabaseKey);

function toSignal(row: SignalRow): TradingSignal {
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

async function fetchAll<T>(table: string, columns: string, orderColumn: string = 'emitted_at'): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  const page = 1000;
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).order(orderColumn, { ascending: true }).range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data as T[]);
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

async function getBars(fromTs: number, toTs: number): Promise<Bar[]> {
  const { data, error } = await supabase
    .from('gold_m1_bars')
    .select('timestamp, open, high, low, close')
    .gte('timestamp', new Date(fromTs).toISOString())
    .lte('timestamp', new Date(toTs).toISOString())
    .order('timestamp', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ timestamp: new Date(r.timestamp).getTime(), open: r.open, high: r.high, low: r.low, close: r.close }));
}

function fmtR(r: number | null) {
  if (r === null) return 'null';
  return r >= 0 ? `+${r.toFixed(4)}` : r.toFixed(4);
}

function resolve(sig: TradingSignal, bars: Bar[]) {
  const safeStart = sig.createdAt + 60_000;
  const windowBars = bars.filter(b => b.timestamp >= safeStart && b.timestamp < safeStart + WINDOW_MS);
  return resolveSignalWithBars(sig, windowBars, { fromScratch: true });
}

async function main(): Promise<void> {
  const emitted = await fetchAll<SignalRow>('emitted_signals_v1', '*');
  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, ts, result, exit_price, realized_r, pnl', 'ts');
  const outcomeBySignal = new Map(outcomes.map(o => [o.signal_id, o]));

  const today = emitted.filter(e => {
    const ms = new Date(e.emitted_at).getTime();
    return ms >= DAY_START_MS && ms < DAY_END_MS;
  });

  console.log('='.repeat(100));
  console.log(`INVESTIGATION: 2026-08-24 signals — total emitted=${today.length}, BUY=${today.filter(r => r.direction === 'BUY').length}, SELL=${today.filter(r => r.direction === 'SELL').length}`);
  console.log('='.repeat(100));

  for (const row of today) {
    const emittedMs = new Date(row.emitted_at).getTime();
    const outcome = outcomeBySignal.get(row.signal_id);
    const bars = await getBars(emittedMs, emittedMs + WINDOW_MS);
    const sig = toSignal(row);
    const resolved = resolve(sig, bars);

    console.log(`\n${row.emitted_at} UTC  ${row.direction}  entry=${row.entry}  SL=${row.sl}  TP1=${row.tp1}  TP2=${row.tp2}  TP3=${row.tp3}  conf=${row.confidence?.toFixed(2)}  src=${row.source}`);
    console.log(`  id=${row.signal_id}`);
    console.log(`  htf=${row.htf_trend}  ltf=${row.ltf_trend}  regime=${row.regime}  atr=${row.atr?.toFixed(2)}  rsi=${row.rsi?.toFixed(1)}  hour=${row.hour_utc}  session=${row.session_name}`);
    console.log(`  sl_mult=${row.sl_multiplier}  strength_diff=${row.strength_diff?.toFixed(3)}  raw_conf=${row.raw_confidence?.toFixed(3)}`);
    if (outcome) {
      console.log(`  STORED OUTCOME: ${outcome.result}  exit=${outcome.exit_price}  realizedR=${fmtR(outcome.realized_r)}  pnl=${outcome.pnl}`);
    } else {
      console.log(`  STORED OUTCOME: (none yet)`);
    }
    console.log(`  REPLAY: status=${resolved.status}  outcome=${resolved.outcome ?? 'null'}  exitPrice=${resolved.exitPrice ?? 'null'}  targetsHit=${resolved.targetsHit}`);

    const zones = parseZones(row.sr_zones_snapshot);
    if (zones.length) {
      console.log(`  srZones snapshot (${zones.length} zones):`);
      for (const z of zones) {
        const distFromEntry = z.price - row.entry;
        const side = distFromEntry > 0 ? 'above' : 'below';
        console.log(`    ${z.type}@${z.price.toFixed(1)}  dist=${Math.abs(distFromEntry).toFixed(1)}${side}  strength=${(z.reactionStrength * 100).toFixed(0)}%  touches=${z.touches}  source=${z.source}  tier=${z.tier}`);
      }
      const nearestRes = zones.filter(z => z.type === 'RESISTANCE').sort((a, b) => Math.abs(a.price - row.entry) - Math.abs(b.price - row.entry))[0];
      const nearestSup = zones.filter(z => z.type === 'SUPPORT').sort((a, b) => Math.abs(a.price - row.entry) - Math.abs(b.price - row.entry))[0];
      if (nearestRes) console.log(`  NEAREST RESISTANCE to entry: ${nearestRes.price.toFixed(1)}  dist=${Math.abs(nearestRes.price - row.entry).toFixed(1)}  strength=${(nearestRes.reactionStrength * 100).toFixed(0)}%`);
      if (nearestSup) console.log(`  NEAREST SUPPORT to entry:    ${nearestSup.price.toFixed(1)}  dist=${Math.abs(nearestSup.price - row.entry).toFixed(1)}  strength=${(nearestSup.reactionStrength * 100).toFixed(0)}%`);
    } else {
      console.log(`  srZones snapshot: EMPTY or null`);
    }

    const attention = parseAttention(row.attention_scores);
    if (attention && Object.keys(attention).length) {
      console.log(`  attention_scores:`);
      for (const [k, v] of Object.entries(attention)) console.log(`    ${k}: ${v}`);
    } else {
      console.log(`  attention_scores: EMPTY or null`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('DONE');
  console.log('='.repeat(100));
}

function parseZones(raw: unknown): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as any[];
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.zones)) return obj.zones as any[];
    if (Array.isArray(obj.data)) return obj.data as any[];
  }
  return [];
}

function parseAttention(raw: unknown): Record<string, number> | null {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, number>;
  if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
    const map: Record<string, number> = {};
    for (const [k, v] of raw as [string, number][]) map[k] = v;
    return map;
  }
  return null;
}

main().catch(e => { console.error(e); process.exit(1); });
