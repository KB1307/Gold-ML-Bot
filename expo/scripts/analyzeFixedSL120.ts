/**
 * ALTERNATIVE 2 — Fixed 120-pip SL counterfactual (READ-ONLY).
 *
 * Same 164 covered signals, same methodology as Phase R1 / Alternative 1.
 * The difference: SL is a FIXED $12.00 (120 pips) from entry — no zone
 * lookup, no retest wait. Entry stays at the original recorded entry.
 * The 1.4R TP ladder is re-derived off the new $12.00 stop distance.
 * 100% fill by construction (no missed signals).
 *
 * Example: entry 4010 → BUY SL at 3998, SELL SL at 4022.
 *
 * Pre-registered HARD GATE (stated BEFORE running):
 *   The wider fixed SL must improve EV by >= +0.05R per signal over the
 *   +0.0806R baseline AND not reduce net $ below baseline. Because a $12
 *   stop means each loss costs $12 (vs ~$5.10 median original), this is
 *   emphatically NOT a free win — losses are 2.35x more expensive. The
 *   gate measures whether the reduced stop-out FREQUENCY genuinely
 *   outweighs the larger stop-out MAGNITUDE.
 *
 *   Constraint flag: a fixed $12 SL (120 pips) is 2.35x the median
 *   original SL ($5.10) and will routinely exceed the engine's maxSLPips
 *   (90 pips). This is flagged as a scalper-scope concern — TP1 at 84
 *   pips is close to the 100-pip trade target, meaning TP1 alone nearly
 *   captures the full intended move.
 *
 * Reports:
 *   Step 1 — New SL distance vs original (ATR multiples, $, pip count).
 *   Step 2 — Counterfactual outcomes: new WR, PF, EV (in new-R, in $,
 *            and converted to original-R for the gate), net $.
 *   Step 3 — SL_HIT survivor breakdown: of current SL_HIT losers, how
 *            many survive under the $12 SL AND go on to a real TP vs
 *            how many just lose more per trade.
 *   Step 4 — Decision table + HARD GATE verdict + frequency vs magnitude.
 *
 * No engine code is modified. Uses resolveSignalWithBars() against real bars.
 *
 * Usage: bunx tsx expo/scripts/analyzeFixedSL120.ts <path-to-export.txt>
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal } from '@/types/trading';

// ─── Parsing (mirrors analyzeRetestCounterfactual.ts / analyzeZoneSLOuter.ts) ─

interface ParsedZone {
  type: 'SUPPORT' | 'RESISTANCE';
  price: number;
  touches: number;
  reaction: number;
  confluence: number;
  source: string;
  tier: string;
}

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entry: number;
  status: string;
  id: string;
  generatedMs: number;
  entryTime: string;
  confidence: number;
  tp: number[];
  sl: number;
  targetsHit: number;
  exitPrice: number | null;
  exitTime: string | null;
  breakevenReached: boolean;
  slMultiplier: number | null;
  volRegime: string | null;
  atr: number | null;
  features: Record<string, number>;
  zones: ParsedZone[];
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function parseExport(path: string): ParsedSignal[] {
  const raw = readFileSync(path, 'utf8');
  const section1Start = raw.indexOf('SECTION 1');
  const section2Start = raw.indexOf('SECTION 2');
  const body = raw.slice(section1Start, section2Start);
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);

  const signals: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const id = block.match(/id: (\S+)/)?.[1] ?? '';
    const gen = block.match(/generated: (\S+)/)?.[1] ?? '';
    const entryTime = block.match(/entry time: (\S+)/)?.[1] ?? '';
    const conf = num(block.match(/confidence: ([\d.]+)%/)?.[1]) ?? 0;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    const targetsHit = num(block.match(/targets hit: (\d+)/)?.[1]) ?? 0;
    const exitPrice = num(block.match(/exit price: ([\d.]+)/)?.[1]);
    const exitTime = block.match(/exit time: (\S+)/)?.[1] ?? null;
    const slMult = num(block.match(/SL Multiplier: ([\d.]+)x/)?.[1]);
    const regime = block.match(/\((High|Low|Normal) Volatility \| ATR: ([\d.]+)\)/);

    const features: Record<string, number> = {};
    const fullBlock = block.match(/full attention scores \(\d+ total\):\n([\s\S]*?)(?:\n\s{4}\S|\n\n|$)/);
    if (fullBlock) {
      for (const line of fullBlock[1].split('\n')) {
        const m = line.match(/^\s+([A-Z0-9 _/-]+)=(-?[\d.]+)/);
        if (m) features[m[1].trim()] = parseFloat(m[2]);
      }
    }

    const zones: ParsedZone[] = [];
    const zoneRe = /(SUPPORT|RESISTANCE) @ ([\d.]+)\s+touches=(\d+)\s+reaction=(\d+)%\s+confluence=(\d+)\s+source=(\S+)\s+tier=(\S+)/g;
    let zm: RegExpExecArray | null;
    while ((zm = zoneRe.exec(block)) !== null) {
      zones.push({
        type: zm[1] as 'SUPPORT' | 'RESISTANCE',
        price: parseFloat(zm[2]),
        touches: parseInt(zm[3], 10),
        reaction: parseInt(zm[4], 10),
        confluence: parseInt(zm[5], 10),
        source: zm[6],
        tier: zm[7],
      });
    }

    signals.push({
      index: parseInt(head[1], 10),
      direction: head[2] as 'BUY' | 'SELL',
      entry: parseFloat(head[3]),
      status: head[4],
      id,
      generatedMs: new Date(gen).getTime(),
      entryTime,
      confidence: conf,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
      sl: tpm ? parseFloat(tpm[4]) : 0,
      targetsHit,
      exitPrice,
      exitTime,
      breakevenReached: /breakeven reached: yes/.test(block),
      slMultiplier: slMult,
      volRegime: regime?.[1] ?? null,
      atr: num(regime?.[2]),
      features,
      zones,
    });
  }
  return signals;
}

// ─── Supabase bar fetch ─────────────────────────────────────────────────────

interface OhlcBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function fetchSupabaseGoldBars(fromTime: number, toTime: number): Promise<OhlcBar[]> {
  const { data, error } = await supabase
    .from('gold_m1_bars')
    .select('timestamp, open, high, low, close, volume')
    .gte('timestamp', new Date(fromTime).toISOString())
    .lte('timestamp', new Date(toTime).toISOString())
    .order('timestamp', { ascending: true });
  if (error) {
    console.error('   Supabase query failed:', error.message);
    return [];
  }
  return (data ?? []).map((row: any): OhlcBar => ({
    timestamp: new Date(row.timestamp as string).getTime(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const PIP = 0.1;
const SCALPER_TP_R = { tp1: 0.7, tp2: 1.05, tp3: 1.4 } as const;
const SCALPER_TP3_STRETCH_R = 1.5;
const SCALPER_TP3_STRETCH_MAX_R = 1.6;
const COVERAGE_START_MS = new Date('2026-07-13T00:00:00Z').getTime();

/** Fixed SL distance: 120 pips = $12.00 */
const FIXED_SL_DOLLARS = 12.0;
const FIXED_SL_PIPS = FIXED_SL_DOLLARS / PIP; // 120

/** Engine's hard SL cap (pips). 90 pips = $9.0. The fixed $12 SL exceeds this. */
const MAX_SL_PIPS = 90;
const MAX_SL_DOLLARS = MAX_SL_PIPS * PIP;

/** Pre-registered baseline EV from Phase R1 (original-R units). */
const BASELINE_EV_R = 0.0806;
/** Pre-registered gate threshold. */
const GATE_EV_IMPROVEMENT_R = 0.05;

function riskDollars(s: ParsedSignal): number {
  return Math.abs(s.entry - s.sl);
}

function pnlDollars(s: ParsedSignal): number | null {
  if (s.exitPrice === null) return null;
  return s.direction === 'BUY' ? s.exitPrice - s.entry : s.entry - s.exitPrice;
}

function rMultiple(s: ParsedSignal): number | null {
  const p = pnlDollars(s);
  const r = riskDollars(s);
  if (p === null || r <= 0) return null;
  return p / r;
}

function median(arr: number[]): number {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p)));
  return s[idx];
}

function mean(arr: number[]): number {
  if (!arr.length) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Find the next S/R barrier beyond TP3 on the profit side (for TP3 stretch).
 */
function findNextBarrierBeyondTP3(s: ParsedSignal, entry: number, stopDistance: number): number | null {
  const isBuy = s.direction === 'BUY';
  const tp3Price = isBuy
    ? entry + SCALPER_TP_R.tp3 * stopDistance
    : entry - SCALPER_TP_R.tp3 * stopDistance;
  const candidates = s.zones
    .filter((z) => isBuy ? z.type === 'RESISTANCE' && z.price > entry : z.type === 'SUPPORT' && z.price < entry)
    .filter((z) => z.reaction >= 30)
    .filter((z) => isBuy ? z.price > tp3Price : z.price < tp3Price)
    .sort((a, b) => isBuy ? a.price - b.price : b.price - a.price);
  return candidates.length > 0 ? candidates[0].price : null;
}

/**
 * Compute the fixed 120-pip SL price.
 * BUY: entry - $12.00. SELL: entry + $12.00.
 */
function computeFixedSL(s: ParsedSignal): number {
  const isBuy = s.direction === 'BUY';
  return Number((isBuy ? s.entry - FIXED_SL_DOLLARS : s.entry + FIXED_SL_DOLLARS).toFixed(1));
}

/**
 * Build a TradingSignal for the fixed-SL counterfactual.
 * Entry = original entry. SL = entry ± $12.00.
 * TP ladder re-derived off the $12.00 stop distance.
 */
function buildFixedSLSignal(s: ParsedSignal, slPrice: number): TradingSignal {
  const isBuy = s.direction === 'BUY';
  const stopDistance = Math.abs(s.entry - slPrice);

  const nextBarrier = findNextBarrierBeyondTP3(s, s.entry, stopDistance);
  let tp3R: number = SCALPER_TP_R.tp3;
  const barrierDistance = nextBarrier !== null
    ? Math.abs(nextBarrier - s.entry) / stopDistance
    : Infinity;
  if (s.confidence >= 89 && barrierDistance >= 3) tp3R = SCALPER_TP3_STRETCH_MAX_R;
  else if (s.confidence >= 82 && barrierDistance >= 2.5) tp3R = SCALPER_TP3_STRETCH_R;

  const tp1Distance = stopDistance * SCALPER_TP_R.tp1;
  const tp2Distance = stopDistance * SCALPER_TP_R.tp2;
  const tp3Distance = stopDistance * tp3R;

  const tp1 = s.entry + (isBuy ? 1 : -1) * tp1Distance;
  const tp2 = s.entry + (isBuy ? 1 : -1) * tp2Distance;
  const tp3 = s.entry + (isBuy ? 1 : -1) * tp3Distance;

  return {
    id: `fixedsl120_${s.id}`,
    timestamp: new Date(s.generatedMs) as unknown as Date,
    createdAt: s.generatedMs,
    type: isBuy ? 'BUY' : 'SELL',
    entryPrice: s.entry,
    entryPriceWithSlippage: s.entry,
    tp1,
    tp2,
    tp3,
    sl: slPrice,
    slMultiplier: s.slMultiplier ?? 1,
    confidence: s.confidence / 100,
    status: 'ACTIVE',
    targetsHit: 0,
    entryTime: '',
    topFeatures: [],
    riskJustification: 'fixed-sl-120pip-counterfactual',
    breakevenReached: false,
  } as unknown as TradingSignal;
}

/**
 * For a baseline SL_HIT loser, check whether the $12 SL would have prevented
 * the stop-out AND whether the signal then went on to hit TP1/TP2/TP3.
 */
function classifySLHitSurvivor(
  s: ParsedSignal,
  bars: OhlcBar[],
  newSL: number,
  newTP1: number,
  newTP2: number,
  newTP3: number,
): { classification: 'SURVIVED_TP' | 'SURVIVED_FLAT' | 'STILL_STOPPED'; targetsHit: number } {
  const isBuy = s.direction === 'BUY';
  const fourHoursMs = 4 * 60 * 60 * 1000;
  const cutoff = s.generatedMs + fourHoursMs;

  let stopped = false;
  let targetsHit = 0;

  for (const bar of bars) {
    if (bar.timestamp < s.generatedMs) continue;
    if (bar.timestamp > cutoff) break;

    const slHit = isBuy ? bar.low <= newSL : bar.high >= newSL;
    if (slHit) {
      stopped = true;
      break;
    }

    if (targetsHit < 1 && (isBuy ? bar.high >= newTP1 : bar.low <= newTP1)) targetsHit = 1;
    if (targetsHit < 2 && (isBuy ? bar.high >= newTP2 : bar.low <= newTP2)) targetsHit = 2;
    if (targetsHit < 3 && (isBuy ? bar.high >= newTP3 : bar.low <= newTP3)) targetsHit = 3;
  }

  if (stopped) return { classification: 'STILL_STOPPED', targetsHit: 0 };
  if (targetsHit > 0) return { classification: 'SURVIVED_TP', targetsHit };
  return { classification: 'SURVIVED_FLAT', targetsHit: 0 };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const exportPath = process.argv[2] ?? '/tmp/diag_export.txt';
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  ALTERNATIVE 2 — FIXED 120-PIP ($12.00) SL COUNTERFACTUAL (read-only)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  console.log('  PRE-REGISTERED HARD GATE (stated before running):');
  console.log(`    Baseline EV = ${BASELINE_EV_R}R (original-R, from Phase R1)`);
  console.log(`    Gate: new EV must beat baseline by >= +${GATE_EV_IMPROVEMENT_R}R`);
  console.log(`    Gate: net $ must NOT drop below baseline net $`);
  console.log(`    Fixed SL = $${FIXED_SL_DOLLARS.toFixed(2)} (${FIXED_SL_PIPS} pips) from entry`);
  console.log(`    TP ladder off $${FIXED_SL_DOLLARS}: TP1=$${(FIXED_SL_DOLLARS * SCALPER_TP_R.tp1).toFixed(2)} (${(FIXED_SL_DOLLARS * SCALPER_TP_R.tp1 / PIP).toFixed(0)} pips)`);
  console.log(`                                TP2=$${(FIXED_SL_DOLLARS * SCALPER_TP_R.tp2).toFixed(2)} (${(FIXED_SL_DOLLARS * SCALPER_TP_R.tp2 / PIP).toFixed(0)} pips)`);
  console.log(`                                TP3=$${(FIXED_SL_DOLLARS * SCALPER_TP_R.tp3).toFixed(2)} (${(FIXED_SL_DOLLARS * SCALPER_TP_R.tp3 / PIP).toFixed(0)} pips)`);
  console.log(`    ⚠️  Fixed SL $${FIXED_SL_DOLLARS} exceeds engine maxSLPips ($${MAX_SL_DOLLARS} / ${MAX_SL_PIPS} pips) — scope flag active.\n`);

  const allSignals = parseExport(exportPath);
  console.log(`Parsed ${allSignals.length} signals from export.`);

  const covered = allSignals
    .filter((s) => s.generatedMs >= COVERAGE_START_MS)
    .sort((a, b) => a.generatedMs - b.generatedMs);
  console.log(`Signals with Vantage bar coverage (>= 2026-07-13): ${covered.length}`);

  const coveredSLHit = covered.filter((s) => s.status === 'SL_HIT');
  console.log(`  of which SL_HIT: ${coveredSLHit.length}`);

  // Baseline metrics for the covered set
  const baselineResolved = covered.filter((s) => s.exitPrice !== null && s.status !== 'CLOSED');
  const baselineR = baselineResolved.map(rMultiple).filter((v): v is number => v !== null);
  const baselineWins = baselineR.filter((r) => r > 0);
  const baselineLosses = baselineR.filter((r) => r <= 0);
  const baselineGross = baselineWins.reduce((a, b) => a + b, 0);
  const baselineGrossLoss = Math.abs(baselineLosses.reduce((a, b) => a + b, 0));
  const baselineEV = baselineR.length ? baselineR.reduce((a, b) => a + b, 0) / baselineR.length : 0;
  const baselineNetDollars = covered.reduce((a, s) => a + (pnlDollars(s) ?? 0), 0);
  const baselineWR = baselineR.length ? (baselineWins.length / baselineR.length) * 100 : 0;
  const baselinePF = baselineGrossLoss > 0 ? baselineGross / baselineGrossLoss : Infinity;

  const avgOriginalR = mean(covered.map(riskDollars));
  const baselineDollarEV = baselineEV * avgOriginalR;

  console.log(`\n  Baseline (covered set, n=${covered.length}):`);
  console.log(`    resolved n=${baselineR.length}  WR=${baselineWR.toFixed(1)}%  PF=${baselinePF.toFixed(2)}`);
  console.log(`    EV=${baselineEV.toFixed(4)}R  EV$=${baselineDollarEV.toFixed(3)}  net=$${baselineNetDollars.toFixed(1)}`);
  console.log(`    avg original R (stop distance) = $${avgOriginalR.toFixed(3)} (${(avgOriginalR / PIP).toFixed(1)} pips)`);

  // Fetch bars for all covered signals
  console.log('\nFetching real gold_m1_bars for each covered signal...');
  const signalBars = new Map<number, OhlcBar[]>();
  let fetched = 0;
  let noBars = 0;
  for (const s of covered) {
    const fromTime = s.generatedMs;
    const toTime = fromTime + 4 * 60 * 60 * 1000;
    const bars = await fetchSupabaseGoldBars(fromTime, toTime);
    if (bars.length === 0) {
      noBars++;
    } else {
      signalBars.set(s.index, bars);
      fetched++;
    }
  }
  console.log(`  Fetched bars for ${fetched}/${covered.length} signals (${noBars} had no bars).`);

  const coveredWithBars = covered.filter((s) => signalBars.has(s.index));

  // ═══ STEP 1 — SL Distance Distribution ════════════════════════════════════
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 1 — Fixed SL Distance vs Original SL');
  console.log('─'.repeat(90));

  const origDistances = coveredWithBars.map(riskDollars);
  const fixedDistances = coveredWithBars.map(() => FIXED_SL_DOLLARS);
  const atrMults = coveredWithBars.map((s) => FIXED_SL_DOLLARS / (s.atr ?? 5));
  const wideningFactors = coveredWithBars.map((s) => FIXED_SL_DOLLARS / riskDollars(s));

  console.log(`\n  Fixed SL distance: $${FIXED_SL_DOLLARS.toFixed(2)} (${FIXED_SL_PIPS} pips) — constant for all signals`);
  console.log(`\n  Original SL distance:`);
  console.log(`    $:  median=${median(origDistances).toFixed(2)}  p25=${percentile(origDistances, 0.25).toFixed(2)}  p75=${percentile(origDistances, 0.75).toFixed(2)}  max=${Math.max(...origDistances).toFixed(2)}`);
  console.log(`    pips: median=${median(origDistances.map(d => d / PIP)).toFixed(1)}  max=${(Math.max(...origDistances) / PIP).toFixed(1)}`);

  console.log(`\n  Fixed SL in ATR multiples (using each signal's ATR):`);
  console.log(`    median=${median(atrMults).toFixed(2)}x  p25=${percentile(atrMults, 0.25).toFixed(2)}x  p75=${percentile(atrMults, 0.75).toFixed(2)}x  max=${Math.max(...atrMults).toFixed(2)}x`);

  console.log(`\n  Widening factor (fixed / original):`);
  console.log(`    median=${median(wideningFactors).toFixed(2)}x  p25=${percentile(wideningFactors, 0.25).toFixed(2)}x  p75=${percentile(wideningFactors, 0.75).toFixed(2)}x  max=${Math.max(...wideningFactors).toFixed(2)}x`);

  const exceedMaxSL = fixedDistances.filter((d) => d > MAX_SL_DOLLARS).length;
  console.log(`\n  Exceeds maxSLPips (${MAX_SL_PIPS} pips = $${MAX_SL_DOLLARS}): ${exceedMaxSL}/${fixedDistances.length} (100%)`);
  console.log(`  → EVERY signal's fixed SL exceeds the engine's hard SL cap. Scope flag: ACTIVE.`);

  // ═══ STEP 2 — Counterfactual Outcomes ═════════════════════════════════════
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 2 — Counterfactual Outcomes (fixed $12 SL, original entry, re-derived TP ladder)');
  console.log('─'.repeat(90));

  const counterfactualResults: {
    signal: ParsedSignal;
    newStatus: string;
    newR: number;
    pnlDollars: number;
    newStopDistance: number;
    origStopDistance: number;
  }[] = [];

  const windowEndMs = Date.now();
  const origLog = console.log;

  for (const s of coveredWithBars) {
    const bars = signalBars.get(s.index)!;
    const slPrice = computeFixedSL(s);
    const newStopDistance = FIXED_SL_DOLLARS;
    const origStopDistance = riskDollars(s);
    const cfSignal = buildFixedSLSignal(s, slPrice);

    console.log = () => {};
    const result = resolveSignalWithBars(cfSignal, bars, {
      fromScratch: true,
      evalNowMs: Math.min(windowEndMs, s.generatedMs + 4 * 60 * 60 * 1000),
      logPrefix: '',
    });
    console.log = origLog;

    const isBuy = s.direction === 'BUY';
    const pnl = result.outcomeResult === 'WIN'
      ? (isBuy ? result.exitPrice - s.entry : s.entry - result.exitPrice)
      : result.outcomeResult === 'LOSS'
        ? -newStopDistance
        : 0;
    const rMult = newStopDistance > 0 ? pnl / newStopDistance : 0;

    counterfactualResults.push({
      signal: s,
      newStatus: result.newStatus,
      newR: rMult,
      pnlDollars: pnl,
      newStopDistance,
      origStopDistance,
    });
  }

  const allR = counterfactualResults.map((r) => r.newR);
  const wins = allR.filter((r) => r > 0);
  const losses = allR.filter((r) => r <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const newEV_R = allR.length ? allR.reduce((a, b) => a + b, 0) / allR.length : 0;
  const newWR = allR.length ? (wins.length / allR.length) * 100 : 0;
  const newPF = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const newNetDollars = counterfactualResults.reduce((a, r) => a + r.pnlDollars, 0);

  const newDollarEV = mean(counterfactualResults.map((r) => r.pnlDollars));
  const newEV_inOrigR = newDollarEV / avgOriginalR;
  const deltaEV_origR = newEV_inOrigR - BASELINE_EV_R;

  const avgNewR = FIXED_SL_DOLLARS;
  const baselineEV_inNewR = baselineDollarEV / avgNewR;

  console.log(`\n  Counterfactual (fixed $12 SL, n=${counterfactualResults.length}):`);
  console.log(`    WR=${newWR.toFixed(1)}%  PF=${newPF.toFixed(2)}`);
  console.log(`    EV (new-R)      = ${newEV_R.toFixed(4)}R   [baseline in new-R = ${baselineEV_inNewR.toFixed(4)}R]`);
  console.log(`    EV (original-R) = ${newEV_inOrigR.toFixed(4)}R   [baseline = ${BASELINE_EV_R}R]`);
  console.log(`    EV ($)          = ${newDollarEV.toFixed(3)}   [baseline $ = ${baselineDollarEV.toFixed(3)}]`);
  console.log(`    Net $           = $${newNetDollars.toFixed(1)}   [baseline net $ = $${baselineNetDollars.toFixed(1)}]`);
  console.log(`    avg new R (stop distance) = $${avgNewR.toFixed(2)} (${(avgNewR / PIP).toFixed(0)} pips)  [avg original R = $${avgOriginalR.toFixed(3)}]`);

  // Status breakdown
  const statusCounts = new Map<string, number>();
  for (const r of counterfactualResults) {
    statusCounts.set(r.newStatus, (statusCounts.get(r.newStatus) ?? 0) + 1);
  }
  console.log('\n  Status breakdown (counterfactual):');
  for (const [status, count] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${status.padEnd(22)} ${count}`);
  }

  // Direction split
  console.log('\n  Direction split (counterfactual):');
  for (const dir of ['BUY', 'SELL'] as const) {
    const dirResults = counterfactualResults.filter((r) => r.signal.direction === dir);
    const dirR = dirResults.map((r) => r.newR);
    const dirWins = dirR.filter((r) => r > 0);
    const dirGross = dirWins.reduce((a, b) => a + b, 0);
    const dirGrossLoss = Math.abs(dirR.filter((r) => r <= 0).reduce((a, b) => a + b, 0));
    const dirEV = dirR.length ? dirR.reduce((a, b) => a + b, 0) / dirR.length : 0;
    const dirNet = dirResults.reduce((a, r) => a + r.pnlDollars, 0);
    const dirWR = dirR.length ? (dirWins.length / dirR.length) * 100 : 0;
    const dirPF = dirGrossLoss > 0 ? dirGross / dirGrossLoss : Infinity;
    console.log(`    ${dir}: n=${dirResults.length}  WR=${dirWR.toFixed(1)}%  PF=${dirPF.toFixed(2)}  EV=${dirEV.toFixed(4)}R(new)  net=$${dirNet.toFixed(1)}`);
  }

  // ═══ STEP 3 — SL_HIT Survivor Breakdown ═══════════════════════════════════
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 3 — SL_HIT Survivor Breakdown (baseline SL_HIT losers under $12 SL)');
  console.log('─'.repeat(90));

  const baselineSLHitWithBars = coveredSLHit.filter((s) => signalBars.has(s.index));
  console.log(`\n  Baseline SL_HIT losers with bars: ${baselineSLHitWithBars.length}`);

  const survivors: { signal: ParsedSignal; classification: 'SURVIVED_TP' | 'SURVIVED_FLAT' | 'STILL_STOPPED'; targetsHit: number }[] = [];

  for (const s of baselineSLHitWithBars) {
    const bars = signalBars.get(s.index)!;
    const slPrice = computeFixedSL(s);
    const cfSignal = buildFixedSLSignal(s, slPrice);

    const cont = classifySLHitSurvivor(
      s,
      bars,
      slPrice,
      cfSignal.tp1,
      cfSignal.tp2,
      cfSignal.tp3,
    );
    survivors.push({ signal: s, ...cont });
  }

  const survivedTP = survivors.filter((s) => s.classification === 'SURVIVED_TP');
  const survivedFlat = survivors.filter((s) => s.classification === 'SURVIVED_FLAT');
  const stillStopped = survivors.filter((s) => s.classification === 'STILL_STOPPED');
  const totalSurvivors = baselineSLHitWithBars.length;

  console.log(`\n  SURVIVED → reached TP:   ${survivedTP.length}/${totalSurvivors} (${((survivedTP.length / totalSurvivors) * 100).toFixed(1)}%)`);
  console.log(`    of which hit TP1:       ${survivedTP.filter((s) => s.targetsHit >= 1).length}`);
  console.log(`    of which hit TP2:       ${survivedTP.filter((s) => s.targetsHit >= 2).length}`);
  console.log(`    of which hit TP3:       ${survivedTP.filter((s) => s.targetsHit >= 3).length}`);
  console.log(`  SURVIVED → flat (no TP):  ${survivedFlat.length}/${totalSurvivors} (${((survivedFlat.length / totalSurvivors) * 100).toFixed(1)}%)`);
  console.log(`  STILL STOPPED ($12 SL):   ${stillStopped.length}/${totalSurvivors} (${((stillStopped.length / totalSurvivors) * 100).toFixed(1)}%)`);
  console.log(`    → these lose $${FIXED_SL_DOLLARS.toFixed(2)} each vs $${mean(baselineSLHitWithBars.map(riskDollars)).toFixed(2)} original (extra $${(FIXED_SL_DOLLARS - mean(baselineSLHitWithBars.map(riskDollars))).toFixed(2)}/trade)`);

  // Trade-off: survivor gains vs still-stopped extra losses
  const survivorGain = survivedTP.reduce((a, s) => {
    const rMult = s.targetsHit >= 3 ? 1.4 : s.targetsHit >= 2 ? 1.05 : 0.7;
    return a + rMult * FIXED_SL_DOLLARS;
  }, 0);
  const stillStoppedExtraLoss = stillStopped.reduce((a, s) => {
    const origStopDist = riskDollars(s.signal);
    return a + (FIXED_SL_DOLLARS - origStopDist);
  }, 0);

  console.log(`\n  Trade-off summary:`);
  console.log(`    Survivors gain (approx $): +$${survivorGain.toFixed(1)}`);
  console.log(`    Still-stopped extra loss ($): -$${stillStoppedExtraLoss.toFixed(1)}`);
  console.log(`    Net trade-off: $${(survivorGain - stillStoppedExtraLoss).toFixed(1)}`);

  // Also account for the FLAT survivors — they neither win nor lose (exit at entry-ish)
  // but under the resolver they'd resolve as still-ACTIVE or some non-terminal. Approximate as $0.
  console.log(`    Flat survivors (no TP, no stop): $0.0 (neither win nor lose)`);

  // ═══ STEP 4 — Decision Table + HARD GATE ══════════════════════════════════
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 4 — Decision Table + HARD GATE');
  console.log('─'.repeat(90));

  console.log('\n  ┌──────────────────────────────────────────────────────────────────────────┐');
  console.log('  │  METRIC              │  BASELINE (orig SL)  │  FIXED $12 SL (120 pip)   │');
  console.log('  ├──────────────────────┼──────────────────────┼───────────────────────────┤');
  console.log(`  │  n                   │  ${String(covered.length).padStart(18)}   │  ${String(counterfactualResults.length).padStart(25)}  │`);
  console.log(`  │  Win Rate            │  ${baselineWR.toFixed(1).padStart(17)}%   │  ${newWR.toFixed(1).padStart(24)}%  │`);
  console.log(`  │  Profit Factor       │  ${baselinePF.toFixed(2).padStart(18)}   │  ${newPF.toFixed(2).padStart(25)}  │`);
  console.log(`  │  EV (original-R)     │  ${BASELINE_EV_R.toFixed(4).padStart(18)}   │  ${newEV_inOrigR.toFixed(4).padStart(25)}  │`);
  console.log(`  │  EV ($)              │  $${baselineDollarEV.toFixed(3).padStart(16)}   │  $${newDollarEV.toFixed(3).padStart(23)}  │`);
  console.log(`  │  Net $               │  $${baselineNetDollars.toFixed(1).padStart(16)}   │  $${newNetDollars.toFixed(1).padStart(23)}  │`);
  console.log(`  │  avg stop distance   │  $${avgOriginalR.toFixed(2).padStart(16)}   │  $${FIXED_SL_DOLLARS.toFixed(2).padStart(23)}  │`);
  console.log(`  │  stop $ per loss     │  $${mean(baselineLosses.map(r => Math.abs(r) * avgOriginalR)).toFixed(2).padStart(16)}   │  $${FIXED_SL_DOLLARS.toFixed(2).padStart(23)}  │`);
  console.log('  └──────────────────────────────────────────────────────────────────────────┘');

  const evImprovement = deltaEV_origR;
  const netDollarDelta = newNetDollars - baselineNetDollars;
  const gateEVPassed = evImprovement >= GATE_EV_IMPROVEMENT_R;
  const gateNetPassed = newNetDollars >= baselineNetDollars;

  console.log('\n  ┌──────────────────────────────────────────────────────────────────────────┐');
  console.log(`  │  GATE CHECK 1: EV improvement >= +${GATE_EV_IMPROVEMENT_R}R                              │`);
  console.log(`  │    Δ EV (original-R) = ${evImprovement >= 0 ? '+' : ''}${evImprovement.toFixed(4)}R                                    │`);
  console.log(`  │    ${gateEVPassed ? '✅ PASSED' : '❌ FAILED'}                                                       │`);
  console.log('  ├──────────────────────────────────────────────────────────────────────────┤');
  console.log(`  │  GATE CHECK 2: Net $ >= baseline net $                               │`);
  console.log(`  │    Δ net $ = ${netDollarDelta >= 0 ? '+' : ''}$${netDollarDelta.toFixed(1)}                                            │`);
  console.log(`  │    ${gateNetPassed ? '✅ PASSED' : '❌ FAILED'}                                                       │`);
  console.log('  ├──────────────────────────────────────────────────────────────────────────┤');
  console.log(`  │  ⚠️  CONSTRAINT FLAG: ALL ${counterfactualResults.length} signals exceed maxSLPips (${MAX_SL_PIPS} pips)     │`);
  console.log(`  │    Fixed SL = $${FIXED_SL_DOLLARS} = ${FIXED_SL_PIPS} pips > $${MAX_SL_DOLLARS} = ${MAX_SL_PIPS} pips engine cap                │`);
  console.log(`  │    Median ATR multiple: ${median(atrMults).toFixed(2)}x (vs 1.2x floor, 3.0x scope threshold)            │`);
  console.log('  ├──────────────────────────────────────────────────────────────────────────┤');
  if (gateEVPassed && gateNetPassed) {
    console.log('  │  ✅ HARD GATE CLEARED — BUT scope violation flagged (see above)        │');
    console.log('  │  → Review whether 120-pip SL is compatible with scalper scope before   │');
    console.log('  │    implementing. TP1 at 84 pips nearly equals the 100-pip target.      │');
  } else {
    console.log('  │  ❌ HARD GATE NOT CLEARED — do NOT proceed to implementation         │');
    const failures: string[] = [];
    if (!gateEVPassed) failures.push(`EV ${evImprovement >= 0 ? '+' : ''}${evImprovement.toFixed(4)}R < +${GATE_EV_IMPROVEMENT_R}R`);
    if (!gateNetPassed) failures.push(`net $${newNetDollars.toFixed(1)} < baseline $${baselineNetDollars.toFixed(1)}`);
    console.log(`  │  Failed: ${failures.join(', ')}`);
    console.log('  │  → STOP. Report findings. The wide SL does not clear the gate.        │');
  }
  console.log('  └──────────────────────────────────────────────────────────────────────────┘');

  // Frequency vs magnitude analysis
  console.log('\n' + '─'.repeat(90));
  console.log('  FREQUENCY vs MAGNITUDE ANALYSIS');
  console.log('─'.repeat(90));
  const baselineStopFreq = (baselineLosses.length / baselineR.length) * 100;
  const newStopFreq = (losses.length / allR.length) * 100;
  const baselineAvgLossDollar = baselineLosses.length ? Math.abs(mean(baselineLosses)) * avgOriginalR : 0;
  const newAvgLossDollar = losses.length ? Math.abs(mean(losses)) * FIXED_SL_DOLLARS : 0;
  const baselineAvgWinR = wins.length ? mean(wins) : 0;
  const newAvgWinR = wins.length ? mean(wins) : 0;
  const baselineAvgWinDollar = baselineAvgWinR * avgOriginalR;
  const newAvgWinDollar = newAvgWinR * FIXED_SL_DOLLARS;

  console.log(`\n  Stop-out frequency:  baseline ${baselineStopFreq.toFixed(1)}%  →  fixed-SL ${newStopFreq.toFixed(1)}%  (Δ ${(newStopFreq - baselineStopFreq).toFixed(1)}pp)`);
  console.log(`  Avg loss magnitude:  baseline $${baselineAvgLossDollar.toFixed(2)}  →  fixed-SL $${newAvgLossDollar.toFixed(2)}`);
  console.log(`  Avg win magnitude:   baseline $${baselineAvgWinDollar.toFixed(2)} (${baselineAvgWinR.toFixed(3)}R)  →  fixed-SL $${newAvgWinDollar.toFixed(2)} (${newAvgWinR.toFixed(3)}R)`);
  console.log(`\n  Verdict: does reduced stop-out FREQUENCY outweigh larger stop-out MAGNITUDE?`);
  if (newNetDollars > baselineNetDollars) {
    console.log(`    YES — net $ improved by $${(newNetDollars - baselineNetDollars).toFixed(1)} despite ${((FIXED_SL_DOLLARS / avgOriginalR)).toFixed(2)}x larger per-loss cost.`);
  } else {
    console.log(`    NO — the larger per-loss cost ($${(newAvgLossDollar - baselineAvgLossDollar).toFixed(2)}/trade extra) outweighs the frequency reduction.`);
    console.log(`    Each prevented stop-out saves a loss but each surviving stop-out costs $${FIXED_SL_DOLLARS.toFixed(2)} vs $${baselineAvgLossDollar.toFixed(2)} — ratio ${newAvgLossDollar > 0 ? (newAvgLossDollar / baselineAvgLossDollar).toFixed(2) : 'N/A'}x.`);
  }

  // Per-loss economics
  console.log(`\n  Per-loss economics:`);
  console.log(`    Baseline: each SL_HIT costs ~$${baselineAvgLossDollar.toFixed(2)} (median $${median(baselineSLHitWithBars.map(riskDollars)).toFixed(2)})`);
  console.log(`    Fixed SL: each SL_HIT costs exactly $${FIXED_SL_DOLLARS.toFixed(2)}`);
  console.log(`    Extra cost per stopped trade: +$${(FIXED_SL_DOLLARS - median(baselineSLHitWithBars.map(riskDollars))).toFixed(2)}`);
  console.log(`    Break-even: need to prevent ${(stillStoppedExtraLoss / (FIXED_SL_DOLLARS * SCALPER_TP_R.tp1)).toFixed(1)} TP1 wins worth of stopped trades to break even on the extra loss cost`);

  console.log('\n' + '═'.repeat(90));
  console.log('  Alternative 2 (fixed 120-pip SL) analysis complete. No engine code was modified.');
  console.log('═'.repeat(90));
}

main().catch((e) => {
  console.error('Analysis script error:', e);
  process.exit(1);
});
