/**
 * ITEM 196(d) — THE ASYMMETRIC ENTRY BUFFER, MEASURED BEFORE SHIPPING.
 *
 * The user's design: BUY 4500 -> fill band 4495-4500 (enter DEEPER for a BUY),
 * SELL 4500 -> 4500-4505. Price must retrace into the band to fill; if it
 * never does, the trade is MISSED (forgone EV, not a loss).
 *
 * MEASUREMENTS (pre-registered):
 *   1. Retrace rate at 20/30/50/80 pips ($2/$3/$5/$8) beyond entry, split by
 *      eventual WIN and LOSS (POWER stated).
 *   2. Canonical re-resolution from the deeper entry with the ladder shifted
 *      (Item 104 method), miss cost NETTED (a miss contributes 0R and forgoes
 *      the actual realized_r).
 *   3. DERIVED width = the buffer maximizing net counterfactual EV; shipped
 *      behind an OFF flag.
 *
 * MEASUREMENT ONLY — anon key, Supabase DIRECT.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

function loadEnv(): void {
  const env = readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)=(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

interface Bar { t: number; h: number; l: number; c: number }
interface EmittedRow {
  signal_id: string; emitted_at: string; direction: 'BUY' | 'SELL';
  entry: number; sl: number; tp1: number; tp2: number; tp3: number;
}
interface OutcomeRow { signal_id: string; result: string; realized_r: number | null; is_scratch: boolean | null }

const PIP = 0.1;
const SAFE_BAR_OFFSET_MS = 60_000;
const RESOLUTION_WINDOW_MS = 8 * 60 * 60 * 1000;
const EXECUTION_COST_USD = 0.2;
const TP1_LOCK_R = 0.35;
const TP1_LOCK_MIN_PIPS = 5;
const TP1_LOCK_MAX_FRAC = 0.9;
const WIDTHS_PIPS = [20, 30, 50, 80];

interface Ladder { direction: 'BUY' | 'SELL'; entry: number; sl: number; tp1: number; tp2: number; tp3: number }
interface Resolution { status: string; realizedR: number; filled: boolean }

function costInR(risk: number): number {
  const riskUsd = risk * 1;
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  return EXECUTION_COST_USD / riskUsd;
}

function postTP1LockPrice(s: Ladder): number {
  const stopDistance = Math.abs(s.entry - s.sl);
  const tp1Distance = Math.abs(s.tp1 - s.entry);
  const minDelta = TP1_LOCK_MIN_PIPS * PIP;
  const base = stopDistance > 0 ? stopDistance * TP1_LOCK_R : minDelta;
  const ceiling = tp1Distance > 0 ? tp1Distance * TP1_LOCK_MAX_FRAC : Number.POSITIVE_INFINITY;
  const delta = Math.min(Math.max(base, minDelta), ceiling);
  const raw = s.direction === 'BUY' ? s.entry + delta : s.entry - delta;
  return Number(raw.toFixed(1));
}

function protectedExitPrice(s: Ladder, targetsHit: number): number {
  if (targetsHit >= 2) return Number(((s.tp1 + s.tp2 + s.entry) / 3).toFixed(1));
  if (targetsHit === 1) return postTP1LockPrice(s);
  return s.entry;
}

function resolveLadder(s: Ladder, bars: Bar[], fromMs: number): Resolution | null {
  const isBuy = s.direction === 'BUY';
  const risk = Math.abs(s.entry - s.sl);
  if (risk <= 0) return null;
  const window = bars.filter(b => b.t >= fromMs + SAFE_BAR_OFFSET_MS && b.t <= fromMs + RESOLUTION_WINDOW_MS);
  if (window.length === 0) return null;
  const rOf = (exit: number): number => ((isBuy ? exit - s.entry : s.entry - exit) / risk) - costInR(risk);
  const touched = (b: Bar, level: number): boolean => b.l <= level && b.h >= level;
  let entryFilled = false;
  let tp1Hit = false;
  let tp2Hit = false;
  let lockPrice = s.sl;
  for (const bar of window) {
    if (!entryFilled) {
      if (!touched(bar, s.entry)) continue;
      entryFilled = true;
    }
    if (touched(bar, lockPrice)) {
      if (tp2Hit) return { status: 'PARTIAL_WIN_SL_HIT', realizedR: rOf(protectedExitPrice(s, 2)), filled: true };
      if (tp1Hit) return { status: 'SL_AFTER_BE', realizedR: rOf(lockPrice), filled: true };
      return { status: 'SL_HIT', realizedR: rOf(lockPrice), filled: true };
    }
    if (touched(bar, s.tp3)) return { status: 'ALL_TARGETS_HIT', realizedR: rOf(s.tp3), filled: true };
    if (!tp2Hit && touched(bar, s.tp2)) { tp2Hit = true; lockPrice = s.entry; }
    if (!tp1Hit && touched(bar, s.tp1)) { tp1Hit = true; lockPrice = postTP1LockPrice(s); }
  }
  if (!entryFilled) return { status: 'ENTRY_NEVER_FILLED', realizedR: 0, filled: false };
  return { status: 'CLOSED', realizedR: rOf(window[window.length - 1].c), filled: true };
}

async function fetchAll<T>(table: string, select: string, orderCol: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 60; page++) {
    const { data, error } = await supabase.from(table).select(select).order(orderCol, { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('ITEM 196(d) ENTRY BUFFER MEASUREMENT — ' + new Date().toISOString());
  const emitted = await fetchAll<EmittedRow>('emitted_signals_v1', 'signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3', 'emitted_at');
  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, result, realized_r, is_scratch', 'signal_id');
  const outcomeBySignal = new Map(outcomes.map(o => [o.signal_id, o] as const));
  const canonical = emitted.filter(e => {
    const o = outcomeBySignal.get(e.signal_id);
    return !!o && o.realized_r !== null && (o.is_scratch === null || o.is_scratch === false);
  });
  console.log(`canonical population: n=${canonical.length}`);
  console.log('POWER BEFORE the results: at n~140 the paired EV MDE is roughly ±0.15R; a buffer only wins if it both improves filled-trade R AND keeps the miss rate low.');

  const times = canonical.map(e => new Date(e.emitted_at).getTime());
  const bars: Bar[] = [];
  for (let page = 0; page < 120; page++) {
    const from = new Date(Math.min(...times) + SAFE_BAR_OFFSET_MS).toISOString();
    const to = new Date(Math.max(...times) + RESOLUTION_WINDOW_MS).toISOString();
    const { data, error } = await supabase
      .from('gold_m1_bars')
      .select('timestamp, high, low, close')
      .gte('timestamp', from)
      .lte('timestamp', to)
      .order('timestamp', { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as { timestamp: string; high: number; low: number; close: number }[];
    for (const r of batch) bars.push({ t: new Date(r.timestamp).getTime(), h: Number(r.high), l: Number(r.low), c: Number(r.close) });
    if (batch.length < 1000) break;
  }
  console.log(`bars fetched: ${bars.length}`);

  // 1. retrace rates by WIN/LOSS
  const retrace: { win: boolean; depth$: number }[] = [];
  for (const e of canonical) {
    const emittedMs = new Date(e.emitted_at).getTime();
    const window = bars.filter(b => b.t >= emittedMs + SAFE_BAR_OFFSET_MS && b.t <= emittedMs + RESOLUTION_WINDOW_MS);
    if (window.length === 0) continue;
    const o = outcomeBySignal.get(e.signal_id)!;
    const depth = e.direction === 'BUY'
      ? e.entry - Math.min(...window.map(b => b.l))
      : Math.max(...window.map(b => b.h)) - e.entry;
    retrace.push({ win: o.result === 'WIN', depth$: depth });
  }
  console.log(`\n── 1. RETRACE RATE (adverse excursion beyond entry, 8h window) ──`);
  console.log(`n with bars: ${retrace.length}  (wins=${retrace.filter(r => r.win).length}, losses=${retrace.filter(r => !r.win).length})`);
  for (const pips of WIDTHS_PIPS) {
    const w = pips * PIP;
    const wReach = retrace.filter(r => r.win && r.depth$ >= w).length;
    const lReach = retrace.filter(r => !r.win && r.depth$ >= w).length;
    const nW = retrace.filter(r => r.win).length;
    const nL = retrace.filter(r => !r.win).length;
    console.log(`  >=${String(pips).padStart(2)}p ($${w.toFixed(0)}):  WIN ${(wReach / Math.max(nW, 1) * 100).toFixed(1)}% (${wReach}/${nW})   LOSS ${(lReach / Math.max(nL, 1) * 100).toFixed(1)}% (${lReach}/${nL})`);
  }

  // 2. counterfactual re-resolution at each width, miss cost netted
  const actualMean = canonical.reduce((s, e) => s + (outcomeBySignal.get(e.signal_id)!.realized_r ?? 0), 0) / canonical.length;
  console.log(`\n── 2. COUNTERFACTUAL NET EV (misses contribute 0R and forgo actual R) ──`);
  console.log(`actual mean EV_net: ${actualMean.toFixed(4)}R over n=${canonical.length}`);
  let bestWidth = 0;
  let bestEv = actualMean;
  for (const pips of WIDTHS_PIPS) {
    const w = pips * PIP;
    let sumR = 0;
    let filled = 0;
    let missed = 0;
    let missedForgone = 0;
    let noBarsCount = 0;
    for (const e of canonical) {
      const emittedMs = new Date(e.emitted_at).getTime();
      const delta = e.direction === 'BUY' ? -w : w;
      const moved: Ladder = { direction: e.direction, entry: e.entry + delta, sl: e.sl + delta, tp1: e.tp1 + delta, tp2: e.tp2 + delta, tp3: e.tp3 + delta };
      const res = resolveLadder(moved, bars, emittedMs);
      if (!res) { noBarsCount++; sumR += outcomeBySignal.get(e.signal_id)!.realized_r ?? 0; continue; }
      if (res.filled) { filled++; sumR += res.realizedR; }
      else { missed++; missedForgone += outcomeBySignal.get(e.signal_id)!.realized_r ?? 0; }
    }
    const netEv = sumR / canonical.length;
    console.log(`  buffer ${String(pips).padStart(2)}p: filled=${filled} missed=${missed} (forgone ${missedForgone.toFixed(3)}R) netEV=${netEv.toFixed(4)}R  (delta vs actual ${(netEv - actualMean).toFixed(4)}R)`);
    if (netEv > bestEv) { bestEv = netEv; bestWidth = pips; }
  }
  console.log(`\n── 3. DERIVED WIDTH ──`);
  console.log(`best net-EV width: ${bestWidth > 0 ? `${bestWidth} pips ($${(bestWidth * PIP).toFixed(0)}) at netEV ${bestEv.toFixed(4)}R vs actual ${actualMean.toFixed(4)}R` : 'NONE — no buffer width beats the at-market actual EV (ship flag OFF with width 30p as the design placeholder)'}`);
}

main().catch(err => { console.error('FAILED:', err instanceof Error ? err.message : String(err)); process.exit(1); });
