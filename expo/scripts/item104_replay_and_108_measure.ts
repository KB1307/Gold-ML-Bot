/**
 * ITEM 104(b) — REPLAY FAILED BUYs THROUGH AWAIT-THE-ZONE.
 * ITEM 104(c) — VETO-TO-PENDING CONVERSION COUNT.
 * ITEM 108 — RECONSTRUCT OBs AT 398 SIGNALS, MEASURE CORRELATIONS.
 *
 * DATA-SOURCE RULE: reads via anon key only.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { computeMarketStructure, findNearbyUnmitigatedOBs } from '../services/marketStructure';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

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

function toTradingSignal(row: Record<string, unknown>, entryOverride?: number): TradingSignal {
  const entry = entryOverride ?? Number(row.entry);
  return {
    id: String(row.signal_id ?? '') + (entryOverride ? '_moved' : ''),
    timestamp: new Date(String(row.emitted_at)),
    createdAt: new Date(String(row.emitted_at)).getTime(),
    type: String(row.direction) === 'SELL' ? 'SELL' : 'BUY',
    entryPrice: entry,
    entryPriceWithSlippage: entry,
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

async function fetchAllBars(client: ReturnType<typeof createClient>): Promise<{ bars: Bar[]; toMs: number }> {
  const { data: barsStart } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: true }).limit(1);
  const { data: barsEnd } = await client.from('gold_m1_bars').select('timestamp').order('timestamp', { ascending: false }).limit(1);
  const fromMs = new Date(String(barsStart?.[0]?.timestamp)).getTime();
  const toMs = new Date(String(barsEnd?.[0]?.timestamp)).getTime();
  const out: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from('gold_m1_bars').select('timestamp, open, high, low, close')
      .gte('timestamp', new Date(fromMs).toISOString())
      .lte('timestamp', new Date(toMs).toISOString())
      .order('timestamp', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(`bar fetch: ${error.message}`);
    const rows = (data ?? []) as { timestamp: string; open: number; high: number; low: number; close: number }[];
    for (const r of rows) out.push({ timestamp: new Date(r.timestamp).getTime(), open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) });
    if (rows.length < 1000) break;
  }
  return { bars: out, toMs };
}

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('ITEM 104(b)(c) REPLAY + ITEM 108 OB CORRELATION');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing anon credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // Fetch signals
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

  // Fetch bars
  console.log('  Fetching gold_m1_bars...');
  const { bars: allBars, toMs: barsToMs } = await fetchAllBars(client);
  console.log(`  ${allBars.length} bars`);
  const barsByMinute = new Map<number, Bar>();
  for (const b of allBars) barsByMinute.set(b.timestamp, b);
  const sortedTs = allBars.map(b => b.timestamp).sort((a, b) => a - b);
  function barsInWindow(fromMs: number, toMs: number): Bar[] {
    const out: Bar[] = [];
    for (const ts of sortedTs) { if (ts < fromMs) continue; if (ts > toMs) break; const b = barsByMinute.get(ts); if (b) out.push(b); }
    return out;
  }

  // ════════════════════════════════════════════════════════════════════
  // ITEM 104(b) — REPLAY FAILED BUYs THROUGH AWAIT-THE-ZONE
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 104(b) — REPLAY FAILED BUYs THROUGH AWAIT-THE-ZONE');
  console.log(line);

  // Find path-blocked signals
  const AWAIT_ZONE_BAND_ATR = 3.0;
  let pathBlockedCount = 0;
  let converted = 0;
  let stillBlocked = 0;
  let noZoneFound = 0;
  let originalWins = 0;
  let originalLosses = 0;
  let movedWins = 0;
  let movedLosses = 0;
  const replayResults: { id: string; dir: string; origEntry: number; movedEntry: number; zonePrice: number; zoneReaction: number; origR: number; movedR: number; movedTP1: boolean; movedTP2: boolean }[] = [];

  const origLog = console.log;
  for (const row of allSignals) {
    const sig = toTradingSignal(row);
    const isBuy = sig.type === 'BUY';
    const entry = sig.entryPrice;
    const tp1Val = sig.tp1;
    const zones = row.sr_zones_snapshot;
    if (!zones) continue;
    let zoneArr: { type: string; price: number; reactionStrength: number; touches?: number }[] = [];
    try {
      if (typeof zones === 'string') zoneArr = JSON.parse(zones);
      else if (Array.isArray(zones)) zoneArr = zones as any;
    } catch { continue; }

    const opposingType = isBuy ? 'RESISTANCE' : 'SUPPORT';
    const sameSideType = isBuy ? 'SUPPORT' : 'RESISTANCE';
    const minP = Math.min(entry, tp1Val);
    const maxP = Math.max(entry, tp1Val);
    const blockingZone = zoneArr.find(z => z.type === opposingType && z.price > minP + 0.01 && z.price < maxP - 0.01 && (z.reactionStrength ?? 0) >= 0.3);
    if (!blockingZone) continue;
    pathBlockedCount++;

    // Resolve original
    const sigTs = sig.createdAt!;
    const bars = barsInWindow(sigTs - 60_000, Math.min(sigTs + 8 * 3600_000, barsToMs));
    if (bars.length === 0) continue;
    console.log = () => {};
    let origResult: { newStatus: string; exitPrice: number } | null = null;
    try { origResult = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: Math.min(sigTs + 8 * 3600_000, barsToMs) }); } catch { }
    console.log = origLog;
    if (!origResult) continue;
    const risk = Math.abs(sig.entryPrice - sig.sl);
    if (risk <= 0) continue;
    const origR = (isBuy ? (origResult.exitPrice - sig.entryPrice) : (sig.entryPrice - origResult.exitPrice)) / risk - costInR(risk);
    if (origR > 0) originalWins++; else originalLosses++;

    // Find strongest same-side zone within 3 ATR
    const atr = Number(row.atr ?? 1);
    const sameSideZones = zoneArr
      .filter(z => z.type === sameSideType && (z.reactionStrength ?? 0) >= 0.3)
      .filter(z => {
        const dist = Math.abs(z.price - entry);
        const distAtr = dist / Math.max(atr, 0.01);
        return distAtr <= AWAIT_ZONE_BAND_ATR && distAtr > 0.1;
      })
      .sort((a, b) => (b.reactionStrength ?? 0) - (a.reactionStrength ?? 0));

    if (sameSideZones.length === 0) { noZoneFound++; continue; }

    const targetZone = sameSideZones[0];
    const movedEntry = Number(targetZone.price);

    // Re-check path-to-target at MOVED entry with MOVED TP1.
    // The R-based ladder shifts by the same delta as the entry.
    const moveDelta = movedEntry - entry;
    const movedTP1 = tp1Val + moveDelta;
    const movedMinP = Math.min(movedEntry, movedTP1);
    const movedMaxP = Math.max(movedEntry, movedTP1);
    const stillBlockedZone = zoneArr.find(z => z.type === opposingType && z.price > movedMinP + 0.01 && z.price < movedMaxP - 0.01 && (z.reactionStrength ?? 0) >= 0.3);
    if (stillBlockedZone) { stillBlocked++; continue; }

    // Path clears — resolve at moved entry
    converted++;
    const delta = movedEntry - entry;
    const movedSig = toTradingSignal(row, movedEntry);
    movedSig.tp1 = sig.tp1 + delta;
    movedSig.tp2 = sig.tp2 + delta;
    movedSig.tp3 = sig.tp3 + delta;
    movedSig.sl = sig.sl + delta;

    console.log = () => {};
    let movedResult: { newStatus: string; exitPrice: number } | null = null;
    try { movedResult = resolveSignalWithBars(movedSig, bars, { fromScratch: true, evalNowMs: Math.min(sigTs + 8 * 3600_000, barsToMs) }); } catch { }
    console.log = origLog;
    if (!movedResult) continue;
    const movedRisk = Math.abs(movedSig.entryPrice - movedSig.sl);
    if (movedRisk <= 0) continue;
    const movedR = (isBuy ? (movedResult.exitPrice - movedSig.entryPrice) : (movedSig.entryPrice - movedResult.exitPrice)) / movedRisk - costInR(movedRisk);
    if (movedR > 0) movedWins++; else movedLosses++;
    const hitTP1 = movedResult.newStatus === 'ALL_TARGETS_HIT' || movedResult.newStatus === 'PARTIAL_WIN_SL_HIT' || movedResult.newStatus === 'SL_AFTER_BE' || movedResult.newStatus === 'TP2_HIT';
    const hitTP2 = movedResult.newStatus === 'ALL_TARGETS_HIT' || movedResult.newStatus === 'PARTIAL_WIN_SL_HIT';

    replayResults.push({
      id: sig.id, dir: isBuy ? 'BUY' : 'SELL',
      origEntry: entry, movedEntry, zonePrice: movedEntry,
      zoneReaction: targetZone.reactionStrength ?? 0,
      origR, movedR, movedTP1: hitTP1, movedTP2: hitTP2,
    });
  }

  console.log(`\n  Path-blocked signals: ${pathBlockedCount}`);
  console.log(`  Converted (path cleared at moved entry): ${converted}`);
  console.log(`  Still blocked at moved entry: ${stillBlocked}`);
  console.log(`  No same-side zone found: ${noZoneFound}`);
  console.log(`\n  ORIGINAL outcomes (path-blocked): n=${originalWins + originalLosses} W=${originalWins} L=${originalLosses} WR=${originalWins + originalLosses > 0 ? (originalWins / (originalWins + originalLosses) * 100).toFixed(1) : 0}%`);
  console.log(`  MOVED outcomes (await-the-zone):    n=${movedWins + movedLosses} W=${movedWins} L=${movedLosses} WR=${movedWins + movedLosses > 0 ? (movedWins / (movedWins + movedLosses) * 100).toFixed(1) : 0}%`);

  console.log(`\n  WORKED EXAMPLES (first 10):`);
  for (const r of replayResults.slice(0, 10)) {
    console.log(`    ${r.id.slice(-9)} ${r.dir} orig=${r.origEntry.toFixed(1)} → moved=${r.movedEntry.toFixed(1)} (zone r=${(r.zoneReaction * 100).toFixed(0)}%)`);
    console.log(`      orig R=${r.origR >= 0 ? '+' : ''}${r.origR.toFixed(4)} → moved R=${r.movedR >= 0 ? '+' : ''}${r.movedR.toFixed(4)} TP1=${r.movedTP1} TP2=${r.movedTP2}`);
  }

  // 104(c): Veto-to-pending conversion count
  console.log(`\n  104(c) — VETO-TO-PENDING CONVERSION:`);
  console.log(`    Of ${pathBlockedCount} path-blocked signals: ${converted} would convert to PENDING (${pathBlockedCount > 0 ? (converted / pathBlockedCount * 100).toFixed(1) : 0}%)`);
  console.log(`    ${stillBlocked} remain vetoed (path still blocked at moved entry)`);

  // ════════════════════════════════════════════════════════════════════
  // ITEM 108 — OB CORRELATION
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 108 — OB CORRELATION');
  console.log(line);

  // For each signal, reconstruct market structure at its timestamp
  console.log('\n  Reconstructing market structure at each signal...');
  const obResults: { id: string; rNet: number; win: boolean; direction: 'BUY' | 'SELL'; hasOB: boolean; obAligned: boolean; bosAligned: boolean; trend: string }[] = [];
  let processed = 0;

  for (const row of allSignals) {
    const sig = toTradingSignal(row);
    const sigTs = sig.createdAt!;
    // Fetch 24h of bars before the signal for structure reconstruction
    const structBars = barsInWindow(sigTs - 24 * 3600_000, sigTs);
    if (structBars.length < 100) continue;

    // Resolve the signal
    const resolveBars = barsInWindow(sigTs - 60_000, Math.min(sigTs + 8 * 3600_000, barsToMs));
    if (resolveBars.length === 0) continue;
    console.log = () => {};
    let result: { newStatus: string; exitPrice: number } | null = null;
    try { result = resolveSignalWithBars(sig, resolveBars, { fromScratch: true, evalNowMs: Math.min(sigTs + 8 * 3600_000, barsToMs) }); } catch { }
    console.log = origLog;
    if (!result) continue;
    const risk = Math.abs(sig.entryPrice - sig.sl);
    if (risk <= 0) continue;
    const rNet = (sig.type === 'BUY' ? (result.exitPrice - sig.entryPrice) : (sig.entryPrice - result.exitPrice)) / risk - costInR(risk);

    // Compute market structure
    const structure = computeMarketStructure(structBars, 5);
    const atr = Number(row.atr ?? 1);
    const nearbyOBs = findNearbyUnmitigatedOBs(structure, sig.entryPrice, atr, 3);
    const hasOB = nearbyOBs.length > 0;
    const obAligned = nearbyOBs.some(ob => {
      // OB aligned if bullish OB and BUY, or bearish OB and SELL
      return (ob.direction === 'BULLISH' && sig.type === 'BUY') || (ob.direction === 'BEARISH' && sig.type === 'SELL');
    });
    const bosAligned = (structure.prevailingTrend === 'BULLISH' && sig.type === 'BUY') || (structure.prevailingTrend === 'BEARISH' && sig.type === 'SELL');

    obResults.push({
      id: sig.id, rNet, win: rNet > 0, direction: sig.type,
      hasOB, obAligned, bosAligned, trend: structure.prevailingTrend,
    });
    processed++;
  }

  console.log(`  Processed: ${processed}`);

  // 108(b): Measure correlations
  console.log(`\n  108(b) — CORRELATIONS (POWER STATED FIRST: n=${processed})`);

  // OB presence vs outcome
  const obPresent = obResults.filter(r => r.hasOB);
  const obAbsent = obResults.filter(r => !r.hasOB);
  const obPresentWR = obPresent.length > 0 ? obPresent.filter(r => r.win).length / obPresent.length * 100 : 0;
  const obAbsentWR = obAbsent.length > 0 ? obAbsent.filter(r => r.win).length / obAbsent.length * 100 : 0;
  const obPresentEV = obPresent.length > 0 ? obPresent.reduce((s, r) => s + r.rNet, 0) / obPresent.length : 0;
  const obAbsentEV = obAbsent.length > 0 ? obAbsent.reduce((s, r) => s + r.rNet, 0) / obAbsent.length : 0;

  console.log(`\n    OB presence: n_present=${obPresent.length} WR=${obPresentWR.toFixed(1)}% EV=${obPresentEV >= 0 ? '+' : ''}${obPresentEV.toFixed(4)}R`);
  console.log(`                 n_absent=${obAbsent.length}  WR=${obAbsentWR.toFixed(1)}% EV=${obAbsentEV >= 0 ? '+' : ''}${obAbsentEV.toFixed(4)}R`);

  // OB alignment vs outcome
  const obAlignedRows = obResults.filter(r => r.hasOB && r.obAligned);
  const obMisaligned = obResults.filter(r => r.hasOB && !r.obAligned);
  const obAlignedWR = obAlignedRows.length > 0 ? obAlignedRows.filter(r => r.win).length / obAlignedRows.length * 100 : 0;
  const obMisalignedWR = obMisaligned.length > 0 ? obMisaligned.filter(r => r.win).length / obMisaligned.length * 100 : 0;
  const obAlignedEV = obAlignedRows.length > 0 ? obAlignedRows.reduce((s, r) => s + r.rNet, 0) / obAlignedRows.length : 0;
  const obMisalignedEV = obMisaligned.length > 0 ? obMisaligned.reduce((s, r) => s + r.rNet, 0) / obMisaligned.length : 0;

  console.log(`\n    OB aligned: n=${obAlignedRows.length} WR=${obAlignedWR.toFixed(1)}% EV=${obAlignedEV >= 0 ? '+' : ''}${obAlignedEV.toFixed(4)}R`);
  console.log(`    OB misaligned: n=${obMisaligned.length} WR=${obMisalignedWR.toFixed(1)}% EV=${obMisalignedEV >= 0 ? '+' : ''}${obMisalignedEV.toFixed(4)}R`);

  // BoS alignment vs outcome
  const bosAlignedRows = obResults.filter(r => r.bosAligned);
  const bosMisaligned = obResults.filter(r => !r.bosAligned);
  const bosAlignedWR = bosAlignedRows.length > 0 ? bosAlignedRows.filter(r => r.win).length / bosAlignedRows.length * 100 : 0;
  const bosMisalignedWR = bosMisaligned.length > 0 ? bosMisaligned.filter(r => r.win).length / bosMisaligned.length * 100 : 0;
  const bosAlignedEV = bosAlignedRows.length > 0 ? bosAlignedRows.reduce((s, r) => s + r.rNet, 0) / bosAlignedRows.length : 0;
  const bosMisalignedEV = bosMisaligned.length > 0 ? bosMisaligned.reduce((s, r) => s + r.rNet, 0) / bosMisaligned.length : 0;

  console.log(`\n    BoS aligned: n=${bosAlignedRows.length} WR=${bosAlignedWR.toFixed(1)}% EV=${bosAlignedEV >= 0 ? '+' : ''}${bosAlignedEV.toFixed(4)}R`);
  console.log(`    BoS misaligned: n=${bosMisaligned.length} WR=${bosMisalignedWR.toFixed(1)}% EV=${bosMisalignedEV >= 0 ? '+' : ''}${bosMisalignedEV.toFixed(4)}R`);

  // Compute correlation between OB alignment and win
  // Point-biserial correlation: r = (M_win - M_loss) / pooled_sd * sqrt(n1*n2 / (n*(n-1)))
  const obAlignedBinary = obResults.map(r => r.obAligned ? 1 : 0);
  const winBinary = obResults.map(r => r.win ? 1 : 0);
  const n = obResults.length;
  const meanOB = obAlignedBinary.reduce((s, x) => s + x, 0) / n;
  const meanWin = winBinary.reduce((s, x) => s + x, 0) / n;
  const numerator = obAlignedBinary.reduce((s, x, i) => s + (x - meanOB) * (winBinary[i] - meanWin), 0);
  const denomOB = Math.sqrt(obAlignedBinary.reduce((s, x) => s + (x - meanOB) ** 2, 0));
  const denomWin = Math.sqrt(winBinary.reduce((s, x) => s + (x - meanWin) ** 2, 0));
  const corrOB = denomOB > 0 && denomWin > 0 ? numerator / (denomOB * denomWin) : 0;
  // CI for correlation: Fisher z-transform
  const zOB = 0.5 * Math.log((1 + corrOB) / (1 - corrOB));
  const seOB = 1 / Math.sqrt(n - 3);
  const zLoOB = zOB - 1.96 * seOB;
  const zHiOB = zOB + 1.96 * seOB;
  const corrLoOB = (Math.exp(2 * zLoOB) - 1) / (Math.exp(2 * zLoOB) + 1);
  const corrHiOB = (Math.exp(2 * zHiOB) - 1) / (Math.exp(2 * zHiOB) + 1);

  console.log(`\n    OB-aligned vs Win correlation: r=${corrOB.toFixed(4)}, 95% CI [${corrLoOB.toFixed(4)}, ${corrHiOB.toFixed(4)}]`);

  // BoS alignment correlation
  const bosAlignedBinary = obResults.map(r => r.bosAligned ? 1 : 0);
  const meanBOS = bosAlignedBinary.reduce((s, x) => s + x, 0) / n;
  const numeratorBOS = bosAlignedBinary.reduce((s, x, i) => s + (x - meanBOS) * (winBinary[i] - meanWin), 0);
  const denomBOS = Math.sqrt(bosAlignedBinary.reduce((s, x) => s + (x - meanBOS) ** 2, 0));
  const corrBOS = denomBOS > 0 && denomWin > 0 ? numeratorBOS / (denomBOS * denomWin) : 0;
  const zBOS = 0.5 * Math.log((1 + corrBOS) / (1 - corrBOS));
  const zLoBOS = zBOS - 1.96 * seOB;
  const zHiBOS = zBOS + 1.96 * seOB;
  const corrLoBOS = (Math.exp(2 * zLoBOS) - 1) / (Math.exp(2 * zLoBOS) + 1);
  const corrHiBOS = (Math.exp(2 * zHiBOS) - 1) / (Math.exp(2 * zHiBOS) + 1);

  console.log(`    BoS-aligned vs Win correlation: r=${corrBOS.toFixed(4)}, 95% CI [${corrLoBOS.toFixed(4)}, ${corrHiBOS.toFixed(4)}]`);

  // 108(c): Ship decision
  console.log(`\n  108(c) — SHIP DECISION (pre-registered gate: r >= +0.3 with CI excluding zero):`);
  if (corrOB >= 0.3 && corrLoOB > 0) {
    console.log(`    OB-aligned PASSES gate (r=${corrOB.toFixed(4)}, CI [${corrLoOB.toFixed(4)}, ${corrHiOB.toFixed(4)}]). Wire into scoring.`);
  } else {
    console.log(`    OB-aligned does NOT pass gate (r=${corrOB.toFixed(4)}, CI [${corrLoOB.toFixed(4)}, ${corrHiOB.toFixed(4)}]). Do NOT wire.`);
  }
  if (corrBOS >= 0.3 && corrLoBOS > 0) {
    console.log(`    BoS-aligned PASSES gate (r=${corrBOS.toFixed(4)}, CI [${corrLoBOS.toFixed(4)}, ${corrHiBOS.toFixed(4)}]). Wire into scoring.`);
  } else {
    console.log(`    BoS-aligned does NOT pass gate (r=${corrBOS.toFixed(4)}, CI [${corrLoBOS.toFixed(4)}, ${corrHiBOS.toFixed(4)}]). Do NOT wire.`);
  }

  console.log(`\n${line}\nDONE\n${line}\n`);
}

main().catch((err: unknown) => {
  console.error('item104_108 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
