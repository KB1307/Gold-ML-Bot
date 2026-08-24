/**
 * PHASE B / B3 — ITEM 138(d): CONFIDENCE RE-DERIVATION ON THE LIVE-ONLY CORPUS.
 *
 * Every confidence threshold from 0.68 to 0.90 measured NEGATIVE EV while the
 * full book was positive (HC-133c), and Item 138 amended F-33 to NOT CONFIRMED
 * (the sub-0.68 cohort is 100% BACKFILL). The named fix — re-derive confidence
 * against canonical R on a LIVE-only corpus — was never run. This runs it.
 *
 * POPULATION: LIVE-only canonical rows (resolved, non-scratch), the population
 * forward trading actually experiences.
 *
 * POWER (stated BEFORE results): n≈36 LIVE rows. For a confidence-vs-R
 * correlation, |r| ≥ 1.96/√(n−3) ≈ 0.34 is the 95% significance floor — the
 * test can only detect a VERY strong relationship. For an EV split at the
 * 0.80 threshold, arms of ~n=18 each have MDE ≈ ±0.9R. If the result is
 * inconclusive, the accrual date is named (per the pre-registered rule: no
 * re-thresholding, no post-hoc bucket moves).
 *
 * PRE-REGISTERED QUESTION: does confidence carry ANY signal about canonical R
 * in the LIVE population? Verdict options: PREDICTIVE (CI excludes zero),
 * UNINFORMATIVE (CI includes zero, |r| small), or UNDERPOWERED (CI includes
 * zero but wide enough that a real effect could hide).
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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

const env = loadEnv();
const supabase = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface SignalRow {
  signal_id: string;
  emitted_at: string;
  source: string;
  confidence: number;
  raw_confidence: number | null;
}

interface OutcomeRow {
  signal_id: string;
  realized_r: number | null;
  is_scratch: boolean | null;
}

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

function bootstrapMeanCI(values: number[], seed: number, iters = 5000): { low: number; high: number } {
  if (values.length < 2) return { low: NaN, high: NaN };
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(rand() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return { low: means[Math.floor(iters * 0.025)], high: means[means.length - 1 - Math.floor(iters * 0.025)] };
}

async function fetchAll<T>(table: string, columns: string, orderColumn: string): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabase.from(table).select(columns).order(orderColumn, { ascending: true }).range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('PHASE B / B3 — ITEM 138(d): CONFIDENCE RE-DERIVATION (LIVE-ONLY) — ' + new Date().toISOString());
  console.log('='.repeat(100));

  const emitted = await fetchAll<SignalRow>('emitted_signals_v1', 'signal_id, emitted_at, source, confidence, raw_confidence', 'emitted_at');
  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, realized_r, is_scratch', 'ts');
  const outcomeBySignal = new Map(outcomes.map(o => [o.signal_id, o]));

  const canonical = emitted
    .filter(e => {
      const o = outcomeBySignal.get(e.signal_id);
      return o && o.realized_r !== null && (o.is_scratch === null || o.is_scratch === false);
    })
    .map(e => ({ signalId: e.signal_id, ts: e.emitted_at, source: e.source, conf: Number(e.confidence), r: Number(outcomeBySignal.get(e.signal_id)!.realized_r) }));

  const live = canonical.filter(c => c.source === 'LIVE');
  console.log(`canonical n=${canonical.length}, LIVE-only n=${live.length}`);

  // ── POWER FIRST ──
  const n = live.length;
  const rFloor = 1.96 / Math.sqrt(Math.max(1, n - 3));
  console.log(`\n── POWER (before results) ──`);
  console.log(`n=${n} LIVE rows. Correlation significance floor |r| ≥ ${rFloor.toFixed(3)}.`);
  console.log(`A 0.80-threshold EV split gives arms of ~n=${Math.floor(n / 2)} each, MDE ≈ ±${(2.8 * Math.sqrt(2 * 1.0 / (n / 2))).toFixed(2)}R.`);
  console.log(`This test can only detect a strong relationship; anything weaker is honestly UNDERPOWERED.`);

  // ── Correlation: confidence vs canonical R ──
  console.log(`\n── CONFIDENCE vs CANONICAL R (LIVE-only) ──`);
  const pairs = live.map(c => ({ x: c.conf, y: c.r }));
  const mx = mean(pairs.map(p => p.x));
  const my = mean(pairs.map(p => p.y));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (const p of pairs) {
    num += (p.x - mx) * (p.y - my);
    dx += (p.x - mx) ** 2;
    dy += (p.y - my) ** 2;
  }
  const r = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
  const se = 1 / Math.sqrt(Math.max(1, n - 3));
  const z = 0.5 * Math.log((1 + r) / (1 - r));
  const lo = Math.tanh(z - 1.96 * se);
  const hi = Math.tanh(z + 1.96 * se);
  console.log(`Pearson r = ${r >= 0 ? '+' : ''}${r.toFixed(3)}  95% CI [${lo.toFixed(3)}, ${hi.toFixed(3)}]  (floor ${rFloor.toFixed(3)})`);
  const excludesZero = lo > 0 || hi < 0;
  console.log(`CI excludes zero: ${excludesZero ? 'YES' : 'NO'}`);

  // ── EV by confidence tercile (LIVE-only; fixed buckets, no post-hoc moves) ──
  console.log(`\n── EV BY CONFIDENCE TERCILE (fixed split, LIVE-only) ──`);
  const sorted = [...live].sort((a, b) => a.conf - b.conf);
  const t1 = sorted.slice(0, Math.floor(n / 3));
  const t2 = sorted.slice(Math.floor(n / 3), Math.floor((2 * n) / 3));
  const t3 = sorted.slice(Math.floor((2 * n) / 3));
  for (const [label, arr] of [['low tercile', t1], ['mid tercile', t2], ['high tercile', t3]] as const) {
    if (arr.length === 0) { console.log(`${label}: n=0`); continue; }
    const rs = arr.map(a => a.r);
    const ci = bootstrapMeanCI(rs, 1380 + arr.length, 3000);
    console.log(`${label.padEnd(12)} n=${String(arr.length).padStart(3)}  conf[${arr[0].conf.toFixed(2)}–${arr[arr.length - 1].conf.toFixed(2)}]  EV=${mean(rs) >= 0 ? '+' : ''}${mean(rs).toFixed(4)}R  WR=${((rs.filter(x => x > 0).length / (rs.filter(x => x !== 0).length || 1)) * 100).toFixed(0)}%  CI=[${ci.low.toFixed(3)}, ${ci.high.toFixed(3)}]`);
  }

  // ── The 0.68–0.90 threshold question, honestly restated ──
  console.log(`\n── THRESHOLD STABILITY (LIVE-only, informative only at this n) ──`);
  for (const th of [0.68, 0.75, 0.80, 0.85, 0.90] as const) {
    const above = live.filter(c => c.conf >= th);
    const below = live.filter(c => c.conf < th);
    if (above.length === 0) { console.log(`th=${th.toFixed(2)}: n_above=0`); continue; }
    console.log(`th=${th.toFixed(2)}: above n=${above.length} EV=${mean(above.map(a => a.r)) >= 0 ? '+' : ''}${mean(above.map(a => a.r)).toFixed(4)}R | below n=${below.length}${below.length ? ` EV=${mean(below.map(a => a.r)) >= 0 ? '+' : ''}${mean(below.map(a => a.r)).toFixed(4)}R` : ''}`);
  }

  // ── Verdict ──
  console.log(`\n── VERDICT (pre-registered) ──`);
  if (excludesZero) {
    console.log(`PREDICTIVE: confidence carries signal about canonical R in the LIVE population (CI excludes zero).`);
    console.log(`Follow-up (pre-registered): a monotonic re-derivation of the confidence scale is warranted.`);
  } else if (Math.abs(r) < rFloor && hi - lo > 0.6) {
    console.log(`UNDERPOWERED: CI includes zero and is wide (±${((hi - lo) / 2).toFixed(3)}). A real |r| up to ~${(hi - lo).toFixed(2)} could hide.`);
    // Accrual: CI half-width scales 1/sqrt(n)
    const half = (hi - lo) / 2;
    const nForFloor = n * (half / 0.15) ** 2; // resolve |r|=0.15
    const perWeek = n / 2.5; // LIVE span ~2.5 weeks (B1: 36 over 3 weekly buckets)
    const weeks = (nForFloor - n) / Math.max(0.1, perWeek);
    console.log(`To resolve a |r|=0.15 confidence-R relationship: n≈${Math.round(nForFloor)} ⇒ ~${weeks.toFixed(0)} more weeks ≈ ${(weeks / 4.33).toFixed(1)} months at ${perWeek.toFixed(0)}/week.`);
    console.log(`Per the pre-registered rule: NO re-thresholding and NO confidence changes on this evidence.`);
  } else {
    console.log(`UNINFORMATIVE: CI includes zero at a width that excludes meaningful effects.`);
    console.log(`Confidence as currently computed does not rank LIVE outcomes; any penalty charged against it (OB 5pt penalty — now REMOVED by C3) had no evidential basis.`);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
