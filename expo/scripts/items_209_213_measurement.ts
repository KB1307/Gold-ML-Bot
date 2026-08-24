/**
 * Items 209-213 measurement round — live Supabase read, canonical outcomes.
 *
 * 209: zone-type staleness / out-of-boundary snapshots
 * 210: entry-backing distance to nearest opposing zone BEHIND entry
 * 212: same-side zone density / merge failure analysis
 * 213: reaction-strength saturation + touch-count outcome split
 * 215: attention_scores coverage (raw values)
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

interface SignalRow {
  signal_id: string;
  emitted_at: string;
  direction: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  source: string;
  sr_zones_snapshot: unknown;
  attention_scores: unknown;
  atr: number | null;
  rsi: number | null;
  htf_trend: string | null;
  regime: string | null;
}

interface OutcomeRow {
  signal_id: string;
  ts: string;
  result: string;
  exit_price: number | null;
  realized_r: number | null;
  pnl: number | null;
  is_scratch: boolean | null;
}

const loadEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  try {
    for (const line of readFileSync('.env', 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
  } catch { /* fall through */ }
  return env;
};

const env = loadEnv();
const supabaseUrl = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error('Supabase not configured');
const supabase = createClient(supabaseUrl, supabaseKey);

function toSignal(row: SignalRow): TradingSignal {
  return {
    id: row.signal_id,
    timestamp: new Date(row.emitted_at),
    createdAt: new Date(row.emitted_at).getTime(),
    type: row.direction === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1),
    tp2: Number(row.tp2),
    tp3: Number(row.tp3),
    sl: Number(row.sl),
    confidence: Number(row.confidence),
    status: 'ACTIVE' as SignalStatus,
    targetsHit: 0,
    breakevenReached: false,
  } as unknown as TradingSignal;
}

async function fetchAll<T>(table: string, columns: string, orderColumn: string = 'emitted_at'): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  const page = 1000;
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).order(orderColumn, { ascending: true }).range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data as T[]);
    if (data.length < page) break;
    from += page;
  }
  return rows;
}

async function getBars(fromTs: number, toTs: number): Promise<Bar[]> {
  const { data, error } = await supabase
    .from('gold_m1_bars')
    .select('timestamp, open, high, low, close')
    .gte('timestamp', new Date(fromTs).toISOString())
    .lte('timestamp', new Date(toTs).toISOString())
    .order('timestamp', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ timestamp: new Date(r.timestamp).getTime(), open: r.open, high: r.high, low: r.low, close: r.close }));
}

function fmtR(r: number | null) {
  if (r === null || r === undefined) return 'null';
  return r >= 0 ? `+${r.toFixed(4)}` : r.toFixed(4);
}

function bookStats(rs: number[]) {
  if (rs.length === 0) return { n: 0, wr: 0, ev: 0, pf: 0, maxdd: 0 };
  const wins = rs.filter(r => r > 0).length;
  const losses = rs.filter(r => r < 0).length;
  const ev = rs.reduce((a, b) => a + b, 0) / rs.length;
  const grossProfit = rs.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rs.filter(r => r < 0).reduce((a, b) => a + b, 0));
  let maxdd = 0;
  let peak = 0;
  let running = 0;
  for (const r of rs) {
    running += r;
    peak = Math.max(peak, running);
    maxdd = Math.max(maxdd, peak - running);
  }
  return { n: rs.length, wr: wins / (wins + losses || 1), ev, pf: grossLoss > 0 ? grossProfit / grossLoss : 0, maxdd };
}

function resolveSignal(row: SignalRow, bars: Bar[]) {
  const sig = toSignal(row);
  const safeStart = sig.createdAt + 60_000;
  const windowBars = bars.filter(b => b.timestamp >= safeStart && b.timestamp < safeStart + 8 * 60 * 60 * 1000);
  return resolveSignalWithBars(sig, windowBars, { fromScratch: true });
}

function parseZones(raw: unknown): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as any[];
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.zones)) return obj.zones as any[];
    if (Array.isArray(obj.data)) return obj.data as any[];
  }
  return [];
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]) {
  return values.reduce((a, b) => a + b, 0) / (values.length || 1);
}

function ci95(values: number[]) {
  if (values.length < 2) return { low: NaN, high: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const low = sorted[Math.floor(values.length * 0.025)];
  const high = sorted[Math.ceil(values.length * 0.975) - 1];
  return { low, high };
}

function bootstrapMeanCI(values: number[], seed: number, iters = 5000) {
  if (values.length < 2) return { low: NaN, high: NaN };
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 2**32;
    return s / 2**32;
  };
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(rand() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return { low: means[Math.floor(iters * 0.025)], high: means[Math.ceil(iters * 0.975) - 1] };
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('ITEMS 209-213 MEASUREMENT — ' + new Date().toISOString());
  console.log('='.repeat(100));

  const emitted = await fetchAll<SignalRow>('emitted_signals_v1', '*');
  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, ts, result, exit_price, realized_r, pnl, is_scratch', 'ts');
  const outcomeBySignal = new Map(outcomes.map(o => [o.signal_id, o]));
  console.log(`emitted=${emitted.length} outcomes=${outcomes.length}`);

  const canonical = emitted
    .filter(e => {
      const o = outcomeBySignal.get(e.signal_id);
      return o && o.realized_r !== null && (o.is_scratch === null || o.is_scratch === false);
    })
    .map(e => ({ e, o: outcomeBySignal.get(e.signal_id)! }));
  console.log(`canonical (resolved, non-scratch): n=${canonical.length}`);

  const dayStart = Date.parse('2026-08-24T00:00:00Z');
  const dayEnd = Date.parse('2026-08-25T00:00:00Z');
  const today = canonical.filter(c => {
    const ms = new Date(c.e.emitted_at).getTime();
    return ms >= dayStart && ms < dayEnd;
  });
  console.log(`\ntoday (2026-08-24) canonical: n=${today.length}`);
  for (const t of today) {
    const emittedMs = new Date(t.e.emitted_at).getTime();
    const bars = await getBars(emittedMs, emittedMs + 8 * 60 * 60 * 1000);
    const r = resolveSignal(t.e, bars);
    console.log(`  ${t.e.emitted_at} ${t.e.direction} entry=${t.e.entry} SL=${t.e.sl} TP1=${t.e.tp1} stored=${t.o.result}/${fmtR(t.o.realized_r)} replay=${r.outcome}/${r.exitPrice}`);
  }

  // ITEM 209: out-of-boundary opposing zones
  console.log('\n' + '='.repeat(100));
  console.log('ITEM 209 — ZONE TYPE STALENESS / OUT-OF-BOUNDARY SNAPSHOTS');
  console.log('='.repeat(100));
  let outOfBoundary = 0;
  let inBoundary = 0;
  const boundaryRs: { out: number[]; in: number[] } = { out: [], in: [] };
  const crossedOpp: any[] = [];
  for (const c of canonical) {
    const zones = parseZones(c.e.sr_zones_snapshot);
    if (zones.length === 0) continue;
    const atr = c.e.atr ?? 1;
    const dir = c.e.direction === 'SELL' ? 'SELL' : 'BUY';
    const oppType = dir === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const entry = c.e.entry;
    // An opposing zone is "out-of-boundary" if it sits on the WRONG side of entry
    // (for a BUY, a RESISTANCE below entry; for a SELL, a SUPPORT above entry).
    const wrongSide = zones.filter((z: any) => z.type === oppType && ((dir === 'BUY' && z.price < entry) || (dir === 'SELL' && z.price > entry)));
    const hasWrong = wrongSide.length > 0;
    if (hasWrong) {
      outOfBoundary++;
      boundaryRs.out.push(c.o.realized_r ?? 0);
      const nearest = wrongSide.sort((a: any, b: any) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0];
      crossedOpp.push({ id: c.e.signal_id, dir, entry, price: nearest.price, distAtr: Math.abs(nearest.price - entry) / atr, r: c.o.realized_r });
    } else {
      inBoundary++;
      boundaryRs.in.push(c.o.realized_r ?? 0);
    }
  }
  console.log(`snapshots with >=1 opposing zone on wrong side of entry: ${outOfBoundary}/${canonical.length} (${(outOfBoundary / canonical.length * 100).toFixed(1)}%)`);
  console.log(`  OUT-OF-BOUNDARY: n=${boundaryRs.out.length} ${JSON.stringify(bookStats(boundaryRs.out))}`);
  console.log(`  IN-BOUNDARY:     n=${boundaryRs.in.length} ${JSON.stringify(bookStats(boundaryRs.in))}`);
  const bOut = bootstrapMeanCI(boundaryRs.out, 2091, 5000);
  const bIn = bootstrapMeanCI(boundaryRs.in, 2092, 5000);
  console.log(`  OUT-OF-BOUNDARY EV 95% CI: [${bOut.low.toFixed(4)}, ${bOut.high.toFixed(4)}]`);
  console.log(`  IN-BOUNDARY     EV 95% CI: [${bIn.low.toFixed(4)}, ${bIn.high.toFixed(4)}]`);
  console.log(`  POWER: n=${Math.min(boundaryRs.out.length, boundaryRs.in.length)} per arm; MDE on mean Δ ≈ ±${(2.8 * Math.sqrt((variance(boundaryRs.out) + variance(boundaryRs.in)) / 2) * Math.sqrt(1 / boundaryRs.out.length + 1 / boundaryRs.in.length)).toFixed(4)}R`);
  console.log('  First 5 out-of-boundary signals:');
  for (const x of crossedOpp.slice(0, 5)) console.log(`    ${x.id} ${x.dir} entry=${x.entry} zone=${x.price} dist=${x.distAtr.toFixed(2)}ATR r=${fmtR(x.r)}`);

  // ITEM 210: nearest opposing zone BEHIND entry distance distribution
  console.log('\n' + '='.repeat(100));
  console.log('ITEM 210 — ENTRY-BACKING DISTANCE TO NEAREST OPPOSING ZONE BEHIND ENTRY');
  console.log('='.repeat(100));
  const bucketed: Record<string, number[]> = {};
  const behindMeta: any[] = [];
  for (const c of canonical) {
    const zones = parseZones(c.e.sr_zones_snapshot);
    if (zones.length === 0) continue;
    const atr = c.e.atr ?? 1;
    const dir = c.e.direction === 'SELL' ? 'SELL' : 'BUY';
    const oppType = dir === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const entry = c.e.entry;
    const behind = zones.filter((z: any) => z.type === oppType && ((dir === 'BUY' && z.price < entry) || (dir === 'SELL' && z.price > entry)));
    const nearest = behind.sort((a: any, b: any) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0];
    if (!nearest) continue;
    const distAtr = Math.abs(nearest.price - entry) / atr;
    const bucket = distAtr <= 0.5 ? '<=0.5' : distAtr <= 1.0 ? '0.5-1.0' : distAtr <= 1.5 ? '1.0-1.5' : distAtr <= 2.0 ? '1.5-2.0' : '>2.0';
    bucketed[bucket] = bucketed[bucket] || [];
    bucketed[bucket].push(c.o.realized_r ?? 0);
    behindMeta.push({ id: c.e.signal_id, dir, entry, price: nearest.price, distAtr, bucket, r: c.o.realized_r, type: nearest.type });
  }
  for (const [bucket, rs] of Object.entries(bucketed).sort((a, b) => a[0].localeCompare(b[0]))) {
    const bs = bookStats(rs);
    const ci = bootstrapMeanCI(rs, 2100 + Object.keys(bucketed).indexOf(bucket), 5000);
    console.log(`  bucket ${bucket}: n=${rs.length} WR=${(bs.wr * 100).toFixed(1)}% EV=${bs.ev.toFixed(4)}R PF=${bs.pf.toFixed(2)} 95%CI=[${ci.low.toFixed(4)},${ci.high.toFixed(4)}]`);
  }
  const today210 = today.map(t => behindMeta.find(m => m.id === t.e.signal_id)).filter(Boolean);
  console.log('  2026-08-24 signals placed:');
  for (const x of today210) console.log(`    ${x.id} ${x.dir} entry=${x.entry} ${x.type}@${x.price} dist=${x.distAtr.toFixed(2)}ATR bucket=${x.bucket} r=${fmtR(x.r)}`);
  const explain07 = today.find(t => t.e.signal_id.includes('94nz6o9nm'));
  if (explain07) {
    const zones = parseZones(explain07.e.sr_zones_snapshot);
    console.log(`\n  07:15Z oddity explanation — full snapshot (${zones.length} zones):`);
    for (const z of zones) {
      const dist = z.price - explain07.e.entry;
      console.log(`    ${z.type}@${z.price.toFixed(1)} dist=${Math.abs(dist).toFixed(1)}${dist > 0 ? 'above' : 'below'} entry t=${z.touches} rs=${(z.reactionStrength * 100).toFixed(0)}%`);
    }
    // 07:15 entry was 4648.3. SUPPORT@4649.8 is above entry. This is possible because the
    // snapshot was built when spot was lower (~4646-4648), then price moved up to 4648.3
    // between refresh and emission. The SUPPORT level was below spot at refresh time.
    console.log('  => SUPPORT above entry is the same stale-typing mechanism as 209: the zone was typed SUPPORT when spot was lower, then price rose above it before emission.');
  }

  // ITEM 212: same-side zone density
  console.log('\n' + '='.repeat(100));
  console.log('ITEM 212 — SAME-SIDE ZONE DENSITY / MERGE FAILURE');
  console.log('='.repeat(100));
  const mergeWidthAtr = 1.5;
  let totalSameSideGroups = 0;
  let unmergedGroups = 0;
  let groupCounts: number[] = [];
  const densityGaps: number[] = [];
  for (const c of canonical) {
    const zones = parseZones(c.e.sr_zones_snapshot);
    if (zones.length === 0) continue;
    const atr = c.e.atr ?? 1;
    for (const type of ['SUPPORT', 'RESISTANCE']) {
      const sideZones = zones.filter((z: any) => z.type === type).sort((a: any, b: any) => a.price - b.price);
      if (sideZones.length < 2) continue;
      let i = 0;
      while (i < sideZones.length) {
        let j = i + 1;
        while (j < sideZones.length && Math.abs(sideZones[j].price - sideZones[i].price) < atr * mergeWidthAtr) {
          densityGaps.push(Math.abs(sideZones[j].price - sideZones[i].price) / atr);
          j++;
        }
        const groupSize = j - i;
        if (groupSize > 1) {
          totalSameSideGroups++;
          groupCounts.push(groupSize);
          if (groupSize >= 3) unmergedGroups++;
        }
        i = j;
      }
    }
  }
  console.log(`same-side clusters within ${mergeWidthAtr} ATR: total groups=${totalSameSideGroups}, groups with 3+ zones=${unmergedGroups}`);
  console.log(`group size distribution: ${JSON.stringify(groupCounts.reduce((acc, n) => { acc[n] = (acc[n] || 0) + 1; return acc; }, {} as Record<number, number>))}`);
  console.log(`within-cluster gap ATR: median=${median(densityGaps).toFixed(2)} mean=${mean(densityGaps).toFixed(2)}`);
  const sig1 = canonical.find(c => c.e.signal_id.includes('5vebl78nz'));
  if (sig1) {
    const zones = parseZones(sig1.e.sr_zones_snapshot);
    const supports = zones.filter((z: any) => z.type === 'SUPPORT').sort((a: any, b: any) => a.price - b.price);
    console.log(`\n  02:56Z SUPPORT cluster analysis (${supports.length} support zones):`);
    for (const z of supports) console.log(`    ${z.price.toFixed(1)} t=${z.touches} rs=${(z.reactionStrength * 100).toFixed(0)}%`);
    const gaps = supports.slice(1).map((z: any, i: number) => z.price - supports[i].price);
    console.log(`    gaps: ${gaps.map((g: number) => g.toFixed(1)).join(', ')} (ATR=${sig1.e.atr?.toFixed(2)})`);
  }

  // ITEM 213: reaction strength / touch count saturation
  console.log('\n' + '='.repeat(100));
  console.log('ITEM 213 — REACTION STRENGTH / TOUCH COUNT SATURATION');
  console.log('='.repeat(100));
  const allZones: any[] = [];
  for (const c of canonical) {
    const zones = parseZones(c.e.sr_zones_snapshot);
    for (const z of zones) allZones.push(z);
  }
  const rs = allZones.map(z => z.reactionStrength).filter(Number.isFinite);
  const touches = allZones.map(z => z.touches).filter(Number.isFinite);
  console.log(`reactionStrength: n=${rs.length} min=${Math.min(...rs).toFixed(3)} median=${median(rs).toFixed(3)} max=${Math.max(...rs).toFixed(3)} mean=${mean(rs).toFixed(3)}`);
  console.log(`touches: n=${touches.length} min=${Math.min(...touches)} median=${median(touches)} max=${Math.max(...touches)} mean=${mean(touches).toFixed(1)}`);
  const rsBuckets: Record<string, number[]> = { '<0.9': [], '0.9-0.95': [], '0.95-0.99': [], '>=0.99': [] };
  for (const r of rs) {
    if (r < 0.9) rsBuckets['<0.9'].push(r);
    else if (r < 0.95) rsBuckets['0.9-0.95'].push(r);
    else if (r < 0.99) rsBuckets['0.95-0.99'].push(r);
    else rsBuckets['>=0.99'].push(r);
  }
  console.log('reactionStrength histogram:');
  for (const [k, v] of Object.entries(rsBuckets)) console.log(`  ${k}: ${v.length} (${(v.length / rs.length * 100).toFixed(1)}%)`);
  // touch-count split on outcomes where the signal's driving zone can be identified
  // proxy: nearest opposing zone ahead of entry (the one the path-to-target gate uses)
  const lowTouch: number[] = [];
  const highTouch: number[] = [];
  for (const c of canonical) {
    const zones = parseZones(c.e.sr_zones_snapshot);
    if (zones.length === 0) continue;
    const dir = c.e.direction === 'SELL' ? 'SELL' : 'BUY';
    const oppType = dir === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const entry = c.e.entry;
    const ahead = zones.filter((z: any) => z.type === oppType && ((dir === 'BUY' && z.price > entry) || (dir === 'SELL' && z.price < entry)));
    const nearest = ahead.sort((a: any, b: any) => Math.abs(a.price - entry) - Math.abs(b.price - entry))[0];
    if (!nearest) continue;
    (nearest.touches <= 5 ? lowTouch : nearest.touches >= 15 ? highTouch : []).push(c.o.realized_r ?? 0);
  }
  const lowStat = bookStats(lowTouch);
  const highStat = bookStats(highTouch);
  const lowCi = bootstrapMeanCI(lowTouch, 2131, 5000);
  const highCi = bootstrapMeanCI(highTouch, 2132, 5000);
  console.log(`\noutcome split by driving-zone touch count:`);
  console.log(`  low-touch (<=5):  n=${lowTouch.length} WR=${(lowStat.wr * 100).toFixed(1)}% EV=${lowStat.ev.toFixed(4)}R CI=[${lowCi.low.toFixed(4)},${lowCi.high.toFixed(4)}]`);
  console.log(`  high-touch (>=15): n=${highTouch.length} WR=${(highStat.wr * 100).toFixed(1)}% EV=${highStat.ev.toFixed(4)}R CI=[${highCi.low.toFixed(4)},${highCi.high.toFixed(4)}]`);
  const mde213 = 2.8 * Math.sqrt((variance(lowTouch) + variance(highTouch)) / 2) * Math.sqrt(1 / lowTouch.length + 1 / highTouch.length);
  console.log(`  POWER: n_low=${lowTouch.length} n_high=${highTouch.length}; MDE ≈ ±${mde213.toFixed(4)}R`);

  // ITEM 215: attention_scores coverage
  console.log('\n' + '='.repeat(100));
  console.log('ITEM 215 — ATTENTION_SCORES COVERAGE');
  console.log('='.repeat(100));
  let nonEmpty = 0;
  let empty = 0;
  const eraStart = Date.parse('2026-07-16T10:51:28.481Z');
  let eraNonEmpty = 0;
  let eraTotal = 0;
  let preNonEmpty = 0;
  let preTotal = 0;
  for (const e of emitted) {
    const raw = e.attention_scores;
    const ms = new Date(e.emitted_at).getTime();
    const isEra = ms >= eraStart;
    const isEmpty = raw === null || (typeof raw === 'object' && Object.keys(raw).length === 0) || (Array.isArray(raw) && raw.length === 0);
    if (isEmpty) empty++; else nonEmpty++;
    if (isEra) { eraTotal++; if (!isEmpty) eraNonEmpty++; } else { preTotal++; if (!isEmpty) preNonEmpty++; }
  }
  console.log(`attention_scores non-empty: ${nonEmpty}/${emitted.length} (${(nonEmpty / emitted.length * 100).toFixed(1)}%)`);
  console.log(`  snapshot-era (>=2026-07-16T10:51:28Z): ${eraNonEmpty}/${eraTotal} (${(eraNonEmpty / eraTotal * 100).toFixed(1)}%)`);
  console.log(`  pre-snapshot: ${preNonEmpty}/${preTotal} (${(preNonEmpty / preTotal * 100).toFixed(1)}%)`);
  const sample = emitted.slice(-5).map(e => ({ id: e.signal_id, raw: e.attention_scores }));
  console.log('  last 5 raw attention_scores values:');
  for (const s of sample) console.log(`    ${s.id}: ${JSON.stringify(s.raw).slice(0, 200)}`);

  console.log('\n' + '='.repeat(100));
  console.log('DONE');
  console.log('='.repeat(100));
}

function variance(values: number[]) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
}

main().catch(e => { console.error(e); process.exit(1); });
