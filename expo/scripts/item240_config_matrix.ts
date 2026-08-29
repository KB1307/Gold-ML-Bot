/**
 * ITEM W — CANONICAL CONFIGURATION DERIVATION on the era-clean canonical
 * population (snapshot-bearing decided, real resolver — same instrument as
 * item237_era_clean.ts).
 *
 * Configs (prompt-defined): A snapshot-veto & !fp | B M15-veto & !fp |
 * C union & !fp | D both-agree & !fp.
 *
 * NAMED BLOCKER, stated up front: the P-round momentum-fingerprint (fp)
 * instrument is ABSENT from this tree — no script, artifact, ledger row or
 * engine constant defines it (greps: "momentum fingerprint", fp_exempt,
 * retype_verdict — empty; migrations end at 017; no P/Q/R artifacts). The
 * !fp conditioning therefore CANNOT be applied. Everything below is reported
 * UNCONDITIONED-ON-fp and labelled as such; A-D as literally defined are
 * BLOCKED on that instrument.
 *
 * Pre-stated power: MDE = 2.80 * sigma_p * sqrt(1/n_removed + 1/n_kept);
 * bootstrap 20k, seed 20260828 (same as item237).
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import { bandVetoHit } from './item234_band_veto';
import type { SnapZone } from './item234_band_veto';
import { buildM15Zones, m15OpposedHit, m15EndorsedHit, type M1Bar } from '../services/m15ZoneLayer';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; sr_zones_snapshot: SnapZone[] | string | null }
interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface R { id: string; dir: 'BUY' | 'SELL'; entry: number; tp1: number; ems: number; zones: SnapZone[] | null; rNet: number | null; snapVeto: boolean; m15Opp: boolean | null; m15End: boolean | null; m15Zone: string }

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const lbR = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };
const lbM = (bars: M1Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].ts < t) lo = m + 1; else hi = m; } return lo; };
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

function statLine(label: string, vals: number[]): string {
  const n = vals.length; const wr = n ? (vals.filter(v => v > 0).length / n) * 100 : NaN;
  return `  ${label.padEnd(30)} n=${String(n).padStart(4)}  WR=${isNaN(wr) ? ' - ' : wr.toFixed(1) + '%'}  EV_net=${n ? ((ev(vals) >= 0 ? '+' : '') + ev(vals).toFixed(4)) : '  -   '}R  total=${n ? ((vals.reduce((x, y) => x + y, 0) >= 0 ? '+' : '') + vals.reduce((x, y) => x + y, 0).toFixed(2)) : '  -  '}R`;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM W — CANONICAL CONFIGURATION DERIVATION (era-clean, real resolver; UNCONDITIONED-ON-fp)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  PRE-STATED MDE: 2.80*sigma_p*sqrt(1/nr+1/nk); expected removed-share 18-55% of n=218 -> MDE band ~+/-0.35..0.75R. Stated BEFORE results.');
  console.log('  BLOCKER (named): P-round momentum-fingerprint instrument ABSENT from tree -> !fp conditioning NOT applied; configs reported unconditioned.');

  const all: Row[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,sr_zones_snapshot').order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(String(error.message));
    all.push(...(data ?? []) as Row[]);
    if ((data?.length ?? 0) < 1000) break;
  }
  const { data: ends } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(ends?.[0]?.timestamp)).getTime();
  const minEms = Math.min(...all.map(r => new Date(r.emitted_at).getTime()));
  const barsR: Bar[] = [];
  const m1: M1Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close').gte('timestamp', new Date(minEms - 17 * 86_400_000).toISOString()).lte('timestamp', new Date(barsEndMs).toISOString()).order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(String(error.message));
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[]) {
      const ts = new Date(r.timestamp).getTime();
      barsR.push({ timestamp: ts, open: +r.open, high: +r.high, low: +r.low, close: +r.close });
      m1.push({ ts, o: +r.open, h: +r.high, l: +r.low, c: +r.close });
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  signals=${all.length}  bars=${barsR.length} (from ${new Date(barsR[0]?.timestamp ?? 0).toISOString()})`);

  const book: R[] = [];
  let m15Insufficient = 0;
  for (const s of all) {
    const ems = new Date(s.emitted_at).getTime();
    const windowEnd = Math.min(ems + 8 * 3600_000, barsEndMs);
    const wb = barsR.slice(lbR(barsR, ems - 60_000), lbR(barsR, windowEnd));
    const cov = wb.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
    if (cov < 100 || wb.length === 0) continue;
    const zones = typeof s.sr_zones_snapshot === 'string' ? JSON.parse(s.sr_zones_snapshot) as SnapZone[] : s.sr_zones_snapshot;
    const sig = { id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: s.direction === 'SELL' ? 'SELL' : 'BUY', entryPrice: +s.entry, entryPriceWithSlippage: +s.entry, tp1: +s.tp1, tp2: +s.tp2, tp3: +s.tp3, sl: +s.sl, confidence: +s.confidence, status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false } as unknown as TradingSignal;
    const r = resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd });
    const decided = r.outcomeResult !== null;
    if (!decided) continue;
    const snapVeto = bandVetoHit(sig.type as 'BUY' | 'SELL', +s.entry, +s.tp1, zones ?? null, 10, 0.5) !== null;
    let m15Opp: boolean | null = null, m15End: boolean | null = null, m15Zone = '-';
    const built = buildM15Zones(m1.slice(0, lbM(m1, ems)), ems);
    if (built && built.tradingDays >= 14) {
      const dir = sig.type as 'BUY' | 'SELL';
      const o = m15OpposedHit(built.zones, dir, +s.entry, +s.tp1);
      const e = m15EndorsedHit(built.zones, dir, +s.entry, +s.tp1);
      m15Opp = o !== null; m15End = e !== null;
      m15Zone = o ? `${o.lo.toFixed(1)}-${o.hi.toFixed(1)} ${o.role} n=${o.n} rb=${o.rb} ra=${o.ra}` : (e ? `endorse ${e.lo.toFixed(1)}-${e.hi.toFixed(1)}` : '-');
    } else m15Insufficient += 1;
    book.push({ id: s.signal_id, dir: sig.type as 'BUY' | 'SELL', entry: +s.entry, tp1: +s.tp1, ems, zones: zones ?? null, rNet: computeRNet(sig.type as 'BUY' | 'SELL', +s.entry, r.exitPrice, Math.abs(+s.entry - +s.sl)), snapVeto, m15Opp, m15End, m15Zone });
  }
  const clean = book.filter(b => b.zones !== null);
  const m15ok = clean.filter(b => b.m15Opp !== null);
  console.log(`\nPOPULATION: decided=${book.length} | snapshot-bearing (CANONICAL)=${clean.length} | M15-evaluable=${m15ok.length} | M15-insufficient=${m15Insufficient}`);
  const whole = ev(clean.map(b => b.rNet!));
  console.log(`  WHOLE-BOOK (clean): EV_net=${(whole >= 0 ? '+' : '') + whole.toFixed(4)}R`);

  const report = (label: string, removed: R[], kept: R[]): void => {
    const rr = removed.map(b => b.rNet!), kk = kept.map(b => b.rNet!);
    const [clo, chi] = removed.length && kept.length ? ciSplit(rr, kk) : [NaN, NaN];
    const pool = [...rr, ...kk];
    const sigmaP = pool.length > 1 ? Math.sqrt(pool.reduce((a, r) => a + (r - ev(pool)) ** 2, 0) / (pool.length - 1)) : NaN;
    const mde = 2.8 * sigmaP * Math.sqrt(1 / Math.max(1, rr.length) + 1 / Math.max(1, kk.length));
    console.log(`\nCONFIG ${label}: removed n=${rr.length} EV=${rr.length ? ev(rr).toFixed(4) : '-'} | kept n=${kk.length} EV=${kk.length ? ev(kk).toFixed(4) : '-'} | retained ${(100 * kk.length / (rr.length + kk.length)).toFixed(1)}%`);
    console.log(`  diff (kept-removed)=${(kept.length && removed.length) ? (ev(kk) - ev(rr)).toFixed(4) : '-'}R; boot CI [${clo.toFixed(4)}, ${chi.toFixed(4)}]; MDE +/-${mde.toFixed(4)}R`);
  };
  const A = clean.filter(b => b.snapVeto), notA = clean.filter(b => !b.snapVeto);
  const B = m15ok.filter(b => b.m15Opp), notB = m15ok.filter(b => !b.m15Opp);
  const C = m15ok.filter(b => b.snapVeto || b.m15Opp), notC = m15ok.filter(b => !C.includes(b));
  const D = m15ok.filter(b => b.snapVeto && b.m15Opp), notD = m15ok.filter(b => !D.includes(b));
  console.log('\n===== CONFIGS (ALL UNCONDITIONED-ON-fp — see blocker) =====');
  report('A snapshot-veto', A, notA);
  report('B M15-veto    ', B, notB);
  report('C union       ', C, notC);
  report('D both-agree  ', D, notD);

  console.log('\nD-CELL SIGNAL-BY-SIGNAL (snapshot-veto AND M15-opposed):');
  for (const b of D) console.log(`  ${b.id}  ${new Date(b.ems).toISOString()}  ${b.dir} entry=${b.entry} rNet=${b.rNet!.toFixed(4)}  snap=${(b.zones ?? []).length}z  m15=${b.m15Zone}`);
  if (D.length === 0) console.log('  (empty)');

  console.log('\nW.2 — EXEMPTION-INTERACTION (fp cohort unobtainable; M15-opposed reported directly):');
  for (const d of ['BUY', 'SELL'] as const) {
    const s = B.filter(b => b.dir === d);
    console.log(statLine(`M15-opposed ${d}`, s.map(b => b.rNet!)));
  }
  const endorsed = m15ok.filter(b => b.m15End), notEnd = m15ok.filter(b => !b.m15End);
  console.log('  M15 ENDORSEMENT canonical check (provisional: -0.1808R):');
  console.log(statLine('endorsed', endorsed.map(b => b.rNet!)));
  console.log(statLine('not endorsed', notEnd.map(b => b.rNet!)));

  console.log('\n===== W.3 PRE-REGISTERED SELECTION (criterion check; fp caveat applies to ALL) =====');
  const check = (name: string, rem: R[], kep: R[]): void => {
    const remEv = rem.length ? ev(rem.map(b => b.rNet!)) : NaN;
    const kepEv = kep.length ? ev(kep.map(b => b.rNet!)) : NaN;
    const [, chi] = rem.length && kep.length ? ciSplit(rem.map(b => b.rNet!), kep.map(b => b.rNet!)) : [NaN, NaN];
    const retained = 100 * kep.length / (rem.length + kep.length);
    const i = kepEv > whole, ii = remEv < -0.15 && chi < 0, iii = retained >= 65;
    console.log(`  ${name}: (i) kept ${kepEv.toFixed(4)} > whole ${whole.toFixed(4)}: ${i ? 'PASS' : 'FAIL'} | (ii) removed ${remEv.toFixed(4)} < -0.15 & CIupper ${chi.toFixed(4)} < 0: ${ii ? 'PASS' : 'FAIL'} | (iii) retained ${retained.toFixed(1)}% >= 65%: ${iii ? 'PASS' : 'FAIL'} -> ${i && ii && iii ? 'QUALIFIES' : 'fails'}`);
  };
  check('A', A, notA); check('B', B, notB); check('C', C, notC); check('D', D, notD);
  console.log('\nW.3 VERDICT: see report paragraph — no config is evaluable AS DEFINED (fp blocker); the shipped config stands this round.');
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
