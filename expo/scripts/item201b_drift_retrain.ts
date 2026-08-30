/**
 * ITEMS 201(b) / 199(a) / 201(d) — THE DRIFT ARTEFACT, THE RETRAIN SIMULATION,
 * THE UNMARKED COHORT, AND THE CPI/NFP SPLIT.
 *
 * 201(b): recompute analyzeFeatureValueDrift() exactly from the live corpus,
 *         twice — with ALL rows (what the engine hydrates today) and EXCLUDING
 *         provenance-marked reconstruction rows (whose sentiment/volume/dxy/
 *         timeWindow are documented DEFAULTS, not measurements). Then simulate
 *         the retrain: retrainModel() ported faithfully (exponential decay
 *         0.75^age, scratch exclusion, weighted win/loss centroids, the raw
 *         weight formulas, consumed-subset normalization, 0.4/0.6 Bayesian
 *         blend against the CURRENT 1/6 uniform vector) — on ALL rows and on
 *         engine-native rows only. Answers: is a retrain now safe, and what
 *         does the new weight vector look like?
 * 199(a): breakdown of the unmarked cohort (no atrMethod) — confirm they are
 *         engine-native rows, not resolver rows that missed the marker.
 * 201(d): CPI/NFP heuristic windows (signalEngine.ts:5324-5360) applied to
 *         every canonical emission — file:line + provenance + canonical split.
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

interface OutcomeRow {
  signal_id: string; ts: string; result: string; realized_r: number | null;
  is_scratch: boolean | null; features: Record<string, unknown> | null;
}
interface EmittedRow { signal_id: string; emitted_at: string }

/* ─── retrainModel constants, ported verbatim ─── */
const DECAY_LAMBDA = 0.75;              // signalEngine.ts:7874
const BAYESIAN_BLEND_ALPHA = 0.4;       // signalEngine.ts:387
const CONSUMED_MODEL_WEIGHTS = new Set(['rsi_weight', 'dxy_weight', 'volume_weight', 'atr_weight']); // :955
const CURRENT_WEIGHTS: Record<string, number> = {
  rsi_weight: 1 / 6, dxy_weight: 1 / 6, volume_weight: 1 / 6,
  atr_weight: 1 / 6, timeWindow_weight: 1 / 6, sentiment_weight: 1 / 6,
}; // user-stated: all six exactly 1/6 since the 06:27:34Z retrain

function isReconstruction(f: Record<string, unknown> | null): boolean {
  if (!f || typeof f !== 'object') return false;
  const sent = f.sentiment as Record<string, unknown> | undefined;
  return sent?.source === 'resolver-bar-reconstruction' || f.featuresSource === 'app-bar-reconstruction' || f.featuresIncomplete === true;
}

function featureVal(f: Record<string, unknown>, name: string): number {
  if (name === 'sentiment') return Number((f.sentiment as Record<string, unknown> | undefined)?.score ?? 0);
  return Number(f[name] ?? 0);
}

/** Exact replica of analyzeFeatureValueDrift's per-feature computation. */
function computeDrift(rows: OutcomeRow[]): Array<{ feature: string; recentAvg: number; olderAvg: number; drift: number }> {
  const recent = rows.slice(-20);
  const older = rows.slice(-40, -20);
  const out: Array<{ feature: string; recentAvg: number; olderAvg: number; drift: number }> = [];
  if (older.length < 10) return out;
  for (const name of ['rsi', 'atr', 'volumeRatio', 'sentiment', 'dxyChange']) {
    const rw = recent.filter(o => o.result === 'WIN' && o.features);
    const ow = older.filter(o => o.result === 'WIN' && o.features);
    if (rw.length === 0 || ow.length === 0) continue;
    const recentAvg = rw.reduce((s, o) => s + featureVal(o.features!, name), 0) / rw.length;
    const olderAvg = ow.reduce((s, o) => s + featureVal(o.features!, name), 0) / ow.length;
    const drift = Math.abs(Math.abs(recentAvg) - Math.abs(olderAvg)) / (Math.abs(olderAvg) + 0.01);
    out.push({ feature: name, recentAvg, olderAvg, drift });
  }
  return out;
}

/** Faithful retrainModel port. Returns { recent, blended } weight vectors. */
function simulateRetrain(rows: OutcomeRow[]): { recent: Record<string, number>; blended: Record<string, number>; nTrain: number; nWin: number; nLoss: number; nScratch: number } {
  const now = Date.now();
  const dataWithWeights = rows.map(outcome => {
    const daysSinceOutcome = (now - new Date(outcome.ts).getTime()) / (24 * 60 * 60 * 1000);
    return { outcome, weight: Math.pow(DECAY_LAMBDA, daysSinceOutcome) };
  });
  const totalWeight = dataWithWeights.reduce((sum, d) => sum + d.weight, 0);
  const normalizedData = dataWithWeights.map(d => ({ ...d, weight: d.weight / totalWeight }));
  const scratch = normalizedData.filter(d => d.outcome.is_scratch === true);
  const labelled = normalizedData.filter(d => d.outcome.is_scratch !== true);
  const winners = labelled.filter(d => d.outcome.result === 'WIN');
  const losers = labelled.filter(d => d.outcome.result === 'LOSS');
  const winningData = winners.length > 0 ? winners : normalizedData;
  const losingData = losers.length > 0 ? losers : normalizedData;

  const wAvg = (data: typeof winningData, get: (f: Record<string, unknown>) => number): number =>
    data.reduce((s, d) => s + get(d.outcome.features ?? {}) * d.weight, 0) / data.reduce((s, d) => s + d.weight, 0);

  const raw: Record<string, number> = {};
  raw['rsi_weight'] = (wAvg(winningData, f => Number(f.rsi ?? 0)) - wAvg(losingData, f => Number(f.rsi ?? 0))) / 100;
  raw['timeWindow_weight'] = (wAvg(winningData, f => Number(f.timeWindowFactor ?? 0)) - wAvg(losingData, f => Number(f.timeWindowFactor ?? 0))) * 0.5;
  raw['volume_weight'] = wAvg(winningData, f => Number(f.volumeRatio ?? 0)) - wAvg(losingData, f => Number(f.volumeRatio ?? 0));
  raw['sentiment_weight'] = (wAvg(winningData, f => Number((f.sentiment as Record<string, unknown> | undefined)?.score ?? 0)) - wAvg(losingData, f => Number((f.sentiment as Record<string, unknown> | undefined)?.score ?? 0))) * 2;
  raw['atr_weight'] = (wAvg(winningData, f => Number(f.atr ?? 0)) - wAvg(losingData, f => Number(f.atr ?? 0))) / 10;
  raw['dxy_weight'] = (wAvg(winningData, f => Number(f.dxyChange ?? 0)) - wAvg(losingData, f => Number(f.dxyChange ?? 0))) * 2;

  const sumAll = Object.values(raw).reduce((s, w) => s + Math.abs(w), 0);
  const sumConsumed = Object.entries(raw).filter(([k]) => CONSUMED_MODEL_WEIGHTS.has(k)).reduce((s, [, w]) => s + Math.abs(w), 0);
  const recent: Record<string, number> = {};
  if (sumAll > 0) {
    for (const [key, value] of Object.entries(raw)) {
      const denominator = CONSUMED_MODEL_WEIGHTS.has(key) && sumConsumed > 0 ? sumConsumed : sumAll;
      recent[key] = value / denominator;
    }
  } else {
    for (const key of Object.keys(raw)) recent[key] = 1 / Object.keys(raw).length;
  }
  const blended: Record<string, number> = {};
  for (const key of Object.keys(raw)) {
    blended[key] = BAYESIAN_BLEND_ALPHA * (CURRENT_WEIGHTS[key] ?? 0) + (1 - BAYESIAN_BLEND_ALPHA) * recent[key];
  }
  return { recent, blended, nTrain: rows.length, nWin: winners.length, nLoss: losers.length, nScratch: scratch.length };
}

function printVector(label: string, v: Record<string, number>): void {
  console.log(`  ${label}:`);
  for (const [k, val] of Object.entries(v).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
    console.log(`    ${k.padEnd(18)} ${val >= 0 ? '+' : ''}${val.toFixed(4)}  (${(Math.abs(val) * 100).toFixed(1)}% |w|)`);
  }
}

/** CPI/NFP heuristic windows, ported from signalEngine.ts:5324-5360. */
function macroWindow(d: Date): 'NFP' | 'CPI' | 'FOMC' | null {
  const hour = d.getUTCHours();
  const dayOfWeek = d.getUTCDay();
  const dayOfMonth = d.getUTCDate();
  const nfpWeek = dayOfWeek === 5 && dayOfMonth >= 1 && dayOfMonth <= 7;
  const cpiWeek = dayOfMonth >= 10 && dayOfMonth <= 15;
  const fomcWeek = [20, 21, 22, 23].includes(dayOfMonth);
  if (nfpWeek && hour >= 12 && hour < 15) return 'NFP';
  if (cpiWeek && dayOfWeek >= 2 && dayOfWeek <= 4 && hour >= 12 && hour < 15) return 'CPI';
  if (fomcWeek && dayOfWeek === 3 && hour >= 17 && hour < 20) return 'FOMC';
  return null;
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('ITEMS 201(b) / 199(a) / 201(d) — ' + new Date().toISOString());
  console.log('='.repeat(100));

  const outcomes: OutcomeRow[] = [];
  for (let page = 0; page < 60; page++) {
    const { data, error } = await supabase.from('trade_outcomes_v1').select('signal_id, ts, result, realized_r, is_scratch, features').order('ts', { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as OutcomeRow[];
    outcomes.push(...batch);
    if (batch.length < 1000) break;
  }
  console.log(`corpus rows (ts-ordered): ${outcomes.length}`);

  // ── 199(a): the unmarked cohort ──
  console.log('\n── 199(a) THE UNMARKED COHORT (no atrMethod) ──');
  let wilder = 0;
  let reconMarkedNoWilder = 0;
  const unmarked: OutcomeRow[] = [];
  let emptyFeatures = 0;
  for (const o of outcomes) {
    const f = o.features;
    if (!f || typeof f !== 'object' || Object.keys(f).length === 0) { emptyFeatures++; continue; }
    const hasWilder = f.atrMethod === 'wilder';
    const recon = isReconstruction(f);
    if (hasWilder) { wilder++; continue; }
    if (recon) { reconMarkedNoWilder++; continue; }
    unmarked.push(o);
  }
  console.log(`  total=${outcomes.length}  atrMethod=wilder=${wilder}  reconstruction-marked WITHOUT wilder=${reconMarkedNoWilder}  empty=${emptyFeatures}  UNMARKED=${unmarked.length}`);
  const schemaVersions = new Map<number, number>();
  let unmarkedRealSentiment = 0;
  let unmarkedNonDefaultVolume = 0;
  for (const o of unmarked) {
    const f = o.features!;
    const sv = Number(f.schemaVersion ?? 0);
    schemaVersions.set(sv, (schemaVersions.get(sv) ?? 0) + 1);
    const sent = (f.sentiment as Record<string, unknown> | undefined)?.score;
    if (typeof sent === 'number' && sent !== 0) unmarkedRealSentiment++;
    if (typeof f.volumeRatio === 'number' && f.volumeRatio !== 1) unmarkedNonDefaultVolume++;
  }
  console.log(`  unmarked schemaVersion distribution: ${Array.from(schemaVersions.entries()).sort((a, b) => a[0] - b[0]).map(([k, v]) => `v${k}=${v}`).join(', ')}`);
  console.log(`  unmarked rows with a NON-ZERO sentiment score (real engine feed, not a reconstruction default): ${unmarkedRealSentiment}/${unmarked.length}`);
  console.log(`  unmarked rows with volumeRatio != 1 (real engine feed): ${unmarkedNonDefaultVolume}/${unmarked.length}`);
  const sample = unmarked[unmarked.length - 1];
  if (sample) console.log(`  newest unmarked row ${sample.signal_id} features: ${JSON.stringify(sample.features).slice(0, 300)}`);

  // ── 201(b): drift, both ways ──
  console.log('\n── 201(b) DRIFT RECOMPUTE ──');
  const withAll = computeDrift(outcomes);
  const clean = computeDrift(outcomes.filter(o => !isReconstruction(o.features)));
  console.log('  WITH all rows (what the engine hydrates today):');
  for (const m of withAll) console.log(`    ${m.feature.padEnd(12)} ${m.olderAvg.toFixed(4)} -> ${m.recentAvg.toFixed(4)}  drift=${m.drift.toFixed(4)}`);
  if (withAll.length > 0) console.log(`    mean drift: ${(withAll.reduce((s, m) => s + m.drift, 0) / withAll.length).toFixed(4)}`);
  console.log('  EXCLUDING provenance-marked reconstruction rows:');
  for (const m of clean) console.log(`    ${m.feature.padEnd(12)} ${m.olderAvg.toFixed(4)} -> ${m.recentAvg.toFixed(4)}  drift=${m.drift.toFixed(4)}`);
  if (clean.length > 0) console.log(`    mean drift: ${(clean.reduce((s, m) => s + m.drift, 0) / clean.length).toFixed(4)}`);

  // ── 201(b): the retrain simulation ──
  console.log('\n── 201(b) RETRAIN SIMULATION (retrainModel ported verbatim; historical vector = current 1/6 uniform) ──');
  const trainRows = outcomes.filter(o => o.features && Object.keys(o.features).length > 0);
  const simAll = simulateRetrain(trainRows);
  console.log(`  trained on ALL populated rows: n=${simAll.nTrain} (wins=${simAll.nWin} losses=${simAll.nLoss} scratches-excluded=${simAll.nScratch})`);
  printVector('recent-only vector (ALL rows)', simAll.recent);
  printVector('BLENDED vector (ALL rows) — what a retrain TODAY would install', simAll.blended);

  const nativeRows = trainRows.filter(o => !isReconstruction(o.features));
  const simNative = simulateRetrain(nativeRows);
  console.log(`\n  trained on ENGINE-NATIVE rows only: n=${simNative.nTrain} (wins=${simNative.nWin} losses=${simNative.nLoss} scratches-excluded=${simNative.nScratch})`);
  printVector('recent-only vector (engine-native only)', simNative.recent);
  printVector('BLENDED vector (engine-native only) — the artefact-safe retrain', simNative.blended);

  // ── 201(d): CPI/NFP canonical split ──
  console.log('\n── 201(d) CPI/NFP HEURISTIC WINDOWS (signalEngine.ts:5324-5360) — canonical split ──');
  const emitted: EmittedRow[] = [];
  for (let page = 0; page < 60; page++) {
    const { data, error } = await supabase.from('emitted_signals_v1').select('signal_id, emitted_at').or("closed_market_emission.is.null,closed_market_emission.eq.false").order('emitted_at', { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as EmittedRow[];
    emitted.push(...batch);
    if (batch.length < 1000) break;
  }
  const outcomeBySignal = new Map(outcomes.map(o => [o.signal_id, o] as const));
  const groups: Record<string, { n: number; wins: number; ev: number }> = {};
  for (const e of emitted) {
    const o = outcomeBySignal.get(e.signal_id);
    if (!o || o.realized_r === null || o.is_scratch === true) continue;
    const w = macroWindow(new Date(e.emitted_at));
    const key = w ?? 'OUTSIDE';
    if (!groups[key]) groups[key] = { n: 0, wins: 0, ev: 0 };
    groups[key].n++;
    if (o.result === 'WIN') groups[key].wins++;
    groups[key].ev += o.realized_r ?? 0;
  }
  for (const [key, g] of Object.entries(groups)) {
    console.log(`    ${key.padEnd(8)} n=${String(g.n).padStart(3)}  WR=${((g.wins / Math.max(g.n, 1)) * 100).toFixed(1)}%  EV_net=${(g.ev / Math.max(g.n, 1)).toFixed(4)}R`);
  }

  console.log('\nDONE.');
}

main().catch(err => { console.error('FAILED:', err instanceof Error ? err.message : String(err)); process.exit(1); });
