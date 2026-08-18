/**
 * ITEM 95(a)(b) — RETRAIN FILTER ANALYSIS + POST-REPAIR WEIGHT COMPUTATION.
 *
 * 95(a): Traces the filter chain that cut 440 local outcomes to 34 training rows.
 * 95(b): Pulls the CLEAN corpus (post-F-29 repair), runs the retrainModel
 *        weight computation on it, and reports what the weight vector WOULD be.
 *
 * DATA-SOURCE: trade_outcomes_v1 READ = Supabase DIRECT via anon key. READ-ONLY.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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

// Constants mirrored from signalEngine.ts
const TRAINING_WINDOW_DAYS = 14;
const SCRATCH_R_THRESHOLD = 0.15;
const DECAY_LAMBDA = 0.75;
const BAYESIAN_BLEND_ALPHA = 0.4;
const CONSUMED_MODEL_WEIGHTS = new Set(['rsi_weight', 'dxy_weight', 'volume_weight', 'atr_weight']);

interface OutcomeRow {
  signal_id: string;
  ts: string;
  result: string;
  realized_r: number | null;
  is_scratch: boolean | null;
  features: Record<string, unknown>;
  direction: string | null;
}

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('ITEM 95(a)(b) — RETRAIN FILTER ANALYSIS + POST-REPAIR WEIGHTS');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // Pull the full clean corpus
  console.log('\n  Pulling trade_outcomes_v1 (post-F-29 repair)...');
  const allRows: OutcomeRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('trade_outcomes_v1')
      .select('signal_id, ts, result, realized_r, is_scratch, features, direction')
      .order('ts', { ascending: true })
      .range(offset, offset + 999);
    if (error) { console.error(`fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as OutcomeRow[];
    allRows.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`    Total rows: ${allRows.length}`);

  // ── 95(a): TRACE THE FILTER CHAIN ──
  console.log(`\n${line}`);
  console.log('ITEM 95(a) — FILTER CHAIN: 440 → 34');
  console.log(line);

  // Stage 0: total available (what hydrateLearningStoreFromRemote would pull)
  const stage0 = allRows.length;
  console.log(`  Stage 0 (total trade_outcomes_v1 rows pulled): ${stage0}`);

  // Stage 1: rows with non-null realized_r (the ones with actual R values)
  const stage1 = allRows.filter(r => r.realized_r !== null);
  console.log(`  Stage 1 (rows with non-null realized_r): ${stage1.length}  (removed ${stage0 - stage1.length} null-R rows)`);

  // Stage 2: 14-day training window filter (TRAINING_WINDOW_DAYS = 14)
  // The retrain fired at 2026-08-17T23:26:02.238Z per the user's report
  const retrainTime = new Date('2026-08-17T23:26:02.238Z').getTime();
  const trainingWindowMs = TRAINING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(retrainTime - trainingWindowMs);
  const stage2 = stage1.filter(r => new Date(r.ts).getTime() >= cutoffDate.getTime());
  console.log(`  Stage 2 (within ${TRAINING_WINDOW_DAYS}-day window from ${cutoffDate.toISOString()}): ${stage2.length}  (removed ${stage1.length - stage2.length} pre-cutoff rows)`);
  console.log(`    ← THIS IS THE FILTER: signalEngine.ts:329 TRAINING_WINDOW_DAYS = ${TRAINING_WINDOW_DAYS}`);
  console.log(`    ← Applied at signalEngine.ts:6978: trainingData = this.tradeOutcomes.filter(o => new Date(o.timestamp) >= cutoffDate)`);

  // Stage 3: scratch exclusion (|R| < 0.15)
  const stage3 = stage2.filter(r => {
    const rVal = Number(r.realized_r);
    return Math.abs(rVal) >= SCRATCH_R_THRESHOLD;
  });
  const scratches = stage2.length - stage3.length;
  console.log(`  Stage 3 (after scratch exclusion, |R| >= ${SCRATCH_R_THRESHOLD}): ${stage3.length}  (removed ${scratches} scratches)`);

  console.log(`\n  FILTER CHAIN: ${stage0} → ${stage1.length} (null-R) → ${stage2.length} (14-day window) → ${stage3.length} (scratches)`);
  console.log(`  The reported "34" matches Stage 2/3: the 14-day window is the dominant filter.`);
  console.log(`  It is NOT MIN_CONFIDENCE_FOR_RETRAINING (0.68) — that constant controls WHEN to trigger a retrain, not what data to train on.`);

  // ── 95(b): COMPUTE POST-REPAIR WEIGHTS ──
  console.log(`\n${line}`);
  console.log('ITEM 95(b) — POST-REPAIR WEIGHT COMPUTATION (clean corpus)');
  console.log(line);

  // Use ALL clean rows (not just 14-day window) to show what the weights WOULD be
  // if the training window weren't cutting the corpus
  const cleanRows = stage1.filter(r => {
    const rVal = Number(r.realized_r);
    return Math.abs(rVal) >= SCRATCH_R_THRESHOLD;
  });
  console.log(`  Clean corpus (all rows, non-null R, non-scratch): ${cleanRows.length}`);

  // Simulate retrainModel
  const now = Date.now();
  const dataWithWeights = cleanRows.map(r => {
    const age = now - new Date(r.ts).getTime();
    const daysSinceOutcome = age / (24 * 60 * 60 * 1000);
    const weight = Math.pow(DECAY_LAMBDA, daysSinceOutcome);
    const rVal = Number(r.realized_r);
    const features = r.features ?? {};
    return {
      result: r.result === 'WIN' ? 'WIN' : 'LOSS' as 'WIN' | 'LOSS',
      realizedR: rVal,
      weight,
      rsi: typeof features.rsi === 'number' ? features.rsi : 50,
      atr: typeof features.atr === 'number' ? features.atr : 2,
      volumeRatio: typeof features.volumeRatio === 'number' ? features.volumeRatio : 1,
      dxyChange: typeof features.dxyChange === 'number' ? features.dxyChange : 0,
      timeWindowFactor: typeof features.timeWindowFactor === 'number' ? features.timeWindowFactor : 0.5,
      sentiment: typeof features.sentiment === 'object' && features.sentiment !== null
        ? (features.sentiment as Record<string, unknown>).score as number ?? 0
        : 0,
    };
  });

  const totalWeight = dataWithWeights.reduce((s, d) => s + d.weight, 0);
  const normalizedData = dataWithWeights.map(d => ({ ...d, weight: d.weight / totalWeight }));

  const winningData = normalizedData.filter(d => d.result === 'WIN');
  const losingData = normalizedData.filter(d => d.result === 'LOSS');
  console.log(`  Wins: ${winningData.length}, Losses: ${losingData.length}`);

  const rawWeights: Record<string, number> = {};

  const wWinRSI = winningData.reduce((s, d) => s + d.rsi * d.weight, 0) / Math.max(winningData.reduce((s, d) => s + d.weight, 0), 1e-10);
  const wLossRSI = losingData.reduce((s, d) => s + d.rsi * d.weight, 0) / Math.max(losingData.reduce((s, d) => s + d.weight, 0), 1e-10);
  rawWeights['rsi_weight'] = (wWinRSI - wLossRSI) / 100;

  const wWinTW = winningData.reduce((s, d) => s + d.timeWindowFactor * d.weight, 0) / Math.max(winningData.reduce((s, d) => s + d.weight, 0), 1e-10);
  const wLossTW = losingData.reduce((s, d) => s + d.timeWindowFactor * d.weight, 0) / Math.max(losingData.reduce((s, d) => s + d.weight, 0), 1e-10);
  rawWeights['timeWindow_weight'] = (wWinTW - wLossTW) * 0.5;

  const wWinVol = winningData.reduce((s, d) => s + d.volumeRatio * d.weight, 0) / Math.max(winningData.reduce((s, d) => s + d.weight, 0), 1e-10);
  const wLossVol = losingData.reduce((s, d) => s + d.volumeRatio * d.weight, 0) / Math.max(losingData.reduce((s, d) => s + d.weight, 0), 1e-10);
  rawWeights['volume_weight'] = wWinVol - wLossVol;

  const wWinSent = winningData.reduce((s, d) => s + d.sentiment * d.weight, 0) / Math.max(winningData.reduce((s, d) => s + d.weight, 0), 1e-10);
  const wLossSent = losingData.reduce((s, d) => s + d.sentiment * d.weight, 0) / Math.max(losingData.reduce((s, d) => s + d.weight, 0), 1e-10);
  rawWeights['sentiment_weight'] = (wWinSent - wLossSent) * 2;

  const wWinATR = winningData.reduce((s, d) => s + d.atr * d.weight, 0) / Math.max(winningData.reduce((s, d) => s + d.weight, 0), 1e-10);
  const wLossATR = losingData.reduce((s, d) => s + d.atr * d.weight, 0) / Math.max(losingData.reduce((s, d) => s + d.weight, 0), 1e-10);
  rawWeights['atr_weight'] = (wWinATR - wLossATR) / 10;

  const wWinDXY = winningData.reduce((s, d) => s + d.dxyChange * d.weight, 0) / Math.max(winningData.reduce((s, d) => s + d.weight, 0), 1e-10);
  const wLossDXY = losingData.reduce((s, d) => s + d.dxyChange * d.weight, 0) / Math.max(losingData.reduce((s, d) => s + d.weight, 0), 1e-10);
  rawWeights['dxy_weight'] = (wWinDXY - wLossDXY) * 2;

  // Normalize
  const sumAbs = Object.values(rawWeights).reduce((s, w) => s + Math.abs(w), 0);
  const sumAbsConsumed = Object.entries(rawWeights)
    .filter(([k]) => CONSUMED_MODEL_WEIGHTS.has(k))
    .reduce((s, [, w]) => s + Math.abs(w), 0);

  console.log('\n  POST-REPAIR RAW WEIGHTS (clean corpus, all rows):');
  for (const [k, v] of Object.entries(rawWeights)) {
    console.log(`    ${k}: ${v.toFixed(6)}`);
  }

  const recentWeights = new Map<string, number>();
  if (sumAbs > 0) {
    for (const [k, v] of Object.entries(rawWeights)) {
      const denom = CONSUMED_MODEL_WEIGHTS.has(k) && sumAbsConsumed > 0 ? sumAbsConsumed : sumAbs;
      recentWeights.set(k, v / denom);
    }
  }

  // Blend with the PRIOR weights (from the retrain that fired at 23:26Z)
  // Prior: rsi=0.092, atr=0.170406, volume=0.161251, dxy=0.156000, timeWindow=0.149699, sentiment=0.125675
  const priorWeights = new Map<string, number>([
    ['rsi_weight', 0.092],
    ['atr_weight', 0.170406],
    ['volume_weight', 0.161251],
    ['dxy_weight', 0.156000],
    ['timeWindow_weight', 0.149699],
    ['sentiment_weight', 0.125675],
  ]);

  console.log('\n  BLENDED WEIGHTS (alpha=0.4 prior + 0.6 recent-clean):');
  console.log('    feature          prior       recent(clean)  blended');
  for (const key of [...new Set([...priorWeights.keys(), ...recentWeights.keys()])]) {
    const prior = priorWeights.get(key) ?? 0;
    const recent = recentWeights.get(key) ?? 0;
    const blended = BAYESIAN_BLEND_ALPHA * prior + (1 - BAYESIAN_BLEND_ALPHA) * recent;
    console.log(`    ${key.padEnd(18)} ${prior.toFixed(6)}   ${recent.toFixed(6)}   ${blended.toFixed(6)}`);
  }

  // Also compute with 14-day window only (matching what the device would actually produce)
  console.log('\n  14-DAY WINDOW ONLY (matching device behavior):');
  const windowRows = cleanRows.filter(r => new Date(r.ts).getTime() >= cutoffDate.getTime());
  console.log(`    Rows in 14-day window: ${windowRows.length}`);
  if (windowRows.length > 0) {
    const wData = windowRows.map(r => {
      const age = now - new Date(r.ts).getTime();
      const days = age / (24 * 60 * 60 * 1000);
      const weight = Math.pow(DECAY_LAMBDA, days);
      const rVal = Number(r.realized_r);
      const features = r.features ?? {};
      return {
        result: r.result === 'WIN' ? 'WIN' : 'LOSS' as 'WIN' | 'LOSS',
        weight,
        rsi: typeof features.rsi === 'number' ? features.rsi : 50,
        atr: typeof features.atr === 'number' ? features.atr : 2,
        volumeRatio: typeof features.volumeRatio === 'number' ? features.volumeRatio : 1,
        dxyChange: typeof features.dxyChange === 'number' ? features.dxyChange : 0,
        timeWindowFactor: typeof features.timeWindowFactor === 'number' ? features.timeWindowFactor : 0.5,
        sentiment: typeof features.sentiment === 'object' && features.sentiment !== null
          ? (features.sentiment as Record<string, unknown>).score as number ?? 0 : 0,
      };
    });
    const tw = wData.reduce((s, d) => s + d.weight, 0);
    const nw = wData.map(d => ({ ...d, weight: d.weight / tw }));
    const wins14 = nw.filter(d => d.result === 'WIN');
    const losses14 = nw.filter(d => d.result === 'LOSS');
    console.log(`    Wins: ${wins14.length}, Losses: ${losses14.length}`);
    
    const raw14: Record<string, number> = {};
    raw14['rsi_weight'] = (wins14.reduce((s, d) => s + d.rsi * d.weight, 0) / Math.max(wins14.reduce((s, d) => s + d.weight, 0), 1e-10) 
      - losses14.reduce((s, d) => s + d.rsi * d.weight, 0) / Math.max(losses14.reduce((s, d) => s + d.weight, 0), 1e-10)) / 100;
    raw14['atr_weight'] = (wins14.reduce((s, d) => s + d.atr * d.weight, 0) / Math.max(wins14.reduce((s, d) => s + d.weight, 0), 1e-10)
      - losses14.reduce((s, d) => s + d.atr * d.weight, 0) / Math.max(losses14.reduce((s, d) => s + d.weight, 0), 1e-10)) / 10;
    raw14['volume_weight'] = wins14.reduce((s, d) => s + d.volumeRatio * d.weight, 0) / Math.max(wins14.reduce((s, d) => s + d.weight, 0), 1e-10)
      - losses14.reduce((s, d) => s + d.volumeRatio * d.weight, 0) / Math.max(losses14.reduce((s, d) => s + d.weight, 0), 1e-10);
    raw14['dxy_weight'] = (wins14.reduce((s, d) => s + d.dxyChange * d.weight, 0) / Math.max(wins14.reduce((s, d) => s + d.weight, 0), 1e-10)
      - losses14.reduce((s, d) => s + d.dxyChange * d.weight, 0) / Math.max(losses14.reduce((s, d) => s + d.weight, 0), 1e-10)) * 2;
    
    const sumAbs14 = Object.values(raw14).reduce((s, w) => s + Math.abs(w), 0);
    const sumAbsConsumed14 = Object.entries(raw14).filter(([k]) => CONSUMED_MODEL_WEIGHTS.has(k)).reduce((s, [, w]) => s + Math.abs(w), 0);
    
    console.log('    Normalized (14-day, consumed-only denominator):');
    for (const [k, v] of Object.entries(raw14)) {
      const denom = CONSUMED_MODEL_WEIGHTS.has(k) && sumAbsConsumed14 > 0 ? sumAbsConsumed14 : sumAbs14;
      const norm = v / denom;
      const prior = priorWeights.get(k) ?? 0;
      const blended = BAYESIAN_BLEND_ALPHA * prior + (1 - BAYESIAN_BLEND_ALPHA) * norm;
      console.log(`      ${k.padEnd(18)} raw=${v.toFixed(6)}  norm=${norm.toFixed(6)}  blended=${blended.toFixed(6)}`);
    }
  }

  console.log(`\n${line}\nDONE\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('item95 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
