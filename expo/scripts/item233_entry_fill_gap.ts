/**
 * ITEM B.2 / CHECKPOINT B.2 — THE ENTRY-FILL BOOKING GAP, MEASURED CANONICALLY.
 *
 * POPULATION : same canonical decided population as A.1/item232 (emitted_signals_v1
 *              ∩ gold_m1_bars coverage with ≥2h usable bars after emission).
 * ARM 1      : resolveSignalWithBars(fromScratch:true, evalNowMs=min(ems+8h,barsEnd)) —
 *              production semantics, unmodified (the shared instrument).
 * ARM 2      : HONEST-FILL counterfactual. Entry taken at the OPEN of the first
 *              gold_m1_bars bar STRICTLY AFTER emitted_at+60s. The ladder is
 *              recomputed FROM THAT ACTUAL FILL PRICE by ADDITIVELY SHIFTING every
 *              level (sl/tp1/tp2/tp3) by (fillOpen − entry): stop distance, target
 *              distances and the R-geometry are preserved EXACTLY — only the price
 *              the position actually starts from changes. The shifted signal then
 *              goes through the SAME real resolveSignalWithBars (no second ladder
 *              implementation anywhere in this file), evaluated from the fill bar
 *              INCLUSIVE (an order filled at open may hit levels within that same
 *              minute; the resolver's open-proximity ambiguity guard is exactly the
 *              right mechanism for an open-entry position).
 * ECONOMICS  : shared lib/evCompute.ts computeRNet for BOTH arms (cost $0.20).
 * PRE-STATED POWER: MDE(pair, 80% power, α=5%) = 2.80 × σ_d / √n. No prior paired
 *              distribution exists, so σ_d could not be pinned before running;
 *              the provisional gap (+0.12R mean on tiny divergences) implies σ_d ≈ 0.8–1.2R,
 *              i.e. an MDE band of ±0.11–0.16R at n≈431 — stated BEFORE the point estimate
 *              below is used for anything.
 *
 * DATA-SOURCE RULE: reads DIRECT via anon key. READ-ONLY script.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface SignalRow {
  signal_id: string; emitted_at: string; direction: string;
  entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number;
}
const WINDOW_MS = 8 * 60 * 60 * 1000;
const SAFE_BAR_OFFSET_MS = 60_000;
const MIN_COVERAGE_BARS_FIRST_2H = 100;

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(`${__dirname}/../.env`, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  } catch { /* fall back to process.env */ }
  return env;
}

function toTradingSignal(row: SignalRow): TradingSignal {
  return {
    id: row.signal_id,
    timestamp: new Date(row.emitted_at),
    createdAt: new Date(row.emitted_at).getTime(),
    type: row.direction === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1), tp2: Number(row.tp2), tp3: Number(row.tp3),
    sl: Number(row.sl), confidence: Number(row.confidence),
    status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false,
  } as unknown as TradingSignal;
}

function lowerBound(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; }
  return lo;
}
function upperBound(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp <= t) lo = m + 1; else hi = m; }
  return lo;
}

interface ArmResult { status: string; exitPrice: number; rNet: number | null; decided: boolean }

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('BLOCKER: missing Supabase credentials');
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(line);
  console.log('ITEM B.2 / CHECKPOINT B.2 — ENGINE BOOK vs HONEST NEXT-OPEN FILL (PAIRED, REAL RESOLVER)');
  console.log(line);
  console.log(`  run at : ${new Date().toISOString()}`);

  const allSignals: SignalRow[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1')
      .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence')
      .order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`emitted fetch failed: ${error.message}`);
    allSignals.push(...((data ?? []) as SignalRow[]));
    if ((data?.length ?? 0) < 1000) break;
  }
  const { data: ends } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(ends?.[0]?.timestamp)).getTime();
  const allBars: Bar[] = [];
  const minEms = Math.min(...allSignals.map(r => new Date(r.emitted_at).getTime()));
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(minEms - 60_000).toISOString())
      .lte('timestamp', new Date(barsEndMs).toISOString())
      .order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`bars fetch failed: ${error.message}`);
    for (const r of (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[])
      allBars.push({ timestamp: new Date(r.timestamp).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  corpus : ${allSignals.length} emitted | ${allBars.length} M1 bars`);

  interface Pair { id: string; dir: 'BUY' | 'SELL'; arm1: ArmResult; arm2: ArmResult; fill: number }
  const pairs: Pair[] = [];
  let noFillBar = 0, exclCoverage = 0;

  for (const s of allSignals) {
    const sig = toTradingSignal(s);
    const ems = sig.createdAt!;
    const windowEnd = Math.min(ems + WINDOW_MS, barsEndMs);
    const lo = lowerBound(allBars, ems - SAFE_BAR_OFFSET_MS);
    const hi = upperBound(allBars, windowEnd);
    const windowBars = allBars.slice(lo, hi);
    const first2h = windowBars.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
    if (first2h < MIN_COVERAGE_BARS_FIRST_2H || windowBars.length === 0) { exclCoverage++; continue; }

    // ── ARM 1 — production semantics, byte-for-byte ──────────────────────────
    const r1 = resolveSignalWithBars(sig, windowBars, { fromScratch: true, evalNowMs: windowEnd });
    const risk = Math.abs(Number(s.entry) - Number(s.sl));
    const dir = sig.type as 'BUY' | 'SELL';
    const dec1: boolean = r1.outcomeResult !== null;
    const arm1: ArmResult = {
      status: String(r1.newStatus), exitPrice: r1.exitPrice, decided: dec1,
      rNet: dec1 ? computeRNet(dir, Number(s.entry), r1.exitPrice, risk) : null,
    };

    // ── ARM 2 — honest next-open fill, SAME resolver, shifted ladder ────────
    const fillIdxRaw = upperBound(windowBars, ems + SAFE_BAR_OFFSET_MS); // strictly after ems+60s
    const fillIdx = fillIdxRaw < windowBars.length && windowBars[fillIdxRaw].timestamp <= ems + SAFE_BAR_OFFSET_MS
      ? upperBound(windowBars, ems + SAFE_BAR_OFFSET_MS)
      : fillIdxRaw;
    // strictly-after: advance while bar.ts <= ems+60s
    let fi = fillIdx;
    while (fi < windowBars.length && windowBars[fi].timestamp <= ems + SAFE_BAR_OFFSET_MS) fi++;
    if (fi >= windowBars.length) { noFillBar++; continue; }
    const fillBar = windowBars[fi];
    const fill = fillBar.open;
    const shift = fill - Number(s.entry);
    const shiftedSig = {
      ...sig,
      entryPrice: fill,
      entryPriceWithSlippage: fill,
      sl: Number(s.sl) + shift,
      tp1: Number(s.tp1) + shift,
      tp2: Number(s.tp2) + shift,
      tp3: Number(s.tp3) + shift,
    } as TradingSignal;
    // Evaluate from the fill bar INCLUSIVE: drop bars strictly before fillBar.ts.
    const arm2Bars = windowBars.filter(b => b.timestamp >= fillBar.timestamp);
    const r2 = resolveSignalWithBars(shiftedSig, arm2Bars, { fromScratch: true, evalNowMs: windowEnd });
    const dec2: boolean = r2.outcomeResult !== null;
    const arm2: ArmResult = {
      status: String(r2.newStatus), exitPrice: r2.exitPrice, decided: dec2,
      rNet: dec2 ? computeRNet(dir, fill, r2.exitPrice, risk) : null,
    };
    pairs.push({ id: s.signal_id, dir, arm1, arm2, fill });
  }

  // ── Arm-level stat lines ──────────────────────────────────────────────────────
  const statLine = (label: string, vals: number[]): string => {
    const n = vals.length;
    const wr = n ? (vals.filter(v => v > 0).length / n) * 100 : NaN;
    const ev = n ? vals.reduce((x, y) => x + y, 0) / n : NaN;
    const tot = n ? vals.reduce((x, y) => x + y, 0) : NaN;
    return `  ${label.padEnd(34)} n=${String(n).padStart(4)}  WR=${isNaN(wr) ? '-' : wr.toFixed(1)}%  EV_net=${ev >= 0 ? '+' : ''}${ev.toFixed(4)}R  total=${tot >= 0 ? '+' : ''}${tot.toFixed(2)}R`;
  };
  const a1 = pairs.filter(p => p.arm1.decided);
  const a2 = pairs.filter(p => p.arm2.decided);
  const both = pairs.filter(p => p.arm1.decided && p.arm2.decided);

  console.log(`\n${line}\nARM STAT LINES\n${line}`);
  console.log(statLine('ARM 1 engine-booked (live semantics)', a1.map(p => p.arm1.rNet!)));
  console.log(statLine('ARM 2 honest next-open fill', a2.map(p => p.arm2.rNet!)));
  console.log(statLine('PAIRED subset (both arms decided)', both.map(p => p.arm1.rNet!)));
  console.log(statLine('PAIRED subset — arm 2 leg', both.map(p => p.arm2.rNet!)));
  console.log(`  corpus accounting: total=${allSignals.length} coverage-excluded=${exclCoverage} no-fill-bar=${noFillBar} paired-with-arm1=${a1.length} arm2-decided=${a2.length} both-decided=${both.length}`);

  // ── Paired difference + CI (normal approx AND bootstrap, seed-fixed) ────────
  const d = both.map(p => p.arm2.rNet! - p.arm1.rNet!);
  const n = d.length;
  const meanD = d.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(d.reduce((acc, v) => acc + (v - meanD) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const rnd = mulberry32(20260826);
  const boots: number[] = [];
  for (let i = 0; i < 20000; i++) {
    let s2 = 0;
    for (let k = 0; k < n; k++) s2 += d[(rnd() * n) | 0];
    boots.push(s2 / n);
  }
  boots.sort((x, y) => x - y);
  const ciLo = boots[(boots.length * 0.025) | 0];
  const ciHi = boots[(boots.length * 0.975) | 0];

  console.log(`\n${line}\nPAIRED DIFFERENCE (arm2 − arm1)\n${line}`);
  console.log(`  MDE declared BEFORE use of point estimate (80% power, alpha 5%):`);
  console.log(`    MDE = 2.80 x sigma_d / sqrt(n); with observed sigma_d=${sd.toFixed(4)}R at n=${n} -> realised sensitivity +/-${(2.8 * sd / Math.sqrt(n)).toFixed(4)}R`);
  console.log(`    (pre-run band estimated from the provisional finding: sigma_d in [0.8, 1.2] -> MDE +/-[${(2.8 * 0.8 / Math.sqrt(a1.length)).toFixed(3)}, ${(2.8 * 1.2 / Math.sqrt(a1.length)).toFixed(3)}])`);
  console.log(`  point estimate : ${meanD >= 0 ? '+' : ''}${meanD.toFixed(4)}R per trade (total ${(meanD * n >= 0 ? '+' : '')}${(meanD * n).toFixed(2)}R over n=${n})`);
  console.log(`  normal approx 95% CI : [${(meanD - 1.96 * se).toFixed(4)}, ${(meanD + 1.96 * se).toFixed(4)}]`);
  console.log(`  bootstrap 20k  95% CI: [${ciLo.toFixed(4)}, ${ciHi.toFixed(4)}]`);

  // ── Outcome-class flips ──────────────────────────────────────────────────────
  const cls = (r: ArmResult): string => !r.decided ? 'UNDECIDED' : r.rNet! > 0 ? 'WIN' : 'LOSS';
  const flips = { WtoL: 0, LtoW: 0 };
  for (const p of both) {
    const c1 = cls(p.arm1), c2 = cls(p.arm2);
    if (c1 === 'WIN' && c2 === 'LOSS') flips.WtoL++;
    if (c1 === 'LOSS' && c2 === 'WIN') flips.LtoW++;
  }
  console.log(`\n  outcome CLASS flips among both-decided: WIN->LOSS ${flips.WtoL}, LOSS->WIN ${flips.LtoW}`);

  const top5 = [...both].sort((a, b) => Math.abs(b.arm2.rNet! - b.arm1.rNet!) - Math.abs(a.arm2.rNet! - a.arm1.rNet!)).slice(0, 5);
  console.log(`\n  5 LARGEST SINGLE-SIGNAL DIVERGENCES:`);
  for (const p of top5) {
    console.log(`    ${p.id} dir=${p.dir}`);
    console.log(`      arm1: ${p.arm1.status} exit ${p.arm1.exitPrice.toFixed(2)} (${p.arm1.rNet!.toFixed(4)}R)`);
    console.log(`      arm2: fill ${p.fill.toFixed(2)} -> ${p.arm2.status} exit ${p.arm2.exitPrice.toFixed(2)} (${p.arm2.rNet!.toFixed(4)}R)   Δ=${(p.arm2.rNet! - p.arm1.rNet!).toFixed(4)}R`);
  }

  console.log(`\n  PROVISIONAL vs CANONICAL (this script WINS on disagreement):`);
  console.log(`    provisional: engine -0.0727R n=128 vs honest-fill +0.0515R n=126 -> gap ~ +0.12R/trade`);
  console.log(`    canonical  : engine ${statEngine(a1)} vs honest-fill — see PAIRED DIFFERENCE above`);

  function statEngine(rows: Pair[]): string {
    const v = rows.map(p => p.arm1.rNet!);
    return `${v.length ? (v.reduce((x, y) => x + y, 0) / v.length >= 0 ? '+' : '') + (v.reduce((x, y) => x + y, 0) / v.length).toFixed(4) : '-'}R n=${v.length}`;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
