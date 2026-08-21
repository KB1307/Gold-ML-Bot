/**
 * ITEMS 197 / 198 — THE SNAPSHOT-ERA BOOK, AND 191(e) RE-RUN ON DIRECT ATR.
 *
 * 197(a): confirm the -0.1352R aggregate arithmetic; publish the snapshot-era
 *         canonical book: n, WR, EV_gross, EV_net, PF, MaxDD, with CIs.
 * 197(b): the pre-snapshot era on the same formula; era-vs-sample-vs-regime
 *         verdict controlled for realised volatility per period.
 * 197(c): plain losing-or-not statement with confidence (printed, not softened).
 * 198(a): dispersion of the ATR imputation ratio on the 29 rows that HAVE atr.
 * 198(b): ATR recomputed DIRECTLY from gold_m1_bars for the 118 NULL-atr rows
 *         (Wilder ATR-14 over the last 15 M1 bars — the resolver's construct).
 * 198(c): 191(e)'s emit->veto flip count and outcome split re-run on direct ATR.
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
  entry: number; sl: number; tp1: number; atr: number | null; sr_zones_snapshot: unknown;
}
interface OutcomeRow { signal_id: string; ts: string; result: string; realized_r: number | null; is_scratch: boolean | null }

const SNAPSHOT_ERA_START = new Date('2026-07-16T10:51:28.481Z').getTime(); // first stored sr_zones_snapshot
const EXECUTION_COST_USD = 0.2;
const ZONE_WIDTH_FLOOR_PCT = 0.0001;
const TYPING_LOOKBACK_MS = 24 * 60 * 60 * 1000;

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

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function bootstrapMeanCI(vals: number[], resamples = 3000): [number, number] {
  if (vals.length === 0) return [0, 0];
  const rng = makeRng(20260822);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < vals.length; i++) sum += vals[Math.floor(rng() * vals.length)];
    means.push(sum / vals.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(resamples * 0.025)], means[Math.floor(resamples * 0.975)]];
}

function bootstrapDiffCI(a: number[], b: number[], resamples = 3000): [number, number] {
  if (a.length === 0 || b.length === 0) return [0, 0];
  const rng = makeRng(20260823);
  const diffs: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sa = 0; let sb = 0;
    for (let i = 0; i < a.length; i++) sa += a[Math.floor(rng() * a.length)];
    for (let i = 0; i < b.length; i++) sb += b[Math.floor(rng() * b.length)];
    diffs.push(sa / a.length - sb / b.length);
  }
  diffs.sort((a2, b2) => a2 - b2);
  return [diffs[Math.floor(resamples * 0.025)], diffs[Math.floor(resamples * 0.975)]];
}

interface BookRow { netR: number; grossR: number | null }
interface Book {
  n: number; wr: number; wrCI: [number, number];
  evNet: number; evNetCI: [number, number];
  evGross: number | null; pf: number | null; maxDD: number;
}
function book(rows: BookRow[]): Book {
  const net = rows.map(r => r.netR);
  const wins = rows.filter(r => r.netR > 0).length;
  const evNet = net.length > 0 ? net.reduce((a, b) => a + b, 0) / net.length : 0;
  const withGross = rows.filter(r => r.grossR !== null) as Array<{ netR: number; grossR: number }>;
  let evGross: number | null = null;
  let pf: number | null = null;
  if (withGross.length > 0) {
    evGross = withGross.reduce((s, r) => s + r.grossR, 0) / withGross.length;
    const grossWins = withGross.filter(r => r.grossR > 0).reduce((s, r) => s + r.grossR, 0);
    const grossLosses = withGross.filter(r => r.grossR < 0).reduce((s, r) => s + r.grossR, 0);
    pf = grossLosses !== 0 ? grossWins / Math.abs(grossLosses) : null;
  }
  // MaxDD on the cumulative net-R series in ts order.
  let cum = 0; let peak = 0; let maxDD = 0;
  for (const r of net) { cum += r; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum; }
  return { n: rows.length, wr: rows.length > 0 ? wins / rows.length : 0, wrCI: wilson(wins, rows.length), evNet, evNetCI: bootstrapMeanCI(net), evGross, pf, maxDD };
}

function printBook(label: string, b: Book): void {
  console.log(`  ${label}:`);
  console.log(`    n=${b.n}  WR=${(b.wr * 100).toFixed(1)}% [${(b.wrCI[0] * 100).toFixed(1)}, ${(b.wrCI[1] * 100).toFixed(1)}]`);
  console.log(`    EV_net=${b.evNet.toFixed(4)}R  CI[${b.evNetCI[0].toFixed(4)}, ${b.evNetCI[1].toFixed(4)}]  EV_gross=${b.evGross === null ? 'n/a' : b.evGross.toFixed(4) + 'R'}  PF=${b.pf === null ? 'n/a' : b.pf.toFixed(2)}  MaxDD=${b.maxDD.toFixed(2)}R`);
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

function costInR(risk: number): number {
  if (!Number.isFinite(risk) || risk <= 0) return 0;
  return EXECUTION_COST_USD / risk;
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

/* ───────────────────────────── main ───────────────────────────── */

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('ITEMS 197 / 198 MEASUREMENT — ' + new Date().toISOString());
  console.log('='.repeat(100));

  const emitted = await fetchAll<EmittedRow>('emitted_signals_v1', 'signal_id, emitted_at, direction, entry, sl, tp1, atr, sr_zones_snapshot', 'emitted_at');
  const outcomes = await fetchAll<OutcomeRow>('trade_outcomes_v1', 'signal_id, ts, result, realized_r, is_scratch', 'ts');
  console.log(`emitted=${emitted.length} outcomes=${outcomes.length}`);

  const emittedBySignal = new Map(emitted.map(e => [e.signal_id, e] as const));
  const canonical = outcomes
    .filter(o => o.realized_r !== null && (o.is_scratch === null || o.is_scratch === false) && emittedBySignal.has(o.signal_id))
    .map(o => ({ outcome: o, sig: emittedBySignal.get(o.signal_id)! }));
  console.log(`canonical (resolved, non-scratch, emission joinable): n=${canonical.length}`);

  const eraRows = canonical.map(r => {
    const risk = Math.abs(r.sig.entry - r.sig.sl);
    return {
      row: { netR: r.outcome.realized_r ?? 0, grossR: Number.isFinite(risk) && risk > 0 ? (r.outcome.realized_r ?? 0) + costInR(risk) : null } as BookRow,
      emittedMs: new Date(r.sig.emitted_at).getTime(),
      sig: r.sig,
      outcome: r.outcome,
    };
  });

  const snapshotEra = eraRows.filter(r => r.emittedMs >= SNAPSHOT_ERA_START);
  const preEra = eraRows.filter(r => r.emittedMs < SNAPSHOT_ERA_START);
  console.log(`era split at ${new Date(SNAPSHOT_ERA_START).toISOString()}: snapshot-era n=${snapshotEra.length}, pre-snapshot n=${preEra.length}`);

  // ── 197(a): arithmetic confirmation + the snapshot-era book ──
  console.log('\n── 197(a) ARITHMETIC CONFIRMATION ──');
  const snapCanon = snapshotEra.filter(r => parseZones(r.sig.sr_zones_snapshot).length > 0);
  const snapNet = snapshotEra.map(r => r.row.netR);
  const directMean = snapNet.length > 0 ? snapNet.reduce((a, b) => a + b, 0) / snapNet.length : 0;
  // recompute the 191(b) arms on the with-snapshot subset for the weighted check
  const oneSided: number[] = [];
  const balanced: number[] = [];
  for (const r of snapCanon) {
    const zs = parseZones(r.sig.sr_zones_snapshot);
    const sup = zs.filter(z => z.type === 'SUPPORT').length;
    const res = zs.length - sup;
    const share = Math.max(sup, res) / zs.length;
    (share > 0.8 ? oneSided : balanced).push(r.row.netR);
  }
  const evOne = oneSided.length > 0 ? oneSided.reduce((a, b) => a + b, 0) / oneSided.length : 0;
  const evBal = balanced.length > 0 ? balanced.reduce((a, b) => a + b, 0) / balanced.length : 0;
  const weighted = (evOne * oneSided.length + evBal * balanced.length) / (oneSided.length + balanced.length);
  console.log(`  direct snapshot-era canonical mean EV_net (all ${snapshotEra.length} rows): ${directMean.toFixed(4)}R`);
  console.log(`  191(b) arms recomputed: one-sided n=${oneSided.length} EV=${evOne.toFixed(4)} | balanced n=${balanced.length} EV=${evBal.toFixed(4)}`);
  console.log(`  weighted aggregate of the arms: ${weighted.toFixed(4)}R  (user's arithmetic: -0.1352R)`);
  console.log(`  arithmetic ${Math.abs(weighted - (-0.1352)) < 0.002 ? 'CONFIRMED' : 'CHECK — differs'}`);

  console.log('\n── 197(a) THE SNAPSHOT-ERA CANONICAL BOOK ──');
  printBook('snapshot era', book(snapshotEra.map(r => r.row)));

  // ── 197(b): pre-snapshot era + vol control ──
  console.log('\n── 197(b) PRE-SNAPSHOT ERA (same formula) ──');
  printBook('pre-snapshot era', book(preEra.map(r => r.row)));
  const diffCI = bootstrapDiffCI(preEra.map(r => r.row.netR), snapshotEra.map(r => r.row.netR));
  console.log(`  era difference (pre - snapshot) EV_net: ${(preEra.reduce((s, r) => s + r.row.netR, 0) / Math.max(preEra.length, 1) - directMean).toFixed(4)}R  bootstrap CI[${diffCI[0].toFixed(4)}, ${diffCI[1].toFixed(4)}]`);

  // realised volatility per era from the bars
  const eraBarsNeeded = snapshotEra.length > 0;
  if (eraBarsNeeded) {
    const minEra = Math.min(...preEra.map(r => r.emittedMs), ...snapshotEra.map(r => r.emittedMs));
    const maxEra = Math.max(...preEra.map(r => r.emittedMs), ...snapshotEra.map(r => r.emittedMs));
    const allBars = await fetchBars(minEra, maxEra);
    const volStats = (from: number, to: number): string => {
      const bars = allBars.filter(b => b.t >= from && b.t <= to);
      if (bars.length < 100) return 'insufficient bars';
      let trSum = 0;
      const rets: number[] = [];
      for (let i = 1; i < bars.length; i++) {
        trSum += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
        rets.push(Math.log(bars[i].c / bars[i - 1].c));
      }
      const meanTR = trSum / (bars.length - 1);
      const meanRet = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((s, r) => s + (r - meanRet) ** 2, 0) / rets.length);
      const dailyVol = sd * Math.sqrt(1440) * 100;
      return `bars=${bars.length} meanTR=$${meanTR.toFixed(3)} 1-min logret sd=${sd.toFixed(6)} (~${dailyVol.toFixed(2)}% daily) `;
    };
    console.log('\n  realised volatility per era (gold_m1_bars):');
    const preMin = preEra.length > 0 ? Math.min(...preEra.map(r => r.emittedMs)) : 0;
    const preMax = preEra.length > 0 ? Math.max(...preEra.map(r => r.emittedMs)) : 0;
    const snapMin = Math.min(...snapshotEra.map(r => r.emittedMs));
    const snapMax = Math.max(...snapshotEra.map(r => r.emittedMs));
    console.log(`    pre-snapshot era  ${new Date(preMin).toISOString()} .. ${new Date(preMax).toISOString()}: ${volStats(preMin, preMax)}`);
    console.log(`    snapshot era      ${new Date(snapMin).toISOString()} .. ${new Date(snapMax).toISOString()}: ${volStats(snapMin, snapMax)}`);
    const snapBars = allBars.filter(b => b.t >= snapMin && b.t <= snapMax);
    if (snapBars.length > 100) {
      let trSum = 0;
      for (let i = 1; i < snapBars.length; i++) trSum += Math.max(snapBars[i].h - snapBars[i].l, Math.abs(snapBars[i].h - snapBars[i - 1].c), Math.abs(snapBars[i].l - snapBars[i - 1].c));
      const meanTR = trSum / (snapBars.length - 1);
      console.log(`    snapshot-era EV in volatility units: ${directMean.toFixed(4)}R; mean 1-min TR $${meanTR.toFixed(3)} -> EV = ${(directMean * Math.abs(riskProxy()) / meanTR).toFixed(3)} mean-TRs per trade (risk proxy = $8 SL)`);
    }
  }

  // ── 197(c): plain statement ──
  console.log('\n── 197(c) PLAIN VERDICT INPUT ──');
  const snapBook = book(snapshotEra.map(r => r.row));
  console.log(`  snapshot-era EV_net = ${snapBook.evNet.toFixed(4)}R, bootstrap 95% CI [${snapBook.evNetCI[0].toFixed(4)}, ${snapBook.evNetCI[1].toFixed(4)}]`);
  console.log(`  CI ${snapBook.evNetCI[1] < 0 ? 'ENTIRELY BELOW ZERO — losing at 95% confidence' : 'SPANS ZERO — direction negative, significance not established'}`);

  // ── 198: ATR imputation ──
  console.log('\n── 198(a) ATR IMPUTATION RATIO DISPERSION (rows with stored atr) ──');
  const snapTimes = snapshotEra.map(r => r.emittedMs);
  const barsStart = Math.min(...snapTimes) - TYPING_LOOKBACK_MS;
  const barsEnd = Math.max(...snapTimes) + 60_000;
  console.log(`fetching bars ${new Date(barsStart).toISOString()} .. ${new Date(barsEnd).toISOString()} ...`);
  const bars = await fetchBars(barsStart, barsEnd);
  console.log(`bars: ${bars.length}`);

  const ratios: number[] = [];
  for (const r of snapCanon) {
    if (r.sig.atr === null || !Number.isFinite(r.sig.atr) || r.sig.atr <= 0) continue;
    const emittedMs = r.emittedMs;
    const w = bars.filter(b => b.t >= emittedMs - TYPING_LOOKBACK_MS && b.t < emittedMs);
    if (w.length < 30) continue;
    let trSum = 0; let trN = 0;
    for (let i = 1; i < w.length; i++) { trSum += Math.max(w[i].h - w[i].l, Math.abs(w[i].h - w[i - 1].c), Math.abs(w[i].l - w[i - 1].c)); trN++; }
    if (trN === 0 || trSum / trN <= 0) continue;
    ratios.push(r.sig.atr / (trSum / trN));
  }
  ratios.sort((a, b) => a - b);
  if (ratios.length > 0) {
    const q = (p: number) => ratios[Math.floor(ratios.length * p)];
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const sd = Math.sqrt(ratios.reduce((s, r) => s + (r - mean) ** 2, 0) / ratios.length);
    console.log(`  n=${ratios.length} median=${q(0.5).toFixed(3)} IQR=[${q(0.25).toFixed(3)}, ${q(0.75).toFixed(3)}] min=${ratios[0].toFixed(3)} max=${ratios[ratios.length - 1].toFixed(3)} mean=${mean.toFixed(3)} sd=${sd.toFixed(3)} CV=${(sd / mean * 100).toFixed(1)}%`);
  }

  console.log('\n── 198(b/c) DIRECT ATR + 191(e) RE-RUN ──');
  let directAtrUsed = 0;
  let noBarsCount = 0;
  const changed: { result: string; realized_r: number | null }[] = [];
  const unchanged: { result: string; realized_r: number | null }[] = [];
  let atrDeltaAbs: number[] = [];
  for (const r of snapCanon) {
    const emittedMs = r.emittedMs;
    const window = bars.filter(b => b.t >= emittedMs - TYPING_LOOKBACK_MS && b.t < emittedMs);
    if (window.length < 30) { noBarsCount++; continue; }
    const directAtr = wilderAtr14(window);
    if (directAtr === null) { noBarsCount++; continue; }
    if (r.sig.atr !== null && Number.isFinite(r.sig.atr) && r.sig.atr > 0) atrDeltaAbs.push(Math.abs(directAtr - r.sig.atr));
    else directAtrUsed++;
    const zones = parseZones(r.sig.sr_zones_snapshot);
    // re-type by rejection direction using the DIRECT atr for the band
    const typed = zones.map(z => {
      const band = Math.max(directAtr * 0.3, z.price * ZONE_WIDTH_FLOOR_PCT);
      const zoneLow = z.price - band;
      const zoneHigh = z.price + band;
      let below = 0; let above = 0;
      for (let i = 1; i < window.length; i++) {
        const b = window[i];
        const prev = window[i - 1];
        if (prev.c < zoneLow && b.h >= zoneLow && b.c < zoneLow) below++;
        if (prev.c > zoneHigh && b.l <= zoneHigh && b.c > zoneHigh) above++;
      }
      const newType: 'SUPPORT' | 'RESISTANCE' = below > above ? 'RESISTANCE' : above > below ? 'SUPPORT' : z.type;
      return { ...z, newType };
    });
    const opposing = r.sig.direction === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
    const minP = Math.min(r.sig.entry, r.sig.tp1);
    const maxP = Math.max(r.sig.entry, r.sig.tp1);
    const blocking = typed.find(z => z.newType === opposing && z.price > minP + 0.01 && z.price < maxP - 0.01 && z.reactionStrength >= 0.3);
    const rec = { result: r.outcome.result, realized_r: r.outcome.realized_r };
    (blocking ? changed : unchanged).push(rec);
  }
  if (atrDeltaAbs.length > 0) {
    atrDeltaAbs = atrDeltaAbs.sort((a, b) => a - b);
    console.log(`  direct-vs-stored atr |delta| on the ${atrDeltaAbs.length} rows WITH atr: median=${atrDeltaAbs[Math.floor(atrDeltaAbs.length / 2)].toFixed(3)} max=${atrDeltaAbs[atrDeltaAbs.length - 1].toFixed(3)}`);
  }
  console.log(`  re-typed on DIRECT atr: n=${changed.length + unchanged.length} (directAtrUsed for NULL-atr rows: ${directAtrUsed}; skipped noBars: ${noBarsCount})`);
  console.log('  POWER BEFORE the split (two-prop WR MDE, changed-vs-unchanged):');
  const pBar = 0.45;
  const mde = (1.96 + 0.8416) * Math.sqrt(pBar * (1 - pBar) * (1 / Math.max(changed.length, 1) + 1 / Math.max(unchanged.length, 1)));
  console.log(`    MDE = ±${(mde * 100).toFixed(1)}pp`);
  const changedWins = changed.filter(c => c.result === 'WIN').length;
  const changedEv = changed.length > 0 ? changed.reduce((s, c) => s + (c.realized_r ?? 0), 0) / changed.length : 0;
  const unchangedWins = unchanged.filter(c => c.result === 'WIN').length;
  const unchangedEv = unchanged.length > 0 ? unchanged.reduce((s, c) => s + (c.realized_r ?? 0), 0) / unchanged.length : 0;
  console.log(`    changed to VETO: n=${changed.length} WR=${(changedWins / Math.max(changed.length, 1) * 100).toFixed(1)}% [${(wilson(changedWins, changed.length)[0] * 100).toFixed(1)}, ${(wilson(changedWins, changed.length)[1] * 100).toFixed(1)}] EV_net=${changedEv.toFixed(4)}R CI[${bootstrapMeanCI(changed.map(c => c.realized_r ?? 0))[0].toFixed(3)}, ${bootstrapMeanCI(changed.map(c => c.realized_r ?? 0))[1].toFixed(3)}]`);
  console.log(`    unchanged:        n=${unchanged.length} WR=${(unchangedWins / Math.max(unchanged.length, 1) * 100).toFixed(1)}% [${(wilson(unchangedWins, unchanged.length)[0] * 100).toFixed(1)}, ${(wilson(unchangedWins, unchanged.length)[1] * 100).toFixed(1)}] EV_net=${unchangedEv.toFixed(4)}R CI[${bootstrapMeanCI(unchanged.map(c => c.realized_r ?? 0))[0].toFixed(3)}, ${bootstrapMeanCI(unchanged.map(c => c.realized_r ?? 0))[1].toFixed(3)}]`);
  console.log(`    (Item 191(e) with the imputed ATR reported 27 flips at EV=-0.2794R; direct-ATR flip count above is the comparable number.)`);

  console.log('\nDONE.');
}

function riskProxy(): number { return 8; }

main().catch(err => { console.error('FAILED:', err instanceof Error ? err.message : String(err)); process.exit(1); });
