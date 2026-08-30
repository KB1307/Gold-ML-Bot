/**
 * ITEM L (D1) — E.1 ERA-CLEAN RE-DERIVATION: snapshot-bearing decided signals ONLY.
 * Same rule and instrument as item234 (bandVetoHit, real resolver, shared evCompute).
 * Also characterises the no-snapshot cohort (n, era span, EV) that caused the confound.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import { bandVetoHit } from './item234_band_veto';
import type { SnapZone } from './item234_band_veto';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; sr_zones_snapshot: SnapZone[] | string | null }

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }
const lb = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };

function statLine(label: string, vals: number[]): string {
  const n = vals.length; const wr = n ? (vals.filter(v => v > 0).length / n) * 100 : NaN;
  const ev = n ? vals.reduce((x, y) => x + y, 0) / n : NaN; const tot = vals.reduce((x, y) => x + y, 0);
  return `  ${label.padEnd(34)} n=${String(n).padStart(4)}  WR=${isNaN(wr) ? ' - ' : wr.toFixed(1) + '%'}  EV_net=${(ev >= 0 ? '+' : '') + ev.toFixed(4)}R  total=${(tot >= 0 ? '+' : '') + tot.toFixed(2)}R`;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM L — E.1 ERA-CLEAN RE-DERIVATION (snapshot-bearing decided ONLY)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  PRE-STATED MDE: 2.80*sigma_p*sqrt(1/nv+1/nk), 80%/5%; clean split expected ~80/138 -> pre-run band +/-0.28..0.42R (sigma 1.0..1.5R). Stated BEFORE results.');

  const all: Row[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,sr_zones_snapshot').or("closed_market_emission.is.null,closed_market_emission.eq.false").order('emitted_at', { ascending: true }).range(o, o + 999);
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
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[]) bars.push({ timestamp: new Date(r.timestamp).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  interface R { id: string; dir: 'BUY' | 'SELL'; entry: number; tp1: number; ems: number; zones: SnapZone[] | null; rNet: number | null }
  const book: R[] = [];
  for (const s of all) {
    const ems = new Date(s.emitted_at).getTime();
    const windowEnd = Math.min(ems + 8 * 3600_000, barsEndMs);
    const wb = bars.slice(lb(bars, ems - 60_000), lb(bars, windowEnd));
    const cov = wb.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
    if (cov < 100 || wb.length === 0) continue;
    const zones = typeof s.sr_zones_snapshot === 'string' ? JSON.parse(s.sr_zones_snapshot) as SnapZone[] : s.sr_zones_snapshot;
    const sig = { id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: s.direction === 'SELL' ? 'SELL' : 'BUY', entryPrice: +s.entry, entryPriceWithSlippage: +s.entry, tp1: +s.tp1, tp2: +s.tp2, tp3: +s.tp3, sl: +s.sl, confidence: +s.confidence, status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false } as unknown as TradingSignal;
    const r = resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd });
    const decided = r.outcomeResult !== null;
    book.push({ id: s.signal_id, dir: sig.type as 'BUY' | 'SELL', entry: +s.entry, tp1: +s.tp1, ems, zones: zones ?? null, rNet: decided ? computeRNet(sig.type as 'BUY' | 'SELL', +s.entry, r.exitPrice, Math.abs(+s.entry - +s.sl)) : null });
  }
  const dec = book.filter(b => b.rNet !== null);
  const clean = dec.filter(b => b.zones !== null);
  const noSnap = dec.filter(b => b.zones === null);
  console.log(`  decided=${dec.length} | snapshot-bearing (CLEAN)=${clean.length} | no-snapshot=${noSnap.length}`);
  const ev = (v: number[]): number => v.reduce((x, y) => x + y, 0) / v.length;

  const runSplit = (mt: number, mrs: number): { v: R[]; k: R[] } => {
    const v = clean.filter(b => bandVetoHit(b.dir, b.entry, b.tp1, b.zones, mt, mrs) !== null);
    return { v, k: clean.filter(b => !v.includes(b)) };
  };
  const { v, k } = runSplit(10, 0.5);
  const pool = [...v, ...k];
  const sigmaP = Math.sqrt(pool.reduce((a, r) => a + (r.rNet! - ev(pool.map(x => x.rNet!))) ** 2, 0) / (pool.length - 1));
  const rnd = mulberry32(20260828);
  const boots: number[] = [];
  for (let i = 0; i < 20000; i++) {
    let sv = 0, sk = 0;
    for (let t = 0; t < v.length; t++) sv += v[(rnd() * v.length) | 0].rNet!;
    for (let t = 0; t < k.length; t++) sk += k[(rnd() * k.length) | 0].rNet!;
    boots.push(sk / k.length - sv / v.length);
  }
  boots.sort((a, b) => a - b);
  console.log(`\nCLEAN HEADLINE (touches>=10, rs>=0.5):`);
  console.log(`  MDE realised: sigma_pooled=${sigmaP.toFixed(3)}R -> +/-${(2.8 * sigmaP * Math.sqrt(1 / v.length + 1 / k.length)).toFixed(4)}R (n_v=${v.length}, n_k=${k.length})`);
  console.log(statLine('VETOED (clean)', v.map(r => r.rNet!)));
  console.log(statLine('KEPT (clean)', k.map(r => r.rNet!)));
  for (const d of ['BUY', 'SELL'] as const) {
    const dv = v.filter(r => r.dir === d), dk = k.filter(r => r.dir === d);
    console.log(`    ${d}: VETOED n=${dv.length} EV=${dv.length ? ev(dv.map(x => x.rNet!)).toFixed(4) : '-'} | KEPT n=${dk.length} EV=${dk.length ? ev(dk.map(x => x.rNet!)).toFixed(4) : '-'}`);
  }
  const diff = ev(k.map(r => r.rNet!)) - ev(v.map(r => r.rNet!));
  console.log(`  diff ${(diff >= 0 ? '+' : '') + diff.toFixed(4)}R; boot 20k CI [${boots[(boots.length * 0.025) | 0].toFixed(4)}, ${boots[(boots.length * 0.975) | 0].toFixed(4)}]`);
  const live = clean.filter(b => (b.zones ?? []).some(z => z?.tier === 'TIER_0_SERVER'));
  const lv = live.filter(b => bandVetoHit(b.dir, b.entry, b.tp1, b.zones, 10, 0.5));
  const lk = live.filter(b => !lv.includes(b));
  console.log(statLine('LIVE VETOED', lv.map(r => r.rNet!)));
  console.log(statLine('LIVE KEPT', lk.map(r => r.rNet!)));
  console.log(`\n12-POINT GRID (clean population):`);
  console.log('  touches   rs | n_V  EV_V | n_K  EV_K | diff');
  for (const mt of [5, 10, 20, 40]) for (const mrs of [0.3, 0.5, 0.7]) {
    const s2 = runSplit(mt, mrs);
    const evV = s2.v.length ? ev(s2.v.map(x => x.rNet!)) : NaN;
    const evK = s2.k.length ? ev(s2.k.map(x => x.rNet!)) : NaN;
    const df = evK - evV;
    console.log(`  ${String(mt).padStart(7)} ${mrs.toFixed(1)} | ${String(s2.v.length).padStart(3)} ${isNaN(evV) ? '  -    ' : (evV >= 0 ? '+' : '') + evV.toFixed(4)} | ${String(s2.k.length).padStart(4)} ${isNaN(evK) ? '  -    ' : (evK >= 0 ? '+' : '') + evK.toFixed(4)} | ${(df >= 0 ? '+' : '') + df.toFixed(4)} ${df > 0 ? 'KEPT>V' : df < 0 ? 'V>KEPT' : 'flat'}`);
  }
  const sigmaV = Math.sqrt(v.reduce((a, r) => a + (r.rNet! - ev(v.map(x => x.rNet!))) ** 2, 0) / Math.max(1, v.length - 1));
  const nVneeded = Math.ceil((1.96 * sigmaV / Math.abs(ev(v.map(r => r.rNet!)))) ** 2);
  console.log(`\nE.2 REQUIRED-N (clean): EV_v=${ev(v.map(r => r.rNet!)).toFixed(4)}, sigma_v=${sigmaV.toFixed(3)} -> n_v >= ${nVneeded}; clean fire rate ${(100 * v.length / clean.length).toFixed(1)}% -> ~${Math.ceil(nVneeded / (v.length / clean.length))} more decided snapshot-bearing signals (total ~${clean.length + Math.ceil(nVneeded / (v.length / clean.length))})`);
  const emsNo = noSnap.map(r => r.ems);
  console.log(`\nNO-SNAPSHOT COHORT (the confound): n=${noSnap.length}, era ${emsNo[0]} .. ${emsNo[emsNo.length - 1]}`);
  console.log(statLine('no-snapshot cohort EV', noSnap.map(r => r.rNet!)));
  console.log(`  DELTAS vs era-mixed round: VETOED ${ev(v.map(r => r.rNet!)).toFixed(4)} vs -0.1825 | KEPT ${ev(k.map(r => r.rNet!)).toFixed(4)} vs +0.0567 | diff ${diff.toFixed(4)} vs +0.2392`);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
