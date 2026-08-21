/**
 * ITEMS 191 / 192 / 193 — measurement round (2026-08-21).
 *
 * 191(b): one-sidedness distribution across EVERY stored zone snapshot, then
 *         canonical WR / EV_net split for signals emitted from a >80%
 *         one-sided map vs a balanced one. POWER FIRST.
 * 191(d): the 4601 counterfactual — re-type each snapshot zone by rejection
 *         direction from gold_m1_bars; does 4600.3 become RESISTANCE; does the
 *         path-to-target veto fire; does await-the-zone arm.
 * 191(e): population-wide veto re-derivation under rejection-directed typing:
 *         how many canonical signals change emit -> veto, outcome split of the
 *         changed set. veto -> emit is NOT measurable from stored data (vetoed
 *         signals never emit and the near-miss ring is in-memory only) — stated
 *         in the report, not silently dropped.
 * 192(b): zero-opposing vs has-opposing split (LEGACY typing — what the shipped
 *         veto actually saw), n / WR / EV_net / CI per arm. POWER FIRST.
 * 193(c): the three documented top-buys (4601 hpy5mh8ld, 4565 i44ilxit7,
 *         4438.6 5qyon2qk8) re-scored under 191+192+reachable await-the-zone,
 *         Item 104 method: moved entry, ladder shifted, canonical bar replay.
 *
 * PRE-REGISTERED constructs (stated before running):
 *   * Zone band mirrors the engine: w = max(atr*0.3, price*0.0001)
 *     (signalEngine.ts:4201 with ZONE_WIDTH_FLOOR_PCT=0.0001 at :613).
 *   * Rejection-from-below (RESISTANCE behaviour): prev.close < zoneLow AND
 *     bar.high >= zoneLow AND bar.close < zoneLow — price probed up into the
 *     band from below and was pushed back below it.
 *   * Rejection-from-above (SUPPORT behaviour): prev.close > zoneHigh AND
 *     bar.low <= zoneHigh AND bar.close > zoneHigh.
 *   * newType: below > above -> RESISTANCE; above > below -> SUPPORT; tie ->
 *     legacy spot-relative type.
 *   * Typing window: 24h of M1 bars before emission.
 *   * Veto re-derivation mirrors signalEngine.ts:8971-8976 exactly: opposing
 *     type, strictly between entry and TP1 (+/- 0.01), reactionStrength >= 0.3.
 *   * Await-the-zone target mirrors signalEngine.ts:8983-8992: same-side zones
 *     with rs >= 0.3, distance from entry in ATR in (0.1, 3.0], strongest rs.
 *   * Combined logic (193c): (1) rejection-typed blocking zone between entry
 *     and TP1 -> veto branch -> await-zone at strongest same-side
 *     (rejection-typed) zone in band, else straight veto; (2) else legacy
 *     opposingCount === 0 -> await-zone at strongest same-side (legacy) zone
 *     in band, else straight veto (NO structure anywhere); (3) else emit.
 *     Per Item 192(c) this routes zero-opposing signals to await-the-zone
 *     toward the nearest same-side shelf; the 180(e) N=3-ATR extra condition
 *     is replaced by "no same-side zone in band -> straight veto" — extension
 *     stated here, not silently.
 *   * Canonical resolution ported verbatim from the deployed resolver
 *     semantics: safeBarStart = emitted+60s, 8h window, bar-containment
 *     touches, SL-first conservative ordering, post-TP1 0.35R profit lock,
 *     TP2 -> breakeven, protected exit (tp1+tp2+entry)/3 after TP2, net of
 *     the $0.20 execution cost in R.
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

/* ───────────────────────────── types ───────────────────────────── */

interface Bar { t: number; h: number; l: number; c: number }
interface ZoneSnap {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  reactionStrength: number;
  touches: number;
  rejectionWicks: number;
  source: string;
  confluenceScore: number;
  tier?: string;
}
interface TypedZone extends ZoneSnap {
  below: number;
  above: number;
  newType: 'SUPPORT' | 'RESISTANCE';
  band: number;
}
interface EmittedRow {
  signal_id: string;
  emitted_at: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  atr: number | null;
  sr_zones_snapshot: unknown;
}
interface OutcomeRow { signal_id: string; result: string; realized_r: number | null; is_scratch: boolean | null }

/* ─────────────────────── engine/resolver mirrors ─────────────────────── */

const ZONE_WIDTH_FLOOR_PCT = 0.0001; // signalEngine.ts:613
const TYPING_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const VETO_BLOCK_RS = 0.3;           // signalEngine.ts:8975
const AWAIT_BAND_ATR = 3.0;          // signalEngine.ts:8983
const AWAIT_MIN_ATR = 0.1;           // signalEngine.ts:8990
const EXECUTION_COST_USD = 0.2;      // executionCost.ts:37
const DOLLAR_PER_PRICE_UNIT = 1;
const SCRATCH_R = 0.15;
const SAFE_BAR_OFFSET_MS = 60_000;
const RESOLUTION_WINDOW_MS = 8 * 60 * 60 * 1000;
const TP1_LOCK_R = 0.35;
const TP1_LOCK_MIN_PIPS = 5;
const PIP = 0.1;
const TP1_LOCK_MAX_FRAC = 0.9;

function costInR(riskPriceUnits: number): number {
  const riskUsd = riskPriceUnits * DOLLAR_PER_PRICE_UNIT;
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  return EXECUTION_COST_USD / riskUsd;
}

/* ───────────────────────────── stats ───────────────────────────── */

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const adj = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(centre - adj) / denom, (centre + adj) / denom];
}

/** Deterministic LCG so bootstrap CIs reproduce exactly. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function bootstrapMeanCI(vals: number[], resamples = 2000): [number, number] {
  if (vals.length === 0) return [0, 0];
  const rng = makeRng(20260821);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < vals.length; i++) sum += vals[Math.floor(rng() * vals.length)];
    means.push(sum / vals.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(resamples * 0.025)], means[Math.floor(resamples * 0.975)]];
}

/** MDE for a two-proportion WR comparison at alpha=0.05, power=0.8. */
function mdeWR(n1: number, n2: number, pBar: number): number {
  if (n1 < 2 || n2 < 2) return Number.NaN;
  return (1.96 + 0.8416) * Math.sqrt(pBar * (1 - pBar) * (1 / n1 + 1 / n2));
}

interface ArmStats { n: number; wr: number; wrCI: [number, number]; ev: number; evCI: [number, number] }
function armStats(rs: { result: string; realized_r: number | null }[], label: string): ArmStats {
  const wins = rs.filter(r => r.result === 'WIN').length;
  const ev = rs.map(r => r.realized_r ?? 0);
  const evMean = ev.length > 0 ? ev.reduce((a, b) => a + b, 0) / ev.length : 0;
  const st: ArmStats = { n: rs.length, wr: rs.length > 0 ? wins / rs.length : 0, wrCI: wilson(wins, rs.length), ev: evMean, evCI: bootstrapMeanCI(ev) };
  console.log(`  ${label}: n=${st.n} WR=${(st.wr * 100).toFixed(1)}% [${(st.wrCI[0] * 100).toFixed(1)}, ${(st.wrCI[1] * 100).toFixed(1)}]  EV_net=${st.ev.toFixed(4)}R [${st.evCI[0].toFixed(3)}, ${st.evCI[1].toFixed(3)}]`);
  return st;
}

/* ───────────────────────────── fetch ───────────────────────────── */

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

/* ─────────────────── rejection-directed typing (191) ─────────────────── */

function retypeZones(zones: ZoneSnap[], bars: Bar[], emittedMs: number, atr: number): TypedZone[] {
  const from = emittedMs - TYPING_LOOKBACK_MS;
  const window = bars.filter(b => b.t >= from && b.t < emittedMs);
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
    return { ...z, below, above, newType, band };
  });
}

function findBlockingZone(zones: TypedZone[], opposing: 'SUPPORT' | 'RESISTANCE', entry: number, tp1: number): TypedZone | undefined {
  const minP = Math.min(entry, tp1);
  const maxP = Math.max(entry, tp1);
  return zones.find(z => z.newType === opposing && z.price > minP + 0.01 && z.price < maxP - 0.01 && z.reactionStrength >= VETO_BLOCK_RS);
}

function findAwaitTarget(zones: TypedZone[], sameSide: 'SUPPORT' | 'RESISTANCE', atr: number, entry: number): TypedZone | undefined {
  const cands = zones
    .filter(z => z.newType === sameSide && z.reactionStrength >= VETO_BLOCK_RS)
    .filter(z => {
      const distAtr = Math.abs(z.price - entry) / Math.max(atr, 0.01);
      return distAtr <= AWAIT_BAND_ATR && distAtr > AWAIT_MIN_ATR;
    })
    .sort((a, b) => b.reactionStrength - a.reactionStrength);
  return cands[0];
}

/* ─────────────── canonical resolution (deployed resolver port) ─────────────── */

interface Ladder { direction: 'BUY' | 'SELL'; entry: number; sl: number; tp1: number; tp2: number; tp3: number }
interface Resolution { status: string; exitPrice: number; realizedR: number; filled: boolean; minutesToFill: number | null }

function postTP1LockPrice(s: Ladder): number {
  const stopDistance = Math.abs(s.entry - s.sl);
  const tp1Distance = Math.abs(s.tp1 - s.entry);
  const minDelta = TP1_LOCK_MIN_PIPS * PIP;
  const base = Number.isFinite(stopDistance) && stopDistance > 0 ? stopDistance * TP1_LOCK_R : minDelta;
  const ceiling = Number.isFinite(tp1Distance) && tp1Distance > 0 ? tp1Distance * TP1_LOCK_MAX_FRAC : Number.POSITIVE_INFINITY;
  const delta = Math.min(Math.max(base, minDelta), ceiling);
  const raw = s.direction === 'BUY' ? s.entry + delta : s.entry - delta;
  return Number(raw.toFixed(1));
}

function protectedExitPrice(s: Ladder, targetsHit: number): number {
  const normalized = Math.max(0, Math.min(2, targetsHit));
  if (normalized >= 2) return Number(((s.tp1 + s.tp2 + s.entry) / 3).toFixed(1));
  if (normalized === 1) return postTP1LockPrice(s);
  return s.entry;
}

function resolveLadder(s: Ladder, bars: Bar[], fromMs: number): Resolution | null {
  const isBuy = s.direction === 'BUY';
  const risk = Math.abs(s.entry - s.sl);
  if (risk <= 0) return null;
  const window = bars.filter(b => b.t >= fromMs + SAFE_BAR_OFFSET_MS && b.t <= fromMs + RESOLUTION_WINDOW_MS);
  if (window.length === 0) return null;
  const rOf = (exit: number): number => ((isBuy ? exit - s.entry : s.entry - exit) / risk) - costInR(risk);
  const touched = (b: Bar, level: number): boolean => b.l <= level && b.h >= level;
  let entryFilled = false;
  let fillIdx = -1;
  let tp1Hit = false;
  let tp2Hit = false;
  let lockPrice = s.sl;
  for (let i = 0; i < window.length; i++) {
    const bar = window[i];
    if (!entryFilled) {
      if (!touched(bar, s.entry)) continue;
      entryFilled = true;
      fillIdx = i;
    }
    if (touched(bar, lockPrice)) {
      if (tp2Hit) {
        const exitPrice = protectedExitPrice(s, 2);
        return { status: 'PARTIAL_WIN_SL_HIT', exitPrice, realizedR: rOf(exitPrice), filled: true, minutesToFill: Math.round((window[fillIdx].t - fromMs) / 60000) };
      }
      if (tp1Hit) {
        const exitPrice = lockPrice;
        return { status: 'SL_AFTER_BE', exitPrice, realizedR: rOf(exitPrice), filled: true, minutesToFill: Math.round((window[fillIdx].t - fromMs) / 60000) };
      }
      return { status: 'SL_HIT', exitPrice: lockPrice, realizedR: rOf(lockPrice), filled: true, minutesToFill: Math.round((window[fillIdx].t - fromMs) / 60000) };
    }
    if (touched(bar, s.tp3)) {
      return { status: 'ALL_TARGETS_HIT', exitPrice: s.tp3, realizedR: rOf(s.tp3), filled: true, minutesToFill: Math.round((window[fillIdx].t - fromMs) / 60000) };
    }
    if (!tp2Hit && touched(bar, s.tp2)) {
      tp2Hit = true;
      lockPrice = s.entry;
    }
    if (!tp1Hit && touched(bar, s.tp1)) {
      tp1Hit = true;
      lockPrice = postTP1LockPrice(s);
    }
  }
  if (!entryFilled) return { status: 'ENTRY_NEVER_FILLED', exitPrice: NaN, realizedR: NaN, filled: false, minutesToFill: null };
  const last = window[window.length - 1];
  return { status: 'CLOSED', exitPrice: last.c, realizedR: rOf(last.c), filled: true, minutesToFill: Math.round((window[fillIdx].t - fromMs) / 60000) };
}

/* ───────────────────────────── main ───────────────────────────── */

const TOP_BUYS: Array<{ id: string; label: string }> = [
  { id: 'signal_1787322718300_hpy5mh8ld', label: '4601 (2026-08-21 14:31Z)' },
  { id: 'signal_1787295208116_i44ilxit7', label: '4565 (2026-08-21 06:53Z)' },
  { id: 'signal_1787144425005_5qyon2qk8', label: '4438.6 (2026-08-19 13:00Z)' },
];

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('ITEMS 191/192/193 MEASUREMENT — ' + new Date().toISOString());
  console.log('='.repeat(100));

  const emitted = await fetchAll<EmittedRow>('emitted_signals_v1', 'signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, atr, sr_zones_snapshot', 'emitted_at');
  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, result, realized_r, is_scratch', 'signal_id');
  console.log(`fetched: emitted=${emitted.length} outcomes=${outcomes.length}`);

  const outcomeBySignal = new Map<string, OutcomeRow>();
  for (const o of outcomes) outcomeBySignal.set(o.signal_id, o);

  // ── 191(b): one-sidedness distribution across EVERY stored snapshot ──
  const withSnap = emitted.filter(e => parseZones(e.sr_zones_snapshot).length > 0);
  const shares: number[] = [];
  let fullySupport = 0;
  let fullyResistance = 0;
  let over80 = 0;
  for (const e of withSnap) {
    const zs = parseZones(e.sr_zones_snapshot);
    const sup = zs.filter(z => z.type === 'SUPPORT').length;
    const res = zs.length - sup;
    const share = Math.max(sup, res) / zs.length;
    shares.push(share);
    if (sup === zs.length) fullySupport++;
    if (res === zs.length) fullyResistance++;
    if (share > 0.8) over80++;
  }
  shares.sort((a, b) => a - b);
  const median = shares.length > 0 ? shares[Math.floor(shares.length / 2)] : 0;
  console.log('\n── 191(b) ONE-SIDEDNESS across every stored snapshot ──');
  console.log(`snapshots with zones: n=${withSnap.length}`);
  console.log(`median dominant-side share: ${(median * 100).toFixed(1)}%`);
  console.log(`snapshots >80% one-sided: ${over80}/${withSnap.length} = ${(over80 / withSnap.length * 100).toFixed(1)}%`);
  console.log(`snapshots 100% SUPPORT (zero resistance): ${fullySupport}/${withSnap.length} = ${(fullySupport / withSnap.length * 100).toFixed(1)}%`);
  console.log(`snapshots 100% RESISTANCE: ${fullyResistance}/${withSnap.length}`);

  // canonical population: resolved, non-scratch, snapshot present
  const canonical = emitted.filter(e => {
    const o = outcomeBySignal.get(e.signal_id);
    return !!o && o.realized_r !== null && (o.is_scratch === null || o.is_scratch === false) && parseZones(e.sr_zones_snapshot).length > 0;
  });
  console.log(`\ncanonical population (resolved, non-scratch, snapshot present): n=${canonical.length}`);
  console.log('POWER BEFORE 191(b) split:');

  const oneSided: { result: string; realized_r: number | null }[] = [];
  const balanced: { result: string; realized_r: number | null }[] = [];
  const zeroOpposing: { result: string; realized_r: number | null }[] = [];
  const hasOpposing: { result: string; realized_r: number | null }[] = [];
  for (const e of canonical) {
    const zs = parseZones(e.sr_zones_snapshot);
    const sup = zs.filter(z => z.type === 'SUPPORT').length;
    const res = zs.length - sup;
    const share = Math.max(sup, res) / zs.length;
    const o = outcomeBySignal.get(e.signal_id)!;
    const rec = { result: o.result, realized_r: o.realized_r };
    (share > 0.8 ? oneSided : balanced).push(rec);
    const opposing = e.direction === 'BUY' ? res : sup;
    (opposing === 0 ? zeroOpposing : hasOpposing).push(rec);
  }
  console.log(`  MDE (WR, two-prop) oneSided-vs-balanced: ±${(mdeWR(oneSided.length, balanced.length, 0.45) * 100).toFixed(1)}pp`);
  console.log('  191(b) split (>80% one-sided map vs balanced map):');
  armStats(oneSided, 'one-sided >80%');
  armStats(balanced, 'balanced <=80%');

  // ── 192(b): zero-opposing vs has-opposing (legacy typing) ──
  console.log('\n── 192(b) ZERO-OPPOSING split (legacy typing, what the shipped veto saw) ──');
  console.log('POWER BEFORE the result:');
  console.log(`  MDE (WR, two-prop): ±${(mdeWR(zeroOpposing.length, hasOpposing.length, 0.45) * 100).toFixed(1)}pp`);
  armStats(zeroOpposing, 'ZERO opposing zones');
  armStats(hasOpposing, '>=1 opposing zone');
  console.log(`  gate 192(c): n>=30/arm? zero=${zeroOpposing.length} has=${hasOpposing.length}`);

  // ── bars for re-typing + re-scoring ──
  const neededIds = new Set<string>([...canonical.map(e => e.signal_id), ...TOP_BUYS.map(t => t.id)]);
  const needed = emitted.filter(e => neededIds.has(e.signal_id));
  const times = needed.map(e => new Date(e.emitted_at).getTime()).filter(t => Number.isFinite(t));
  const minT = Math.min(...times) - TYPING_LOOKBACK_MS;
  const maxT = Math.max(...times) + RESOLUTION_WINDOW_MS + 60 * 60 * 1000;
  console.log(`\nfetching bars ${new Date(minT).toISOString()} .. ${new Date(maxT).toISOString()} for typing+re-scoring...`);
  const bars = await fetchBars(minT, maxT);
  console.log(`bars fetched: ${bars.length}`);

  // ── 191(e): veto re-derivation under rejection-directed typing ──
  // 118 of 147 canonical rows have atr=NULL in emitted_signals_v1 (written before
  // the atr column was populated). Skipping them would cut the measurement to n=29.
  // Fallback: derive a scale from the bars themselves. The stored atr is the
  // engine's M5 ATR-14; the bar window is M1. Measure the median ratio
  // atr_column / M1-window-mean-TR on the rows that HAVE atr, then apply that
  // measured scale to the null rows. LABEL: 'scaled-M1-TR estimate'.
  const ratios: number[] = [];
  for (const e of canonical) {
    if (e.atr === null || !Number.isFinite(e.atr) || e.atr <= 0) continue;
    const emittedMs = new Date(e.emitted_at).getTime();
    const w = bars.filter(b => b.t >= emittedMs - TYPING_LOOKBACK_MS && b.t < emittedMs);
    if (w.length < 30) continue;
    let trSum = 0;
    let trN = 0;
    for (let i = 1; i < w.length; i++) {
      trSum += Math.max(w[i].h - w[i].l, Math.abs(w[i].h - w[i - 1].c), Math.abs(w[i].l - w[i - 1].c));
      trN++;
    }
    if (trN > 0 && trSum / trN > 0) ratios.push(e.atr / (trSum / trN));
  }
  ratios.sort((a, b) => a - b);
  const ATR_SCALE = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : 1;
  console.log(`\n── 191(e) VETO RE-DERIVATION under rejection-directed typing (canonical) ──`);
  console.log(`atr fallback scale: median(engine M5 ATR / M1 window mean TR) = ${ATR_SCALE.toFixed(3)} over ${ratios.length} rows with stored atr`);
  let noBars = 0;
  let atrFallbackUsed = 0;
  const changed: { result: string; realized_r: number | null }[] = [];
  const unchanged: { result: string; realized_r: number | null }[] = [];
  let changedWin = 0;
  for (const e of canonical) {
    const emittedMs = new Date(e.emitted_at).getTime();
    const zones = parseZones(e.sr_zones_snapshot);
    const window = bars.filter(b => b.t >= emittedMs - TYPING_LOOKBACK_MS && b.t < emittedMs);
    if (window.length < 30) { noBars++; continue; }
    let atr = e.atr;
    if (atr === null || !Number.isFinite(atr) || atr <= 0) {
      let trSum = 0;
      let trN = 0;
      for (let i = 1; i < window.length; i++) {
        trSum += Math.max(window[i].h - window[i].l, Math.abs(window[i].h - window[i - 1].c), Math.abs(window[i].l - window[i - 1].c));
        trN++;
      }
      if (trN === 0 || trSum / trN <= 0) { noBars++; continue; }
      atr = (trSum / trN) * ATR_SCALE;
      atrFallbackUsed++;
    }
    {
    const typed = retypeZones(zones, bars, emittedMs, atr);
    const opposing = e.direction === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const blocking = findBlockingZone(typed, opposing, e.entry, e.tp1);
    const o = outcomeBySignal.get(e.signal_id)!;
    const rec = { result: o.result, realized_r: o.realized_r };
    if (blocking) {
      changed.push(rec);
      if (o.result === 'WIN') changedWin++;
    } else {
      unchanged.push(rec);
    }
    }
  }
  console.log(`re-typed: n=${changed.length + unchanged.length} (skipped noBars=${noBars}; atrFallbackUsed=${atrFallbackUsed} with scaled-M1-TR estimate)`);
  console.log(`emit -> veto changes: ${changed.length}`);
  console.log('POWER BEFORE the split:');
  console.log(`  MDE (WR, two-prop) changed-vs-unchanged: ±${(mdeWR(changed.length, unchanged.length, 0.45) * 100).toFixed(1)}pp`);
  armStats(changed, 'changed to VETO (would not emit)');
  armStats(unchanged, 'unchanged (still emits)');

  // ── 191(d): the 4601 counterfactual, zone by zone ──
  console.log('\n── 191(d) THE 4601 SIGNAL UNDER REJECTION-DIRECTED TYPING ──');
  const s4601 = emitted.find(e => e.signal_id === 'signal_1787322718300_hpy5mh8ld');
  if (!s4601 || s4601.atr === null) {
    console.log('4601 signal row not found / atr null');
  } else {
    const emittedMs = new Date(s4601.emitted_at).getTime();
    const zones = parseZones(s4601.sr_zones_snapshot);
    const typed = retypeZones(zones, bars, emittedMs, s4601.atr);
    console.log(`entry=${s4601.entry} TP1=${s4601.tp1} SL=${s4601.sl} ATR=${s4601.atr} emitted=${s4601.emitted_at}`);
    console.log('  price   legacyType    below above  newType     rs     band  (below=reject-from-below=resistance behaviour)');
    for (const z of typed.sort((a, b) => b.price - a.price)) {
      const flip = z.newType !== z.type ? '  <-- FLIPPED' : '';
      console.log(`  ${z.price.toFixed(1).padStart(7)} ${z.type.padEnd(12)} ${String(z.below).padStart(5)} ${String(z.above).padStart(5)}  ${z.newType.padEnd(10)} ${(z.reactionStrength).toFixed(3)}  ${z.band.toFixed(2)}${flip}`);
    }
    const blocking = findBlockingZone(typed, 'RESISTANCE', s4601.entry, s4601.tp1);
    console.log(`path-to-target veto (new typing): blocking zone between ${s4601.entry} and ${s4601.tp1}? ${blocking ? `YES — ${blocking.price} (${blocking.newType}, rs=${blocking.reactionStrength})` : 'NO — no zone of any type sits above the entry'}`);
    const target = findAwaitTarget(typed, 'SUPPORT', s4601.atr, s4601.entry);
    console.log(`await-the-zone target (new typing, same-side SUPPORT within 3 ATR): ${target ? `${target.price} (rs=${target.reactionStrength}, ${(Math.abs(target.price - s4601.entry) / s4601.atr).toFixed(2)} ATR below)` : 'none'}`);
    const legacyOpposing = typed.filter(z => z.type === 'RESISTANCE').length;
    console.log(`192 no-structure (legacy typing): opposing zones = ${legacyOpposing} -> ${legacyOpposing === 0 ? 'FIRES (route to await-zone at strongest same-side shelf)' : 'does not fire'}`);
    const legacyTarget = findAwaitTarget(typed.map(z => ({ ...z, newType: z.type })), 'SUPPORT', s4601.atr, s4601.entry);
    console.log(`192 await-zone target (legacy same-side): ${legacyTarget ? `${legacyTarget.price} (rs=${legacyTarget.reactionStrength}, ${(Math.abs(legacyTarget.price - s4601.entry) / s4601.atr).toFixed(2)} ATR)` : 'none in band'}`);
    const o = outcomeBySignal.get(s4601.signal_id);
    console.log(`actual outcome: ${o ? `${o.result} r=${o.realized_r}` : 'not yet in trade_outcomes_v1'}`);
  }

  // ── 193(c): three top-buys under combined 191+192+reachable await-zone ──
  console.log('\n── 193(c) THREE TOP-BUYS UNDER COMBINED 191 + 192 + REACHABLE AWAIT-THE-ZONE ──');
  for (const tb of TOP_BUYS) {
    const e = emitted.find(x => x.signal_id === tb.id);
    const o = e ? outcomeBySignal.get(e.signal_id) : undefined;
    console.log(`\n  ${tb.label}  ${e ? `${e.direction} entry=${e.entry} TP1=${e.tp1} SL=${e.sl} ATR=${e.atr} conf=${e.confidence ?? 'n/a'}` : 'ROW NOT FOUND'}`);
    if (o) console.log(`    actual: ${o.result} realized_r=${o.realized_r}`);
    if (!e || e.atr === null) continue;
    const emittedMs = new Date(e.emitted_at).getTime();
    const zones = parseZones(e.sr_zones_snapshot);
    const typed = retypeZones(zones, bars, emittedMs, e.atr);
    const opposing = e.direction === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const sameSide = e.direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
    const blocking = findBlockingZone(typed, opposing, e.entry, e.tp1);
    const legacyOpposingCount = typed.filter(z => z.type === opposing).length;
    let branch = 'EMIT (unchanged)';
    let target: TypedZone | undefined;
    if (blocking) {
      target = findAwaitTarget(typed, sameSide, e.atr, e.entry);
      branch = target ? `191-VETO -> AWAIT-ZONE at ${target.price}` : '191-VETO -> straight veto (no same-side zone in band)';
    } else if (legacyOpposingCount === 0) {
      target = findAwaitTarget(typed.map(z => ({ ...z, newType: z.type })), sameSide, e.atr, e.entry);
      branch = target ? `192-NO-STRUCTURE -> AWAIT-ZONE at ${target.price}` : '192-NO-STRUCTURE -> straight veto (no same-side zone within 3 ATR)';
    }
    console.log(`    combined decision: ${branch}`);
    if (target) {
      const delta = target.price - e.entry;
      const moved: Ladder = { direction: e.direction, entry: target.price, sl: e.sl + delta, tp1: e.tp1 + delta, tp2: e.tp2 + delta, tp3: e.tp3 + delta };
      console.log(`    moved ladder: entry=${moved.entry} SL=${moved.sl} TP1=${moved.tp1} TP2=${moved.tp2} TP3=${moved.tp3} (shift ${delta.toFixed(1)})`);
      const res = resolveLadder(moved, bars, emittedMs);
      if (!res) {
        console.log('    counterfactual resolution: NO BARS in window');
      } else if (!res.filled) {
        console.log(`    counterfactual resolution: ENTRY_NEVER_FILLED — pending entry expires after 4h; the at-market trade is FORGONE (miss cost = actual ${o ? o.realized_r : '?'}R)`);
      } else {
        console.log(`    counterfactual resolution: ${res.status} exit=${res.exitPrice} realizedR=${res.realizedR.toFixed(4)} (filled after ${res.minutesToFill}min) vs actual ${o ? `${o.result} ${o.realized_r}R` : 'unresolved'}`);
      }
    } else if (branch.includes('straight veto')) {
      console.log(`    counterfactual: NO TRADE AT ALL — the at-market trade is forgone (miss cost = actual ${o ? o.realized_r : '?'}R)`);
    } else {
      const res = resolveLadder({ direction: e.direction, entry: e.entry, sl: e.sl, tp1: e.tp1, tp2: e.tp2, tp3: e.tp3 }, bars, emittedMs);
      console.log(`    counterfactual (emit at market, unchanged): ${res ? `${res.status} r=${res.realizedR.toFixed(4)}` : 'no bars'}`);
    }
  }

  console.log('\nDONE.');
}

main().catch(err => { console.error('FAILED:', err instanceof Error ? err.message : String(err)); process.exit(1); });
