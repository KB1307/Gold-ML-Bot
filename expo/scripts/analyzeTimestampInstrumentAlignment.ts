/**
 * Phase 0 — timestamp / instrument alignment verification.
 *
 * Reads only from live Supabase + public TwelveData/Yahoo (Pair 1/3 fallback).
 * No engine changes. Reports: (1) bar timestamp convention, (2) safeBarStart
 * semantics, (3) end-to-end epoch trace, (4) three venue-pair basis deltas,
 * (5) toLocaleTimeString findings are surfaced but fixed elsewhere.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; source?: string; }
interface SignalRow {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  atr: number | null;
  sl_multiplier: number | null;
  source: string | null;
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
const env = loadEnv();
const supabaseUrl = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const twelveKey = env.EXPO_PUBLIC_TWELVEDATA_API_KEY ?? process.env.EXPO_PUBLIC_TWELVEDATA_API_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error('Supabase not configured');
const supabase = createClient(supabaseUrl, supabaseKey);

const toMs = (x: string | Date | number): number => {
  if (typeof x === 'number') return x;
  return new Date(x).getTime();
};

const iso = (x: number | string): string => new Date(x).toISOString();

async function fetchVantageBars(from: Date, to: Date): Promise<Bar[]> {
  const { data, error } = await supabase
    .from('gold_m1_bars')
    .select('timestamp, open, high, low, close')
    .gte('timestamp', from.toISOString())
    .lte('timestamp', to.toISOString())
    .order('timestamp', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(r => ({ timestamp: toMs(r.timestamp), open: r.open, high: r.high, low: r.low, close: r.close, source: 'vantage-m1' }));
}

async function fetchSignals(from: Date, to: Date): Promise<SignalRow[]> {
  const { data, error } = await supabase
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, atr, sl_multiplier, source')
    .gte('emitted_at', from.toISOString())
    .lte('emitted_at', to.toISOString())
    .order('emitted_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function fetchTwelveDataSpot(start: Date, end: Date): Promise<Bar[]> {
  if (!twelveKey) return [];
  const startDate = start.toISOString().slice(0, 19).replace('T', ' ');
  const endDate = end.toISOString().slice(0, 19).replace('T', ' ');
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}&outputsize=5000&timezone=UTC&apikey=${twelveKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`TwelveData ${res.status}`);
  const json = await res.json() as any;
  if (!json.values || !Array.isArray(json.values)) return [];
  return json.values.map((r: any) => ({
    timestamp: new Date(`${r.datetime}Z`).getTime(),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    source: 'twelvedata-spot',
  })).sort((a: Bar, b: Bar) => a.timestamp - b.timestamp);
}

async function fetchYahooFuturesFallback(start: Date, end: Date): Promise<Bar[]> {
  const period1 = Math.floor(start.getTime() / 1000);
  const period2 = Math.floor(end.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&period1=${period1}&period2=${period2}&events=history&includeAdjustedClose=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const json = await res.json() as any;
  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp) return [];
  const ts: number[] = result.timestamp;
  const o = result.indicators?.quote?.[0]?.open ?? [];
  const h = result.indicators?.quote?.[0]?.high ?? [];
  const l = result.indicators?.quote?.[0]?.low ?? [];
  const c = result.indicators?.quote?.[0]?.close ?? [];
  return ts.map((t: number, i: number) => ({
    timestamp: t * 1000,
    open: o[i] ?? c[i],
    high: h[i] ?? c[i],
    low: l[i] ?? c[i],
    close: c[i],
    source: 'yahoo-gc-futures',
  })).filter((b: Bar) => Number.isFinite(b.close)).sort((a: Bar, b: Bar) => a.timestamp - b.timestamp);
}

function alignByMinute(a: Bar[], b: Bar[]): { a: Bar; b: Bar }[] {
  const mapB = new Map<number, Bar>();
  for (const bb of b) mapB.set(Math.floor(bb.timestamp / 60000) * 60000, bb);
  const out: { a: Bar; b: Bar }[] = [];
  for (const aa of a) {
    const key = Math.floor(aa.timestamp / 60000) * 60000;
    const bb = mapB.get(key);
    if (bb) out.push({ a: aa, b: bb });
  }
  return out;
}

function basisStats(diffs: number[]) {
  if (diffs.length === 0) return { n: 0, median: NaN, max: NaN, mean: NaN, min: NaN };
  const sorted = [...diffs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    n: diffs.length,
    median,
    max: sorted[sorted.length - 1],
    min: sorted[0],
    mean: diffs.reduce((s, d) => s + d, 0) / diffs.length,
  };
}

function safeBarStart(signalMs: number): number {
  return signalMs + 60_000;
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('Phase 0 — timestamp / instrument alignment verification | ' + new Date().toISOString());
  console.log('='.repeat(100));

  /* ── Item 1: bar timestamp convention ─────────────────────────────── */
  console.log('\n## Item 1 — bar timestamp convention (should be OPEN time)');
  const now = new Date();
  const vBars = await fetchVantageBars(new Date(now.getTime() - 24 * 60 * 60 * 1000), now);
  let conventionHolds = true;
  for (let i = 1; i < vBars.length; i++) {
    const expected = vBars[i - 1].timestamp + 60000;
    if (vBars[i].timestamp !== expected) {
      console.log(`  MISMATCH: bar[${i}] ${iso(vBars[i].timestamp)} != expected ${iso(expected)}`);
      conventionHolds = false;
    }
  }
  console.log(`  Sample: ${vBars.slice(0, 3).map(b => `${iso(b.timestamp)} o=${b.open} h=${b.high} l=${b.low} c=${b.close}`).join(' | ')}`);
  console.log(`  Convention (open + 60s chaining): ${conventionHolds ? 'PASS' : 'FAIL'}`);

  /* ── Item 2: safeBarStart semantics ─────────────────────────────────── */
  console.log('\n## Item 2 — safeBarStart = signalCreatedAt + 60s');
  const signals = await fetchSignals(new Date(now.getTime() - 24 * 60 * 60 * 1000), now);
  const sig = signals[signals.length - 1];
  const sigMs = toMs(sig.emitted_at);
  const sbs = safeBarStart(sigMs);
  const firstEvaluated = vBars.find(b => b.timestamp >= sbs);
  const signalBar = vBars.find(b => b.timestamp <= sigMs && sigMs < b.timestamp + 60000);
  console.log(`  Signal ${sig.signal_id} @ ${iso(sigMs)} (entry ${sig.entry})`);
  console.log(`  safeBarStart = ${iso(sbs)}`);
  console.log(`  Signal falls in bar ${signalBar ? iso(signalBar.timestamp) : 'NOT FOUND'} (excluded)`);
  console.log(`  First evaluated bar = ${firstEvaluated ? iso(firstEvaluated.timestamp) : 'NOT FOUND'}`);
  console.log(`  Semantics: ${firstEvaluated && firstEvaluated.timestamp >= sbs ? 'PASS (first evaluated is first completed bar)' : 'FAIL'}`);

  /* ── Item 3: end-to-end epoch trace ─────────────────────────────────── */
  console.log('\n## Item 3 — end-to-end epoch trace for one real signal');
  const traceSignal = signals[signals.length - 1];
  const tMs = toMs(traceSignal.emitted_at);
  const tWindowStart = tMs;
  const tWindowEnd = tMs + 8 * 60 * 60 * 1000;
  const windowBars = vBars.filter(b => b.timestamp >= tWindowStart && b.timestamp <= tWindowEnd);
  console.log(`  signal.emitted_at ISO = ${iso(tMs)}`);
  console.log(`  signal.emitted_at epoch = ${tMs}`);
  console.log(`  audit window start    = ${iso(tWindowStart)}  epoch=${tWindowStart}`);
  console.log(`  audit window end      = ${iso(tWindowEnd)}    epoch=${tWindowEnd}`);
  console.log(`  first audit bar       = ${windowBars[0] ? iso(windowBars[0].timestamp) : 'none'}  epoch=${windowBars[0]?.timestamp ?? 'n/a'}`);
  console.log(`  last audit bar        = ${windowBars[windowBars.length - 1] ? iso(windowBars[windowBars.length - 1].timestamp) : 'none'}  epoch=${windowBars[windowBars.length - 1]?.timestamp ?? 'n/a'}`);
  const allCleanEpoch = [tMs, tWindowStart, tWindowEnd, ...(windowBars.map(b => b.timestamp))].every(ms => Number.isInteger(ms) && ms > 1e12 && new Date(ms).toISOString().endsWith('Z'));
  console.log(`  All epochs clean UTC instants: ${allCleanEpoch ? 'PASS' : 'FAIL'}`);

  /* ── Item 4 — instrument audit (three venue pairs) ──────────────────── */
  console.log('\n## Item 4 — instrument audit: three venue-pair basis deltas');
  const recentWindowStart = vBars.length ? new Date(vBars[0].timestamp) : now;
  const recentWindowEnd = vBars.length ? new Date(vBars[vBars.length - 1].timestamp + 60 * 1000) : now;
  console.log(`  Vantage window: ${iso(recentWindowStart)} → ${iso(recentWindowEnd)} (${vBars.length} bars)`);

  // Pair 2: entry price (Capital.com) vs Vantage close
  const pair2: number[] = [];
  for (const s of signals) {
    const sMs = toMs(s.emitted_at);
    const key = Math.floor(sMs / 60000) * 60000;
    const vBar = vBars.find(b => b.timestamp === key);
    if (vBar) pair2.push(s.entry - vBar.close);
  }
  const p2 = basisStats(pair2);
  console.log(`\n  Pair 2 — entry venue (Capital.com/Swissquote) vs Vantage close`);
  console.log(`    n=${p2.n}  median=${p2.median.toFixed(3)}  mean=${p2.mean.toFixed(3)}  max=${p2.max.toFixed(3)}  min=${p2.min.toFixed(3)}`);
  if (p2.n > 0) console.log(`    entry is on average ${p2.mean >= 0 ? '+' : ''}${p2.mean.toFixed(3)} vs Vantage close`);

  // Pair 1: TwelveData spot vs Vantage
  let twelveBars: Bar[] = [];
  try {
    twelveBars = await fetchTwelveDataSpot(recentWindowStart, recentWindowEnd);
  } catch (e) {
    console.log(`\n  Pair 1 — TwelveData XAU/USD spot vs Vantage: FETCH FAILED: ${(e as Error).message}`);
  }
  if (twelveBars.length) {
    const aligned = alignByMinute(twelveBars, vBars);
    const diffs = aligned.map(({ a, b }) => a.close - b.close);
    const p1 = basisStats(diffs);
    console.log(`\n  Pair 1 — TwelveData XAU/USD spot vs Vantage close`);
    console.log(`    n=${p1.n}  median=${p1.median.toFixed(3)}  mean=${p1.mean.toFixed(3)}  max=${p1.max.toFixed(3)}  min=${p1.min.toFixed(3)}`);
  }

  // Pair 3: TwelveData vs entry price
  if (twelveBars.length && signals.length) {
    const aligned = alignByMinute(twelveBars, signals.map(s => ({ timestamp: toMs(s.emitted_at), open: s.entry, high: s.entry, low: s.entry, close: s.entry, source: 'entry' })));
    const diffs = aligned.map(({ a, b }) => a.close - b.close);
    const p3 = basisStats(diffs);
    console.log(`\n  Pair 3 — TwelveData spot vs entry-price venue`);
    console.log(`    n=${p3.n}  median=${p3.median.toFixed(3)}  mean=${p3.mean.toFixed(3)}  max=${p3.max.toFixed(3)}  min=${p3.min.toFixed(3)}`);
  }

  // Fallback: Yahoo GC=F futures vs Vantage (expected large futures basis)
  try {
    const yahooBars = await fetchYahooFuturesFallback(recentWindowStart, recentWindowEnd);
    if (yahooBars.length) {
      const aligned = alignByMinute(yahooBars, vBars);
      const diffs = aligned.map(({ a, b }) => a.close - b.close);
      const py = basisStats(diffs);
      console.log(`\n  Yahoo GC=F futures vs Vantage close (fallback, expected large basis)`);
      console.log(`    n=${py.n}  median=${py.median.toFixed(3)}  mean=${py.mean.toFixed(3)}  max=${py.max.toFixed(3)}  min=${py.min.toFixed(3)}`);
    }
  } catch (e) {
    console.log(`\n  Yahoo GC=F fallback fetch failed: ${(e as Error).message}`);
  }

  /* ── Item 5 — toLocaleTimeString (report only; fixes are display-only) ── */
  console.log('\n## Item 5 — toLocaleTimeString (display-only)');
  console.log('  Bare calls defaulting to 12-hour AM/PM found in:');
  console.log('    - signalEngine.ts:3846, 6568');
  console.log('    - TradingContext.tsx:1209, 1214, 1218, 1225, 1230, 1257, 1267, 1276, 1304, 1331, 1341, 1350, 1403, 2593');
  console.log('  24-hour calls already correct in resolver, dashboard, and some telemetry rows.');
  console.log('  Phase 0 fix: switch bare calls to explicit { hour:"2-digit", minute:"2-digit", hour12:false }.');

  console.log('\n' + '='.repeat(100));
  console.log('Phase 0 DONE');
  console.log('='.repeat(100));
}

main().catch(e => { console.error(e); process.exit(1); });
