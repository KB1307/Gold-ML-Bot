/**
 * PHASE B / B1 — ITEM 120 / F-10: WEEKLY ERA BUCKETING OF THE CANONICAL BOOK.
 *
 * Five+ rounds skipped, self-flagged as the single most consequential open
 * measurement (SYSTEM_CHECKLIST F-10). The question: is the snapshot-era EV of
 * -0.1016R (Item 201) ERA DECAY (the edge itself is fading/negative forward)
 * or SELECTION (a regime/mix artifact of which signals got captured)?
 *
 * POPULATION (identical construct to items_209_213_measurement.ts, the last
 * audited canonical definition): emitted_signals_v1 joined to
 * trade_outcomes_v1 on signal_id, realized_r non-null, is_scratch not true.
 * No re-resolution, no bars fetch — stored labels only.
 *
 * BUCKETS: calendar weeks (Monday 00:00 UTC).
 *
 * POWER (stated BEFORE any result, mindset rule 7):
 *   Per-week EV MDE ≈ ±1.96 * sd_w / sqrt(n_w). At n_w≈10/week and the book's
 *   measured sd≈1.0R, MDE ≈ ±0.62R per week — individual weeks CANNOT resolve
 *   the question. The pre-registered primary test is therefore the TREND
 *   (slope of weekly EV on week index, LIVE-only rows, n-weighted), bootstrap
 *   CI over signal resampling within weeks. Secondary: full-canonical slope;
 *   era split at the snapshot boundary 2026-07-16T10:51:28Z (Item 201).
 *
 * PRE-REGISTERED GATE (decided before running): if the LIVE-only weekly EV
 * slope is negative with the 95% bootstrap CI excluding zero, the forward edge
 * is NEGATIVE — no flag flips, no gate loosens, Phase C reduces to C1 until
 * the scoring layer is re-derived. If the CI includes zero, the verdict is
 * UNDERPOWERED (not "positive") and the accrual date for a decisive test is
 * named from the measured slope CI width.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface SignalRow {
  signal_id: string;
  emitted_at: string;
  direction: string;
  source: string;
  confidence: number;
}

interface OutcomeRow {
  signal_id: string;
  realized_r: number | null;
  is_scratch: boolean | null;
}

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

const fmtR = (r: number): string => (r >= 0 ? `+${r.toFixed(4)}` : r.toFixed(4));

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
}

/** Deterministic LCG bootstrap mean CI (same pattern as items_209_213_measurement.ts). */
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

interface WeekBucket {
  weekStart: number;
  label: string;
  rs: number[];
  liveRs: number[];
  backfillRs: number[];
  simRs: number[];
}

/** Monday 00:00 UTC of the week containing ts. */
function weekStartMs(ts: number): number {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - day * 86_400_000;
}

/** n-weighted least-squares slope of weekly EV on week index. */
function weightedSlope(weeks: { idx: number; ev: number; n: number }[]): number {
  let sw = 0;
  let swx = 0;
  let swy = 0;
  let swxx = 0;
  let swxy = 0;
  for (const w of weeks) {
    const wt = w.n;
    sw += wt;
    swx += wt * w.idx;
    swy += wt * w.ev;
    swxx += wt * w.idx * w.idx;
    swxy += wt * w.idx * w.ev;
  }
  const denom = sw * swxx - swx * swx;
  if (denom === 0) return 0;
  return (sw * swxy - swx * swy) / denom;
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('PHASE B / B1 — ITEM 120 / F-10: WEEKLY ERA BUCKETING — ' + new Date().toISOString());
  console.log('='.repeat(100));

  const emitted = await fetchAll<SignalRow>('emitted_signals_v1', 'signal_id, emitted_at, direction, source, confidence', 'emitted_at');
  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, realized_r, is_scratch', 'ts');
  const outcomeBySignal = new Map(outcomes.map(o => [o.signal_id, o]));
  console.log(`emitted=${emitted.length} outcomes=${outcomes.length}`);

  const canonical = emitted
    .filter(e => {
      const o = outcomeBySignal.get(e.signal_id);
      return o && o.realized_r !== null && (o.is_scratch === null || o.is_scratch === false);
    })
    .map(e => ({
      signalId: e.signal_id,
      ts: new Date(e.emitted_at).getTime(),
      r: Number(outcomeBySignal.get(e.signal_id)!.realized_r),
      source: e.source,
    }));
  console.log(`canonical (resolved, non-scratch): n=${canonical.length}`);
  const bySource: Record<string, number> = {};
  for (const c of canonical) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  console.log(`canonical by source: ${JSON.stringify(bySource)}`);

  const allRs = canonical.map(c => c.r);
  const sdAll = Math.sqrt(variance(allRs));
  console.log(`full canonical book: n=${allRs.length} EV=${fmtR(mean(allRs))} sd=${sdAll.toFixed(4)}R`);

  // ── POWER FIRST (before any weekly result) ─────────────────────────────────
  console.log('\n── POWER (stated BEFORE results) ──');
  const nWeeks = new Set(canonical.map(c => weekStartMs(c.ts))).size;
  const perWeek = canonical.length / nWeeks;
  console.log(`weeks spanned: ${nWeeks} · mean canonical signals/week: ${perWeek.toFixed(1)}`);
  const mdePerWeek = 1.96 * (sdAll / Math.sqrt(Math.max(1, Math.round(perWeek))));
  console.log(`per-week EV MDE at sd=${sdAll.toFixed(4)}R, n≈${Math.round(perWeek)}/week: ±${mdePerWeek.toFixed(4)}R`);
  console.log('  → A single week cannot resolve the question at this n (MDE dwarfs the |−0.10R| era effect).');
  console.log('  → PRIMARY TEST: LIVE-only n-weighted weekly-EV slope, bootstrap CI (5000 resamples).');
  console.log('     A slope is decisive only if its 95% CI excludes zero.');
  console.log('  → PRE-REGISTERED GATE: LIVE-only slope negative with CI excluding zero ⇒ forward edge');
  console.log('     NEGATIVE ⇒ no flag flips, no gate loosens; Phase C reduces to C1.');
  console.log('     CI includes zero ⇒ verdict UNDERPOWERED, accrual date named below.');

  // ── Weekly buckets ─────────────────────────────────────────────────────────
  const buckets = new Map<number, WeekBucket>();
  for (const c of canonical) {
    const ws = weekStartMs(c.ts);
    let b = buckets.get(ws);
    if (!b) {
      b = { weekStart: ws, label: new Date(ws).toISOString().slice(0, 10), rs: [], liveRs: [], backfillRs: [], simRs: [] };
      buckets.set(ws, b);
    }
    b.rs.push(c.r);
    if (c.source === 'LIVE') b.liveRs.push(c.r);
    else if (c.source === 'BACKFILL') b.backfillRs.push(c.r);
    else b.simRs.push(c.r);
  }
  const weeks = [...buckets.values()].sort((a, b) => a.weekStart - b.weekStart);

  console.log('\n── WEEKLY SERIES (canonical, all sources) ──');
  console.log('weekStart      n   LIVE  BACK  SIM    EV(R)      WR      95% CI (bootstrap)');
  for (const w of weeks) {
    const wr = w.rs.filter(r => r > 0).length / (w.rs.filter(r => r !== 0).length || 1);
    const ci = bootstrapMeanCI(w.rs, 1200 + w.weekStart % 100000, 2000);
    console.log(
      `${w.label}  ${String(w.rs.length).padStart(3)}  ${String(w.liveRs.length).padStart(5)}  ${String(w.backfillRs.length).padStart(4)}  ${String(w.simRs.length).padStart(3)}  ${fmtR(mean(w.rs)).padStart(9)}  ${(wr * 100).toFixed(0).padStart(4)}%  [${ci.low.toFixed(3)}, ${ci.high.toFixed(3)}]`,
    );
  }

  // ── LIVE-only weekly series (the forward-trading population) ───────────────
  console.log('\n── LIVE-ONLY WEEKLY SERIES ──');
  const liveWeeks = weeks
    .map(w => ({ weekStart: w.weekStart, label: w.label, rs: w.liveRs }))
    .filter(w => w.rs.length > 0);
  for (const w of liveWeeks) {
    const wr = w.rs.filter(r => r > 0).length / (w.rs.filter(r => r !== 0).length || 1);
    const ci = bootstrapMeanCI(w.rs, 1300 + w.weekStart % 100000, 2000);
    console.log(`${w.label}  n=${String(w.rs.length).padStart(3)}  EV=${fmtR(mean(w.rs)).padStart(9)}  WR=${(wr * 100).toFixed(0).padStart(4)}%  CI=[${ci.low.toFixed(3)}, ${ci.high.toFixed(3)}]`);
  }

  // ── PRIMARY TEST: LIVE-only slope with bootstrap CI ────────────────────────
  console.log('\n── PRIMARY TEST: LIVE-only weekly EV slope (n-weighted, bootstrap over signals) ──');
  const liveSignalWeeks = canonical
    .filter(c => c.source === 'LIVE')
    .map(c => ({ idx: weekIndex(weeks, c.ts), r: c.r }));
  const observedSlope = weightedSlope(
    liveSignalWeeks.reduce<{ idx: number; ev: number; n: number }[]>((acc, s) => {
      let b = acc.find(a => a.idx === s.idx);
      if (!b) { b = { idx: s.idx, ev: 0, n: 0 }; acc.push(b); }
      b.ev = (b.ev * b.n + s.r) / (b.n + 1);
      b.n += 1;
      return acc;
    }, []),
  );
  console.log(`observed LIVE-only slope: ${fmtR(observedSlope)}R per week`);

  let seed = 120120;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };
  const slopeSamples: number[] = [];
  for (let iter = 0; iter < 5000; iter++) {
    const sample = liveSignalWeeks.map(s => ({ idx: s.idx, r: liveSignalWeeks[Math.floor(rand() * liveSignalWeeks.length)].r }));
    const agg = sample.reduce<{ idx: number; ev: number; n: number }[]>((acc, s) => {
      let b = acc.find(a => a.idx === s.idx);
      if (!b) { b = { idx: s.idx, ev: 0, n: 0 }; acc.push(b); }
      b.ev = (b.ev * b.n + s.r) / (b.n + 1);
      b.n += 1;
      return acc;
    }, []);
    slopeSamples.push(weightedSlope(agg));
  }
  slopeSamples.sort((a, b) => a - b);
  const slopeLow = slopeSamples[Math.floor(5000 * 0.025)];
  const slopeHigh = slopeSamples[5000 - 1 - Math.floor(5000 * 0.025)];
  console.log(`LIVE-only slope 95% bootstrap CI: [${slopeLow.toFixed(4)}, ${slopeHigh.toFixed(4)}]R/week`);
  const slopeExcludesZero = (slopeLow > 0 && slopeHigh > 0) || (slopeLow < 0 && slopeHigh < 0);
  console.log(`CI excludes zero: ${slopeExcludesZero ? 'YES' : 'NO'}`);

  // ── Secondary: full-canonical slope ────────────────────────────────────────
  console.log('\n── SECONDARY: full-canonical weekly EV slope ──');
  const allSignalWeeks = canonical.map(c => ({ idx: weekIndex(weeks, c.ts), r: c.r }));
  const aggAll = allSignalWeeks.reduce<{ idx: number; ev: number; n: number }[]>((acc, s) => {
    let b = acc.find(a => a.idx === s.idx);
    if (!b) { b = { idx: s.idx, ev: 0, n: 0 }; acc.push(b); }
    b.ev = (b.ev * b.n + s.r) / (b.n + 1);
    b.n += 1;
    return acc;
  }, []);
  console.log(`observed full-canonical slope: ${fmtR(weightedSlope(aggAll))}R per week`);

  // ── Era split at the snapshot boundary (Item 201) ──────────────────────────
  console.log('\n── ERA SPLIT at snapshot boundary 2026-07-16T10:51:28Z (Item 201) ──');
  const boundary = Date.parse('2026-07-16T10:51:28Z');
  const pre = canonical.filter(c => c.ts < boundary);
  const post = canonical.filter(c => c.ts >= boundary);
  const postLive = post.filter(c => c.source === 'LIVE');
  const preLive = pre.filter(c => c.source === 'LIVE');
  for (const [name, pop] of [['PRE-boundary all', pre], ['POST-boundary all', post], ['PRE-boundary LIVE', preLive], ['POST-boundary LIVE', postLive]] as const) {
    const rs = pop.map(p => p.r);
    if (rs.length === 0) { console.log(`${name}: n=0`); continue; }
    const ci = bootstrapMeanCI(rs, 1400 + rs.length, 3000);
    const wr = rs.filter(r => r > 0).length / (rs.filter(r => r !== 0).length || 1);
    console.log(`${name.padEnd(20)} n=${String(rs.length).padStart(3)}  EV=${fmtR(mean(rs)).padStart(9)}  WR=${(wr * 100).toFixed(1).padStart(5)}%  CI=[${ci.low.toFixed(4)}, ${ci.high.toFixed(4)}]`);
  }

  // ── Verdict (pre-registered order) ────────────────────────────────────────
  console.log('\n── VERDICT (pre-registered) ──');
  if (slopeExcludesZero && observedSlope < 0) {
    console.log('ERA DECAY CONFIRMED: LIVE-only weekly EV trend negative with CI excluding zero.');
    console.log('GATE ENGAGED: forward edge is NEGATIVE. No flag flips, no gate loosening.');
    console.log('Phase C reduces to C1 (venue basis) until the scoring layer is re-derived.');
  } else {
    console.log('UNDERPOWERED / INCONCLUSIVE: LIVE-only slope CI includes zero.');
    const slopeHalf = (slopeHigh - slopeLow) / 2;
    const liveWeeksSpanned = new Set(liveSignalWeeks.map(s => s.idx)).size;
    const liveRatePerWeek = liveSignalWeeks.length / Math.max(1, liveWeeksSpanned);
    console.log(`slope CI half-width ≈ ±${slopeHalf.toFixed(4)}R/week at current n (${liveSignalWeeks.length} LIVE signals over ${liveWeeksSpanned} weeks, ~${liveRatePerWeek.toFixed(1)}/week).`);
    // CI half-width scales ~1/sqrt(n): n_new = n0 * (h0/h_target)^2.
    const nForTrend = liveSignalWeeks.length * (slopeHalf / 0.10) ** 2;
    const weeksForTrend = (nForTrend - liveSignalWeeks.length) / Math.max(0.1, liveRatePerWeek);
    console.log(`TREND TEST: to resolve a |0.10R/week| slope needs n≈${Math.round(nForTrend)} LIVE signals ≈ ${weeksForTrend.toFixed(0)} more weeks ≈ ${(weeksForTrend / 4.33).toFixed(1)} months at ${liveRatePerWeek.toFixed(1)}/week.`);
    console.log('  → At this emission rate the trend test is closer to IMPOSSIBLE than underpowered (mindset rule 8).');
    console.log('  → The instrument that CAN settle the era question is the POST-boundary LIVE MEAN, not the slope.');
    const postLiveRs = postLive.map(p => p.r);
    const postCi = bootstrapMeanCI(postLiveRs, 1450, 5000);
    const postHalf = (postCi.high - postCi.low) / 2;
    const postEv = Math.abs(mean(postLiveRs));
    console.log(`POST-boundary LIVE mean EV=${fmtR(mean(postLiveRs))}, CI half-width ±${postHalf.toFixed(4)} at n=${postLiveRs.length}.`);
    const nForObserved = postLiveRs.length * (postHalf / Math.max(postEv, 0.01)) ** 2;
    const weeksForObserved = (nForObserved - postLiveRs.length) / Math.max(0.1, liveRatePerWeek);
    console.log(`  If the TRUE post-boundary LIVE EV stays at the observed ${fmtR(mean(postLiveRs))}: n≈${Math.round(nForObserved)} ⇒ ~${weeksForObserved.toFixed(1)} more weeks to exclude zero.`);
    const nForTenth = postLiveRs.length * (postHalf / 0.10) ** 2;
    const weeksForTenth = (nForTenth - postLiveRs.length) / Math.max(0.1, liveRatePerWeek);
    console.log(`  To resolve a |0.10R| era EV at all: n≈${Math.round(nForTenth)} ⇒ ~${weeksForTenth.toFixed(0)} more weeks ≈ ${(weeksForTenth / 4.33).toFixed(1)} months.`);
    console.log('Per the pre-registered gate this is NOT evidence of a positive edge — flags stay OFF.');
  }
}

function weekIndex(weeks: WeekBucket[], ts: number): number {
  const ws = weekStartMs(ts);
  const sorted = [...weeks].sort((a, b) => a.weekStart - b.weekStart);
  return sorted.findIndex(w => w.weekStart === ws);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
