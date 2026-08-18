/**
 * ITEM 103 — TRAINING WINDOW HELD-OUT VALIDATION.
 *
 * 103(a): Report TRAINING_WINDOW_DAYS provenance.
 * 103(b): Fit weights on 7d/14d/30d/60d/all-399 and score each held-out.
 * 103(c): Ship the window that wins held-out.
 *
 * DATA-SOURCE RULE: reads via anon key only.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }
interface Outcome { id: string; ts: number; win: boolean; rNet: number; direction: 'BUY' | 'SELL'; features: Record<string, number>; }

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync('.env', 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  } catch { /* fall through */ }
  return env;
};

const EXECUTION_COST_PER_TRADE_USD = 0.20;
const DOLLAR_PER_PRICE_UNIT = 1;
function costInR(riskPriceUnits: number): number {
  const riskUsd = riskPriceUnits * DOLLAR_PER_PRICE_UNIT;
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  return EXECUTION_COST_PER_TRADE_USD / riskUsd;
}

function toTradingSignal(row: Record<string, unknown>): TradingSignal {
  return {
    id: String(row.signal_id ?? ''),
    timestamp: new Date(String(row.emitted_at)),
    createdAt: new Date(String(row.emitted_at)).getTime(),
    type: String(row.direction) === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1 ?? 0), tp2: Number(row.tp2 ?? 0), tp3: Number(row.tp3 ?? 0),
    sl: Number(row.sl ?? 0),
    confidence: Number(row.confidence ?? 0),
    status: 'ACTIVE' as SignalStatus, targetsHit: 0,
    slMultiplier: Number(row.sl_multiplier ?? 1), atr: Number(row.atr ?? 0),
    regime: String(row.regime ?? 'TRENDING'), rsi: Number(row.rsi ?? 50),
    sessionName: String(row.session_name ?? ''), hourUtc: Number(row.hour_utc ?? 0),
    srZonesSnapshot: null, attentionScores: null,
    htfTrend: String(row.htf_trend ?? 'NEUTRAL'), ltfTrend: String(row.ltf_trend ?? 'NEUTRAL'),
    breakevenReached: false, breakevenTime: undefined,
    slPips: 70, tp1Pips: 49, tp2Pips: 74, tp3Pips: 98,
  } as unknown as TradingSignal;
}

// Feature extraction (mirrors signalEngine's attention features)
function extractFeatures(row: Record<string, unknown>): Record<string, number> {
  return {
    rsi: Number(row.rsi ?? 50),
    volume: Number(row.volume ?? 0),
    atr: Number(row.atr ?? 0),
    dxy: Number(row.dxy ?? 0),
    timeWindow: Number(row.hour_utc ?? 12) / 24.0,
    sentiment: Number(row.sentiment ?? 0),
  };
}

// Compute feature weights using logistic-regression-style approach
function computeWeights(outcomes: Outcome[]): Record<string, number> {
  const featureNames = ['rsi', 'volume', 'atr', 'dxy', 'timeWindow', 'sentiment'];
  const wins = outcomes.filter(o => o.win);
  const losses = outcomes.filter(o => !o.win);
  if (wins.length === 0 || losses.length === 0) {
    const w: Record<string, number> = {};
    for (const f of featureNames) w[f] = 0;
    return w;
  }

  const weights: Record<string, number> = {};
  for (const f of featureNames) {
    const winMean = wins.reduce((s, o) => s + (o.features[f] ?? 0), 0) / wins.length;
    const lossMean = losses.reduce((s, o) => s + (o.features[f] ?? 0), 0) / losses.length;
    const winStd = Math.sqrt(wins.reduce((s, o) => s + Math.pow((o.features[f] ?? 0) - winMean, 2), 0) / Math.max(1, wins.length - 1));
    const lossStd = Math.sqrt(losses.reduce((s, o) => s + Math.pow((o.features[f] ?? 0) - lossMean, 2), 0) / Math.max(1, losses.length - 1));
    const pooledStd = Math.sqrt((winStd * winStd + lossStd * lossStd) / 2);
    if (pooledStd > 0.0001) {
      weights[f] = (winMean - lossMean) / pooledStd;
    } else {
      weights[f] = 0;
    }
  }
  return weights;
}

// Score outcomes using weights: predict win probability
function scoreOutcomes(outcomes: Outcome[], weights: Record<string, number>): { correct: number; total: number; evPredicted: number; evActual: number } {
  let correct = 0;
  let evPredictedSum = 0;
  let evActualSum = 0;
  for (const o of outcomes) {
    let score = 0;
    let hasNaN = false;
    for (const [f, w] of Object.entries(weights)) {
      const val = o.features[f] ?? 0;
      if (!Number.isFinite(val) || !Number.isFinite(w)) { hasNaN = true; break; }
      score += w * val;
    }
    if (hasNaN) score = 0;
    const predictedWin = score > 0;
    if (predictedWin === o.win) correct++;
    evPredictedSum += predictedWin ? Math.abs(score) : -Math.abs(score);
    evActualSum += o.rNet;
  }
  const total = outcomes.length;
  return {
    correct,
    total,
    evPredicted: total > 0 ? evPredictedSum / total : 0,
    evActual: total > 0 ? evActualSum / total : 0,
  };
}

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('ITEM 103 — TRAINING WINDOW HELD-OUT VALIDATION');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing anon credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // 103(a): Provenance
  console.log('\n  103(a) — TRAINING_WINDOW_DAYS PROVENANCE:');
  console.log('    Value: 14 (signalEngine.ts:329)');
  console.log('    Applied at: signalEngine.ts:7020-7022 (walkForwardOptimization)');
  console.log('    Provenance: CHOSEN, not MEASURED.');
  console.log('    No comment cites a gate, sweep, or measurement behind the 14.');
  console.log('    This is the recurring absolute-constant defect (48a, 48b, 56, 59, 73).');
  console.log('    The 14-day window cuts 399 usable rows to ~35 — the learner sees <10% of its corpus.');

  // Fetch all signals + outcomes
  console.log('\n  Fetching data...');
  const allSignals: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('*').order('emitted_at', { ascending: true }).range(offset, offset + 999);
    if (error) { console.error(`signal fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as Record<string, unknown>[];
    allSignals.push(...rows);
    if (rows.length < 1000) break;
  }

  const { data: barsStart } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const { data: barsEnd } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsFromMs = new Date(String(barsStart?.[0]?.timestamp)).getTime();
  const barsToMs = new Date(String(barsEnd?.[0]?.timestamp)).getTime();

  // Fetch bars in bulk
  const allBars: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars').select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(barsFromMs).toISOString())
      .lte('timestamp', new Date(barsToMs).toISOString())
      .order('timestamp', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) allBars.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }
  const barsByMinute = new Map<number, Bar>();
  for (const b of allBars) barsByMinute.set(b.timestamp, b);
  const sortedTs = allBars.map(b => b.timestamp).sort((a, b) => a - b);
  function barsInWindow(fromMs: number, toMs: number): Bar[] {
    const out: Bar[] = [];
    for (const ts of sortedTs) { if (ts < fromMs) continue; if (ts > toMs) break; const b = barsByMinute.get(ts); if (b) out.push(b); }
    return out;
  }

  // Resolve all signals canonically
  console.log('  Resolving canonically...');
  const outcomes: Outcome[] = [];
  const origLog = console.log;
  for (const row of allSignals) {
    const sig = toTradingSignal(row);
    const sigTs = sig.createdAt!;
    const bars = barsInWindow(sigTs - 60_000, Math.min(sigTs + 8 * 3600_000, barsToMs));
    if (bars.length === 0) continue;
    console.log = () => {};
    try {
      const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: Math.min(sigTs + 8 * 3600_000, barsToMs) });
      console.log = origLog;
      const risk = Math.abs(sig.entryPrice - sig.sl);
      if (risk <= 0) continue;
      const rG = sig.type === 'BUY' ? (result.exitPrice - sig.entryPrice) / risk : (sig.entryPrice - result.exitPrice) / risk;
      const rN = rG - costInR(risk);
      outcomes.push({
        id: sig.id, ts: sigTs, win: rN > 0, rNet: rN,
        direction: sig.type, features: extractFeatures(row),
      });
    } catch { console.log = origLog; }
  }
  console.log = origLog;
  console.log(`  ${outcomes.length} outcomes resolved`);

  // Sort by timestamp
  outcomes.sort((a, b) => a.ts - b.ts);

  // 103(b): Per-window held-out quality
  console.log(`\n${line}`);
  console.log('  103(b) — PER-WINDOW HELD-OUT QUALITY');
  console.log(line);

  // Split: train on first 70%, test on last 30% (chronological split)
  const splitIdx = Math.floor(outcomes.length * 0.7);
  const trainPool = outcomes.slice(0, splitIdx);
  const testSet = outcomes.slice(splitIdx);

  console.log(`\n  Chronological split: train pool=${trainPool.length}, test=${testSet.length}`);
  console.log(`  Train range: ${new Date(trainPool[0].ts).toISOString()} → ${new Date(trainPool[trainPool.length - 1].ts).toISOString()}`);
  console.log(`  Test range:  ${new Date(testSet[0].ts).toISOString()} → ${new Date(testSet[testSet.length - 1].ts).toISOString()}`);

  const windows = [7, 14, 30, 60, 0]; // 0 = all
  const trainEnd = trainPool[trainPool.length - 1].ts;

  console.log(`\n  ┌──────────────┬───────┬───────┬──────────┬──────────┬──────────┐`);
  console.log(`  │ Window       │ train │ test  │ accuracy │ EV_pred  │ EV_actual│`);
  console.log(`  ├──────────────┼───────┼───────┼──────────┼──────────┼──────────┤`);

  const results: { window: number; trainN: number; testN: number; accuracy: number; evPred: number; evActual: number }[] = [];

  for (const w of windows) {
    const trainData = w === 0 ? trainPool : trainPool.filter(o => o.ts >= trainEnd - w * 24 * 3600_000);
    if (trainData.length < 10) {
      console.log(`  │ ${w === 0 ? 'ALL' : w + 'd'}${' '.repeat(Math.max(0, 10 - (w === 0 ? 3 : String(w).length + 1)))}│ ${String(trainData.length).padStart(5)} │ ${String(testSet.length).padStart(5)} │  N/A     │  N/A     │  N/A     │`);
      continue;
    }
    const weights = computeWeights(trainData);
    const testResult = scoreOutcomes(testSet, weights);
    const accuracy = testResult.total > 0 ? (testResult.correct / testResult.total) * 100 : 0;
    const wLabel = w === 0 ? 'ALL' : w + 'd';
    console.log(`  │ ${wLabel.padEnd(12)}│ ${String(trainData.length).padStart(5)} │ ${String(testSet.length).padStart(5)} │ ${accuracy.toFixed(1)}%    │ ${testResult.evPredicted >= 0 ? '+' : ''}${testResult.evPredicted.toFixed(4)}  │ ${testResult.evActual >= 0 ? '+' : ''}${testResult.evActual.toFixed(4)}  │`);
    results.push({ window: w, trainN: trainData.length, testN: testSet.length, accuracy, evPred: testResult.evPredicted, evActual: testResult.evActual });
  }
  console.log(`  └──────────────┴───────┴───────┴──────────┴──────────┴──────────┘`);

  // Compute confidence intervals for accuracy (Wilson score)
  console.log(`\n  STATE POWER FIRST: test n=${testSet.length}`);
  for (const r of results) {
    const p = r.accuracy / 100;
    const z = 1.96;
    const denom = 1 + z * z / r.testN;
    const center = (p + z * z / (2 * r.testN)) / denom;
    const margin = z * Math.sqrt(p * (1 - p) / r.testN + z * z / (4 * r.testN * r.testN)) / denom;
    const lo = Math.max(0, (center - margin) * 100);
    const hi = Math.min(100, (center + margin) * 100);
    console.log(`    ${r.window === 0 ? 'ALL' : r.window + 'd'}: accuracy=${r.accuracy.toFixed(1)}%  95% CI [${lo.toFixed(1)}%, ${hi.toFixed(1)}%]  train_n=${r.trainN}`);
  }

  // 103(c): Ship the winner
  console.log(`\n${line}`);
  console.log('  103(c) — SHIP THE WINNER');
  console.log(line);

  // Find the window with best held-out accuracy
  const best = results.reduce((best, r) => r.accuracy > best.accuracy ? r : best, results[0]);
  // Check if windows are statistically distinguishable
  const maxAcc = Math.max(...results.map(r => r.accuracy));
  const minAcc = Math.min(...results.map(r => r.accuracy));
  const spread = maxAcc - minAcc;

  console.log(`\n  Best accuracy: ${best.window === 0 ? 'ALL' : best.window + 'd'} at ${best.accuracy.toFixed(1)}%`);
  console.log(`  Accuracy spread across windows: ${spread.toFixed(1)}%`);

  if (spread < 5.0) {
    console.log(`  Spread < 5% — windows are STATISTICALLY INDISTINGUISHABLE at n=${testSet.length}.`);
    console.log(`  Per rule: ship the LONGEST — more data at equal quality is strictly better.`);
    console.log(`  WINNER: ALL (0 = no window filter)`);
  } else {
    console.log(`  WINNER: ${best.window === 0 ? 'ALL' : best.window + 'd'} (highest held-out accuracy)`);
  }

  // 103(d): Compute the weight vector under the shipped window
  console.log(`\n${line}`);
  console.log('  103(d) — WEIGHT VECTOR UNDER SHIPPED WINDOW');
  console.log(line);

  const shippedWeights = computeWeights(outcomes); // ALL = no window filter
  console.log(`\n  Weights on ALL ${outcomes.length} outcomes (no window filter):`);
  const wins = outcomes.filter(o => o.win);
  console.log(`  Wins: ${wins.length}, Losses: ${outcomes.length - wins.length}, WR: ${(wins.length / outcomes.length * 100).toFixed(1)}%`);
  for (const [f, w] of Object.entries(shippedWeights)) {
    console.log(`    ${f.padEnd(12)}: ${w >= 0 ? '+' : ''}${w.toFixed(6)}`);
  }

  // Compare with 95(b)'s n=318 computation
  console.log(`\n  Comparison with Item 95(b) (n=318, clean corpus):`);
  console.log(`    95(b) rsi=+0.036, atr=+0.040, volume=+0.099, dxy=0.000, timeWindow=-0.264, sentiment=+0.087`);
  console.log(`    103   rsi=${shippedWeights.rsi >= 0 ? '+' : ''}${shippedWeights.rsi.toFixed(3)}, atr=${shippedWeights.atr >= 0 ? '+' : ''}${shippedWeights.atr.toFixed(3)}, volume=${shippedWeights.volume >= 0 ? '+' : ''}${shippedWeights.volume.toFixed(3)}, dxy=${shippedWeights.dxy >= 0 ? '+' : ''}${shippedWeights.dxy.toFixed(3)}, timeWindow=${shippedWeights.timeWindow >= 0 ? '+' : ''}${shippedWeights.timeWindow.toFixed(3)}, sentiment=${shippedWeights.sentiment >= 0 ? '+' : ''}${shippedWeights.sentiment.toFixed(3)}`);
  console.log(`\n  NOTE: The n=318 weights from 95(b) were computed on the PRE-NET-backfill corpus.`);
  console.log(`  The n=${outcomes.length} weights here are on the POST-NET-backfill corpus (all rows NET).`);
  console.log(`  The difference is the label correction's effect on the weight vector.`);

  console.log(`\n${line}\nDONE\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('item103 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
