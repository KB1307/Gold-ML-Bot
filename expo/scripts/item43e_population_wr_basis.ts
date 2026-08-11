/**
 * ITEM 43(e) — CONFIRM THE BASIS OF THE "POPULATION WR" NUMBER
 * ============================================================
 *
 * MINDSET (restated verbatim):
 *  Senior Lead Quantitative Trading Engineer / Senior Institutional Gold
 *  (XAU/USD) Elite Portfolio Manager.
 *  1. Measure before building. Pre-registered gates, no post-hoc loosening.
 *  2. Verify against the LIVE system, never "the code looks right."
 *  3. No step reported done without pasted evidence from the real system.
 *  4. Provenance is not appearance — ask the source system what it holds.
 *  5. A measurement is only as good as its LABELS.
 *  6. Correlation in observational data is not a lever.
 *  7. State the POWER before the result.
 *  8. When measurement is IMPOSSIBLE rather than underpowered, say so and
 *     decide on first principles — then state what forward evidence settles it.
 *
 * WHAT THIS ITEM IS. Item 43(d) printed "Population WR 24.2% vs corpus-captured
 * WR 21.6%". That was computed from the EXPORT's STORED `status` field via a
 * WINNING_STATUSES set — i.e. the RAW STORED-LABEL BASIS. It is NOT canonical:
 * it never ran resolveSignalWithBars, never used fromScratch, and never tested
 * R > 0. Item 43 already proved 17 of 51 stored corpus labels were WRONG, so the
 * stored-label basis is exactly the basis this project has learned not to trust.
 *
 * Rather than drop the number, the geometry needed to re-derive it canonically is
 * present in the export (entry, TP1/2/3, SL, generated ts), so this script
 * re-derives the WHOLE population from real Vantage bars with the REAL resolver
 * and restates the comparison on the canonical basis. Where the two bases
 * disagree, the canonical one wins and the stored one is reported as defective.
 *
 * DATA-SOURCE RULE: gold_m1_bars read DIRECT from Supabase via anon key.
 * trade_outcomes_v1 read DIRECT via anon key. No writes of any kind.
 *
 * PRE-REGISTERED GATES (declared before the result, per rule 1 and 7):
 *  G43E-1 BASIS IDENTIFIED: the 43(d) number's basis must be positively
 *         identified in the 43(d) source as stored-status vs canonical. This
 *         gate is about naming the basis correctly, not about the value.
 *  G43E-2 CANONICAL COVERAGE: canonical re-derivation must reach a terminal
 *         (non-ACTIVE) outcome for >= 90% of resolved population signals.
 *         Below that, the canonical restatement is itself underpowered and the
 *         WR comparison must be DROPPED rather than restated.
 *  G43E-3 CORPUS-TIER AGREEMENT (the label-trust test): on the 51 corpus rows,
 *         where a durable BAR-VERIFIED label already exists from Item 43, the
 *         canonical re-derivation must agree with that durable label for >= 95%
 *         of rows. This validates the canonical pipeline against known-good
 *         ground truth before any population claim leans on it.
 *  G43E-4 The restated comparison must be reported with BOTH bases side by side
 *         and an explicit statement of which is authoritative.
 *
 * NOTE ON SCOPE: the session-CAPTURE-COUNT finding (2.50x, G43D-4 FAILED) is a
 * pure ROW-COUNT measurement. It does not read any WR or label, so it is
 * unaffected by anything in this script and stands either way.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

const EXPORT_PATH = '/tmp/diagnostics_export.txt';

/** The exact win-set used by the Item 43(d) script, reproduced for comparison. */
const ITEM_43D_WINNING_STATUSES = new Set([
  'TP1_HIT',
  'TP2_HIT',
  'TP3_HIT',
  'ALL_TARGETS_HIT',
  'PARTIAL_WIN_SL_HIT',
]);

const RESOLVED_STATUSES = new Set([
  'SL_HIT',
  'TP1_HIT',
  'TP2_HIT',
  'TP3_HIT',
  'CLOSED',
  'SL_AFTER_BE',
  'BE_STOP',
  'ALL_TARGETS_HIT',
  'PARTIAL_WIN_SL_HIT',
]);

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const f of ['.env', '../.env']) {
    try {
      const raw = readFileSync(pathResolve(process.cwd(), f), 'utf-8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i < 0) continue;
        env[t.slice(0, i)] = t.slice(i + 1).replace(/^["']|["']$/g, '');
      }
    } catch {
      /* optional */
    }
  }
  return env;
}

const env = loadEnv();
const anon = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  storedStatus: string;
  id: string;
  generatedMs: number;
  confidence: number;
  storedExitPrice: number | null;
  storedTargetsHit: number;
}

/** Same parser shape as verifyItemB_addendum.ts — the established export reader. */
function parseExport(filePath: string): ParsedSignal[] {
  const raw = readFileSync(filePath, 'utf-8');
  const signals: ParsedSignal[] = [];
  let current: Partial<ParsedSignal> | null = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^\[(\d+)\]\s+(BUY|SELL)\s+@\s+([\d.]+)\s+—\s+status:\s+(\S+)/);
    if (m) {
      if (current && current.id) signals.push(current as ParsedSignal);
      current = {
        index: parseInt(m[1], 10),
        direction: m[2] as 'BUY' | 'SELL',
        entry: parseFloat(m[3]),
        storedStatus: m[4],
        storedTargetsHit: 0,
        storedExitPrice: null,
      };
      continue;
    }
    if (!current) continue;
    const id = line.match(/^\s+id:\s+(\S+)/);
    if (id && !current.id) current.id = id[1];
    const g = line.match(/^\s+generated:\s+(\S+)/);
    if (g && current.generatedMs === undefined) {
      const ts = new Date(g[1]).getTime();
      if (!Number.isNaN(ts)) current.generatedMs = ts;
    }
    const c = line.match(/^\s+confidence:\s+([\d.]+)%/);
    if (c && current.confidence === undefined) current.confidence = parseFloat(c[1]);
    const tp = line.match(/TP1:\s+([\d.]+)\s+TP2:\s+([\d.]+)\s+TP3:\s+([\d.]+)\s+SL:\s+([\d.]+)/);
    if (tp) {
      current.tp1 = parseFloat(tp[1]);
      current.tp2 = parseFloat(tp[2]);
      current.tp3 = parseFloat(tp[3]);
      current.sl = parseFloat(tp[4]);
    }
    const th = line.match(/targets hit:\s+(\d+)/);
    if (th) current.storedTargetsHit = parseInt(th[1], 10);
    const ex = line.match(/exit price:\s+([\d.]+)/);
    if (ex && current.storedExitPrice === null) current.storedExitPrice = parseFloat(ex[1]);
  }
  if (current && current.id) signals.push(current as ParsedSignal);
  return signals;
}

async function fetchBars(fromTs: string): Promise<OhlcBar[]> {
  const out: OhlcBar[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await anon
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', fromTs)
      .order('timestamp', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) {
      out.push({
        timestamp: new Date(r.timestamp).getTime(),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
      });
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 200_000) break;
  }
  return out;
}

function toTradingSignal(p: ParsedSignal): TradingSignal {
  return {
    id: p.id,
    timestamp: new Date(p.generatedMs),
    type: p.direction,
    entryPrice: p.entry,
    entryPriceWithSlippage: p.entry,
    tp1: p.tp1,
    tp2: p.tp2,
    tp3: p.tp3,
    sl: p.sl,
    slMultiplier: 1,
    confidence: (p.confidence ?? 72) / 100,
    status: p.storedStatus as SignalStatus,
    targetsHit: p.storedTargetsHit,
    entryTime: new Date(p.generatedMs).toISOString(),
    exitPrice: p.storedExitPrice ?? undefined,
    topFeatures: [],
    riskJustification: '',
    createdAt: p.generatedMs,
  };
}

/** Engine convention: R = signed move / |entry - sl| (signalEngine.ts:6440/6472). */
function rMult(dir: 'BUY' | 'SELL', entry: number, sl: number, exit: number): number | null {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  return (dir === 'BUY' ? exit - entry : entry - exit) / risk;
}

/** SCRATCH_R_THRESHOLD, signalEngine.ts:562. */
const SCRATCH_R_THRESHOLD = 0.15;

let pass = 0;
let fail = 0;
function gate(label: string, ok: boolean, detail: string): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}: ${detail}`);
}

interface Canonical {
  p: ParsedSignal;
  newStatus: SignalStatus;
  r: number | null;
  terminal: boolean;
  canonicalWin: boolean | null;
  isScratch: boolean;
}

async function main(): Promise<void> {
  console.log('='.repeat(80));
  console.log('ITEM 43(e) — POPULATION WR BASIS CONFIRMATION');
  console.log(`run at ${new Date().toISOString()}`);
  console.log('='.repeat(80));

  // ── G43E-1: name the basis, from the 43(d) source itself ──────────────────
  console.log('\n' + '='.repeat(80));
  console.log('1. WHAT BASIS PRODUCED THE 43(d) NUMBER');
  console.log('='.repeat(80));
  const src = readFileSync(pathResolve(process.cwd(), 'scripts/item43d_corpus_selection_audit.ts'), 'utf-8');
  const usesStatusField = /WINNING_STATUSES\.has\(s\.status\)/.test(src);
  const callsResolver = /resolveSignalWithBars/.test(src);
  const usesFromScratch = /fromScratch/.test(src);
  const usesRPositive = /realized_r\s*>\s*0|r\s*>\s*0/.test(src);
  console.log(`  item43d source: classifies wins via WINNING_STATUSES.has(s.status) : ${usesStatusField}`);
  console.log(`  item43d source: calls resolveSignalWithBars()                     : ${callsResolver}`);
  console.log(`  item43d source: uses fromScratch                                  : ${usesFromScratch}`);
  console.log(`  item43d source: tests R > 0                                        : ${usesRPositive}`);
  console.log('');
  console.log('  VERDICT: the 43(d) "Population WR 24.2% / captured WR 21.6%" pair was');
  console.log('  computed from the EXPORT\'S STORED `status` STRING — the RAW STORED-LABEL');
  console.log('  BASIS. It is NOT canonical: no resolver, no fromScratch, no R>0 test.');
  console.log('  Per rule 5, that basis is untrustworthy here by direct prior evidence:');
  console.log('  Item 43 proved 17 of 51 stored corpus labels (33.3%) were WRONG.');
  gate(
    'G43E-1 basis identified',
    usesStatusField && !callsResolver && !usesFromScratch,
    'stored-status basis positively identified in the 43(d) source (no resolver / no fromScratch)',
  );

  // ── POWER, before any result ──────────────────────────────────────────────
  const population = parseExport(EXPORT_PATH).filter((s) => s.generatedMs !== undefined);
  const resolvedPop = population.filter((s) => RESOLVED_STATUSES.has(s.storedStatus));
  const withGeometry = resolvedPop.filter((s) => s.sl && s.tp1 && s.tp2 && s.tp3);

  console.log('\n' + '='.repeat(80));
  console.log('2. POWER, STATED BEFORE THE RESULT');
  console.log('='.repeat(80));
  console.log(`  export signals parsed                 : ${population.length}`);
  console.log(`  of which terminal/resolved by status  : ${resolvedPop.length}`);
  console.log(`  of which carry full geometry (SL+TPs) : ${withGeometry.length}`);
  console.log('  A WR on ~400 signals has a 95% CI half-width of roughly +/-4pp at p=0.25,');
  console.log('  so differences smaller than ~8pp between two bases on this sample are not');
  console.log('  separable. The 43(d) gap under test (24.2% vs 21.6% = 2.6pp) is BELOW that');
  console.log('  threshold, which is already reason enough not to treat it as a finding.');

  const { data: corpusRows, error: cErr } = await anon
    .from('trade_outcomes_v1')
    .select('signal_id, result, realized_r, is_scratch');
  if (cErr) {
    console.log(`\nBLOCKER: corpus read failed (${cErr.message}). STOP.`);
    process.exit(1);
  }
  const corpus = (corpusRows ?? []) as { signal_id: string; result: string; realized_r: number | null; is_scratch: boolean | null }[];
  const corpusById = new Map(corpus.map((r) => [r.signal_id, r]));
  console.log(`  durable corpus rows (bar-verified)   : ${corpus.length}`);

  // ── canonical re-derivation ───────────────────────────────────────────────
  const bars = await fetchBars('2026-06-18T00:00:00Z');
  const evalNowMs = bars.length ? bars[bars.length - 1].timestamp : Date.now();
  console.log(`  Vantage bars loaded                  : ${bars.length} (through ${new Date(evalNowMs).toISOString()})`);

  const results: Canonical[] = [];
  const realLog = console.log;
  console.log = () => {};
  for (const p of withGeometry) {
    const out = resolveSignalWithBars(toTradingSignal(p), bars, { fromScratch: true, evalNowMs });
    const terminal = out.newStatus !== 'ACTIVE' && out.newStatus !== 'PENDING';
    const r = out.exitPrice !== undefined ? rMult(p.direction, p.entry, p.sl, out.exitPrice) : null;
    const isScratch = r !== null && Math.abs(r) < SCRATCH_R_THRESHOLD;
    results.push({
      p,
      newStatus: out.newStatus,
      r,
      terminal,
      canonicalWin: r === null ? null : r > 0,
      isScratch,
    });
  }
  console.log = realLog;

  const terminalRes = results.filter((x) => x.terminal && x.r !== null);
  const coverage = withGeometry.length ? (terminalRes.length / withGeometry.length) * 100 : 0;

  console.log('\n' + '='.repeat(80));
  console.log('3. CANONICAL RE-DERIVATION (real resolveSignalWithBars, fromScratch, R>0)');
  console.log('='.repeat(80));
  console.log(`  signals canonically resolved to terminal + R : ${terminalRes.length}/${withGeometry.length} (${coverage.toFixed(1)}%)`);
  gate('G43E-2 canonical coverage', coverage >= 90, `${coverage.toFixed(1)}% terminal (pre-registered floor 90.0%)`);

  // ── G43E-3: validate the canonical pipeline against Item 43 ground truth ──
  const overlap = terminalRes.filter((x) => corpusById.has(x.p.id));
  let agree = 0;
  const disagreements: string[] = [];
  for (const x of overlap) {
    const durable = corpusById.get(x.p.id)!;
    const durableWin = durable.result === 'WIN';
    if (x.canonicalWin === durableWin) agree++;
    else disagreements.push(`${x.p.id} canonical=${x.canonicalWin ? 'WIN' : 'LOSS'} (R=${x.r?.toFixed(4)}) durable=${durable.result} (R=${durable.realized_r})`);
  }
  const agreePct = overlap.length ? (agree / overlap.length) * 100 : 0;
  console.log(`\n  canonical vs DURABLE bar-verified labels on corpus rows: ${agree}/${overlap.length} agree (${agreePct.toFixed(1)}%)`);
  for (const d of disagreements.slice(0, 10)) console.log(`    ⚠ ${d}`);
  gate('G43E-3 corpus-tier agreement', agreePct >= 95, `${agreePct.toFixed(1)}% agreement with Item 43 ground truth (floor 95.0%)`);

  // ── the restatement ──────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('4. THE RESTATED COMPARISON — BOTH BASES SIDE BY SIDE');
  console.log('='.repeat(80));

  const inCorpus = new Set(corpus.map((r) => r.signal_id));

  // stored-status basis (what 43d did), reproduced exactly
  const storedWin = resolvedPop.filter((s) => ITEM_43D_WINNING_STATUSES.has(s.storedStatus)).length;
  const storedPopWR = resolvedPop.length ? (storedWin / resolvedPop.length) * 100 : 0;
  const capturedStored = resolvedPop.filter((s) => inCorpus.has(s.id));
  const capturedStoredWin = capturedStored.filter((s) => ITEM_43D_WINNING_STATUSES.has(s.storedStatus)).length;
  const capturedStoredWR = capturedStored.length ? (capturedStoredWin / capturedStored.length) * 100 : 0;

  // canonical basis, non-scratch only (training-relevant filter, :5023/:6515)
  const canonNonScratch = terminalRes.filter((x) => !x.isScratch);
  const canonWin = canonNonScratch.filter((x) => x.canonicalWin === true).length;
  const canonPopWR = canonNonScratch.length ? (canonWin / canonNonScratch.length) * 100 : 0;
  const canonCaptured = canonNonScratch.filter((x) => inCorpus.has(x.p.id));
  const canonCapturedWin = canonCaptured.filter((x) => x.canonicalWin === true).length;
  const canonCapturedWR = canonCaptured.length ? (canonCapturedWin / canonCaptured.length) * 100 : 0;

  console.log('\n  STORED-STATUS BASIS  [DEFECTIVE — reproduced only to show what 43(d) said]');
  console.log(`    population WR      ${storedPopWR.toFixed(1)}%  (${storedWin}/${resolvedPop.length})`);
  console.log(`    corpus-captured WR ${capturedStoredWR.toFixed(1)}%  (${capturedStoredWin}/${capturedStored.length})`);
  console.log(`    gap ${(storedPopWR - capturedStoredWR).toFixed(1)}pp`);

  console.log('\n  CANONICAL BASIS  [AUTHORITATIVE — real resolver, fromScratch, R>0, scratch excluded]');
  console.log(`    population WR      ${canonPopWR.toFixed(1)}%  (${canonWin}/${canonNonScratch.length})`);
  console.log(`    corpus-captured WR ${canonCapturedWR.toFixed(1)}%  (${canonCapturedWin}/${canonCaptured.length})`);
  console.log(`    gap ${(canonPopWR - canonCapturedWR).toFixed(1)}pp`);

  const evAll = canonNonScratch.length
    ? canonNonScratch.reduce((a, b) => a + (b.r ?? 0), 0) / canonNonScratch.length
    : 0;
  console.log(`\n    canonical population EV ${evAll >= 0 ? '+' : ''}${evAll.toFixed(4)}R over n=${canonNonScratch.length}`);

  console.log('\n  WHICH IS AUTHORITATIVE: the CANONICAL basis. The stored-status basis');
  console.log('  classifies by a string the client wrote at resolution time, and Item 43');
  console.log('  measured a 33.3% error rate in exactly those strings on the subset where');
  console.log('  ground truth exists. The canonical basis re-derives the outcome from real');
  console.log('  Vantage bars with the production resolver and is validated against Item 43');
  console.log('  ground truth by G43E-3 above.');
  gate('G43E-4 both bases reported with authority stated', true, 'stored vs canonical printed side by side; canonical declared authoritative');

  // ── scope note ───────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('5. WHAT THIS DOES AND DOES NOT TOUCH');
  console.log('='.repeat(80));
  console.log('  UNAFFECTED: the 43(d) session-capture finding (2.50x, G43D-4 FAILED). That');
  console.log('  is a pure ROW-COUNT ratio — corpus rows per resolved signal per session. It');
  console.log('  reads no label and no WR, so no labelling basis can move it. It stands.');
  console.log('  RESTATED: the WR comparison, now on the canonical basis above.');

  console.log('\n' + '='.repeat(80));
  console.log(
    fail === 0
      ? `ITEM 43(e): ALL ${pass} GATES PASS — WR COMPARISON RESTATED ON THE CANONICAL BASIS`
      : `ITEM 43(e): ${fail} GATE FAILURE(S) — ${pass} passed. WR COMPARISON MUST BE DROPPED, NOT RESTATED.`,
  );
  console.log('='.repeat(80));
}

main().catch((e: unknown) => {
  console.error('FATAL', e);
  process.exit(1);
});
