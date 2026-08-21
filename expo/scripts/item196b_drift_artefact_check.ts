/**
 * ITEM 196(b) — IS THE HIGH DRIFT SCORE AN ARTEFACT OF THE 179(d) BACKFILL?
 *
 * Item 186 reported drift score 0.6330 (HIGH) driven ENTIRELY by sentiment
 * 0.000 -> 0.164. The 179(d) backfill wrote 285 historical rows with
 * sentiment {score: 0} as a DOCUMENTED DEFAULT (no sentiment feed exists in
 * the resolver). The engine hydrates its in-memory tradeOutcomes from the
 * durable corpus (hydrateLearningStoreFromRemote -> getAllOutcomesFromStore,
 * signalEngine.ts ~:8060-8073), and analyzeFeatureValueDrift() compares the
 * last 20 outcomes vs the previous 20 (WINS only, avg feature value). If the
 * older window is dominated by backfilled rows whose sentiment is 0 BY
 * DESIGN, the 0.000 baseline is an artefact, not a measured regime.
 *
 * This script replicates the drift computation EXACTLY from the live corpus
 * (trade_outcomes_v1 ordered by ts) and reports it twice: with ALL rows, and
 * with the provenance-marked reconstruction rows REMOVED. If the sentiment
 * drift collapses when the backfilled rows are removed, the alert is an
 * artefact and must NOT trigger a retrain.
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
const anon = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

interface Row { signal_id: string; ts: string; result: string; features: Record<string, unknown> | null }

function isReconstruction(f: Record<string, unknown> | null): boolean {
  if (!f || typeof f !== 'object') return false;
  const sent = f.sentiment as Record<string, unknown> | undefined;
  return sent?.source === 'resolver-bar-reconstruction' || f.featuresSource === 'app-bar-reconstruction';
}

function featureVal(f: Record<string, unknown>, name: string): number {
  if (name === 'sentiment') return Number((f.sentiment as Record<string, unknown> | undefined)?.score ?? 0);
  return Number(f[name] ?? 0);
}

/** Exact replica of analyzeFeatureValueDrift's computation (signalEngine.ts:5739-5784). */
function computeDrift(rows: Row[]): { feature: string; recentAvg: number; olderAvg: number; drift: number }[] {
  const recent = rows.slice(-20);
  const older = rows.slice(-40, -20);
  const out: { feature: string; recentAvg: number; olderAvg: number; drift: number }[] = [];
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

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('ITEM 196(b) DRIFT ARTEFACT VERIFICATION — ' + new Date().toISOString());
  const rows: Row[] = [];
  for (let page = 0; page < 60; page++) {
    const { data, error } = await anon.from('trade_outcomes_v1').select('signal_id, ts, result, features').order('ts', { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  console.log(`corpus rows (ts-ordered): ${rows.length}`);

  const all = computeDrift(rows);
  const clean = computeDrift(rows.filter(r => !isReconstruction(r.features)));

  console.log('\n── WITH all rows (what the engine hydrates today) ──');
  for (const m of all) console.log(`  ${m.feature.padEnd(12)} recentAvg=${m.recentAvg.toFixed(4)} olderAvg=${m.olderAvg.toFixed(4)} drift=${m.drift.toFixed(4)}`);
  if (all.length > 0) console.log(`  mean drift across features: ${(all.reduce((s, m) => s + m.drift, 0) / all.length).toFixed(4)}`);

  console.log('\n── EXCLUDING provenance-marked reconstruction rows ──');
  for (const m of clean) console.log(`  ${m.feature.padEnd(12)} recentAvg=${m.recentAvg.toFixed(4)} olderAvg=${m.olderAvg.toFixed(4)} drift=${m.drift.toFixed(4)}`);
  if (clean.length > 0) console.log(`  mean drift across features: ${(clean.reduce((s, m) => s + m.drift, 0) / clean.length).toFixed(4)}`);
  else console.log('  (insufficient non-reconstruction rows in the 40-row window)');

  const sentAll = all.find(m => m.feature === 'sentiment');
  const sentClean = clean.find(m => m.feature === 'sentiment');
  console.log('\n── VERDICT INPUT ──');
  if (sentAll) console.log(`  sentiment drift WITH backfill:      ${sentAll.drift.toFixed(4)} (${sentAll.olderAvg.toFixed(4)} -> ${sentAll.recentAvg.toFixed(4)})`);
  if (sentClean) console.log(`  sentiment drift WITHOUT backfill:   ${sentClean.drift.toFixed(4)} (${sentClean.olderAvg.toFixed(4)} -> ${sentClean.recentAvg.toFixed(4)})`);
  const recentWindow = rows.slice(-20);
  const olderWindow = rows.slice(-40, -20);
  console.log(`  recent-20 window: ${recentWindow.filter(r => isReconstruction(r.features)).length}/20 reconstruction rows`);
  console.log(`  older-20 window:  ${olderWindow.filter(r => isReconstruction(r.features)).length}/20 reconstruction rows`);
}

main().catch(err => { console.error('FAILED:', err instanceof Error ? err.message : String(err)); process.exit(1); });
