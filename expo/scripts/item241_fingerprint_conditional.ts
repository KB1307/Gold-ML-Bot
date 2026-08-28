/**
 * ITEM P.0 — CANONICAL RE-DERIVATION of the momentum-fingerprint cohort and the
 * conditional band veto, on the era-clean canonical population (snapshot-bearing
 * decided, real resolver — the SAME instrument as item237/item240).
 *
 * Cohorts (pre-registered in the round prompt):
 *   fp            : agrees_with_prior_4h_move (A.2 method, computed fresh from
 *                   gold_m1_bars — NOT read from storage) AND (BUY rsi>=60 OR
 *                   SELL rsi<=40, stored emission-time rsi) AND
 *                   opposing_zone_fraction<=0.10 (from stored snapshot).
 *   fp-vetoable   : fp members the E.1 band rule would have vetoed.
 *   conditional   : E.1 band rule fires AND fingerprint NOT active.
 * Fingerprint semantics: active ONLY when all three inputs affirmatively hold;
 * a NULL input (rsi absent, bars insufficient) -> NOT active (emission-time
 * semantic — identical to the shipped veto's rule).
 *
 * GATES (pre-registered, evaluated on these canonical numbers):
 *   GATE-1: conditional cohort EV_net < -0.10R.
 *   GATE-2: fp-vetoable subset EV_net > 0.
 *   BOTH PASS -> ship CONDITIONAL veto | GATE-1 pass, GATE-2 fail -> PLAIN veto
 *   (user standing authorization) | GATE-1 fail -> ship NOTHING live.
 *
 * Pre-stated power: MDE = 2.80 * sigma_p * sqrt(1/nr + 1/nk); bootstrap 20k,
 * seed 20260828 (same generator as item237/item240). Stated BEFORE results.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import { bandVetoHit } from './item234_band_veto';
import type { SnapZone } from './item234_band_veto';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; rsi: number | null; sr_zones_snapshot: SnapZone[] | string | null }
interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface R { id: string; dir: 'BUY' | 'SELL'; entry: number; tp1: number; ems: number; zones: SnapZone[] | null; rNet: number | null; snapVeto: boolean; fp: boolean; fpDetail: string; oppFrac: number | null; rsi: number | null; agrees: boolean | null }

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const lbR = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };
const ev = (v: number[]): number => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN);

function ciSplit(removed: number[], kept: number[]): [number, number] {
  const rnd = mulberry32(20260828);
  const boots: number[] = [];
  for (let i = 0; i < 20000; i++) {
    let sr = 0, sk = 0;
    for (let t = 0; t < removed.length; t++) sr += removed[(rnd() * removed.length) | 0];
    for (let t = 0; t < kept.length; t++) sk += kept[(rnd() * kept.length) | 0];
    boots.push(sk / kept.length - sr / removed.length);
  }
  boots.sort((a, b) => a - b);
  return [boots[(boots.length * 0.025) | 0], boots[(boots.length * 0.975) | 0]];
}

/** bootstrap 95% CI of a single cohort's mean EV (for GATE-1 context). */
function ciMean(vals: number[]): [number, number] {
  const rnd = mulberry32(20260828);
  const boots: number[] = [];
  for (let i = 0; i < 20000; i++) {
    let s = 0;
    for (let t = 0; t < vals.length; t++) s += vals[(rnd() * vals.length) | 0];
    boots.push(s / vals.length);
  }
  boots.sort((a, b) => a - b);
  return [boots[(boots.length * 0.025) | 0], boots[(boots.length * 0.975) | 0]];
}

function statLine(label: string, vals: number[]): string {
  const n = vals.length; const wr = n ? (vals.filter(v => v > 0).length / n) * 100 : NaN;
  const e = n ? ev(vals) : NaN;
  return `  ${label.padEnd(34)} n=${String(n).padStart(4)}  WR=${isNaN(wr) ? ' - ' : wr.toFixed(1) + '%'}  EV_net=${n ? ((e >= 0 ? '+' : '') + e.toFixed(4)) : '  -   '}R  total=${n ? ((vals.reduce((x, y) => x + y, 0) >= 0 ? '+' : '') + vals.reduce((x, y) => x + y, 0).toFixed(2)) : '  -  '}R`;
}

/** A.2 method, verbatim semantics of the emittedSignalService annotation:
 *  5h window ending at emission, >=150 bars, base = last bar with ts <= last.ts - 4h,
 *  delta = last.close - base.close; agrees = BUY ? delta>0 : delta<0. */
function prior4hAgreement(bars: Bar[], ems: number, dir: 'BUY' | 'SELL'): { agrees: boolean | null; delta: number | null } {
  const win = bars.slice(lbR(bars, ems - 5 * 3600_000), lbR(bars, ems));
  if (win.length < 150) return { agrees: null, delta: null };
  let base = win[0];
  for (const b of win) { if (b.timestamp <= win[win.length - 1].timestamp - 4 * 3600_000) base = b; else break; }
  const delta = Math.round((win[win.length - 1].close - base.close) * 100) / 100;
  return { agrees: dir === 'BUY' ? delta > 0 : delta < 0, delta };
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM P.0 — FINGERPRINT + CONDITIONAL VETO, CANONICAL RE-DERIVATION (era-clean, real resolver)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  PRE-STATED: GATE-1 conditional EV_net < -0.10R | GATE-2 fp-vetoable EV_net > 0 | MDE 2.80*sigma_p*sqrt(1/nr+1/nk); boot 20k seed 20260828. Stated BEFORE results.');

  const all: Row[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,rsi,sr_zones_snapshot').order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(String(error.message));
    all.push(...(data ?? []) as Row[]);
    if ((data?.length ?? 0) < 1000) break;
  }
  const { data: ends } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(ends?.[0]?.timestamp)).getTime();
  const minEms = Math.min(...all.map(r => new Date(r.emitted_at).getTime()));
  const bars: Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close').gte('timestamp', new Date(minEms - 60_000).toISOString()).lte('timestamp', new Date(barsEndMs).toISOString()).order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(String(error.message));
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[])
      bars.push({ timestamp: new Date(r.timestamp).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  corpus: ${all.length} emitted | ${bars.length} M1 bars to ${new Date(barsEndMs).toISOString()}`);

  const book: R[] = [];
  for (const s of all) {
    const ems = new Date(s.emitted_at).getTime();
    const windowEnd = Math.min(ems + 8 * 3600_000, barsEndMs);
    const wb = bars.slice(lbR(bars, ems - 60_000), lbR(bars, windowEnd));
    const cov = wb.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
    if (cov < 100 || wb.length === 0) continue;
    const zones = typeof s.sr_zones_snapshot === 'string' ? JSON.parse(s.sr_zones_snapshot) as SnapZone[] : s.sr_zones_snapshot;
    const sig = { id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: s.direction === 'SELL' ? 'SELL' : 'BUY', entryPrice: +s.entry, entryPriceWithSlippage: +s.entry, tp1: +s.tp1, tp2: +s.tp2, tp3: +s.tp3, sl: +s.sl, confidence: +s.confidence, status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false } as unknown as TradingSignal;
    const r = resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd });
    if (r.outcomeResult === null) continue;
    const dir = sig.type as 'BUY' | 'SELL';
    const snapVeto = bandVetoHit(dir, +s.entry, +s.tp1, zones ?? null, 10, 0.5) !== null;
    const { agrees, delta } = prior4hAgreement(bars, ems, dir);
    const rsi = s.rsi === null || s.rsi === undefined ? null : Number(s.rsi);
    let oppFrac: number | null = null;
    if (zones && zones.length > 0) {
      const opp = zones.filter(z => (dir === 'BUY' ? z.type === 'RESISTANCE' : z.type === 'SUPPORT')).length;
      oppFrac = Math.round((opp / zones.length) * 1000) / 1000;
    }
    const rsiStretch = rsi !== null && (dir === 'BUY' ? rsi >= 60 : rsi <= 40);
    const fp = agrees === true && rsiStretch && oppFrac !== null && oppFrac <= 0.10;
    book.push({
      id: s.signal_id, dir, entry: +s.entry, tp1: +s.tp1, ems, zones: zones ?? null,
      rNet: computeRNet(dir, +s.entry, r.exitPrice, Math.abs(+s.entry - +s.sl)),
      snapVeto, fp, rsi, agrees, oppFrac,
      fpDetail: `rsi=${rsi === null ? '-' : rsi.toFixed(1)} agree=${agrees === null ? '-' : String(agrees)}(d=${delta === null ? '-' : delta.toFixed(2)}) opp=${oppFrac === null ? '-' : oppFrac.toFixed(3)}`,
    });
  }
  const clean = book.filter(b => b.zones !== null);
  const whole = ev(clean.map(b => b.rNet!));
  const rsiCov = clean.filter(b => b.rsi !== null).length;
  const agreeCov = clean.filter(b => b.agrees !== null).length;
  console.log(`\nPOPULATION: decided=${book.length} | snapshot-bearing (CANONICAL)=${clean.length} | whole-book EV_net=${(whole >= 0 ? '+' : '') + whole.toFixed(4)}R`);
  console.log(`  fingerprint input coverage: rsi non-null ${rsiCov}/${clean.length} | prior-4h agreement computable ${agreeCov}/${clean.length} (A.2, >=150 bars)`);
  console.log(`  fingerprint semantic: active ONLY when all three inputs affirmatively hold; NULL input -> NOT active`);

  const FP = clean.filter(b => b.fp);
  const FPV = FP.filter(b => b.snapVeto);
  const COND_REM = clean.filter(b => b.snapVeto && !b.fp);
  const COND_KEPT = clean.filter(b => !(b.snapVeto && !b.fp));
  const PLAIN_REM = clean.filter(b => b.snapVeto);
  const PLAIN_KEPT = clean.filter(b => !b.snapVeto);

  console.log('\n===== P.0(a) FINGERPRINT COHORT =====');
  console.log(statLine('fingerprint (fp)', FP.map(b => b.rNet!)));
  console.log(statLine('fp AND band-vetoable', FPV.map(b => b.rNet!)));
  for (const b of FPV) console.log(`    ${b.id}  ${new Date(b.ems).toISOString()}  ${b.dir} entry=${b.entry} rNet=${b.rNet!.toFixed(4)}  ${b.fpDetail}`);

  console.log('\n===== P.0(b) CONDITIONAL-VETO COHORT (band rule fires AND fp NOT active) =====');
  const split = (label: string, rem: R[], kep: R[]): void => {
    const rr = rem.map(b => b.rNet!), kk = kep.map(b => b.rNet!);
    const [clo, chi] = rem.length && kep.length ? ciSplit(rr, kk) : [NaN, NaN];
    const [mlo, mhi] = rem.length >= 2 ? ciMean(rr) : [NaN, NaN];
    const pool = [...rr, ...kk];
    const sigmaP = pool.length > 1 ? Math.sqrt(pool.reduce((a, r) => a + (r - ev(pool)) ** 2, 0) / (pool.length - 1)) : NaN;
    const mde = 2.8 * sigmaP * Math.sqrt(1 / Math.max(1, rr.length) + 1 / Math.max(1, kk.length));
    console.log(`\n${label}: removed n=${rr.length} EV=${rr.length ? ev(rr).toFixed(4) : '-'} | kept n=${kk.length} EV=${kk.length ? ev(kk).toFixed(4) : '-'} | retained ${(100 * kk.length / (rr.length + kk.length)).toFixed(1)}%`);
    console.log(`  removed-cohort mean-EV boot CI [${mlo.toFixed(4)}, ${mhi.toFixed(4)}]; diff (kept-removed)=${rem.length && kep.length ? (ev(kk) - ev(rr)).toFixed(4) : '-'}R; boot CI [${clo.toFixed(4)}, ${chi.toFixed(4)}]; MDE +/-${mde.toFixed(4)}R`);
  };
  split('CONDITIONAL', COND_REM, COND_KEPT);
  split('PLAIN      ', PLAIN_REM, PLAIN_KEPT);

  // kept book in both halves (median emitted_at split), per the provisional claim.
  const condKeptSorted = [...COND_KEPT].sort((a, b) => a.ems - b.ems);
  const mid = Math.floor(condKeptSorted.length / 2);
  const h1 = condKeptSorted.slice(0, mid), h2 = condKeptSorted.slice(mid);
  console.log(`\n  CONDITIONAL kept book, both halves (median-emitted_at split):`);
  console.log(statLine('kept first half', h1.map(b => b.rNet!)));
  console.log(statLine('kept second half', h2.map(b => b.rNet!)));
  const condRemSorted = [...COND_REM].sort((a, b) => a.ems - b.ems);
  const mrem = Math.floor(condRemSorted.length / 2);
  console.log('  removed cohort, both halves:');
  console.log(statLine('removed first half', condRemSorted.slice(0, mrem).map(b => b.rNet!)));
  console.log(statLine('removed second half', condRemSorted.slice(mrem).map(b => b.rNet!)));

  console.log('\n===== AGREE/DISAGREE vs PROVISIONAL SLICE (2x 27-Aug failure analysis) =====');
  const cmp = (name: string, prov: string, canon: string): void => console.log(`  ${name.padEnd(28)} provisional ${prov.padEnd(22)} canonical ${canon}`);
  const fpev = FP.length ? ev(FP.map(b => b.rNet!)) : NaN;
  const fpwr = FP.length ? (100 * FP.filter(b => b.rNet! > 0).length / FP.length) : NaN;
  const fpvev = FPV.length ? ev(FPV.map(b => b.rNet!)) : NaN;
  cmp('fp cohort (n/WR/EV)', 'n=33 WR 75.8% +0.2331R', `n=${FP.length} WR ${fpwr.toFixed(1)}% ${(fpev >= 0 ? '+' : '') + fpev.toFixed(4)}R`);
  cmp('fp AND vetoable', '6 members +0.5491R 0 losers', `n=${FPV.length} ${(fpvev >= 0 ? '+' : '') + fpvev.toFixed(4)}R ${FPV.filter(b => b.rNet! > 0).length}W/${FPV.filter(b => b.rNet! <= 0).length}L`);
  cmp('conditional removed', '-0.3208R', `${COND_REM.length ? ev(COND_REM.map(b => b.rNet!)).toFixed(4) : '-'}R`);
  cmp('conditional kept', '+0.0812R', `${COND_KEPT.length ? ev(COND_KEPT.map(b => b.rNet!)).toFixed(4) : '-'}R`);
  cmp('retained', '62%', `${(100 * COND_KEPT.length / clean.length).toFixed(1)}%`);

  console.log('\n===== P.1 GATE CASCADE (pre-registered thresholds; verdict = ship branch) =====');
  const condEv = COND_REM.length ? ev(COND_REM.map(b => b.rNet!)) : NaN;
  const [cmlo, cmhi] = COND_REM.length >= 2 ? ciMean(COND_REM.map(b => b.rNet!)) : [NaN, NaN];
  const fpvEv = FPV.length ? ev(FPV.map(b => b.rNet!)) : NaN;
  const g1 = condEv < -0.10, g2 = fpvEv > 0;
  console.log(`  GATE-1: conditional cohort EV_net ${condEv.toFixed(4)} < -0.10R -> ${g1 ? 'PASS' : 'FAIL'}  (boot CI [${cmlo.toFixed(4)}, ${cmhi.toFixed(4)}])`);
  console.log(`  GATE-2: fp AND vetoable EV_net ${FPV.length ? fpvEv.toFixed(4) : 'n/a (empty)'} > 0 -> ${g2 ? 'PASS' : 'FAIL'}  (n=${FPV.length})`);
  console.log(`  CASCADE: ${g1 && g2 ? 'BOTH PASS -> ship CONDITIONAL veto' : g1 && !g2 ? 'GATE-1 pass, GATE-2 fail -> ship PLAIN veto (user standing authorization, recorded verbatim)' : 'GATE-1 FAIL -> ship NOTHING live; both rules to shadow annotation; Item P stops'}`);
  console.log('\nFP cohort signal-by-signal:');
  for (const b of FP) console.log(`    ${b.id}  ${new Date(b.ems).toISOString()}  ${b.dir} entry=${b.entry} rNet=${b.rNet!.toFixed(4)} vetoable=${b.snapVeto}  ${b.fpDetail}`);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
