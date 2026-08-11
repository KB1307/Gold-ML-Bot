/**
 * ITEM 43 — CORRECT THE CONTAMINATED LEARNING CORPUS
 * ==================================================
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
 * DATA-SOURCE RULE, as enforced here:
 *  - gold_m1_bars + trade_outcomes_v1 READS  -> Supabase DIRECT via anon key.
 *  - trade_outcomes_v1 WRITES                -> service-role key ONLY.
 *    Two separate clients are constructed so a read can never accidentally
 *    travel on the privileged connection and vice versa.
 *
 * WHY THE 7 FALSE-WIN ROWS ARE CORRECTED TOO (explicit, because Item 42's
 * G42-1 was declared IMPOSSIBLE):
 *  Those are two different questions. "What did price actually do?" is settled
 *  with certainty by gold_m1_bars — SL was touched first on real bars in 7 of 7
 *  (Item 39, three independent gate closures). "Can a live replay reproduce the
 *  live monitor banking them?" is what could not be answered, because the
 *  literal ticks are gone. The corpus stores the FIRST question's answer. The
 *  bar-verified truth is therefore authoritative for the label regardless of
 *  G42-1, and all 17 rows are corrected here.
 *
 * VALUE CONVENTION — deliberately the engine's own, not a new one.
 * signalEngine.recordTradeOutcome (:6440, :6472) computes:
 *      pnl        = result === 'WIN' ? +|exit - entry| : -|exit - entry|
 *      realized_r = pnl / stopDistance,  stopDistance = |entry - sl|
 *      is_scratch = |realized_r| < 0.15
 * Reproducing that exactly is what makes the corrected rows indistinguishable
 * from rows the live engine would have written itself. A flat resolution
 * (outcomeResult === null) is NOT forced into a WIN/LOSS: it is reported and
 * skipped, because an invented label is the very defect Item 41 removed.
 *
 * PRE-REGISTERED GATES (fixed before any write was attempted):
 *  G43-1 Exactly the rows whose stored label disagrees with bar-verified truth
 *        are updated. Count must equal the disagreement count. Zero agreeing
 *        rows may be written.
 *  G43-2 Post-write READ-BACK (fresh anon client, not the write response) must
 *        show every corrected row carrying the bar-verified label, pnl and
 *        realized_r, to within 1e-6.
 *  G43-3 Whole-corpus agreement: after the write, ZERO rows in the 51-row
 *        sample may disagree with their bar-verified outcome.
 *  G43-4 No row may be created or deleted. Corpus row count before === after.
 *  G43-5 Local-tier repopulation must be a genuine drop-and-refill from the
 *        durable store, and the refilled tier must carry the corrected labels.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

/** Item 41's canonical maturity window. The truth set is measured on it. */
const RESOLUTION_WINDOW_MS = 8 * 60 * 60 * 1000;
/** signalEngine.ts:562 — reproduced, not redefined. */
const SCRATCH_R_THRESHOLD = 0.15;

const APPLY = process.argv.includes('--apply');

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['expo/.env', '.env']) {
    try {
      const raw = readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
    } catch {
      /* optional */
    }
  }
  return out;
}

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number[];
  id: string;
  generatedMs: number;
}

interface CorpusRow {
  signal_id: string;
  ts: string;
  direction: string | null;
  result: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  realized_r: number | null;
  is_scratch: boolean | null;
}

function parseExport(p: string): ParsedSignal[] {
  const raw = readFileSync(p, 'utf8');
  const body = raw.slice(raw.indexOf('SECTION 1'), raw.indexOf('SECTION 2'));
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);
  const out: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      id: block.match(/id: (\S+)/)?.[1] ?? '',
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? '').getTime(),
      sl: tpm ? parseFloat(tpm[4]) : 0,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
    });
  }
  return out;
}

function toTradingSignal(p: ParsedSignal): TradingSignal {
  return {
    id: p.id || `idx-${p.index}`,
    timestamp: new Date(p.generatedMs),
    createdAt: p.generatedMs,
    type: p.direction,
    entryPrice: p.entry,
    entryPriceWithSlippage: p.entry,
    tp1: p.tp[0],
    tp2: p.tp[1],
    tp3: p.tp[2],
    sl: p.sl,
    slMultiplier: 1,
    confidence: 0.5,
    status: 'ACTIVE',
    targetsHit: 0,
    entryTime: '',
    topFeatures: [],
  } as unknown as TradingSignal;
}

async function fetchBars(client: SupabaseClient, fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let i = 0; i < 600; i++) {
    const { data, error } = await client
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
    cursor = (bars[bars.length - 1] as OhlcBar).timestamp + 1;
  }
  return bars;
}

async function readCorpus(client: SupabaseClient): Promise<CorpusRow[]> {
  const rows: CorpusRow[] = [];
  for (let page = 0; page < 40; page++) {
    const { data, error } = await client
      .from('trade_outcomes_v1')
      .select('signal_id, ts, direction, result, entry_price, exit_price, pnl, realized_r, is_scratch')
      .order('ts', { ascending: true })
      .range(page * 500, (page + 1) * 500 - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...(data as CorpusRow[]));
    if (data.length < 500) break;
  }
  return rows;
}

/** Engine-identical derivation of the stored values from a bar-verified outcome. */
function deriveValues(
  sig: ParsedSignal,
  result: 'WIN' | 'LOSS',
  exitPrice: number,
): { pnl: number; realizedR: number; isScratch: boolean } {
  const magnitude = Math.abs(exitPrice - sig.entry);
  const pnl = result === 'WIN' ? magnitude : -magnitude;
  const stopDistance = Math.abs(sig.entry - sig.sl);
  const realizedR = parseFloat((pnl / stopDistance).toFixed(4));
  return { pnl: parseFloat(pnl.toFixed(4)), realizedR, isScratch: Math.abs(realizedR) < SCRATCH_R_THRESHOLD };
}

interface TruthRow {
  row: CorpusRow;
  sig: ParsedSignal;
  status: string;
  truthResult: 'WIN' | 'LOSS' | null;
  exitPrice: number;
  pnl: number;
  realizedR: number;
  isScratch: boolean;
  disagrees: boolean;
}

let pass = 0;
let fail = 0;
function gate(label: string, ok: boolean, detail: string): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}: ${detail}`);
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL as string;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
  const service = env.SUPABASE_SERVICE_ROLE_KEY as string;

  console.log('='.repeat(80));
  console.log('ITEM 43 — CORRECT THE CORPUS TO BAR-VERIFIED TRUTH');
  console.log('='.repeat(80));
  console.log(`  mode: ${APPLY ? 'APPLY (writes will be made)' : 'DRY RUN (no writes; pass --apply to write)'}`);

  if (!url || !anon) {
    console.log('\n  BLOCKER: EXPO_PUBLIC_SUPABASE_URL / ANON_KEY missing. STOP. Nothing done.');
    process.exitCode = 1;
    return;
  }
  if (APPLY && !service) {
    console.log('\n  BLOCKER: SUPABASE_SERVICE_ROLE_KEY missing and --apply was requested.');
    console.log('  The DATA-SOURCE RULE forbids writing trade_outcomes_v1 with the anon key.');
    console.log('  STOP. Nothing written, nothing reported as done.');
    process.exitCode = 1;
    return;
  }

  const readClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
  const writeClient = service
    ? createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

  // ── export (signal geometry) ──
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  let gotExport = false;
  for (const p of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const res = await fetch(`${url}${p}`, { headers: h });
    if (res.ok) {
      writeFileSync('/tmp/diagnostics_export.txt', await res.text());
      gotExport = true;
      break;
    }
  }
  if (!gotExport) {
    console.log('\n  BLOCKER: diagnostics export unavailable — signal geometry cannot be sourced.');
    console.log('  STOP. Nothing written.');
    process.exitCode = 1;
    return;
  }
  const byId = new Map<string, ParsedSignal>();
  for (const s of parseExport('/tmp/diagnostics_export.txt')) if (s.id) byId.set(s.id, s);

  const before = await readCorpus(readClient);
  console.log(`\n  POWER, stated before the result: ${before.length} durable corpus rows read (anon DIRECT,`);
  console.log('  paginated). This is a census of the whole corpus, not a sample. Every row with');
  console.log('  recoverable geometry is re-derived from real Vantage bars over the 8h window.');

  // ── build the bar-verified truth set ──
  const truth: TruthRow[] = [];
  const unmatched: CorpusRow[] = [];
  const flat: TruthRow[] = [];
  for (const row of before) {
    const sig = byId.get(row.signal_id);
    if (!sig || sig.tp.length < 3 || !(sig.sl > 0)) {
      unmatched.push(row);
      continue;
    }
    const windowEnd = sig.generatedMs + RESOLUTION_WINDOW_MS;
    const bars = await fetchBars(readClient, sig.generatedMs, windowEnd);
    if (bars.length === 0) {
      unmatched.push(row);
      continue;
    }
    const outcome = resolveSignalWithBars(toTradingSignal(sig), bars, {
      fromScratch: true,
      evalNowMs: windowEnd,
    });
    const truthResult = outcome.outcomeResult;
    const t: TruthRow = {
      row,
      sig,
      status: outcome.newStatus,
      truthResult,
      exitPrice: outcome.exitPrice,
      pnl: 0,
      realizedR: 0,
      isScratch: false,
      disagrees: false,
    };
    if (truthResult === null) {
      flat.push(t);
      truth.push(t);
      continue;
    }
    const v = deriveValues(sig, truthResult, outcome.exitPrice);
    t.pnl = v.pnl;
    t.realizedR = v.realizedR;
    t.isScratch = v.isScratch;
    t.disagrees = row.result !== truthResult;
    truth.push(t);
  }

  const toFix = truth.filter((t) => t.disagrees);

  console.log('\n' + '='.repeat(80));
  console.log('43a — THE DISAGREEMENT SET (stored label vs bar-verified truth)');
  console.log('='.repeat(80));
  console.log(`  rows with recoverable geometry + bars: ${truth.length}`);
  console.log(`  rows without (left completely alone):  ${unmatched.length}`);
  console.log(`  FLAT resolutions (outcomeResult null): ${flat.length}  <- never forced into a label`);
  console.log(`  rows DISAGREEING with bar truth:       ${toFix.length}`);
  console.log('');
  console.log('  idx   signal_id    dir   stored -> truth        status                stored_R   truth_R   stored_pnl  truth_pnl');
  console.log('  ' + '─'.repeat(115));
  for (const t of toFix.slice().sort((a, b) => a.sig.index - b.sig.index)) {
    console.log(
      `  ${String(t.sig.index).padEnd(5)} ${t.row.signal_id.slice(-9).padEnd(12)} ${t.sig.direction.padEnd(5)} ` +
        `${(t.row.result + ' -> ' + String(t.truthResult)).padEnd(22)} ${t.status.padEnd(21)} ` +
        `${String(t.row.realized_r ?? 'n/a').padStart(8)} ${t.realizedR.toFixed(3).padStart(9)} ` +
        `${t.row.pnl.toFixed(2).padStart(11)} ${t.pnl.toFixed(2).padStart(10)}`,
    );
  }
  if (flat.length > 0) {
    console.log('\n  FLAT rows (bar-verified as neither win nor loss — reported, NOT relabelled):');
    for (const t of flat) {
      console.log(`    idx ${t.sig.index} (${t.row.signal_id.slice(-9)}): stored=${t.row.result}, bars=${t.status}, outcomeResult=null`);
    }
    console.log('    These are left exactly as stored. Inventing a WIN/LOSS here would re-commit');
    console.log('    the very defect Item 41 removed. If any are also wrong, they need a separate');
    console.log('    decision on how a flat trade should be represented — not a guess made here.');
  }

  if (!APPLY) {
    console.log('\n  DRY RUN — no writes attempted. Re-run with --apply to correct the corpus.');
    return;
  }
  if (!writeClient) {
    console.log('\n  BLOCKER: no service-role client. STOP.');
    process.exitCode = 1;
    return;
  }

  // ── 43a: the writes (service-role only) ──
  console.log('\n' + '='.repeat(80));
  console.log('43a — WRITING CORRECTIONS (service-role key, one UPDATE per signal_id)');
  console.log('='.repeat(80));
  let written = 0;
  const writeErrors: string[] = [];
  for (const t of toFix) {
    const { error } = await writeClient
      .from('trade_outcomes_v1')
      .update({
        result: t.truthResult,
        exit_price: t.exitPrice,
        pnl: t.pnl,
        realized_r: t.realizedR,
        is_scratch: t.isScratch,
      })
      .eq('signal_id', t.row.signal_id);
    if (error) writeErrors.push(`${t.row.signal_id}: ${error.message}`);
    else written++;
  }
  console.log(`  UPDATEs accepted: ${written}/${toFix.length}`);
  if (writeErrors.length > 0) {
    console.log('  WRITE ERRORS:');
    for (const e of writeErrors) console.log(`    ${e}`);
  }

  // ── G43-2 / G43-3 / G43-4: independent read-back on a FRESH anon client ──
  const verifyClient = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });
  const after = await readCorpus(verifyClient);
  const afterById = new Map(after.map((r) => [r.signal_id, r]));

  let readBackOk = 0;
  const readBackBad: string[] = [];
  for (const t of toFix) {
    const r = afterById.get(t.row.signal_id);
    if (!r) {
      readBackBad.push(`${t.row.signal_id}: row missing after write`);
      continue;
    }
    const ok =
      r.result === t.truthResult &&
      Math.abs(Number(r.pnl) - t.pnl) < 1e-6 &&
      Math.abs(Number(r.realized_r ?? NaN) - t.realizedR) < 1e-6;
    if (ok) readBackOk++;
    else
      readBackBad.push(
        `${t.row.signal_id}: read back result=${r.result} pnl=${r.pnl} r=${r.realized_r}, expected ${t.truthResult}/${t.pnl}/${t.realizedR}`,
      );
  }

  const stillDisagreeing = truth.filter((t) => {
    if (t.truthResult === null) return false;
    const r = afterById.get(t.row.signal_id);
    return !r || r.result !== t.truthResult;
  });

  console.log('\n' + '='.repeat(80));
  console.log('GATE VERDICTS');
  console.log('='.repeat(80));
  gate(
    'G43-1 exactly the disagreeing rows were written',
    written === toFix.length && writeErrors.length === 0,
    `${written} UPDATEs for ${toFix.length} disagreeing rows, ${writeErrors.length} errors`,
  );
  gate(
    'G43-2 independent read-back confirms every correction',
    readBackOk === toFix.length,
    `${readBackOk}/${toFix.length} rows read back with the bar-verified label, pnl and realized_r`,
  );
  gate(
    'G43-3 whole-corpus agreement with bar-verified truth',
    stillDisagreeing.length === 0,
    `${stillDisagreeing.length} of ${truth.length} bar-resolvable rows still disagree`,
  );
  gate(
    'G43-4 no row created or deleted',
    after.length === before.length,
    `corpus row count ${before.length} before, ${after.length} after`,
  );
  if (readBackBad.length > 0) {
    console.log('\n  READ-BACK FAILURES:');
    for (const e of readBackBad) console.log(`    ${e}`);
  }

  // ── 43c: corrected corpus EV ──
  const evOf = (rows: CorpusRow[]): { n: number; ev: number; wr: number; pf: number } => {
    const usable = rows.filter((r) => r.realized_r !== null && !r.is_scratch);
    const rs = usable.map((r) => Number(r.realized_r));
    const wins = rs.filter((r) => r > 0);
    const losses = rs.filter((r) => r < 0);
    const gross = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    return {
      n: rs.length,
      ev: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
      wr: rs.length ? (wins.length / rs.length) * 100 : 0,
      pf: grossLoss > 0 ? gross / grossLoss : Number.POSITIVE_INFINITY,
    };
  };
  const beforeEv = evOf(before);
  const afterEv = evOf(after);

  console.log('\n' + '='.repeat(80));
  console.log('43c — CORRECTED CORPUS EV (non-scratch rows carrying realized_r)');
  console.log('='.repeat(80));
  console.log(`  BEFORE  n=${beforeEv.n}  EV=${beforeEv.ev >= 0 ? '+' : ''}${beforeEv.ev.toFixed(4)}R  WR=${beforeEv.wr.toFixed(1)}%  PF=${beforeEv.pf.toFixed(3)}`);
  console.log(`  AFTER   n=${afterEv.n}  EV=${afterEv.ev >= 0 ? '+' : ''}${afterEv.ev.toFixed(4)}R  WR=${afterEv.wr.toFixed(1)}%  PF=${afterEv.pf.toFixed(3)}`);
  console.log(`  DELTA   EV ${afterEv.ev - beforeEv.ev >= 0 ? '+' : ''}${(afterEv.ev - beforeEv.ev).toFixed(4)}R  WR ${(afterEv.wr - beforeEv.wr).toFixed(1)}pp`);
  console.log('');
  console.log('  Read this correctly: the corpus EV is now what the BARS say happened. It is a');
  console.log('  corrected measurement of the same past trades, NOT an improvement in the');
  console.log('  strategy. Nothing about the engine got better between BEFORE and AFTER.');

  console.log('\n' + '='.repeat(80));
  console.log(`ITEM 43 (a + c): ${fail === 0 ? 'ALL GATES PASSED' : 'GATE FAILURE — NOTHING REPORTED AS DONE'} (${pass} passed, ${fail} failed)`);
  console.log('='.repeat(80));
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
