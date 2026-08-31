/**
 * ITEM AI.2 — EV_net by hour_utc on the full era-clean book (RECOMMENDATION
 * ONLY — nothing changes live; BLOCKED_UTC_HOURS stays [4, 11] this round).
 *
 * ONE INSTRUMENT — the canonical book machinery of scripts/canonicalBook.ts,
 * unchanged, grouped by hour. PINNED PARAMETERS (identical to canonicalBook):
 *   Resolution window : 8h (Item 41a authority). safeBarStart = emitted + 60s.
 *   Replay            : the REAL resolveSignalWithBars (services/signalResolver)
 *                       with fromScratch: true — bars only, no stored labels.
 *   Population        : EVERY emitted_signals_v1 row (all sources). Decided =
 *                       outcomeResult !== null; quotable book = decided AND
 *                       full 8h coverage.
 *   Win predicate     : canonical — resolver outcomeResult === 'WIN'
 *                       (equivalently rNet > 0).
 *   Cost model        : shared evCompute — $0.20/trade; NET = GROSS − costInR.
 *   CI                : 95% bootstrap, mulberry32 seed 20260824, 10,000 iters.
 *   Era boundary      : 2026-07-16T10:51:28.481Z (first stored sr_zones_snapshot).
 *   Power             : MDE stated FIRST for every hour — 80% power, two-sided
 *                       5%, sigma ~= 1R: MDE = 2.802 / sqrt(n) R.
 *
 * DATA-SOURCE RULE: gold_m1_bars + emitted_signals_v1 reads = Supabase DIRECT
 * via anon key. READ-ONLY; nothing is written anywhere.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { computeRGross, computeRNet } from '../lib/evCompute';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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
  hour_utc: number | null;
}

const WINDOW_MS = 8 * 60 * 60 * 1000;
const SAFE_BAR_OFFSET_MS = 60_000;
const SNAPSHOT_ERA_START_MS = Date.parse('2026-07-16T10:51:28.481Z');
const BOOTSTRAP_SEED = 20260824;
const BOOTSTRAP_ITERS = 10_000;

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return env;
};

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

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapCI(values: number[]): { lo: number; hi: number } {
  if (values.length === 0) return { lo: NaN, hi: NaN };
  const rnd = mulberry32(BOOTSTRAP_SEED);
  const means: number[] = [];
  for (let it = 0; it < BOOTSTRAP_ITERS; it++) {
    let sum = 0;
    for (let k = 0; k < values.length; k++) sum += values[Math.floor(rnd() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(BOOTSTRAP_ITERS * 0.025)], hi: means[Math.floor(BOOTSTRAP_ITERS * 0.975)] };
}

function lowerBound(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].timestamp < t) lo = mid + 1; else hi = mid; }
  return lo;
}

function upperBound(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].timestamp <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

async function fetchAll<T>(
  client: ReturnType<typeof createClient>,
  table: string,
  select: string,
  orderCol: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from(table).select(select).order(orderCol, { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

interface HourStats { n: number; wins: number; rNetSum: number; rGrossSum: number; rNet: number[] }

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  const allSignalRows = await fetchAll<SignalRow>(client, 'emitted_signals_v1',
    'signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, source, hour_utc', 'emitted_at');

  const { data: barsEndRow } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(barsEndRow?.[0]?.timestamp)).getTime();
  const minSignalMs = Math.min(...allSignalRows.map(r => new Date(r.emitted_at).getTime()));

  const allBars: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(minSignalMs - 60_000).toISOString())
      .lte('timestamp', new Date(barsEndMs).toISOString())
      .order('timestamp', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`gold_m1_bars fetch failed: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) allBars.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }

  console.log(`\n${line}`);
  console.log('ITEM AI.2 — EV_net BY HOUR_UTC ON THE CANONICAL ERA-CLEAN BOOK (fromScratch replay, RECOMMENDATION ONLY)');
  console.log(line);
  console.log(`  run at              : ${new Date().toISOString()}`);
  console.log(`  emitted rows        : ${allSignalRows.length}`);
  console.log(`  gold_m1_bars window : ${new Date(minSignalMs - 60_000).toISOString()} -> ${new Date(barsEndMs).toISOString()} (${allBars.length} bars)`);
  console.log(`  PINNED              : 8h window, safeBarStart=emitted+60s, fromScratch, evCompute $0.20 cost, bootstrap seed ${BOOTSTRAP_SEED}`);
  console.log(`  era boundary        : ${new Date(SNAPSHOT_ERA_START_MS).toISOString()}`);

  interface Replay { hourUtc: number; emittedMs: number; risk: number; outcome: 'WIN' | 'LOSS' | null; exitPrice: number; fullCoverage: boolean; rGross: number; rNet: number }
  const replays: Replay[] = [];
  let noBars = 0;
  const origLog = console.log;
  console.log = () => {};
  for (const row of allSignalRows) {
    const sig = toTradingSignal(row);
    const emittedMs = sig.createdAt ?? 0;
    const windowEnd = Math.min(emittedMs + WINDOW_MS, barsEndMs);
    const lo = lowerBound(allBars, emittedMs - SAFE_BAR_OFFSET_MS);
    const hi = upperBound(allBars, windowEnd);
    const bars = allBars.slice(lo, hi);
    if (bars.length === 0) { noBars += 1; continue; }
    const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: windowEnd });
    if (result.outcomeResult === null) continue;
    const risk = Math.abs(sig.entryPrice - sig.sl);
    if (!(risk > 0)) continue;
    const dir = row.direction === 'BUY' ? 'BUY' : 'SELL';
    const hourUtc = typeof row.hour_utc === 'number' && row.hour_utc >= 0 && row.hour_utc <= 23
      ? row.hour_utc
      : new Date(row.emitted_at).getUTCHours();
    replays.push({
      hourUtc,
      emittedMs,
      risk,
      outcome: result.outcomeResult,
      exitPrice: result.exitPrice,
      fullCoverage: barsEndMs >= emittedMs + WINDOW_MS,
      rGross: computeRGross(dir, Number(row.entry), result.exitPrice, risk),
      rNet: computeRNet(dir, Number(row.entry), result.exitPrice, risk),
    });
  }
  console.log = origLog;

  const decidedFull = replays.filter(r => r.fullCoverage);
  console.log(`\n  canonical replay: ${replays.length} decided (any coverage), ${decidedFull.length} decided with FULL 8h coverage (quotable book), ${noBars} rows with zero bars excluded`);

  const byHour = new Map<number, HourStats>();
  for (const r of decidedFull) {
    let s = byHour.get(r.hourUtc);
    if (!s) { s = { n: 0, wins: 0, rNetSum: 0, rGrossSum: 0, rNet: [] }; byHour.set(r.hourUtc, s); }
    s.n += 1;
    if (r.outcome === 'WIN') s.wins += 1;
    s.rNetSum += r.rNet;
    s.rGrossSum += r.rGross;
    s.rNet.push(r.rNet);
  }

  console.log(`\n  MDE stated FIRST (80% power, two-sided 5%, sigma~=1R): MDE = 2.802/sqrt(n) R`);
  console.log(`  hour_utc |   n |  MDE    | WR     | EV_net            | 95% CI_net (bootstrap)      | era: pre/post-boundary`);
  for (const h of Array.from({ length: 24 }, (_, i) => i)) {
    const s = byHour.get(h);
    const blocked = h === 4 || h === 11 ? ' [BLOCKED_UTC_HOURS]' : '';
    if (!s || s.n === 0) { console.log(`  ${String(h).padStart(2)}Z      |   0 | n/a     | n/a    | n/a${blocked}`); continue; }
    const mde = 2.802 / Math.sqrt(s.n);
    const ci = bootstrapCI(s.rNet);
    const preEra = decidedFull.filter(r => r.hourUtc === h && r.emittedMs < SNAPSHOT_ERA_START_MS).length;
    console.log(`  ${String(h).padStart(2)}Z      | ${String(s.n).padStart(3)} | ±${mde.toFixed(4)}R | ${(s.wins / s.n * 100).toFixed(1)}% | ${(s.rNetSum / s.n >= 0 ? '+' : '')}${(s.rNetSum / s.n).toFixed(4)}R | [${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}] | ${preEra}/${s.n - preEra}${blocked}`);
  }

  const blockedHours = decidedFull.filter(r => r.hourUtc === 4 || r.hourUtc === 11);
  const otherHours = decidedFull.filter(r => r.hourUtc !== 4 && r.hourUtc !== 11);
  const sum = (xs: Replay[]): number => xs.reduce((acc, r) => acc + r.rNet, 0);
  const ciB = bootstrapCI(blockedHours.map(r => r.rNet));
  const ciO = bootstrapCI(otherHours.map(r => r.rNet));
  console.log(`\n  BLOCKED HOURS [4,11] combined : n=${blockedHours.length}  MDE=±${(2.802 / Math.sqrt(Math.max(1, blockedHours.length))).toFixed(4)}R  WR=${blockedHours.length ? (blockedHours.filter(r => r.outcome === 'WIN').length / blockedHours.length * 100).toFixed(1) : 'n/a'}%  EV_net=${blockedHours.length ? (sum(blockedHours) / blockedHours.length).toFixed(4) : 'n/a'}R  CI=[${blockedHours.length ? ciB.lo.toFixed(4) : 'n/a'}, ${blockedHours.length ? ciB.hi.toFixed(4) : 'n/a'}]  (pre-boundary n=${blockedHours.filter(r => r.emittedMs < SNAPSHOT_ERA_START_MS).length})`);
  console.log(`  ALL OTHER HOURS combined      : n=${otherHours.length}  MDE=±${(2.802 / Math.sqrt(Math.max(1, otherHours.length))).toFixed(4)}R  WR=${(otherHours.filter(r => r.outcome === 'WIN').length / otherHours.length * 100).toFixed(1)}%  EV_net=${(sum(otherHours) / otherHours.length).toFixed(4)}R  CI=[${ciO.lo.toFixed(4)}, ${ciO.hi.toFixed(4)}]`);
  const worst = Array.from(byHour.entries()).filter(([, s]) => s.n >= 8).sort((a, b) => (sum(decidedFull.filter(r => r.hourUtc === a[0])) / a[1].n) - (sum(decidedFull.filter(r => r.hourUtc === b[0])) / b[1].n)).slice(0, 3);
  console.log(`\n  worst hours by EV_net (n>=8): ${worst.map(([h, s]) => `${h}Z EV=${(sum(decidedFull.filter(r => r.hourUtc === h)) / s.n).toFixed(4)}R n=${s.n}`).join('  |  ')}`);
}

main().catch(err => { console.error('FATAL:', err instanceof Error ? err.message : String(err)); process.exit(1); });
