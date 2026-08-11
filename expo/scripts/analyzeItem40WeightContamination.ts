/**
 * ITEM 40 — IS THE LIVE model_weights_v1 ALREADY CONTAMINATED?
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
 * DATA-SOURCE RULE: trade_outcomes_v1 + gold_m1_bars read DIRECT via anon key.
 * READ-ONLY. No retrain triggered. No weights modified. Nothing ships.
 *
 * WHAT THIS ANSWERS:
 *  40a. Every retrain since the corpus first held >=20 outcomes, and whether the
 *       corpus at that moment contained any of the known-wrong rows.
 *  40b. Is the CURRENTLY LIVE weight vector fitted to contaminated labels, and
 *       what fraction of its training set was wrong?
 *
 * LIVE-SYSTEM FACTS ESTABLISHED BY CODE READING (signalEngine.ts):
 *  - MODEL_WEIGHTS_KEY = 'model_weights_v1', persisted to AsyncStorage (:279, :6828).
 *  - Persisted payload holds ONLY the LATEST retrain: { weights, lastTrainingTime,
 *    corpusSizeAtTraining, hydrateUnavailableAtTraining } (:6823-6827). There is NO
 *    retrain-history array and NO durable retrain-history table in Supabase
 *    (migrations hold only shadow_signals_v1). => enumerating EVERY historical
 *    retrain from durable evidence is IMPOSSIBLE (MINDSET rule 8). We reconstruct
 *    the ONE retrain that produced the live vector, plus the SCHEDULE that governs
 *    retrains, and state exactly what forward telemetry would settle the rest.
 *  - Retrain gate: walkForwardOptimization returns early unless
 *    tradeOutcomes.length >= 20 (:6618).
 *  - Training window: TRAINING_WINDOW_DAYS = 14 (:307). trainingData =
 *    outcomes with timestamp >= now - 14d (:6623-6625).
 *  - If that window yields < 10, it falls back to the last MAX_STORED_OUTCOMES
 *    (300) outcomes instead (:6627-6631).
 *  - Retrain triggers: >48h since last training (:6552) OR confidence
 *    degradation / win-rate drift (:6558); executed only in the 22:00-07:00 UTC
 *    low-liquidity window, else deferred (:6565-6584).
 *
 * PRE-REGISTERED GATES:
 *  G1. A retrain is "contaminated" if >=1 known-wrong row falls inside its
 *      reconstructed training set.
 *  G2. Contamination fraction = wrong_rows_in_training_set / training_set_size.
 *      Reported as a plain fraction; no threshold is applied to it, because the
 *      decision (halt retraining or not) is the user's, on real numbers.
 *  G3. If the persisted corpusSizeAtTraining disagrees with the reconstructed
 *      training-set size, the reconstruction is declared UNRELIABLE and the
 *      discrepancy is reported rather than smoothed over.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

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
  status: string;
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

function parseExport(path: string): ParsedSignal[] {
  const raw = readFileSync(path, 'utf8');
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
      status: head[4],
      id: block.match(/id: (\S+)/)?.[1] ?? '',
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? '').getTime(),
      sl: tpm ? parseFloat(tpm[4]) : 0,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
    });
  }
  return out;
}

/** Pull the SECTION 2 model-weights provenance block out of the export. */
function parseModelWeightsSection(path: string): {
  present: boolean;
  raw: string;
  lastTrainingTime: string | null;
  featureCount: number | null;
  corpusSizeAtTraining: number | null;
  corpusUnavailableAtTraining: string | null;
} {
  const raw = readFileSync(path, 'utf8');
  const i = raw.indexOf('SECTION 2');
  if (i < 0) {
    return {
      present: false,
      raw: '',
      lastTrainingTime: null,
      featureCount: null,
      corpusSizeAtTraining: null,
      corpusUnavailableAtTraining: null,
    };
  }
  const j = raw.indexOf('SECTION 3', i);
  const body = raw.slice(i, j > 0 ? j : Math.min(raw.length, i + 8000));
  const ltt = body.match(/Last training time:\s*(.+)/);
  const fc = body.match(/Feature count:\s*(\d+)/);
  const cs = body.match(/Corpus size at training:\s*(\d+)/);
  const cu = body.match(/Corpus-unavailable count at training:\s*(.+)/);
  return {
    present: true,
    raw: body,
    lastTrainingTime: ltt ? ltt[1].trim() : null,
    featureCount: fc ? parseInt(fc[1], 10) : null,
    corpusSizeAtTraining: cs ? parseInt(cs[1], 10) : null,
    corpusUnavailableAtTraining: cu ? cu[1].trim() : null,
  };
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
  for (let p = 0; p < 600; p++) {
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

const WIN_STATUSES = new Set([
  'ALL_TARGETS_HIT',
  'TP3_HIT',
  'TP2_HIT',
  'TP1_HIT',
  'PARTIAL_WIN_SL_HIT',
  'SL_AFTER_BE',
]);

const TRAINING_WINDOW_DAYS = 14;
const MIN_OUTCOMES_FOR_RETRAIN = 20;

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL as string;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
  const client: SupabaseClient = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('='.repeat(80));
  console.log('ITEM 40 — IS THE LIVE model_weights_v1 ALREADY FITTED TO WRONG LABELS?');
  console.log('MINDSET 8 rules apply. READ-ONLY. No retrain triggered. Nothing ships.');
  console.log('='.repeat(80));
  console.log('\nPRE-REGISTERED GATES:');
  console.log('  G1 A retrain is CONTAMINATED if >=1 known-wrong row is inside its training set.');
  console.log('  G2 Contamination fraction = wrong_in_training / training_size (no threshold applied).');
  console.log('  G3 If persisted corpusSizeAtTraining disagrees with the reconstruction, the');
  console.log('     reconstruction is declared UNRELIABLE and the discrepancy is reported.');

  // ── export ──
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  let ok = false;
  for (const p of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const res = await fetch(`${url}${p}`, { headers: h });
    if (res.ok) {
      writeFileSync('/tmp/diagnostics_export.txt', await res.text());
      ok = true;
      break;
    }
  }
  if (!ok) {
    console.log('\n  BLOCKER: export unavailable. STOP. Nothing reported as done.');
    return;
  }
  const signals = parseExport('/tmp/diagnostics_export.txt');
  const byId = new Map<string, ParsedSignal>();
  for (const s of signals) if (s.id) byId.set(s.id, s);

  // ── model weights provenance ──
  console.log('\n' + '='.repeat(80));
  console.log('LIVE WEIGHT-VECTOR PROVENANCE (export SECTION 2 = model_weights_v1 contents)');
  console.log('='.repeat(80));
  const mw = parseModelWeightsSection('/tmp/diagnostics_export.txt');
  if (!mw.present) {
    console.log('  SECTION 2 not present in this export.');
    console.log('  BLOCKER for 40a/40b as specified: the live vector provenance is not in this');
    console.log('  artefact. Reporting nothing as done for the provenance-dependent parts.');
  } else {
    console.log(`  Last training time:                 ${mw.lastTrainingTime ?? 'NOT PARSED'}`);
    console.log(`  Feature count:                      ${mw.featureCount ?? 'NOT PARSED'}`);
    console.log(`  Corpus size at training:            ${mw.corpusSizeAtTraining ?? 'NOT PARSED / UNKNOWN'}`);
    console.log(`  Corpus-unavailable at training:     ${mw.corpusUnavailableAtTraining ?? 'NOT PARSED'}`);
  }

  // ── corpus ──
  const corpus: CorpusRow[] = [];
  for (let page = 0; page < 40; page++) {
    const { data, error } = await client
      .from('trade_outcomes_v1')
      .select('signal_id, ts, direction, result, entry_price, exit_price, pnl, realized_r, is_scratch')
      .order('ts', { ascending: true })
      .range(page * 500, (page + 1) * 500 - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    corpus.push(...(data as CorpusRow[]));
    if (data.length < 500) break;
  }
  console.log(`\n  Corpus rows (trade_outcomes_v1): ${corpus.length}`);
  if (corpus.length > 0) {
    console.log(`  Corpus ts range: ${corpus[0].ts}  ->  ${corpus[corpus.length - 1].ts}`);
  }

  // ── recompute the wrong rows (do NOT hardcode Item 37's list) ──
  console.log('\n' + '='.repeat(80));
  console.log('RE-DERIVING THE KNOWN-WRONG ROWS (independent recomputation, not hardcoded)');
  console.log('='.repeat(80));
  const wrong: { row: CorpusRow; corpusLabel: string; barLabel: string; resolverStatus: string }[] = [];
  let checked = 0;
  for (const row of corpus) {
    const sig = byId.get(row.signal_id);
    if (!sig || sig.tp.length < 3 || !(sig.sl > 0)) continue;
    const bars = await fetchBars(client, sig.generatedMs, sig.generatedMs + 8 * 3600_000);
    if (bars.length === 0) continue;
    checked++;
    const outcome = resolveSignalWithBars(toTradingSignal(sig), bars, {
      fromScratch: true,
      evalNowMs: sig.generatedMs + 8 * 3600_000,
    });
    const barLabel = WIN_STATUSES.has(outcome.newStatus)
      ? 'WIN'
      : outcome.newStatus === 'SL_HIT'
        ? 'LOSS'
        : 'OTHER';
    if (barLabel !== 'OTHER' && row.result !== barLabel) {
      wrong.push({ row, corpusLabel: row.result, barLabel, resolverStatus: outcome.newStatus });
    }
  }
  console.log(`  Rows checked (matched + bar-covered): ${checked}`);
  console.log(`  KNOWN-WRONG rows re-derived:          ${wrong.length}`);
  const wrongIds = new Set(wrong.map((w) => w.row.signal_id));
  console.log('\n  Wrong rows, in corpus ts order (this ordering is what decides membership):');
  console.log('  #    ts                        signal_id   corpus  bars(resolver)');
  console.log('  ' + '─'.repeat(78));
  wrong
    .slice()
    .sort((a, b) => new Date(a.row.ts).getTime() - new Date(b.row.ts).getTime())
    .forEach((w, k) => {
      console.log(
        `  ${String(k + 1).padEnd(4)} ${w.row.ts.padEnd(25)} ${w.row.signal_id.slice(-9).padEnd(11)} ${w.corpusLabel.padEnd(7)} ${w.barLabel} (${w.resolverStatus})`,
      );
    });

  // ── 40a: retrain reconstruction ──
  console.log('\n' + '='.repeat(80));
  console.log('40a — RETRAINS SINCE THE CORPUS FIRST HELD >=20 OUTCOMES');
  console.log('='.repeat(80));
  const sorted = corpus.slice().sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  if (sorted.length < MIN_OUTCOMES_FOR_RETRAIN) {
    console.log(`  Corpus holds ${sorted.length} rows — never reached the ${MIN_OUTCOMES_FOR_RETRAIN}-outcome retrain gate.`);
  } else {
    const twentiethTs = sorted[MIN_OUTCOMES_FOR_RETRAIN - 1].ts;
    console.log(`  Corpus reached ${MIN_OUTCOMES_FOR_RETRAIN} outcomes at: ${twentiethTs}`);
    console.log(`  (row #${MIN_OUTCOMES_FOR_RETRAIN} by ts = signal ${sorted[MIN_OUTCOMES_FOR_RETRAIN - 1].signal_id.slice(-9)})`);
    console.log(`  From that instant on, EVERY recordTradeOutcome call could trigger a retrain`);
    console.log(`  (48h-scheduled or confidence/drift), deferred to the 22:00-07:00 UTC window.`);

    console.log('\n  IMPOSSIBLE-MEASUREMENT DECLARATION (MINDSET rule 8):');
    console.log('  model_weights_v1 persists ONLY the latest retrain (signalEngine.ts:6823-6827).');
    console.log('  There is NO retrain-history array and NO durable retrain-history table');
    console.log('  (backend/migrations holds only shadow_signals_v1). So the full list of every');
    console.log('  historical retrain and its exact training set is NOT RECOVERABLE from durable');
    console.log('  evidence. This is IMPOSSIBLE, not underpowered. What IS recoverable is the ONE');
    console.log('  retrain that produced the CURRENTLY LIVE vector, which is what 40b asks for.');
    console.log('  FORWARD EVIDENCE THAT WOULD SETTLE IT: persist an append-only retrain-history');
    console.log('  record (timestamp + training-set signal_ids) on every walkForwardOptimization.');
  }

  // ── 40b: is the live vector contaminated? ──
  console.log('\n' + '='.repeat(80));
  console.log('40b — IS THE CURRENTLY LIVE WEIGHT VECTOR FITTED TO CONTAMINATED LABELS?');
  console.log('='.repeat(80));

  const lttMs = mw.lastTrainingTime ? new Date(mw.lastTrainingTime).getTime() : NaN;
  if (!Number.isFinite(lttMs)) {
    console.log('  Last training time is not a parseable instant.');
    console.log('  BLOCKER: cannot reconstruct the training set. Reporting nothing as done for 40b.');
  } else {
    console.log(`  Live vector trained at: ${new Date(lttMs).toISOString()}`);
    const cutoff = lttMs - TRAINING_WINDOW_DAYS * 24 * 3600_000;
    console.log(`  Training window:        last ${TRAINING_WINDOW_DAYS} days => rows with ts >= ${new Date(cutoff).toISOString()}`);

    // Rows that EXISTED at training time and fall inside the 14d window.
    const existed = sorted.filter((r) => new Date(r.ts).getTime() <= lttMs);
    const inWindow = existed.filter((r) => new Date(r.ts).getTime() >= cutoff);
    const usedFallback = inWindow.length < 10;
    const trainingSet = usedFallback ? existed.slice(-300) : inWindow;

    console.log(`\n  Rows existing at training time:        ${existed.length}`);
    console.log(`  Of those, inside the 14-day window:    ${inWindow.length}`);
    console.log(`  Fallback path used (window < 10)?      ${usedFallback ? 'YES -> last 300 outcomes' : 'NO'}`);
    console.log(`  RECONSTRUCTED TRAINING SET SIZE:       ${trainingSet.length}`);
    console.log(`  PERSISTED corpusSizeAtTraining:        ${mw.corpusSizeAtTraining ?? 'UNKNOWN'}`);

    // G3
    if (mw.corpusSizeAtTraining === null) {
      console.log('\n  G3: persisted corpusSizeAtTraining is UNKNOWN -> reconstruction cannot be');
      console.log('      cross-validated. Treat the fraction below as INDICATIVE, not confirmed.');
    } else if (mw.corpusSizeAtTraining !== trainingSet.length) {
      console.log(`\n  G3 TRIGGERED: persisted (${mw.corpusSizeAtTraining}) != reconstructed (${trainingSet.length}).`);
      console.log('      The reconstruction is UNRELIABLE. Reporting the discrepancy rather than');
      console.log('      smoothing it over. Most likely cause: the local in-memory corpus that');
      console.log('      actually fed the retrain is NOT identical to the durable Supabase table');
      console.log('      (local store is capped/pruned independently, and rows can fail to upsert).');
    } else {
      console.log('\n  G3: persisted size MATCHES reconstruction -> reconstruction is reliable.');
    }

    const wrongInTraining = trainingSet.filter((r) => wrongIds.has(r.signal_id));
    const frac = trainingSet.length > 0 ? wrongInTraining.length / trainingSet.length : NaN;

    console.log('\n  ── ANSWER ──');
    console.log(`  Known-wrong rows inside the reconstructed training set: ${wrongInTraining.length}`);
    console.log(`  Training set size:                                      ${trainingSet.length}`);
    console.log(`  CONTAMINATION FRACTION OF THE LIVE TRAINING SET:        ${(frac * 100).toFixed(1)}%`);
    console.log(`  G1 VERDICT: live weight vector is ${wrongInTraining.length >= 1 ? 'CONTAMINATED' : 'NOT contaminated'}.`);

    if (wrongInTraining.length > 0) {
      console.log('\n  The specific wrong rows the live vector was fitted on:');
      console.log('  ts                        signal_id   corpus_said  bars_say');
      console.log('  ' + '─'.repeat(66));
      for (const r of wrongInTraining) {
        const w = wrong.find((x) => x.row.signal_id === r.signal_id);
        console.log(
          `  ${r.ts.padEnd(25)} ${r.signal_id.slice(-9).padEnd(11)} ${(w?.corpusLabel ?? '?').padEnd(12)} ${w?.barLabel ?? '?'} (${w?.resolverStatus ?? '?'})`,
        );
      }
    }

    // Exponential decay: which wrong rows carried the MOST weight?
    console.log('\n  ── DECAY-WEIGHTED INFLUENCE OF THE WRONG ROWS ──');
    console.log('  retrainModel applies weight = 0.75 ^ daysSinceOutcome (signalEngine.ts:6644-6651),');
    console.log('  normalised across the training set. A wrong row close to the retrain instant');
    console.log('  therefore distorts the vector far more than an old one.');
    const DECAY = 0.75;
    let totalW = 0;
    const weights: { id: string; ts: string; w: number; isWrong: boolean }[] = [];
    for (const r of trainingSet) {
      const days = (lttMs - new Date(r.ts).getTime()) / (24 * 3600_000);
      const w = Math.pow(DECAY, days);
      totalW += w;
      weights.push({ id: r.signal_id, ts: r.ts, w, isWrong: wrongIds.has(r.signal_id) });
    }
    const wrongW = weights.filter((x) => x.isWrong).reduce((s, x) => s + x.w, 0);
    console.log(`\n  Wrong-row share of TOTAL DECAY WEIGHT: ${totalW > 0 ? ((wrongW / totalW) * 100).toFixed(1) : 'n/a'}%`);
    console.log(`  (vs their raw count share of ${(frac * 100).toFixed(1)}%)`);
    const topWrong = weights
      .filter((x) => x.isWrong)
      .sort((a, b) => b.w - a.w)
      .slice(0, 5);
    if (topWrong.length > 0) {
      console.log('\n  Highest-influence wrong rows (normalised decay weight):');
      for (const t of topWrong) {
        console.log(`    ${t.ts}  ${t.id.slice(-9)}  weight=${totalW > 0 ? ((t.w / totalW) * 100).toFixed(2) : '?'}%`);
      }
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('DONE — Item 40 complete. READ-ONLY. No retrain triggered. No weights modified.');
  console.log('='.repeat(80));
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
