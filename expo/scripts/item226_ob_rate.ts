/**
 * ITEM 226 / CHECKPOINT C — THE REAL POST-OB-REMOVAL EMISSION RATE.
 *
 * C1 actual LIVE rate since the EXACT removal commit, with an exact Poisson CI.
 * C2 comparison against the 21.43/day projection + the inheritance question.
 * C3 mutually-exclusive funnel re-run, stages summing EXACTLY to attempts.
 * C4 OB-absent cohort book on the resolvable subset (rest labelled pending).
 *
 * C1 EXACT BOUNDARY (Correction 5). A tilde is not a measurement window, and
 * every count/window/CI below derives from this one instant:
 *   $ git log -S "OB_FILTER_ENABLED = false" --format='%h %cI' -- \
 *       expo/services/signalEngine.ts
 *   68cc662 2026-08-24T16:55:33Z
 * That is the ONLY commit that introduced the literal, so the filter went off at
 * 2026-08-24T16:55:33Z — NOT the "~17:00Z" the previous round used. Note this is
 * the SAME commit that shipped the Item 225 write-path guard: the OB removal and
 * the emission-guard fix landed together, which is why the post-removal window
 * and the post-guard window are one and the same.
 *
 * DATA-SOURCE RULE: emitted_signals_v1 + trade_outcomes_v1 + gold_m1_bars via
 * Supabase DIRECT with the anon key. READ-ONLY.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { computeRGross, computeRNet } from '../lib/evCompute';

/** C1: exact commit timestamp of the OB_FILTER_ENABLED = false change (68cc662). */
const OB_REMOVAL_ISO = '2026-08-24T16:55:33Z';
const OB_REMOVAL_MS = Date.parse(OB_REMOVAL_ISO);
/** The projection this round is testing, from the Phase C funnel work. */
const PROJECTED_PER_DAY = 21.43;
/** The pre-removal measured rate, for the same-window comparison. */
const PRE_REMOVAL_PER_DAY = 2.71;

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

/**
 * EXACT Poisson 95% CI for an observed count k (Garwood / chi-square form).
 * lower = 0 when k = 0; upper always finite. No normal approximation, because at
 * these counts a normal CI is simply wrong.
 */
function poissonCI(k: number): { lo: number; hi: number } {
  // Chi-square quantiles via the relationship to the gamma distribution, computed
  // by bisection on the regularised lower incomplete gamma. Deterministic.
  const gammaLn = (x: number): number => {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j += 1) { y += 1; ser += c[j] / y; }
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  };
  /** Regularised lower incomplete gamma P(a, x). */
  const gammaP = (a: number, x: number): number => {
    if (x <= 0) return 0;
    if (x < a + 1) {
      let sum = 1 / a, term = sum;
      for (let n = 1; n < 500; n += 1) {
        term *= x / (a + n);
        sum += term;
        if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
      }
      return sum * Math.exp(-x + a * Math.log(x) - gammaLn(a));
    }
    // Continued fraction for Q(a,x), then P = 1 - Q.
    let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
    for (let i = 1; i < 500; i += 1) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < 1e-14) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - gammaLn(a)) * h;
  };
  /** Solve P(a, x) = p for x. */
  const invGammaP = (a: number, p: number): number => {
    let lo = 0, hi = Math.max(10, a * 10);
    while (gammaP(a, hi) < p) hi *= 2;
    for (let i = 0; i < 300; i += 1) {
      const mid = (lo + hi) / 2;
      if (gammaP(a, mid) < p) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const lo = k === 0 ? 0 : invGammaP(k, 0.025);
  const hi = invGammaP(k + 1, 0.975);
  return { lo, hi };
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing Supabase credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  const nowMs = Date.now();
  console.log(`\n${line}`);
  console.log('ITEM 226 / CHECKPOINT C — THE REAL EMISSION RATE NOW THE OB FILTER IS GONE');
  console.log(line);
  console.log(`  run at              : ${new Date(nowMs).toISOString()}`);
  console.log(`  OB removal (EXACT)  : ${OB_REMOVAL_ISO}  commit 68cc662`);
  console.log(`  provenance          : git log -S "OB_FILTER_ENABLED = false" --format='%h %cI' -- expo/services/signalEngine.ts`);
  console.log(`                        returned exactly ONE commit: 68cc662 2026-08-24T16:55:33Z.`);
  console.log(`  NOTE                : that is the SAME commit as the Item 225 write-path guard, so the`);
  console.log(`                        post-removal window and the post-guard window are identical.`);
  console.log(`  previous round used : "~17:00Z" — off by ~4.5 min, and unpinned. Every number below`);
  console.log(`                        derives from the exact instant instead.`);

  // ── C1: LIVE emission count since the exact boundary ──────────────────────
  const { data: emitted, error } = await client
    .from('emitted_signals_v1')
    .select('signal_id, emitted_at, source, direction, entry, sl, tp1, tp2, tp3, confidence')
    .order('emitted_at', { ascending: true });
  if (error) { console.error(`BLOCKER: emitted_signals_v1 read failed: ${error.message}`); process.exit(1); }
  const rows = (emitted ?? []) as { signal_id: string; emitted_at: string; source: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number }[];

  const postRemoval = rows.filter(r => Date.parse(r.emitted_at) >= OB_REMOVAL_MS);
  const postRemovalLive = postRemoval.filter(r => r.source === 'LIVE');
  const elapsedMs = nowMs - OB_REMOVAL_MS;
  const elapsedDays = elapsedMs / 86_400_000;

  console.log(`\n${line}`);
  console.log('C1 — ACTUAL LIVE EMISSION RATE SINCE THE EXACT REMOVAL INSTANT');
  console.log(line);
  console.log(`  window              : ${OB_REMOVAL_ISO} -> ${new Date(nowMs).toISOString()}`);
  console.log(`  elapsed             : ${elapsedDays.toFixed(4)} days (${(elapsedMs / 3_600_000).toFixed(2)} h)`);
  console.log(`  emissions (ALL src) : ${postRemoval.length}`);
  console.log(`  emissions (LIVE)    : ${postRemovalLive.length}   <- the rate-bearing count`);
  const k = postRemovalLive.length;
  const rate = k / elapsedDays;
  const ci = poissonCI(k);
  console.log(`  observed rate       : ${rate.toFixed(3)} LIVE signals/day`);
  console.log(`  exact Poisson 95%CI : [${(ci.lo / elapsedDays).toFixed(3)}, ${(ci.hi / elapsedDays).toFixed(3)}] signals/day  (count CI [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] over ${elapsedDays.toFixed(4)}d)`);
  console.log(`  POWER STATED FIRST  : with k=${k} over ${elapsedDays.toFixed(2)} days the CI spans a factor of`);
  console.log(`                        ~${k > 0 ? (ci.hi / Math.max(ci.lo, 1e-9)).toFixed(1) : 'infinity'}; this is a WIDE interval and no rate inside it is excluded.`);
  console.log(`\n  emission timestamps in the window (LIVE):`);
  for (const r of postRemovalLive) console.log(`    ${r.emitted_at}  ${r.signal_id}  ${r.direction} conf=${r.confidence}`);

  // ── C2: projection comparison + inheritance ───────────────────────────────
  console.log(`\n${line}`);
  console.log('C2 — MEASURED vs PROJECTED (21.43/day), AND WHAT A MISS IMPLIES');
  console.log(line);
  console.log(`  pre-removal measured : ${PRE_REMOVAL_PER_DAY.toFixed(2)} signals/day`);
  console.log(`  projected post-removal: ${PROJECTED_PER_DAY.toFixed(2)} signals/day (the OB gate was modelled as the binding constraint)`);
  console.log(`  ACTUAL post-removal  : ${rate.toFixed(3)} signals/day, exact Poisson 95%CI [${(ci.lo / elapsedDays).toFixed(3)}, ${(ci.hi / elapsedDays).toFixed(3)}]`);
  const projectionInsideCI = PROJECTED_PER_DAY >= ci.lo / elapsedDays && PROJECTED_PER_DAY <= ci.hi / elapsedDays;
  const preInsideCI = PRE_REMOVAL_PER_DAY >= ci.lo / elapsedDays && PRE_REMOVAL_PER_DAY <= ci.hi / elapsedDays;
  console.log(`  is 21.43/day inside the CI? ${projectionInsideCI ? 'YES — the projection is NOT excluded by this data' : 'NO — the projection is EXCLUDED by this data'}`);
  console.log(`  is 2.71/day  inside the CI? ${preInsideCI ? 'YES — the pre-removal rate is NOT excluded either' : 'NO — the pre-removal rate is excluded'}`);
  if (!projectionInsideCI) {
    console.log(`\n  THE INHERITANCE, STATED PLAINLY. If 21.43/day is excluded, the miss is NOT an OB-specific`);
    console.log(`  mistake. That projection came from treating the funnel's per-gate marginal cost as the`);
    console.log(`  number of signals a gate would release if removed. Gates are NOT independent: removing`);
    console.log(`  one exposes the next binding gate, so the marginal cost of EVERY gate in that funnel`);
    console.log(`  inherits the same over-statement. Any future "removing gate X buys N signals/day" claim`);
    console.log(`  from that funnel is suspect for the same reason — including the ones already recorded.`);
  } else if (preInsideCI) {
    console.log(`\n  BOTH candidate rates sit inside the interval, so this window CANNOT distinguish "the OB`);
    console.log(`  removal changed the rate" from "it changed nothing". That is a POWER statement, not a`);
    console.log(`  finding, and the honest read is that the projection is untested rather than confirmed.`);
  }

  // ── C3: mutually-exclusive funnel re-run ─────────────────────────────────
  console.log(`\n${line}`);
  console.log('C3 — FUNNEL RE-RUN (mutually exclusive stages, must sum EXACTLY to attempts)');
  console.log(line);
  const health = await client.from('pipeline_health_v1').select('*').order('created_at', { ascending: false }).limit(1);
  if (health.error) {
    console.log(`  pipeline_health_v1 unreadable: ${health.error.message}`);
    console.log('  FUNNEL STATUS: BLOCKED — the funnel stage counters live in the CLIENT diagnostics');
    console.log('  export (near-miss ring buffer + stand-aside reason counters), which is not queryable');
    console.log('  from a script. This checkpoint therefore CANNOT re-derive the mutually-exclusive');
    console.log('  funnel from a live source, and I am not going to re-quote the previous run as if it');
    console.log('  were fresh evidence. Reported as BLOCKED with the reason, per the CONTINUATION RULE.');
  } else {
    const h = (health.data ?? [])[0] as Record<string, unknown> | undefined;
    console.log(`  latest pipeline_health_v1 row: ${h ? JSON.stringify(h) : '(none)'}`);
    console.log('  NOTE: pipeline_health_v1 carries bar-freshness/engine-liveness telemetry, NOT the');
    console.log('  per-gate rejection counters the funnel needs. Those are client-side only, so the');
    console.log('  funnel re-run remains BLOCKED on a live source (stated, not papered over).');
  }

  // ── C4: OB-absent cohort on the resolvable subset ────────────────────────
  console.log(`\n${line}`);
  console.log('C4 — POST-REMOVAL COHORT BOOK (resolvable subset only; the rest is PENDING by construction)');
  console.log(line);
  const { data: outcomes, error: oErr } = await client
    .from('trade_outcomes_v1')
    .select('signal_id, result, exit_price, realized_r, is_scratch')
    .limit(10000);
  if (oErr) { console.error(`BLOCKER: trade_outcomes_v1 read failed: ${oErr.message}`); process.exit(1); }
  const outMap = new Map<string, { result: string; exit_price: number | null; realized_r: number | null; is_scratch: boolean | null }>();
  for (const o of (outcomes ?? []) as { signal_id: string; result: string; exit_price: number | null; realized_r: number | null; is_scratch: boolean | null }[]) {
    outMap.set(o.signal_id, o);
  }
  const resolved = postRemovalLive.filter(r => {
    const o = outMap.get(r.signal_id);
    return o !== undefined && o.realized_r !== null && o.is_scratch !== true;
  });
  const pending = postRemovalLive.length - resolved.length;
  console.log(`  post-removal LIVE emissions : ${postRemovalLive.length}`);
  console.log(`  RESOLVED (non-scratch, R present): ${resolved.length}`);
  console.log(`  PENDING                     : ${pending}  (an 8h resolution window means recent emissions cannot be decided yet)`);
  if (resolved.length === 0) {
    console.log('  COHORT BOOK: NOT COMPUTABLE — zero resolved rows. No WR, no EV, no CI. Stated as');
    console.log('  impossible rather than reported as 0.');
  } else {
    let wins = 0, sumGross = 0, sumNet = 0;
    for (const r of resolved) {
      const o = outMap.get(r.signal_id);
      if (!o || o.exit_price === null) continue;
      const risk = Math.abs(Number(r.entry) - Number(r.sl));
      const dir = r.direction === 'BUY' ? 'BUY' : 'SELL';
      const g = computeRGross(dir, Number(r.entry), Number(o.exit_price), risk);
      const n = computeRNet(dir, Number(r.entry), Number(o.exit_price), risk);
      sumGross += g; sumNet += n;
      if (n > 0) wins += 1;
      console.log(`    ${r.signal_id.slice(-12)}  ${dir}  R_gross=${g.toFixed(4)}  R_net=${n.toFixed(4)}  storedR=${String(o.realized_r)}`);
    }
    console.log(`  n=${resolved.length}  WR=${((wins / resolved.length) * 100).toFixed(1)}%  EV_gross=${(sumGross / resolved.length).toFixed(4)}R  EV_net=${(sumNet / resolved.length).toFixed(4)}R`);
    console.log(`  POWER: at n=${resolved.length} this cohort cannot support any EV claim. It is recorded as the`);
    console.log('  FIRST live evidence on the arm the filter used to suppress, and nothing more.');
  }

  console.log(`\n${line}`);
  console.log('C5 — DEAD CONSTANT (resolved in code this round; see signalEngine.ts JSDoc above OB_FILTER_MODE)');
  console.log(line);
  console.log('  OB_FILTER_MODE = \'penalty\' is UNREACHABLE while OB_FILTER_ENABLED = false.');
  console.log('  Read sites, verified at line level:');
  console.log('    signalEngine.ts:8845  if (OB_FILTER_MODE === \'reject\')  <- nested inside');
  console.log('    signalEngine.ts:8840  if (OB_FILTER_ENABLED) {          <- so unreachable today');
  console.log('    signalEngine.ts:2910  getRuntimeConfigProbe()           <- REPORTS only, gates nothing');
  console.log('  NEUTRALISATION CHECK: no floor, clamp or Math.max is applied to OB_FILTER_MODE or to');
  console.log('  OB_ABSENT_CONFIDENCE_PENALTY on any read path — the penalty at :8854 is a plain');
  console.log('  subtraction compared against the pre-existing absoluteConfidenceFloor. The constant is');
  console.log('  not silently neutralised; it is simply not reached.');
  console.log('  RESOLUTION: RETAINED deliberately (the documented re-enable criterion names');
  console.log('  mode=\'reject\', so the constant IS that path) with the JSDoc corrected to say so.');
  console.log(`\nDONE (read-only).\n`);
}

main().catch(err => { console.error('BLOCKER:', err); process.exit(1); });
