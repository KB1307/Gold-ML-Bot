/**
 * ITEM KK — IS THE BAND VETO BLOCKING THE RIGHT THING? (ROLE-AWARE SPLIT)
 *
 * QUESTION (measurement only): the SHIPPED band veto (config A = snapshot band
 * rule fires AND fingerprint NOT active) is ROLE-BLIND — bandVetoHit fires on
 * geometric band proximity, whatever the vetoing zone's CANONICAL role is.
 * This script splits the veto's removed cohort by the vetoing zone's canonical
 * zone role AT EMISSION (no look-ahead: bars strictly before emitted_at):
 *
 *   role-opposed : vetoing zone's canonical role is the one that historically
 *                  blocks this direction (blockingRoleFor(dir))
 *   role-aligned : vetoing zone's canonical role actually AGREES with the
 *                  direction (agreeingRoleFor(dir)) — the veto suppressed a
 *                  trade the zone structure supports
 *   untyped      : role === 'UNTYPED' (coin flip / no evidence)
 *
 * Canonical classification = services/zoneSemantics.buildZoneRole with
 * DEFAULT_ZONE_SEMANTICS (the SHIPPED recency variant (a); NOT the (b)
 * counterfactual — that is FF's audit and stays there).
 *
 * MDE 2.80*sigma_p*sqrt(1/nr+1/nk) stated BEFORE point estimates (MINDSET 7).
 * Bootstrap 20k, seed 20260828. BB.2 criterion UNCHANGED:
 *   (i) kept EV > whole EV, (ii) removed EV < -0.15R AND its mean-CI upper < 0,
 *   (iii) retained >= 65%.
 *
 * SCOPE: measurement + recommendation ONLY. The shipped veto's rule,
 * thresholds, mode, and flag are NOT touched. Nothing changes live.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import { bandVetoHit } from './item234_band_veto';
import type { SnapZone } from './item234_band_veto';
import { fingerprintActive, opposingZoneFractionOfSnapshot } from '../services/bandProximityVeto';
import { buildZoneRole, blockingRoleFor, agreeingRoleFor, DEFAULT_ZONE_SEMANTICS } from '../services/zoneSemantics';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; rsi: number | null; sr_zones_snapshot: SnapZone[] | string | null }
interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface R {
  id: string; dir: 'BUY' | 'SELL'; entry: number; ems: number; rNet: number;
  snapVeto: boolean; fp: boolean;
  vetoZonePrice: number | null;
  vetoRole: 'OPPOSED' | 'ALIGNED' | 'UNTYPED' | null; // canonical role of the VETOING zone
  vetoDetail: string;
}

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }
const lbR = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };
const lbM = (bars: { ts: number }[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].ts < t) lo = m + 1; else hi = m; } return lo; };
const ev = (v: number[]): number => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN);

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

function pooled(e1: number, e2: number, v1: number[], v2: number[]): number {
  const n1 = v1.length, n2 = v2.length;
  if (n1 + n2 < 3) return NaN;
  return Math.sqrt(((n1 - 1) * v1.reduce((a, r) => a + (r - e1) ** 2, 0) + (n2 - 1) * v2.reduce((a, r) => a + (r - e2) ** 2, 0)) / (n1 + n2 - 2));
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
  console.log(line); console.log('ITEM KK — ROLE-AWARE BAND VETO SPLIT (era-clean, real resolver, SHIPPED veto + SHIPPED zone semantics)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  PRE-STATED: MDE 2.80*sigma_p*sqrt(1/nr+1/nk), printed BEFORE each split; boot 20k seed 20260828.');
  console.log('  BB.2 criterion (unchanged): (i) kept EV > whole EV, (ii) removed EV < -0.15R AND its mean-CI upper < 0, (iii) retained >= 65%.');
  console.log('  SCOPE: measurement + recommendation ONLY. The shipped veto is NOT touched.');

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
  const m1All: { ts: number; o: number; h: number; l: number; c: number }[] = [];
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
  let exclNoSnap = 0, exclUndecided = 0, roleUnavailable = 0;
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

    // SHIPPED veto: the vetoing ZONE ITSELF (strict equality with the shipped call).
    const vetoZone = bandVetoHit(dir, +s.entry, +s.tp1, zones, 10, 0.5);

    // SHIPPED fingerprint input path (identical to item246).
    const rsi = s.rsi === null || s.rsi === undefined ? null : Number(s.rsi);
    const oppFrac = opposingZoneFractionOfSnapshot(dir, zones);
    const { agrees } = prior4hAgreement(bars, ems, dir);
    const fp = fingerprintActive(dir, rsi, oppFrac, agrees);

    // Canonical role of the VETOING zone at emission — NO look-ahead:
    // M1 bars STRICTLY before emitted_at, 48h window (FF's canonical window).
    let vetoRole: R['vetoRole'] = null;
    let vetoDetail = 'no-veto-zone';
    if (vetoZone) {
      const zw = m1All.slice(lbM(m1All, ems - 48 * 3600_000), lbM(m1All, ems));
      const zr = zw.length >= 100 ? buildZoneRole(zw, vetoZone.price, DEFAULT_ZONE_SEMANTICS) : null;
      if (!zr) {
        roleUnavailable++;
        vetoDetail = 'insufficient-bars';
      } else {
        if (zr.role === blockingRoleFor(dir)) vetoRole = 'OPPOSED';
        else if (zr.role === agreeingRoleFor(dir)) vetoRole = 'ALIGNED';
        else vetoRole = 'UNTYPED';
        vetoDetail = `${zr.role}(s=${zr.score}, m=${zr.margin})`;
      }
    }

    book.push({
      id: s.signal_id, dir, entry: +s.entry, ems,
      rNet: computeRNet(dir, +s.entry, r.exitPrice, Math.abs(+s.entry - +s.sl)),
      snapVeto: vetoZone !== null, fp,
      vetoZonePrice: vetoZone ? vetoZone.price : null,
      vetoRole, vetoDetail,
    });
  }

  const whole = ev(book.map(b => b.rNet));
  console.log(`\nPOPULATION: decided=${book.length} | whole-book EV_net=${(whole >= 0 ? '+' : '') + whole.toFixed(4)}R | vetoing-zone role unavailable: ${roleUnavailable}`);

  // SHIPPED removed cohort (config A, byte-identical predicate to item246).
  const removedBlind = book.filter(b => b.snapVeto && !b.fp);
  const keptBlind = book.filter(b => !(b.snapVeto && !b.fp));

  const removedOpposed = removedBlind.filter(b => b.vetoRole === 'OPPOSED');
  const removedAligned = removedBlind.filter(b => b.vetoRole === 'ALIGNED');
  const removedUntyped = removedBlind.filter(b => b.vetoRole === 'UNTYPED');
  const removedRoleUnknown = removedBlind.filter(b => b.vetoRole === null);

  const stats = (vals: number[]): { n: number; wr: string; evS: string; ci: string } => {
    const n = vals.length;
    if (!n) return { n: 0, wr: '-', evS: '-', ci: '-' };
    const [lo, hi] = bootMean(vals);
    return {
      n,
      wr: (100 * vals.filter(v => v > 0).length / n).toFixed(1) + '%',
      evS: (ev(vals) >= 0 ? '+' : '') + ev(vals).toFixed(4) + 'R',
      ci: `[${lo.toFixed(4)}, ${hi.toFixed(4)}]`,
    };
  };

  const mdeLine = (label: string, rem: R[], kep: R[]): void => {
    const rr = rem.map(b => b.rNet), kk = kep.map(b => b.rNet);
    const sigmaP = pooled(ev(rr), ev(kk), rr, kk);
    const mde = 2.8 * sigmaP * Math.sqrt(1 / Math.max(1, rr.length) + 1 / Math.max(1, kk.length));
    console.log(`  ${label}:  MDE ±${mde.toFixed(4)}R  (n_removed=${rr.length}, n_kept=${kk.length}, pooled sigma=${isNaN(sigmaP) ? '-' : sigmaP.toFixed(4)}R)  <-- stated BEFORE point estimates`);
  };

  console.log(`\n===== KK.1 — SHIPPED (ROLE-BLIND) REMOVED COHORT =====`);
  console.log(`  role-blind removed n=${removedBlind.length} | kept n=${keptBlind.length} | retained ${(100 * keptBlind.length / book.length).toFixed(1)}%`);
  mdeLine('SHIPPED (blind)', removedBlind, keptBlind);
  console.log(`  removed (blind) ${JSON.stringify(stats(removedBlind.map(b => b.rNet)))}`);
  console.log(`  kept    (blind) ${JSON.stringify(stats(keptBlind.map(b => b.rNet)))}`);

  console.log(`\n===== KK.2 — REMOVED COHORT SPLIT BY VETOING ZONE'S CANONICAL ROLE =====`);
  for (const [label, sub] of [['role-opposed', removedOpposed], ['role-aligned', removedAligned], ['untyped', removedUntyped], ['role-unknown', removedRoleUnknown]] as const) {
    const st = stats(sub.map(b => b.rNet));
    const rest = book.filter(b => !sub.includes(b));
    mdeLine(`${label} vs rest`, sub, rest);
    console.log(`  ${label.padEnd(14)} n=${String(st.n).padStart(3)}  WR=${st.wr}  EV_net=${st.evS}  mean-CI=${st.ci}`);
    for (const b of sub.slice(0, 8)) console.log(`      ${b.id}  ${new Date(b.ems).toISOString()}  ${b.dir} entry=${b.entry} rNet=${b.rNet.toFixed(4)}  vetoZone=${b.vetoZonePrice} role=${b.vetoDetail}`);
    if (sub.length > 8) console.log(`      ... (+${sub.length - 8} more)`);
  }

  console.log(`\n===== KK.3 — ROLE-AWARE VARIANT vs SHIPPED ROLE-BLIND (BB.2, unchanged criterion) =====`);
  const verdict = (name: string, rem: R[], kep: R[]): void => {
    const rr = rem.map(b => b.rNet), kk = kep.map(b => b.rNet);
    const remEv = ev(rr), kepEv = ev(kk);
    const [, remHi] = bootMean(rr);
    const retained = 100 * kep.length / book.length;
    const failed: string[] = [];
    if (!(kepEv > whole)) failed.push(`(i) kept ${kepEv.toFixed(4)} <= whole ${whole.toFixed(4)}`);
    if (!(remEv < -0.15)) failed.push(`(ii) removed ${remEv.toFixed(4)} not < -0.15R`);
    else if (!(remHi < 0)) failed.push(`(ii) removed mean-CI upper ${remHi.toFixed(4)} not < 0`);
    if (!(retained >= 65)) failed.push(`(iii) retained ${retained.toFixed(1)}% < 65%`);
    console.log(`  ${name}: removed n=${rr.length} EV=${remEv.toFixed(4)}R | kept n=${kk.length} EV=${kepEv.toFixed(4)}R | retained ${retained.toFixed(1)}%  ->  ${failed.length === 0 ? 'QUALIFIES' : 'FAILS -> ' + failed.join('; ')}`);
  };

  const keptRoleAwareOpp = book.filter(b => !(b.snapVeto && !b.fp && b.vetoRole === 'OPPOSED'));
  const keptRoleAwareOppUntyped = book.filter(b => !(b.snapVeto && !b.fp && (b.vetoRole === 'OPPOSED' || b.vetoRole === 'UNTYPED')));

  mdeLine('ROLE-AWARE (opposed only)', removedOpposed, keptRoleAwareOpp);
  verdict('ROLE-AWARE remove ONLY canonically-OPPOSED', removedOpposed, keptRoleAwareOpp);
  mdeLine('ROLE-AWARE (opposed+untyped)', [...removedOpposed, ...removedUntyped], keptRoleAwareOppUntyped);
  verdict('ROLE-AWARE remove OPPOSED + UNTYPED (sensitivity)', [...removedOpposed, ...removedUntyped], keptRoleAwareOppUntyped);
  verdict('SHIPPED role-blind (reference)', removedBlind, keptBlind);

  console.log(`\n===== KK.4 — RECOMMENDATION (judged against the UNCHANGED BB.2 criterion) =====`);
  console.log('  The recommendation below is a MEASUREMENT OUTPUT only. The shipped veto is unchanged;');
  console.log('  any adoption would have to pass a future pre-registered round against the same criterion.');
  const oppSt = stats(removedOpposed.map(b => b.rNet));
  const aliSt = stats(removedAligned.map(b => b.rNet));
  const untSt = stats(removedUntyped.map(b => b.rNet));
  console.log(`  role-opposed removed EV=${oppSt.evS} (n=${oppSt.n}) | role-aligned removed EV=${aliSt.evS} (n=${aliSt.n}) | untyped removed EV=${untSt.evS} (n=${untSt.n})`);
  console.log('  If role-aligned + untyped removals carry materially better EV than role-opposed removals,');
  console.log('  the role-blind veto is suppressing value; the role-aware variant that best satisfies BB.2');
  console.log('  above is the candidate to PRE-REGISTER — not to ship.');

  console.log(`\n  KK SCOPE: measurement + pre-registered recommendation ONLY. Nothing changes live this round.`);
}

main().catch((e: unknown) => { console.error('ITEM KK FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
