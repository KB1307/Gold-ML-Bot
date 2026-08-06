/**
 * DIRECTION-SELECTION INVESTIGATION — READ-ONLY. Changes nothing.
 *
 * STEP 1c  outcomes for signals carrying COUNTER TREND BOUNCE SETUP, split by
 *          whether the signal OPPOSED its own htf label.
 * STEP 1d  outcomes for SELLs at RSI < 40 and BUYs at RSI > 60.
 * STEP 2   mirrored-direction counterfactual: same entry, same SL/TP DISTANCES,
 *          opposite side, resolved by the REAL resolver against real bars.
 * STEP 3   the zone touch/reaction predicate, re-run verbatim, plus a
 *          crossing-vs-reversal count for one level over one window.
 *
 * DATA SOURCE: gold_m1_bars read DIRECT from Supabase with the anon key. The
 * Rork backend is never a read path here.
 *
 * Usage: cd expo && bun scripts/investigateDirectionSelection.ts [export.txt]
 */
import { readFileSync, existsSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { createClient } from '@supabase/supabase-js';
import { resolveSignalWithBars, type ResolverOutcome } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

/** .env loader — scripts run outside the Expo bundler so process.env is bare. */
function loadEnv(): Record<string, string> {
  const raw = readFileSync(resolvePath(process.cwd(), '.env'), 'utf-8');
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}
const env = loadEnv();
const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? env.EXPO_PUBLIC_SUPABASE_URL) as string;
const SUPABASE_ANON_KEY = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? env.EXPO_PUBLIC_SUPABASE_ANON_KEY) as string;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  status: string;
  id: string;
  generatedMs: number;
  tp: number[];
  sl: number;
  rsi: number | null;
  htf: string | null;
  regime: string | null;
  adx: number | null;
  features: Map<string, number>;
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function parseExport(path: string): ParsedSignal[] {
  const raw = readFileSync(path, 'utf8');
  const body = raw.slice(raw.indexOf('SECTION 1'), raw.indexOf('SECTION 2'));
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);
  const out: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    const tel = block.match(/forward telemetry: rsi=(\S+)\s+regime=(\S+)\s+regimeStrength=(\S+)\s+atr=(\S+)\s+htf=(\S+)\s+adx=(\S+)/);
    const features = new Map<string, number>();
    // Prefer the FULL attention list; fall back to the top-3 line. Both are the
    // engine's own emitted names, so the labels are the engine's, not mine.
    const fullBlock = block.match(/full attention scores \(\d+ total\):\n((?:\s{6}[^\n]+\n)+)/);
    if (fullBlock) {
      for (const line of fullBlock[1].split('\n')) {
        const m = line.match(/^\s{6}(.+?)=(-?[\d.]+)$/);
        if (m) features.set(m[1].trim(), parseFloat(m[2]));
      }
    } else {
      const top = block.match(/top features: (.+)/);
      if (top) {
        for (const part of top[1].split(', ')) {
          const m = part.match(/^(.+?)=(-?[\d.]+)$/);
          if (m) features.set(m[1].trim(), parseFloat(m[2]));
        }
      }
    }
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      id: block.match(/id: (\S+)/)?.[1] ?? '',
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? '').getTime(),
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
      sl: tpm ? parseFloat(tpm[4]) : 0,
      rsi: tel ? num(tel[1]) : null,
      regime: tel ? tel[2] : null,
      htf: tel ? tel[5] : null,
      adx: tel ? num(tel[6]) : null,
      features,
    });
  }
  return out;
}

async function fetchBars(fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let p = 0; p < 400; p++) {
    const { data, error } = await supabase
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(cursor).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .limit(page);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { timestamp: string; open: number; high: number; low: number; close: number }[]) {
      bars.push({
        timestamp: new Date(r.timestamp).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      } as OhlcBar);
    }
    if (data.length < page) break;
    cursor = bars[bars.length - 1].timestamp + 1;
  }
  return bars;
}

function toTradingSignal(
  p: ParsedSignal,
  override?: { type: 'BUY' | 'SELL'; sl: number; tp: number[] },
): TradingSignal {
  const type = override ? override.type : p.direction;
  const sl = override ? override.sl : p.sl;
  const tp = override ? override.tp : p.tp;
  return {
    id: p.id || `idx-${p.index}`,
    timestamp: new Date(p.generatedMs),
    createdAt: p.generatedMs,
    type,
    entryPrice: p.entry,
    entryPriceWithSlippage: p.entry,
    tp1: tp[0],
    tp2: tp[1],
    tp3: tp[2],
    sl,
    slMultiplier: 1,
    confidence: 0.5,
    status: 'ACTIVE',
    targetsHit: 0,
    entryTime: '',
    topFeatures: [],
  } as unknown as TradingSignal;
}

/** R earned off the fill that was really obtainable. null = no position existed. */
function realisedR(entry: number, sl: number, dirSign: number, out: ResolverOutcome): number | null {
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  if (!out.entryConfirmed) return null;
  const fill = out.entryFillPrice ?? entry;
  return (dirSign * (out.exitPrice - fill)) / risk;
}

const mean = (a: number[]): number => (a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
function profitFactor(rs: number[]): number {
  const gw = rs.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(rs.filter(r => r < 0).reduce((a, b) => a + b, 0));
  return gl === 0 ? Number.POSITIVE_INFINITY : gw / gl;
}

/**
 * Wilson 95% interval on a win rate. Printed so a thin cell cannot be read as a
 * result: if the interval spans the book baseline, the cell is UNDERPOWERED.
 */
function wilson(wins: number, n: number): [number, number] {
  if (n === 0) return [NaN, NaN];
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + (z * z) / (4 * n * n));
  return [(c - s) / d, (c + s) / d];
}

interface Cell {
  label: string;
  rs: number[];
  wins: number;
}
function cell(label: string, rs: number[]): Cell {
  return { label, rs, wins: rs.filter(r => r > 0).length };
}
function printCell(c: Cell, baselineWr: number, minN: number): void {
  const n = c.rs.length;
  if (n === 0) {
    console.log(`  ${c.label.padEnd(46)} n=0     — EMPTY CELL, no verdict`);
    return;
  }
  const wr = (c.wins / n) * 100;
  const [lo, hi] = wilson(c.wins, n);
  const spansBaseline = lo * 100 <= baselineWr && hi * 100 >= baselineWr;
  const verdict = n < minN || spansBaseline ? 'UNDERPOWERED' : 'separable';
  console.log(
    `  ${c.label.padEnd(46)} n=${String(n).padStart(3)}  WR ${wr.toFixed(1).padStart(5)}%  ` +
      `EV ${c.rs.length ? mean(c.rs).toFixed(4).padStart(8) : '     n/a'}R  ` +
      `PF ${profitFactor(c.rs).toFixed(3).padStart(6)}  ` +
      `WR95 [${(lo * 100).toFixed(1)}, ${(hi * 100).toFixed(1)}]  ${verdict}`,
  );
}

const MIN_CELL_N = 30;

async function main(): Promise<void> {
  const exportPath = process.argv[2] ?? '/tmp/diagnostics_export.txt';
  if (!existsSync(exportPath)) {
    console.error(`export not found: ${exportPath}`);
    process.exit(1);
  }

  const signals = parseExport(exportPath);
  const withGeom = signals.filter(s => s.tp.length === 3 && s.sl > 0 && Number.isFinite(s.generatedMs));

  console.log('='.repeat(80));
  console.log('DIRECTION-SELECTION INVESTIGATION — READ-ONLY');
  console.log('='.repeat(80));
  console.log('\nPOWER (stated before any result, rule 7):');
  console.log(`  signals parsed from export       : ${signals.length}`);
  console.log(`  with full geometry + timestamp   : ${withGeom.length}`);

  const minTs = Math.min(...withGeom.map(s => s.generatedMs)) - 60 * 60_000;
  const maxTs = Math.max(...withGeom.map(s => s.generatedMs)) + 8 * 60 * 60_000;
  const bars = await fetchBars(minTs, maxTs);
  const byMinute = new Set<number>(bars.map(b => Math.floor(b.timestamp / 60_000) * 60_000));
  const covered = withGeom.filter(s => byMinute.has(Math.floor(s.generatedMs / 60_000) * 60_000));
  const evalNowMs = bars.length > 0 ? bars[bars.length - 1].timestamp : Date.now();
  console.log(`  gold_m1_bars rows (anon DIRECT)  : ${bars.length}`);
  console.log(`  bar window                       : ${new Date(minTs).toISOString()} .. ${new Date(maxTs).toISOString()}`);
  console.log(`  CANONICAL bar-covered set        : ${covered.length}   <-- denominator for Steps 1c/1d/2`);
  console.log(`  NOT covered (excluded, reported) : ${withGeom.length - covered.length}`);
  console.log(`  evalNowMs = last real bar        : ${new Date(evalNowMs).toISOString()}`);
  console.log(`  minimum cell size for a verdict  : ${MIN_CELL_N} (smaller prints UNDERPOWERED)`);

  // ── resolve every covered signal AS ISSUED and MIRRORED ──────────────
  interface Row {
    p: ParsedSignal;
    actual: ResolverOutcome;
    actualR: number | null;
    mirror: ResolverOutcome;
    mirrorR: number | null;
    mirrorSl: number;
  }
  const rows: Row[] = [];
  const quiet = { fromScratch: true, evalNowMs, logPrefix: '' };
  const origLog = console.log;
  console.log = (): void => {};
  for (const p of covered) {
    const dirSign = p.direction === 'BUY' ? 1 : -1;
    const actualSig = toTradingSignal(p);
    const actual = resolveSignalWithBars(actualSig, bars, quiet);

    // MIRROR: identical entry, identical SL/TP DISTANCES, opposite side.
    const slDist = Math.abs(p.entry - p.sl);
    const tpDist = p.tp.map(t => Math.abs(t - p.entry));
    const mDir: 'BUY' | 'SELL' = p.direction === 'BUY' ? 'SELL' : 'BUY';
    const mSign = mDir === 'BUY' ? 1 : -1;
    const mirrorSl = p.entry - mSign * slDist;
    const mirrorTp = tpDist.map(d => p.entry + mSign * d);
    const mirror = resolveSignalWithBars(
      toTradingSignal(p, { type: mDir, sl: mirrorSl, tp: mirrorTp }),
      bars,
      quiet,
    );
    rows.push({
      p,
      actual,
      actualR: realisedR(p.entry, p.sl, dirSign, actual),
      mirror,
      mirrorR: realisedR(p.entry, mirrorSl, mSign, mirror),
      mirrorSl,
    });
  }
  console.log = origLog;

  const resolvedRows = rows.filter(r => r.actualR !== null);
  const baselineRs = resolvedRows.map(r => r.actualR as number);
  const baselineWr = (baselineRs.filter(r => r > 0).length / baselineRs.length) * 100;
  console.log(`  resolved with a real fill        : ${resolvedRows.length}`);
  console.log(`  BOOK BASELINE                    : WR ${baselineWr.toFixed(1)}%  EV ${mean(baselineRs).toFixed(4)}R  PF ${profitFactor(baselineRs).toFixed(3)}`);

  /**
   * The htf label is present on only a MINORITY of signals: the engine writes
   * `htf=n/a` when the forward-telemetry field was not populated. 'n/a' is
   * UNLABELLED and must never be pooled with either agreeing or opposing, or
   * the split silently becomes "labelled-opposing vs everything else".
   */
  const htfLabelled = (p: ParsedSignal): boolean =>
    p.htf === 'BULLISH' || p.htf === 'BEARISH' || p.htf === 'NEUTRAL';
  const opposedHtf = (p: ParsedSignal): boolean =>
    (p.direction === 'SELL' && p.htf === 'BULLISH') || (p.direction === 'BUY' && p.htf === 'BEARISH');

  console.log('\n  LABEL AVAILABILITY (rule 5 — a measurement is only as good as its labels):');
  for (const h of ['BULLISH', 'BEARISH', 'NEUTRAL', 'n/a'] as const) {
    const n = resolvedRows.filter(r => (r.p.htf ?? 'missing') === h).length;
    console.log(`    htf=${h.padEnd(8)} ${String(n).padStart(3)} of ${resolvedRows.length}  (${((n / resolvedRows.length) * 100).toFixed(1)}%)`);
  }
  const labelledN = resolvedRows.filter(r => htfLabelled(r.p)).length;
  console.log(`    => htf-split cells can only be computed on ${labelledN} of ${resolvedRows.length} signals (${((labelledN / resolvedRows.length) * 100).toFixed(1)}%).`);
  console.log('       On the other rows the htf split is IMPOSSIBLE, not underpowered (rule 8).');

  // ─────────────────── STEP 1b ───────────────────
  // Reconstruct exactly what the drift veto would have read. The veto is
  //   driftAgainst >= features.atr * 2.0,  driftAgainst = +recentDrift for SELL
  //   recentDrift = last12FiveMinCandles[last].close - [first].open  (60 minutes)
  // The engine's own 5-min candles are not stored, so this rebuilds them from
  // real M1 bars. That is a RECONSTRUCTION of the input, not a replay of the
  // engine's internal array — stated plainly rather than claimed as identical.
  console.log(`\n${'='.repeat(80)}\nSTEP 1b — DID THE DRIFT VETO EVALUATE THE TWO SELLs? WHICH PREDICATE FAILED?\n${'='.repeat(80)}`);
  const DRIFT_CANDLES = 12;
  const VETO_MULT = 2.0;
  for (const r of rows.filter(x => x.p.index === 1 || x.p.index === 2)) {
    const p = r.p;
    const genBucket = Math.floor(p.generatedMs / 60_000) * 60_000;
    const windowStart = genBucket - DRIFT_CANDLES * 5 * 60_000;
    const w = bars.filter(b => b.timestamp >= windowStart && b.timestamp < genBucket);
    const drift = w.length >= 2 ? w[w.length - 1].close - w[0].open : null;
    // ATR the engine itself printed for this signal, from its own telemetry line.
    const telAtr = (() => {
      const raw2 = readFileSync(exportPath, 'utf8');
      const blk = raw2.split(`[${p.index}] ${p.direction} @ `)[1] ?? '';
      const m = blk.match(/atr=([\d.]+)/);
      return m ? parseFloat(m[1]) : null;
    })();
    const driftAgainst = drift === null ? null : (p.direction === 'BUY' ? -drift : drift);
    const threshold = telAtr === null ? null : telAtr * VETO_MULT;
    console.log(`\n  [${p.index}] ${p.direction} @ ${p.entry}   generated ${new Date(p.generatedMs).toISOString()}   htf=${p.htf}  rsi=${p.rsi}`);
    console.log(`    isCounterTrendSignal = (SELL && htf===BULLISH) = ${p.direction === 'SELL' && p.htf === 'BULLISH'}  -> the veto DID evaluate it`);
    console.log(`    reconstructed 60-min drift (close[-1] - open[-60]) = ${drift === null ? 'n/a' : (drift >= 0 ? '+' : '') + drift.toFixed(2)}   (${w.length} M1 bars in window)`);
    console.log(`    driftAgainst (SELL => +drift)                      = ${driftAgainst === null ? 'n/a' : driftAgainst.toFixed(2)}`);
    console.log(`    veto threshold = atr ${telAtr ?? 'n/a'} x ${VETO_MULT}            = ${threshold === null ? 'n/a' : threshold.toFixed(2)}`);
    const fired = driftAgainst !== null && threshold !== null && driftAgainst >= threshold;
    console.log(`    PREDICATE driftAgainst >= threshold               = ${fired ? 'TRUE -> would REJECT' : 'FALSE -> veto did NOT fire'}`);
    if (!fired && driftAgainst !== null && threshold !== null) {
      console.log(`    THE PREDICATE THAT FAILED: ${driftAgainst.toFixed(2)} >= ${threshold.toFixed(2)} is false (short by ${(threshold - driftAgainst).toFixed(2)})`);
    }
    // what price did AFTER, for contrast
    const after = bars.filter(b => b.timestamp >= genBucket && b.timestamp <= genBucket + 3 * 60 * 60_000);
    if (after.length > 0) {
      const hi = Math.max(...after.map(b => b.high));
      console.log(`    for contrast, price AFTER generation (3h): max high ${hi.toFixed(1)} = +$${(hi - p.entry).toFixed(2)} against the SELL`);
    }
  }
  console.log('\n  NOTE ON UNITS in the counter-trend structural gate (validateStructuralConditions):');
  console.log('    `const bounceThreshold = 10;` is compared as  Math.abs(zone.price - currentPrice) < 10');
  console.log('    i.e. TEN DOLLARS = 100 pips, while the comment and the tip string both say "10 pips".');
  console.log('    Distance from these SELL entries to the nearest qualifying RESISTANCE:');
  for (const r of rows.filter(x => x.p.index === 1 || x.p.index === 2)) {
    console.log(`      [${r.p.index}] entry ${r.p.entry} -> RESISTANCE 4256.6 is $${Math.abs(4256.6 - r.p.entry).toFixed(2)} away  (passes a $10 band; would FAIL a true 10-pip/$1.00 band)`);
  }

  // ─────────────────── STEP 1c ───────────────────
  console.log(`\n${'='.repeat(80)}\nSTEP 1c — OUTCOMES FOR "COUNTER TREND BOUNCE SETUP" CARRIERS\n${'='.repeat(80)}`);
  const KEY = 'COUNTER TREND BOUNCE SETUP';
  const carriers = resolvedRows.filter(r => r.p.features.has(KEY));
  console.log(`Carriers in the canonical resolved set: ${carriers.length} of ${resolvedRows.length}`);
  console.log(`  carrier direction split: BUY ${carriers.filter(r => r.p.direction === 'BUY').length} / SELL ${carriers.filter(r => r.p.direction === 'SELL').length}`);
  console.log(`  htf label on carriers   : ${['BULLISH', 'BEARISH', 'NEUTRAL', 'n/a'].map(h => `${h}=${carriers.filter(r => (r.p.htf ?? 'n/a') === h).length}`).join('  ')}`);
  console.log('');
  printCell(cell('ALL carriers', carriers.map(r => r.actualR as number)), baselineWr, MIN_CELL_N);
  printCell(
    cell('carriers OPPOSING htf (labelled only)', carriers.filter(r => opposedHtf(r.p)).map(r => r.actualR as number)),
    baselineWr,
    MIN_CELL_N,
  );
  printCell(
    cell('carriers AGREEING htf (labelled only)', carriers.filter(r => htfLabelled(r.p) && !opposedHtf(r.p)).map(r => r.actualR as number)),
    baselineWr,
    MIN_CELL_N,
  );
  printCell(
    cell('carriers htf UNLABELLED (no verdict poss.)', carriers.filter(r => !htfLabelled(r.p)).map(r => r.actualR as number)),
    baselineWr,
    MIN_CELL_N,
  );
  printCell(
    cell('non-carriers', resolvedRows.filter(r => !r.p.features.has(KEY)).map(r => r.actualR as number)),
    baselineWr,
    MIN_CELL_N,
  );
  console.log('\n  SELL carriers (the feature is BULLISH-signed; these are the mislabelled cell):');
  printCell(
    cell('SELL carriers, htf=BULLISH', carriers.filter(r => r.p.direction === 'SELL' && r.p.htf === 'BULLISH').map(r => r.actualR as number)),
    baselineWr,
    MIN_CELL_N,
  );
  printCell(
    cell('BUY carriers, htf=BULLISH', carriers.filter(r => r.p.direction === 'BUY' && r.p.htf === 'BULLISH').map(r => r.actualR as number)),
    baselineWr,
    MIN_CELL_N,
  );

  // ─────────────────── STEP 1d ───────────────────
  console.log(`\n${'='.repeat(80)}\nSTEP 1d — RSI-SIDE MISMATCH: SELLs at RSI<40, BUYs at RSI>60\n${'='.repeat(80)}`);
  const withRsi = resolvedRows.filter(r => r.p.rsi !== null);
  console.log(`Signals with an rsi label: ${withRsi.length} of ${resolvedRows.length}`);
  printCell(cell('SELL, RSI < 40', withRsi.filter(r => r.p.direction === 'SELL' && (r.p.rsi as number) < 40).map(r => r.actualR as number)), baselineWr, MIN_CELL_N);
  printCell(cell('SELL, RSI >= 40', withRsi.filter(r => r.p.direction === 'SELL' && (r.p.rsi as number) >= 40).map(r => r.actualR as number)), baselineWr, MIN_CELL_N);
  printCell(cell('BUY, RSI > 60', withRsi.filter(r => r.p.direction === 'BUY' && (r.p.rsi as number) > 60).map(r => r.actualR as number)), baselineWr, MIN_CELL_N);
  printCell(cell('BUY, RSI <= 60', withRsi.filter(r => r.p.direction === 'BUY' && (r.p.rsi as number) <= 60).map(r => r.actualR as number)), baselineWr, MIN_CELL_N);
  console.log('  pooled "late on the RSI axis" cell:');
  printCell(
    cell('SELL RSI<40 OR BUY RSI>60', withRsi
      .filter(r => (r.p.direction === 'SELL' && (r.p.rsi as number) < 40) || (r.p.direction === 'BUY' && (r.p.rsi as number) > 60))
      .map(r => r.actualR as number)),
    baselineWr,
    MIN_CELL_N,
  );
  console.log('  the two live SELLs sit at RSI 34.05 / 38.48 — inside the SELL RSI<40 cell.');

  // ─────────────────── STEP 2 ───────────────────
  console.log(`\n${'='.repeat(80)}\nSTEP 2 — MIRRORED-DIRECTION COUNTERFACTUAL\n${'='.repeat(80)}`);
  console.log('Construction: same entry price, same SL distance, same TP distances, opposite side.');
  console.log('Resolved by the REAL resolveSignalWithBars against real gold_m1_bars,');
  console.log('{ fromScratch: true, evalNowMs = last real bar }. WIN predicate = R > 0.\n');
  console.log('LIMIT — STATED BEFORE THE NUMBERS (rule 8 discipline, and it is not optional):');
  console.log('  This does NOT show the engine would have generated the opposite signal, and it');
  console.log('  is NOT an achievable alternative strategy. Nothing here proposes "invert the');
  console.log('  book". It measures ONE thing: how often, at that instant and with that exact');
  console.log('  geometry, the other side was the winning side. It is a diagnostic on DIRECTION');
  console.log('  SELECTION, and it is mechanically near-antisymmetric by construction, so its');
  console.log('  own EV must never be quoted as a tradable result.\n');

  const mirrorResolved = rows.filter(r => r.actualR !== null && r.mirrorR !== null);
  console.log(`POWER: both sides resolved with a real fill: ${mirrorResolved.length} of ${rows.length}`);
  console.log(`  actual filled but mirror unfilled : ${rows.filter(r => r.actualR !== null && r.mirrorR === null).length}`);
  console.log(`  mirror filled but actual unfilled : ${rows.filter(r => r.actualR === null && r.mirrorR !== null).length}`);

  const losers = mirrorResolved.filter(r => (r.actualR as number) <= 0);
  const winners = mirrorResolved.filter(r => (r.actualR as number) > 0);
  const losersMirrorWon = losers.filter(r => (r.mirrorR as number) > 0);
  const winnersMirrorLost = winners.filter(r => (r.mirrorR as number) <= 0);
  console.log('\n(a) FLIP TABLE');
  console.log(`  LOST as issued : ${losers.length}   of which the MIRROR WON : ${losersMirrorWon.length}  (${((losersMirrorWon.length / Math.max(1, losers.length)) * 100).toFixed(1)}%)`);
  console.log(`  WON  as issued : ${winners.length}   of which the MIRROR LOST: ${winnersMirrorLost.length}  (${((winnersMirrorLost.length / Math.max(1, winners.length)) * 100).toFixed(1)}%)`);
  const bothLost = mirrorResolved.filter(r => (r.actualR as number) <= 0 && (r.mirrorR as number) <= 0);
  const bothWon = mirrorResolved.filter(r => (r.actualR as number) > 0 && (r.mirrorR as number) > 0);
  console.log(`  BOTH sides lost (geometry, not direction): ${bothLost.length}  (${((bothLost.length / Math.max(1, mirrorResolved.length)) * 100).toFixed(1)}%)`);
  console.log(`  BOTH sides won  (chop / both ladders paid): ${bothWon.length}  (${((bothWon.length / Math.max(1, mirrorResolved.length)) * 100).toFixed(1)}%)`);

  console.log('\n(b) BOOK EV — actual vs mirrored, then split');
  const evLine = (label: string, rsA: number[], rsM: number[]): void => {
    const wrA = (rsA.filter(r => r > 0).length / Math.max(1, rsA.length)) * 100;
    const wrM = (rsM.filter(r => r > 0).length / Math.max(1, rsM.length)) * 100;
    console.log(
      `  ${label.padEnd(34)} n=${String(rsA.length).padStart(3)}  ` +
        `ACTUAL EV ${mean(rsA).toFixed(4).padStart(8)}R WR ${wrA.toFixed(1).padStart(5)}%  |  ` +
        `MIRROR EV ${mean(rsM).toFixed(4).padStart(8)}R WR ${wrM.toFixed(1).padStart(5)}%`,
    );
  };
  evLine('WHOLE BOOK', mirrorResolved.map(r => r.actualR as number), mirrorResolved.map(r => r.mirrorR as number));
  for (const d of ['BUY', 'SELL'] as const) {
    const sub = mirrorResolved.filter(r => r.p.direction === d);
    evLine(`issued ${d}`, sub.map(r => r.actualR as number), sub.map(r => r.mirrorR as number));
  }
  const agreeing = mirrorResolved.filter(r => htfLabelled(r.p) && r.p.htf !== 'NEUTRAL' && !opposedHtf(r.p));
  const opposing = mirrorResolved.filter(r => opposedHtf(r.p));
  const neutralHtf = mirrorResolved.filter(r => r.p.htf === 'NEUTRAL');
  const unlabelled = mirrorResolved.filter(r => !htfLabelled(r.p));
  evLine('htf-AGREEING (labelled)', agreeing.map(r => r.actualR as number), agreeing.map(r => r.mirrorR as number));
  evLine('htf-OPPOSING (labelled)', opposing.map(r => r.actualR as number), opposing.map(r => r.mirrorR as number));
  evLine('htf=NEUTRAL (labelled)', neutralHtf.map(r => r.actualR as number), neutralHtf.map(r => r.mirrorR as number));
  evLine('htf UNLABELLED — NOT a split', unlabelled.map(r => r.actualR as number), unlabelled.map(r => r.mirrorR as number));
  const ctb = mirrorResolved.filter(r => r.p.features.has(KEY));
  evLine('COUNTER TREND BOUNCE carriers', ctb.map(r => r.actualR as number), ctb.map(r => r.mirrorR as number));
  const sellLowRsi = mirrorResolved.filter(r => r.p.direction === 'SELL' && r.p.rsi !== null && r.p.rsi < 40);
  evLine('SELL at RSI<40', sellLowRsi.map(r => r.actualR as number), sellLowRsi.map(r => r.mirrorR as number));

  // DEGENERACY CHECK. The ladder's TP1 sits at 0.70R while the stop sits at
  // 1.00R, so ANY full-SL loss means price travelled 1.00R against the issued
  // side — which is 1.43x the distance the MIRROR needed for its own TP1. For
  // those rows "the mirror won" is an ARITHMETIC IDENTITY of the ladder, not
  // evidence about direction. Quantify how much of the flip table is identity.
  const fullSlLosers = losers.filter(r => r.actual.targetsHit === 0);
  console.log('\n(a-DEGENERACY) how much of the loser flip is a ladder identity, not a finding:');
  console.log(`  losers with targetsHit=0 (full 1.00R stop, no partial): ${fullSlLosers.length} of ${losers.length}`);
  console.log(`  for those, mirror TP1 (0.70R) is CLOSER than the distance price already travelled (1.00R),`);
  console.log(`  and mirror SL (1.00R the other way) cannot have printed first or the issued side would`);
  console.log(`  have banked TP3 (1.40R). So mirror-wins is FORCED for all ${fullSlLosers.length}.`);
  console.log(`  mirror won among those: ${fullSlLosers.filter(r => (r.mirrorR as number) > 0).length} (expected = all of them)`);
  console.log('  => the 100% figure below is TAUTOLOGICAL and carries NO directional information.');

  console.log('\n(d) WHICH CONSTRAINT BINDS');
  const mirrorWinRateAmongLosers = (losersMirrorWon.length / Math.max(1, losers.length)) * 100;
  console.log(`  mirror-win rate among losers: ${mirrorWinRateAmongLosers.toFixed(1)}%`);
  console.log(`  losses where BOTH sides lost: ${((bothLost.length / Math.max(1, losers.length)) * 100).toFixed(1)}% of losers`);
  console.log('  Reading: BOTH numbers are forced by the ladder geometry (TP1 0.70R < SL 1.00R),');
  console.log('  so neither answers 1(d). The DIRECTIONAL question is answered instead by the');
  console.log('  BOTH-SIDES-WON cell and by mirror EV vs actual EV, printed above.');
  console.log(`  both-sides-won share of the whole book: ${((bothWon.length / Math.max(1, mirrorResolved.length)) * 100).toFixed(1)}%`);
  console.log('  — in those rows the 0.70R TP1 was reachable in BOTH directions from the same');
  console.log('  entry, i.e. the ladder banked noise and the side chosen was irrelevant.');

  // the two live SELLs, individually
  console.log('\n  THE TWO LIVE SELLs, mirrored individually:');
  for (const r of rows.filter(r => r.p.index === 1 || r.p.index === 2)) {
    console.log(
      `    [${r.p.index}] SELL entry ${r.p.entry} sl ${r.p.sl} -> actual ${r.actual.newStatus} R=${r.actualR === null ? 'null' : (r.actualR as number).toFixed(3)}` +
        `  |  MIRROR BUY sl ${r.mirrorSl.toFixed(1)} -> ${r.mirror.newStatus} targets ${r.mirror.targetsHit} R=${r.mirrorR === null ? 'null' : (r.mirrorR as number).toFixed(3)}`,
    );
  }

  // ─────────────────── STEP 3 ───────────────────
  console.log(`\n${'='.repeat(80)}\nSTEP 3 — TOUCH-COUNT / REACTION PREDICATE, RE-RUN VERBATIM\n${'='.repeat(80)}`);
  const LEVEL = 4256.6;
  const winFrom = Date.parse('2026-08-06T03:00:00.000Z');
  const winTo = Date.parse('2026-08-06T07:00:00.000Z');
  const win = bars.filter(b => b.timestamp >= winFrom && b.timestamp <= winTo);
  console.log(`Window: 2026-08-06T03:00Z .. 07:00Z   bars present: ${win.length} (of 241 possible minutes)`);

  // zoneWidth exactly as the writer computes it: max(atr*0.3, price*0.0015),
  // atr = mean TR over the LAST 14 bars of the 120h series (writer's own form).
  const last14 = bars.slice(-15);
  let trSum = 0;
  for (let i = 1; i < last14.length; i++) {
    trSum += Math.max(
      last14[i].high - last14[i].low,
      Math.abs(last14[i].high - last14[i - 1].close),
      Math.abs(last14[i].low - last14[i - 1].close),
    );
  }
  const writerAtr = trSum / Math.max(1, last14.length - 1);
  const currentPrice = bars.length > 0 ? bars[bars.length - 1].close : LEVEL;
  const zoneWidth = Math.max(writerAtr * 0.3, currentPrice * 0.0015);
  console.log(`\n  writer atr (mean TR, last 14 bars) = ${writerAtr.toFixed(3)}`);
  console.log(`  currentPrice                       = ${currentPrice.toFixed(1)}`);
  console.log(`  zoneWidth = max(atr*0.3=${(writerAtr * 0.3).toFixed(3)}, price*0.0015=${(currentPrice * 0.0015).toFixed(3)}) = ${zoneWidth.toFixed(3)}`);
  console.log(`  => the "touch" band for ${LEVEL} is [${(LEVEL - zoneWidth).toFixed(1)}, ${(LEVEL + zoneWidth).toFixed(1)}]  (width ${(zoneWidth * 2).toFixed(1)} dollars = ${(zoneWidth * 2 * 10).toFixed(0)} pips)`);

  // (a) the touch predicate, verbatim: close within zoneWidth. Consecutive bars
  // each count. Measure the run structure to show what the count really is.
  let touches = 0;
  let runs = 0;
  let inRun = false;
  let longestRun = 0;
  let curRun = 0;
  for (const b of win) {
    const isTouch = Math.abs(b.close - LEVEL) < zoneWidth;
    if (isTouch) {
      touches++;
      curRun++;
      if (!inRun) {
        runs++;
        inRun = true;
      }
      longestRun = Math.max(longestRun, curRun);
    } else {
      inRun = false;
      curRun = 0;
    }
  }
  console.log(`\n(a) TOUCH PREDICATE (verbatim: Math.abs(close - level) < zoneWidth)`);
  console.log(`  bars satisfying it in-window        : ${touches} of ${win.length}  (${((touches / Math.max(1, win.length)) * 100).toFixed(1)}% of minutes)`);
  console.log(`  DISTINCT contiguous visits (runs)   : ${runs}`);
  console.log(`  longest single uninterrupted run    : ${longestRun} consecutive bars, all counted separately`);
  console.log(`  => the predicate counts BAR-MINUTES OF OCCUPANCY, not visits.`);

  // (c) crossings vs reversals, on the SAME level and window.
  let crossings = 0;
  let reversals = 0;
  const REVERSAL_ATR_MULT = 1.0;
  const approachBand = Math.max(0.5, writerAtr * 0.5);
  for (let i = 1; i < win.length; i++) {
    const prev = win[i - 1].close - LEVEL;
    const cur = win[i].close - LEVEL;
    if (prev !== 0 && Math.sign(prev) !== Math.sign(cur)) crossings++;
  }
  // A REVERSAL: bar comes within approachBand of the level from one side, and
  // within the next 15 bars moves REVERSAL_ATR_MULT*atr AWAY on the approach
  // side WITHOUT any close crossing to the other side.
  for (let i = 0; i < win.length; i++) {
    const d = win[i].close - LEVEL;
    if (Math.abs(d) > approachBand) continue;
    const side = Math.sign(d) || 1;
    let confirmed = false;
    for (let j = i + 1; j < Math.min(win.length, i + 16); j++) {
      const dj = win[j].close - LEVEL;
      if (Math.sign(dj) !== side && dj !== 0) break; // crossed instead of reversing
      if (side * dj >= REVERSAL_ATR_MULT * writerAtr) {
        confirmed = true;
        break;
      }
    }
    if (confirmed) {
      reversals++;
      i += 15; // do not double-count the same reversal
    }
  }
  console.log(`\n(c) CROSSINGS vs GENUINE REVERSALS on ${LEVEL}, same window`);
  console.log(`  CROSSINGS (close changed side)      : ${crossings}`);
  console.log(`  REVERSALS (approached within ${approachBand.toFixed(2)}, then moved >= ${(REVERSAL_ATR_MULT * writerAtr).toFixed(2)} away, no cross): ${reversals}`);
  console.log(`  crossing : reversal ratio           : ${reversals === 0 ? 'all crossings, ZERO reversals' : (crossings / reversals).toFixed(2) + ' : 1'}`);

  // (b) reaction% saturation, across every zone row in the export.
  console.log(`\n(b) REACTION% SATURATION — reaction formula re-stated from the writer:`);
  console.log('  touchScore        = min(1, touches/6)                  <-- SATURATES AT 6 TOUCHES');
  console.log('  rejectionScore    = min(1, rejectionWicks/4)');
  console.log('  rejectionSizeScore= min(1, avgRejectionSize/(atr*0.5))');
  console.log('  confluence terms  = min(1, confluenceScore/3)*0.2 + min(1, confluenceScore*0.25)');
  console.log('  raw = min(1, touchScore*0.3 + rejectionScore*0.3 + rejectionSizeScore*0.2 + confluence terms)');
  console.log('  reaction = min(1, raw * 0.5^(ageHours/18))');
  const raw = readFileSync(exportPath, 'utf8');
  const zoneLines = [...raw.matchAll(/^\s+(SUPPORT|RESISTANCE) @ ([\d.]+)\s+touches=(\d+)\s+reaction=(\d+)%/gm)];
  const tArr = zoneLines.map(m => parseInt(m[3], 10)).sort((a, b) => a - b);
  const rArr = zoneLines.map(m => parseInt(m[4], 10)).sort((a, b) => a - b);
  const q = (arr: number[], p: number): number => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : NaN);
  console.log(`\n  zone rows in export: ${zoneLines.length}`);
  console.log(`  touches   p50=${q(tArr, 0.5)}  p75=${q(tArr, 0.75)}  p90=${q(tArr, 0.9)}  max=${q(tArr, 1)}`);
  console.log(`  reaction% p50=${q(rArr, 0.5)}  p75=${q(rArr, 0.75)}  p90=${q(rArr, 0.9)}  max=${q(rArr, 1)}`);
  console.log(`  rows with touches > 6  (touchScore already saturated): ${tArr.filter(t => t > 6).length} (${((tArr.filter(t => t > 6).length / Math.max(1, tArr.length)) * 100).toFixed(1)}%)`);
  console.log(`  rows with touches > 100                              : ${tArr.filter(t => t > 100).length} (${((tArr.filter(t => t > 100).length / Math.max(1, tArr.length)) * 100).toFixed(1)}%)`);
  console.log(`  rows with reaction >= 90%                            : ${rArr.filter(r => r >= 90).length} (${((rArr.filter(r => r >= 90).length / Math.max(1, rArr.length)) * 100).toFixed(1)}%)`);

  console.log(`\n${'='.repeat(80)}\nEND — nothing above changed any engine, resolver, gate or scoring code.\n${'='.repeat(80)}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
