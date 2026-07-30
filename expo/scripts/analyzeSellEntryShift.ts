/**
 * SELL ENTRY-SHIFT COUNTERFACTUAL (read-only).
 *
 * Same 164 covered signals, same real Vantage bars, same discipline as the
 * four prior counterfactuals (retest, zone-SL, fixed-120-SL, SELL-filters).
 *
 * Treatment: for SELL signals ONLY, move the entry 40 pips ($4.00) HIGHER
 * than the recorded entry (a limit-sell at a better price — the retest-up
 * the user keeps pointing at), then apply a fixed geometry:
 *   SL  = entry + $4.50  (45 pips above the new entry)
 *   TP1 = entry - $3.00  (30 pips)
 *   TP2 = entry - $6.00  (60 pips)
 *   TP3 = entry - $9.00  (90 pips)
 *
 * BUY signals pass through UNCHANGED in every variant — recorded outcomes
 * are used directly (no re-resolution), exactly as the SELL-filter
 * counterfactual did.
 *
 * HONESTY NOTE: a SELL entry 40 pips higher is a LIMIT ORDER — it only
 * fills if price actually climbs $4.00 from the original entry after the
 * signal fires. This script checks fill against the real bars within the
 * 4h window. Unfilled SELLs count as MISSED (zero P/L, not excluded).
 * A "100% fill by assumption" row is also reported so the user can see
 * what the optimistic case looks like vs the honest fill-checked case.
 *
 * Pre-registered HARD GATE (stated BEFORE running):
 *   (a) SELL book's OWN EV (fill-checked) >= +0.10R (new-R, where 1R = $7.00)
 *   (b) WHOLE system (shifted SELL + unchanged BUY) EV >= +0.1306R
 *       (baseline +0.0806R + 0.05R, converted to new-R for the mixed system)
 *   (c) SELL fill rate >= 40% (a filter that never fills is useless)
 *
 *   IMPORTANT: the R units differ between BUY (original-R, avg ~$5.10) and
 *   shifted SELL (new-R, $7.00). The gate is evaluated in DOLLAR EV per
 *   signal, then converted to original-R for the baseline comparison, so
 *   the comparison is apples-to-apples.
 *
 * No engine code is modified. Uses resolveSignalWithBars() for SELL signals
 * that fill; BUY outcomes come from the recorded export.
 *
 * Usage: bunx tsx expo/scripts/analyzeSellEntryShift.ts <path-to-export.txt>
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal } from '@/types/trading';

// ─── Parsing (mirrors analyzeFixedSL120.ts / analyzeSellSideFilters.ts) ─────

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

// ─── Geometry constants ─────────────────────────────────────────────────────

const PIP = 0.1;
const COVERAGE_START_MS = new Date('2026-07-13T00:00:00Z').getTime();
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/** SELL entry shift: +40 pips = +$4.00 above the recorded entry. */
const ENTRY_SHIFT_DOLLARS = 4.0;
const ENTRY_SHIFT_PIPS = ENTRY_SHIFT_DOLLARS / PIP; // 40

/** Fixed SELL geometry: SL 45 pips, TP1 30, TP2 60, TP3 90 pips. */
const SL_DISTANCE_DOLLARS = 4.5;   // 45 pips
const TP1_DISTANCE_DOLLARS = 3.0;  // 30 pips
const TP2_DISTANCE_DOLLARS = 6.0;  // 60 pips
const TP3_DISTANCE_DOLLARS = 9.0;  // 90 pips
const SL_DISTANCE_PIPS = SL_DISTANCE_DOLLARS / PIP;     // 45
const TP1_DISTANCE_PIPS = TP1_DISTANCE_DOLLARS / PIP;   // 30
const TP2_DISTANCE_PIPS = TP2_DISTANCE_DOLLARS / PIP;   // 60
const TP3_DISTANCE_PIPS = TP3_DISTANCE_DOLLARS / PIP;   // 90

/** R multiples of the new SELL geometry (1R = $4.50 = 45 pips). */
const NEW_R_DOLLARS = SL_DISTANCE_DOLLARS;
const TP1_R = TP1_DISTANCE_DOLLARS / NEW_R_DOLLARS; // 0.6667
const TP2_R = TP2_DISTANCE_DOLLARS / NEW_R_DOLLARS; // 1.3333
const TP3_R = TP3_DISTANCE_DOLLARS / NEW_R_DOLLARS; // 2.0000

/** Pre-registered baseline EV from Phase R1 (original-R units). */
const BASELINE_EV_R = 0.0806;
const GATE_EV_IMPROVEMENT_R = 0.05;
const GATE_SELL_EV_MIN_R = 0.10;
const GATE_SELL_FILL_MIN_PCT = 40;

// ─── Helpers ────────────────────────────────────────────────────────────────

function riskDollars(s: ParsedSignal): number {
  return Math.abs(s.entry - s.sl);
}

function pnlDollars(s: ParsedSignal): number | null {
  if (s.exitPrice === null) return null;
  return s.direction === 'BUY' ? s.exitPrice - s.entry : s.entry - s.exitPrice;
}

function rMultipleOriginal(s: ParsedSignal): number | null {
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
 * Check whether a SELL limit order at the shifted entry price fills within
 * the bar window. For a SELL limit at `limitPrice`, the order fills when
 * price rises to reach `limitPrice` (bar.high >= limitPrice).
 * Returns the fill bar index (first bar where high >= limitPrice) or -1 if
 * no fill within the window.
 */
function findFillBarIndex(bars: OhlcBar[], limitPrice: number, fromMs: number): number {
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.timestamp < fromMs) continue;
    if (bar.high >= limitPrice) return i;
  }
  return -1;
}

/**
 * Build a TradingSignal for the shifted SELL entry.
 * newEntry = original entry + $4.00 (40 pips higher)
 * SL = newEntry + $7.00 (70 pips above)
 * TP1 = newEntry - $3.00, TP2 = newEntry - $6.00, TP3 = newEntry - $9.00
 */
function buildShiftedSellSignal(s: ParsedSignal, newEntry: number): TradingSignal {
  const slPrice = Number((newEntry + SL_DISTANCE_DOLLARS).toFixed(1));
  const tp1 = Number((newEntry - TP1_DISTANCE_DOLLARS).toFixed(1));
  const tp2 = Number((newEntry - TP2_DISTANCE_DOLLARS).toFixed(1));
  const tp3 = Number((newEntry - TP3_DISTANCE_DOLLARS).toFixed(1));

  return {
    id: `sellshift_${s.id}`,
    timestamp: new Date(s.generatedMs) as unknown as Date,
    createdAt: s.generatedMs,
    type: 'SELL',
    entryPrice: newEntry,
    entryPriceWithSlippage: newEntry,
    tp1,
    tp2,
    tp3,
    sl: slPrice,
    slMultiplier: 1,
    confidence: s.confidence / 100,
    status: 'ACTIVE',
    targetsHit: 0,
    entryTime: '',
    topFeatures: [],
    riskJustification: 'sell-entry-shift-counterfactual',
    breakevenReached: false,
  } as unknown as TradingSignal;
}

/**
 * For a baseline SELL SL_HIT loser, check whether the shifted entry + wider
 * SL would have survived and gone on to hit TP.
 */
function classifySellSLHitSurvivor(
  s: ParsedSignal,
  bars: OhlcBar[],
  newEntry: number,
  fillBarIndex: number,
): { classification: 'FILLED_SURVIVED_TP' | 'FILLED_SURVIVED_FLAT' | 'FILLED_STILL_STOPPED' | 'NOT_FILLED'; targetsHit: number } {
  if (fillBarIndex < 0) return { classification: 'NOT_FILLED', targetsHit: 0 };

  const slPrice = newEntry + SL_DISTANCE_DOLLARS;
  const tp1 = newEntry - TP1_DISTANCE_DOLLARS;
  const tp2 = newEntry - TP2_DISTANCE_DOLLARS;
  const tp3 = newEntry - TP3_DISTANCE_DOLLARS;
  const fillMs = bars[fillBarIndex].timestamp;
  const cutoff = s.generatedMs + FOUR_HOURS_MS;

  let stopped = false;
  let targetsHit = 0;

  for (let i = fillBarIndex; i < bars.length; i++) {
    const bar = bars[i];
    if (bar.timestamp > cutoff) break;

    // SELL: SL hit when price rises to slPrice
    if (bar.high >= slPrice) {
      stopped = true;
      break;
    }
    // SELL: TP hit when price falls to TP level
    if (targetsHit < 1 && bar.low <= tp1) targetsHit = 1;
    if (targetsHit < 2 && bar.low <= tp2) targetsHit = 2;
    if (targetsHit < 3 && bar.low <= tp3) targetsHit = 3;
  }

  if (stopped) return { classification: 'FILLED_STILL_STOPPED', targetsHit: 0 };
  if (targetsHit > 0) return { classification: 'FILLED_SURVIVED_TP', targetsHit };
  return { classification: 'FILLED_SURVIVED_FLAT', targetsHit: 0 };
}

// ─── Metrics ────────────────────────────────────────────────────────────────

interface Metrics {
  n: number;
  nResolved: number;
  winRate: number;
  pf: number;
  evR: number;
  evDollars: number;
  netDollars: number;
  avgRiskDollars: number;
}

function computeMetricsFromR(rValues: number[], dollarValues: number[], riskPerTrade: number[]): Metrics {
  const n = rValues.length + dollarValues.filter((_, i) => i >= rValues.length).length; // approximate
  const wins = rValues.filter((r) => r > 0);
  const losses = rValues.filter((r) => r <= 0);
  const gross = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const evR = rValues.length ? rValues.reduce((a, b) => a + b, 0) / rValues.length : 0;
  const winRate = rValues.length ? (wins.length / rValues.length) * 100 : 0;
  const pf = grossLoss > 0 ? gross / grossLoss : (gross > 0 ? Infinity : 0);
  const netDollars = dollarValues.reduce((a, b) => a + b, 0);
  const avgRisk = riskPerTrade.length ? mean(riskPerTrade) : 0;
  const evDollars = evR * avgRisk;
  return { n, nResolved: rValues.length, winRate, pf, evR, evDollars, netDollars, avgRiskDollars: avgRisk };
}

function fmtMetrics(m: Metrics): string {
  const pfStr = Number.isFinite(m.pf) ? m.pf.toFixed(2) : 'inf';
  return `n=${String(m.n).padStart(3)} (res=${String(m.nResolved).padStart(3)})  WR=${m.winRate.toFixed(1).padStart(5)}%  PF=${pfStr.padStart(5)}  EV=${m.evR.toFixed(4).padStart(7)}R  EV$=${m.evDollars.toFixed(3).padStart(7)}  net=$${m.netDollars.toFixed(1).padStart(7)}`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const exportPath = process.argv[2] ?? '/tmp/diag_export.txt';
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  SELL ENTRY-SHIFT COUNTERFACTUAL (read-only)');
  console.log(`  SELL entry +${ENTRY_SHIFT_PIPS} pips ($${ENTRY_SHIFT_DOLLARS.toFixed(2)}) | SL ${SL_DISTANCE_PIPS}p | TP1 ${TP1_DISTANCE_PIPS}p TP2 ${TP2_DISTANCE_PIPS}p TP3 ${TP3_DISTANCE_PIPS}p`);
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  console.log('  PRE-REGISTERED HARD GATE (stated before running):');
  console.log(`    Baseline EV = ${BASELINE_EV_R}R (original-R, from Phase R1)`);
  console.log(`    (a) SELL book OWN EV (fill-checked, new-R) >= +${GATE_SELL_EV_MIN_R}R`);
  console.log(`    (b) WHOLE system EV (original-R) >= +${(BASELINE_EV_R + GATE_EV_IMPROVEMENT_R).toFixed(4)}R (baseline + ${GATE_EV_IMPROVEMENT_R}R)`);
  console.log(`    (c) SELL fill rate >= ${GATE_SELL_FILL_MIN_PCT}%`);
  console.log(`    New SELL R = $${NEW_R_DOLLARS.toFixed(2)} (${SL_DISTANCE_PIPS} pips)`);
  console.log(`    TP ladder: TP1=${TP1_R.toFixed(4)}R  TP2=${TP2_R.toFixed(4)}R  TP3=${TP3_R.toFixed(4)}R`);
  console.log(`    HONESTY: SELL limit at entry+$${ENTRY_SHIFT_DOLLARS} only fills if price climbs — checked against real bars.\n`);

  const allSignals = parseExport(exportPath);
  console.log(`Parsed ${allSignals.length} signals from export.`);

  const covered = allSignals
    .filter((s) => s.generatedMs >= COVERAGE_START_MS)
    .sort((a, b) => a.generatedMs - b.generatedMs);
  console.log(`Signals with Vantage bar coverage (>= 2026-07-13): ${covered.length}`);

  const coveredBuy = covered.filter((s) => s.direction === 'BUY');
  const coveredSell = covered.filter((s) => s.direction === 'SELL');
  console.log(`  BUY: ${coveredBuy.length}  SELL: ${coveredSell.length}`);

  // ─── Baseline metrics ─────────────────────────────────────────────────────
  const baselineResolved = covered.filter((s) => s.exitPrice !== null && s.status !== 'CLOSED');
  const baselineR = baselineResolved.map(rMultipleOriginal).filter((v): v is number => v !== null);
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

  // Baseline by direction
  const baselineBuyR = coveredBuy.filter((s) => s.exitPrice !== null && s.status !== 'CLOSED').map(rMultipleOriginal).filter((v): v is number => v !== null);
  const baselineSellR = coveredSell.filter((s) => s.exitPrice !== null && s.status !== 'CLOSED').map(rMultipleOriginal).filter((v): v is number => v !== null);
  const baselineBuyEV = baselineBuyR.length ? baselineBuyR.reduce((a, b) => a + b, 0) / baselineBuyR.length : 0;
  const baselineSellEV = baselineSellR.length ? baselineSellR.reduce((a, b) => a + b, 0) / baselineSellR.length : 0;
  const baselineBuyNet = coveredBuy.reduce((a, s) => a + (pnlDollars(s) ?? 0), 0);
  const baselineSellNet = coveredSell.reduce((a, s) => a + (pnlDollars(s) ?? 0), 0);
  const baselineBuyWR = baselineBuyR.length ? (baselineBuyR.filter((r) => r > 0).length / baselineBuyR.length) * 100 : 0;
  const baselineSellWR = baselineSellR.length ? (baselineSellR.filter((r) => r > 0).length / baselineSellR.length) * 100 : 0;

  console.log(`\n  Baseline (all covered, n=${covered.length}):`);
  console.log(`    resolved n=${baselineR.length}  WR=${baselineWR.toFixed(1)}%  PF=${baselinePF.toFixed(2)}`);
  console.log(`    EV=${baselineEV.toFixed(4)}R  EV$=${baselineDollarEV.toFixed(3)}  net=$${baselineNetDollars.toFixed(1)}`);
  console.log(`    avg original R (stop distance) = $${avgOriginalR.toFixed(3)} (${(avgOriginalR / PIP).toFixed(1)} pips)`);
  console.log(`  Baseline BUY:  n=${coveredBuy.length}  WR=${baselineBuyWR.toFixed(1)}%  EV=${baselineBuyEV.toFixed(4)}R  net=$${baselineBuyNet.toFixed(1)}`);
  console.log(`  Baseline SELL: n=${coveredSell.length}  WR=${baselineSellWR.toFixed(1)}%  EV=${baselineSellEV.toFixed(4)}R  net=$${baselineSellNet.toFixed(1)}`);

  // ─── Fetch bars ───────────────────────────────────────────────────────────
  console.log('\nFetching real gold_m1_bars for each covered SELL signal (4h forward)...');
  const sellBars = new Map<number, OhlcBar[]>();
  let fetched = 0;
  let noBars = 0;
  for (const s of coveredSell) {
    const bars = await fetchSupabaseGoldBars(s.generatedMs, s.generatedMs + FOUR_HOURS_MS);
    if (bars.length === 0) {
      noBars++;
    } else {
      sellBars.set(s.index, bars);
      fetched++;
    }
  }
  console.log(`  Fetched bars for ${fetched}/${coveredSell.length} SELL signals (${noBars} had no bars).`);

  const sellWithBars = coveredSell.filter((s) => sellBars.has(s.index));
  console.log(`  SELL signals with bars for re-resolution: ${sellWithBars.length}`);

  // ─── STEP 1 — Fill Rate Analysis ──────────────────────────────────────────
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 1 — SELL LIMIT FILL ANALYSIS (entry + $4.00 = 40 pips higher)');
  console.log('─'.repeat(90));

  const fillResults: { signal: ParsedSignal; newEntry: number; fillBarIndex: number; fillMs: number | null }[] = [];

  for (const s of sellWithBars) {
    const bars = sellBars.get(s.index)!;
    const newEntry = Number((s.entry + ENTRY_SHIFT_DOLLARS).toFixed(1));
    const fillIdx = findFillBarIndex(bars, newEntry, s.generatedMs);
    fillResults.push({
      signal: s,
      newEntry,
      fillBarIndex: fillIdx,
      fillMs: fillIdx >= 0 ? bars[fillIdx].timestamp : null,
    });
  }

  const filled = fillResults.filter((r) => r.fillBarIndex >= 0);
  const unfilled = fillResults.filter((r) => r.fillBarIndex < 0);
  const fillRate = (filled.length / fillResults.length) * 100;

  console.log(`\n  SELL signals with bars: ${fillResults.length}`);
  console.log(`  Filled (price reached new entry): ${filled.length} (${fillRate.toFixed(1)}%)`);
  console.log(`  Unfilled (MISSED): ${unfilled.length} (${(100 - fillRate).toFixed(1)}%)`);

  // Time-to-fill distribution
  const fillTimesMin = filled.map((r) => (r.fillMs! - r.signal.generatedMs) / (60 * 1000));
  console.log(`\n  Time-to-fill distribution (minutes from signal generation):`);
  console.log(`    median=${median(fillTimesMin).toFixed(1)}  p25=${percentile(fillTimesMin, 0.25).toFixed(1)}  p75=${percentile(fillTimesMin, 0.75).toFixed(1)}  max=${Math.max(...fillTimesMin).toFixed(1)}`);

  // Original entry distance from new entry — sanity check
  const shiftDistances = fillResults.map((r) => Math.abs(r.newEntry - r.signal.entry));
  console.log(`\n  Entry shift: all ${fillResults.length} SELLs shifted +$${ENTRY_SHIFT_DOLLARS.toFixed(2)} (${ENTRY_SHIFT_PIPS} pips) — constant by construction`);

  // ─── STEP 2 — Counterfactual Outcomes (fill-checked) ──────────────────────
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 2 — COUNTERFACTUAL OUTCOMES (fill-checked SELL + unchanged BUY)');
  console.log('─'.repeat(90));

  const origLog = console.log;
  const windowEndMs = Date.now();

  // Re-resolve filled SELL signals
  const sellCfResults: {
    signal: ParsedSignal;
    newEntry: number;
    newStatus: string;
    newR: number; // in new-R ($7.00)
    pnlDollars: number;
    filled: boolean;
  }[] = [];

  for (const fr of fillResults) {
    if (fr.fillBarIndex < 0) {
      // MISSED — zero P/L
      sellCfResults.push({
        signal: fr.signal,
        newEntry: fr.newEntry,
        newStatus: 'MISSED_NO_FILL',
        newR: 0,
        pnlDollars: 0,
        filled: false,
      });
      continue;
    }

    const bars = sellBars.get(fr.signal.index)!;
    const cfSignal = buildShiftedSellSignal(fr.signal, fr.newEntry);
    const fillMs = bars[fr.fillBarIndex].timestamp;

    // Resolve from the fill bar onward
    const barsFromFill = bars.filter((b) => b.timestamp >= fillMs);

    console.log = () => {};
    const result = resolveSignalWithBars(cfSignal, barsFromFill, {
      fromScratch: true,
      evalNowMs: Math.min(windowEndMs, fr.signal.generatedMs + FOUR_HOURS_MS),
      logPrefix: '',
    });
    console.log = origLog;

    const pnl = result.outcomeResult === 'WIN'
      ? (fr.newEntry - result.exitPrice) // SELL: entry - exit
      : result.outcomeResult === 'LOSS'
        ? -NEW_R_DOLLARS
        : 0;
    const rMult = pnl / NEW_R_DOLLARS;

    sellCfResults.push({
      signal: fr.signal,
      newEntry: fr.newEntry,
      newStatus: result.newStatus,
      newR: rMult,
      pnlDollars: pnl,
      filled: true,
    });
  }

  // SELL-only metrics (fill-checked)
  const sellFilledResults = sellCfResults.filter((r) => r.filled);
  const sellFilledR = sellFilledResults.map((r) => r.newR);
  const sellAllR = sellCfResults.map((r) => r.newR); // includes missed as 0R
  const sellAllDollars = sellCfResults.map((r) => r.pnlDollars);
  const sellFilledDollars = sellFilledResults.map((r) => r.pnlDollars);

  const sellFilledWins = sellFilledR.filter((r) => r > 0);
  const sellFilledLosses = sellFilledR.filter((r) => r <= 0);
  const sellFilledGross = sellFilledWins.reduce((a, b) => a + b, 0);
  const sellFilledGrossLoss = Math.abs(sellFilledLosses.reduce((a, b) => a + b, 0));
  const sellFilledEV = sellFilledR.length ? sellFilledR.reduce((a, b) => a + b, 0) / sellFilledR.length : 0;
  const sellFilledWR = sellFilledR.length ? (sellFilledWins.length / sellFilledR.length) * 100 : 0;
  const sellFilledPF = sellFilledGrossLoss > 0 ? sellFilledGross / sellFilledGrossLoss : (sellFilledGross > 0 ? Infinity : 0);
  const sellFilledNet = sellFilledDollars.reduce((a, b) => a + b, 0);

  // SELL EV including missed (per ORIGINAL signal)
  const sellAllEV = sellAllR.length ? sellAllR.reduce((a, b) => a + b, 0) / sellAllR.length : 0;
  const sellAllNet = sellAllDollars.reduce((a, b) => a + b, 0);

  console.log(`\n  SELL book (fill-checked, n=${sellCfResults.length}, filled=${sellFilledResults.length}):`);
  console.log(`    Fill rate: ${fillRate.toFixed(1)}%`);
  console.log(`    Filled-only:  WR=${sellFilledWR.toFixed(1)}%  PF=${sellFilledPF.toFixed(2)}  EV=${sellFilledEV.toFixed(4)}R(new)  net=$${sellFilledNet.toFixed(1)}`);
  console.log(`    All (missed=0): EV=${sellAllEV.toFixed(4)}R(new)  net=$${sellAllNet.toFixed(1)}`);
  console.log(`    EV in $ (per original SELL signal, missed included): $${(sellAllNet / sellCfResults.length).toFixed(3)}`);

  // Status breakdown
  const statusCounts = new Map<string, number>();
  for (const r of sellCfResults) {
    statusCounts.set(r.newStatus, (statusCounts.get(r.newStatus) ?? 0) + 1);
  }
  console.log('\n  SELL status breakdown (counterfactual):');
  for (const [status, count] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${status.padEnd(26)} ${count}`);
  }

  // ─── WHOLE SYSTEM (shifted SELL + unchanged BUY) ──────────────────────────
  // BUY: use recorded outcomes (original-R)
  const buyR = coveredBuy
    .filter((s) => s.exitPrice !== null && s.status !== 'CLOSED')
    .map(rMultipleOriginal)
    .filter((v): v is number => v !== null);
  const buyDollars = coveredBuy.map((s) => pnlDollars(s) ?? 0);
  const buyNet = buyDollars.reduce((a, b) => a + b, 0);
  const buyEV = buyR.length ? buyR.reduce((a, b) => a + b, 0) / buyR.length : 0;

  // Whole system dollar EV per signal (the honest apples-to-apples metric)
  const wholeDollars = [...buyDollars, ...sellAllDollars];
  const wholeNet = wholeDollars.reduce((a, b) => a + b, 0);
  const wholeDollarEV = wholeNet / covered.length;
  const wholeEV_origR = wholeDollarEV / avgOriginalR;
  const deltaEV_origR = wholeEV_origR - BASELINE_EV_R;

  console.log(`\n  WHOLE SYSTEM (shifted SELL + unchanged BUY, n=${covered.length}):`);
  console.log(`    BUY (unchanged):  n=${coveredBuy.length}  EV=${buyEV.toFixed(4)}R(orig)  net=$${buyNet.toFixed(1)}`);
  console.log(`    SELL (shifted):    n=${coveredSell.length}  EV=${sellAllEV.toFixed(4)}R(new)  net=$${sellAllNet.toFixed(1)}`);
  console.log(`    Combined net $:    $${wholeNet.toFixed(1)}  [baseline net $${baselineNetDollars.toFixed(1)}]`);
  console.log(`    Combined EV:       ${wholeEV_origR.toFixed(4)}R(orig)  [baseline ${BASELINE_EV_R}R]`);
  console.log(`    Δ EV:              ${deltaEV_origR >= 0 ? '+' : ''}${deltaEV_origR.toFixed(4)}R`);

  // ─── STEP 2b — 100% FILL BY ASSUMPTION (optimistic case) ──────────────────
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 2b — OPTIMISTIC CASE (100% fill by assumption, for comparison)');
  console.log('─'.repeat(90));

  const sellAssumedResults: { newR: number; pnlDollars: number; newStatus: string }[] = [];

  for (const s of sellWithBars) {
    const bars = sellBars.get(s.index)!;
    const newEntry = Number((s.entry + ENTRY_SHIFT_DOLLARS).toFixed(1));
    const cfSignal = buildShiftedSellSignal(s, newEntry);

    console.log = () => {};
    const result = resolveSignalWithBars(cfSignal, bars, {
      fromScratch: true,
      evalNowMs: Math.min(windowEndMs, s.generatedMs + FOUR_HOURS_MS),
      logPrefix: '',
    });
    console.log = origLog;

    const pnl = result.outcomeResult === 'WIN'
      ? (newEntry - result.exitPrice)
      : result.outcomeResult === 'LOSS'
        ? -NEW_R_DOLLARS
        : 0;
    const rMult = pnl / NEW_R_DOLLARS;

    sellAssumedResults.push({ newR: rMult, pnlDollars: pnl, newStatus: result.newStatus });
  }

  const assumedR = sellAssumedResults.map((r) => r.newR);
  const assumedWins = assumedR.filter((r) => r > 0);
  const assumedLosses = assumedR.filter((r) => r <= 0);
  const assumedGross = assumedWins.reduce((a, b) => a + b, 0);
  const assumedGrossLoss = Math.abs(assumedLosses.reduce((a, b) => a + b, 0));
  const assumedEV = assumedR.length ? assumedR.reduce((a, b) => a + b, 0) / assumedR.length : 0;
  const assumedWR = assumedR.length ? (assumedWins.length / assumedR.length) * 100 : 0;
  const assumedPF = assumedGrossLoss > 0 ? assumedGross / assumedGrossLoss : (assumedGross > 0 ? Infinity : 0);
  const assumedNet = sellAssumedResults.reduce((a, r) => a + r.pnlDollars, 0);

  const wholeAssumedNet = buyNet + assumedNet;
  const wholeAssumedDollarEV = wholeAssumedNet / covered.length;
  const wholeAssumedEV_origR = wholeAssumedDollarEV / avgOriginalR;

  console.log(`\n  SELL (100% assumed, n=${sellAssumedResults.length}):`);
  console.log(`    WR=${assumedWR.toFixed(1)}%  PF=${assumedPF.toFixed(2)}  EV=${assumedEV.toFixed(4)}R(new)  net=$${assumedNet.toFixed(1)}`);
  console.log(`  WHOLE system (100% assumed): net=$${wholeAssumedNet.toFixed(1)}  EV=${wholeAssumedEV_origR.toFixed(4)}R(orig)`);
  console.log(`    ⚠️  This is the OPTIMISTIC ceiling — assumes every SELL limit fills. Not honest for gating.`);

  // ─── STEP 3 — SL_HIT Survivor Breakdown ───────────────────────────────────
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 3 — BASELINE SELL SL_HIT SURVIVOR BREAKDOWN');
  console.log('─'.repeat(90));

  const baselineSellSLHit = sellWithBars.filter((s) => s.status === 'SL_HIT');
  console.log(`\n  Baseline SELL SL_HIT losers with bars: ${baselineSellSLHit.length}`);

  const survivors: { signal: ParsedSignal; classification: string; targetsHit: number }[] = [];

  for (const s of baselineSellSLHit) {
    const bars = sellBars.get(s.index)!;
    const newEntry = Number((s.entry + ENTRY_SHIFT_DOLLARS).toFixed(1));
    const fillIdx = findFillBarIndex(bars, newEntry, s.generatedMs);
    const cont = classifySellSLHitSurvivor(s, bars, newEntry, fillIdx);
    survivors.push({ signal: s, classification: cont.classification, targetsHit: cont.targetsHit });
  }

  const survivedTP = survivors.filter((s) => s.classification === 'FILLED_SURVIVED_TP');
  const survivedFlat = survivors.filter((s) => s.classification === 'FILLED_SURVIVED_FLAT');
  const stillStopped = survivors.filter((s) => s.classification === 'FILLED_STILL_STOPPED');
  const notFilled = survivors.filter((s) => s.classification === 'NOT_FILLED');
  const totalSurvivors = survivors.length;

  console.log(`\n  FILLED → reached TP:    ${survivedTP.length}/${totalSurvivors} (${((survivedTP.length / totalSurvivors) * 100).toFixed(1)}%)`);
  console.log(`    of which hit TP1:      ${survivedTP.filter((s) => s.targetsHit >= 1).length}`);
  console.log(`    of which hit TP2:      ${survivedTP.filter((s) => s.targetsHit >= 2).length}`);
  console.log(`    of which hit TP3:      ${survivedTP.filter((s) => s.targetsHit >= 3).length}`);
  console.log(`  FILLED → flat (no TP):   ${survivedFlat.length}/${totalSurvivors} (${((survivedFlat.length / totalSurvivors) * 100).toFixed(1)}%)`);
  console.log(`  FILLED → still stopped:  ${stillStopped.length}/${totalSurvivors} (${((stillStopped.length / totalSurvivors) * 100).toFixed(1)}%)`);
  console.log(`    → these lose $${SL_DISTANCE_DOLLARS.toFixed(2)} each (the new wider stop)`);
  console.log(`  NOT FILLED (missed):     ${notFilled.length}/${totalSurvivors} (${((notFilled.length / totalSurvivors) * 100).toFixed(1)}%)`);
  console.log(`    → price never climbed to the +$${ENTRY_SHIFT_DOLLARS} entry; original SL_HIT avoided but no trade taken`);

  // Trade-off: survivor gains vs still-stopped extra losses vs missed opportunity cost
  const survivorGain = survivedTP.reduce((a, s) => {
    const rMult = s.targetsHit >= 3 ? TP3_R : s.targetsHit >= 2 ? TP2_R : TP1_R;
    return a + rMult * NEW_R_DOLLARS;
  }, 0);
  const stillStoppedLoss = stillStopped.reduce((a) => a + NEW_R_DOLLARS, 0);
  const origSLHitLoss = baselineSellSLHit.reduce((a, s) => a + riskDollars(s), 0);

  console.log(`\n  Trade-off summary (vs original SL_HIT losses):`);
  console.log(`    Original SL_HIT total loss:    -$${origSLHitLoss.toFixed(1)} (${baselineSellSLHit.length} × avg $${mean(baselineSellSLHit.map(riskDollars)).toFixed(2)})`);
  console.log(`    Survivor gains (filled+TP):    +$${survivorGain.toFixed(1)}`);
  console.log(`    Still-stopped losses (filled): -$${stillStoppedLoss.toFixed(1)} (${stillStopped.length} × $${NEW_R_DOLLARS.toFixed(2)})`);
  console.log(`    Missed (not filled):           $0.0 (${notFilled.length} — no trade, no loss, no gain)`);
  console.log(`    Net SELL SL_HIT trade-off:     $${(survivorGain - stillStoppedLoss).toFixed(1)} vs original -$${origSLHitLoss.toFixed(1)}`);

  // ─── STEP 4 — Decision Table + HARD GATE ──────────────────────────────────
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 4 — DECISION TABLE + HARD GATE');
  console.log('─'.repeat(90));

  console.log('\n  ┌──────────────────────────────────────────────────────────────────────────────────────┐');
  console.log('  │  METRIC              │  BASELINE (orig)  │  SELL-SHIFT (fill-checked)  │  100% ASSUMED  │');
  console.log('  ├──────────────────────┼───────────────────┼────────────────────────────┼────────────────┤');

  const pfBaseStr = Number.isFinite(baselinePF) ? baselinePF.toFixed(2) : 'inf';
  const pfFillStr = Number.isFinite(sellFilledPF) ? sellFilledPF.toFixed(2) : 'inf';
  const pfAssumeStr = Number.isFinite(assumedPF) ? assumedPF.toFixed(2) : 'inf';

  console.log(`  │  ALL n               │  ${String(covered.length).padStart(15)}   │  ${String(covered.length).padStart(26)}   │  ${String(covered.length).padStart(14)}  │`);
  console.log(`  │  ALL WR              │  ${baselineWR.toFixed(1).padStart(14)}%   │  ${'—'.padStart(26)}   │  ${'—'.padStart(14)}  │`);
  console.log(`  │  ALL PF              │  ${pfBaseStr.padStart(15)}   │  ${'—'.padStart(26)}   │  ${'—'.padStart(14)}  │`);
  console.log(`  │  ALL EV (orig-R)     │  ${baselineEV.toFixed(4).padStart(15)}   │  ${wholeEV_origR.toFixed(4).padStart(26)}   │  ${wholeAssumedEV_origR.toFixed(4).padStart(14)}  │`);
  console.log(`  │  ALL net $           │  $${baselineNetDollars.toFixed(1).padStart(13)}   │  $${wholeNet.toFixed(1).padStart(25)}   │  $${wholeAssumedNet.toFixed(1).padStart(13)}  │`);
  console.log('  ├──────────────────────┼───────────────────┼────────────────────────────┼────────────────┤');
  console.log(`  │  SELL n              │  ${String(coveredSell.length).padStart(15)}   │  ${String(sellCfResults.length).padStart(26)}   │  ${String(sellAssumedResults.length).padStart(14)}  │`);
  console.log(`  │  SELL filled         │  ${'—'.padStart(15)}   │  ${String(sellFilledResults.length).padStart(26)}   │  ${String(sellAssumedResults.length).padStart(14)}  │`);
  console.log(`  │  SELL fill rate      │  ${'—'.padStart(15)}   │  ${`${fillRate.toFixed(1)}%`.padStart(26)}   │  ${'100.0%'.padStart(14)}  │`);
  const baselineSellPF = (() => {
    const gw = baselineSellR.filter(r => r > 0).reduce((a, b) => a + b, 0);
    const gl = Math.abs(baselineSellR.filter(r => r <= 0).reduce((a, b) => a + b, 0));
    return gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0);
  })();
  const pfSellBaseStr = Number.isFinite(baselineSellPF) ? baselineSellPF.toFixed(2) : 'inf';
  console.log(`  │  SELL WR (filled)    │  ${baselineSellWR.toFixed(1).padStart(14)}%   │  ${`${sellFilledWR.toFixed(1)}%`.padStart(26)}   │  ${`${assumedWR.toFixed(1)}%`.padStart(14)}  │`);
  console.log(`  │  SELL PF (filled)    │  ${pfSellBaseStr.padStart(15)}   │  ${pfFillStr.padStart(26)}   │  ${pfAssumeStr.padStart(14)}  │`);
  console.log(`  │  SELL EV (new-R)     │  ${(baselineSellEV * avgOriginalR / NEW_R_DOLLARS).toFixed(4).padStart(15)}   │  ${sellFilledEV.toFixed(4).padStart(26)}   │  ${assumedEV.toFixed(4).padStart(14)}  │`);
  console.log(`  │  SELL EV (all, new-R)│  ${(baselineSellEV * avgOriginalR / NEW_R_DOLLARS).toFixed(4).padStart(15)}   │  ${sellAllEV.toFixed(4).padStart(26)}   │  ${assumedEV.toFixed(4).padStart(14)}  │`);
  console.log(`  │  SELL net $          │  $${baselineSellNet.toFixed(1).padStart(13)}   │  $${sellAllNet.toFixed(1).padStart(25)}   │  $${assumedNet.toFixed(1).padStart(13)}  │`);
  console.log(`  │  SELL stop distance  │  $${avgOriginalR.toFixed(2).padStart(13)}   │  $${NEW_R_DOLLARS.toFixed(2).padStart(25)}   │  $${NEW_R_DOLLARS.toFixed(2).padStart(13)}  │`);
  console.log('  └──────────────────────────────────────────────────────────────────────────────────────┘');

  // ─── GATE CHECKS ──────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(90));
  console.log('  GATE CHECKS (pre-registered)');
  console.log('─'.repeat(90));

  const gateA = sellFilledEV >= GATE_SELL_EV_MIN_R; // SELL filled EV in new-R
  const gateB = wholeEV_origR >= BASELINE_EV_R + GATE_EV_IMPROVEMENT_R; // whole system in orig-R
  const gateC = fillRate >= GATE_SELL_FILL_MIN_PCT;
  const gateThreshEV = BASELINE_EV_R + GATE_EV_IMPROVEMENT_R;

  console.log(`\n  (a) SELL filled EV = ${sellFilledEV.toFixed(4)}R(new) >= +${GATE_SELL_EV_MIN_R}R?  ${gateA ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  (b) Whole EV = ${wholeEV_origR.toFixed(4)}R(orig) >= ${gateThreshEV.toFixed(4)}R?  ${gateB ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`  (c) SELL fill rate = ${fillRate.toFixed(1)}% >= ${GATE_SELL_FILL_MIN_PCT}%?  ${gateC ? '✅ PASS' : '❌ FAIL'}`);

  const allPass = gateA && gateB && gateC;
  if (allPass) {
    console.log(`\n  → ✅ ALL GATES CLEARED — proceed to implementation`);
  } else {
    console.log(`\n  → ❌ GATE NOT CLEARED`);
    const failures: string[] = [];
    if (!gateA) failures.push(`SELL EV ${sellFilledEV.toFixed(4)}R < +${GATE_SELL_EV_MIN_R}R`);
    if (!gateB) failures.push(`Whole EV ${wholeEV_origR.toFixed(4)}R < ${gateThreshEV.toFixed(4)}R`);
    if (!gateC) failures.push(`fill rate ${fillRate.toFixed(1)}% < ${GATE_SELL_FILL_MIN_PCT}%`);
    console.log(`    Failed: ${failures.join(', ')}`);
  }

  // ─── FREQUENCY vs MAGNITUDE ───────────────────────────────────────────────
  console.log('\n' + '─'.repeat(90));
  console.log('  FREQUENCY vs MAGNITUDE + HONEST ASSESSMENT');
  console.log('─'.repeat(90));

  const baselineSellLossFreq = baselineSellR.length ? (baselineSellR.filter((r) => r <= 0).length / baselineSellR.length) * 100 : 0;
  const newSellLossFreq = sellFilledR.length ? (sellFilledR.filter((r) => r <= 0).length / sellFilledR.length) * 100 : 0;
  const baselineSellAvgLossDollar = baselineSellR.filter((r) => r <= 0).length ? Math.abs(mean(baselineSellR.filter((r) => r <= 0))) * avgOriginalR : 0;
  const newSellAvgLossDollar = sellFilledR.filter((r) => r <= 0).length ? Math.abs(mean(sellFilledR.filter((r) => r <= 0))) * NEW_R_DOLLARS : 0;

  console.log(`\n  SELL stop-out frequency:  baseline ${baselineSellLossFreq.toFixed(1)}%  →  shifted ${newSellLossFreq.toFixed(1)}% (filled only)`);
  console.log(`  SELL avg loss magnitude:  baseline $${baselineSellAvgLossDollar.toFixed(2)}  →  shifted $${newSellAvgLossDollar.toFixed(2)}`);
  console.log(`  SELL avg win magnitude:   baseline $${baselineSellR.filter(r=>r>0).length ? mean(baselineSellR.filter(r=>r>0)) * avgOriginalR : 0}  →  shifted $${sellFilledR.filter(r=>r>0).length ? mean(sellFilledR.filter(r=>r>0)) * NEW_R_DOLLARS : 0}`);
  console.log(`  SELL TP ladder: TP1=${TP1_R.toFixed(3)}R ($${TP1_DISTANCE_DOLLARS}) TP2=${TP2_R.toFixed(3)}R ($${TP2_DISTANCE_DOLLARS}) TP3=${TP3_R.toFixed(3)}R ($${TP3_DISTANCE_DOLLARS})`);
  console.log(`    vs baseline 1.4R ladder: TP1=0.700R TP2=1.050R TP3=1.400R`);
  console.log(`    → The compressed ladder captures less per win even from the better entry.`);

  // The core question: did the 40-pip better entry + wider stop actually help?
  console.log(`\n  Core question: does the +$${ENTRY_SHIFT_DOLLARS} better entry offset the compressed TP ladder?`);
  const entryImprovementPerFill = ENTRY_SHIFT_DOLLARS; // each filled SELL starts $4 better
  const tp1Reduction = avgOriginalR * 0.7 - TP1_DISTANCE_DOLLARS; // baseline TP1$ - new TP1$
  console.log(`    Entry improvement per fill: +$${entryImprovementPerFill.toFixed(2)}`);
  console.log(`    TP1 distance reduction:     $${tp1Reduction.toFixed(2)} (baseline TP1 was ~$${(avgOriginalR * 0.7).toFixed(2)}, new TP1 is $${TP1_DISTANCE_DOLLARS.toFixed(2)})`);
  console.log(`    Net per TP1 win:             $${(entryImprovementPerFill - tp1Reduction + TP1_DISTANCE_DOLLARS).toFixed(2)} vs baseline $${(avgOriginalR * 0.7).toFixed(2)}`);

  console.log('\n' + '═'.repeat(90));
  console.log('  SELL entry-shift analysis complete. No engine code was modified.');
  console.log('═'.repeat(90));
}

main().catch((e) => {
  console.error('Analysis script error:', e);
  process.exit(1);
});
