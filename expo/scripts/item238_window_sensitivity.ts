/**
 * ITEM M (D2+D3) — ROLE-WINDOW SENSITIVITY + MATCHED CLASS PROTECTION.
 * M.1: G.2 acceptance tests at 24h / 48h / 7d / full-history windows.
 * M.2: G.3 counterfactual at 48h and 7d.
 * M.3: matched at-extreme class (chase_position >= 0.85 via K.1 day-start OHLC method,
 *      opposing_zone_fraction <= 0.10 from the stored snapshot) — n, EV, flips per window.
 * Measurement only; nothing ships.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import { classifyZone } from './item235_side_aware';
import type { SnapZone } from './item234_band_veto';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Bar { t: number; o: number; h: number; l: number; c: number }
const HOUR = 3600_000, DAY = 24 * HOUR;
const WINDOWS: { label: string; ms: number | null }[] = [{ label: '24h', ms: 24 * HOUR }, { label: '48h', ms: 48 * HOUR }, { label: '7d', ms: 7 * DAY }, { label: 'full', ms: null }];

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }
const lb = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].t < t) lo = m + 1; else hi = m; } return lo; };
const ev = (v: number[]): number => v.reduce((x, y) => x + y, 0) / v.length;

/** side-aware role within a bounded window ending at cutoff. */
function classifyWindow(bars: Bar[], cutoff: number, windowMs: number | null, price: number): string {
  const start = windowMs === null ? 0 : cutoff - windowMs;
  const sub = bars.slice(lb(bars, start), lb(bars, cutoff)).map(b => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c }));
  return classifyZone(sub, cutoff, price).role;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM M — WINDOW SENSITIVITY + MATCHED CLASS PROTECTION'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  PRE-STATED MDE (M.2 per run): 2.80*sigma_p*sqrt(1/nf+1/ns); band +/-0.35..0.55R at expected split ~30/190, sigma 1.0..1.5R — stated BEFORE results.');

  const all: { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; sr_zones_snapshot: SnapZone[] | string | null }[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,sr_zones_snapshot').order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(String(error.message));
    all.push(...(data ?? []) as typeof all);
    if ((data?.length ?? 0) < 1000) break;
  }
  const bars: Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close').order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(String(error.message));
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[]) bars.push({ t: new Date(r.timestamp).getTime(), o: +r.open, h: +r.high, l: +r.low, c: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  const barsEnd = bars[bars.length - 1].t;

  // ── M.1: both failure zone-sets at four windows ──
  const t1Cutoff = Date.parse('2026-08-27T02:15:56Z');
  const sig2 = all.find(s => s.emitted_at.startsWith('2026-08-27T10:37:1'));
  const z2: SnapZone[] = sig2 ? (typeof sig2.sr_zones_snapshot === 'string' ? JSON.parse(sig2.sr_zones_snapshot) : (sig2.sr_zones_snapshot ?? [])) : [];
  const c2 = sig2 ? new Date(sig2.emitted_at).getTime() : 0;
  for (const label of ['TEST 1 (02:15Z zones, cutoff 02:15:56Z)', 'TEST 2 (10:37Z snapshot zones, cutoff 10:37:16Z)']) {
    console.log(`\nM.1 ${label}`);
    const zones = label.startsWith('TEST 1') ? [4641.6, 4636.9, 4635.9, 4635.3, 4633.2].map(p => ({ price: p })) : z2.filter(z => [4583.2, 4580.9, 4579.9, 4597, 4598.3].includes(Number(z.price))).map(z => ({ price: Number(z.price), type: z.type }));
    const cut = label.startsWith('TEST 1') ? t1Cutoff : c2;
    for (const w of WINDOWS) {
      const roles = zones.map(z => `${Number(z.price).toFixed(1)}:${classifyWindow(bars, cut, w.ms, Number(z.price)).replace('RESISTANCE', 'RES').replace('SUPPORT', 'SUP')}${z.type ? ` (stored ${(z.type as string).slice(0, 3)})` : ''}`).join('  ');
      console.log(`  ${w.label.padEnd(5)} ${roles}`);
    }
  }

  // ── resolve whole book once ──
  interface B { id: string; dir: 'BUY' | 'SELL'; entry: number; tp1: number; ems: number; zones: SnapZone[] | null; rNet: number | null }
  const book: B[] = [];
  for (const s of all) {
    const ems = new Date(s.emitted_at).getTime();
    const windowEnd = Math.min(ems + 8 * HOUR, barsEnd);
    const wb = bars.slice(lb(bars, ems - 60_000), lb(bars, windowEnd)).map(b => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c }));
    const cov = wb.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * HOUR).length;
    if (cov < 100 || wb.length === 0) continue;
    const zones = typeof s.sr_zones_snapshot === 'string' ? JSON.parse(s.sr_zones_snapshot) as SnapZone[] : s.sr_zones_snapshot;
    const sig = { id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: s.direction === 'SELL' ? 'SELL' : 'BUY', entryPrice: +s.entry, entryPriceWithSlippage: +s.entry, tp1: +s.tp1, tp2: +s.tp2, tp3: +s.tp3, sl: +s.sl, confidence: +s.confidence, status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false } as unknown as TradingSignal;
    const r = resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd });
    const decided = r.outcomeResult !== null;
    book.push({ id: s.signal_id, dir: sig.type as 'BUY' | 'SELL', entry: +s.entry, tp1: +s.tp1, ems, zones: zones ?? null, rNet: decided ? computeRNet(sig.type as 'BUY' | 'SELL', +s.entry, r.exitPrice, Math.abs(+s.entry - +s.sl)) : null });
  }
  const dec = book.filter(b => b.rNet !== null && b.zones !== null);
  const qualifying = (z: SnapZone): boolean => Number(z.touches) >= 10 && Number(z.reactionStrength) >= 0.5;
  const inBand = (b: B, z: SnapZone): boolean => {
    const tp1d = Math.abs(b.tp1 - b.entry);
    return b.dir === 'BUY' ? z.price >= b.entry - 1.0 && z.price <= b.entry + tp1d : z.price <= b.entry + 1.0 && z.price >= b.entry - tp1d;
  };

  // ── M.2: counterfactual at 48h and 7d ──
  const flipSets = new Map<string, Set<string>>();
  for (const w of [WINDOWS[1], WINDOWS[2]]) {
    const flipped: number[] = []; const same: number[] = []; const ids: string[] = [];
    for (const b of dec) {
      const legacyOpposes = b.zones!.some(z => qualifying(z) && inBand(b, z) && ((b.dir === 'BUY' && z.type === 'RESISTANCE') || (b.dir === 'SELL' && z.type === 'SUPPORT')));
      let awareOpposes = false;
      for (const z of b.zones!) {
        if (!qualifying(z) || !inBand(b, z)) continue;
        const role = classifyWindow(bars, b.ems, w.ms, z.price);
        if ((b.dir === 'BUY' && role === 'RESISTANCE') || (b.dir === 'SELL' && role === 'SUPPORT')) { awareOpposes = true; break; }
      }
      if (awareOpposes !== legacyOpposes) { flipped.push(b.rNet!); ids.push(b.id); } else same.push(b.rNet!);
    }
    flipSets.set(w.label, new Set(ids));
    const pool = [...flipped, ...same];
    const sigmaP = Math.sqrt(pool.reduce((a, r) => a + (r - ev(pool)) ** 2, 0) / (pool.length - 1));
    const rnd = mulberry32(20260828);
    const boots: number[] = [];
    for (let i = 0; i < 20000; i++) {
      let sf = 0, ss = 0;
      for (let t = 0; t < flipped.length; t++) sf += flipped[(rnd() * flipped.length) | 0];
      for (let t = 0; t < same.length; t++) ss += same[(rnd() * same.length) | 0];
      boots.push(ss / same.length - sf / flipped.length);
    }
    boots.sort((a, b) => a - b);
    console.log(`\nM.2 counterfactual @ ${w.label}: WOULD-FLIP n=${flipped.length} WR=${(100 * flipped.filter(x => x > 0).length / flipped.length).toFixed(1)}% EV=${ev(flipped).toFixed(4)}R | UNCHANGED n=${same.length} WR=${(100 * same.filter(x => x > 0).length / same.length).toFixed(1)}% EV=${ev(same).toFixed(4)}R`);
    console.log(`   diff ${(ev(same) - ev(flipped) >= 0 ? '+' : '') + (ev(same) - ev(flipped)).toFixed(4)}R; boot CI [${boots[(boots.length * 0.025) | 0].toFixed(4)}, ${boots[(boots.length * 0.975) | 0].toFixed(4)}]; MDE +/-${(2.8 * sigmaP * Math.sqrt(1 / flipped.length + 1 / same.length)).toFixed(4)}R`);
  }

  // ── M.3: matched at-extreme class (K.1 day-start method) ──
  const members: B[] = [];
  for (const b of dec) {
    const dayStart = Date.UTC(new Date(b.ems).getUTCFullYear(), new Date(b.ems).getUTCMonth(), new Date(b.ems).getUTCDate());
    const dayBars = bars.filter(x => x.t >= dayStart && x.t < b.ems);
    if (dayBars.length < 30) continue;
    const dHi = Math.max(...dayBars.map(x => x.h)), dLo = Math.min(...dayBars.map(x => x.l));
    if (dHi - dLo < 3) continue;
    const cp = (b.entry - dLo) / (dHi - dLo);
    const z = b.zones!;
    const opp = z.filter(zz => (b.dir === 'BUY' ? zz.type === 'RESISTANCE' : zz.type === 'SUPPORT')).length / z.length;
    if (cp >= 0.85 && opp <= 0.10) members.push(b);
  }
  console.log(`\nM.3 MATCHED at-extreme class (chase_position>=0.85 day-start OHLC AND opposing_zone_fraction<=0.10):`);
  console.log(`   n=${members.length} WR=${(100 * members.filter(m => m.rNet! > 0).length / members.length).toFixed(1)}% EV=${ev(members.map(m => m.rNet!)).toFixed(4)}R total=${members.map(m => m.rNet!).reduce((x, y) => x + y, 0).toFixed(2)}R`);
  for (const [label, set] of flipSets) console.log(`   flips @${label}: ${members.filter(m => set.has(m.id)).length} of ${members.length}`);
  console.log(`   provisional slice comparison: n=24 EV+0.1345R (provisional) vs canonical above — canonical wins.`);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
