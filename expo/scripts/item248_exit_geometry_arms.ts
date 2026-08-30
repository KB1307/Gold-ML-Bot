/**
 * ITEM Y.1 — REGIME-MAPPED EXIT GEOMETRY, CANONICAL THREE-ARM RE-DERIVATION
 * (measurement only; NOTHING ships from this script — Y.2 is the annotation).
 *
 * POPULATION: the era-clean canonical population (decided, snapshot-bearing),
 * REAL resolver fromScratch + computeRNet — the same instrument as
 * item241/245/246/247. gold_m1_bars via anon key ONLY (DATA-SOURCE RULE).
 *
 * ARMS (prompt-defined, verbatim map):
 *   ARM-1 LIVE BOOKED (reference): the canonical resolver outcome (live ladder).
 *   ARM-2 PURE MAPPED: single TP at 4.0 x SL-distance, SL from the regime map:
 *     TREND (ADX(14,M5) > 25)      : SL = 3.5 x ATR(14,M5)
 *     MID   (ADX 20..25 inclusive) : SL = $8.00
 *     RANGE (ADX < 20)             : SL = 2.5 x ATR(14,M5)
 *   ARM-3 HYBRID: half the position banks at the LIVE TP1 distance (with the
 *     LIVE SL as its stop), half runs to the mapped TP with the ORIGINAL mapped
 *     SL; no lock. R = 0.5*liveLegR + 0.5*mappedLegR, both legs normalised by
 *     the LIVE risk (|entry - sl|) so the hybrid reads in live-R units (stated).
 *
 * FILL + RESOLUTION (stated): entry = the stored entryPrice for ALL arms (the
 * live fill); resolution begins at the first COMPLETED bar after
 * emitted_at + 60s (the shared safeBarStart). Single-TP walks scan bars in
 * order; if ONE bar contains BOTH the stop and the target, the STOP is taken
 * (conservative tie-break, stated). Cost netted via lib/evCompute computeRNet.
 * An arm that hits neither level by the last bar is UNDECIDED for that arm and
 * excluded from that arm's stats (counts reported); paired stats use signals
 * where ALL THREE arms decided.
 *
 * NO LOOK-AHEAD (hard rule): the regime label uses ONLY bars STRICTLY before
 * emitted_at. M5 bars are aggregated from M1 bars with ts < ems, and any M5
 * bucket whose CLOSE time (bucket start + 5m) is not strictly <= ems is DROPPED,
 * so no bar at or after emission can enter ADX or ATR. The script prints the
 * exact window fed to the indicators per regime bucket below.
 *
 * Indicators are the EXISTING instruments: services/barIndicators
 * aggregateBars / sealBarSeries / barADX / barATR. No new indicator code.
 *
 * POWER (MINDSET 7): every paired comparison prints MDE
 * 2.80*sigma_p*sqrt(1/n) BEFORE its point estimates. Bootstrap 20k, seed 20260828.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import { computeRNet } from '../lib/evCompute';
import { aggregateBars, sealBarSeries, barADX, barATR, type Bar } from '../services/barIndicators';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';

interface Row { signal_id: string; emitted_at: string; direction: string; entry: number; sl: number; tp1: number; tp2: number; tp3: number; confidence: number; sr_zones_snapshot: unknown }
interface Sig { id: string; dir: 'BUY' | 'SELL'; entry: number; sl: number; tp1: number; ems: number; rNet: number; regime: string | null; mappedSl: number | null; mappedTp: number | null; arm2: number | null; arm3: number | null; m5First: number | null; m5LastClose: number | null; m5Count: number }

function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + 0x6d2b79f5 * (t ^ (t >>> 15))) | 0; return ((t ^ (t >>> 16)) >>> 0) / 4294967296; }; }
const lbR = (bars: Bar[], t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; } return lo; };
const ev = (v: number[]): number => (v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN);

function bootDiff(a: number[], b: number[]): [number, number] {
  const rnd = mulberry32(20260828);
  const boots: number[] = [];
  for (let i = 0; i < 20000; i++) {
    let sa = 0, sb = 0;
    for (let t = 0; t < a.length; t++) sa += a[(rnd() * a.length) | 0];
    for (let t = 0; t < b.length; t++) sb += b[(rnd() * b.length) | 0];
    boots.push(sb / b.length - sa / a.length);
  }
  boots.sort((x, y) => x - y);
  return [boots[(boots.length * 0.025) | 0], boots[(boots.length * 0.975) | 0]];
}

function pairedStats(label: string, armX: number[], arm1: number[]): void {
  const n = armX.length;
  const paired = armX.map((v, i) => v - arm1[i]);
  const d = ev(paired);
  const pool = [...armX, ...arm1];
  const m = ev(pool);
  const sigmaP = Math.sqrt(pool.reduce((a, r) => a + (r - m) ** 2, 0) / (pool.length - 1));
  const mde = 2.8 * sigmaP * Math.sqrt(2 / n);
  console.log(`  ${label}:  MDE ±${mde.toFixed(4)}R (n=${n})  <-- stated BEFORE point estimates`);
  const rnd = mulberry32(20260828);
  const boots: number[] = [];
  for (let i = 0; i < 20000; i++) { let s = 0; for (let t = 0; t < paired.length; t++) s += paired[(rnd() * paired.length) | 0]; boots.push(s / paired.length); }
  boots.sort((a, b) => a - b);
  console.log(`    paired diff (arm - ARM-1) ${d >= 0 ? '+' : ''}${d.toFixed(4)}R; boot CI [${boots[0].toFixed(4)}, ${boots[boots.length - 1].toFixed(4)}]`);
}

function statLine(label: string, vals: number[]): string {
  const n = vals.length; const wr = n ? (vals.filter(v => v > 0).length / n) * 100 : NaN;
  return `  ${label.padEnd(26)} n=${String(n).padStart(4)}  WR=${isNaN(wr) ? '  - ' : wr.toFixed(1) + '%'}  EV_net=${n ? ((ev(vals) >= 0 ? '+' : '') + ev(vals).toFixed(4)) : '  -   '}R  total=${n ? ((vals.reduce((x, y) => x + y, 0) >= 0 ? '+' : '') + vals.reduce((x, y) => x + y, 0).toFixed(2)) : '  -  '}R`;
}

/** longest run of consecutive losers and max peak-to-trough drawdown, in R. */
function streakAndDrawdown(ordered: number[]): { longestLossStreak: number; maxDD: number } {
  let streak = 0, longest = 0, cum = 0, peak = 0, dd = 0;
  for (const v of ordered) {
    if (v < 0) { streak++; longest = Math.max(longest, streak); } else streak = 0;
    cum += v; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
  }
  return { longestLossStreak: longest, maxDD: dd };
}

/** single-TP walk; returns exit price or null if undecided by the last bar.
 *  Exported so the Y.2 forward resolver (item249) uses the IDENTICAL walk —
 *  ONE instrument for the paired ladder (verbatim, not a re-implementation). */
export function walkSingleTP(bars: Bar[], startIdx: number, dir: 'BUY' | 'SELL', entry: number, slPrice: number, tpPrice: number): number | null {
  for (let i = startIdx; i < bars.length; i++) {
    const b = bars[i];
    const hitSl = dir === 'BUY' ? b.low <= slPrice : b.high >= slPrice;
    const hitTp = dir === 'BUY' ? b.high >= tpPrice : b.low <= tpPrice;
    if (hitSl && hitTp) return slPrice; // conservative tie-break: STOP first (stated)
    if (hitTp) return tpPrice;
    if (hitSl) return slPrice;
  }
  return null;
}

async function main(): Promise<void> {
  const line = '='.repeat(100);
  const client = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  console.log(line); console.log('ITEM Y.1 — REGIME-MAPPED EXIT GEOMETRY, CANONICAL THREE-ARM RE-DERIVATION'); console.log(line);
  console.log(`  run at: ${new Date().toISOString()}`);
  console.log('  MAP (verbatim): TREND ADX>25 SL=3.5*ATR | MID 20..25 SL=$8 | RANGE <20 SL=2.5*ATR; TP=4.0*SL. M5 from gold_m1_bars, NO look-ahead.');
  console.log('  Fill/resolution: stored entry all arms; walks start first COMPLETED bar after emitted_at+60s; same-bar SL+TP -> STOP taken (conservative).');
  console.log('  PRE-STATED MDE policy: paired MDE printed BEFORE each estimate. Boot 20k seed 20260828.');

  const all: Row[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('signal_id,emitted_at,direction,entry,sl,tp1,tp2,tp3,confidence,sr_zones_snapshot').or("closed_market_emission.is.null,closed_market_emission.eq.false").order('emitted_at', { ascending: true }).range(o, o + 999);
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

  const book: Sig[] = [];
  let exclNoSnap = 0, exclUndecided = 0, regimeUnavailable = 0;
  const regimeWindowLog: string[] = [];
  for (const s of all) {
    const snap = typeof s.sr_zones_snapshot === 'string' ? JSON.parse(s.sr_zones_snapshot as string) : s.sr_zones_snapshot;
    if (!snap) { exclNoSnap++; continue; }
    const ems = new Date(s.emitted_at).getTime();
    const windowEnd = Math.min(ems + 8 * 3600_000, barsEndMs);
    const wb = bars.slice(lbR(bars, ems - 60_000), lbR(bars, windowEnd));
    const cov = wb.filter(b => b.timestamp >= ems && b.timestamp <= ems + 2 * 3600_000).length;
    if (cov < 100 || wb.length === 0) { exclUndecided++; continue; }
    const dir = (s.direction === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL';
    const sig = { id: s.signal_id, timestamp: new Date(ems), createdAt: ems, type: dir, entryPrice: +s.entry, entryPriceWithSlippage: +s.entry, tp1: +s.tp1, tp2: +s.tp2, tp3: +s.tp3, sl: +s.sl, confidence: +s.confidence, status: 'ACTIVE' as SignalStatus, targetsHit: 0, breakevenReached: false } as unknown as TradingSignal;
    const r = resolveSignalWithBars(sig, wb, { fromScratch: true, evalNowMs: windowEnd });
    if (r.outcomeResult === null) { exclUndecided++; continue; }
    const riskLive = Math.abs(+s.entry - +s.sl);

    // ── regime map: M5 bars STRICTLY before emission (no look-ahead) ──
    const m1Before = bars.slice(0, lbR(bars, ems)); // ts < ems only
    let m5 = m1Before.length >= 60 ? aggregateBars(m1Before, 5) : [];
    // drop any bucket whose CLOSE time is not strictly <= ems (no bar at/after emission feeds indicators)
    m5 = m5.filter(b => b.timestamp + 5 * 60_000 <= ems);
    let regime: string | null = null, mappedSl: number | null = null, mappedTp: number | null = null;
    let m5First: number | null = null, m5LastClose: number | null = null;
    if (m5.length >= 29) {
      const series = sealBarSeries(m5);
      const adx = barADX(series, 14);
      const atr = barATR(series, 14);
      if (adx && atr) {
        regime = adx.adx > 25 ? 'TREND' : adx.adx >= 20 ? 'MID' : 'RANGE';
        const slDist = regime === 'TREND' ? 3.5 * atr : regime === 'MID' ? 8.0 : 2.5 * atr;
        mappedSl = Math.round(slDist * 1000) / 1000;
        mappedTp = Math.round(4.0 * slDist * 1000) / 1000;
        m5First = m5[0].timestamp;
        m5LastClose = m5[m5.length - 1].timestamp + 5 * 60_000;
        if (regimeWindowLog.length < 3) regimeWindowLog.push(`  sample regime window (${regime}, adx=${adx.adx.toFixed(1)}, atr=${atr.toFixed(2)}): M5 bars ${m5.length}, first open ${new Date(m5First).toISOString()}, LAST CLOSE ${new Date(m5LastClose).toISOString()} (<= emitted ${new Date(ems).toISOString()})`);
      }
    }
    if (regime === null || mappedSl === null || mappedTp === null) { regimeUnavailable++; }

    // ── ARM-2 / ARM-3 walks (only when the regime map is available) ──
    let arm2: number | null = null, arm3: number | null = null;
    const startIdx = lbR(bars, ems + 60_000);
    if (mappedSl !== null && mappedTp !== null && startIdx < bars.length) {
      const slDist = mappedSl;
      const slPrice = dir === 'BUY' ? +s.entry - slDist : +s.entry + slDist;
      const tpPrice = dir === 'BUY' ? +s.entry + mappedTp : +s.entry - mappedTp;
      const exit2 = walkSingleTP(bars, startIdx, dir, +s.entry, slPrice, tpPrice);
      if (exit2 !== null) arm2 = computeRNet(dir, +s.entry, exit2, slDist);
      // hybrid: live leg (live SL / live TP1) + mapped leg (mapped SL / mapped TP), live-risk denominator
      const liveSl = dir === 'BUY' ? +s.entry - riskLive : +s.entry + riskLive;
      const exitLive = walkSingleTP(bars, startIdx, dir, +s.entry, liveSl, +s.tp1);
      if (exitLive !== null && exit2 !== null) {
        const rLiveLeg = computeRNet(dir, +s.entry, exitLive, riskLive);
        const rMappedLeg = computeRNet(dir, +s.entry, exit2, riskLive);
        arm3 = 0.5 * rLiveLeg + 0.5 * rMappedLeg;
      }
    }

    book.push({ id: s.signal_id, dir, entry: +s.entry, sl: +s.sl, tp1: +s.tp1, ems, rNet: computeRNet(dir, +s.entry, r.exitPrice, riskLive), regime, mappedSl, mappedTp, arm2, arm3, m5First, m5LastClose, m5Count: m5.length });
  }
  console.log(`  era-clean canonical population: n=${book.length} (excluded: no-snapshot ${exclNoSnap}, undecided/no-coverage ${exclUndecided})`);
  console.log(`  regime map available: ${book.filter(b => b.regime !== null).length} | unavailable: ${regimeUnavailable}`);
  for (const l of regimeWindowLog) console.log(l);

  // ── per-arm stats (each arm over ITS decided subset) ──
  console.log(`\n${line}\nPER-ARM STATS (each arm over its own decided subset)\n${line}`);
  const arm1All = book.map(b => b.rNet);
  const arm2All = book.filter(b => b.arm2 !== null).map(b => b.arm2 as number);
  const arm3All = book.filter(b => b.arm3 !== null).map(b => b.arm3 as number);
  console.log(statLine('ARM-1 live booked', arm1All));
  console.log(statLine('ARM-2 pure mapped', arm2All));
  console.log(statLine('ARM-3 hybrid', arm3All));
  const byEms = (arr: Sig[], pick: (b: Sig) => number): number[] => [...arr].sort((a, b) => a.ems - b.ems).map(pick);
  console.log(`  ARM-1 longest losing streak / max drawdown: ${JSON.stringify(streakAndDrawdown(byEms(book, b => b.rNet)))}`);
  console.log(`  ARM-2 longest losing streak / max drawdown: ${JSON.stringify(streakAndDrawdown(byEms(book.filter(b => b.arm2 !== null), b => b.arm2 as number)))}`);
  console.log(`  ARM-3 longest losing streak / max drawdown: ${JSON.stringify(streakAndDrawdown(byEms(book.filter(b => b.arm3 !== null), b => b.arm3 as number)))}`);

  // ── paired comparisons (all three arms decided) ──
  const complete = book.filter(b => b.arm2 !== null && b.arm3 !== null);
  console.log(`\n${line}\nPAIRED vs ARM-1 (n=${complete.length} with ALL arms decided)\n${line}`);
  const c1 = complete.map(b => b.rNet), c2 = complete.map(b => b.arm2 as number), c3 = complete.map(b => b.arm3 as number);
  console.log(statLine('ARM-1 (paired subset)', c1));
  console.log(statLine('ARM-2 (paired subset)', c2));
  console.log(statLine('ARM-3 (paired subset)', c3));
  pairedStats('ARM-2 vs ARM-1', c2, c1);
  pairedStats('ARM-3 vs ARM-1', c3, c1);

  // ── per-direction / per-regime / live-source ──
  console.log(`\n${line}\nPER-DIRECTION and PER-REGIME (ARM-1 / ARM-2 / ARM-3 EV on the paired subset)\n${line}`);
  for (const d of ['BUY', 'SELL'] as const) {
    const sub = complete.filter(b => b.dir === d);
    if (!sub.length) continue;
    console.log(`  ${d}: n=${sub.length} | ARM-1 ${ev(sub.map(b => b.rNet)).toFixed(4)}R | ARM-2 ${ev(sub.map(b => b.arm2 as number)).toFixed(4)}R | ARM-3 ${ev(sub.map(b => b.arm3 as number)).toFixed(4)}R`);
  }
  for (const g of ['TREND', 'MID', 'RANGE']) {
    const sub = complete.filter(b => b.regime === g);
    if (!sub.length) continue;
    console.log(`  ${g}: n=${sub.length} | ARM-1 ${ev(sub.map(b => b.rNet)).toFixed(4)}R | ARM-2 ${ev(sub.map(b => b.arm2 as number)).toFixed(4)}R | ARM-3 ${ev(sub.map(b => b.arm3 as number)).toFixed(4)}R`);
  }

  // ── AGREE/DISAGREE vs the provisional (Python M5-dataset) figures ──
  console.log(`\n${line}\nAGREE/DISAGREE vs PROVISIONAL (deltas; canonical wins by MINDSET 5)\n${line}`);
  const arm2ev = ev(c2), arm1ev = ev(c1), arm3ev = ev(c3);
  const prov = [
    { name: 'holdout map vs uniform 1:4 (random entries)', prov: '+0.1335R', canon: `${arm2ev >= 0 ? '+' : ''}${arm2ev.toFixed(4)}R (ARM-2, timed engine entries)` },
    { name: '17-month paired swap live-like vs mapped', prov: '+0.0971R', canon: `${((arm2ev - arm1ev) >= 0 ? '+' : '') + (arm2ev - arm1ev).toFixed(4)}R (ARM-2 paired)` },
    { name: 'live-like fix8/TP=0.7xSL worst geometry', prov: '-0.0567R', canon: `ARM-1 live booked ${arm1ev.toFixed(4)}R on this book` },
    { name: 'engine 128-signal month: map vs booked', prov: '+0.6505R vs -0.0727R', canon: `paired subset ARM-2 ${arm2ev.toFixed(4)}R vs ARM-1 ${arm1ev.toFixed(4)}R` },
  ];
  for (const p of prov) console.log(`  ${p.name.padEnd(48)} provisional ${p.prov.padEnd(20)} canonical ${p.canon}`);
  console.log(`  REALITY CONSTRAINT carried: provisional mapped shape ran 22% WR with a 40-loss streak and 83R max DD on its proxy stream;`);
  console.log(`  canonical streaks/DD printed above are the comparable numbers on THIS book. A wholesale exit replacement is NOT proposed.`);
  console.log(`\n  Y.1 SCOPE: measurement only. Y.2's annotation is write-only; no live exit changes.`);
}
// Guarded so item249 can import walkSingleTP without re-running this measurement.
if (import.meta.main) { main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack ?? err.message : String(err)); process.exit(1); }); }
