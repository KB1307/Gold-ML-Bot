/**
 * ITEM 36 — IS THE NEW-GEOMETRY ERA GENUINELY NEGATIVE, OR IS THIS NOISE?
 * =====================================================================
 *
 * MINDSET 8 rules (restated verbatim):
 *  1. Measure before building. Pre-registered gates, no post-hoc loosening.
 *  2. Verify against the LIVE system, never "the code looks right."
 *  3. No step reported done without pasted evidence from the real system.
 *  4. Provenance is not appearance — ask the source system what it holds.
 *  5. A measurement is only as good as its LABELS.
 *  6. Correlation in observational data is not a lever.
 *  7. State the POWER before the result.
 *  8. When measurement is IMPOSSIBLE rather than underpowered, say so and
 *     decide on first principles — then state what forward evidence settles it.
 *
 * DATA-SOURCE RULE: gold_m1_bars + trade_outcomes_v1 read DIRECT from Supabase
 * via anon key. Export fetched to /tmp/diagnostics_export.txt. No Rork backend
 * reads. No engine code is modified. Nothing ships.
 *
 * WHAT THIS SCRIPT MEASURES:
 *  36a. OLD-geometry-era EV vs NEW-geometry-era EV as a direct two-group
 *       comparison (same method as Follow-up 2: pooled SD, SE of difference,
 *       MDE at 80% power). NOT filtered through the TP1-clearance split.
 *  36b. NEW-geometry era's outcomes chronologically (by day/date), so a
 *       genuine regime shift is distinguishable from a short losing streak.
 *  36c. How many NEW-geometry signals exist as of TODAY from trade_outcomes_v1
 *       (not just the 396-signal export). If a larger n exists, use it and
 *       state the updated power picture.
 *  36d. Whether the new geometry's underperformance is explained by the
 *       TP1/SL ratio fragility (mirror-symmetry finding) or is a separate effect.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { resolveSignalWithBars, type ResolverOutcome } from '../services/signalResolver';
import type { TradingSignal } from '../types/trading';
import type { OhlcBar } from '../services/barStore';

// ─── env ────────────────────────────────────────────────────────────────
function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ['expo/.env', '.env']) {
    try {
      const raw = readFileSync(file, 'utf8');
      raw.split('\n').forEach((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      });
    } catch { /* optional */ }
  }
  return out;
}

// ─── types ──────────────────────────────────────────────────────────────
interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp: number[];
  status: string;
  exit: number | null;
  id: string;
  generatedMs: number;
}

// ─── export parser (same as Item 32) ─────────────────────────────────────
function parseExport(path: string): ParsedSignal[] {
  const raw = readFileSync(path, 'utf8');
  const body = raw.slice(raw.indexOf('SECTION 1'), raw.indexOf('SECTION 2'));
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);
  const out: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    const exit = block.match(/exit price: ([\d.]+)/);
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      exit: exit ? parseFloat(exit[1]) : null,
      id: block.match(/id: (\S+)/)?.[1] ?? '',
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? '').getTime(),
      sl: tpm ? parseFloat(tpm[4]) : 0,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
    });
  }
  return out;
}

function toTradingSignal(p: ParsedSignal): TradingSignal {
  return {
    id: p.id || `idx-${p.index}`,
    timestamp: new Date(p.generatedMs),
    createdAt: p.generatedMs,
    type: p.direction,
    entryPrice: p.entry,
    entryPriceWithSlippage: p.entry,
    tp1: p.tp[0],
    tp2: p.tp[1],
    tp3: p.tp[2],
    sl: p.sl,
    slMultiplier: 1,
    confidence: 0.5,
    status: 'ACTIVE',
    targetsHit: 0,
    entryTime: '',
    topFeatures: [],
  } as unknown as TradingSignal;
}

// ─── bar fetcher ────────────────────────────────────────────────────────
async function fetchBars(client: SupabaseClient, fromMs: number, toMs: number): Promise<OhlcBar[]> {
  const page = 1000;
  const bars: OhlcBar[] = [];
  let cursor = fromMs;
  for (let p = 0; p < 400; p++) {
    const { data, error } = await client
      .from('gold_m1_bars')
      .select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(cursor).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true })
      .limit(page);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data as { timestamp: string; open: number; high: number; low: number; close: number }[]) {
      bars.push({
        timestamp: new Date(r.timestamp).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      } as OhlcBar);
    }
    if (data.length < page) break;
    cursor = bars[bars.length - 1].timestamp + 1;
  }
  return bars;
}

// ─── helpers ────────────────────────────────────────────────────────────
function mean(a: number[]): number {
  return a.length > 0 ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
}
function sd(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
function pooledSd(vals1: number[], vals2: number[]): number {
  const all = [...vals1, ...vals2];
  if (all.length < 2) return 0;
  const m = all.reduce((a, b) => a + b, 0) / all.length;
  return Math.sqrt(all.reduce((s, v) => s + (v - m) ** 2, 0) / (all.length - 1));
}
function profitFactor(rs: number[]): number {
  const gw = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  return gl === 0 ? Infinity : gw / gl;
}

// ─── MAIN ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const env = loadEnv();
  const client: SupabaseClient = createClient(
    env.EXPO_PUBLIC_SUPABASE_URL as string,
    env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  console.log('='.repeat(80));
  console.log('ITEM 36 — IS THE NEW-GEOMETRY ERA GENUINELY NEGATIVE, OR NOISE?');
  console.log('MINDSET 8 rules apply. Read-only. No engine code touched. Nothing ships.');
  console.log('='.repeat(80));

  // ── fetch export ──
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const h = { apikey: anon, Authorization: `Bearer ${anon}` };
  for (const path of [
    '/storage/v1/object/public/diagnostics/latest.txt',
    '/storage/v1/object/public/diagnostics/diagnostics_export.txt',
  ]) {
    const res = await fetch(`${url}${path}`, { headers: h });
    if (res.ok) {
      const text = await res.text();
      writeFileSync('/tmp/diagnostics_export.txt', text);
      console.log(`  Export fetched: ${text.length} bytes`);
      break;
    }
  }

  const signals = parseExport('/tmp/diagnostics_export.txt');
  console.log(`  Signals parsed: ${signals.length}`);

  // ── fetch bars ──
  const minTs = Math.min(...signals.map((s) => s.generatedMs)) - 60 * 60_000;
  const maxTs = Math.max(...signals.map((s) => s.generatedMs)) + 8 * 60 * 60_000;
  const bars = await fetchBars(client, minTs, maxTs);
  console.log(`  Bars fetched: ${bars.length}`);

  const byMinute = new Map<number, OhlcBar>();
  for (const b of bars) {
    byMinute.set(Math.floor(b.timestamp / 60_000) * 60_000, b);
  }

  // ── resolve all signals fromScratch (canonical Method B) ──
  const evalNow = maxTs;
  const quiet = { fromScratch: true, evalNowMs: evalNow, logPrefix: '' };
  const origLog = console.log;
  console.log = (): void => {};

  const resolved: { signal: ParsedSignal; r: number | null; outcome: ResolverOutcome; tp1SlRatio: number }[] = [];
  for (const p of signals) {
    const sigTs = p.generatedMs;
    const covered = byMinute.has(Math.floor(sigTs / 60_000) * 60_000);
    if (!covered) {
      resolved.push({ signal: p, r: null, outcome: {} as ResolverOutcome, tp1SlRatio: 0 });
      continue;
    }
    const sigBars = bars.filter((b) => b.timestamp >= sigTs + 60_000 && b.timestamp <= sigTs + 8 * 60 * 60_000);
    const sig = toTradingSignal(p);
    const out = resolveSignalWithBars(sig, sigBars, quiet);
    const risk = Math.abs(p.entry - p.sl);
    const dirSign = p.direction === 'BUY' ? 1 : -1;
    const tp1Dist = Math.abs(p.entry - p.tp[0]);
    const slDist = Math.abs(p.entry - p.sl);
    const ratio = slDist > 0 ? tp1Dist / slDist : 0;
    let r: number | null = null;
    if (risk > 0 && out.entryConfirmed) {
      const fill = out.entryFillPrice ?? p.entry;
      r = (dirSign * (out.exitPrice - fill)) / risk;
    }
    resolved.push({ signal: p, r, outcome: out, tp1SlRatio: ratio });
  }
  console.log = origLog;

  const withR = resolved.filter((x) => x.r !== null) as { signal: ParsedSignal; r: number; outcome: ResolverOutcome; tp1SlRatio: number }[];
  console.log(`  Resolved with R: ${withR.length} (of ${signals.length})`);

  // ═══════════════════════════════════════════════════════════════════════
  // 36a — OLD vs NEW GEOMETRY: direct two-group comparison
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('36a — OLD vs NEW GEOMETRY: direct two-group comparison (POWER FIRST)');
  console.log('='.repeat(80));
  console.log('  Era boundary = TP1/SL ratio: OLD < 0.60, NEW >= 0.60');
  console.log('  R = dirSign * (resolverExit - fill) / |entry - sl| (canonical Method B)');
  console.log('');

  const oldGeo = withR.filter((x) => x.tp1SlRatio < 0.60);
  const newGeo = withR.filter((x) => x.tp1SlRatio >= 0.60);

  const oldRs = oldGeo.map((x) => x.r);
  const newRs = newGeo.map((x) => x.r);

  const evOld = mean(oldRs);
  const evNew = mean(newRs);
  const sdOld = sd(oldRs);
  const sdNew = sd(newRs);
  const wrOld = (oldRs.filter((r) => r > 0).length / oldRs.length) * 100;
  const wrNew = (newRs.filter((r) => r > 0).length / newRs.length) * 100;
  const pfOld = profitFactor(oldRs);
  const pfNew = profitFactor(newRs);

  console.log(`  OLD geometry (TP1/SL < 0.60): n=${oldRs.length}, EV=${isNaN(evOld) ? 'n/a' : `${evOld >= 0 ? '+' : ''}${evOld.toFixed(4)}R`}, WR=${wrOld.toFixed(1)}%, PF=${pfOld.toFixed(3)}, SD=${sdOld.toFixed(4)}`);
  console.log(`  NEW geometry (TP1/SL >= 0.60): n=${newRs.length}, EV=${isNaN(evNew) ? 'n/a' : `${evNew >= 0 ? '+' : ''}${evNew.toFixed(4)}R`}, WR=${wrNew.toFixed(1)}%, PF=${pfNew.toFixed(3)}, SD=${sdNew.toFixed(4)}`);

  // Two-group comparison (same method as Follow-up 2)
  const observedDiff = evOld - evNew;
  const sigmaPooled = pooledSd(oldRs, newRs);
  const nOld = oldRs.length;
  const nNew = newRs.length;
  const seDiff = sigmaPooled * Math.sqrt(1 / nOld + 1 / nNew);
  const mdeDiff = 2.8 * seDiff;
  const poweredDiff = nOld >= 10 && nNew >= 10 && Math.abs(observedDiff) >= mdeDiff;

  console.log('');
  console.log(`  Observed difference (OLD - NEW) = ${observedDiff >= 0 ? '+' : ''}${observedDiff.toFixed(4)}R`);
  console.log(`  Pooled SD = ${sigmaPooled.toFixed(4)}R`);
  console.log(`  SE of difference = ${seDiff.toFixed(4)}R`);
  console.log(`  MDE (80% power, alpha=0.05) = ${mdeDiff.toFixed(4)}R`);
  console.log(`  POWER: ${poweredDiff ? 'POWERED — difference is distinguishable from zero' : 'UNDERPOWERED — observed difference ' + Math.abs(observedDiff).toFixed(4) + 'R < MDE ' + mdeDiff.toFixed(4) + 'R'}`);

  // ═══════════════════════════════════════════════════════════════════════
  // 36b — NEW-geometry outcomes CHRONOLOGICALLY by day
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('36b — NEW-geometry outcomes by DAY (regime shift vs losing streak)');
  console.log('='.repeat(80));
  console.log('');

  // Group by UTC date
  const byDay = new Map<string, { rs: number[]; count: number }>();
  for (const x of newGeo) {
    const dateStr = new Date(x.signal.generatedMs).toISOString().slice(0, 10);
    const entry = byDay.get(dateStr) ?? { rs: [], count: 0 };
    entry.rs.push(x.r);
    entry.count++;
    byDay.set(dateStr, entry);
  }

  const sortedDays = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`  ${'date'.padEnd(12)} ${'n'.padStart(4)} ${'EV'.padStart(10)} ${'WR'.padStart(7)} ${'PF'.padStart(7)} ${'cum_EV'.padStart(10)} ${'cum_n'.padStart(6)}`);
  console.log(`  ${'─'.repeat(70)}`);

  let cumRs: number[] = [];
  for (const [date, entry] of sortedDays) {
    const dayEv = mean(entry.rs);
    const dayWr = (entry.rs.filter((r) => r > 0).length / entry.rs.length) * 100;
    const dayPf = profitFactor(entry.rs);
    cumRs = [...cumRs, ...entry.rs];
    const cumEv = mean(cumRs);
    console.log(`  ${date.padEnd(12)} ${String(entry.count).padStart(4)} ${(dayEv >= 0 ? '+' : '') + dayEv.toFixed(4) + 'R'.padStart(9)} ${dayWr.toFixed(1).padStart(6)}% ${dayPf.toFixed(3).padStart(7)} ${(cumEv >= 0 ? '+' : '') + cumEv.toFixed(4) + 'R'.padStart(9)} ${String(cumRs.length).padStart(6)}`);
  }

  // Detect: is the negative EV concentrated in one bad day, or spread across all days?
  const negativeDays = sortedDays.filter(([, e]) => mean(e.rs) < 0);
  const positiveDays = sortedDays.filter(([, e]) => mean(e.rs) >= 0);
  console.log('');
  console.log(`  Days with negative EV: ${negativeDays.length} / ${sortedDays.length}`);
  console.log(`  Days with positive EV: ${positiveDays.length} / ${sortedDays.length}`);
  if (negativeDays.length > 0 && positiveDays.length > 0) {
    const worstDay = negativeDays.reduce((a, b) => (mean(a[1].rs) < mean(b[1].rs) ? a : b));
    const bestDay = positiveDays.reduce((a, b) => (mean(a[1].rs) > mean(b[1].rs) ? a : b));
    console.log(`  Worst day: ${worstDay[0]} EV=${mean(worstDay[1].rs).toFixed(4)}R (n=${worstDay[1].count})`);
    console.log(`  Best day:  ${bestDay[0]} EV=${mean(bestDay[1].rs).toFixed(4)}R (n=${bestDay[1].count})`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 36c — How many NEW-geometry signals exist NOW in trade_outcomes_v1?
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('36c — NEW-geometry signals in trade_outcomes_v1 (as of TODAY)');
  console.log('='.repeat(80));
  console.log('  The export is a snapshot. trade_outcomes_v1 is the durable store.');
  console.log('  Checking if more NEW-geometry signals have resolved since export.');
  console.log('');

  // Fetch all trade_outcomes_v1 rows
  const allOutcomes: { signal_id: string; direction: string; entry_price: number; exit_price: number; pnl: number; realized_r: number | null; result: string; ts: string }[] = [];
  let offset = 0;
  const pageSize = 1000;
  for (let p = 0; p < 50; p++) {
    const { data, error } = await client
      .from('trade_outcomes_v1')
      .select('signal_id, direction, entry_price, exit_price, pnl, realized_r, result, ts')
      .order('ts', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    allOutcomes.push(...(data as typeof allOutcomes));
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`  trade_outcomes_v1 total rows: ${allOutcomes.length}`);

  // The export's generated timestamp tells us the snapshot date
  const exportGenDate = signals.length > 0 ? new Date(signals[0].generatedMs).toISOString().slice(0, 10) : 'unknown';
  console.log(`  Export snapshot date: ${exportGenDate}`);

  // Count outcomes since export
  const exportMs = signals.length > 0 ? Math.min(...signals.map((s) => s.generatedMs)) : 0;
  const sinceExport = allOutcomes.filter((o) => new Date(o.ts).getTime() > exportMs);
  console.log(`  Outcomes since export date: ${sinceExport.length}`);
  console.log(`  Outcomes before/at export:   ${allOutcomes.length - sinceExport.length}`);

  // We cannot directly determine geometry era from trade_outcomes_v1 (no SL/TP fields).
  // We CAN check realized_r distribution for recent outcomes.
  if (sinceExport.length > 0) {
    const recentRs = sinceExport.map((o) => o.realized_r).filter((r): r is number => r !== null && Number.isFinite(r));
    if (recentRs.length > 0) {
      const recentEv = mean(recentRs);
      const recentWr = (recentRs.filter((r) => r > 0).length / recentRs.length) * 100;
      console.log(`  Recent outcomes (since export) with realized_r: n=${recentRs.length}, EV=${recentEv >= 0 ? '+' : ''}${recentEv.toFixed(4)}R, WR=${recentWr.toFixed(1)}%`);
    }
  }

  // Full corpus EV
  const allRs = allOutcomes.map((o) => o.realized_r).filter((r): r is number => r !== null && Number.isFinite(r));
  if (allRs.length > 0) {
    const fullEv = mean(allRs);
    const fullWr = (allRs.filter((r) => r > 0).length / allRs.length) * 100;
    console.log(`  Full corpus EV: n=${allRs.length}, EV=${fullEv >= 0 ? '+' : ''}${fullEv.toFixed(4)}R, WR=${fullWr.toFixed(1)}%`);
  }

  // Note: trade_outcomes_v1 does not store SL/TP1, so we cannot split by geometry era directly.
  console.log('');
  console.log('  NOTE: trade_outcomes_v1 does not store SL/TP1 fields, so geometry-era');
  console.log('  classification cannot be done from the durable store alone. The export');
  console.log(`  is the only source with per-signal TP1/SL. The n=${nNew} from the export`);
  console.log(`  remains the best available NEW-geometry sample.`);

  // ═══════════════════════════════════════════════════════════════════════
  // 36d — Is the underperformance explained by TP1/SL ratio fragility?
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(80));
  console.log('36d — Is NEW-geometry underperformance explained by TP1/SL ratio?');
  console.log('='.repeat(80));
  console.log('  The mirror-symmetry finding (Item 33.2d) showed that the TP1/SL ratio');
  console.log('  changed between eras. If the NEW geometry\'s underperformance is SOLELY');
  console.log('  explained by the TP1/SL ratio change, then controlling for the ratio');
  console.log('  within the NEW era should eliminate the EV gap. If it does not, there');
  console.log('  is a separate effect.');
  console.log('');

  // Within NEW geometry, split by TP1/SL ratio: is there a gradient?
  const newRatioMedian = newGeo.length > 0 ? newGeo.map((x) => x.tp1SlRatio).sort((a, b) => a - b)[Math.floor(newGeo.length / 2)] : 0;
  console.log(`  NEW geometry TP1/SL ratio: median=${newRatioMedian.toFixed(4)}, min=${Math.min(...newGeo.map((x) => x.tp1SlRatio)).toFixed(4)}, max=${Math.max(...newGeo.map((x) => x.tp1SlRatio)).toFixed(4)}`);

  // Split NEW at its own median ratio
  const newHighRatio = newGeo.filter((x) => x.tp1SlRatio >= newRatioMedian);
  const newLowRatio = newGeo.filter((x) => x.tp1SlRatio < newRatioMedian);
  if (newHighRatio.length >= 10 && newLowRatio.length >= 10) {
    const evHighR = mean(newHighRatio.map((x) => x.r));
    const evLowR = mean(newLowRatio.map((x) => x.r));
    console.log(`  NEW era split at own median (${newRatioMedian.toFixed(4)}):`);
    console.log(`    HIGH ratio (>= ${newRatioMedian.toFixed(4)}): n=${newHighRatio.length}, EV=${evHighR >= 0 ? '+' : ''}${evHighR.toFixed(4)}R, WR=${(newHighRatio.filter((x) => x.r > 0).length / newHighRatio.length * 100).toFixed(1)}%`);
    console.log(`    LOW ratio  (< ${newRatioMedian.toFixed(4)}):  n=${newLowRatio.length}, EV=${evLowR >= 0 ? '+' : ''}${evLowR.toFixed(4)}R, WR=${(newLowRatio.filter((x) => x.r > 0).length / newLowRatio.length * 100).toFixed(1)}%`);
    // Power on the within-NEW split
    const withinRs1 = newHighRatio.map((x) => x.r);
    const withinRs2 = newLowRatio.map((x) => x.r);
    const withinSigma = pooledSd(withinRs1, withinRs2);
    const withinSe = withinSigma * Math.sqrt(1 / withinRs1.length + 1 / withinRs2.length);
    const withinMde = 2.8 * withinSe;
    const withinDiff = evHighR - evLowR;
    console.log(`    Within-NEW difference: ${withinDiff >= 0 ? '+' : ''}${withinDiff.toFixed(4)}R, MDE=${withinMde.toFixed(4)}R, ${Math.abs(withinDiff) >= withinMde ? 'POWERED' : 'UNDERPOWERED'}`);
  } else {
    console.log(`  NEW era split at own median: n too small (high=${newHighRatio.length}, low=${newLowRatio.length})`);
  }

  // Cross-era: is the OLD era's entire advantage explained by its lower ratio?
  // If OLD is ~0.50R and NEW is ~0.70R, and the ratio IS the lever, then
  // NEW signals with ratio close to 0.50 should perform like OLD signals.
  // But OLD only has n=21 and ALL of them are in the OLD era...
  console.log('');
  console.log('  Cross-era: the OLD era has n=' + oldRs.length + ' (TP1/SL ~0.50), NEW has n=' + newRs.length + ' (TP1/SL ~0.70).');
  console.log('  If the TP1/SL ratio IS the sole lever, the within-NEW gradient above');
  console.log('  should show it. If the within-NEW split is UNDERPOWERED or shows no');
  console.log('  gradient, the era gap cannot be attributed to the ratio alone —');
  console.log('  there may be a separate regime effect (market conditions, signal');
  console.log('  selection, or the era boundary correlates with something else).');

  // Summary verdict
  console.log('\n' + '='.repeat(80));
  console.log('VERDICT');
  console.log('='.repeat(80));
  console.log('');
  if (!poweredDiff) {
    console.log(`  The OLD vs NEW geometry difference (${observedDiff >= 0 ? '+' : ''}${observedDiff.toFixed(4)}R) is`);
    console.log(`  UNDERPOWERED (MDE=${mdeDiff.toFixed(4)}R). The NEW era's negative EV (${evNew >= 0 ? '+' : ''}${evNew.toFixed(4)}R)`);
    console.log(`  is directionally concerning but NOT distinguishable from noise at this sample size.`);
    console.log(`  The chronological breakdown shows whether it is concentrated or spread —`);
    console.log(`  if spread across all days, it is more likely a regime effect; if concentrated`);
    console.log(`  in 1-2 bad days, it is more likely a losing streak that a positive-EV system`);
    console.log(`  produces routinely.`);
  } else {
    console.log(`  The OLD vs NEW geometry difference (${observedDiff >= 0 ? '+' : ''}${observedDiff.toFixed(4)}R) is`);
    console.log(`  POWERED. The NEW era's negative EV is a genuine effect, not noise.`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('DONE — Item 36 complete. Nothing was written. No engine code touched.');
  console.log('='.repeat(80));
}

main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
