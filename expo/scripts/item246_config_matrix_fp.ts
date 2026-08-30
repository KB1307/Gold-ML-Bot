/**
 * ITEM BB — CONFIG MATRIX, NOW PROPERLY CONDITIONED ON THE FINGERPRINT.
 *
 * The V/W/X round measured the four configs UNCONDITIONED because the
 * fingerprint instrument did not exist in the tree (item240's named blocker).
 * It exists now: services/bandProximityVeto.ts exports fingerprintActive(),
 * computePrior4hAgreement() and opposingZoneFractionOfSnapshot() — the SHIPPED
 * functions are used here, not re-implementations.
 *
 * CONFIGS (prompt-defined, unchanged):
 *   A = snapshot band rule fires AND fingerprint NOT active   (SHIPPED)
 *   B = M15 opposed AND fingerprint NOT active
 *   C = (A-conditions union: snapshot band OR M15 opposed) AND fingerprint NOT active
 *   D = (snapshot band rule AND M15 opposed) AND fingerprint NOT active
 *
 * INPUT PATHS (stated): rsi = stored emission-time rsi; opposing_zone_fraction
 * = shipped opposingZoneFractionOfSnapshot on the signal's OWN snapshot;
 * prior-4h agreement = the A.2 method computed fresh from gold_m1_bars over the
 * FULL 5h window (the input path item241 used for the recorded gates — the
 * shipped FETCH truncation is Item CC's audit and is deliberately NOT mixed
 * into this matrix). M15 roles = the oracle (services/m15ZoneLayer.ts) on bars
 * STRICTLY before emitted_at, >= 14 trading days required, else NULL.
 *
 * BB.2 SELECTION CRITERION (pre-registered in the V/W/X round; UNCHANGED):
 *   (i)   kept-book EV_net > whole-book EV_net,
 *   (ii)  removed-cohort EV_net < -0.15R AND its CI upper bound < 0,
 *   (iii) retained frequency >= 65% of emissions.
 *   Ties -> highest retained frequency. None -> SHIPPED config (A) stands.
 *
 * POWER (MINDSET 7): every split prints MDE = 2.80*sigma_p*sqrt(1/nr+1/nk)
 * BEFORE its point estimates. Bootstrap 20k, seed 20260828.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import { bandVetoHit } from './item234_band_veto';
import type { SnapZone } from './item234_band_veto';
import { fingerprintActive, opposingZoneFractionOfSnapshot } from '../services/bandProximityVeto';
import { buildM15Zones, m15OpposedHit, m15EndorsedHit, MEMORY_TRADING_DAYS, type M1Bar } from '../services/m15ZoneLayer';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; rsi: number | null; sr_zones_snapshot: SnapZone[] | string | null }
interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface R {
  id: string; dir: 'BUY' | 'SELL'; entry: number; tp1: number; ems: number; rNet: number;
  snapVeto: boolean; m15Opp: boolean | null; m15End: boolean | null;
  fp: boolean; fpDetail: string; rsi: number | null; oppFrac: number | null; agrees: boolean | null;
}

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }
const lbR = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };
const lbM = (bars: M1Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].ts < t) lo = m + 1; else hi = m; } return lo; };
const ev = (v: number[]): number => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN);

function bootDiff(removed: number[], kept: number[]): [number, number] {
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

function bootMean(vals: number[]): [number, number] {
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
  return `  ${label.padEnd(30)} n=${String(n).padStart(4)}  WR=${isNaN(wr) ? '  - ' : wr.toFixed(1) + '%'}  EV_net=${n ? ((ev(vals) >= 0 ? '+' : '') + ev(vals).toFixed(4)) : '  -   '}R  total=${n ? ((vals.reduce((x, y) => x + y, 0) >= 0 ? '+' : '') + vals.reduce((x, y) => x + y, 0).toFixed(2)) : '  -  '}R`;
}

/** A.2 method, verbatim semantics (item241): 5h window ending at emission,
 *  >=150 bars, base = last bar with ts <= last.ts - 4h, delta = last - base. */
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
  console.log(line); console.log('ITEM BB — CONFIG MATRIX, FINGERPRINT-CONDITIONED (era-clean, real resolver, SHIPPED fingerprint fn)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  PRE-STATED: MDE 2.80*sigma_p*sqrt(1/nr+1/nk), printed BEFORE each split; boot 20k seed 20260828.');
  console.log('  BB.2 criterion (unchanged): (i) kept EV > whole EV, (ii) removed EV < -0.15R AND CI upper < 0, (iii) retained >= 65%.');

  const all: Row[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,rsi,sr_zones_snapshot').or("closed_market_emission.is.null,closed_market_emission.eq.false").order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`signals: ${error.message}`);
    all.push(...(data ?? []) as Row[]);
    if ((data?.length ?? 0) < 1000) break;
  }
  const { data: ends } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(ends?.[0]?.timestamp)).getTime();
  const minEms = Math.min(...all.map(r => new Date(r.emitted_at).getTime()));
  const bars: Bar[] = [];
  const m1All: M1Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close').gte('timestamp', new Date(minEms - 18 * 86_400_000).toISOString()).lte('timestamp', new Date(barsEndMs).toISOString()).order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`bars: ${error.message}`);
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[]) {
      const ts = new Date(r.timestamp).getTime();
      bars.push({ timestamp: ts, open: +r.open, high: +r.high, low: +r.low, close: +r.close });
      m1All.push({ ts, o: +r.open, h: +r.high, l: +r.low, c: +r.close });
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  corpus: ${all.length} emitted | ${bars.length} M1 bars to ${new Date(barsEndMs).toISOString()}`);

  const book: R[] = [];
  let exclNoSnap = 0, exclUndecided = 0, m15Unavailable = 0;
  for (const s of all) {
    const zones = typeof s.sr_zones_snapshot === 'string' ? (JSON.parse(s.sr_zones_snapshot) as SnapZone[]) : s.sr_zones_snapshot;
    if (!zones || zones.length === 0) { exclNoSnap++; continue; }
    const ems = new Date(s.emitted_at).getTime();
    const windowEnd = Math.min(ems + 8 * 3600_000, barsEndMs);
    const wb = bars.slice(lbR(bars, ems - 60_000), lbR(bars, windowEnd));
    const cov = wb.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
    if (cov < 100 || wb.length === 0) { exclUndecided++; continue; }
    const sig = { id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: s.direction === 'SELL' ? 'SELL' : 'BUY', entryPrice: +s.entry, entryPriceWithSlippage: +s.entry, tp1: +s.tp1, tp2: +s.tp2, tp3: +s.tp3, sl: +s.sl, confidence: +s.confidence, status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false } as unknown as TradingSignal;
    const r = resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd });
    if (r.outcomeResult === null) { exclUndecided++; continue; }
    const dir = sig.type as 'BUY' | 'SELL';

    const snapVeto = bandVetoHit(dir, +s.entry, +s.tp1, zones, 10, 0.5) !== null;

    // M15 oracle, STRICTLY before emission, >= 14 trading days else NULL.
    const m1 = m1All.slice(lbM(m1All, ems - 16 * 86_400_000), lbM(m1All, ems));
    let m15Opp: boolean | null = null, m15End: boolean | null = null;
    const built = m1.length >= 1000 ? buildM15Zones(m1, ems) : null;
    if (built && built.tradingDays >= MEMORY_TRADING_DAYS) {
      m15Opp = m15OpposedHit(built.zones, dir, +s.entry, +s.tp1) !== null;
      m15End = m15EndorsedHit(built.zones, dir, +s.entry, +s.tp1) !== null;
    } else m15Unavailable++;

    // SHIPPED fingerprint function with its shipped input functions.
    const rsi = s.rsi === null || s.rsi === undefined ? null : Number(s.rsi);
    const oppFrac = opposingZoneFractionOfSnapshot(dir, zones);
    const { agrees, delta } = prior4hAgreement(bars, ems, dir);
    const fp = fingerprintActive(dir, rsi, oppFrac, agrees);

    book.push({
      id: s.signal_id, dir, entry: +s.entry, tp1: +s.tp1, ems, rNet: computeRNet(dir, +s.entry, r.exitPrice, Math.abs(+s.entry - +s.sl)),
      snapVeto, m15Opp, m15End, fp, rsi, oppFrac, agrees,
      fpDetail: `rsi=${rsi === null ? '-' : rsi.toFixed(1)} agree=${agrees === null ? '-' : String(agrees)}(d=${delta === null ? '-' : delta.toFixed(2)}) opp=${oppFrac === null ? '-' : oppFrac.toFixed(3)}`,
    });
  }
  const whole = ev(book.map(b => b.rNet));
  console.log(`\nPOPULATION: decided=${book.length} | whole-book EV_net=${(whole >= 0 ? '+' : '') + whole.toFixed(4)}R | M15 map unavailable (NULL role): ${m15Unavailable}`);
  console.log(`  fingerprint input coverage: rsi non-null ${book.filter(b => b.rsi !== null).length} | prior-4h computable ${book.filter(b => b.agrees !== null).length} | fingerprint ACTIVE ${book.filter(b => b.fp).length}`);

  const split = (label: string, rem: R[], kep: R[]): { removedEv: number; remMeanCiHi: number; keptEv: number; retained: number; nr: number } => {
    const rr = rem.map(b => b.rNet), kk = kep.map(b => b.rNet);
    const nr = rr.length, nk = kk.length;
    const pool = [...rr, ...kk];
    const sigmaP = pool.length > 1 ? Math.sqrt(pool.reduce((a, r) => a + (r - ev(pool)) ** 2, 0) / (pool.length - 1)) : NaN;
    const mde = 2.8 * sigmaP * Math.sqrt(1 / Math.max(1, nr) + 1 / Math.max(1, nk));
    console.log(`\n${label}:  MDE ±${mde.toFixed(4)}R  (n_removed=${nr}, n_kept=${nk}, pooled sigma=${isNaN(sigmaP) ? '-' : sigmaP.toFixed(4)}R)  <-- stated BEFORE point estimates`);
    const [mlo, mhi] = nr >= 2 ? bootMean(rr) : [NaN, NaN];
    const [clo, chi] = nr > 0 && nk > 0 ? bootDiff(rr, kk) : [NaN, NaN];
    console.log(`  removed n=${nr} WR=${nr ? (100 * rr.filter(v => v > 0).length / nr).toFixed(1) : '-'}% EV=${nr ? ((ev(rr) >= 0 ? '+' : '') + ev(rr).toFixed(4)) : '-'}R total=${nr ? '+' + rr.reduce((x, y) => x + y, 0).toFixed(2) : '-'}R  (mean CI [${isNaN(mlo) ? '-' : mlo.toFixed(4)}, ${isNaN(mhi) ? '-' : mhi.toFixed(4)}])`);
    console.log(`  kept    n=${nk} WR=${nk ? (100 * kk.filter(v => v > 0).length / nk).toFixed(1) : '-'}% EV=${nk ? ((ev(kk) >= 0 ? '+' : '') + ev(kk).toFixed(4)) : '-'}R total=${nk ? '+' + kk.reduce((x, y) => x + y, 0).toFixed(2) : '-'}R`);
    if (nr && nk) console.log(`  retained ${(100 * nk / (nr + nk)).toFixed(1)}% | diff (kept-removed)=${(ev(kk) - ev(rr) >= 0 ? '+' : '') + (ev(kk) - ev(rr)).toFixed(4)}R; boot CI [${clo.toFixed(4)}, ${chi.toFixed(4)}]`);
    // kept book in both halves (median emitted_at split)
    const kepSorted = [...kep].sort((a, b) => a.ems - b.ems);
    const mid = Math.floor(kepSorted.length / 2);
    console.log(statLine('kept first half', kepSorted.slice(0, mid).map(b => b.rNet)));
    console.log(statLine('kept second half', kepSorted.slice(mid).map(b => b.rNet)));
    return { removedEv: nr ? ev(rr) : NaN, remMeanCiHi: mhi, keptEv: nk ? ev(kk) : NaN, retained: nr + nk ? 100 * nk / (nr + nk) : NaN, nr };
  };

  const A = book.filter(b => b.snapVeto && !b.fp);
  const B = book.filter(b => b.m15Opp === true && !b.fp);
  const C = book.filter(b => (b.snapVeto || b.m15Opp === true) && !b.fp);
  const D = book.filter(b => b.snapVeto && b.m15Opp === true && !b.fp);
  const notA = book.filter(b => !(b.snapVeto && !b.fp));
  const notB = book.filter(b => !(b.m15Opp === true && !b.fp));
  const notC = book.filter(b => !((b.snapVeto || b.m15Opp === true) && !b.fp));
  const notD = book.filter(b => !(b.snapVeto && b.m15Opp === true && !b.fp));

  console.log(`\n===== BB.1 — THE FOUR CONFIGS (all AND fingerprint-NOT-active) =====`);
  const resA = split('CONFIG A (snapshot band & !fp)  [SHIPPED]', A, notA);
  const resB = split('CONFIG B (M15 opposed & !fp)', B, notB);
  const resC = split('CONFIG C ((A-union) & !fp)', C, notC);
  const resD = split('CONFIG D ((A AND B) & !fp)', D, notD);

  console.log(`\n===== D-CELL LISTING (signal-by-signal) =====`);
  for (const b of D) console.log(`  ${b.id}  ${new Date(b.ems).toISOString()}  ${b.dir} entry=${b.entry} rNet=${b.rNet.toFixed(4)}  ${b.fpDetail}  m15Opp=${b.m15Opp}`);

  console.log(`\n===== BB.2 — PRE-REGISTERED SELECTION VERDICT =====`);
  // Criterion (ii) reads "removed-cohort EV_net < -0.15R AND ITS CI upper bound < 0"
  // — the removed cohort's OWN mean-EV CI (bootMean above), not the kept-minus-removed
  // difference CI. (First automated pass mistakenly used the diff CI; corrected before
  // any verdict was recorded — the correction is noted in the artifact.)
  const check = (name: string, res: { removedEv: number; remMeanCiHi: number; keptEv: number; retained: number; nr: number }): { ok: boolean; failed: string[] } => {
    const failed: string[] = [];
    if (!(res.keptEv > whole)) failed.push(`(i) kept ${res.keptEv.toFixed(4)} <= whole ${whole.toFixed(4)}`);
    if (!(res.removedEv < -0.15)) failed.push(`(ii) removed ${res.removedEv.toFixed(4)} not < -0.15R`);
    else if (!(res.remMeanCiHi < 0)) failed.push(`(ii) removed-cohort mean-EV CI upper ${res.remMeanCiHi.toFixed(4)} not < 0`);
    if (!(res.retained >= 65)) failed.push(`(iii) retained ${res.retained.toFixed(1)}% < 65%`);
    console.log(`  ${name}: ${failed.length === 0 ? 'QUALIFIES' : 'FAILS -> ' + failed.join('; ')}`);
    return { ok: failed.length === 0, failed };
  };
  const cands = [
    { name: 'A (SHIPPED)', res: resA }, { name: 'B', res: resB }, { name: 'C', res: resC }, { name: 'D', res: resD },
  ].map(c => ({ ...c, v: check(c.name, c.res) }));
  const qualifiers = cands.filter(c => c.v.ok);
  if (qualifiers.length > 0) {
    const best = qualifiers.map(c => ({ c, r: c.res.retained })).sort((a, b) => b.r - a.r)[0];
    console.log(`  VERDICT: ${qualifiers.length} config(s) qualify; HIGHEST RETAINED FREQUENCY -> ${best.c.name} at ${best.r.toFixed(1)}%. This is the pre-registered PROPOSAL for the NEXT round; NOTHING changes live this round.`);
  } else {
    console.log(`  VERDICT: NO config qualifies -> the SHIPPED config (A) STANDS (per the pre-registered rule). NOTHING changes live this round.`);
  }

  console.log(`\n===== BB.3 — M15 ENDORSED cohort (canonical; provisional claimed -0.1808R harmful) =====`);
  const END = book.filter(b => b.m15End === true);
  const NOTEND = book.filter(b => b.m15End !== true);
  console.log(`  endorsed (M15 map available): n=${END.length} | not-endorsed: n=${NOTEND.length} | unavailable: ${m15Unavailable}`);
  if (END.length && NOTEND.length) {
    const endEv = ev(END.map(b => b.rNet)), notEv = ev(NOTEND.map(b => b.rNet));
    const [mlo, mhi] = bootMean(END.map(b => b.rNet));
    const sigmaP = pooled(endEv, notEv, END.map(b => b.rNet), NOTEND.map(b => b.rNet));
    console.log(`  MDE ±${(2.8 * sigmaP * Math.sqrt(1 / END.length + 1 / NOTEND.length)).toFixed(4)}R (n_e=${END.length}, n_ne=${NOTEND.length})  <-- stated BEFORE point estimates`);
    console.log(`  endorsed n=${END.length} WR=${(100 * END.filter(b => b.rNet > 0).length / END.length).toFixed(1)}% EV=${(endEv >= 0 ? '+' : '') + endEv.toFixed(4)}R (mean CI [${mlo.toFixed(4)}, ${mhi.toFixed(4)}]) | not-endorsed EV=${(notEv >= 0 ? '+' : '') + notEv.toFixed(4)}R | diff ${(endEv - notEv >= 0 ? '+' : '') + (endEv - notEv).toFixed(4)}R`);
    // The same three criteria, treating "remove endorsed" as the candidate rule.
    const kept = notEv, removed = endEv;
    const [, remHi] = bootMean(END.map(b => b.rNet));
    const retained = 100 * NOTEND.length / book.length;
    const c1 = kept > whole, c2 = removed < -0.15 && remHi < 0, c3 = retained >= 65;
    console.log(`  three-criteria test for BARRING endorsement as a removal rule:`);
    console.log(`    (i)  kept ${kept.toFixed(4)} > whole ${whole.toFixed(4)} -> ${c1 ? 'PASS' : 'FAIL'}`);
    console.log(`    (ii) endorsed ${removed.toFixed(4)} < -0.15R AND CI upper ${remHi.toFixed(4)} < 0 -> ${c2 ? 'PASS' : 'FAIL'}`);
    console.log(`    (iii) retained ${retained.toFixed(1)}% >= 65% -> ${c3 ? 'PASS' : 'FAIL'}`);
    console.log(`  VERDICT: endorsement ${c1 && c2 && c3 ? 'clears all three — barring is SUPPORTED' : 'does NOT clear the three criteria — endorsement REMAINS BARRED from buy-side scoring as a standing position, and the removal rule is NOT proposed'}.`);
  } else {
    console.log('  endorsed or not-endorsed cohort empty — no comparison possible (M15 map availability limits).');
  }
  console.log(`\n  BB SCOPE: measurement + pre-registered verdict ONLY. Nothing changes live this round.`);
}
function pooled(e1: number, e2: number, v1: number[], v2: number[]): number {
  const pool = [...v1, ...v2];
  if (pool.length < 2) return NaN;
  const m = (e1 * v1.length + e2 * v2.length) / pool.length;
  return Math.sqrt(pool.reduce((a, r) => a + (r - m) ** 2, 0) / (pool.length - 1));
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
