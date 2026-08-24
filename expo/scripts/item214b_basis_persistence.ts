/**
 * CHECKPOINT D — VENUE BASIS: MEASURE PERSISTENCE (PROPOSE, DO NOT SHIP).
 *
 * D1: basis distribution — app_m1_bars close vs gold_m1_bars close, joined on
 *     the minute. Mean, median, p90/p95, max — in dollars AND as a fraction of
 *     TP1 ($2.50 on the 25-pip ladder).
 * D2: accrual sufficiency vs the PRE-REGISTERED minimums (decided before this
 *     run): >= 1 full trading day (~1380 M1 bars) for the distribution;
 *     >= 2 weeks (~2026-09-07) for persistence claims. Not enough -> state the
 *     date and STOP the persistence claim honestly. No extrapolation from a
 *     few hours.
 * D3: boundary-crossing frequency — per minute with both bars, how often the
 *     basis moves price ACROSS a zone boundary of the live sr_zones_v1 map
 *     (app close and Vantage close on OPPOSITE sides of a zone price), and how
 *     often |basis| exceeds the distance from the Vantage close to the nearest
 *     zone edge. This frequency decides defect-vs-quirk.
 * D4: proposal only — cost the two translation forms and name the authorising
 *     gate. NOTHING IS SHIPPED.
 *
 * Prior measurement context (item214_venue_basis_run.txt, emission-stamp basis,
 * n=24): median |basis| $0.68 = 28.4% of TP1, p90 $1.52; the two failed
 * 2026-08-24 BUYs carried basis 51.6% / 55.2% of TP1.
 *
 * CAVEAT (stated up front): the "then-current" zone map is approximated by the
 * CURRENT sr_zones_v1 map (zone refresh cadence 15 min; levels are persistent —
 * updated_at reflects touch refresh, not map membership). The D3 frequency is
 * therefore an approximation on the current map, reported as such.
 *
 * DATA-SOURCE RULE: app_m1_bars + gold_m1_bars + sr_zones_v1 reads = Supabase
 * DIRECT via anon key. READ-ONLY. Nothing is written.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: string; close: number }
interface Zone { price: number; type: string; updated_at: string | null }

const TP1_USD = 2.50;
const CAPTURE_START_APPROX_MS = Date.parse('2026-08-24T16:30:00Z');
const ONE_TRADING_DAY_BARS = 1380;
const PERSISTENCE_DATE = '2026-09-07';

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return env;
};

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return sorted[idx];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function lag1Autocorr(xs: number[]): number {
  if (xs.length < 3) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  let num = 0, den = 0;
  for (let i = 1; i < xs.length; i++) num += (xs[i - 1] - m) * (xs[i] - m);
  for (let i = 0; i < xs.length; i++) den += (xs[i] - m) ** 2;
  return den > 0 ? num / den : NaN;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: appRows, error: appErr } = await client.from('app_m1_bars')
    .select('timestamp, close').order('timestamp', { ascending: true });
  if (appErr) { console.error(`BLOCKER: app_m1_bars fetch: ${appErr.message}`); process.exit(1); }
  const appBars = (appRows ?? []) as Bar[];

  console.log(`\n${line}`);
  console.log('CHECKPOINT D — VENUE BASIS: PERSISTENCE MEASUREMENT (PROPOSE, DO NOT SHIP)');
  console.log(line);
  console.log(`  run at            : ${new Date().toISOString()}`);
  console.log(`  app_m1_bars rows  : ${appBars.length}`);
  if (appBars.length === 0) {
    console.log(`\n  D2: ZERO app bars accrued since capture shipped (~2026-08-24T16:30Z). The capture`);
    console.log(`  module may not be wired to a running app instance, or no app session has been`);
    console.log(`  active since. CHECKPOINT D BLOCKED on accrual: no distribution, no crossing`);
    console.log(`  frequency. Distribution date: after the first full trading day of accrual;`);
    console.log(`  persistence date: ${PERSISTENCE_DATE}. Re-run this script once bars exist.`);
    console.log(`\n  D4 (proposal only, unchanged): translate the zone map into app-feed space at read`);
    console.log(`  time IF the basis proves persistent; single-venue geometry if white noise.`);
    console.log(`  Authorising gate: lag-1 autocorrelation >= 0.5 (or half-life >= 30 min) on >= 2`);
    console.log(`  weeks of minute bars AND residual boundary-crossing <= 2% of minutes.`);
    console.log(`\nDONE (measurement only — nothing written, nothing shipped)\n`);
    return;
  }
  const firstTs = appBars[0].timestamp;
  const lastTs = appBars[appBars.length - 1].timestamp;
  console.log(`  first / last bar  : ${firstTs} -> ${lastTs}`);
  const captureElapsedDays = (new Date(lastTs).getTime() - CAPTURE_START_APPROX_MS) / 86400000;

  // Vantage bars over the same window
  const { data: vRows, error: vErr } = await client.from('gold_m1_bars')
    .select('timestamp, close')
    .gte('timestamp', firstTs).lte('timestamp', new Date(new Date(lastTs).getTime() + 60_000).toISOString())
    .order('timestamp', { ascending: true });
  if (vErr) { console.error(`BLOCKER: gold_m1_bars fetch: ${vErr.message}`); process.exit(1); }
  const vBars = (vRows ?? []) as Bar[];
  const vByMinute = new Map<string, number>();
  for (const b of vBars) vByMinute.set(b.timestamp.slice(0, 16), Number(b.close));

  // D1 — basis distribution on minute-matched closes
  const matched: { minute: string; app: number; v: number; basis: number }[] = [];
  for (const b of appBars) {
    const vClose = vByMinute.get(b.timestamp.slice(0, 16));
    if (vClose === undefined) continue;
    const appClose = Number(b.close);
    matched.push({ minute: b.timestamp, app: appClose, v: vClose, basis: appClose - vClose });
  }
  const absBasis = matched.map(m => Math.abs(m.basis)).sort((a, b) => a - b);
  const bases = matched.map(m => m.basis);
  const pctOfTp1 = (x: number): string => `${((x / TP1_USD) * 100).toFixed(1)}% of TP1`;

  console.log(`\n${line}`);
  console.log('D1 — BASIS DISTRIBUTION (app close − Vantage close, minute-matched)');
  console.log(line);
  console.log(`  matched minutes   : ${matched.length}/${appBars.length} app bars (${vBars.length} Vantage bars in window)`);
  if (matched.length === 0) {
    console.log(`  NO minute-matched pairs — Vantage feed has no bars in the app-capture window.`);
    console.log(`  CHECKPOINT D BLOCKED on accrual (same gate as D2 below).`);
  } else {
    console.log(`  mean |basis|      : $${(absBasis.reduce((a, b) => a + b, 0) / absBasis.length).toFixed(3)}  (${pctOfTp1(absBasis.reduce((a, b) => a + b, 0) / absBasis.length)})`);
    console.log(`  median |basis|    : $${median(absBasis).toFixed(3)}  (${pctOfTp1(median(absBasis))})`);
    console.log(`  p90 |basis|       : $${quantile(absBasis, 0.90).toFixed(3)}  (${pctOfTp1(quantile(absBasis, 0.90))})`);
    console.log(`  p95 |basis|       : $${quantile(absBasis, 0.95).toFixed(3)}  (${pctOfTp1(quantile(absBasis, 0.95))})`);
    console.log(`  max |basis|       : $${Math.max(...absBasis).toFixed(3)}  (${pctOfTp1(Math.max(...absBasis))})`);
    const posBasis = bases.filter(b => b > 0).length;
    const negBasis = bases.filter(b => b < 0).length;
    console.log(`  sign              : ${posBasis} positive / ${negBasis} negative / ${bases.length - posBasis - negBasis} zero — ${posBasis > negBasis * 2 || negBasis > posBasis * 2 ? 'SKEWED (persistent level candidate)' : 'roughly symmetric (level + noise)'}`);
    console.log(`  mean signed basis : $${(bases.reduce((a, b) => a + b, 0) / bases.length).toFixed(3)}`);
    console.log(`  prior stamp-basis (item214, n=24): median $0.68 = 28.4% of TP1, p90 $1.52 —`); 
    console.log(`  cross-check: minute-bar basis ${matched.length > 0 ? `median ${pctOfTp1(median(absBasis))}` : 'n/a'}`);
  }

  // D2 — accrual sufficiency
  console.log(`\n${line}`);
  console.log('D2 — ACCRUAL SUFFICIENCY (pre-registered minimums, decided before this run)');
  console.log(line);
  console.log(`  accrued                      : ${appBars.length} app bars over ${captureElapsedDays.toFixed(2)} days (capture since ~2026-08-24T16:30Z)`);
  console.log(`  distribution minimum         : ${ONE_TRADING_DAY_BARS} bars (one full trading day) -> ${appBars.length >= ONE_TRADING_DAY_BARS ? 'MET' : `NOT MET (${((appBars.length / ONE_TRADING_DAY_BARS) * 100).toFixed(0)}% of minimum)`}`);
  console.log(`  persistence minimum          : 2 weeks of bars -> NOT MET. Persistence claims STOP here.`);
  console.log(`  persistence measurement date : ${PERSISTENCE_DATE} (accrual continues automatically; nothing to do but wait)`);
  const distUsable = appBars.length >= ONE_TRADING_DAY_BARS;
  console.log(`  D2 VERDICT: distribution ${distUsable ? 'REPORTABLE (>= 1 trading day)' : 'PROVISIONAL (fewer than 1 trading day — report the numbers above as a first cut, not a claim)'};`);
  console.log(`  persistence UNMEASURABLE until ${PERSISTENCE_DATE}. The lag-1 autocorrelation preview below is`);
  console.log(`  a preview ONLY — it cannot authorize anything at this n.`);

  // Persistence preview (honest, labeled as preview)
  if (matched.length >= 3) {
    const ac = lag1Autocorr(bases);
    console.log(`\n  PERSISTENCE PREVIEW (NOT a claim): lag-1 autocorrelation of the signed basis = ${Number.isFinite(ac) ? ac.toFixed(3) : 'n/a'} on n=${matched.length} minutes.`);
    console.log(`    interpretation bound: at this n the standard error of an autocorrelation is ~1/sqrt(n) = ±${(1 / Math.sqrt(matched.length)).toFixed(3)};`);
    console.log(`    the preview is ${Number.isFinite(ac) && Math.abs(ac) > 2 / Math.sqrt(matched.length) ? 'statistically distinguishable from zero' : 'indistinguishable from zero'} — but ${matched.length} minutes cannot measure a half-life.`);
  }

  // D3 — boundary-crossing frequency vs the live zone map
  console.log(`\n${line}`);
  console.log('D3 — BOUNDARY-CROSSING FREQUENCY (vs CURRENT sr_zones_v1 map — approximation, see header)');
  console.log(line);
  const { data: zoneRows } = await client.from('sr_zones_v1')
    .select('price, type, updated_at').order('reaction_strength', { ascending: false }).limit(32);
  const zones = ((zoneRows ?? []) as Zone[]).map(z => Number(z.price));
  console.log(`  zone map           : ${zones.length} zones (top 32 by reaction_strength)`);
  if (matched.length > 0 && zones.length > 0) {
    let minutesWithCrossing = 0;
    let totalCrossings = 0;
    let basisExceedsEdgeDist = 0;
    const crossingMinutes: string[] = [];
    for (const m of matched) {
      let crossed = 0;
      let minEdgeDist = Infinity;
      for (const z of zones) {
        const appSide = m.app - z;
        const vSide = m.v - z;
        if ((appSide > 0) !== (vSide > 0)) crossed += 1;
        const edgeDist = Math.abs(m.v - z);
        if (edgeDist < minEdgeDist) minEdgeDist = edgeDist;
      }
      totalCrossings += crossed;
      if (crossed > 0) { minutesWithCrossing += 1; if (crossingMinutes.length < 5) crossingMinutes.push(`${m.minute} app=${m.app} v=${m.v} crossings=${crossed}`); }
      if (Math.abs(m.basis) > minEdgeDist && minEdgeDist !== Infinity) basisExceedsEdgeDist += 1;
    }
    console.log(`  minutes evaluated  : ${matched.length}`);
    console.log(`  minutes with >=1 zone boundary CROSSED by the basis: ${minutesWithCrossing} (${((minutesWithCrossing / matched.length) * 100).toFixed(1)}%)`);
    console.log(`  total zone crossings: ${totalCrossings} (${(totalCrossings / matched.length).toFixed(2)} per minute)`);
    console.log(`  minutes where |basis| > distance to nearest zone edge: ${basisExceedsEdgeDist} (${((basisExceedsEdgeDist / matched.length) * 100).toFixed(1)}%)`);
    for (const c of crossingMinutes) console.log(`    e.g. ${c}`);
    console.log(`\n  DEFECT-VS-QUIRK READ (provisional, n=${matched.length} minutes): a crossing frequency of`);
    console.log(`  ${((minutesWithCrossing / matched.length) * 100).toFixed(1)}% of minutes is ${minutesWithCrossing / matched.length >= 0.10 ? 'HIGH — consistent with a DEFECT-class frame mismatch' : 'LOW-MODERATE — consistent with a persistent level plus noise (quirk, translatable)'} —`);
    console.log(`  but this is ONE ${captureElapsedDays.toFixed(1)}-day window on the CURRENT map. The decision waits for ${PERSISTENCE_DATE}.`);
  } else {
    console.log(`  BLOCKED: no minute-matched pairs (see D1).`);
  }

  // D4 — proposal + authorising gate
  console.log(`\n${line}`);
  console.log('D4 — PROPOSAL (NOTHING SHIPPED) + AUTHORISING GATE');
  console.log(line);
  console.log(`  Two translation forms, costed:`);
  console.log(`  A) TRANSLATE THE ZONE MAP into app-feed space at read time (zone' = zone + T, T = a`);
  console.log(`     rolling robust estimate of the basis, e.g. median over the last 60 app bars):`);
  console.log(`     - the ladder (SL/TP) is RELATIVE to entry, hence frame-free; the zone map is the`);
  console.log(`       ONLY Vantage-frame object the engine consumes -> the map is the side to move.`);
  console.log(`     - error carried: the RESIDUAL (basis − T), not the basis. Requires persistence.`);
  console.log(`     - zones refresh every 15 min (slow side); the engine already reads its own feed.`);
  console.log(`  B) TRANSLATE ENTRIES into Vantage space at emission: carries the FULL instantaneous`);
  console.log(`     basis into every zone-relative decision, and leaves entries/SL/TP — the things`);
  console.log(`     that execute — in a frame the engine no longer observes directly. STRICTLY WORSE.`);
  console.log(`  => A is the candidate. The ladder needs no translation (relative by construction).`);
  console.log(`\n  AUTHORISING GATE (pre-registered NOW, evaluated ${PERSISTENCE_DATE}):`);
  console.log(`    1. basis persistence on >= 2 weeks of app bars: lag-1 autocorrelation >= 0.5 OR`);
  console.log(`       half-life >= 30 minutes. (White noise -> gate FAILS -> single-venue geometry:`);
  console.log(`       widen TP1 beyond cross-venue noise or move the stack to one venue.)`);
  console.log(`    2. residual boundary-crossing frequency with T applied <= 2% of minutes.`);
  console.log(`    3. no scoring/gate constant changes ship with the translation — additive only.`);
  console.log(`\nDONE (measurement only — nothing written, nothing shipped)\n`);
}

main().catch(err => { console.error('BLOCKER:', err); process.exit(1); });
