/**
 * ITEM E.1 / CHECKPOINT E.1 — BAND-PROXIMITY VETO, CANONICAL RE-DERIVATION.
 *
 * POPULATION : full canonical A.1 population (emitted_signals_v1 ∩ gold_m1_bars
 *              ≥100/120-bar first-2h coverage). Resolution: REAL
 *              resolveSignalWithBars(fromScratch:true, evalNowMs = window end from
 *              real bar timestamps); EV via shared lib/evCompute computeRNet; win =
 *              rNet > 0.
 * RULE (EXACTLY as pre-registered, no tuning): veto a signal when ANY zone in its
 *              OWN stored sr_zones_snapshot (generation-time information set — no
 *              later zone data touched) with touches>=10 AND reactionStrength>=0.5
 *              lies inside [entry-1.0, entry+TP1dist] for BUY, mirrored
 *              [entry-TP1dist, entry+1.0] for SELL.
 * PRE-STATED POWER (before any canonical point estimate is used): MDE = 2.80 ×
 *              σ_pooled × sqrt(1/n_v + 1/n_k), 80% power, α=5%. Provisional split
 *              (55/128 vetoed) scales to n≈431 as n_v≈185 / n_k≈246; with a
 *              conservative σ_pooled=1.5R the pre-run MDE band is
 *              ±0.31R (best case σ=1.0R → ±0.21R). Stated FIRST per MINDSET 7.
 *
 * DATA-SOURCE RULE: DIRECT anon reads only. READ-ONLY script.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number }
export interface SnapZone { price: number; touches: number; reactionStrength: number; type?: string; source?: string; tier?: string }
interface SignalRow {
  signal_id: string; emitted_at: string; direction: string;
  entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number;
  sr_zones_snapshot: SnapZone[] | string | null;
}
const WINDOW_MS = 8 * 3600_000, SAFE = 60_000, MIN_COV = 100;

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
function toTradingSignal(r: SignalRow): TradingSignal {
  return {
    id: r.signal_id, timestamp: new Date(r.emitted_at), createdAt: new Date(r.emitted_at).getTime(),
    type: r.direction === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: +r.entry, entryPriceWithSlippage: +r.entry,
    tp1: +r.tp1, tp2: +r.tp2, tp3: +r.tp3, sl: +r.sl, confidence: +r.confidence,
    status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false,
  } as unknown as TradingSignal;
}
const lb = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };
const ub = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp <= t) lo = m + 1; else hi = m; } return lo; };

/** Pre-registered veto predicate. zones = the signal's OWN snapshot (generation-time set). */
export function bandVetoHit(dir: 'BUY' | 'SELL', entry: number, tp1: number, zones: SnapZone[] | null, minTouches: number, minRs: number): SnapZone | null {
  if (!zones || !Array.isArray(zones)) return null;
  const tp1d = Math.abs(+tp1 - entry);
  const lo = dir === 'BUY' ? entry - 1.0 : entry - tp1d;
  const hi = dir === 'BUY' ? entry + tp1d : entry + 1.0;
  for (const z of zones) {
    if (z === null || typeof z !== 'object') continue;
    const p = Number(z.price);
    if (!Number.isFinite(p)) continue;
    if (Number(z.touches) >= minTouches && Number(z.reactionStrength) >= minRs && p >= lo && p <= hi) return z;
  }
  return null;
}

interface Resolved { id: string; dir: 'BUY' | 'SELL'; entry: number; tp1: number; rNet: number | null; zones: SnapZone[] | null; status: string; exit: number }

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }

function statLine(label: string, vals: number[]): string {
  const n = vals.length; const wr = n ? (vals.filter(v => v > 0).length / n) * 100 : NaN;
  const ev = n ? vals.reduce((x, y) => x + y, 0) / n : NaN; const tot = vals.reduce((x, y) => x + y, 0);
  return `  ${label.padEnd(30)} n=${String(n).padStart(4)}  WR=${isNaN(wr) ? ' - ' : wr.toFixed(1) + '%'}  EV_net=${(ev >= 0 ? '+' : '') + ev.toFixed(4)}R  total=${(tot >= 0 ? '+' : '') + tot.toFixed(2)}R`;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const env = loadEnv();
  const client = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM E.1 — BAND-PROXIMITY VETO, CANONICAL (real resolver, own-snapshot zones)'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log(`  PRE-STATED MDE (80%/5%): 2.80*sigma_p*sqrt(1/nv+1/nk); pre-run band +/-0.21..0.31R at expected nv~185/nk~246 (sigma 1.0..1.5R) — stated BEFORE results`);

  const all: SignalRow[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1')
      .select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,sr_zones_snapshot')
      .order('emitted_at', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`signals: ${error.message}`);
    all.push(...((data ?? []) as SignalRow[]));
    if ((data?.length ?? 0) < 1000) break;
  }
  const { data: ends } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsEndMs = new Date(String(ends?.[0]?.timestamp)).getTime();
  const minEms = Math.min(...all.map(r => new Date(r.emitted_at).getTime()));
  const bars: Bar[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('gold_m1_bars').select('timestamp,open,high,low,close')
      .gte('timestamp', new Date(minEms - 60_000).toISOString()).lte('timestamp', new Date(barsEndMs).toISOString())
      .order('timestamp', { ascending: true }).range(o, o + 999);
    if (error) throw new Error(`bars: ${error.message}`);
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[])
      bars.push({ timestamp: new Date(r.timestamp).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    if ((data?.length ?? 0) < 1000) break;
  }
  console.log(`  corpus: ${all.length} emitted | ${bars.length} M1 bars to ${new Date(barsEndMs).toISOString()}`);

  const resolved: Resolved[] = [];
  let excl = 0, snapNull = 0;
  for (const s of all) {
    const sig = toTradingSignal(s); const ems = sig.createdAt!;
    const windowEnd = Math.min(ems + WINDOW_MS, barsEndMs);
    const wb = bars.slice(lb(bars, ems - SAFE), ub(bars, windowEnd));
    const cov = wb.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
    if (cov < MIN_COV || wb.length === 0) { excl++; continue; }
    const zones = typeof s.sr_zones_snapshot === 'string' ? (JSON.parse(s.sr_zones_snapshot) as SnapZone[]) : s.sr_zones_snapshot;
    if (!zones) snapNull++;
    const r = resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd });
    const risk = Math.abs(+s.entry - +s.sl);
    const dir = sig.type as 'BUY' | 'SELL';
    const decided = r.outcomeResult !== null;
    resolved.push({ id: s.signal_id, dir, entry: +s.entry, tp1: +s.tp1, status: String(r.newStatus), exit: r.exitPrice, zones: zones ?? null, rNet: decided ? computeRNet(dir, +s.entry, r.exitPrice, risk) : null });
  }
  const dec = resolved.filter(r => r.rNet !== null);
  console.log(`  resolved: decided=${dec.length} coverage-excluded=${excl} null-snapshot=${snapNull}`);

  // Resolver console evidence for >=3 individual signals: the 02:15Z failure, first VETOED, first KEPT.
  console.log(`\n${line}\nRESOLVER CONSOLE — INDIVIDUAL SIGNALS (checkpoint (a))\n${line}`);
  const f0215 = dec.find(r => r.id === 'signal_1787796956413_g776eza9i');
  for (const r of [f0215, dec.find(x => bandVetoHit(x.dir, x.entry, x.tp1, x.zones, 10, 0.5) && x.id !== f0215?.id), dec.find(x => !bandVetoHit(x.dir, x.entry, x.tp1, x.zones, 10, 0.5))].filter(Boolean) as Resolved[]) {
    const z = bandVetoHit(r.dir, r.entry, r.tp1, r.zones, 10, 0.5);
    console.log(`  ${r.id} ${r.dir} entry=${r.entry.toFixed(1)} tp1=${r.tp1.toFixed(1)} -> ${r.status} exit=${r.exit.toFixed(2)} rNet=${r.rNet!.toFixed(4)}R | veto-qualifying zone in band: ${z ? `YES price=${z.price} touches=${z.touches} rs=${Number(z.reactionStrength).toFixed(3)} type=${z.type ?? '-'}` : 'NO'}`);
  }

  // Headline split at the pre-registered thresholds (10 / 0.5).
  const runSplit = (mt: number, mrs: number): { v: Resolved[]; k: Resolved[] } => {
    const v = dec.filter(r => bandVetoHit(r.dir, r.entry, r.tp1, r.zones, mt, mrs) !== null);
    return { v, k: dec.filter(r => !v.includes(r)) };
  };
  const { v, k } = runSplit(10, 0.5);
  const ev = (rs: Resolved[]): number => rs.reduce((x, y) => x + y.rNet!, 0) / rs.length;
  const diff = ev(k) - ev(v);
  const pool = [...v, ...k];
  const sigmaP = Math.sqrt(pool.reduce((a, r) => a + (r.rNet! - ev(pool)) ** 2, 0) / (pool.length - 1));
  const mde = 2.8 * sigmaP * Math.sqrt(1 / v.length + 1 / k.length);
  const rnd = mulberry32(20260827);
  const boots: number[] = [];
  for (let i = 0; i < 20000; i++) {
    let sv = 0, sk = 0;
    for (let t = 0; t < v.length; t++) sv += v[(rnd() * v.length) | 0].rNet!;
    for (let t = 0; t < k.length; t++) sk += k[(rnd() * k.length) | 0].rNet!;
    boots.push(sk / k.length - sv / v.length);
  }
  boots.sort((a, b) => a - b);
  console.log(`\n${line}\nHEADLINE SPLIT (touches>=10, rs>=0.5) — checkpoint (b)\n${line}`);
  console.log(`  MDE realised: sigma_pooled=${sigmaP.toFixed(3)}R -> +/-${mde.toFixed(4)}R (n_v=${v.length}, n_k=${k.length})`);
  console.log(statLine('VETOED (rule fires)', v.map(r => r.rNet!)));
  console.log(statLine('KEPT (rule silent)', k.map(r => r.rNet!)));
  console.log(statLine('whole decided book', dec.map(r => r.rNet!)));
  for (const d of ['BUY', 'SELL'] as const) {
    const dv = v.filter(r => r.dir === d), dk = k.filter(r => r.dir === d);
    if (dv.length || dk.length) console.log(`    ${d}: VETOED n=${dv.length} EV=${dv.length ? ev(dv).toFixed(4) : '-'} | KEPT n=${dk.length} EV=${dk.length ? ev(dk).toFixed(4) : '-'}`);
  }
  console.log(`  KEPT−VETOED EV difference: ${(diff >= 0 ? '+' : '') + diff.toFixed(4)}R; bootstrap 20k 95% CI [${boots[(boots.length * 0.025) | 0].toFixed(4)}, ${boots[(boots.length * 0.975) | 0].toFixed(4)}]`);

  // LIVE-source subset: split by snapshot zone source provenance where present.
  console.log(`\n  LIVE-source subset (zones whose snapshot includes at least one TIER_0 PRICE_ACTION zone):`);
  const live = dec.filter(r => (r.zones ?? []).some(z => z?.tier === 'TIER_0_SERVER'));
  const lv = live.filter(r => bandVetoHit(r.dir, r.entry, r.tp1, r.zones, 10, 0.5));
  const lk = live.filter(r => !lv.includes(r));
  if (lv.length && lk.length) {
    console.log(statLine('  LIVE VETOED', lv.map(r => r.rNet!)));
    console.log(statLine('  LIVE KEPT', lk.map(r => r.rNet!)));
  } else console.log('  subset degenerate (one side empty) — reported honestly');

  console.log(`\n${line}\n12-POINT SENSITIVITY GRID — checkpoint (c)\n${line}`);
  console.log('  touches   rs | n_VETOED  EV_VETOED | n_KEPT  EV_KEPT |   diff    sign');
  for (const mt of [5, 10, 20, 40]) for (const mrs of [0.3, 0.5, 0.7]) {
    const s2 = runSplit(mt, mrs);
    const evV = s2.v.length ? s2.v.reduce((x, y) => x + y.rNet!, 0) / s2.v.length : NaN;
    const evK = s2.k.length ? s2.k.reduce((x, y) => x + y.rNet!, 0) / s2.k.length : NaN;
    const df = evK - evV;
    console.log(`  ${String(mt).padStart(7)} ${mrs.toFixed(1)} | ${String(s2.v.length).padStart(8)}  ${isNaN(evV) ? '   -    ' : (evV >= 0 ? '+' : '') + evV.toFixed(4)} | ${String(s2.k.length).padStart(6)}  ${isNaN(evK) ? '   -    ' : (evK >= 0 ? '+' : '') + evK.toFixed(4)} | ${(df >= 0 ? '+' : '') + df.toFixed(4)}  ${df > 0 ? 'KEPT>VETOED' : df < 0 ? 'VETOED>KEPT' : 'flat'}`);
  }

  const g = runSplit(10, 0.5);
  const prov = { v: -0.2259, k: 0.0427 };
  console.log(`\n${line}\nPROVISIONAL vs CANONICAL — checkpoint (d)\n${line}`);
  console.log(`  provisional (128-slice): VETOED ${prov.v}R / KEPT +${prov.k}R`);
  console.log(`  canonical  (this run)  : VETOED ${ev(g.v).toFixed(4)}R / KEPT ${ev(g.k).toFixed(4)}R -> delta_v ${(ev(g.v) - prov.v).toFixed(4)}, delta_k ${(ev(g.k) - prov.k).toFixed(4)}`);
  console.log(`  E.2 GATE: VETOED CI-upper < 0? ${boots[(boots.length * 0.975) | 0] < 0 ? 'YES' : 'NO'} | KEPT > whole-book? ${ev(g.k) > ev(dec) ? 'YES' : 'NO'} | n_v>=40? ${g.v.length >= 40 ? 'YES' : 'NO'}`);
}
if (import.meta.main) main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); });
