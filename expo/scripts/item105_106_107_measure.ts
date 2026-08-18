/**
 * ITEM 105 — RE-DERIVE DEDUP GUARD AGAINST THE REAL 5-SIGNAL CLUSTER.
 * ITEM 106 — GRADE THE VETO.
 * ITEM 107 — SESSION-LIQUIDITY HAZARD.
 *
 * Combined measurement script: all three are read-only canonical measurements
 * against Supabase, so they share the same data fetch.
 *
 * DATA-SOURCE RULE: reads via anon key only.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }
interface SignalRow {
  signal_id: string; emitted_at: string; direction: 'BUY' | 'SELL';
  entry: number; sl: number; tp1: number; tp2: number; tp3: number;
  confidence: number; atr: number; hour_utc: number;
  srZonesSnapshot: any; session_name: string | null;
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

const EXECUTION_COST_PER_TRADE_USD = 0.20;
const DOLLAR_PER_PRICE_UNIT = 1;
function costInR(riskPriceUnits: number): number {
  const riskUsd = riskPriceUnits * DOLLAR_PER_PRICE_UNIT;
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  return EXECUTION_COST_PER_TRADE_USD / riskUsd;
}

function toTradingSignal(row: Record<string, unknown>): TradingSignal {
  return {
    id: String(row.signal_id ?? ''),
    timestamp: new Date(String(row.emitted_at)),
    createdAt: new Date(String(row.emitted_at)).getTime(),
    type: String(row.direction) === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: Number(row.entry),
    entryPriceWithSlippage: Number(row.entry),
    tp1: Number(row.tp1 ?? 0), tp2: Number(row.tp2 ?? 0), tp3: Number(row.tp3 ?? 0),
    sl: Number(row.sl ?? 0),
    confidence: Number(row.confidence ?? 0),
    status: 'ACTIVE' as SignalStatus, targetsHit: 0,
    slMultiplier: Number(row.sl_multiplier ?? 1), atr: Number(row.atr ?? 0),
    regime: String(row.regime ?? 'TRENDING'), rsi: Number(row.rsi ?? 50),
    sessionName: String(row.session_name ?? ''), hourUtc: Number(row.hour_utc ?? 0),
    srZonesSnapshot: null, attentionScores: null,
    htfTrend: String(row.htf_trend ?? 'NEUTRAL'), ltfTrend: String(row.ltf_trend ?? 'NEUTRAL'),
    breakevenReached: false, breakevenTime: undefined,
    slPips: 70, tp1Pips: 49, tp2Pips: 74, tp3Pips: 98,
  } as unknown as TradingSignal;
}

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('ITEMS 105 / 106 / 107 — DEDUP RE-DERIVATION + VETO GRADING + SESSION HAZARD');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing anon credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // Fetch all signals
  console.log('\n  Fetching emitted_signals_v1...');
  const allSignals: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from('emitted_signals_v1').select('*').order('emitted_at', { ascending: true }).range(offset, offset + 999);
    if (error) { console.error(`signal fetch: ${error.message}`); process.exit(1); }
    const rows = (data ?? []) as Record<string, unknown>[];
    allSignals.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`  ${allSignals.length} signals`);

  // Fetch all bars
  console.log('  Fetching gold_m1_bars...');
  const { data: barsStart } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const { data: barsEnd } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const barsFromMs = new Date(String(barsStart?.[0]?.timestamp)).getTime();
  const barsToMs = new Date(String(barsEnd?.[0]?.timestamp)).getTime();
  const allBars: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars').select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(barsFromMs).toISOString())
      .lte('timestamp', new Date(barsToMs).toISOString())
      .order('timestamp', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) allBars.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }
  console.log(`  ${allBars.length} bars`);
  const barsByMinute = new Map<number, Bar>();
  for (const b of allBars) barsByMinute.set(b.timestamp, b);
  const sortedTs = allBars.map(b => b.timestamp).sort((a, b) => a - b);
  function barsInWindow(fromMs: number, toMs: number): Bar[] {
    const out: Bar[] = [];
    for (const ts of sortedTs) { if (ts < fromMs) continue; if (ts > toMs) break; const b = barsByMinute.get(ts); if (b) out.push(b); }
    return out;
  }

  // Resolve all signals canonically
  console.log('  Resolving canonically...');
  const resolved = new Map<string, { status: string; exitPrice: number; rNet: number; win: boolean }>();
  const origLog = console.log;
  for (const row of allSignals) {
    const sig = toTradingSignal(row);
    const sigTs = sig.createdAt!;
    const bars = barsInWindow(sigTs - 60_000, Math.min(sigTs + 8 * 3600_000, barsToMs));
    if (bars.length === 0) continue;
    console.log = () => {};
    try {
      const result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: Math.min(sigTs + 8 * 3600_000, barsToMs) });
      console.log = origLog;
      const risk = Math.abs(sig.entryPrice - sig.sl);
      if (risk <= 0) continue;
      const rG = sig.type === 'BUY' ? (result.exitPrice - sig.entryPrice) / risk : (sig.entryPrice - result.exitPrice) / risk;
      const rN = rG - costInR(risk);
      resolved.set(sig.id, { status: result.newStatus, exitPrice: result.exitPrice, rNet: rN, win: rN > 0 });
    } catch { console.log = origLog; }
  }
  console.log = origLog;
  console.log(`  ${resolved.size} resolved`);

  // ════════════════════════════════════════════════════════════════════
  // ITEM 105 — DEDUP RE-DERIVATION
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 105 — DEDUP RE-DERIVATION AGAINST 5-SIGNAL CLUSTER');
  console.log(line);

  // 105(a): Pull the 5-signal BUY cluster
  // The cluster was at ~4399-4400 around 08:00 UTC. Find all BUYs within a tight price band.
  const buySignals = allSignals
    .filter(r => String(r.direction) === 'BUY')
    .map(r => ({
      id: String(r.signal_id),
      ts: new Date(String(r.emitted_at)).getTime(),
      entry: Number(r.entry),
      atr: Number(r.atr ?? 0),
      direction: 'BUY' as const,
      emitted_at: String(r.emitted_at),
    }))
    .sort((a, b) => a.ts - b.ts);

  // Find clusters: groups of same-direction signals within 2 ATR and 60 min
  const clusters: { signals: typeof buySignals }[] = [];
  for (const sig of buySignals) {
    let placed = false;
    for (const cluster of clusters) {
      const last = cluster.signals[cluster.signals.length - 1];
      const timeGap = sig.ts - last.ts;
      const priceGap = Math.abs(sig.entry - last.entry);
      const atrApprox = Math.max(sig.atr, last.atr, 1);
      if (timeGap < 60 * 60 * 1000 && priceGap < 2 * atrApprox) {
        cluster.signals.push(sig);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ signals: [sig] });
  }

  // Find the largest cluster(s)
  const bigClusters = clusters.filter(c => c.signals.length >= 3).sort((a, b) => b.signals.length - a.signals.length);

  console.log(`\n  105(a) — ALL CLUSTERS (>= 3 same-direction signals within 60min/2ATR):`);
  for (let ci = 0; ci < Math.min(3, bigClusters.length); ci++) {
    const c = bigClusters[ci];
    console.log(`\n  CLUSTER ${ci + 1}: ${c.signals.length} BUYs`);
    for (let i = 0; i < c.signals.length; i++) {
      const s = c.signals[i];
      const outcome = resolved.get(s.id);
      const rNet = outcome?.rNet ?? 0;
      const win = outcome?.win ? 'WIN' : 'LOSS';
      console.log(`    [${i + 1}] ${s.id.slice(-9)}  ${new Date(s.ts).toISOString()}  entry=${s.entry.toFixed(1)}  atr=${s.atr.toFixed(2)}  R=${rNet >= 0 ? '+' : ''}${rNet.toFixed(4)}  ${win}`);
    }
    // Pairwise gaps
    console.log(`    PAIRWISE GAPS:`);
    for (let i = 0; i < c.signals.length; i++) {
      for (let j = i + 1; j < c.signals.length; j++) {
        const a = c.signals[i];
        const b = c.signals[j];
        const timeGapMin = (b.ts - a.ts) / 60000;
        const priceGap = Math.abs(b.entry - a.entry);
        const atrApprox = Math.max(a.atr, b.atr, 1);
        const priceGapAtr = priceGap / atrApprox;
        console.log(`      [${i + 1}]→[${j + 1}]: time=${timeGapMin.toFixed(1)}min  price=$${priceGap.toFixed(2)}  ${priceGapAtr.toFixed(2)}ATR`);
      }
    }
  }

  // 105(b): Derive DEDUP_TIME_WINDOW_MS and DEDUP_PRICE_BAND_ATR
  console.log(`\n  105(b) — DERIVE DEDUP CONSTANTS:`);
  // Use the largest cluster's pairwise max gaps as the derivation basis
  const primaryCluster = bigClusters[0];
  if (primaryCluster) {
    let maxTimeGapMin = 0;
    let maxPriceGapAtr = 0;
    for (let i = 0; i < primaryCluster.signals.length; i++) {
      for (let j = i + 1; j < primaryCluster.signals.length; j++) {
        const a = primaryCluster.signals[i];
        const b = primaryCluster.signals[j];
        const timeGapMin = (b.ts - a.ts) / 60000;
        const priceGap = Math.abs(b.entry - a.entry);
        const atrApprox = Math.max(a.atr, b.atr, 1);
        const priceGapAtr = priceGap / atrApprox;
        maxTimeGapMin = Math.max(maxTimeGapMin, timeGapMin);
        maxPriceGapAtr = Math.max(maxPriceGapAtr, priceGapAtr);
      }
    }
    console.log(`    Primary cluster: ${primaryCluster.signals.length} signals`);
    console.log(`    Max time gap: ${maxTimeGapMin.toFixed(1)} min`);
    console.log(`    Max price gap: ${maxPriceGapAtr.toFixed(2)} ATR`);
    console.log(`    DERIVATION: DEDUP_TIME_WINDOW_MS must exceed max gap = ${maxTimeGapMin.toFixed(0)} min → ceil to ${Math.ceil(maxTimeGapMin / 10) * 10} min`);
    console.log(`    DERIVATION: DEDUP_PRICE_BAND_ATR must exceed max gap = ${maxPriceGapAtr.toFixed(2)} → ceil to ${Math.ceil(maxPriceGapAtr * 2) / 2} ATR`);
  }

  // Also compute across ALL same-direction emission pairs
  const allSameDirPairs: { timeGapMin: number; priceGapAtr: number }[] = [];
  for (let i = 0; i < buySignals.length - 1; i++) {
    for (let j = i + 1; j < Math.min(i + 20, buySignals.length); j++) {
      const a = buySignals[i];
      const b = buySignals[j];
      const timeGapMin = (b.ts - a.ts) / 60000;
      if (timeGapMin > 120) break; // only within 2h
      const priceGap = Math.abs(b.entry - a.entry);
      const atrApprox = Math.max(a.atr, b.atr, 1);
      allSameDirPairs.push({ timeGapMin, priceGapAtr: priceGap / atrApprox });
    }
  }
  // Distribution
  const within30min = allSameDirPairs.filter(p => p.timeGapMin <= 30);
  const within60min = allSameDirPairs.filter(p => p.timeGapMin <= 60);
  const within2ATR = allSameDirPairs.filter(p => p.priceGapAtr <= 2.0);
  console.log(`\n    ALL same-direction BUY pairs within 2h: n=${allSameDirPairs.length}`);
  console.log(`    Within 30 min: ${within30min.length} (${(within30min.length / allSameDirPairs.length * 100).toFixed(1)}%)`);
  console.log(`    Within 60 min: ${within60min.length} (${(within60min.length / allSameDirPairs.length * 100).toFixed(1)}%)`);
  console.log(`    Within 2.0 ATR: ${within2ATR.length} (${(within2ATR.length / allSameDirPairs.length * 100).toFixed(1)}%)`);

  // ════════════════════════════════════════════════════════════════════
  // ITEM 106 — GRADE THE VETO
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 106 — GRADE THE VETO');
  console.log(line);

  // 106(a): Live veto count — how many signals would be blocked?
  let pathBlocked = 0;
  let pathClear = 0;
  const blockedOutcomes: { id: string; rNet: number; win: boolean }[] = [];
  const clearOutcomes: { id: string; rNet: number; win: boolean }[] = [];

  for (const row of allSignals) {
    const sig = toTradingSignal(row);
    const isBuy = sig.type === 'BUY';
    const entry = sig.entryPrice;
    const tp1 = sig.tp1;
    const sl = sig.sl;
    const zones = row.sr_zones_snapshot;
    if (!zones) continue;
    let zoneArr: { type: string; price: number; reactionStrength: number }[] = [];
    try {
      if (typeof zones === 'string') zoneArr = JSON.parse(zones);
      else if (Array.isArray(zones)) zoneArr = zones as any;
    } catch { continue; }

    const opposingType = isBuy ? 'RESISTANCE' : 'SUPPORT';
    const minP = Math.min(entry, tp1);
    const maxP = Math.max(entry, tp1);
    const blockingZone = zoneArr.find((z: any) =>
      z.type === opposingType &&
      z.price > minP + 0.01 &&
      z.price < maxP - 0.01 &&
      (z.reactionStrength ?? 0) >= 0.3
    );

    const outcome = resolved.get(sig.id);
    if (!outcome) continue;

    if (blockingZone) {
      pathBlocked++;
      blockedOutcomes.push({ id: sig.id, rNet: outcome.rNet, win: outcome.win });
    } else {
      pathClear++;
      clearOutcomes.push({ id: sig.id, rNet: outcome.rNet, win: outcome.win });
    }
  }

  const blockedWR = blockedOutcomes.length > 0 ? (blockedOutcomes.filter(o => o.win).length / blockedOutcomes.length) * 100 : 0;
  const blockedEV = blockedOutcomes.length > 0 ? blockedOutcomes.reduce((s, o) => s + o.rNet, 0) / blockedOutcomes.length : 0;
  const clearWR = clearOutcomes.length > 0 ? (clearOutcomes.filter(o => o.win).length / clearOutcomes.length) * 100 : 0;
  const clearEV = clearOutcomes.length > 0 ? clearOutcomes.reduce((s, o) => s + o.rNet, 0) / clearOutcomes.length : 0;

  console.log(`\n  106(a) — LIVE VETO EFFECT:`);
  console.log(`    Path-blocked: n=${pathBlocked} WR=${blockedWR.toFixed(1)}% EV=${blockedEV >= 0 ? '+' : ''}${blockedEV.toFixed(4)}R`);
  console.log(`    Path-clear:   n=${pathClear} WR=${clearWR.toFixed(1)}% EV=${clearEV >= 0 ? '+' : ''}${clearEV.toFixed(4)}R`);

  // 106(b): Three policies on the same population
  console.log(`\n  106(b) — THREE POLICIES:`);
  // Policy 1: hard veto (current) — blocked signals excluded
  const hardVetoN = clearOutcomes.length;
  const hardVetoEV = clearEV;
  const hardVetoWR = clearWR;

  // Policy 2: graded confidence penalty — reduce confidence by how far into the opposing zone TP1 sits
  const gradedOutcomes = [...clearOutcomes, ...blockedOutcomes.map(o => ({
    ...o,
    rNet: o.rNet * 0.5, // 50% confidence penalty
  }))];
  const gradedN = gradedOutcomes.length;
  const gradedWR = gradedOutcomes.filter(o => o.win).length / gradedN * 100;
  const gradedEV = gradedOutcomes.reduce((s, o) => s + o.rNet, 0) / gradedN;

  // Policy 3: no gate (all signals through)
  const allOutcomes = [...clearOutcomes, ...blockedOutcomes];
  const noGateN = allOutcomes.length;
  const noGateWR = allOutcomes.filter(o => o.win).length / noGateN * 100;
  const noGateEV = allOutcomes.reduce((s, o) => s + o.rNet, 0) / noGateN;

  console.log(`    POWER: blocked n=${pathBlocked}, clear n=${pathClear}, total n=${pathBlocked + pathClear}`);
  console.log(`\n    ┌────────────────────────────────┬─────┬────────┬──────────────┐`);
  console.log(`    │ POLICY                         │  n  │  WR    │ EV NET       │`);
  console.log(`    ├────────────────────────────────┼─────┼────────┼──────────────┤`);
  console.log(`    │ Hard veto (current)            │ ${String(hardVetoN).padStart(3)} │ ${hardVetoWR.toFixed(1)}% │ ${hardVetoEV >= 0 ? '+' : ''}${hardVetoEV.toFixed(4)}R  │`);
  console.log(`    │ Graded penalty (50% conf)      │ ${String(gradedN).padStart(3)} │ ${gradedWR.toFixed(1)}% │ ${gradedEV >= 0 ? '+' : ''}${gradedEV.toFixed(4)}R  │`);
  console.log(`    │ No gate                        │ ${String(noGateN).padStart(3)} │ ${noGateWR.toFixed(1)}% │ ${noGateEV >= 0 ? '+' : ''}${noGateEV.toFixed(4)}R  │`);
  console.log(`    └────────────────────────────────┴─────┴────────┴──────────────┘`);

  // 106(c): Winner
  const policies = [
    { name: 'Hard veto', ev: hardVetoEV, n: hardVetoN },
    { name: 'Graded penalty', ev: gradedEV, n: gradedN },
    { name: 'No gate', ev: noGateEV, n: noGateN },
  ];
  const winner = policies.reduce((best, p) => p.ev > best.ev ? p : best, policies[0]);
  console.log(`\n  WINNER: ${winner.name} (EV=${winner.ev >= 0 ? '+' : ''}${winner.ev.toFixed(4)}R)`);
  if (winner.name === 'Hard veto') {
    console.log(`  Keep the hard veto. It beats the graded penalty by ${(hardVetoEV - gradedEV).toFixed(4)}R.`);
  } else {
    console.log(`  Ship ${winner.name} instead of the hard veto.`);
  }
  console.log(`  Item 104 interaction: with await-the-zone, a path-blocked signal should first attempt`);
  console.log(`  to move its entry to the strong zone, and only be vetoed if the path is still blocked there.`);

  // ════════════════════════════════════════════════════════════════════
  // ITEM 107 — SESSION-LIQUIDITY HAZARD
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 107 — SESSION-LIQUIDITY HAZARD');
  console.log(line);

  // 107(a): Bucket by minutes-to-next-session-open
  const LONDON_OPEN_UTC = 7; // 07:00 UTC
  const NY_OPEN_UTC = 13;    // 13:00 UTC

  function minutesToNextSessionOpen(ts: number): number {
    const d = new Date(ts);
    const hourUtc = d.getUTCHours();
    const minUtc = d.getUTCMinutes();
    const currentMinutes = hourUtc * 60 + minUtc;
    const londonMin = LONDON_OPEN_UTC * 60;
    const nyMin = NY_OPEN_UTC * 60;
    // Next London open
    let londonGap = londonMin - currentMinutes;
    if (londonGap < 0) londonGap += 24 * 60; // next day
    // Next NY open
    let nyGap = nyMin - currentMinutes;
    if (nyGap < 0) nyGap += 24 * 60;
    return Math.min(londonGap, nyGap);
  }

  // Bucket signals by minutes-to-open
  const buckets: { range: string; outcomes: { rNet: number; win: boolean }[] }[] = [
    { range: '0-15 min before open', outcomes: [] },
    { range: '15-30 min before open', outcomes: [] },
    { range: '30-60 min before open', outcomes: [] },
    { range: '60-120 min before open', outcomes: [] },
    { range: '> 120 min from open', outcomes: [] },
  ];

  for (const row of allSignals) {
    const sig = toTradingSignal(row);
    const outcome = resolved.get(sig.id);
    if (!outcome) continue;
    const m = minutesToNextSessionOpen(sig.createdAt!);
    if (m <= 15) buckets[0].outcomes.push({ rNet: outcome.rNet, win: outcome.win });
    else if (m <= 30) buckets[1].outcomes.push({ rNet: outcome.rNet, win: outcome.win });
    else if (m <= 60) buckets[2].outcomes.push({ rNet: outcome.rNet, win: outcome.win });
    else if (m <= 120) buckets[3].outcomes.push({ rNet: outcome.rNet, win: outcome.win });
    else buckets[4].outcomes.push({ rNet: outcome.rNet, win: outcome.win });
  }

  console.log(`\n  107(a) — CANONICAL WR/EV BY MINUTES-TO-SESSION-OPEN:`);
  console.log(`  POWER STATED FIRST:`);
  console.log(`\n    ┌──────────────────────────────┬─────┬────────┬──────────────┐`);
  console.log(`    │ BUCKET                       │  n  │  WR    │ EV NET       │`);
  console.log(`    ├──────────────────────────────┼─────┼────────┼──────────────┤`);
  for (const b of buckets) {
    const n = b.outcomes.length;
    const wr = n > 0 ? (b.outcomes.filter(o => o.win).length / n) * 100 : 0;
    const ev = n > 0 ? b.outcomes.reduce((s, o) => s + o.rNet, 0) / n : 0;
    console.log(`    │ ${b.range.padEnd(28)} │ ${String(n).padStart(3)} │ ${wr.toFixed(1)}% │ ${ev >= 0 ? '+' : ''}${ev.toFixed(4)}R  │`);
  }
  console.log(`    └──────────────────────────────┴─────┴────────┴──────────────┘`);

  // 107(b): Measure expansion — realized range 60 min after vs before 07:00 UTC
  console.log(`\n  107(b) — SESSION EXPANSION (60min after vs before 07:00 UTC):`);
  // For each day in the bar data, compute the range of the 60 bars before and after 07:00 UTC
  const barsByDay = new Map<string, Bar[]>();
  for (const b of allBars) {
    const d = new Date(b.timestamp);
    const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
    if (!barsByDay.has(dayKey)) barsByDay.set(dayKey, []);
    barsByDay.get(dayKey)!.push(b);
  }

  let beforeRanges: number[] = [];
  let afterRanges: number[] = [];
  for (const [, dayBars] of barsByDay) {
    const dayBarsSorted = dayBars.sort((a, b) => a.timestamp - b.timestamp);
    const sevenAM = dayBarsSorted.find(b => {
      const d = new Date(b.timestamp);
      return d.getUTCHours() === 7 && d.getUTCMinutes() === 0;
    });
    if (!sevenAM) continue;
    const sevenAMTs = sevenAM.timestamp;
    // 60 bars before: 06:00-07:00 UTC
    const before = dayBarsSorted.filter(b => b.timestamp >= sevenAMTs - 60 * 60000 && b.timestamp < sevenAMTs);
    // 60 bars after: 07:00-08:00 UTC
    const after = dayBarsSorted.filter(b => b.timestamp >= sevenAMTs && b.timestamp < sevenAMTs + 60 * 60000);
    if (before.length < 30 || after.length < 30) continue;
    const beforeRange = Math.max(...before.map(b => b.high)) - Math.min(...before.map(b => b.low));
    const afterRange = Math.max(...after.map(b => b.high)) - Math.min(...after.map(b => b.low));
    beforeRanges.push(beforeRange);
    afterRanges.push(afterRange);
  }

  const avgBefore = beforeRanges.length > 0 ? beforeRanges.reduce((s, r) => s + r, 0) / beforeRanges.length : 0;
  const avgAfter = afterRanges.length > 0 ? afterRanges.reduce((s, r) => s + r, 0) / afterRanges.length : 0;
  const expansion = avgAfter - avgBefore;
  const expansionPct = avgBefore > 0 ? (expansion / avgBefore) * 100 : 0;

  console.log(`    Days measured: ${beforeRanges.length}`);
  console.log(`    Avg range 60min BEFORE 07:00 UTC: $${avgBefore.toFixed(2)}`);
  console.log(`    Avg range 60min AFTER  07:00 UTC: $${avgAfter.toFixed(2)}`);
  console.log(`    Expansion: $${expansion.toFixed(2)} (${expansionPct >= 0 ? '+' : ''}${expansionPct.toFixed(1)}%)`);

  // 107(c/d): Ship decision
  console.log(`\n  107(c) — SHIP DECISION:`);
  const preOpenBucket = buckets[0]; // 0-15 min
  const otherBuckets = buckets.slice(1).flatMap(b => b.outcomes);
  const preOpenWR = preOpenBucket.outcomes.length > 0 ? preOpenBucket.outcomes.filter(o => o.win).length / preOpenBucket.outcomes.length * 100 : 0;
  const preOpenEV = preOpenBucket.outcomes.length > 0 ? preOpenBucket.outcomes.reduce((s, o) => s + o.rNet, 0) / preOpenBucket.outcomes.length : 0;
  const otherWR = otherBuckets.length > 0 ? otherBuckets.filter(o => o.win).length / otherBuckets.length * 100 : 0;
  const otherEV = otherBuckets.length > 0 ? otherBuckets.reduce((s, o) => s + o.rNet, 0) / otherBuckets.length : 0;

  console.log(`    Pre-open (0-15 min): n=${preOpenBucket.outcomes.length} WR=${preOpenWR.toFixed(1)}% EV=${preOpenEV >= 0 ? '+' : ''}${preOpenEV.toFixed(4)}R`);
  console.log(`    Other:               n=${otherBuckets.length} WR=${otherWR.toFixed(1)}% EV=${otherEV >= 0 ? '+' : ''}${otherEV.toFixed(4)}R`);

  if (preOpenBucket.outcomes.length < 15) {
    console.log(`    n=${preOpenBucket.outcomes.length} is UNDERPOWERED (< 15). Ship TELEMETRY only.`);
    console.log(`    Forward evidence: once n >= 30 in the pre-open bucket, re-run and ship a delay gate if the gap is material.`);
  } else if (preOpenEV < otherEV - 0.1 && expansionPct > 20) {
    console.log(`    Pre-open EV is materially worse AND expansion is confirmed. Ship DELAY gate.`);
  } else {
    console.log(`    Pre-open bucket is not materially worse, or underpowered. Ship telemetry only.`);
  }

  console.log(`\n${line}\nDONE\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('item105_106_107 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
