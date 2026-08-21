/**
 * ITEM 179(d)/(e) — FEATURES-ONLY BACKFILL, EXECUTED ONCE against the live
 * corpus. Mirrors the resolver's backfillEmptyFeatures() pass EXACTLY (same
 * reconstruction math, same gate) so the run is evidence of what the
 * redeployed resolver will do on its own cron.
 *
 * GATE (pre-registered, identical to the resolver):
 *   1. Only rows whose features column is EXACTLY '{}' — enforced by Postgres
 *      atomically at UPDATE time via .eq('features', {}).
 *   2. Only features + feature_schema_version columns are written. result,
 *      realized_r, exit_price, pnl, ts, direction — every outcome field — is
 *      immutable here (F-29's sin was rewriting labels; this cannot reach one).
 *   3. Reconstructed features carry provenance: sentiment.source =
 *      'resolver-bar-reconstruction'.
 *   4. Rows with insufficient pre-emission bars are counted and left untouched.
 *
 * DATA-SOURCE RULE: emitted_signals_v1 + gold_m1_bars + trade_outcomes_v1
 * READS = anon key. trade_outcomes_v1 UPDATE (the repair) = service-role key
 * (item94_backfill_f29 precedent — RLS permits anon INSERT only, never UPDATE).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

function loadEnv() {
  const env = readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)=(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const URL_ = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
const svc = SERVICE
  ? createClient(URL_, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

interface Bar { timestamp: number; high: number; low: number; close: number }

async function fetchBars(fromMs: number, toMs: number): Promise<Bar[]> {
  const out: Bar[] = [];
  let offset = 0;
  for (let page = 0; page < 50; page++) {
    const { data, error } = await anon
      .from('gold_m1_bars')
      .select('timestamp, high, low, close')
      .gte('timestamp', new Date(fromMs).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`gold_m1_bars read failed: ${error.message}`);
    const batch = (data ?? []) as Array<{ timestamp: string; high: number; low: number; close: number }>;
    for (const r of batch) {
      out.push({ timestamp: new Date(r.timestamp).getTime(), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    }
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return out;
}

/** Verbatim mirror of the resolver's computeLearningFeatures(). */
async function computeLearningFeatures(emittedMs: number): Promise<Record<string, unknown> | null> {
  try {
    const bars = await fetchBars(emittedMs - 60 * 60_000, emittedMs - 1_000);
    if (bars.length < 15) return null;
    const closes = bars.map((b) => b.close);
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= 14; i += 1) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) avgGain += d;
      else avgLoss -= d;
    }
    avgGain /= 14;
    avgLoss /= 14;
    for (let i = 15; i < closes.length; i += 1) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * 13 + Math.max(d, 0)) / 14;
      avgLoss = (avgLoss * 13 + Math.max(-d, 0)) / 14;
    }
    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    let trSum = 0;
    let trN = 0;
    for (let i = 1; i < bars.length; i += 1) {
      const prevClose = bars[i - 1].close;
      trSum += Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - prevClose),
        Math.abs(bars[i].low - prevClose),
      );
      trN += 1;
    }
    const atr = trN > 0 ? trSum / trN : null;
    if (!Number.isFinite(rsi) || atr === null || !Number.isFinite(atr)) return null;
    return {
      rsi: Number(rsi.toFixed(2)),
      atr: Number(atr.toFixed(2)),
      volumeRatio: 1,
      timeWindowFactor: 1,
      dxyChange: 0,
      sentiment: { score: 0, confidence: 0, source: 'resolver-bar-reconstruction' },
      schemaVersion: 1,
    };
  } catch {
    return null;
  }
}

async function main() {
  if (!svc) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set — cannot run the backfill UPDATE (anon has INSERT only).');
    process.exit(1);
  }

  const { data: emittedRaw } = await anon
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at')
    .order('emitted_at', { ascending: true });
  const emittedById = new Map(((emittedRaw ?? []) as Array<{ signal_id: string; emitted_at: string }>).map((r) => [r.signal_id, r.emitted_at]));
  console.log(`emitted signals: ${emittedById.size}`);

  const { data: before } = await anon.from('trade_outcomes_v1').select('signal_id, features');
  const beforeRows = (before ?? []) as Array<{ signal_id: string; features: Record<string, unknown> | null }>;
  const populatedBefore = beforeRows.filter((r) => r.features !== null && Object.keys(r.features).length > 0).length;
  console.log(`BEFORE: total=${beforeRows.length} populated=${populatedBefore} (${((populatedBefore / beforeRows.length) * 100).toFixed(1)}%) empty=${beforeRows.length - populatedBefore}`);

  const { data: emptyRaw, error: emptyErr } = await anon
    .from('trade_outcomes_v1')
    .select('signal_id, ts')
    .eq('features', '{}')
    .order('ts', { ascending: true });
  if (emptyErr) throw new Error(`empty-features read failed: ${emptyErr.message}`);
  const targets = (emptyRaw ?? []) as Array<{ signal_id: string; ts: string }>;
  console.log(`empty-features rows selected: ${targets.length}`);

  let backfilled = 0;
  let noEmission = 0;
  let noBars = 0;
  let failed = 0;
  let i = 0;
  for (const row of targets) {
    i += 1;
    if (i % 40 === 0) console.log(`  ...${i}/${targets.length} (backfilled=${backfilled} noEmission=${noEmission} noBars=${noBars} failed=${failed})`);
    const emittedAt = emittedById.get(row.signal_id);
    if (!emittedAt) {
      noEmission += 1;
      continue;
    }
    const features = await computeLearningFeatures(Date.parse(emittedAt));
    if (features === null) {
      noBars += 1;
      continue;
    }
    const { error: updateError } = await svc
      .from('trade_outcomes_v1')
      .update({ features, feature_schema_version: 1 })
      .eq('signal_id', row.signal_id)
      .eq('features', '{}');
    if (updateError) {
      failed += 1;
      console.warn(`  UPDATE failed ${row.signal_id}: ${updateError.message}`);
      continue;
    }
    backfilled += 1;
  }

  const { data: after } = await anon.from('trade_outcomes_v1').select('signal_id, features');
  const afterRows = (after ?? []) as Array<{ signal_id: string; features: Record<string, unknown> | null }>;
  const populatedAfter = afterRows.filter((r) => r.features !== null && Object.keys(r.features).length > 0).length;
  console.log(`\nRESULTS: examined=${targets.length} backfilled=${backfilled} noEmission=${noEmission} noBars=${noBars} failed=${failed}`);
  console.log(`AFTER: total=${afterRows.length} populated=${populatedAfter} (${((populatedAfter / afterRows.length) * 100).toFixed(1)}%) empty=${afterRows.length - populatedAfter}`);

  // Label-integrity spot check: the UPDATE must not have touched any outcome field.
  const { data: sample } = await anon
    .from('trade_outcomes_v1')
    .select('signal_id, result, realized_r, exit_price, pnl, features')
    .eq('features->sentiment->>source', 'resolver-bar-reconstruction')
    .order('ts', { ascending: false })
    .limit(3);
  console.log('sample repaired rows (outcome fields must be pre-existing values, only features changed):');
  for (const r of (sample ?? []) as Array<Record<string, unknown>>) {
    console.log(`  ${String(r.signal_id).slice(-8)} result=${r.result} realized_r=${r.realized_r} exit=${r.exit_price} features.rsi=${(r.features as Record<string, unknown>)?.rsi}`);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
