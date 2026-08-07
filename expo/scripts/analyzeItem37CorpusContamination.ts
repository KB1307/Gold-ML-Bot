/**
 * ITEM 37 — IS THE LEARNING CORPUS CONTAMINATED?
 * ==============================================
 *
 * MINDSET 8 rules (restated verbatim):
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
 * DATA-SOURCE RULE: gold_m1_bars + trade_outcomes_v1 read DIRECT from Supabase
 * via anon key. Export fetched to /tmp/diagnostics_export.txt. No Rork backend
 * reads. No engine code is modified. Nothing ships.
 *
 * WHAT THIS SCRIPT MEASURES:
 *  Item 35 confirmed the mechanism gap: live path marks signals CLOSED at >2h
 *  without checking bars, and the audit confirms CLOSED because it also only
 *  looks at 2h of bars. The fromScratch replay with 8h finds TP events after 2h.
 *
 *  The CLOSED-at-2h path calls recordTradeOutcome(signalId, entry, currentPrice,
 *  'LOSS') — pushing a LOSS label to trade_outcomes_v1. The audit does NOT
 *  correct it (2h window confirms CLOSED). So the corpus may carry wrong labels.
 *
 *  This script:
 *   1. Fetches ALL trade_outcomes_v1 rows (anon DIRECT).
 *   2. Fetches the export (has signal_id, entry, sl, tp1/2/3, direction).
 *   3. Cross-references by signal_id.
 *   4. For each matched row, runs fromScratch resolution with 8h bars.
 *   5. Compares corpus result (WIN/LOSS) vs fromScratch outcome.
 *   6. Reports contamination rate, direction, and which signals are affected.
 *   7. Also checks unmatched rows (in corpus but not in export) — what do
 *      they look like?
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveSignalWithBars, type ResolverOutcome } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

// ─── env ────────────────────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['expo/.env', '.env']) {
    try {
      const raw = readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
    } catch { /* optional */ }
  }
  return out;
}

// ─── types ──────────────────────────────────────────────────────────────
interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number[];
  status: string;
  exit: number | null;
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
  confidence: number | null;
}

// ─── export parser (same as Item 32) ─────────────────────────────────────
function parseExport(path: string): ParsedSignal[] {
  const raw = readFileSync(path, 'utf8');
  const body = raw.slice(raw.indexOf('SECTION 1'), raw.indexOf('SECTION 2'));
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);
  const out: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    const exit = block.match(/exit price: ([\d.]+)/);
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      exit: exit ? parseFloat(exit[1]) : null,
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

// ─── bar fetcher ────────────────────────────────────────────────────────
async function fetchBars(client: SupabaseClient, fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let p = 0; p < 400; p++) {
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
    cursor = bars[bars.length - 1].timestamp + 1;
  }
  return bars;
}

// ─── helpers ────────────────────────────────────────────────────────────
function mean(a: number[]): number {
  return a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
}

// ─── MAIN ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const env = loadEnv();
  const client: SupabaseClient = createClient(
    env.EXPO_PUBLIC_SUPABASE_URL as string,
    env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  console.log('='.repeat(80));
  console.log('ITEM 37 — IS THE LEARNING CORPUS (trade_outcomes_v1) CONTAMINATED?');
  console.log('MINDSET 8 rules apply. Read-only. No engine code touched. Nothing ships.');
  console.log('='.repeat(80));

  // ── 1. Fetch export ──
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  for (const path of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const res = await fetch(`${url}${path}`, { headers: h });
    if (res.ok) {
      const text = await res.text();
      writeFileSync('/tmp/diagnostics_export.txt', text);
      console.log(`  Export fetched: ${text.length} bytes`);
      break;
    }
  }

  const signals = parseExport('/tmp/diagnostics_export.txt');
  console.log(`  Export signals parsed: ${signals.length}`);

  // Build lookup by signal_id
  const signalsById = new Map<string, ParsedSignal>();
  for (const s of signals) {
    if (s.id) signalsById.set(s.id, s);
  }

  // ── 2. Fetch ALL trade_outcomes_v1 rows ──
  console.log('\n── Fetching trade_outcomes_v1 (anon DIRECT, paginated) ──');
  const corpus: CorpusRow[] = [];
  const pageSize = 500;
  for (let page = 0; page < 40; page++) {
    const { data, error } = await client
      .from('trade_outcomes_v1')
      .select('signal_id, ts, direction, result, entry_price, exit_price, pnl, realized_r, is_scratch, confidence')
      .order('ts', { ascending: true })
      .range(page * pageSize, (page + 1) * pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    corpus.push(...(data as CorpusRow[]));
    if (data.length < pageSize) break;
  }
  console.log(`  Corpus rows: ${corpus.length}`);

  // ── 3. Cross-reference ──
  console.log('\n' + '='.repeat(80));
  console.log('CROSS-REFERENCE: corpus vs export by signal_id');
  console.log('='.repeat(80));

  const matched: { corpus: CorpusRow; signal: ParsedSignal }[] = [];
  const unmatched: CorpusRow[] = [];
  for (const row of corpus) {
    const sig = signalsById.get(row.signal_id);
    if (sig) {
      matched.push({ corpus: row, signal: sig });
    } else {
      unmatched.push(row);
    }
  }

  console.log(`  Corpus rows matched to export: ${matched.length} / ${corpus.length}`);
  console.log(`  Corpus rows NOT in export:     ${unmatched.length}`);

  // ── 4. Fetch bars for matched signals ──
  if (matched.length === 0) {
    console.log('\n  No matched rows — cannot measure contamination. STOP.');
    console.log('  This itself is a finding: the corpus and export share zero signal_ids.');
    console.log('  The corpus may use a different ID scheme, or the export signals are');
    console.log('  not the same population as the corpus signals.');

    // Report unmatched rows in detail
    console.log('\n── Unmatched corpus rows (sample) ──');
    for (const row of unmatched.slice(0, 20)) {
      console.log(`  ${row.signal_id.slice(-8)}  dir=${row.direction ?? 'n/a'}  result=${row.result}  pnl=${row.pnl.toFixed(1)}  r=${row.realized_r ?? 'n/a'}  ts=${row.ts}`);
    }

    // Check if ANY export signal_id appears in corpus at all
    const corpusIds = new Set(corpus.map((r) => r.signal_id));
    const exportIdsInCorpus = signals.filter((s) => s.id && corpusIds.has(s.id));
    console.log(`\n  Export signal_ids found in corpus: ${exportIdsInCorpus.length} / ${signals.length}`);
    if (exportIdsInCorpus.length > 0) {
      console.log('  (these were missed by the match above — ID format mismatch?)');
      for (const s of exportIdsInCorpus.slice(0, 5)) {
        console.log(`    export: id=${s.id} idx=${s.index} dir=${s.direction} status=${s.status}`);
        const cr = corpus.find((r) => r.signal_id === s.id);
        if (cr) {
          console.log(`    corpus:  result=${cr.result} pnl=${cr.pnl.toFixed(1)} r=${cr.realized_r ?? 'n/a'} dir=${cr.direction ?? 'n/a'}`);
        }
      }
    }

    // Try fuzzy match: same entry_price + same direction
    console.log('\n  Attempting fuzzy match by entry_price + direction...');
    let fuzzyMatches = 0;
    for (const row of unmatched) {
      const fuzzy = signals.find((s) =>
        Math.abs(s.entry - Number(row.entry_price)) < 0.1 &&
        s.direction === (row.direction ?? '').toUpperCase(),
      );
      if (fuzzy) {
        fuzzyMatches++;
        if (fuzzyMatches <= 10) {
          console.log(`    corpus ${row.signal_id.slice(-8)} entry=${row.entry_price} dir=${row.direction} result=${row.result} → export #${fuzzy.index} id=${fuzzy.id} status=${fuzzy.status}`);
        }
      }
    }
    console.log(`  Fuzzy matches (entry±0.1 + direction): ${fuzzyMatches}`);

    console.log('\n' + '='.repeat(80));
    console.log('DONE — Item 37. Nothing was written. No engine code touched.');
    console.log('='.repeat(80));
    return;
  }

  // ── 5. Fetch bars and run fromScratch on matched signals ──
  console.log(`\n── Fetching bars for ${matched.length} matched signals ──`);
  const minTs = Math.min(...matched.map((m) => m.signal.generatedMs)) - 60 * 60_000;
  const maxTs = Math.max(...matched.map((m) => m.signal.generatedMs)) + 8 * 60 * 60_000;
  const allBars = await fetchBars(client, minTs, maxTs);
  console.log(`  Bars fetched: ${allBars.length}`);

  const byMinute = new Map<number, OhlcBar>();
  for (const b of allBars) {
    byMinute.set(Math.floor(b.timestamp / 60_000) * 60_000, b);
  }

  const evalNow = maxTs;
  const quiet = { fromScratch: true, evalNowMs: evalNow, logPrefix: '' };
  const origLog = console.log;
  console.log = (): void => {};

  interface MatchResult {
    corpus: CorpusRow;
    signal: ParsedSignal;
    outcome: ResolverOutcome;
    r: number | null;
    covered: boolean;
    corpusLabel: 'WIN' | 'LOSS' | 'OTHER';
    resolverLabel: 'WIN' | 'LOSS' | 'NEUTRAL';
    agrees: boolean;
  }

  const results: MatchResult[] = [];
  for (const { corpus: row, signal: p } of matched) {
    const sigTs = p.generatedMs;
    const covered = byMinute.has(Math.floor(sigTs / 60_000) * 60_000);
    if (!covered) {
      results.push({
        corpus: row, signal: p, outcome: {} as ResolverOutcome, r: null, covered: false,
        corpusLabel: row.result === 'WIN' ? 'WIN' : row.result === 'LOSS' ? 'LOSS' : 'OTHER',
        resolverLabel: 'NEUTRAL', agrees: false,
      });
      continue;
    }
    const sigBars = allBars.filter((b) => b.timestamp >= sigTs + 60_000 && b.timestamp <= sigTs + 8 * 60 * 60_000);
    const sig = toTradingSignal(p);
    const out = resolveSignalWithBars(sig, sigBars, quiet);
    const risk = Math.abs(p.entry - p.sl);
    const dirSign = p.direction === 'BUY' ? 1 : -1;
    let r: number | null = null;
    if (risk > 0 && out.entryConfirmed) {
      const fill = out.entryFillPrice ?? p.entry;
      r = (dirSign * (out.exitPrice - fill)) / risk;
    }
    const corpusLabel: 'WIN' | 'LOSS' | 'OTHER' = row.result === 'WIN' ? 'WIN' : row.result === 'LOSS' ? 'LOSS' : 'OTHER';
    const resolverLabel: 'WIN' | 'LOSS' | 'NEUTRAL' = out.outcomeResult === 'WIN' ? 'WIN' : out.outcomeResult === 'LOSS' ? 'LOSS' : 'NEUTRAL';
    const agrees = (corpusLabel === 'WIN' && resolverLabel === 'WIN') || (corpusLabel === 'LOSS' && resolverLabel === 'LOSS');
    results.push({ corpus: row, signal: p, outcome: out, r, covered: true, corpusLabel, resolverLabel, agrees });
  }

  console.log = origLog;

  // ── 6. Report contamination ──
  console.log('\n' + '='.repeat(80));
  console.log('CONTAMINATION ANALYSIS — corpus label vs fromScratch outcome');
  console.log('='.repeat(80));

  const covered = results.filter((r) => r.covered);
  const notCovered = results.filter((r) => !r.covered);
  console.log(`  Matched rows:          ${results.length}`);
  console.log(`  Bar-covered:           ${covered.length}`);
  console.log(`  Not bar-covered:       ${notCovered.length}`);

  const agrees = covered.filter((r) => r.agrees);
  const disagrees = covered.filter((r) => !r.agrees);
  console.log(`  Label AGREES:          ${agrees.length}`);
  console.log(`  Label DISAGREES:       ${disagrees.length}`);

  // Direction of contamination
  const falseLoss = covered.filter((r) => r.corpusLabel === 'LOSS' && r.resolverLabel === 'WIN');
  const falseWin = covered.filter((r) => r.corpusLabel === 'WIN' && r.resolverLabel === 'LOSS');
  const falseLossNeutral = covered.filter((r) => r.corpusLabel === 'LOSS' && r.resolverLabel === 'NEUTRAL');
  const falseWinNeutral = covered.filter((r) => r.corpusLabel === 'WIN' && r.resolverLabel === 'NEUTRAL');
  const otherMismatch = covered.filter((r) => r.corpusLabel === 'OTHER' && r.resolverLabel !== 'NEUTRAL');

  console.log('\n  Direction of disagreements:');
  console.log(`    Corpus=LOSS, Resolver=WIN (false LOSS):    ${falseLoss.length}`);
  console.log(`    Corpus=WIN, Resolver=LOSS (false WIN):     ${falseWin.length}`);
  console.log(`    Corpus=LOSS, Resolver=NEUTRAL (flat):      ${falseLossNeutral.length}`);
  console.log(`    Corpus=WIN, Resolver=NEUTRAL (flat):       ${falseWinNeutral.length}`);
  console.log(`    Corpus=OTHER, Resolver=WIN/LOSS:           ${otherMismatch.length}`);

  // Detail on false LOSS (the Item 35 mechanism gap)
  if (falseLoss.length > 0) {
    console.log('\n  ── FALSE LOSS signals (corpus says LOSS, bars say WIN) ──');
    console.log(`  ${'idx'.padStart(4)} ${'dir'.padEnd(5)} ${'entry'.padStart(8)} ${'corpus_result'.padEnd(14)} ${'resolver_status'.padEnd(20)} ${'resolver_R'.padStart(10)} ${'corpus_R'.padStart(10)} ${'corpus_pnl'.padStart(10)}`);
    console.log(`  ${'─'.repeat(100)}`);
    for (const r of falseLoss) {
      const cr = r.r !== null ? r.r.toFixed(4) : 'n/a';
      const ccR = r.corpus.realized_r !== null ? Number(r.corpus.realized_r).toFixed(4) : 'n/a';
      console.log(`  ${String(r.signal.index).padStart(4)} ${r.signal.direction.padEnd(5)} ${r.signal.entry.toFixed(1).padStart(8)} ${r.corpusLabel.padEnd(14)} ${r.outcome.newStatus.padEnd(20)} ${('+' + cr + 'R').padStart(10)} ${ccR.padStart(10)} ${r.corpus.pnl.toFixed(1).padStart(10)}`);
    }
  }

  if (falseWin.length > 0) {
    console.log('\n  ── FALSE WIN signals (corpus says WIN, bars say LOSS) ──');
    console.log(`  ${'idx'.padStart(4)} ${'dir'.padEnd(5)} ${'entry'.padStart(8)} ${'corpus_result'.padEnd(14)} ${'resolver_status'.padEnd(20)} ${'resolver_R'.padStart(10)} ${'corpus_R'.padStart(10)}`);
    console.log(`  ${'─'.repeat(90)}`);
    for (const r of falseWin) {
      const cr = r.r !== null ? r.r.toFixed(4) : 'n/a';
      const ccR = r.corpus.realized_r !== null ? Number(r.corpus.realized_r).toFixed(4) : 'n/a';
      console.log(`  ${String(r.signal.index).padStart(4)} ${r.signal.direction.padEnd(5)} ${r.signal.entry.toFixed(1).padStart(8)} ${r.corpusLabel.padEnd(14)} ${r.outcome.newStatus.padEnd(20)} ${cr.padStart(10)} ${ccR.padStart(10)}`);
    }
  }

  // ── 7. Impact on learning ──
  console.log('\n' + '='.repeat(80));
  console.log('IMPACT ON LEARNING');
  console.log('='.repeat(80));

  const corpusEv = mean(covered.filter((r) => r.corpus.realized_r !== null).map((r) => Number(r.corpus.realized_r)));
  const resolverEv = mean(covered.filter((r) => r.r !== null).map((r) => r.r as number));
  const corpusWr = (covered.filter((r) => r.corpusLabel === 'WIN').length / covered.length) * 100;
  const resolverWr = (covered.filter((r) => r.resolverLabel === 'WIN').length / covered.length) * 100;

  console.log(`  Corpus EV (from realized_r):   ${isNaN(corpusEv) ? 'n/a' : `${corpusEv >= 0 ? '+' : ''}${corpusEv.toFixed(4)}R`}  (n=${covered.filter((r) => r.corpus.realized_r !== null).length})`);
  console.log(`  Resolver EV (from 8h bars):    ${isNaN(resolverEv) ? 'n/a' : `${resolverEv >= 0 ? '+' : ''}${resolverEv.toFixed(4)}R`}  (n=${covered.filter((r) => r.r !== null).length})`);
  console.log(`  Corpus WR:   ${corpusWr.toFixed(1)}%`);
  console.log(`  Resolver WR: ${resolverWr.toFixed(1)}%`);
  console.log('');
  console.log(`  Contamination rate: ${disagrees.length} / ${covered.length} = ${((disagrees.length / covered.length) * 100).toFixed(1)}%`);
  console.log(`  False LOSS rate:    ${falseLoss.length} / ${covered.length} = ${((falseLoss.length / covered.length) * 100).toFixed(1)}%`);
  console.log(`  False WIN rate:     ${falseWin.length} / ${covered.length} = ${((falseWin.length / covered.length) * 100).toFixed(1)}%`);

  if (falseLoss.length > 0 || falseWin.length > 0) {
    console.log('');
    console.log('  THE CORPUS IS CONTAMINATED. The learning engine is training on');
    console.log(`  ${disagrees.length} wrong labels out of ${covered.length} bar-covered rows.`);
    if (falseLoss.length > falseWin.length) {
      console.log(`  The dominant contamination is FALSE LOSS (${falseLoss.length} signals marked`);
      console.log('  LOSS that were actually WIN). This is the Item 35 mechanism gap:');
      console.log('  signals marked CLOSED at >2h → recordTradeOutcome(LOSS) → audit');
      console.log('  confirms CLOSED (2h window) → wrong LOSS label persists in corpus.');
    }
    if (falseWin.length > 0) {
      console.log(`  There are also ${falseWin.length} FALSE WIN labels — signals the corpus`);
      console.log('  recorded as WIN that the bars say were actually LOSS. These may come');
      console.log('  from the live tick monitor banking a phantom TP the bars never confirmed.');
    }
  }

  // ── 8. Unmatched rows ──
  if (unmatched.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log('UNMATCHED CORPUS ROWS (in corpus, not in export)');
    console.log('='.repeat(80));
    console.log(`  Count: ${unmatched.length}`);
    const unmatchedWins = unmatched.filter((r) => r.result === 'WIN').length;
    const unmatchedLosses = unmatched.filter((r) => r.result === 'LOSS').length;
    const unmatchedOther = unmatched.filter((r) => r.result !== 'WIN' && r.result !== 'LOSS').length;
    console.log(`  WIN: ${unmatchedWins}, LOSS: ${unmatchedLosses}, OTHER: ${unmatchedOther}`);
    const unmatchedEv = mean(unmatched.filter((r) => r.realized_r !== null).map((r) => Number(r.realized_r)));
    console.log(`  EV (realized_r): ${isNaN(unmatchedEv) ? 'n/a' : `${unmatchedEv >= 0 ? '+' : ''}${unmatchedEv.toFixed(4)}R`}`);
    console.log('');
    console.log('  These signals are NOT in the export. They may be:');
    console.log('  - signals generated after the export snapshot');
    console.log('  - signals from a different device/session');
    console.log('  - signals whose export block was not captured');
    console.log('  They cannot be bar-verified without their generation timestamp,');
    console.log('  which trade_outcomes_v1 does not store (only ts = recording time).');
  }

  // ── 9. Full corpus summary ──
  console.log('\n' + '='.repeat(80));
  console.log('FULL CORPUS SUMMARY');
  console.log('='.repeat(80));
  const allWins = corpus.filter((r) => r.result === 'WIN').length;
  const allLosses = corpus.filter((r) => r.result === 'LOSS').length;
  const allScratch = corpus.filter((r) => r.is_scratch === true).length;
  const allEv = mean(corpus.filter((r) => r.realized_r !== null).map((r) => Number(r.realized_r)));
  console.log(`  Total rows:     ${corpus.length}`);
  console.log(`  WIN:            ${allWins} (${((allWins / corpus.length) * 100).toFixed(1)}%)`);
  console.log(`  LOSS:           ${allLosses} (${((allLosses / corpus.length) * 100).toFixed(1)}%)`);
  console.log(`  Scratch:        ${allScratch}`);
  console.log(`  EV (realized_r): ${isNaN(allEv) ? 'n/a' : `${allEv >= 0 ? '+' : ''}${allEv.toFixed(4)}R`}`);
  console.log(`  Matched to export: ${matched.length}`);
  console.log(`  Contamination (of bar-covered matched): ${disagrees.length} / ${covered.length} = ${covered.length > 0 ? ((disagrees.length / covered.length) * 100).toFixed(1) : '0'}%`);

  console.log('\n' + '='.repeat(80));
  console.log('DONE — Item 37 complete. Nothing was written. No engine code touched.');
  console.log('='.repeat(80));
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
