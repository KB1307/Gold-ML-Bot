/**
 * ITEM A.1 / CHECKPOINT A.1 — THE FADE COHORT, RE-DERIVED WITH THE REAL RESOLVER.
 *
 * Provisional numbers (PYTHON PORT of signalResolver.ts, NOT bit identity):
 *   WITH prior 4h move : n=87 WR 58.6% EV_net +0.0014R total +0.12R
 *   AGAINST (fade)     : n=41 WR 43.9% EV_net -0.2300R total -9.43R
 *   whole decided book : n=128 EV_net -0.0727R
 * These MUST be re-derived here via the REAL resolveSignalWithBars. If they
 * disagree, THIS script's numbers WIN and the deltas are reported explicitly.
 *
 * POPULATION  : every row in emitted_signals_v1 whose emitted_at falls inside
 *               gold_m1_bars coverage with >= 2h of bars after it.
 * OUTCOME     : real resolveSignalWithBars(fromScratch: true, evalNowMs =
 *               windowEnd from real bar timestamps — never Date.now()), using
 *               the SAME canonical instrument as Item 224/canonicalBook.ts
 *               (8h resolution window Item 41a, safeBarStart = emitted+60s,
 *               anon key). Win predicate: rNet > 0 where
 *               rNet = computeRNet() from lib/evCompute.ts (shared NET basis;
 *               no second R computation exists anywhere in this file).
 * PRIOR 4h    : gold_m1_bars ONLY (never priceHistory, never Yahoo/TwelveData),
 *               sign(close_of_last_bar_strictly_before_emitted_at
 *                 - close_4h_before_that), bars strictly BEFORE emitted_at.
 *               INSUFFICIENT PRIOR BARS (<150 of the nominal 240-minute span)
 *               -> the signal is EXCLUDED FROM BOTH COHORTS and counted as
 *               INSUFFICIENT_LOOKBACK. No default value, no guess — a defaulted
 *               label would silently manufacture a cohort (ATR two-constructs
 *               defect class).
 *
 * DATA-SOURCE RULE: gold_m1_bars + emitted_signals_v1 read DIRECT via anon key.
 * READ-ONLY — nothing is written by this script.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface SignalRow {
  signal_id: string; emitted_at: string; direction: string;
  entry: number; sl: number; tp1: number; tp2: number; tp3: number;
  confidence: number; source: string;
}

const WINDOW_MS = 8 * 60 * 60 * 1000;
const SAFE_BAR_OFFSET_MS = 60_000;
const MIN_COVERAGE_BARS_FIRST_2H = 100; // of nominal 120 — tolerates small gaps
const MIN_PRIOR_BARS_FOR_4H = 150;     // of nominal 240 — else INSUFFICIENT_LOOKBACK

/** Show the REAL resolver's own log lines for these three signals only. */
const LOG_SAMPLE_IDS = new Set<string>();
// populated after corpus load: indices 0, mid, last of the DECIDED set

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const f = `${__dirname}/../.env`;
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  } catch { /* .env absent — rely on process.env */ }
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
    status: 'ACTIVE' as SignalStatus, targetsHit: 0,
    breakevenReached: false,
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
function pct(n: number, d: number): string { return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`; }

interface Decided {
  id: string; dir: 'BUY' | 'SELL'; status: string; rNet: number;
  withMove: boolean | null; // true=WITH, false=FADE, null=excluded (insufficient lookback)
  cohortReason: string;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error('BLOCKER: missing Supabase credentials');
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(line);
  console.log('ITEM A.1 / CHECKPOINT A.1 — FADE COHORT RE-DERIVED WITH THE REAL RESOLVER');
  console.log(line);
  console.log(`  run at : ${new Date().toISOString()}`);

  const allSignals: SignalRow[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1')
      .select('signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence, source')
      .order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`emitted fetch failed: ${error.message}`);
    allSignals.push(...((data ?? []) as SignalRow[]));
    if ((data?.length ?? 0) < 1000) break;
  }

  const { data: ends } = await client.from('gold_m1_bars')
    .select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(ends?.[0]?.timestamp)).getTime();
  const { data: starts } = await client.from('gold_m1_bars')
    .select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const barsStartMs = new Date(String(starts?.[0]?.timestamp)).getTime();

  const allBars: Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(Math.min(barsStartMs, new Date(allSignals[0].emitted_at).getTime())).toISOString())
      .lte('timestamp', new Date(barsEndMs).toISOString())
      .order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`bars fetch failed: ${error.message}`);
    for (const r of (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[])
      allBars.push({ timestamp: new Date(r.timestamp).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  corpus : ${allSignals.length} emitted signals | gold_m1_bars ${allBars.length} bars, coverage ${new Date(barsStartMs).toISOString()} .. ${new Date(barsEndMs).toISOString()}`);

  // ── Prior-4h construction BEFORE any resolution (gold_m1_bars ONLY) ─────────
  const priorDeltaOf = new Map<string, { delta: number | null; reason: string }>();
  for (const s of allSignals) {
    const ems = new Date(s.emitted_at).getTime();
    const hiIdx = lowerBound(allBars, ems);           // strictly-before boundary
    const priorSpanBars = allBars.slice(Math.max(0, hiIdx - 400), hiIdx); // ≤4h window slice
    const recent = priorSpanBars.filter(b => b.timestamp >= ems - 4 * 3600_000);
    if (recent.length < MIN_PRIOR_BARS_FOR_4H) {
      priorDeltaOf.set(s.signal_id, { delta: null, reason: `INSUFFICIENT_LOOKBACK (${recent.length} bars in prior 4h)` });
      continue;
    }
    const closeNow = recent[recent.length - 1].close;
    const targetT = recent[recent.length - 1].timestamp - 4 * 3600_000;
    const idx = upperBound(recent, targetT);
    const base = recent[idx === recent.length ? 0 : idx]; // closest bar <= t-4h, gap-tolerant on the FIRST covered segment only
    priorDeltaOf.set(s.signal_id, { delta: closeNow - base.close, reason: 'OK' });
  }

  // ── Real resolver replay (log pass-through for the 3 sampled ids) ────────────
  const decided: Decided[] = [];
  let exclOutsideCoverage = 0, exclThinCoverage = 0, exclUnresolvedOrNeutral = 0, exclInsufficientLookback = 0;
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    const s = String(a[0]);
    for (const id of LOG_SAMPLE_IDS) if (s.includes(id)) { origLog(...(a as Parameters<typeof console.log>)); return; }
  };
  try {
    for (const s of allSignals) {
      const sig = toTradingSignal(s);
      const ems = sig.createdAt!;
      // inside gold_m1_bars coverage?
      if (ems < barsStartMs || ems > barsEndMs) { exclOutsideCoverage++; continue; }
      const windowEnd = Math.min(ems + WINDOW_MS, barsEndMs);
      const lo = lowerBound(allBars, ems - SAFE_BAR_OFFSET_MS);
      const hi = upperBound(allBars, windowEnd);
      const windowBars = allBars.slice(lo, hi);
      const first2hCount = windowBars.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
      if (first2hCount < MIN_COVERAGE_BARS_FIRST_2H) { exclThinCoverage++; continue; } // needs >=2h bars AFTER emission
      const evalNowMs = windowEnd; // REAL bar timestamps — never Date.now()
      const res = resolveSignalWithBars(sig, windowBars, { fromScratch: true, evalNowMs, logPrefix: `[Resolver ${sig.id}]` });
      if (res.outcomeResult === null) { exclUnresolvedOrNeutral++; continue; }
      const pd = priorDeltaOf.get(s.signal_id)!;
      const risk = Math.abs(Number(s.entry) - Number(s.sl));
      const rNet = computeRNet(sig.type, Number(s.entry), res.exitPrice, risk);
      const dir = sig.type as 'BUY' | 'SELL';
      // INSUFFICIENT_LOOKBACK rows are counted as excluded ABOVE (never defaulted);
      // they must not enter either cohort OR the decided book.
      if (pd.reason !== 'OK') { exclInsufficientLookback++; continue; }
      decided.push({
        id: s.signal_id, dir, status: String(res.newStatus), rNet,
        // Item A definition: direction AGREES with the prior 4h move —
        // BUY agrees iff price ROSE into emission; SELL agrees iff it FELL.
        withMove: sig.type === 'BUY' ? pd.delta > 0 : pd.delta < 0,
        cohortReason: pd.reason,
      });
    }
  } finally {
    console.log = origLog;
  }

  // choose log samples after seeing statuses: one SL_HIT, one win-class, one middle
  const pick = (p: (d: Decided) => boolean): string | null => decided.find(p)?.id ?? null;
  const samples = [
    pick(d => d.status === 'SL_HIT'),          // 🚨 pre-TP1 wick-through line
    pick(d => d.status === 'SL_AFTER_BE'),     // 🔀 same-bar / ⚖️ lock line
    pick(d => d.status === 'CLOSED'),          // 🧮 fromScratch matured-closed line
    pick(d => d.status === 'PARTIAL_WIN_SL_HIT'), // ⚖️ post-TP2 retrace line
  ].filter((x): x is string => !!x).slice(0, 3);

  // Second pass ONLY for log capture of 3 signals (instrument behaviour identical)
  console.log(`\n${line}\nRESOLVER'S OWN LOG LINES FOR ${samples.length} INDIVIDUAL SIGNALS\n${line}`);
  console.log = (...a: unknown[]) => {
    const str = String(a[0]);
    if (samples.some(id => str.includes(id))) origLog(...(a as Parameters<typeof console.log>));
  };
  try {
    for (const s of allSignals.filter(x => samples.includes(x.signal_id))) {
      const sig = toTradingSignal(s);
      const ems = sig.createdAt!;
      const windowEnd = Math.min(ems + WINDOW_MS, barsEndMs);
      const lo = lowerBound(allBars, ems - SAFE_BAR_OFFSET_MS);
      const hi = upperBound(allBars, windowEnd);
      resolveSignalWithBars(sig, allBars.slice(lo, hi), { fromScratch: true, evalNowMs: windowEnd, logPrefix: `\n>>> SIGNAL ${sig.id}` });
    }
  } finally { console.log = origLog; }

  // ── Cohort stats ─────────────────────────────────────────────────────────────
  const stats = (rows: Decided[]): { n: number; wr: number; ev: number; total: number } => {
    const w = rows.filter(r => r.rNet > 0);
    const ev = rows.length ? rows.reduce((s, r) => s + r.rNet, 0) : 0;
    return { n: rows.length, wr: rows.length ? (w.length / rows.length) * 100 : NaN, ev: rows.length ? ev / rows.length : NaN, total: ev };
  };
  const withC = decided.filter(d => d.withMove === true);
  const fadeC = decided.filter(d => d.withMove === false);

  // Bootstrap 95% CI on (EV_with - EV_fade)
  const rnd = mulberry32(20260826);
  const diffs: number[] = [];
  for (let i = 0; i < 20000; i++) {
    let sw = 0, sf = 0;
    for (let k = 0; k < withC.length; k++) sw += withC[(rnd() * withC.length) | 0].rNet;
    for (let k = 0; k < fadeC.length; k++) sf += fadeC[(rnd() * fadeC.length) | 0].rNet;
    diffs.push(sw / Math.max(withC.length, 1) - sf / Math.max(fadeC.length, 1));
  }
  diffs.sort((a, b) => a - b);
  const ciLo = diffs[(diffs.length * 0.025) | 0];
  const ciHi = diffs[(diffs.length * 0.975) | 0];
  const pGtZero = diffs.filter(d => d > 0).length / diffs.length;

  console.log(`\n${line}`);
  console.log(`COHORT TABLE — CANONICAL REAL-RESOLVER BOOK (decided n=${withC.length + fadeC.length})`);
  console.log(line);
  for (const [label, rows] of [['WITH prior 4h move', withC], ['AGAINST (fade)', fadeC]] as [string, Decided[]][]) {
    const st = stats(rows);
    console.log(`  ${label.padEnd(20)} n=${String(st.n).padStart(4)}  WR=${isNaN(st.wr) ? '-' : st.wr.toFixed(1)}%  EV_net=${st.ev >= 0 ? '+' : ''}${st.ev.toFixed(4)}R  total=${st.total >= 0 ? '+' : ''}${st.total.toFixed(4)}R`);
  }
  const all = stats(decided);
  console.log(`  ${'whole decided book'.padEnd(20)} n=${String(all.n).padStart(4)}  WR=${all.wr.toFixed(1)}%  EV_net=${all.ev >= 0 ? '+' : ''}${all.ev.toFixed(4)}R  total=${all.total >= 0 ? '+' : ''}${all.total.toFixed(4)}R`);

  console.log(`\n  WITH-minus-FADE EV difference : ${(stats(withC).ev - stats(fadeC).ev >= 0 ? '+' : '')}${(stats(withC).ev - stats(fadeC).ev).toFixed(4)}R`);
  console.log(`  bootstrap 95% CI (20k resamples): [${ciLo.toFixed(4)}, ${ciHi.toFixed(4)}]  P(diff>0)=${(pGtZero * 100).toFixed(1)}%`);

  console.log('\n  BY DIRECTION:');
  for (const d of ['BUY', 'SELL'] as const) {
    for (const [lab, pred] of [['WITH', (x: Decided) => x.withMove === true], ['FADE', (x: Decided) => x.withMove === false]] as const) {
      const st = stats(decided.filter(x => x.dir === d && pred(x)));
      if (st.n > 0) console.log(`    ${d} ${lab.padEnd(5)} n=${String(st.n).padStart(4)}  WR=${st.wr.toFixed(1)}%  EV_net=${st.ev >= 0 ? '+' : ''}${st.ev.toFixed(4)}R`);
    }
  }

  // Half-sample stability (first vs second half chronologically)
  const halfSplitMs = (() => { const sortedEm = allSignals.map(s => new Date(s.emitted_at).getTime()).sort((a, b) => a - b); return sortedEm[Math.floor(sortedEm.length / 2)]; })();
  console.log('\n  HALF-SAMPLE STABILITY (chronological split at mid-emission timestamp):');
  const emOf = new Map(allSignals.map(s => [s.signal_id, new Date(s.emitted_at).getTime()]));
  for (const halfName of ['H1', 'H2'] as const) {
    const sel = decided.filter(d => (halfName === 'H1') === emOf.get(d.id)! < halfSplitMs);
    for (const lab of ['WITH', 'FADE']) {
      const rows = sel.filter(x => lab === 'WITH' ? x.withMove === true : x.withMove === false);
      const st = stats(rows);
      if (st.n > 0) console.log(`    ${halfName} ${lab.padEnd(5)} n=${String(st.n).padStart(4)}  EV_net=${st.ev >= 0 ? '+' : ''}${st.ev.toFixed(4)}R`);
    }
  }

  console.log(`\n${line}`);
  console.log('EXCLUSIONS ACCOUNTING');
  console.log(line);
  console.log(`  total emitted rows                      : ${allSignals.length}`);
  console.log(`  excluded: outside gold_m1_bars coverage : ${exclOutsideCoverage}`);
  console.log(`  excluded: <2h usable bars after emission: ${exclThinCoverage}  (coverage floor: >=${MIN_COVERAGE_BARS_FIRST_2H}/120 bars in first 2h)`);
  console.log(`  excluded: unresolved/neutral terminal   : ${exclUnresolvedOrNeutral}  (outcomeResult=null: EXPIRED_MISSED_ENTRY / NEVER_FILLABLE / CLOSED-flat)`);
  console.log(`  excluded: insufficient prior-4h bars    : ${exclInsufficientLookback}  (floor: >=${MIN_PRIOR_BARS_FOR_4H}/240) -> handled WITHOUT default; excluded from BOTH cohorts`);
  console.log(`  DECIDED (resolved WIN-or-LOSS with valid 4h label): ${decided.length}`);

  console.log(`\n  PROVISIONAL vs CANONICAL (this script WINS on disagreement):`);
  console.log(`    provisional: WITH n=87 WR 58.6% EV_net +0.0014R | FADE n=41 WR 43.9% EV_net -0.2300R | book n=128 EV_net -0.0727R`);
  console.log(`    canonical  : WITH n=${withC.length} WR=${withC.length ? stats(withC).wr.toFixed(1) : '-'}% EV_net=${withC.length ? stats(withC).ev.toFixed(4) : '-'} | FADE n=${fadeC.length} WR=${fadeC.length ? stats(fadeC).wr.toFixed(1) : '-'}% EV_net=${fadeC.length ? stats(fadeC).ev.toFixed(4) : '-'} | book n=${decided.length} EV_net=${stats(decided).ev.toFixed(4)}`);
}

/** Deterministic PRNG so the bootstrap CI is reproducible run-to-run. */
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
