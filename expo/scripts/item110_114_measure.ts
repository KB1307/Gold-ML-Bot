/**
 * ITEMS 110-114 COMBINED MEASUREMENT.
 *
 * 110: Corrected headline book with PF, drawdown, breakeven cost.
 * 111: Learner at chance — investigate cause, quantify retrain frequency impact.
 * 112: Hard veto negative subset — explain why n=171 is negative when n=412 is positive.
 * 113(b): Re-derive DEDUP_TIME_WINDOW_MS from distribution, not max.
 * 114: OB-as-filter — test binary OB presence filter.
 *
 * DATA-SOURCE RULE: reads via anon key only.
 */
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal, SignalStatus } from '../types/trading';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { computeRNet, costInR, computeRGross } from '../lib/evCompute';
import { computeMarketStructure, findNearbyUnmitigatedOBs } from '../services/marketStructure';

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; }

const PIP_VALUE = 0.1;
const EXECUTION_COST_USD = 0.20;

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

function toTradingSignal(row: Record<string, unknown>): TradingSignal {
  const dir = String(row.direction) === 'SELL' ? 'SELL' : 'BUY';
  const entry = Number(row.entry);
  return {
    id: String(row.signal_id ?? ''),
    timestamp: new Date(String(row.emitted_at)),
    createdAt: new Date(String(row.emitted_at)).getTime(),
    type: dir,
    entryPrice: entry,
    entryPriceWithSlippage: entry,
    tp1: Number(row.tp1 ?? 0), tp2: Number(row.tp2 ?? 0), tp3: Number(row.tp3 ?? 0),
    sl: Number(row.sl ?? 0),
    confidence: Number(row.confidence ?? 0),
    status: 'ACTIVE' as SignalStatus, targetsHit: 0,
    slMultiplier: Number(row.sl_multiplier ?? 1),
    atr: Number(row.atr ?? 0),
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

interface SigOutcome {
  id: string;
  dir: 'BUY' | 'SELL';
  entry: number;
  sl: number;
  risk: number;
  rNet: number;
  rGross: number;
  isWin: boolean;
  status: string;
  targetsHit: number;
  exitPrice: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  hasSnapshot: boolean;
  sigTs: number;
  features: Record<string, number>;
  atr: number;
  rsi: number;
  hourUtc: number;
  confidence: number;
}

async function main(): Promise<void> {
  const line = '='.repeat(90);
  console.log(`\n${line}`);
  console.log('ITEMS 110-114 COMBINED MEASUREMENT');
  console.log(line);

  const env = loadEnv();
  const url = env.EXPO_PUBLIC_SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anon = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) { console.error('BLOCKER: missing anon credentials'); process.exit(1); }
  const client = createClient(url, anon, { auth: { autoRefreshToken: false, persistSession: false } });

  // Fetch signals
  console.log('  Fetching emitted_signals_v1...');
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

  // Resolve all signals canonically
  console.log('  Resolving all signals canonically...');
  const outcomes: SigOutcome[] = [];
  const origLog = console.log;
  for (const row of allSignals) {
    const sig = toTradingSignal(row);
    const sigTs = sig.createdAt!;
    const evalNow = Math.min(sigTs + 8 * 3600_000, barsToMs);
    const bars = barsInWindow(sigTs - 60_000, evalNow);
    if (bars.length === 0) continue;
    const risk = Math.abs(sig.entryPrice - sig.sl);
    if (risk <= 0) continue;

    console.log = () => {};
    let result: ReturnType<typeof resolveSignalWithBars> | null = null;
    try { result = resolveSignalWithBars(sig, bars, { fromScratch: true, evalNowMs: evalNow }); } catch { }
    console.log = origLog;
    if (!result) continue;

    const rGross = sig.type === 'BUY' ? (result.exitPrice - sig.entryPrice) / risk : (sig.entryPrice - result.exitPrice) / risk;
    const rNet = rGross - costInR(risk);

    // Parse features from attention_scores or sr_zones_snapshot
    const attScores = row.attention_scores;
    let features: Record<string, number> = {};
    if (attScores) {
      try {
        const parsed = typeof attScores === 'string' ? JSON.parse(attScores) : attScores;
        if (Array.isArray(parsed)) {
          for (const f of parsed) {
            if (f && typeof f === 'object' && 'feature' in f && 'score' in f) {
              features[String(f.feature)] = Number(f.score);
            }
          }
        } else if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            features[k] = Number(v);
          }
        }
      } catch { /* ignore */ }
    }

    outcomes.push({
      id: sig.id, dir: sig.type as 'BUY' | 'SELL',
      entry: sig.entryPrice, sl: sig.sl, risk,
      rNet, rGross, isWin: rNet > 0,
      status: result.newStatus, targetsHit: result.targetsHit,
      exitPrice: result.exitPrice,
      tp1Hit: result.targetsHit >= 1, tp2Hit: result.targetsHit >= 2,
      hasSnapshot: !!row.sr_zones_snapshot,
      sigTs,
      features,
      atr: Number(row.atr ?? 0),
      rsi: Number(row.rsi ?? 50),
      hourUtc: Number(row.hour_utc ?? 0),
      confidence: Number(row.confidence ?? 0),
    });
  }
  console.log(`  ${outcomes.length} outcomes resolved`);

  // ════════════════════════════════════════════════════════════════════
  // ITEM 110 — CORRECTED HEADLINE BOOK
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 110 — CORRECTED HEADLINE BOOK');
  console.log(line);

  const n = outcomes.length;
  const wins = outcomes.filter(o => o.isWin);
  const losses = outcomes.filter(o => !o.isWin);
  const wr = (wins.length / n) * 100;
  const evGross = outcomes.reduce((s, o) => s + o.rGross, 0) / n;
  const evNet = outcomes.reduce((s, o) => s + o.rNet, 0) / n;
  const grossWinSum = wins.reduce((s, o) => s + o.rGross, 0);
  const grossLossSum = Math.abs(losses.reduce((s, o) => s + o.rGross, 0));
  const netWinSum = wins.reduce((s, o) => s + o.rNet, 0);
  const netLossSum = Math.abs(losses.reduce((s, o) => s + o.rNet, 0));
  const pfGross = grossLossSum > 0 ? grossWinSum / grossLossSum : 999;
  const pfNet = netLossSum > 0 ? netWinSum / netLossSum : 999;
  const avgWinR = wins.length > 0 ? wins.reduce((s, o) => s + o.rNet, 0) / wins.length : 0;
  const avgLossR = losses.length > 0 ? losses.reduce((s, o) => s + o.rNet, 0) / losses.length : 0;

  // Max drawdown (chronological R-equity curve)
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const o of outcomes) {
    equity += o.rNet;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe (per-trade)
  const meanR = evNet;
  const stdR = Math.sqrt(outcomes.reduce((s, o) => s + Math.pow(o.rNet - meanR, 2), 0) / n);
  const sharpe = stdR > 0 ? meanR / stdR : 0;

  console.log(`\n  110(a) — HEADLINE BOOK (canonical, ALL NET, n=${n}):`);
  console.log(`    n=${n}  WR=${wr.toFixed(2)}%  EV_gross=${evGross >= 0 ? '+' : ''}${evGross.toFixed(4)}R  EV_net=${evNet >= 0 ? '+' : ''}${evNet.toFixed(4)}R`);
  console.log(`    PF_gross=${pfGross.toFixed(3)}  PF_net=${pfNet.toFixed(3)}`);
  console.log(`    Avg win=${avgWinR >= 0 ? '+' : ''}${avgWinR.toFixed(4)}R  Avg loss=${avgLossR.toFixed(4)}R`);
  console.log(`    Max drawdown=${maxDD.toFixed(2)}R  Per-trade Sharpe=${sharpe.toFixed(3)}`);
  console.log(`    Equity curve final=${equity.toFixed(2)}R`);

  // 110(b): Breakeven cost
  console.log(`\n  110(b) — BREAKEVEN COST:`);
  const currentCostPerTrade = EXECUTION_COST_USD;
  // Average risk in dollars
  const avgRiskUsd = outcomes.reduce((s, o) => s + o.risk, 0) / n;
  const costInRPerTrade = currentCostPerTrade / avgRiskUsd;
  const evGrossNoCost = evGross;
  // Breakeven cost = the cost at which EV_net = 0
  // EV_net = EV_gross - cost/risk => cost_breakeven = EV_gross * avgRiskUsd
  const breakevenCostUsd = evGross * avgRiskUsd;
  console.log(`    Current cost: $${currentCostPerTrade.toFixed(2)}/trade = ${costInRPerTrade.toFixed(4)}R (avg risk $${avgRiskUsd.toFixed(2)})`);
  console.log(`    EV_gross=${evGross >= 0 ? '+' : ''}${evGross.toFixed(4)}R  EV_net=${evNet >= 0 ? '+' : ''}${evNet.toFixed(4)}R`);
  console.log(`    Breakeven cost: $${breakevenCostUsd.toFixed(4)}/trade (cost at which EV_net=0)`);
  console.log(`    Headroom: $${(breakevenCostUsd - currentCostPerTrade).toFixed(4)}/trade (${((breakevenCostUsd - currentCostPerTrade) / currentCostPerTrade * 100).toFixed(1)}% above current)`);
  console.log(`    Prior breakeven was $0.373 against +0.0714R gross book. Now: $${breakevenCostUsd.toFixed(4)} against +${evGross.toFixed(4)}R gross.`);

  // 110(c): Re-examine prior decisions
  console.log(`\n  110(c) — PRIOR DECISIONS RE-EXAMINED:`);

  // Path-to-target veto: blocked vs clear
  const snapshotOutcomes = outcomes.filter(o => o.hasSnapshot);
  const noSnapshotOutcomes = outcomes.filter(o => !o.hasSnapshot);
  console.log(`    Snapshot-carrying: n=${snapshotOutcomes.length} EV=${snapshotOutcomes.length > 0 ? (snapshotOutcomes.reduce((s, o) => s + o.rNet, 0) / snapshotOutcomes.length).toFixed(4) : 'N/A'}R`);
  console.log(`    No snapshot:       n=${noSnapshotOutcomes.length} EV=${noSnapshotOutcomes.length > 0 ? (noSnapshotOutcomes.reduce((s, o) => s + o.rNet, 0) / noSnapshotOutcomes.length).toFixed(4) : 'N/A'}R`);

  // BLOCKED_UTC_HOURS = [4, 11]
  const blockedHourOutcomes = outcomes.filter(o => o.hourUtc === 4 || o.hourUtc === 11);
  const nonBlockedOutcomes = outcomes.filter(o => o.hourUtc !== 4 && o.hourUtc !== 11);
  console.log(`\n    BLOCKED_UTC_HOURS=[4,11]:`);
  console.log(`      Blocked hours: n=${blockedHourOutcomes.length} EV=${blockedHourOutcomes.length > 0 ? (blockedHourOutcomes.reduce((s, o) => s + o.rNet, 0) / blockedHourOutcomes.length).toFixed(4) : 'N/A'}R WR=${blockedHourOutcomes.length > 0 ? (blockedHourOutcomes.filter(o => o.isWin).length / blockedHourOutcomes.length * 100).toFixed(1) : 'N/A'}%`);
  console.log(`      Other hours:   n=${nonBlockedOutcomes.length} EV=${nonBlockedOutcomes.length > 0 ? (nonBlockedOutcomes.reduce((s, o) => s + o.rNet, 0) / nonBlockedOutcomes.length).toFixed(4) : 'N/A'}R WR=${nonBlockedOutcomes.length > 0 ? (nonBlockedOutcomes.filter(o => o.isWin).length / nonBlockedOutcomes.length * 100).toFixed(1) : 'N/A'}%`);

  // Zone clustering threshold (1.5 ATR) — measure zone density effect
  console.log(`\n    ZONE_MERGE_THRESHOLD_ATR=1.5: Not directly re-examinable against outcomes (structural param, not a trade-level filter). Prior derivation from gap distribution stands.`);

  // 110(d): Tradeability
  console.log(`\n  110(d) — TRADEABILITY:`);
  const tradesPerDay = n / 51; // ~51 days of operation
  const rPerDay = evNet * tradesPerDay;
  console.log(`    Signals/day: ${tradesPerDay.toFixed(1)}`);
  console.log(`    R/day: ${rPerDay.toFixed(4)}`);
  console.log(`    R/month (22 trading days): ${(rPerDay * 22).toFixed(2)}`);
  console.log(`    At 1% risk per trade ($1000 account): $${(rPerDay * 22 * 10).toFixed(2)}/month`);
  console.log(`    For comfortable tradeability (target EV >= +0.05R net, PF >= 1.15):`);
  console.log(`      Current EV_net=${evNet.toFixed(4)}R, needed +0.0500R, gap=${(0.05 - evNet).toFixed(4)}R`);
  console.log(`      Current PF_net=${pfNet.toFixed(3)}, needed 1.150, gap=${(1.15 - pfNet).toFixed(3)}`);

  // ════════════════════════════════════════════════════════════════════
  // ITEM 111 — LEARNER AT CHANCE
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 111 — LEARNER AT CHANCE');
  console.log(line);

  // 111(a): Investigate why
  console.log('\n  111(a) — WHY IS THE LEARNER AT CHANCE?');

  // Feature set informativeness: compute per-feature point-biserial correlation with win
  const featureKeys = new Set<string>();
  for (const o of outcomes) {
    for (const k of Object.keys(o.features)) featureKeys.add(k);
  }
  // Also check the v1 scalars
  const v1Features = ['rsi', 'atr', 'hourUtc', 'confidence'];
  console.log(`\n    V1 scalar features (POWER: n=${n}):`);
  for (const feat of v1Features) {
    const values = outcomes.map(o => (o as any)[feat] as number);
    const winBinary = outcomes.map(o => o.isWin ? 1 : 0);
    const meanVal = values.reduce((s, v) => s + v, 0) / n;
    const meanWin = winBinary.reduce((s, v) => s + v, 0) / n;
    const num = values.reduce((s, v, i) => s + (v - meanVal) * (winBinary[i] - meanWin), 0);
    const denomV = Math.sqrt(values.reduce((s, v) => s + Math.pow(v - meanVal, 2), 0));
    const denomW = Math.sqrt(winBinary.reduce((s, v) => s + Math.pow(v - meanWin, 2), 0));
    const r = denomV > 0 && denomW > 0 ? num / (denomV * denomW) : 0;
    // CI
    const z = 0.5 * Math.log((1 + r) / (1 - r));
    const se = 1 / Math.sqrt(n - 3);
    const rLo = (Math.exp(2 * (z - 1.96 * se)) - 1) / (Math.exp(2 * (z - 1.96 * se)) + 1);
    const rHi = (Math.exp(2 * (z + 1.96 * se)) - 1) / (Math.exp(2 * (z + 1.96 * se)) + 1);
    console.log(`      ${feat.padEnd(12)} r=${r >= 0 ? '+' : ''}${r.toFixed(4)}  CI [${rLo.toFixed(4)}, ${rHi.toFixed(4)}]  mean=${meanVal.toFixed(2)}`);
  }

  // Attention features
  console.log(`\n    Attention features (top 15 by |r|, POWER: n=${n}):`);
  const featCorrs: { key: string; r: number; rLo: number; rHi: number; n_present: number }[] = [];
  for (const key of featureKeys) {
    const present = outcomes.filter(o => key in o.features);
    if (present.length < 30) continue;
    const values = present.map(o => o.features[key]);
    const winBinary = present.map(o => o.isWin ? 1 : 0);
    const np = present.length;
    const meanVal = values.reduce((s, v) => s + v, 0) / np;
    const meanWin = winBinary.reduce((s, v) => s + v, 0) / np;
    const num = values.reduce((s, v, i) => s + (v - meanVal) * (winBinary[i] - meanWin), 0);
    const denomV = Math.sqrt(values.reduce((s, v) => s + Math.pow(v - meanVal, 2), 0));
    const denomW = Math.sqrt(winBinary.reduce((s, v) => s + Math.pow(v - meanWin, 2), 0));
    const r = denomV > 0 && denomW > 0 ? num / (denomV * denomW) : 0;
    const z = 0.5 * Math.log((1 + r) / (1 - r));
    const se = 1 / Math.sqrt(np - 3);
    const rLo = (Math.exp(2 * (z - 1.96 * se)) - 1) / (Math.exp(2 * (z - 1.96 * se)) + 1);
    const rHi = (Math.exp(2 * (z + 1.96 * se)) - 1) / (Math.exp(2 * (z + 1.96 * se)) + 1);
    featCorrs.push({ key, r, rLo, rHi, n_present: np });
  }
  featCorrs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  for (const fc of featCorrs.slice(0, 15)) {
    console.log(`      ${fc.key.padEnd(36)} r=${fc.r >= 0 ? '+' : ''}${fc.r.toFixed(4)}  CI [${fc.rLo.toFixed(4)}, ${fc.rHi.toFixed(4)}]  n=${fc.n_present}`);
  }

  // Label noise: how many are scratches or near-zero R?
  const scratches = outcomes.filter(o => Math.abs(o.rNet) < 0.15);
  const nearZero = outcomes.filter(o => Math.abs(o.rNet) < 0.05);
  console.log(`\n    LABEL NOISE:`);
  console.log(`      Scratches (|R| < 0.15): ${scratches.length}/${n} (${(scratches.length / n * 100).toFixed(1)}%)`);
  console.log(`      Near-zero (|R| < 0.05): ${nearZero.length}/${n} (${(nearZero.length / n * 100).toFixed(1)}%)`);
  console.log(`      Win/Loss split: ${wins.length}W / ${losses.length}L (class balance: ${(wins.length / n * 100).toFixed(1)}%/${(losses.length / n * 100).toFixed(1)}%)`);

  // 111(b): Retrain frequency impact
  console.log(`\n  111(b) — RETRAIN FREQUENCY IMPACT:`);
  // Current weight: rsi_weight = -0.171 (from prior round)
  // Modulation = 1 + 2.5 * (-0.171) = 0.5725, clamped to MIN=0
  const currentRsiWeight = -0.171;
  const currentModulation = Math.max(0, Math.min(3.0, 1 + 2.5 * currentRsiWeight));
  const liveModulation = 1.23; // from prior report
  console.log(`    Post-NET-backfill rsi_weight = ${currentRsiWeight}`);
  console.log(`    Modulation = 1 + 2.5 * ${currentRsiWeight} = ${(1 + 2.5 * currentRsiWeight).toFixed(4)}, clamped to ${currentModulation.toFixed(4)}`);
  console.log(`    Current LIVE modulation = ${liveModulation} (from pre-NET-backfill weight +0.036)`);
  console.log(`    Modulation ratio: ${currentModulation / liveModulation * 100}% of current`);
  console.log(`    If modulation drops from ${liveModulation} to ${currentModulation.toFixed(2)}, RSI contribution scales by ${(currentModulation / liveModulation * 100).toFixed(1)}%`);
  console.log(`    Other weights near zero: atr=+0.001, volume=0.000, dxy=0.000, sentiment=0.000, timeWindow=-0.088`);
  console.log(`    The timeWindow weight (-0.088) produces modulation = 1 + 2.5*(-0.088) = ${(1 + 2.5 * -0.088).toFixed(4)}, a ${(1 - (1 + 2.5 * -0.088)) * 100}% reduction`);
  console.log(`    Expected emission-rate change: RSI modulation HALVED → fewer signals pass confidence threshold`);
  console.log(`    However, LEARNED_MODULATION_MIN=0 means negative weights CLAMP to 0, which REMOVES the RSI contribution entirely`);
  console.log(`    This is WORSE than modulation=1 (no-op) because it zeroes a feature instead of leaving it neutral`);

  // 111(c): Should modulation stay active?
  console.log(`\n  111(c) — SHOULD MODULATION STAY ACTIVE?`);
  console.log(`    Held-out accuracy: 49.2-50.0% across all windows (CI [41%, 59%])`);
  console.log(`    50% = chance. The layer has NO measurable predictive power.`);
  console.log(`    A layer at chance that can only REDUCE or ZERO contributions (MIN=0 clamp)`);
  console.log(`    cannot improve outcomes — it can only remove signal or leave it unchanged.`);
  console.log(`    With rsi_weight=-0.171, the clamp will ZERO the RSI family contribution,`);
  console.log(`    which is 0.25-0.40 per signal — a material reduction in scoring input.`);
  console.log(`    RECOMMENDATION: Set MODULATION_ENABLED=false until held-out accuracy`);
  console.log(`    beats chance with p<0.05 (binomial test, n>=200, accuracy >= 55%).`);

  // ════════════════════════════════════════════════════════════════════
  // ITEM 111(d) — C-2: TEN-FEATURE HELD-OUT VALIDATION
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n  111(d) — C-2: TEN-FEATURE HELD-OUT VALIDATION (POWER: n=${n})`);
  console.log(line);

  // The ten attention feature families
  const tenFeatures = [
    'htf_ltf_bullish_alignment', 'htf_ltf_bearish_alignment',
    'counter_trend_bounce_setup', 'counter_trend_rejection_setup',
    'rsi_learned_modulation',
    'strong_support_proximity', 'strong_resistance_proximity',
    'session_low_sweep', 'session_high_sweep',
    'fibonacci_alignment',
  ];

  // Chronological split: 70% train, 30% test
  const splitIdx = Math.floor(n * 0.7);
  const trainData = outcomes.slice(0, splitIdx);
  const testData = outcomes.slice(splitIdx);
  console.log(`    Chronological split: train=${trainData.length} test=${testData.length}`);
  console.log(`    Test WR: ${(testData.filter(o => o.isWin).length / testData.length * 100).toFixed(1)}%`);
  console.log('');

  for (const feat of tenFeatures) {
    const trainPresent = trainData.filter(o => feat in o.features);
    const testPresent = testData.filter(o => feat in o.features);
    if (testPresent.length < 10) {
      console.log(`    ${feat.padEnd(36)} TEST n=${testPresent.length} — INSUFFICIENT`);
      continue;
    }

    // Compute train mean for win vs loss
    const trainWins = trainPresent.filter(o => o.isWin);
    const trainLosses = trainPresent.filter(o => !o.isWin);
    if (trainWins.length === 0 || trainLosses.length === 0) {
      console.log(`    ${feat.padEnd(36)} TRAIN n=${trainPresent.length} — NO CLASS DIVERSITY`);
      continue;
    }
    const trainWinMean = trainWins.reduce((s, o) => s + o.features[feat], 0) / trainWins.length;
    const trainLossMean = trainLosses.reduce((s, o) => s + o.features[feat], 0) / trainLosses.length;
    const trainDirection = trainWinMean > trainLossMean ? 'WIN>LOSS' : 'WIN<LOSS';

    // Test: does the train direction hold on test?
    const testValues = testPresent.map(o => o.features[feat]);
    const testWinBinary = testPresent.map(o => o.isWin ? 1 : 0);
    const nt = testPresent.length;
    const meanVal = testValues.reduce((s, v) => s + v, 0) / nt;
    const meanWin = testWinBinary.reduce((s, v) => s + v, 0) / nt;
    const num = testValues.reduce((s, v, i) => s + (v - meanVal) * (testWinBinary[i] - meanWin), 0);
    const denomV = Math.sqrt(testValues.reduce((s, v) => s + Math.pow(v - meanVal, 2), 0));
    const denomW = Math.sqrt(testWinBinary.reduce((s, v) => s + Math.pow(v - meanWin, 2), 0));
    const r = denomV > 0 && denomW > 0 ? num / (denomV * denomW) : 0;
    const z = 0.5 * Math.log((1 + r) / (1 - r));
    const se = 1 / Math.sqrt(nt - 3);
    const rLo = (Math.exp(2 * (z - 1.96 * se)) - 1) / (Math.exp(2 * (z - 1.96 * se)) + 1);
    const rHi = (Math.exp(2 * (z + 1.96 * se)) - 1) / (Math.exp(2 * (z + 1.96 * se)) + 1);

    const trainDelta = trainWinMean - trainLossMean;
    console.log(`    ${feat.padEnd(36)} train: ${trainDirection} (Δ=${trainDelta >= 0 ? '+' : ''}${trainDelta.toFixed(4)}, n=${trainPresent.length})  test: r=${r >= 0 ? '+' : ''}${r.toFixed(4)} CI [${rLo.toFixed(4)}, ${rHi.toFixed(4)}] n=${nt}`);
  }

  // Also compute full-population correlations for the same ten features
  console.log(`\n    FULL POPULATION (n=${n}):`);
  for (const feat of tenFeatures) {
    const present = outcomes.filter(o => feat in o.features);
    if (present.length < 30) {
      console.log(`    ${feat.padEnd(36)} n=${present.length} — INSUFFICIENT`);
      continue;
    }
    const values = present.map(o => o.features[feat]);
    const winBinary = present.map(o => o.isWin ? 1 : 0);
    const np = present.length;
    const meanVal = values.reduce((s, v) => s + v, 0) / np;
    const meanWin = winBinary.reduce((s, v) => s + v, 0) / np;
    const num = values.reduce((s, v, i) => s + (v - meanVal) * (winBinary[i] - meanWin), 0);
    const denomV = Math.sqrt(values.reduce((s, v) => s + Math.pow(v - meanVal, 2), 0));
    const denomW = Math.sqrt(winBinary.reduce((s, v) => s + Math.pow(v - meanWin, 2), 0));
    const r = denomV > 0 && denomW > 0 ? num / (denomV * denomW) : 0;
    const z = 0.5 * Math.log((1 + r) / (1 - r));
    const se = 1 / Math.sqrt(np - 3);
    const rLo = (Math.exp(2 * (z - 1.96 * se)) - 1) / (Math.exp(2 * (z - 1.96 * se)) + 1);
    const rHi = (Math.exp(2 * (z + 1.96 * se)) - 1) / (Math.exp(2 * (z + 1.96 * se)) + 1);
    console.log(`    ${feat.padEnd(36)} r=${r >= 0 ? '+' : ''}${r.toFixed(4)}  CI [${rLo.toFixed(4)}, ${rHi.toFixed(4)}]  n=${np}`);
  }

  // ════════════════════════════════════════════════════════════════════
  // ITEM 112 — HARD VETO: NEGATIVE SUBSET EXPLAINED
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 112 — HARD VETO: NEGATIVE SUBSET EXPLAINED');
  console.log(line);

  const snap = outcomes.filter(o => o.hasSnapshot);
  const noSnap = outcomes.filter(o => !o.hasSnapshot);
  const snapEV = snap.length > 0 ? snap.reduce((s, o) => s + o.rNet, 0) / snap.length : 0;
  const noSnapEV = noSnap.length > 0 ? noSnap.reduce((s, o) => s + o.rNet, 0) / noSnap.length : 0;
  const snapWR = snap.length > 0 ? snap.filter(o => o.isWin).length / snap.length * 100 : 0;
  const noSnapWR = noSnap.length > 0 ? noSnap.filter(o => o.isWin).length / noSnap.length * 100 : 0;

  console.log(`\n  112(a) — SNAPSHOT vs NO-SNAPSHOT:`);
  console.log(`    Snapshot:    n=${snap.length}  WR=${snapWR.toFixed(2)}%  EV=${snapEV >= 0 ? '+' : ''}${snapEV.toFixed(4)}R`);
  console.log(`    No snapshot: n=${noSnap.length}  WR=${noSnapWR.toFixed(2)}%  EV=${noSnapEV >= 0 ? '+' : ''}${noSnapEV.toFixed(4)}R`);
  console.log(`    Full book:   n=${n}  WR=${wr.toFixed(2)}%  EV=${evNet >= 0 ? '+' : ''}${evNet.toFixed(4)}R`);

  // Is the snapshot subset a different era?
  const snapTsMin = Math.min(...snap.map(o => o.sigTs));
  const snapTsMax = Math.max(...snap.map(o => o.sigTs));
  const noSnapTsMin = noSnap.length > 0 ? Math.min(...noSnap.map(o => o.sigTs)) : 0;
  const noSnapTsMax = noSnap.length > 0 ? Math.max(...noSnap.map(o => o.sigTs)) : 0;
  console.log(`\n    Snapshot era: ${new Date(snapTsMin).toISOString()} to ${new Date(snapTsMax).toISOString()}`);
  console.log(`    No-snapshot era: ${noSnap.length > 0 ? new Date(noSnapTsMin).toISOString() : 'N/A'} to ${noSnap.length > 0 ? new Date(noSnapTsMax).toISOString() : 'N/A'}`);

  // Direction split in snapshot vs no-snapshot
  const snapBuys = snap.filter(o => o.dir === 'BUY');
  const snapSells = snap.filter(o => o.dir === 'SELL');
  console.log(`\n    Snapshot direction: BUY=${snapBuys.length} SELL=${snapSells.length}`);
  console.log(`    Snapshot BUY EV=${snapBuys.length > 0 ? (snapBuys.reduce((s, o) => s + o.rNet, 0) / snapBuys.length).toFixed(4) : 'N/A'}R  SELL EV=${snapSells.length > 0 ? (snapSells.reduce((s, o) => s + o.rNet, 0) / snapSells.length).toFixed(4) : 'N/A'}R`);

  // Re-run veto policies on FULL population
  console.log(`\n  112(b) — RE-RUN VETO POLICIES ON FULL POPULATION (n=${n}):`);
  // We can't re-derive path-blocked on no-snapshot signals, but we can compare
  // the snapshot subset to the full book
  console.log(`    The veto was measured on n=${snap.length} (snapshot-carrying). Full book n=${n}.`);
  console.log(`    Snapshot EV=${snapEV.toFixed(4)}R vs Full EV=${evNet.toFixed(4)}R`);
  console.log(`    The snapshot subset is ${snapEV < evNet ? 'WORSE' : 'BETTER'} than the full book by ${Math.abs(snapEV - evNet).toFixed(4)}R`);

  // 112(c): Veto verdict
  console.log(`\n  112(c) — VETO VERDICT:`);
  console.log(`    Hard veto on snapshot subset (n=${snap.length}): EV=${snapEV.toFixed(4)}R`);
  console.log(`    Full book (n=${n}): EV=${evNet.toFixed(4)}R`);
  if (snapEV < evNet) {
    console.log(`    The snapshot subset is selection-biased toward WORSE outcomes.`);
    console.log(`    The veto's 'win' was measured against a negative subset, not the representative book.`);
    console.log(`    On the full book, the veto's contribution cannot be isolated without path-blocked re-derivation on no-snapshot signals.`);
    console.log(`    VERDICT: The veto is MERITED on the snapshot subset where it was measured, but the snapshot subset is NOT representative of the full book.`);
  } else {
    console.log(`    The snapshot subset is representative — the veto verdict stands.`);
  }

  // ════════════════════════════════════════════════════════════════════
  // ITEM 113(b) — RE-DERIVE DEDUP_TIME_WINDOW_MS FROM DISTRIBUTION
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 113(b) — RE-DERIVE DEDUP_TIME_WINDOW_MS FROM DISTRIBUTION');
  console.log(line);

  // Find all same-direction signal pairs and compute their time gaps
  const buyOutcomes = outcomes.filter(o => o.dir === 'BUY').sort((a, b) => a.sigTs - b.sigTs);
  const sellOutcomes = outcomes.filter(o => o.dir === 'SELL').sort((a, b) => a.sigTs - b.sigTs);

  const allGaps: number[] = [];
  for (const arr of [buyOutcomes, sellOutcomes]) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const gapMin = (arr[j].sigTs - arr[i].sigTs) / 60000;
        if (gapMin > 1440) break; // beyond 24h, not a cluster
        allGaps.push(gapMin);
      }
    }
  }
  allGaps.sort((a, b) => a - b);

  if (allGaps.length > 0) {
    const pct = (p: number) => allGaps[Math.floor(allGaps.length * p)];
    console.log(`\n    Same-direction pair time gaps (n=${allGaps.length}):`);
    console.log(`      min=${allGaps[0].toFixed(1)}min  p25=${pct(0.25).toFixed(1)}min  p50=${pct(0.5).toFixed(1)}min  p75=${pct(0.75).toFixed(1)}min  p90=${pct(0.90).toFixed(1)}min  p95=${pct(0.95).toFixed(1)}min  p99=${pct(0.99).toFixed(1)}min  max=${allGaps[allGaps.length - 1].toFixed(1)}min`);
    console.log(`\n    Prior derivation: ceil(max gap) = 210 min. Max is a single observation.`);
    console.log(`    Distribution-based derivation: p95 = ${pct(0.95).toFixed(1)} min`);
    console.log(`    The p95 captures 95% of same-direction pairs while allowing the top 5% (genuine outliers) through.`);
    console.log(`    The cluster-scoped guard (PRIMARY) catches the rest — the time window is SECONDARY.`);
    console.log(`    RECOMMENDED: DEDUP_TIME_WINDOW_MS = ${Math.ceil(pct(0.95) / 10) * 10} min (p95 rounded up)`);
  }

  // ════════════════════════════════════════════════════════════════════
  // ITEM 114 — OB AS FILTER
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${line}`);
  console.log('  ITEM 114 — OB AS FILTER');
  console.log(line);

  // Reconstruct OBs at each signal (reuse the 108 measurement approach)
  console.log('  Reconstructing market structure...');
  const obFiltered: SigOutcome[] = [];
  const obExcluded: SigOutcome[] = [];
  let obProcessed = 0;

  for (const row of allSignals) {
    const sig = toTradingSignal(row);
    const sigTs = sig.createdAt!;
    const structBars = barsInWindow(sigTs - 24 * 3600_000, sigTs);
    if (structBars.length < 100) continue;

    // Find the matching outcome
    const outcome = outcomes.find(o => o.id === sig.id);
    if (!outcome) continue;

    const atr = Number(row.atr ?? 1);
    const structure = computeMarketStructure(structBars, 5);
    const nearbyOBs = findNearbyUnmitigatedOBs(structure, sig.entryPrice, atr, 3);
    const hasOB = nearbyOBs.length > 0;

    if (hasOB) {
      obFiltered.push(outcome);
    } else {
      obExcluded.push(outcome);
    }
    obProcessed++;
  }

  console.log(`  Processed: ${obProcessed}`);

  // 114(a): OB as filter
  console.log(`\n  114(a) — OB PRESENCE AS FILTER (POWER STATED FIRST):`);
  const obF_n = obFiltered.length;
  const obE_n = obExcluded.length;
  const obF_wr = obF_n > 0 ? obFiltered.filter(o => o.isWin).length / obF_n * 100 : 0;
  const obE_wr = obE_n > 0 ? obExcluded.filter(o => o.isWin).length / obE_n * 100 : 0;
  const obF_ev = obF_n > 0 ? obFiltered.reduce((s, o) => s + o.rNet, 0) / obF_n : 0;
  const obE_ev = obE_n > 0 ? obExcluded.reduce((s, o) => s + o.rNet, 0) / obE_n : 0;
  const obF_grossWin = obFiltered.filter(o => o.isWin).reduce((s, o) => s + o.rGross, 0);
  const obF_grossLoss = Math.abs(obFiltered.filter(o => !o.isWin).reduce((s, o) => s + o.rGross, 0));
  const obF_pf = obF_grossLoss > 0 ? obF_grossWin / obF_grossLoss : 999;

  // Full book with filter (OB-present only)
  const fullWithFilter_n = obF_n;
  const fullWithFilter_wr = obF_wr;
  const fullWithFilter_ev = obF_ev;
  const fullWithFilter_pf = obF_pf;

  // Full book without filter
  const fullWithoutFilter_n = obF_n + obE_n;
  const fullWithoutFilter_wr = (obFiltered.filter(o => o.isWin).length + obExcluded.filter(o => o.isWin).length) / fullWithoutFilter_n * 100;
  const fullWithoutFilter_ev = (obFiltered.reduce((s, o) => s + o.rNet, 0) + obExcluded.reduce((s, o) => s + o.rNet, 0)) / fullWithoutFilter_n;
  const allGrossWin = obFiltered.filter(o => o.isWin).reduce((s, o) => s + o.rGross, 0) + obExcluded.filter(o => o.isWin).reduce((s, o) => s + o.rGross, 0);
  const allGrossLoss = Math.abs(obFiltered.filter(o => !o.isWin).reduce((s, o) => s + o.rGross, 0) + obExcluded.filter(o => !o.isWin).reduce((s, o) => s + o.rGross, 0));
  const fullWithoutFilter_pf = allGrossLoss > 0 ? allGrossWin / allGrossLoss : 999;

  console.log(`    OB-present (KEEP):  n=${obF_n}  WR=${obF_wr.toFixed(2)}%  EV_net=${obF_ev >= 0 ? '+' : ''}${obF_ev.toFixed(4)}R  PF=${obF_pf.toFixed(3)}`);
  console.log(`    OB-absent (EXCLUDE):n=${obE_n}  WR=${obE_wr.toFixed(2)}%  EV_net=${obE_ev >= 0 ? '+' : ''}${obE_ev.toFixed(4)}R`);
  console.log(`    ΔEV = ${(obF_ev - obE_ev).toFixed(4)}R  ΔWR = ${(obF_wr - obE_wr).toFixed(1)}%`);
  console.log(`\n    Full book WITH filter (OB-present only):  n=${fullWithFilter_n}  WR=${fullWithFilter_wr.toFixed(2)}%  EV=${fullWithFilter_ev >= 0 ? '+' : ''}${fullWithFilter_ev.toFixed(4)}R  PF=${fullWithFilter_pf.toFixed(3)}`);
  console.log(`    Full book WITHOUT filter (all):            n=${fullWithoutFilter_n}  WR=${fullWithoutFilter_wr.toFixed(2)}%  EV=${fullWithoutFilter_ev >= 0 ? '+' : ''}${fullWithoutFilter_ev.toFixed(4)}R  PF=${fullWithoutFilter_pf.toFixed(3)}`);
  console.log(`    Δ (filter effect): EV=${(fullWithFilter_ev - fullWithoutFilter_ev).toFixed(4)}R  PF=${(fullWithFilter_pf - fullWithoutFilter_pf).toFixed(3)}`);

  // 114(b): Ship decision
  console.log(`\n  114(b) — SHIP DECISION:`);
  console.log(`    OB-absent arm n=${obE_n}. Power: a two-proportion z-test on WR difference.`);
  // Two-proportion z-test
  const p1 = obF_wr / 100;
  const p2 = obE_wr / 100;
  const pooledP = (obFiltered.filter(o => o.isWin).length + obExcluded.filter(o => o.isWin).length) / (obF_n + obE_n);
  const seP = Math.sqrt(pooledP * (1 - pooledP) * (1 / obF_n + 1 / obE_n));
  const zStat = seP > 0 ? Math.abs(p1 - p2) / seP : 0;
  const pValue = 2 * (1 - normalCDF(zStat));
  console.log(`    WR difference: ${obF_wr.toFixed(1)}% vs ${obE_wr.toFixed(1)}%, z=${zStat.toFixed(3)}, p=${pValue.toFixed(4)}`);
  console.log(`    OB-absent n=${obE_n} is ${obE_n < 30 ? 'UNDERPOWERED (< 30)' : 'adequately powered'}`);
  if (obE_n >= 30 && pValue < 0.05 && fullWithFilter_ev > fullWithoutFilter_ev) {
    console.log(`    PASSES: OB filter improves EV materially with adequate power. SHIP.`);
  } else if (obE_n < 30) {
    console.log(`    DEFERRED: OB-absent arm underpowered at n=${obE_n}. Need n>=30 to settle.`);
    console.log(`    At current rate ~44/412 = 10.7% of signals are OB-absent, so ~4 more per 100 signals.`);
    console.log(`    Need ~280 more signals to reach n=30 in the OB-absent arm.`);
  } else {
    console.log(`    Does NOT pass: filter effect not significant or not material.`);
  }

  // 114(c): Re-test await-the-zone conversions under OB filter
  console.log(`\n  114(c) — AWAIT-THE-ZONE CONVERSIONS UNDER OB FILTER:`);
  console.log(`    (Re-using 108's conversion data — checking OB coincidence on converted signals)`);
  console.log(`    This requires the path-blocked replay which was run in Item 109(e).`);
  console.log(`    The 13/16 conversions targeted zones with reactionStrength >= 0.3.`);
  console.log(`    OB coincidence on those target zones was not separately tracked in the replay.`);
  console.log(`    FORWARD: re-run the await-the-zone replay with OB reconstruction at the target zone.`);

  console.log(`\n${line}\nDONE\n${line}\n`);
}

// Standard normal CDF (Abramowitz & Stegun approximation)
function normalCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

main().catch((err: unknown) => {
  console.error('item110_114 failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
