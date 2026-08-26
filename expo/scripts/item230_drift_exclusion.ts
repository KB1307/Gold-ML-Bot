/**
 * ITEM 230 / CHECKPOINT G — THE DRIFT SCORE AND THE RETRAIN CONTRADICTION.
 *
 * The 16:53Z export showed, side by side:
 *     volumeRatio: 0.891 -> 1.432   drift 0.601  CRITICAL
 *     sentiment:   0.200 -> 0.021   drift 0.850  CRITICAL
 *     rsi/atr/dxyChange: STABLE
 *     Retraining recommended: NO
 *     Retrain scheduled:      YES
 *
 * Item 201(b) shipped an exclusion so provenance-marked reconstruction rows are dropped
 * before the drift windows are sliced, and sentiment is a DOCUMENTED DEFAULT on every
 * reconstructed row. If sentiment is still driving a CRITICAL, the exclusion is not reaching
 * this computation. This script replicates analyzeFeatureValueDrift() EXACTLY — windows,
 * filters, fallback, formula, thresholds — on the live corpus and computes the drift THREE ways:
 *
 *   BASIS A — ALL rows          (pre-201(b) behaviour)
 *   BASIS B — THE SHIPPED PATH  (Item 201(b) filter, WITH its documented fallback: if fewer
 *                                than 40 measurable rows exist, fall back to ALL rows)
 *   BASIS C — ENGINE-NATIVE ONLY (the measurable filter applied STRICTLY, no fallback)
 *
 * Whichever basis reproduces the export's exact numbers identifies the path that produced
 * THIS export's Section 3. Sentiment and volumeRatio are then adjudicated
 * real-or-artefact on the strictest basis, with every disagreement printed.
 *
 * DATA-SOURCE RULE: trade_outcomes_v1 read DIRECT via anon key. READ-ONLY.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

/** Exact predicate shipped at signalEngine.ts:5889-5904 (analyzeFeatureValueDrift). */
function isMeasurable(f: RowFeatures | undefined): boolean {
  return f?.sentiment?.source !== 'resolver-bar-reconstruction'
    && f?.featuresSource !== 'app-bar-reconstruction'
    && (f as Record<string, unknown> | undefined)?.featuresIncomplete !== true;
}

interface RowFeatures {
  rsi?: number; atr?: number; volumeRatio?: number; dxyChange?: number;
  sentiment?: { score?: number; source?: string };
  featuresSource?: string;
  featuresIncomplete?: boolean;
}
interface OutcomeRow {
  signal_id: string; ts: string; result: string; features: RowFeatures | null;
}

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return env;
};

const FEATURE_NAMES = ['rsi', 'atr', 'volumeRatio', 'sentiment', 'dxyChange'] as const;

function computeDrift(rows: OutcomeRow[]): Record<string, { olderAvg: number; recentAvg: number; drift: number; status: string }> {
  // signalEngine.ts:5905-5908 — windows sliced AFTER filtering, winners extracted within each.
  if (rows.length < 20) return {};
  const recentRows = rows.slice(-20);
  const olderRows = rows.slice(-40, -20);
  if (olderRows.length < 10) return {};
  const out: Record<string, { olderAvg: number; recentAvg: number; drift: number; status: string }> = {};
  for (const name of FEATURE_NAMES) {
    const recentWin = recentRows.filter(o => o.result === 'WIN');
    const olderWin = olderRows.filter(o => o.result === 'WIN');
    if (recentWin.length === 0 || olderWin.length === 0) continue;
    const avgOf = (list: OutcomeRow[]): number => {
      if (name === 'sentiment') {
        const vals = list.map(o => o.features?.sentiment?.score ?? 0);
        return vals.reduce((s, v) => s + v, 0) / list.length;
      }
      const vals = list.map(o => Number((o.features as unknown as Record<string, number>)?.[name]));
      const finite = vals.filter(v => Number.isFinite(v));
      // mirrors sum + undefined === NaN in the original: non-finite poisons the mean
      return vals.length === finite.length ? vals.reduce((s, v) => s + v, 0) / list.length : NaN;
    };
    const historicalImportance = Math.abs(avgOf(olderWin));
    const currentImportance = Math.abs(avgOf(recentWin));
    const drift = Math.abs(currentImportance - historicalImportance) / (historicalImportance + 0.01);
    const measurable = Number.isFinite(drift) && Number.isFinite(currentImportance) && Number.isFinite(historicalImportance);
    const status = !measurable ? 'INSUFFICIENT_DATA' : drift < 0.3 ? 'STABLE' : drift < 0.6 ? 'DEGRADING' : 'CRITICAL';
    out[name] = { olderAvg: historicalImportance, recentAvg: currentImportance, drift, status };
  }
  return out;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`${line}`);
  console.log('ITEM 230 / CHECKPOINT G — DRIFT SCORE RECOMPUTED THREE WAYS ON LIVE CORPUS');
  console.log(line);

  const all: OutcomeRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('trade_outcomes_v1')
      .select('signal_id, ts, result, features')
      .order('ts', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`trade_outcomes_v1 fetch failed: ${error.message}`);
    const batch = (data ?? []) as OutcomeRow[];
    all.push(...batch);
    if (batch.length < 1000) break;
  }
  console.log(`\n  corpus            : ${all.length} outcome rows`);

  const markedCount = all.filter(o => !isMeasurable(o.features)).length;
  const last40Marked = all.slice(-40).filter(o => !isMeasurable(o.features)).length;
  console.log(`  reconstruction-marked rows (Item 201(b) predicate): ${markedCount}/${all.length} overall, ${last40Marked}/40 inside the drifting window region`);

  const measurable = all.filter(o => isMeasurable(o.features));
  console.log(`  measurable rows after exclusion filter: ${measurable.length}`);

  // Basis B — THE SHIPPED PATH INCLUDING ITS FALLBACK
  const shippedPath = measurable.length >= 40 ? measurable : all;
  console.log(`\n  SHIPPED-PATH RESOLUTION: ${shippedPath === measurable ? 'exclusion APPLIED (>=40 measurable rows)' : 'FALLBACK FIRED (<40 measurable) — exclusion NOT reaching the computation'}`);

  const printBasis = (label: string, rows: OutcomeRow[]): void => {
    const m = computeDrift(rows);
    console.log(`\n-- ${label} --`);
    if (Object.keys(m).length === 0) { console.log('   (windows insufficient)'); return; }
    for (const [name, v] of Object.entries(m)) {
      console.log(`   ${name.padEnd(12)} ${v.olderAvg.toFixed(4)} -> ${v.recentAvg.toFixed(4)}   drift=${v.drift.toFixed(4)}  ${v.status}`);
    }
  };

  printBasis('BASIS A — ALL ROWS (pre-201(b))', all);
  printBasis('BASIS B — SHIPPED PATH (filter + fallback)', shippedPath);
  printBasis('BASIS C — ENGINE-NATIVE ONLY (strict, no fallback)', measurable);

  // Provenance census inside the exact shipped windows — answers WHY sentiment can still drift.
  const winSentimentSources = (rows: OutcomeRow[], which: 'recent' | 'older'): Map<string, number> => {
    const slice = which === 'recent' ? rows.slice(-20) : rows.slice(-40, -20);
    const m = new Map<string, number>();
    for (const o of slice.filter(x => x.result === 'WIN')) {
      const src = o.features?.sentiment?.source ?? '(missing)';
      m.set(src, (m.get(src) ?? 0) + 1);
    }
    return new Map([...m.entries()].sort());
  };
  console.log(`\n${line}`);
  console.log('SENTIMENT PROVENANCE CENSUS AMONG WINDOW WINNERS');
  console.log(line);
  for (const [w, label] of [['older', 'OLDER window (winners)'], ['recent', 'RECENT window (winners)']] as const) {
    for (const [basis, rows] of [['shipped-path', shippedPath], ['engine-native', measurable]] as const) {
      const srcs = winSentimentSources(rows, w);
      console.log(`  ${label} — ${basis}: ${[...srcs.entries()].map(([k, v]) => `${k}=${v}`).join(', ') || '(no winner rows)'}`);
    }
  }
  console.log('\n  A default sentiment (score 0 / feed unavailable) on rows whose provenance is NOT marked');
  console.log('  passes every shipped filter — if the census above shows such sources, that IS the reach gap.');

  // Native sentiment VALUE provenance: are the winning-row sentiment scores real measurements?
  const nativeWinnersAll = measurable.filter(o => o.result === 'WIN');
  const nonDefaultNative = nativeWinnersAll.filter(o => (o.features?.sentiment?.score ?? -1) > 0);
  console.log(`  engine-native winner rows with sentiment score > 0: ${nonDefaultNative.length}/${nativeWinnersAll.length}`);
  void winsToNothing;

  console.log(`\n${line}`);
  console.log('VOLUME RATIO VERIFICATION (engine-native field — is 0.891 -> 1.432 REAL?)');
  console.log(line);
  const volCheck = (rows: OutcomeRow[], label: string): void => {
    const recentWin = rows.slice(-20).filter(o => o.result === 'WIN');
    const olderWin = rows.slice(-40, -20).filter(o => o.result === 'WIN');
    const dump = (l: OutcomeRow[]): string =>
      l.map(o => `${o.features?.volumeRatio?.toFixed(3) ?? '-'}`).join(' ');
    console.log(`  ${label}: older[${olderWin.length}] = ${dump(olderWin)}`);
    console.log(`           recent[${recentWin.length}] = ${dump(recentWin)}`);
  };
  volCheck(measurable, 'engine-native');

  console.log(`\n${line}`);
  console.log('RECOMMENDED=NO / SCHEDULED=YES TRACE FACTS (code paths quoted, no behaviour changed)');
  console.log(line);
  console.log(`  retrainingRecommended formula  : signalEngine.ts:10685-10688`);
  console.log(`     (driftAlertLevel HIGH || conceptDriftScore > 0.5 || confidenceDegradation > 0.08`);
  console.log(`      || daysSinceRetrain > 5)`);
  console.log(`  NOTE: PER-FEATURE CRITICAL is NOT an input to that recommendation flag.`);
  console.log(`  retrainScheduled SET sites     : :5846 (concept-drift HIGH response)`);
  console.log(`                                   :7962 (trigger fired outside low-liquidity window)`);
  console.log(`  retrainScheduled CLEARED       : :7956/:7969 (walkForwardOptimization executed)`);
  console.log(`                                   :8436+ (D5 decoupled execution inside 22:00-07:00 UTC)`);
  console.log(`  retrainScheduled declaration   : :1731 private boolean — IN-MEMORY ONLY, resets on restart.`);
  console.log(`  DEDUCTION: process origin ~2026-08-24T16:27-20:22Z (Item 228 reconciliation). Asian`);
  console.log(`  windows (22:00-07:00 UTC) passed on Aug 24, Aug 25 and today before 07:00Z. For`);
  console.log(`  retrainScheduled to be TRUE at export time (16:53Z), it was set AFTER 07:00Z today:`);
  console.log(`  a trigger fired during TODAY's daytime evaluation cycle. It will execute in the next`);
  console.log(`  low-liquidity window beginning 22:00Z tonight.`);
}

// silence unused warnings helper
function winsToNothing(): void {}

main().catch(e => { console.error(e instanceof Error ? e.stack ?? e.message : String(e)); process.exit(1); });
