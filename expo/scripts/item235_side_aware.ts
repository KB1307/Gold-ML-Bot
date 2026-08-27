/**
 * ITEMS G.2 + G.3 — SIDE-AWARE ZONE ROLES (measurement only; NO engine change).
 *
 * Reference method (as pre-registered in the prompt): a touch event = price entering
 * [Z-w, Z+w] from outside (w=0.8); approach side from the PRIOR bar's close; outcome
 * = first exit side within 15 bars -> REJ_FROM_BELOW / REJ_FROM_ABOVE / BREAK_UP /
 * BREAK_DOWN. Role = majority of rejections with last-5 events double weight.
 * gold_m1_bars ONLY, strictly before each signal's cutoff (generation-time discipline).
 *
 * G.2 TEST 1: zones 4641.6/4636.9/4635.9/4635.3/4633.2 with bars < 2026-08-27T02:15:56Z.
 * G.2 TEST 2: the 10:37:16Z signal's own snapshot zones with bars < its emitted_at.
 * G.3: whole-book counterfactual — retype every decided signal's snapshot zones, report
 *      flip counts and cohort EVs (real-resolver rNet recomputed here), at-extreme/
 *      one-sided class restricted split. MDE stated first. NOTHING SHIPS FROM THIS.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
interface SnapZone { price: number; touches: number; reactionStrength: number; type?: string; rejectionsFromBelow?: number; rejectionsFromAbove?: number }
const W = 0.8, OUTCOME_BARS = 15;

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync(`${__dirname}/../.env`, 'utf8').split('\n')) {
      const t = line.trim(); const eq = t.indexOf('=');
      if (t && !t.startsWith('#') && eq > 0) env[t.slice(0, eq)] = t.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  } catch { /* fall back */ }
  return env;
}
const lb = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };

interface TouchEv { label: 'REJ_FROM_BELOW' | 'REJ_FROM_ABOVE' | 'BREAK_UP' | 'BREAK_DOWN'; ts: number }

/** Reference classifier over bars STRICTLY BEFORE cutoff. */
export function classifyZone(bars: Bar[], cutoffMs: number, zPrice: number): { role: 'SUPPORT' | 'RESISTANCE' | 'NEUTRAL'; events: TouchEv[] } {
  const events: TouchEv[] = [];
  let i = lb(bars, cutoffMs) - 1;
  if (i < 1) return { role: 'NEUTRAL', events };
  let inside = Math.abs(bars[i].close - zPrice) < W;
  for (; i >= 1; i--) {
    const b = bars[i], prev = bars[i - 1];
    const insideNow = Math.abs(b.close - zPrice) < W || (b.low - W < zPrice && b.high + W > zPrice && Math.min(Math.abs(b.high - zPrice), Math.abs(b.low - zPrice)) < W);
    if (!inside && insideNow) {
      const fromBelow = prev.close < zPrice - W;
      let j = i; let outcome: 'REJ_FROM_BELOW' | 'REJ_FROM_ABOVE' | 'BREAK_UP' | 'BREAK_DOWN' | null = null;
      for (let k = 0; k < OUTCOME_BARS && j - k >= 0; k++) {
        const bb = bars[j - k];
        if (bb.close > zPrice + W) { outcome = fromBelow ? 'BREAK_UP' : 'REJ_FROM_ABOVE'; break; }
        if (bb.close < zPrice - W) { outcome = fromBelow ? 'REJ_FROM_BELOW' : 'BREAK_DOWN'; break; }
      }
      events.push({ label: outcome ?? (fromBelow ? 'REJ_FROM_BELOW' : 'REJ_FROM_ABOVE'), ts: b.timestamp });
    }
    inside = insideNow;
  }
  let rejB = 0, rejA = 0;
  const n = events.length;
  for (let idx = 0; idx < n; idx++) {
    const e = events[idx];
    const weight = idx >= n - 5 ? 2 : 1; // last-5-events double weight (list is newest-first)
    if (e.label === 'REJ_FROM_BELOW') rejB += weight;
    else if (e.label === 'REJ_FROM_ABOVE') rejA += weight;
  }
  const role = rejB > rejA ? 'RESISTANCE' : rejA > rejB ? 'SUPPORT' : 'NEUTRAL';
  return { role, events };
}

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const client = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEMS G.2 + G.3 — SIDE-AWARE ZONE ROLES (reference method, gold_m1_bars only)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log(`  PRE-STATED G.3 MDE (80%/5%): 2.80*sigma_p*sqrt(1/n_flip+1/n_same); pre-run band +/-0.2..0.35R at expected split ~40/400, sigma 1.0..1.5R — stated BEFORE results`);

  // ── corpus ──
  const all: { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; sr_zones_snapshot: SnapZone[] | string | null }[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1')
      .select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,sr_zones_snapshot')
      .order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`signals: ${error.message}`);
    all.push(...(data ?? []) as typeof all);
    if ((data?.length ?? 0) < 1000) break;
  }
  const bars: Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close')
      .order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`bars: ${error.message}`);
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[])
      bars.push({ timestamp: new Date(r.timestamp).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  const barsEndMs = bars[bars.length - 1].timestamp;
  console.log(`  corpus: ${all.length} emitted | ${bars.length} bars to ${new Date(barsEndMs).toISOString()}`);

  // ── G.2 TEST 1 ──
  const t1Cutoff = Date.parse('2026-08-27T02:15:56Z');
  const t1BarsEnd = lb(bars, t1Cutoff);
  const t1Bars = bars.slice(0, t1BarsEnd);
  console.log(`\n${line}\nG.2 TEST 1 — 02:15:56Z signal zones | bar cutoff STRICTLY BEFORE ${new Date(t1Cutoff).toISOString()} (${t1Bars.length} bars, last ${new Date(t1Bars[t1Bars.length - 1].timestamp).toISOString()})\n${line}`);
  for (const zp of [4641.6, 4636.9, 4635.9, 4635.3, 4633.2]) {
    const { role, events } = classifyZone(t1Bars, t1Cutoff, zp);
    const rejB = events.filter(e => e.label === 'REJ_FROM_BELOW').length;
    const rejA = events.filter(e => e.label === 'REJ_FROM_ABOVE').length;
    const bu = events.filter(e => e.label === 'BREAK_UP').length, bd = events.filter(e => e.label === 'BREAK_DOWN').length;
    console.log(`  zone ${zp.toFixed(1)}: role=${role}  rej_from_below=${rejB} rej_from_above=${rejA} break_up=${bu} break_down=${bd} (n_events=${events.length})`);
  }

  // ── G.2 TEST 2 ──
  const sig2 = all.find(s => s.emitted_at.startsWith('2026-08-27T10:37:1'));
  if (!sig2) { console.log('\n  G.2 TEST 2: 10:37Z signal NOT FOUND in emitted_signals_v1'); }
  else {
    const zones2: SnapZone[] = typeof sig2.sr_zones_snapshot === 'string' ? JSON.parse(sig2.sr_zones_snapshot) : (sig2.sr_zones_snapshot ?? []);
    const c2 = new Date(sig2.emitted_at).getTime();
    const t2Bars = bars.slice(0, lb(bars, c2));
    console.log(`\n${line}\nG.2 TEST 2 — ${sig2.signal_id} ${sig2.direction} entry=${sig2.entry} | bar cutoff STRICTLY BEFORE ${sig2.emitted_at} (${t2Bars.length} bars)\n${line}`);
    console.log(`  snapshot zone count: ${zones2.length}; 4564-4572 band present? ${zones2.some(z => z.price >= 4564 && z.price <= 4572) ? 'YES' : 'NO — INVISIBLE'}`);
    for (const z of zones2) {
      const { role } = classifyZone(t2Bars, c2, z.price);
      console.log(`  zone ${Number(z.price).toFixed(1)}: stored_type=${z.type ?? '-'} stored_191_below/above=${z.rejectionsFromBelow ?? '-'}/${z.rejectionsFromAbove ?? '-'} touches=${z.touches} rs=${Number(z.reactionStrength).toFixed(2)} -> side-aware role=${role}`);
    }
  }

  // ── G.3 WHOLE-BOOK COUNTERFACTUAL ──
  console.log(`\n${line}\nG.3 — WHOLE-BOOK SIDE-AWARE COUNTERFACTUAL (NO code ships from this)\n${line}`);
  interface Book { id: string; dir: 'BUY' | 'SELL'; entry: number; tp1: number; ems: number; zones: SnapZone[] | null; rNet: number | null }
  const book: Book[] = [];
  let excl = 0;
  for (const s of all) {
    const ems = new Date(s.emitted_at).getTime();
    const windowEnd = Math.min(ems + 8 * 3600_000, barsEndMs);
    const wb = bars.slice(lb(bars, ems - 60_000), lb(bars, windowEnd));
    const cov = wb.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
    if (cov < 100 || wb.length === 0) { excl++; continue; }
    const zones = typeof s.sr_zones_snapshot === 'string' ? JSON.parse(s.sr_zones_snapshot) as SnapZone[] : s.sr_zones_snapshot;
    const sig = {
      id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: s.direction === 'SELL' ? 'SELL' : 'BUY',
      entryPrice: +s.entry, entryPriceWithSlippage: +s.entry, tp1: +s.tp1, tp2: +s.tp2, tp3: +s.tp3, sl: +s.sl,
      confidence: +s.confidence, status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false,
    } as unknown as TradingSignal;
    const r = resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd });
    const decided = r.outcomeResult !== null;
    book.push({ id: s.signal_id, dir: sig.type as 'BUY' | 'SELL', entry: +s.entry, tp1: +s.tp1, ems, zones: zones ?? null, rNet: decided ? computeRNet(sig.type as 'BUY' | 'SELL', +s.entry, r.exitPrice, Math.abs(+s.entry - +s.sl)) : null });
  }
  const dec = book.filter(b => b.rNet !== null);
  console.log(`  decided=${dec.length} excluded=${excl}`);

  // Legacy stored-type veto (E.1 rule) vs side-aware veto: qualifying zone in band OPPOSING the trade.
  const qualifying = (z: SnapZone): boolean => Number(z.touches) >= 10 && Number(z.reactionStrength) >= 0.5;
  const inBand = (b: Book, z: SnapZone): boolean => {
    const tp1d = Math.abs(b.tp1 - b.entry);
    return b.dir === 'BUY' ? z.price >= b.entry - 1.0 && z.price <= b.entry + tp1d : z.price <= b.entry + 1.0 && z.price >= b.entry - tp1d;
  };
  let flips = 0; const flipIds: string[] = [];
  const flipped: number[] = []; const same: number[] = [];
  for (const b of dec) {
    if (!b.zones) continue;
    const legacyOpposes = b.zones.some(z => qualifying(z) && inBand(b, z) && ((b.dir === 'BUY' && z.type === 'RESISTANCE') || (b.dir === 'SELL' && z.type === 'SUPPORT')));
    let awareOpposes = false;
    for (const z of b.zones) {
      if (!qualifying(z) || !inBand(b, z)) continue;
      const { role } = classifyZone(bars, b.ems, z.price);
      if ((b.dir === 'BUY' && role === 'RESISTANCE') || (b.dir === 'SELL' && role === 'SUPPORT')) { awareOpposes = true; break; }
    }
    if (awareOpposes !== legacyOpposes) { flips++; flipIds.push(b.id); flipped.push(b.rNet!); }
    else same.push(b.rNet!);
  }
  const ev = (v: number[]): number => v.reduce((x, y) => x + y, 0) / v.length;
  const sigmaP = Math.sqrt([...flipped, ...same].reduce((a, r) => a + (r - ev([...flipped, ...same])) ** 2, 0) / (flipped.length + same.length - 1));
  console.log(`  (a) signals whose veto verdict CHANGES under side-aware typing: ${flips} of ${flipped.length + same.length} (snapshot-bearing)`);
  console.log(statLine('  WOULD-FLIP cohort', flipped));
  console.log(statLine('  UNCHANGED cohort', same));
  if (flipped.length > 1 && same.length > 1) {
    const diff = ev(same) - ev(flipped);
    const rnd = mulberry32(20260827);
    const boots: number[] = [];
    for (let i = 0; i < 20000; i++) {
      let sf = 0, ss = 0;
      for (let t = 0; t < flipped.length; t++) sf += flipped[(rnd() * flipped.length) | 0];
      for (let t = 0; t < same.length; t++) ss += same[(rnd() * same.length) | 0];
      boots.push(ss / same.length - sf / flipped.length);
    }
    boots.sort((a, b) => a - b);
    console.log(`  (b) UNCHANGED−FLIP EV diff ${(diff >= 0 ? '+' : '') + diff.toFixed(4)}R; boot 95% CI [${boots[(boots.length * 0.025) | 0].toFixed(4)}, ${boots[(boots.length * 0.975) | 0].toFixed(4)}]; MDE realised +/-${(2.8 * sigmaP * Math.sqrt(1 / flipped.length + 1 / same.length)).toFixed(4)}R`);
  }
  // (c) restricted to at-extreme/one-sided class
  const atExtreme = (b: Book): boolean => {
    const dayStart = Date.UTC(new Date(b.ems).getUTCFullYear(), new Date(b.ems).getUTCMonth(), new Date(b.ems).getUTCDate());
    const dayBars = bars.filter(x => x.timestamp >= dayStart && x.timestamp < b.ems);
    if (dayBars.length < 30) return false;
    const hi = Math.max(...dayBars.map(x => x.high)), lo = Math.min(...dayBars.map(x => x.low));
    const oneSided = b.zones ? b.zones.every(z => z.type === b.zones![0].type) : false;
    return oneSided && ((b.dir === 'BUY' && b.entry >= hi - 2.0) || (b.dir === 'SELL' && b.entry <= lo + 2.0));
  };
  const fc = flipped.filter((_, i) => atExtreme(dec.find(x => x.id === flipIds[i])!));
  const sc = same.filter((_, i) => atExtreme(dec.filter(x => !flipIds.includes(x.id))[i] ?? { id: '' } as Book));
  // simpler: recompute classes directly
  const flipExtreme: number[] = [], sameExtreme: number[] = [];
  for (const b of dec) {
    if (!b.zones || !atExtreme(b)) continue;
    (flipIds.includes(b.id) ? flipExtreme : sameExtreme).push(b.rNet!);
  }
  console.log(`  (c) at-extreme/one-sided class: would-flip n=${flipExtreme.length} EV=${flipExtreme.length ? ev(flipExtreme).toFixed(4) : '-'} | unchanged n=${sameExtreme.length} EV=${sameExtreme.length ? ev(sameExtreme).toFixed(4) : '-'}`);
  console.log(`  next-round decision rule proposal: retype LIVE only if, on FORWARD signals annotated with both typings, the side-aware veto's vetoed-cohort EV CI upper < 0 at n_v>=50 AND the at-extreme class EV does not degrade by more than the class's current +EV (protect the winning class per population caution).`);
  function statLine(label: string, vals: number[]): string {
    const n = vals.length; const wr = n ? (vals.filter(v => v > 0).length / n) * 100 : NaN;
    return `  ${label.padEnd(26)} n=${String(n).padStart(4)}  WR=${isNaN(wr) ? ' - ' : wr.toFixed(1) + '%'}  EV_net=${(ev(vals) >= 0 ? '+' : '') + ev(vals).toFixed(4)}R`;
  }
}
if (import.meta.main) main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
