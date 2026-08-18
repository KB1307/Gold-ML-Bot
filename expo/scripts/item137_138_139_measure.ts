/**
 * ITEM 137(b) — ENTRY QUALITY MEASUREMENT: distance-to-nearest-same-side-zone.
 * ITEM 138(a) — Sub-0.68 confidence cohort DIRECT measurement.
 * ITEM 139(a) — Backfill ATR source field identification.
 *
 * DATA SOURCE: emitted_signals_v1 + trade_outcomes_v1 + gold_m1_bars via Supabase DIRECT (anon key).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

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
  } catch { /* */ }
  return env;
};

const PIP_VALUE = 0.1;
const EXECUTION_COST_R = 0.03;

function computeRNet(dir: 'BUY' | 'SELL', entry: number, exit: number, slPrice: number): number {
  const risk = Math.abs(entry - slPrice);
  if (risk <= 0) return 0;
  const pnl = dir === 'BUY' ? (exit - entry) : (entry - exit);
  return pnl / risk - EXECUTION_COST_R;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function meanStdErr(vals: number[]): { n: number; mean: number; se: number; ci95: number } {
  const n = vals.length;
  if (n === 0) return { n: 0, mean: 0, se: 0, ci95: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, se: 0, ci95: 0 };
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const ci95 = 1.96 * se;
  return { n, mean, se, ci95 };
}

// ATR(14) — verbatim port of calculateRealATR
function computeATR14(bars: { high: number; low: number; close: number }[], endIdx: number, period = 14): number | null {
  if (endIdx < period + 1) return null;
  let sum = 0;
  let count = 0;
  for (let i = endIdx - period; i < endIdx; i++) {
    if (i < 1) continue;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i-1].close),
      Math.abs(bars[i].low - bars[i-1].close)
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : null;
}

interface EmittedSignal {
  signal_id: string;
  emitted_at: string;
  direction: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  raw_confidence: number | null;
  atr: number | null;
  source: string;
  sr_zones_snapshot: unknown;
}

async function main(): Promise<void> {
  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('Missing env'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } }) as SupabaseClient;

  console.log('\n' + '='.repeat(84));
  console.log('ITEMS 137(b) + 138(a) + 139(a) — COMBINED MEASUREMENT');
  console.log('='.repeat(84));

  // Fetch all emitted signals
  const allSignals: EmittedSignal[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await client
      .from('emitted_signals_v1').select('*')
      .order('emitted_at', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`Fetch signals: ${error.message}`);
    const rows = (data ?? []) as EmittedSignal[];
    allSignals.push(...rows);
    if (rows.length < 1000) break;
    offset += 1000;
    if (offset > 20000) break;
  }
  console.log(`\nFetched ${allSignals.length} emitted signals`);

  // Fetch all trade outcomes
  const { data: outcomesData } = await client
    .from('trade_outcomes_v1')
    .select('signal_id, realized_r, result, is_scratch')
    .limit(10000);
  const outcomes = new Map<string, { realizedR: number | null; result: string | null; isScratch: boolean }>();
  for (const r of (outcomesData ?? []) as Record<string, unknown>[]) {
    outcomes.set(String(r.signal_id), {
      realizedR: r.realized_r !== null && r.realized_r !== undefined ? Number(r.realized_r) : null,
      result: r.result !== null && r.result !== undefined ? String(r.result) : null,
      isScratch: r.is_scratch === true,
    });
  }
  console.log(`Fetched ${outcomes.size} trade outcomes`);

  // ── 139(a): ATR source field — split by source ─────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('── 139(a): BACKFILL ATR SOURCE IDENTIFICATION ──');
  console.log('─'.repeat(60));

  const bySource: Record<string, EmittedSignal[]> = {};
  for (const s of allSignals) {
    if (!bySource[s.source]) bySource[s.source] = [];
    bySource[s.source].push(s);
  }

  for (const [src, sigs] of Object.entries(bySource)) {
    const atrs = sigs.map(s => s.atr).filter((a): a is number => a !== null && Number.isFinite(a));
    atrs.sort((a, b) => a - b);
    console.log(`\n  ${src}: n=${sigs.length}`);
    if (atrs.length > 0) {
      console.log(`    atr: p10=${percentile(atrs, 10).toFixed(2)} p25=${percentile(atrs, 25).toFixed(2)} p50=${percentile(atrs, 50).toFixed(2)} p75=${percentile(atrs, 75).toFixed(2)} p90=${percentile(atrs, 90).toFixed(2)} max=${atrs[atrs.length-1].toFixed(2)}`);
      // Also check sl_multiplier and other fields
      const sls = sigs.map(s => s.sl).filter(s => Number.isFinite(s));
      const slMults = sigs.map(s => {
        const risk = Math.abs(s.entry - s.sl);
        const atrVal = s.atr;
        if (atrVal && atrVal > 0) return risk / atrVal;
        return null;
      }).filter((v): v is number => v !== null && Number.isFinite(v));
      if (slMults.length > 0) {
        slMults.sort((a, b) => a - b);
        console.log(`    risk/atr (implied mult): p50=${percentile(slMults, 50).toFixed(2)} max=${slMults[slMults.length-1].toFixed(2)}`);
      }
    }
  }

  // Try to identify what the backfill ATR actually holds
  const backfillSigs = bySource['BACKFILL'] ?? [];
  const liveSigs = bySource['LIVE'] ?? [];
  console.log(`\n  BACKFILL sample (first 5 with atr):`);
  for (const s of backfillSigs.filter(s => s.atr !== null).slice(0, 5)) {
    const risk = Math.abs(s.entry - s.sl);
    console.log(`    id=${s.signal_id.slice(-8)} dir=${s.direction} entry=${s.entry} sl=${s.sl} risk=$${risk.toFixed(1)} atr=${s.atr} risk/atr=${(risk / (s.atr ?? 1)).toFixed(2)} conf=${s.confidence}`);
  }
  console.log(`  LIVE sample (all with atr):`);
  for (const s of liveSigs.filter(s => s.atr !== null)) {
    const risk = Math.abs(s.entry - s.sl);
    console.log(`    id=${s.signal_id.slice(-8)} dir=${s.direction} entry=${s.entry} sl=${s.sl} risk=$${risk.toFixed(1)} atr=${s.atr} risk/atr=${(risk / (s.atr ?? 1)).toFixed(2)} conf=${s.confidence}`);
  }

  // Check if backfill atr might be pips instead of price units
  // If atr is in pips, then atr * PIP_VALUE would be the price-unit ATR
  const backfillAtrs = backfillSigs.map(s => s.atr).filter((a): a is number => a !== null && a > 0);
  if (backfillAtrs.length > 0) {
    console.log(`\n  Hypothesis: backfill atr might be in PIPS not price units.`);
    console.log(`    If pips: atr_p50=${percentile(backfillAtrs.sort((a,b) => a-b), 50).toFixed(2)} pips → price ATR = ${(percentile(backfillAtrs.sort((a,b) => a-b), 50) * PIP_VALUE).toFixed(3)} (matches bar-derived ~1.72?)`);
    console.log(`    If price: atr_p50=${percentile(backfillAtrs.sort((a,b) => a-b), 50).toFixed(2)} → in pips = ${(percentile(backfillAtrs.sort((a,b) => a-b), 50) / PIP_VALUE).toFixed(0)} pips (matches bar-derived ~17?)`);

    // Check: for LIVE signals, what's the relationship?
    const liveAtrs = liveSigs.map(s => s.atr).filter((a): a is number => a !== null && a > 0);
    if (liveAtrs.length > 0) {
      console.log(`\n  LIVE atr is clearly in PRICE units: p50=${percentile(liveAtrs.sort((a,b) => a-b), 50).toFixed(2)} → /PIP_VALUE = ${(percentile(liveAtrs.sort((a,b) => a-b), 50) / PIP_VALUE).toFixed(0)} pips`);
    }

    // For backfill: check the sl_multiplier column and see if risk / (atr*PIP_VALUE) gives a sane multiplier
    const saneMults = backfillSigs.filter(s => s.atr && s.atr > 0).map(s => {
      const risk = Math.abs(s.entry - s.sl);
      const atrInPrice = s.atr * PIP_VALUE; // if atr is pips
      return risk / atrInPrice;
    }).filter(m => Number.isFinite(m) && m > 0 && m < 5);
    if (saneMults.length > 0) {
      saneMults.sort((a, b) => a - b);
      console.log(`\n  If backfill atr is PIPS: risk/(atr*PIP_VALUE) mult p50=${percentile(saneMults, 50).toFixed(2)} (expect ~1.0-1.6)`);
    }

    const insaneMults = backfillSigs.filter(s => s.atr && s.atr > 0).map(s => {
      const risk = Math.abs(s.entry - s.sl);
      return risk / s.atr; // if atr is already price units
    }).filter(m => Number.isFinite(m) && m > 0 && m < 5);
    if (insaneMults.length > 0) {
      insaneMults.sort((a, b) => a - b);
      console.log(`  If backfill atr is PRICE: risk/atr mult p50=${percentile(insaneMults, 50).toFixed(2)} (expect ~1.0-1.6)`);
    }
  }

  // Fetch bars to compute real ATR at backfill signal times
  console.log(`\n  Cross-checking against bar-derived ATR(14) at backfill signal timestamps...`);
  const barMap = new Map<number, number>(); // minuteTs -> index in bars array
  const bars: { timestamp: string; open: number; high: number; low: number; close: number }[] = [];
  const barFetchFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  offset = 0;
  for (;;) {
    const { data, error } = await client
      .from('gold_m1_bars').select('timestamp, open, high, low, close')
      .gte('timestamp', barFetchFrom).order('timestamp', { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`Bar fetch: ${error.message}`);
    const rows = (data ?? []) as typeof bars;
    bars.push(...rows);
    if (rows.length < 1000) break;
    offset += 1000;
    if (offset > 200000) break;
  }
  console.log(`  Fetched ${bars.length} bars for ATR cross-check`);
  for (let i = 0; i < bars.length; i++) {
    barMap.set(new Date(bars[i].timestamp).getTime(), i);
  }

  // For each backfill signal with an atr, find the bar at that signal's time and compute real ATR(14)
  console.log(`\n  Backfill ATR vs bar-derived ATR (first 10 matches):`);
  let matchedCount = 0;
  let totalChecked = 0;
  for (const s of backfillSigs) {
    if (s.atr === null || !s.emitted_at) continue;
    const sigMs = new Date(s.emitted_at).getTime();
    // Find the bar at or just before the signal time
    let barIdx = -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (new Date(bars[i].timestamp).getTime() <= sigMs) { barIdx = i; break; }
    }
    if (barIdx < 14) continue;
    totalChecked++;
    const barAtr = computeATR14(bars, barIdx, 14);
    if (barAtr === null) continue;
    matchedCount++;
    if (matchedCount <= 10) {
      const storedAtr = s.atr;
      console.log(`    id=${s.signal_id.slice(-8)} stored_atr=${storedAtr.toFixed(2)} bar_atr=${barAtr.toFixed(4)} ratio=${(storedAtr / barAtr).toFixed(1)} stored/pip=${(storedAtr / PIP_VALUE).toFixed(0)}`);
    }
  }
  console.log(`  Matched ${matchedCount}/${totalChecked} backfill signals to bars`);

  // ── 138(a): Sub-0.68 cohort direct measurement ─────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('── 138(a): SUB-0.68 CONFIDENCE COHORT DIRECT MEASUREMENT ──');
  console.log('─'.repeat(60));

  // Build canonical book: signals with resolved outcomes, scratch excluded
  type BookEntry = {
    signal: EmittedSignal;
    rNet: number;
    confidence: number;
    source: string;
  };
  const book: BookEntry[] = [];

  for (const s of allSignals) {
    const outcome = outcomes.get(s.signal_id);
    if (!outcome || outcome.isScratch) continue;
    if (outcome.realizedR === null || !Number.isFinite(outcome.realizedR)) continue;
    // Use the realized R from the resolver — it's the canonical measure
    book.push({
      signal: s,
      rNet: outcome.realizedR,
      confidence: s.confidence,
      source: s.source,
    });
  }

  console.log(`\n  Canonical book: n=${book.length}`);

  // Full book stats
  const fullRNet = book.map(b => b.rNet);
  const fullStats = meanStdErr(fullRNet);
  const fullWins = fullRNet.filter(r => r > 0).length;
  const fullWR = (fullWins / fullRNet.length) * 100;
  const fullPF = Math.abs(fullRNet.filter(r => r > 0).reduce((a, b) => a + b, 0)) / Math.abs(fullRNet.filter(r => r < 0).reduce((a, b) => a + b, 0) || 1);
  console.log(`  FULL BOOK: n=${fullStats.n} WR=${fullWR.toFixed(2)}% EV=${fullStats.mean >= 0 ? '+' : ''}${fullStats.mean.toFixed(4)}R PF=${fullPF.toFixed(3)} CI=[${(fullStats.mean - fullStats.ci95).toFixed(4)}, ${(fullStats.mean + fullStats.ci95).toFixed(4)}]`);

  // Sub-0.68 cohort
  const sub068 = book.filter(b => b.confidence < 0.68);
  const sub068RNet = sub068.map(b => b.rNet);
  const sub068Stats = meanStdErr(sub068RNet);
  const sub068Wins = sub068RNet.filter(r => r > 0).length;
  const sub068WR = sub068RNet.length > 0 ? (sub068Wins / sub068RNet.length) * 100 : 0;
  const sub068PF = Math.abs(sub068RNet.filter(r => r > 0).reduce((a, b) => a + b, 0)) / Math.abs(sub068RNet.filter(r => r < 0).reduce((a, b) => a + b, 0) || 1);
  console.log(`\n  SUB-0.68: n=${sub068Stats.n} WR=${sub068WR.toFixed(2)}% EV=${sub068Stats.mean >= 0 ? '+' : ''}${sub068Stats.mean.toFixed(4)}R PF=${sub068PF.toFixed(3)} CI=[${(sub068Stats.mean - sub068Stats.ci95).toFixed(4)}, ${(sub068Stats.mean + sub068Stats.ci95).toFixed(4)}]`);

  // Also 0.68-0.72, 0.72-0.80, 0.80-0.85, 0.85-0.90, 0.90+
  const thresholds: [string, number, number][] = [
    ['< 0.68', 0, 0.68],
    ['0.68-0.72', 0.68, 0.72],
    ['0.72-0.80', 0.72, 0.80],
    ['0.80-0.85', 0.80, 0.85],
    ['0.85-0.90', 0.85, 0.90],
    ['>= 0.90', 0.90, 1.01],
  ];
  console.log(`\n  Per-band breakdown:`);
  for (const [label, lo, hi] of thresholds) {
    const band = book.filter(b => b.confidence >= lo && b.confidence < hi);
    if (band.length === 0) { console.log(`    ${label}: n=0`); continue; }
    const rNets = band.map(b => b.rNet);
    const stats = meanStdErr(rNets);
    const wins = rNets.filter(r => r > 0).length;
    const wr = (wins / rNets.length) * 100;
    const pf = Math.abs(rNets.filter(r => r > 0).reduce((a, b) => a + b, 0)) / Math.abs(rNets.filter(r => r < 0).reduce((a, b) => a + b, 0) || 1);
    console.log(`    ${label}: n=${stats.n} WR=${wr.toFixed(2)}% EV=${stats.mean >= 0 ? '+' : ''}${stats.mean.toFixed(4)}R PF=${pf.toFixed(3)} CI=[${(stats.mean - stats.ci95).toFixed(4)}, ${(stats.mean + stats.ci95).toFixed(4)}]`);
  }

  // ── 138(c): Mechanical explanations ─────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('── 138(c): MECHANICAL EXPLANATION TESTS ──');
  console.log('─'.repeat(60));

  // Check if sub-0.68 is concentrated in one source/era
  console.log('\n  Sub-0.68 by source:');
  for (const src of Object.keys(bySource)) {
    const subSrc = sub068.filter(b => b.source === src);
    console.log(`    ${src}: n=${subSrc.length}/${sub068.length} (${((subSrc.length / sub068.length) * 100).toFixed(1)}%)`);
  }

  // Check by date
  console.log('\n  Sub-0.68 by week:');
  const weekMap = new Map<string, BookEntry[]>();
  for (const b of sub068) {
    const week = b.signal.emitted_at.slice(0, 10);
    if (!weekMap.has(week)) weekMap.set(week, []);
    weekMap.get(week)!.push(b);
  }
  for (const [day, entries] of [...weekMap.entries()].sort()) {
    console.log(`    ${day}: n=${entries.length}`);
  }

  // Check if high confidence (>0.89) triggers different TP geometry
  // The code at :8056 stretches TP3 when confidence >= 0.89
  console.log('\n  TP3 stretch check (confidence >= 0.89 vs < 0.89):');
  const highConf = book.filter(b => b.confidence >= 0.89);
  const lowConf = book.filter(b => b.confidence < 0.89);
  // Compare the tp3/sl ratio (R-multiple of TP3)
  const tp3RHigh = highConf.map(b => Math.abs(b.signal.tp3 - b.signal.entry) / Math.abs(b.signal.entry - b.signal.sl));
  const tp3RLow = lowConf.map(b => Math.abs(b.signal.tp3 - b.signal.entry) / Math.abs(b.signal.entry - b.signal.sl));
  tp3RHigh.sort((a, b) => a - b);
  tp3RLow.sort((a, b) => a - b);
  console.log(`    High conf (>=0.89): n=${highConf.length} TP3/SL ratio p50=${percentile(tp3RHigh, 50).toFixed(2)}`);
  console.log(`    Low conf (<0.89):  n=${lowConf.length} TP3/SL ratio p50=${percentile(tp3RLow, 50).toFixed(2)}`);

  // ── 137(b): Entry quality — distance to nearest same-side zone ──────
  console.log('\n' + '─'.repeat(60));
  console.log('── 137(b): ENTRY QUALITY — DISTANCE TO NEAREST SAME-SIDE ZONE ──');
  console.log('─'.repeat(60));

  console.log('\n  NOTE: Using bar-derived ATR for distance normalisation (F-32: stored atr is corrupt for backfill).');

  // For each signal with an sr_zones_snapshot, find the nearest same-side zone
  type ZoneSnap = { price: number; type: string; reactionStrength: number; touches: number; source: string; }
  type EntryQualityRecord = {
    signal: EmittedSignal;
    distAtr: number; // distance to nearest same-side zone in ATR units
    barAtr: number; // bar-derived ATR at signal time
    rNet: number;
    source: string;
  };
  const eqRecords: EntryQualityRecord[] = [];

  for (const s of allSignals) {
    const outcome = outcomes.get(s.signal_id);
    if (!outcome || outcome.isScratch || outcome.realizedR === null) continue;
    if (!s.sr_zones_snapshot || typeof s.sr_zones_snapshot !== 'object') continue;

    let zones: ZoneSnap[];
    try {
      const snap = s.sr_zones_snapshot;
      if (Array.isArray(snap)) {
        zones = snap as ZoneSnap[];
      } else {
        continue;
      }
    } catch { continue; }
    if (!Array.isArray(zones) || zones.length === 0) continue;

    // Same-side zone: BUY wants SUPPORT, SELL wants RESISTANCE
    const sameSide = s.direction === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
    const sameSideZones = zones.filter(z => z.type === sameSide && (z.reactionStrength ?? 0) >= 0.3);
    if (sameSideZones.length === 0) continue;

    // Nearest same-side zone
    const nearest = sameSideZones.sort((a, b) => Math.abs(a.price - s.entry) - Math.abs(b.price - s.entry))[0];
    const dist = Math.abs(s.entry - nearest.price);

    // Get bar-derived ATR at signal time
    const sigMs = new Date(s.emitted_at).getTime();
    let barIdx = -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      if (new Date(bars[i].timestamp).getTime() <= sigMs) { barIdx = i; break; }
    }
    if (barIdx < 14) continue;
    const barAtr = computeATR14(bars, barIdx, 14);
    if (barAtr === null || barAtr <= 0) continue;

    const distAtr = dist / barAtr;
    eqRecords.push({
      signal: s,
      distAtr,
      barAtr,
      rNet: outcome.realizedR,
      source: s.source,
    });
  }

  console.log(`\n  Entry quality records: n=${eqRecords.length}`);

  // Bucket by distance
  const buckets: [string, number, number][] = [
    ['0-0.5 ATR', 0, 0.5],
    ['0.5-1.0 ATR', 0.5, 1.0],
    ['1.0-1.5 ATR', 1.0, 1.5],
    ['1.5-2.0 ATR', 1.5, 2.0],
    ['2.0-3.0 ATR', 2.0, 3.0],
    ['3.0+ ATR', 3.0, 999],
  ];
  console.log('\n  Distance-to-nearest-same-side-zone buckets (BAR-DERIVED ATR):');
  for (const [label, lo, hi] of buckets) {
    const bucket = eqRecords.filter(r => r.distAtr >= lo && r.distAtr < hi);
    if (bucket.length === 0) { console.log(`    ${label}: n=0`); continue; }
    const rNets = bucket.map(r => r.rNet);
    const stats = meanStdErr(rNets);
    const wins = rNets.filter(r => r > 0).length;
    const wr = (wins / rNets.length) * 100;
    const pf = Math.abs(rNets.filter(r => r > 0).reduce((a, b) => a + b, 0)) / Math.abs(rNets.filter(r => r < 0).reduce((a, b) => a + b, 0) || 1);
    // Power: for a one-sample t-test, n needed for medium effect (d=0.5) at alpha=0.05 is ~33
    const power = bucket.length >= 33 ? 'ADEQUATE' : bucket.length >= 15 ? 'MARGINAL' : 'UNDERPOWERED';
    console.log(`    ${label}: n=${stats.n} WR=${wr.toFixed(1)}% EV=${stats.mean >= 0 ? '+' : ''}${stats.mean.toFixed(4)}R PF=${pf.toFixed(3)} ${power} CI=[${(stats.mean - stats.ci95).toFixed(4)}, ${(stats.mean + stats.ci95).toFixed(4)}]`);
  }

  // Also do a far-vs-near split at 1.5 ATR
  const near = eqRecords.filter(r => r.distAtr < 1.5);
  const far = eqRecords.filter(r => r.distAtr >= 1.5);
  console.log(`\n  Near (<1.5 ATR): n=${near.length}`);
  if (near.length > 0) {
    const stats = meanStdErr(near.map(r => r.rNet));
    const wins = near.filter(r => r.rNet > 0).length;
    console.log(`    WR=${((wins / near.length) * 100).toFixed(1)}% EV=${stats.mean >= 0 ? '+' : ''}${stats.mean.toFixed(4)}R CI=[${(stats.mean - stats.ci95).toFixed(4)}, ${(stats.mean + stats.ci95).toFixed(4)}]`);
  }
  console.log(`  Far (>=1.5 ATR): n=${far.length}`);
  if (far.length > 0) {
    const stats = meanStdErr(far.map(r => r.rNet));
    const wins = far.filter(r => r.rNet > 0).length;
    console.log(`    WR=${((wins / far.length) * 100).toFixed(1)}% EV=${stats.mean >= 0 ? '+' : ''}${stats.mean.toFixed(4)}R CI=[${(stats.mean - stats.ci95).toFixed(4)}, ${(stats.mean + stats.ci95).toFixed(4)}]`);
  }

  console.log('\n' + '='.repeat(84));
}

main().catch(err => { console.error('FATAL:', err instanceof Error ? err.message : String(err)); process.exit(1); });
