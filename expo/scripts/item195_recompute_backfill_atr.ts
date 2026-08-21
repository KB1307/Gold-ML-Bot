/**
 * ITEM 195(d) — RECOMPUTE THE WRONG-CONSTRUCT ATR ON BACKFILLED ROWS.
 *
 * The 179(d) backfill (285 rows, provenance sentiment.source =
 * 'resolver-bar-reconstruction') and any app-path reconstructed rows
 * (featuresSource = 'app-bar-reconstruction') wrote `atr` as a MEAN TRUE RANGE
 * over the whole ~59-bar pre-emission window while the construct was labelled
 * ATR-14 — the F-32 collision class (one column, two incompatible constructs:
 * the engine writes its own M5 ATR-14 into the same column). The recompute
 * replaces ONLY the atr value with a genuine Wilder ATR-14 over the last 15 M1
 * bars — the exact construct the fixed resolver now writes — and adds the
 * atrPeriod/atrTimeframe/atrMethod provenance fields so the construct can
 * never again be inferred wrongly.
 *
 * GATE (pre-registered, mirroring 179(d)):
 *   1. ONLY rows whose features carry the reconstruction provenance marker
 *      (features.sentiment.source = 'resolver-bar-reconstruction' OR
 *      features.featuresSource = 'app-bar-reconstruction'). Engine-written
 *      rows (real M5 ATR-14) are never touched.
 *   2. ONLY the features column is written. result, realized_r, exit_price,
 *      pnl, ts, direction — every outcome field — is immutable here.
 *   3. Rows with insufficient pre-emission bars are counted and left untouched.
 *
 * DATA-SOURCE RULE: emitted_signals_v1 + gold_m1_bars + trade_outcomes_v1
 * READS = anon key. trade_outcomes_v1 UPDATE (the repair) = service-role key
 * (item94_backfill_f29 / item179_backfill_features precedent).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

function loadEnv(): void {
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
interface OutcomeRow { signal_id: string; features: Record<string, unknown> | null }

async function fetchBars(fromMs: number, toMs: number): Promise<Bar[]> {
  const out: Bar[] = [];
  let offset = 0;
  for (let page = 0; page < 5; page++) {
    const { data, error } = await anon
      .from('gold_m1_bars')
      .select('timestamp, high, low, close')
      .gte('timestamp', new Date(fromMs).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`gold_m1_bars read failed: ${error.message}`);
    const batch = (data ?? []) as Array<{ timestamp: string; high: number; low: number; close: number }>;
    for (const r of batch) out.push({ timestamp: new Date(r.timestamp).getTime(), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return out;
}

/** Exact mirror of the fixed resolver construct: Wilder ATR-14 over the last 15 bars. */
function wilderAtr14(bars: Bar[]): number | null {
  const w = bars.slice(-15);
  const trs: number[] = [];
  for (let i = 1; i < w.length; i++) {
    const prevClose = w[i - 1].close;
    trs.push(Math.max(w[i].high - w[i].low, Math.abs(w[i].high - prevClose), Math.abs(w[i].low - prevClose)));
  }
  if (trs.length < 14) return null;
  let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
  return atr;
}

async function fetchAll<T>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 60; page++) {
    const { data, error } = await anon.from(table).select(select).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

function stats(vals: number[]): string {
  if (vals.length === 0) return 'n=0';
  const s = [...vals].sort((a, b) => a - b);
  return `n=${vals.length} mean=${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)} median=${s[Math.floor(s.length / 2)].toFixed(3)} min=${s[0].toFixed(3)} max=${s[s.length - 1].toFixed(3)}`;
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('ITEM 195(d) ATR RECOMPUTE — ' + new Date().toISOString());
  if (!svc) {
    console.log('NO SERVICE KEY — reporting only, no updates.');
  }

  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, features');
  const emitted = await fetchAll<{ signal_id: string; emitted_at: string }>('emitted_signals_v1', 'signal_id, emitted_at');
  const emittedAt = new Map(emitted.map(e => [e.signal_id, e.emitted_at] as const));

  const targets = outcomes.filter(o => {
    const f = o.features;
    if (!f || typeof f !== 'object') return false;
    const sent = f.sentiment as Record<string, unknown> | undefined;
    const src = sent?.source;
    return src === 'resolver-bar-reconstruction' || f.featuresSource === 'app-bar-reconstruction';
  });
  console.log(`total outcomes: ${outcomes.length}; reconstruction-provenance rows: ${targets.length}`);

  const beforeAtrs: number[] = [];
  const afterAtrs: number[] = [];
  const deltas: number[] = [];
  let updated = 0;
  let noEmission = 0;
  let noBars = 0;
  let failed = 0;
  const samples: string[] = [];

  for (const row of targets) {
    const iso = emittedAt.get(row.signal_id);
    if (!iso) { noEmission++; continue; }
    const emittedMs = new Date(iso).getTime();
    const bars = await fetchBars(emittedMs - 60 * 60_000, emittedMs - 1_000);
    const atrNew = wilderAtr14(bars);
    if (atrNew === null) { noBars++; continue; }
    const oldFeatures = row.features as Record<string, unknown>;
    const atrOld = typeof oldFeatures.atr === 'number' ? oldFeatures.atr : Number.NaN;
    if (!Number.isFinite(atrOld)) { noBars++; continue; }
    beforeAtrs.push(atrOld);
    afterAtrs.push(atrNew);
    deltas.push(atrNew - atrOld);
    if (samples.length < 5) samples.push(`${row.signal_id.slice(-8)}: ${atrOld.toFixed(2)} -> ${atrNew.toFixed(2)}`);

    if (!svc) continue;
    const newFeatures = {
      ...oldFeatures,
      atr: Number(atrNew.toFixed(2)),
      atrPeriod: 14,
      atrTimeframe: 'M1',
      atrMethod: 'wilder',
    };
    // GATE: only the features column is written; the update is keyed on
    // signal_id. Outcome fields (result, realized_r, exit_price, pnl, ts,
    // direction) are never in the payload.
    const { error } = await svc
      .from('trade_outcomes_v1')
      .update({ features: newFeatures })
      .eq('signal_id', row.signal_id);
    if (error) {
      failed++;
      console.warn(`  UPDATE failed for ${row.signal_id}: ${error.message}`);
    } else {
      updated++;
    }
  }

  console.log(`\nupdated=${updated} (of ${targets.length} targets)  noEmission=${noEmission} noBars/insufficient=${noBars} failed=${failed}`);
  console.log(`\nOLD construct (mean TR over ~59 bars, labelled ATR-14): ${stats(beforeAtrs)}`);
  console.log(`NEW construct (Wilder ATR-14, last 15 M1 bars):        ${stats(afterAtrs)}`);
  const absDeltas = deltas.map(Math.abs);
  console.log(`delta (new - old): ${stats(deltas)}; |delta|: ${stats(absDeltas)}`);
  console.log(`\nspot-check (outcome fields untouched — only features.atr + provenance written):`);
  for (const s of samples) console.log(`  ${s}`);

  // Post-verify: count rows now carrying the provenance fields.
  const { data: after } = await anon.from('trade_outcomes_v1').select('signal_id, features').limit(1000);
  let withProvenance = 0;
  let stillMarkedNoProvenance = 0;
  for (const r of (after ?? []) as OutcomeRow[]) {
    const f = r.features;
    if (!f || typeof f !== 'object') continue;
    const sent = f.sentiment as Record<string, unknown> | undefined;
    const marked = sent?.source === 'resolver-bar-reconstruction' || f.featuresSource === 'app-bar-reconstruction';
    if (!marked) continue;
    if (f.atrMethod === 'wilder') withProvenance++;
    else stillMarkedNoProvenance++;
  }
  console.log(`\npost-verify (first 1000 rows): provenance-marked rows with atrMethod=wilder: ${withProvenance}; marked rows still without provenance fields: ${stillMarkedNoProvenance}`);
}

main().catch(err => { console.error('FAILED:', err instanceof Error ? err.message : String(err)); process.exit(1); });
