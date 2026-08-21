/**
 * ITEM 200 — THE VETO GUARDS THE PATH, NOT THE ENTRY.
 *
 * 200(b): distance from entry to the nearest OPPOSING zone in the direction of
 *         the trade's risk (BUY: nearest RESISTANCE ABOVE entry; SELL: nearest
 *         SUPPORT BELOW). Bucketed, canonical WR and EV_net per bucket.
 * 200(c): the inverse — nearest opposing zone BEHIND the entry (BUY: nearest
 *         RESISTANCE BELOW entry — the 4601 case). Same split.
 * Both under BOTH typings: legacy (stored type) and rejection-directed
 * (re-typed from gold_m1_bars, 24h pre-emission, DIRECT Wilder ATR-14 bands —
 * Item 198's method, no imputation).
 *
 * MEASUREMENT ONLY — anon key, Supabase DIRECT.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

function loadEnv(): void {
  const env = readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)=(.+)/);
    if (m) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();
const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });

interface Bar { t: number; h: number; l: number; c: number }
interface ZoneSnap { price: number; type: 'SUPPORT' | 'RESISTANCE'; reactionStrength: number; touches: number }
interface EmittedRow {
  signal_id: string; emitted_at: string; direction: 'BUY' | 'SELL';
  entry: number; tp1: number; atr: number | null; sr_zones_snapshot: unknown;
}
interface OutcomeRow { signal_id: string; result: string; realized_r: number | null; is_scratch: boolean | null }

const TYPING_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const ZONE_WIDTH_FLOOR_PCT = 0.0001;
const RS_GATE = 0.3;
const BUCKETS: Array<{ label: string; lo: number; hi: number }> = [
  { label: '0-0.5 ATR', lo: 0, hi: 0.5 },
  { label: '0.5-1 ATR', lo: 0.5, hi: 1 },
  { label: '1-2 ATR', lo: 1, hi: 2 },
  { label: '2-4 ATR', lo: 2, hi: 4 },
  { label: '>4 ATR', lo: 4, hi: Number.POSITIVE_INFINITY },
];

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const adj = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(centre - adj) / denom, (centre + adj) / denom];
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function bootstrapMeanCI(vals: number[], resamples = 2000): [number, number] {
  if (vals.length === 0) return [0, 0];
  const rng = makeRng(20260824);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < vals.length; i++) sum += vals[Math.floor(rng() * vals.length)];
    means.push(sum / vals.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(resamples * 0.025)], means[Math.floor(resamples * 0.975)]];
}

async function fetchAll<T>(table: string, select: string, orderCol: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 60; page++) {
    const { data, error } = await supabase.from(table).select(select).order(orderCol, { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

async function fetchBars(fromMs: number, toMs: number): Promise<Bar[]> {
  const out: Bar[] = [];
  for (let page = 0; page < 120; page++) {
    const { data, error } = await supabase
      .from('gold_m1_bars')
      .select('timestamp, high, low, close')
      .gte('timestamp', new Date(fromMs).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(`gold_m1_bars read failed: ${error.message}`);
    const batch = (data ?? []) as { timestamp: string; high: number; low: number; close: number }[];
    for (const r of batch) out.push({ t: new Date(r.timestamp).getTime(), h: Number(r.high), l: Number(r.low), c: Number(r.close) });
    if (batch.length < 1000) break;
  }
  return out;
}

function parseZones(snap: unknown): ZoneSnap[] {
  if (Array.isArray(snap)) return snap as ZoneSnap[];
  if (snap && typeof snap === 'object') {
    const arr = (snap as Record<string, unknown>).zones;
    if (Array.isArray(arr)) return arr as ZoneSnap[];
  }
  return [];
}

function wilderAtr14(bars: Bar[]): number | null {
  const w = bars.slice(-15);
  const trs: number[] = [];
  for (let i = 1; i < w.length; i++) {
    trs.push(Math.max(w[i].h - w[i].l, Math.abs(w[i].h - w[i - 1].c), Math.abs(w[i].l - w[i - 1].c)));
  }
  if (trs.length < 14) return null;
  let atr = trs.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  for (let i = 14; i < trs.length; i++) atr = (atr * 13 + trs[i]) / 14;
  return atr;
}

interface TypedZone extends ZoneSnap { newType: 'SUPPORT' | 'RESISTANCE' }

function retypeZones(zones: ZoneSnap[], window: Bar[], atr: number): TypedZone[] {
  return zones.map(z => {
    const band = Math.max(atr * 0.3, z.price * ZONE_WIDTH_FLOOR_PCT);
    const zoneLow = z.price - band;
    const zoneHigh = z.price + band;
    let below = 0;
    let above = 0;
    for (let i = 1; i < window.length; i++) {
      const b = window[i];
      const prev = window[i - 1];
      if (prev.c < zoneLow && b.h >= zoneLow && b.c < zoneLow) below++;
      if (prev.c > zoneHigh && b.l <= zoneHigh && b.c > zoneHigh) above++;
    }
    const newType: 'SUPPORT' | 'RESISTANCE' = below > above ? 'RESISTANCE' : above > below ? 'SUPPORT' : z.type;
    return { ...z, newType };
  });
}

interface SplitRow { bucket: string; n: number; wr: number; wrCI: [number, number]; ev: number; evCI: [number, number] }

function bucketSplit(rows: Array<{ distAtr: number | null; result: string; realized_r: number | null }>, label: string): SplitRow[] {
  const out: SplitRow[] = [];
  const groups = new Map<string, { result: string; realized_r: number | null }[]>();
  for (const r of rows) {
    const key = r.distAtr === null
      ? 'NONE (no opposing zone)'
      : BUCKETS.find(b => r.distAtr! >= b.lo && r.distAtr! < b.hi)!.label;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ result: r.result, realized_r: r.realized_r });
  }
  console.log(`  ${label}:`);
  for (const [key, g] of groups) {
    const wins = g.filter(x => x.result === 'WIN').length;
    const ev = g.length > 0 ? g.reduce((s, x) => s + (x.realized_r ?? 0), 0) / g.length : 0;
    const ci = bootstrapMeanCI(g.map(x => x.realized_r ?? 0));
    out.push({ bucket: key, n: g.length, wr: wins / Math.max(g.length, 1), wrCI: wilson(wins, g.length), ev, evCI: ci });
    console.log(`    ${key.padEnd(22)} n=${String(g.length).padStart(3)}  WR=${((wins / Math.max(g.length, 1)) * 100).toFixed(1)}% [${(wilson(wins, g.length)[0] * 100).toFixed(0)}, ${(wilson(wins, g.length)[1] * 100).toFixed(0)}]  EV_net=${ev.toFixed(4)}R [${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]`);
  }
  return out;
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('ITEM 200 ENTRY-BACKING MEASUREMENT — ' + new Date().toISOString());
  console.log('='.repeat(100));

  const emitted = await fetchAll<EmittedRow>('emitted_signals_v1', 'signal_id, emitted_at, direction, entry, tp1, atr, sr_zones_snapshot', 'emitted_at');
  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, result, realized_r, is_scratch', 'signal_id');
  const outcomeBySignal = new Map(outcomes.map(o => [o.signal_id, o] as const));
  const canonical = emitted.filter(e => {
    const o = outcomeBySignal.get(e.signal_id);
    return !!o && o.realized_r !== null && (o.is_scratch === null || o.is_scratch === false) && parseZones(e.sr_zones_snapshot).length > 0;
  });
  console.log(`canonical with snapshots: n=${canonical.length}`);
  console.log('POWER BEFORE the results: buckets hold roughly 10-40 rows each; the WR MDE per bucket is ~±20-35pp,');
  console.log('so ONLY a large EV separation (CI excluding zero between adjacent buckets) can gate anything.');

  const times = canonical.map(e => new Date(e.emitted_at).getTime());
  const bars = await fetchBars(Math.min(...times) - TYPING_LOOKBACK_MS, Math.max(...times) + 60_000);
  console.log(`bars: ${bars.length}`);

  for (const typing of ['legacy', 'rejection-directed'] as const) {
    console.log(`\n── ${typing.toUpperCase()} TYPING ──`);
    const ahead: Array<{ distAtr: number | null; result: string; realized_r: number | null }> = [];
    const behind: Array<{ distAtr: number | null; result: string; realized_r: number | null }> = [];
    let noAtr = 0;
    for (const e of canonical) {
      const emittedMs = new Date(e.emitted_at).getTime();
      const window = bars.filter(b => b.t >= emittedMs - TYPING_LOOKBACK_MS && b.t < emittedMs);
      if (window.length < 30) continue;
      const directAtr = wilderAtr14(window);
      if (directAtr === null) { noAtr++; continue; }
      let zones: TypedZone[];
      if (typing === 'legacy') {
        zones = parseZones(e.sr_zones_snapshot).map(z => ({ ...z, newType: z.type }));
      } else {
        zones = retypeZones(parseZones(e.sr_zones_snapshot), window, directAtr);
      }
      const opposing = e.direction === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
      const gated = zones.filter(z => z.newType === opposing && z.reactionStrength >= RS_GATE);
      const o = outcomeBySignal.get(e.signal_id)!;
      // AHEAD: opposing zone in the direction of the trade's risk.
      const aheadZones = gated.filter(z => (e.direction === 'BUY' ? z.price > e.entry : z.price < e.entry));
      const aheadDist = aheadZones.length > 0
        ? Math.min(...aheadZones.map(z => Math.abs(z.price - e.entry))) / directAtr
        : null;
      ahead.push({ distAtr: aheadDist, result: o.result, realized_r: o.realized_r });
      // BEHIND: opposing zone behind the entry (the 4601 shape).
      const behindZones = gated.filter(z => (e.direction === 'BUY' ? z.price < e.entry : z.price > e.entry));
      const behindDist = behindZones.length > 0
        ? Math.min(...behindZones.map(z => Math.abs(z.price - e.entry))) / directAtr
        : null;
      behind.push({ distAtr: behindDist, result: o.result, realized_r: o.realized_r });
    }
    if (noAtr > 0) console.log(`  (skipped ${noAtr} rows: insufficient bars for direct ATR)`);
    console.log(`  200(b) AHEAD — nearest opposing zone in the direction of risk:`);
    bucketSplit(ahead, 'ahead');
    console.log(`  200(c) BEHIND — nearest opposing zone behind the entry (4601 shape):`);
    bucketSplit(behind, 'behind');
  }

  console.log('\nDONE.');
}

main().catch(err => { console.error('FAILED:', err instanceof Error ? err.message : String(err)); process.exit(1); });
