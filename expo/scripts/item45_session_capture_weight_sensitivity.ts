/**
 * ITEM 45 — DOES THE SESSION-CAPTURE SKEW MATERIALLY MOVE THE WEIGHT VECTOR?
 * ==========================================================================
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
 * THE QUESTION. Item 43(d) failed G43D-4: LONDON corpus capture (18.9%) is 2.50x
 * ASIA capture (7.5%), because a row only exists if a CLIENT WAS RUNNING when the
 * signal resolved. So the learning corpus is a client-uptime-weighted sample of
 * the population. This script asks whether correcting that skew moves the weight
 * vector enough to matter, or whether 12.9% overall capture is too thin for ANY
 * retrain to be trusted right now.
 *
 * METHOD. Inverse-propensity weighting (IPW) on the REAL corpus rows. No
 * synthetic rows are created: a row's INFLUENCE is raised by replicating that
 * SAME real row an integer number of times, with the factor set from the
 * measured per-session capture rate (weight ~ 1/capture). Both arms warm-start
 * from the IDENTICAL live vector via the real loadPersistedLearningData(), so the
 * only variable between arms is the session weighting. This mirrors Item 44's
 * warm-start design exactly so the deltas are comparable to Item 44's.
 *
 * WHY REPLICATION AND WHAT IT COSTS. retrainModel() has no per-sample weight
 * parameter, so integer replication is the only way to express IPW through the
 * REAL training function without modifying it. Cost, stated up front: factors are
 * rounded to integers, so the correction is approximate, and replication also
 * inflates the effective sample count the trainer sees. Both are reported.
 *
 * DATA-SOURCE RULE: trade_outcomes_v1 read DIRECT via anon key. No writes.
 *
 * PRE-REGISTERED GATES AND THRESHOLDS (declared before any result):
 *  G45-1 IDENTICAL START: both arms must load the live vector as W_historical to
 *        within 1e-9 before training.
 *  G45-2 DETERMINISM: re-running the reweighted arm must reproduce it to 1e-12.
 *  G45-3 VALID OUTPUT: all 6 features finite in both arms.
 *  G45-4 MATERIALITY (the actual question). Pre-registered threshold: the
 *        session-correction is MATERIAL if max |per-feature delta| >= 0.10, which
 *        is ~53% of Item 44's label-correction effect (0.186937) — i.e. the bar is
 *        "at least half as consequential as fixing 17 wrong labels". Below 0.10 it
 *        is a FUTURE CONCERN, not an act-now finding. This gate DESCRIBES the
 *        outcome; it does not fail the item either way, and the threshold is fixed
 *        here before the number is seen.
 *  G45-5 POWER HONESTY: per-session resolved-cell counts must be reported, and any
 *        session contributing <5 corpus rows must be named as too thin to reweight
 *        on. If the reweighting leans mainly on such cells, the item must say the
 *        reweighting itself is underpowered regardless of the delta size.
 */

import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

interface EngineModule {
  signalEngine: {
    trainOnOutcomesForTest(outcomes: unknown[]): void;
    getModelWeightForTest(featureKey: string): number | undefined;
    loadPersistedLearningData(): Promise<unknown>;
  };
  __storage: Map<string, string>;
}

const FEATURES = [
  'rsi_weight',
  'atr_weight',
  'sentiment_weight',
  'volume_weight',
  'timeWindow_weight',
  'dxy_weight',
] as const;

/** Export SECTION 2, the CONTAMINATED live vector. Pasted, not recomputed. */
const LIVE_CONTAMINATED = {
  trainedAt: '2026-08-06T07:50:00.730Z',
  corpusSizeAtTraining: 51,
  weights: {
    rsi_weight: -0.95615,
    atr_weight: 0.56488,
    sentiment_weight: -0.142306,
    volume_weight: 0.052717,
    timeWindow_weight: -0.044876,
    dxy_weight: 0.000273,
  } as Record<string, number>,
};

/** Item 44's measured label-correction effect, the benchmark for G45-4. */
const ITEM44_LABEL_EFFECT = 0.186937;

/** Measured per-session capture rates from Item 43(d) (corpus rows / resolved). */
const SESSION_CAPTURE: Record<string, number> = {
  ASIA: 7.5,
  LONDON: 18.9,
  OVERLAP: 13.2,
  NY_LATE: 12.2,
};

/** Session bucketing, identical to Item 43(d) (UTC hour). */
function sessionOf(ts: string): string {
  const h = new Date(ts).getUTCHours();
  if (h >= 22 || h < 7) return 'ASIA';
  if (h < 12) return 'LONDON';
  if (h < 17) return 'OVERLAP';
  return 'NY_LATE';
}

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

/** Loads the REAL signalEngine into a plain-node sandbox (Item 44 pattern). */
async function loadEngine(tag: string): Promise<EngineModule> {
  const dir = path.join(process.cwd(), 'scripts', '__sandbox_item45__');
  const enginePath = path.join(dir, `signalEngine.item45.${tag}.ts`);
  const source = await readFile(path.join(process.cwd(), 'services', 'signalEngine.ts'), 'utf8');

  const prelude = `import type { TradingSignal, SignalType, MarketOutlook, FibonacciLevel, SentimentData, PositionSizing, FeatureConfidence, MacroEvent, FeatureDriftMetric, DailyOHLC, SignalLearningContext } from "../../types/trading.ts";
const sandboxStorage = new Map<string, string>();
const AsyncStorage = {
  async getItem(key: string): Promise<string | null> { return sandboxStorage.get(key) ?? null; },
  async setItem(key: string, value: string): Promise<void> { sandboxStorage.set(key, value); },
  async removeItem(key: string): Promise<void> { sandboxStorage.delete(key); },
};
export const __storage = sandboxStorage;
const trpcClient = {} as any;
const Platform = { OS: "web" as const };
async function appendOutcomeToStore(): Promise<void> {}
async function getAllOutcomesFromStore(): Promise<unknown[]> { return []; }
async function getOutcomeCountFromStore(): Promise<number> { return 0; }
async function pruneOutcomeStoreToCap(): Promise<void> {}
async function migrateLegacyOutcomesIfEmpty(): Promise<number> { return 0; }
async function pushOutcomesToRemote(): Promise<{ upserted: number; queued: number }> { return { upserted: 0, queued: 0 }; }
async function hydrateLearningStoreFromRemote(): Promise<unknown> { return { available: false }; }
function getLearningCorpusStats(): { hydrateUnavailableCount: number } { return { hydrateUnavailableCount: 0 }; }
type StoredTradeOutcome = any;
async function appendDiagnosticEvent(_event: unknown): Promise<void> {}
`;

  const rewritten = source
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/types\/trading["'];?\r?\n/m, '')
    .replace(/^import\s+AsyncStorage\s+from\s+["']@react-native-async-storage\/async-storage["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/lib\/trpc["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/learningStore["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']@\/services\/diagnosticEventStore["'];?\r?\n/m, '')
    .replace(/^import\s+\{[^}]*\}\s+from\s+["']react-native["'];?\r?\n/m, '');

  await mkdir(dir, { recursive: true });
  await writeFile(enginePath, `${prelude}\n${rewritten}`);
  return import(`${pathToFileURL(enginePath).href}?ts=${Date.now()}`) as Promise<EngineModule>;
}

interface Row {
  signal_id: string;
  ts: string;
  direction: string | null;
  result: string;
  entry_price: number;
  exit_price: number;
  pnl: number;
  confidence: number | null;
  realized_r: number | null;
  is_scratch: boolean | null;
  features: unknown;
}

let pass = 0;
let fail = 0;
function gate(label: string, ok: boolean, detail: string): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${label}: ${detail}`);
}

/** Identical to Item 44's converter so the two studies are comparable. */
function toTradeOutcome(r: Row): unknown {
  const f = (r.features ?? {}) as Record<string, unknown>;
  const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  const sent = (f.sentiment ?? {}) as Record<string, unknown>;
  return {
    signalId: r.signal_id,
    entryPrice: Number(r.entry_price),
    exitPrice: Number(r.exit_price),
    result: r.result === 'WIN' ? 'WIN' : 'LOSS',
    pnl: Number(r.pnl),
    confidence: r.confidence === null ? 0.72 : Number(r.confidence),
    timestamp: r.ts,
    direction: r.direction === 'BUY' || r.direction === 'SELL' ? r.direction : undefined,
    realizedR: r.realized_r === null ? undefined : Number(r.realized_r),
    isScratch: r.is_scratch ?? undefined,
    features: {
      rsi: num(f.rsi, 50),
      atr: num(f.atr, 10),
      volumeRatio: num(f.volumeRatio, 1),
      dxyChange: num(f.dxyChange, 0),
      timeWindowFactor: num(f.timeWindowFactor, 1),
      sentiment: {
        score: num(sent.score, 0),
        confidence: num(sent.confidence, 0),
        source: 'corpus',
      },
    },
  };
}

function vectorOf(engine: EngineModule['signalEngine']): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  for (const f of FEATURES) out[f] = engine.getModelWeightForTest(f);
  return out;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL as string;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;
  const sb = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log('='.repeat(80));
  console.log('ITEM 45 — SESSION-CAPTURE SKEW vs THE WEIGHT VECTOR');
  console.log(`run at ${new Date().toISOString()}`);
  console.log('='.repeat(80));

  const { data, error } = await sb
    .from('trade_outcomes_v1')
    .select('signal_id, ts, direction, result, entry_price, exit_price, pnl, confidence, realized_r, is_scratch, features')
    .order('ts', { ascending: true });
  if (error) {
    console.log(`BLOCKER: corpus read failed (${error.message}). STOP.`);
    process.exit(1);
  }
  const rows = (data ?? []) as Row[];

  // ── POWER, before the result ──────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('1. POWER, STATED BEFORE THE RESULT');
  console.log('='.repeat(80));
  const bySession = new Map<string, Row[]>();
  for (const r of rows) {
    const s = sessionOf(r.ts);
    bySession.set(s, [...(bySession.get(s) ?? []), r]);
  }
  console.log(`  corpus rows available            : ${rows.length}`);
  console.log(`  overall population capture rate  : 12.9% (51/396, Item 43d)`);
  console.log('\n  session      corpus rows   measured capture   thin cell (<5 rows)?');
  console.log('  ' + '-'.repeat(66));
  const thinSessions: string[] = [];
  for (const s of ['ASIA', 'LONDON', 'OVERLAP', 'NY_LATE']) {
    const n = (bySession.get(s) ?? []).length;
    const thin = n < 5;
    if (thin) thinSessions.push(s);
    console.log(`  ${s.padEnd(12)}${String(n).padStart(11)}${(SESSION_CAPTURE[s].toFixed(1) + '%').padStart(19)}   ${thin ? 'YES — too thin to reweight on' : 'no'}`);
  }
  console.log('\n  Any per-session weight below is estimated from at most a couple of dozen rows.');
  console.log('  No per-session claim here supports a fine-grained conclusion; the only');
  console.log('  question in scope is whether the AGGREGATE weight vector moves materially.');

  // ── IPW factors ───────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('2. INVERSE-PROPENSITY FACTORS (from measured capture, not chosen by hand)');
  console.log('='.repeat(80));
  const invs: Record<string, number> = {};
  for (const s of Object.keys(SESSION_CAPTURE)) invs[s] = 1 / SESSION_CAPTURE[s];
  const minInv = Math.min(...Object.values(invs));
  const BASE = 4; // integer resolution multiplier, fixed before seeing any result
  const factors: Record<string, number> = {};
  console.log(`\n  raw weight = 1/capture, normalised to the least-captured-corrected session,`);
  console.log(`  then scaled by a fixed integer resolution multiplier of ${BASE} and rounded.\n`);
  console.log('  session      1/capture   normalised   replication factor (integer)');
  console.log('  ' + '-'.repeat(66));
  for (const s of ['ASIA', 'LONDON', 'OVERLAP', 'NY_LATE']) {
    const norm = invs[s] / minInv;
    factors[s] = Math.max(1, Math.round(norm * BASE));
    console.log(`  ${s.padEnd(12)}${invs[s].toFixed(4).padStart(11)}${norm.toFixed(3).padStart(13)}${String(factors[s]).padStart(30)}`);
  }
  const roundingErr = ['ASIA', 'LONDON', 'OVERLAP', 'NY_LATE'].map((s) => {
    const ideal = (invs[s] / minInv) * BASE;
    return Math.abs(factors[s] - ideal) / ideal;
  });
  console.log(`\n  max rounding error introduced by integer replication: ${(Math.max(...roundingErr) * 100).toFixed(1)}%`);

  const baseline = rows.map((r) => toTradeOutcome(r));
  const reweighted: unknown[] = [];
  for (const r of rows) {
    const f = factors[sessionOf(r.ts)];
    for (let i = 0; i < f; i++) reweighted.push(toTradeOutcome(r));
  }
  console.log(`  training rows seen by trainer: baseline ${baseline.length}  vs  reweighted ${reweighted.length}`);
  console.log('  NOTE: the reweighted arm contains NO new information — every row is a real');
  console.log('  corpus row, replicated. Replication changes influence, not evidence.');

  // ── warm-start arms ───────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('3. TWO WARM-START ARMS, IDENTICAL SEED, ONE VARIABLE (session weighting)');
  console.log('='.repeat(80));

  const seedPayload = JSON.stringify({
    weights: FEATURES.map((f) => [f, LIVE_CONTAMINATED.weights[f]]),
    lastTrainingTime: new Date(LIVE_CONTAMINATED.trainedAt).getTime(),
    corpusSizeAtTraining: LIVE_CONTAMINATED.corpusSizeAtTraining,
    hydrateUnavailableAtTraining: 0,
  });

  let seedVerifiedBothArms = true;
  async function warmRun(tag: string, outcomes: unknown[]): Promise<Record<string, number | undefined>> {
    const mod = await loadEngine(tag);
    mod.__storage.set('model_weights_v1', seedPayload);
    await mod.signalEngine.loadPersistedLearningData();
    const seeded = vectorOf(mod.signalEngine);
    const ok = FEATURES.every((f) => Math.abs((seeded[f] ?? NaN) - LIVE_CONTAMINATED.weights[f]) < 1e-9);
    if (!ok) seedVerifiedBothArms = false;
    mod.signalEngine.trainOnOutcomesForTest(outcomes);
    return vectorOf(mod.signalEngine);
  }

  const armBaseline = await warmRun('baseline', baseline);
  const armReweighted = await warmRun('reweighted', reweighted);
  const armReweightedRepeat = await warmRun('reweighted-repeat', reweighted);

  console.log('\n  feature             LIVE (now)     LONDON-WEIGHTED     SESSION-CORRECTED        delta');
  console.log('  ' + '─'.repeat(96));
  for (const f of FEATURES) {
    const live = LIVE_CONTAMINATED.weights[f];
    const b = armBaseline[f] ?? NaN;
    const w = armReweighted[f] ?? NaN;
    const d = w - b;
    console.log(
      `  ${f.padEnd(20)}${live.toFixed(6).padStart(13)}${b.toFixed(6).padStart(20)}${w.toFixed(6).padStart(21)}` +
        `${((d >= 0 ? '+' : '') + d.toFixed(6)).padStart(14)}`,
    );
  }

  const deltas = FEATURES.map((f) => ({ f, d: Math.abs((armReweighted[f] ?? 0) - (armBaseline[f] ?? 0)) }));
  deltas.sort((a, b) => b.d - a.d);
  const maxDelta = deltas[0].d;
  const deterministic = FEATURES.every(
    (f) => Math.abs((armReweighted[f] ?? NaN) - (armReweightedRepeat[f] ?? NaN)) < 1e-12,
  );
  const allFinite = FEATURES.every(
    (f) => Number.isFinite(armBaseline[f] ?? NaN) && Number.isFinite(armReweighted[f] ?? NaN),
  );
  const signFlips = FEATURES.filter(
    (f) => Math.sign(armReweighted[f] ?? 0) !== Math.sign(armBaseline[f] ?? 0),
  );

  console.log(`\n  largest mover: ${deltas[0].f} (|Δ| ${maxDelta.toFixed(6)})`);
  console.log(`  ranked movers: ${deltas.map((d) => `${d.f.replace('_weight', '')} ${d.d.toFixed(4)}`).join(' > ')}`);
  console.log(`  sign flips vs the London-weighted arm: ${signFlips.length === 0 ? 'none' : signFlips.join(', ')}`);

  console.log('\n' + '='.repeat(80));
  console.log('4. GATES');
  console.log('='.repeat(80));
  gate('G45-1 identical warm-start seed in both arms', seedVerifiedBothArms, 'both arms loaded the live vector as W_historical to < 1e-9');
  gate('G45-2 determinism', deterministic, 'reweighted arm reproduced to < 1e-12 on a second independent run');
  gate('G45-3 valid output', allFinite, 'all 6 features finite in both arms');

  const material = maxDelta >= 0.1;
  gate(
    'G45-4 materiality (descriptive)',
    true,
    `max |Δ| ${maxDelta.toFixed(6)} vs pre-registered 0.10 threshold → ${material ? 'MATERIAL' : 'NOT material'} ` +
      `(${((maxDelta / ITEM44_LABEL_EFFECT) * 100).toFixed(1)}% of Item 44's label effect ${ITEM44_LABEL_EFFECT})`,
  );
  gate(
    'G45-5 power honesty',
    true,
    thinSessions.length === 0
      ? 'no session cell below 5 corpus rows'
      : `thin cells named: ${thinSessions.join(', ')} — reweighting leans on cells too small to trust`,
  );

  console.log('\n' + '='.repeat(80));
  console.log('5. VERDICT — ACT NOW, OR FUTURE CONCERN?');
  console.log('='.repeat(80));
  console.log(`  max per-feature move from correcting the 2.50x session skew: ${maxDelta.toFixed(6)}`);
  console.log(`  benchmark, Item 44 label correction on the same harness      : ${ITEM44_LABEL_EFFECT}`);
  console.log(`  ratio: ${((maxDelta / ITEM44_LABEL_EFFECT) * 100).toFixed(1)}%`);
  console.log('');
  if (material) {
    console.log('  => MATERIAL by the pre-registered threshold. Session-capture bias moves the');
    console.log('     vector comparably to fixing 17 wrong labels, so a retrain on the');
    console.log('     uncorrected corpus embeds a London-shaped model.');
  } else {
    console.log('  => NOT MATERIAL by the pre-registered threshold. Correcting the session skew');
    console.log('     barely moves the vector, so reweighting is NOT the lever.');
  }
  console.log('');
  console.log('  THE BINDING CONSTRAINT IS SAMPLE SIZE, NOT WEIGHTING. Overall capture is');
  console.log('  12.9% (51/396). Reweighting redistributes influence inside 51 rows; it adds');
  console.log('  no information. Per rule 6, a capture-rate/session correlation measured in');
  console.log('  observational data is not a lever to pull.');
  console.log('');
  console.log('  THE REAL FIX IS RAISING CAPTURE. A row exists only if a client happened to be');
  console.log('  running at resolution time (Item 43d condition 3) — the corpus is sampled by');
  console.log('  device uptime, which has nothing to do with trade quality. Making resolution');
  console.log('  durable server-side would take capture toward ~100% and grow the corpus ~8x');
  console.log('  on data ALREADY in gold_m1_bars, which is a real information gain rather than');
  console.log('  a reweighting of the same thin sample.');
  console.log('');
  console.log('  FORWARD EVIDENCE THAT SETTLES IT (rule 8): a server-side resolver replaying');
  console.log('  gold_m1_bars against emitted signals should reproduce all 51 existing durable');
  console.log('  labels (Item 43e already showed canonical re-derivation agrees 51/51) and then');
  console.log('  add the ~345 uncaptured ones. That is a build, and it is NOT in this scope.');

  console.log('\n' + '='.repeat(80));
  console.log(
    fail === 0
      ? `ITEM 45: ALL ${pass} GATES PASS — verdict above, nothing shipped (read-only study)`
      : `ITEM 45: ${fail} GATE FAILURE(S) — ${pass} passed. Comparison not trustworthy; no verdict claimed.`,
  );
  console.log('='.repeat(80));
}

main().catch((e: unknown) => {
  console.error('FATAL', e);
  process.exit(1);
});
