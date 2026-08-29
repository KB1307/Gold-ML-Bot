/**
 * ITEM CC — THE FINGERPRINT'S OWN INPUT: PRIOR-4H WINDOW TRUNCATION, QUANTIFIED
 * (measure ONLY; the shipped computation is NOT patched).
 *
 * THE DEFECT ON RECORD (services/bandProximityVeto.ts:143-158, and the identical
 * A.2 annotation block in emittedSignalService.ts): the 5h pre-emission window is
 * fetched with .order('timestamp', {ascending:true}).limit(250). A 5-hour M1
 * window can hold ~300 bars, so the fetch returns the EARLIEST 250 bars and the
 * window's "current" end can sit tens of minutes BEFORE emission when coverage
 * is dense. The prior-4h momentum reading — one of the three fingerprint inputs,
 * and the fingerprint is what EXEMPTS signals from the shipped veto — therefore
 * varies with bar density.
 *
 * BOTH VARIANTS computed here from the SAME gold_m1_bars (anon key):
 *  (a) AS SHIPPED   : window = [ems-5h, ems); take the FIRST 250 bars (ascending
 *                     order, i.e. the earliest 250 — exactly what .limit(250)
 *                     returns); if <150 bars -> NULL; base = last bar with
 *                     ts <= (last kept bar).ts - 4h (scan-from-start loop, same
 *                     as shipped); last = the last KEPT bar; delta = last - base.
 *  (b) CORRECTED    : window = [ems-5h, ems), UNTRUNCATED; if <150 bars -> NULL
 *                     (same coverage rule); last = the last bar strictly before
 *                     ems (the emission-adjacent bar); base = the LAST bar with
 *                     ts <= last.ts - 4h (scan keeps the latest qualifying bar);
 *                     delta = last - base.
 * Both endpoints are stated exactly here. The fingerprint-ACTIVE state uses the
 * SHIPPED fingerprintActive() with identical rsi and opposing_zone_fraction on
 * both sides — only `agrees` differs between the arms.
 *
 * PROVENANCE NUANCE (stated up front): item241's canonical P.0 re-derivation
 * computed the prior-4h from the FULL window — i.e. the RECORDED gate numbers
 * (GATE-1 -0.2008R n=79; GATE-2 +0.1924R n=4) were measured on (b)-style inputs,
 * while the LIVE shipped veto computes (a)-style inputs at emission. This round
 * measures BOTH fresh on the same population so the divergence is visible.
 *
 * POWER (MINDSET 7): MDE printed BEFORE point estimates; boot 20k, seed 20260828.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import { bandVetoHit } from './item234_band_veto';
import type { SnapZone } from './item234_band_veto';
import { fingerprintActive, opposingZoneFractionOfSnapshot } from '../services/bandProximityVeto';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; rsi: number | null; sr_zones_snapshot: SnapZone[] | string | null }
interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface R { id: string; dir: 'BUY' | 'SELL'; entry: number; tp1: number; ems: number; rNet: number; snapVeto: boolean; rsi: number | null; oppFrac: number | null; agreesA: boolean | null; agreesB: boolean | null; gapMs: number | null }

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }
const lbR = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };
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

function pooledSigma(v1: number[], v2: number[]): number {
  const pool = [...v1, ...v2];
  if (pool.length < 2) return NaN;
  const m = ev(pool);
  return Math.sqrt(pool.reduce((a, r) => a + (r - m) ** 2, 0) / (pool.length - 1));
}

/** (a) AS SHIPPED — simulated .limit(250) ascending fetch over the same bars. */
function prior4hA(bars: Bar[], ems: number, dir: 'BUY' | 'SELL'): { agrees: boolean | null; delta: number | null; gapMs: number | null } {
  const win = bars.slice(lbR(bars, ems - 5 * 3600_000), lbR(bars, ems));
  const ann = win.slice(0, 250); // exactly what .order(asc).limit(250) returns: the EARLIEST 250
  if (ann.length < 150) return { agrees: null, delta: null, gapMs: null };
  const last = ann[ann.length - 1];
  let base = ann[0];
  for (const b of ann) { if (b.timestamp <= last.timestamp - 4 * 3600_000) base = b; else break; }
  const delta = Math.round((last.close - base.close) * 100) / 100;
  return { agrees: dir === 'BUY' ? delta > 0 : delta < 0, delta, gapMs: ems - last.timestamp };
}

/** (b) CORRECTED — full untruncated window; emission-adjacent last bar. */
function prior4hB(bars: Bar[], ems: number, dir: 'BUY' | 'SELL'): { agrees: boolean | null; delta: number | null } {
  const win = bars.slice(lbR(bars, ems - 5 * 3600_000), lbR(bars, ems));
  if (win.length < 150) return { agrees: null, delta: null };
  const last = win[win.length - 1];
  let base = win[0];
  for (const b of win) { if (b.timestamp <= last.timestamp - 4 * 3600_000) base = b; else break; }
  const delta = Math.round((last.close - base.close) * 100) / 100;
  return { agrees: dir === 'BUY' ? delta > 0 : delta < 0, delta };
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM CC — PRIOR-4H WINDOW TRUNCATION AUDIT (variants only; NO patch)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  (a) AS SHIPPED: earliest-250 of the 5h window (simulated .limit(250) ascending)');
  console.log('  (b) CORRECTED : full untruncated window; last = emission-adjacent bar; base = last bar <= last.ts - 4h');
  console.log('  MDE policy: gates print MDE BEFORE point estimates. Boot 20k seed 20260828.');
  console.log('  PROVENANCE NUANCE: recorded P.0 gates (item241) were computed on FULL-window (b-style) inputs; the LIVE veto fetches (a)-style. Both measured fresh below.');

  const all: Row[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,rsi,sr_zones_snapshot').order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`signals: ${error.message}`);
    all.push(...(data ?? []) as Row[]);
    if ((data?.length ?? 0) < 1000) break;
  }
  const { data: ends } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(ends?.[0]?.timestamp)).getTime();
  const minEms = Math.min(...all.map(r => new Date(r.emitted_at).getTime()));
  const bars: Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close').gte('timestamp', new Date(minEms - 60_000).toISOString()).lte('timestamp', new Date(barsEndMs).toISOString()).order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`bars: ${error.message}`);
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[])
      bars.push({ timestamp: new Date(r.timestamp).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  corpus: ${all.length} emitted | ${bars.length} M1 bars to ${new Date(barsEndMs).toISOString()}`);

  const book: R[] = [];
  let exclNoSnap = 0, exclUndecided = 0;
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
    const A = prior4hA(bars, ems, dir);
    const B = prior4hB(bars, ems, dir);
    book.push({
      id: s.signal_id, dir, entry: +s.entry, tp1: +s.tp1, ems, rNet: computeRNet(dir, +s.entry, r.exitPrice, Math.abs(+s.entry - +s.sl)),
      snapVeto: bandVetoHit(dir, +s.entry, +s.tp1, zones, 10, 0.5) !== null,
      rsi: s.rsi === null || s.rsi === undefined ? null : Number(s.rsi),
      oppFrac: opposingZoneFractionOfSnapshot(dir, zones),
      agreesA: A.agrees, agreesB: B.agrees, gapMs: A.gapMs,
    });
  }
  console.log(`  era-clean canonical population: n=${book.length} (excluded: no-snapshot ${exclNoSnap}, undecided/no-coverage ${exclUndecided})`);

  // ── CC.1 — flips, gap distribution, fingerprint-ACTIVE flips ──
  console.log(`\n${line}\nCC.1 — VARIANT COMPARISON\n${line}`);
  const bothA = book.filter(b => b.agreesA !== null), bothB = book.filter(b => b.agreesB !== null);
  const comparable = book.filter(b => b.agreesA !== null && b.agreesB !== null);
  console.log(`  prior-4h computable: (a) AS SHIPPED ${bothA.length}/${book.length} | (b) CORRECTED ${bothB.length}/${book.length} | both ${comparable.length}`);
  const agreeFlips = comparable.filter(b => b.agreesA !== b.agreesB);
  console.log(`  agrees_with_prior_4h_move FLIPS between (a) and (b): ${agreeFlips.length} of ${comparable.length} comparable (${comparable.length ? (100 * agreeFlips.length / comparable.length).toFixed(1) : '-'}%)`);

  const gaps = comparable.map(b => b.gapMs as number).sort((a, b) => a - b);
  const q = (p: number): string => gaps.length ? `${(gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] / 60000).toFixed(1)}min` : '-';
  console.log(`  window-end-to-emission GAP under (a) [the truncation's "stale window"]: 0 bars exactly at emission: ${gaps.filter(g => g === 0).length}`);
  console.log(`    <=5min: ${gaps.filter(g => g <= 5 * 60000).length} | <=15min: ${gaps.filter(g => g <= 15 * 60000).length} | <=30min: ${gaps.filter(g => g <= 30 * 60000).length} | <=50min: ${gaps.filter(g => g <= 50 * 60000).length} | >50min: ${gaps.filter(g => g > 50 * 60000).length}`);
  console.log(`    min=${gaps.length ? (gaps[0] / 60000).toFixed(1) : '-'}min  p25=${q(0.25)}  median=${q(0.5)}  p75=${q(0.75)}  p95=${q(0.95)}  max=${gaps.length ? (gaps[gaps.length - 1] / 60000).toFixed(1) : '-'}min`);

  const fpOf = (b: R, agrees: boolean | null): boolean => fingerprintActive(b.dir, b.rsi, b.oppFrac, agrees);
  const fpA = book.map(b => fpOf(b, b.agreesA)), fpB = book.map(b => fpOf(b, b.agreesB));
  const fpFlips = book.filter((_, i) => fpA[i] !== fpB[i]);
  console.log(`  FINGERPRINT-ACTIVE state flips: ${fpFlips.length} of ${book.length} (${book.length ? (100 * fpFlips.length / book.length).toFixed(1) : '-'}%)`);
  console.log(`    fp active under (a): ${fpA.filter(Boolean).length} | under (b): ${fpB.filter(Boolean).length}`);
  for (const b of fpFlips.slice(0, 12)) console.log(`      flip ${b.id} ${b.dir} rsi=${b.rsi === null ? '-' : b.rsi.toFixed(1)} opp=${b.oppFrac === null ? '-' : b.oppFrac.toFixed(3)} agreesA=${b.agreesA} agreesB=${b.agreesB} rNet=${b.rNet.toFixed(4)}`);

  // ── CC.2 — gates under both variants (MDE FIRST) ──
  console.log(`\n${line}\nCC.2 — GATES UNDER BOTH VARIANTS (recorded P.0 values measured on (b)-style inputs)\n${line}`);
  const gates = (which: 'A' | 'B'): void => {
    const agreesOf = (b: R): boolean | null => which === 'A' ? b.agreesA : b.agreesB;
    const fp = book.map(b => fpOf(b, agreesOf(b)));
    const COND_REM = book.filter((b, i) => b.snapVeto && !fp[i]);
    const COND_KEPT = book.filter((b, i) => !(b.snapVeto && !fp[i]));
    const FPV = book.filter((b, i) => fp[i] && b.snapVeto);
    const label = which === 'A' ? '(a) AS SHIPPED' : '(b) CORRECTED';
    const rem = COND_REM.map(b => b.rNet), kep = COND_KEPT.map(b => b.rNet), fpv = FPV.map(b => b.rNet);
    const sigmaR = pooledSigma(rem, kep);
    const mdeR = 2.8 * sigmaR * Math.sqrt(1 / Math.max(1, rem.length) + 1 / Math.max(1, kep.length));
    const [rlo, rhi] = rem.length >= 2 ? bootMean(rem) : [NaN, NaN];
    const [dlo, dhi] = rem.length && kep.length ? bootDiff(rem, kep) : [NaN, NaN];
    const sigmaF = pooledSigma(fpv, kep);
    const mdeF = 2.8 * sigmaF * Math.sqrt(1 / Math.max(1, fpv.length) + 1 / Math.max(1, kep.length));
    console.log(`\n  ${label}:`);
    console.log(`    GATE-1 (conditional cohort EV < -0.10R):  MDE ±${mdeR.toFixed(4)}R (n_removed=${rem.length}, n_kept=${kep.length})  <-- BEFORE estimates`);
    console.log(`      removed n=${rem.length} WR=${rem.length ? (100 * rem.filter(v => v > 0).length / rem.length).toFixed(1) : '-'}% EV=${rem.length ? ev(rem).toFixed(4) : '-'}R (mean CI [${isNaN(rlo) ? '-' : rlo.toFixed(4)}, ${isNaN(rhi) ? '-' : rhi.toFixed(4)}]) | kept EV=${kep.length ? ev(kep).toFixed(4) : '-'}R | diff ${rem.length && kep.length ? ((ev(kep) - ev(rem) >= 0 ? '+' : '') + (ev(kep) - ev(rem)).toFixed(4)) : '-'}R CI [${isNaN(dlo) ? '-' : dlo.toFixed(4)}, ${isNaN(dhi) ? '-' : dhi.toFixed(4)}]`);
    console.log(`      GATE-1 verdict: ${rem.length ? (ev(rem) < -0.10 ? 'PASS' : 'FAIL') : 'n/a (empty)'} under this variant`);
    console.log(`    GATE-2 (fp-AND-vetoable EV > 0):  MDE ±${mdeF.toFixed(4)}R (n=${fpv.length})  <-- BEFORE estimates (n is TINY — read with M.7 discipline)`);
    console.log(`      n=${fpv.length} WR=${fpv.length ? (100 * fpv.filter(v => v > 0).length / fpv.length).toFixed(1) : '-'}% EV=${fpv.length ? ((ev(fpv) >= 0 ? '+' : '') + ev(fpv).toFixed(4)) : '-'}R | GATE-2 verdict: ${fpv.length ? (ev(fpv) > 0 ? 'PASS' : 'FAIL') : 'n/a (empty)'}`);
    for (const b of FPV) console.log(`        ${b.id} ${new Date(b.ems).toISOString()} ${b.dir} rNet=${b.rNet.toFixed(4)}`);
  };
  gates('A');
  gates('B');

  console.log(`\n  SHIP-DECISION PROVENANCE: the recorded GATE-1 -0.2008R (n=79) / GATE-2 +0.1924R (n=4) came from item241, which computed the prior-4h on the FULL window = (b)-style inputs. The LIVE veto computes (a)-style at emission. If the fresh (b) numbers reproduce the recorded gates and the fresh (a) numbers do not, the gate that authorised the ship was measured on a DIFFERENT input than the one that runs live — stated plainly in the report.`);
  console.log(`  CC SCOPE: measurement + recommendation ONLY. The shipped computation is NOT patched this round.`);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
