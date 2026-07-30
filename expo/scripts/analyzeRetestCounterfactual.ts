/**
 * PHASE R1 — Retest-confirmation counterfactual analysis (READ-ONLY).
 *
 * Parses the diagnostic export (same ParsedSignal approach as
 * auditDiagnosticsReport.ts), filters to signals with real Vantage
 * gold_m1_bars coverage (generated >= 2026-07-13), fetches real bars
 * from createdAt through +4h, and computes:
 *
 *   Step 1 — MAE distribution (winners vs SL_HIT losers, in $ and x SL distance).
 *   Step 2 — Retest fill-rate matrix (depths {0.3,0.5,0.7} x TTL {30,60,120} min).
 *   Step 3 — Counterfactual outcomes: re-resolve filled signals from the
 *            retest entry with a re-anchored 1.4R ladder and SL behind the
 *            originating zone boundary.
 *   Step 4 — Decision table + HARD GATE check.
 *
 * No engine code is modified. Uses the real resolveSignalWithBars() against
 * the same real bars.
 *
 * Usage: bunx tsx expo/scripts/analyzeRetestCounterfactual.ts <path-to-export.txt>
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { resolveSignalWithBars } from '../services/signalResolver';
import type { TradingSignal } from '@/types/trading';

// ─── Parsing (mirrors auditDiagnosticsReport.ts) ───────────────────────────

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

// ─── Supabase bar fetch (mirrors verify_vantage_backfill_flagged_signals.ts) ─

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
const MIN_SL_ATR_MULTIPLE = 1.2;
const COVERAGE_START_MS = new Date('2026-07-13T00:00:00Z').getTime();

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

/**
 * Find the nearest zone boundary on the STOP side of the signal.
 * For a BUY, the stop is below entry — find the nearest SUPPORT zone below entry.
 * For a SELL, the stop is above entry — find the nearest RESISTANCE zone above entry.
 * Falls back to null if no zone is resolvable.
 */
function findZoneBoundaryForStop(s: ParsedSignal): number | null {
  const isBuy = s.direction === 'BUY';
  const candidates = s.zones
    .filter((z) => isBuy ? z.type === 'SUPPORT' && z.price < s.entry : z.type === 'RESISTANCE' && z.price > s.entry)
    .filter((z) => z.reaction >= 30 || z.touches >= 1) // filter weak zones
    .sort((a, b) => isBuy
      ? (s.entry - a.price) - (s.entry - b.price) // nearest below (largest support price)
      : (a.price - s.entry) - (b.price - s.entry) // nearest above (smallest resistance price)
    );
  return candidates.length > 0 ? candidates[0].price : null;
}

/**
 * Find the next S/R barrier beyond TP3 on the profit side.
 * For BUY: nearest RESISTANCE above entry beyond 1.4R.
 * For SELL: nearest SUPPORT below entry beyond 1.4R.
 * Returns null if none found.
 */
function findNextBarrierBeyondTP3(s: ParsedSignal, retestEntry: number, stopDistance: number): number | null {
  const isBuy = s.direction === 'BUY';
  const tp3Price = isBuy
    ? retestEntry + SCALPER_TP_R.tp3 * stopDistance
    : retestEntry - SCALPER_TP_R.tp3 * stopDistance;
  const candidates = s.zones
    .filter((z) => isBuy ? z.type === 'RESISTANCE' && z.price > retestEntry : z.type === 'SUPPORT' && z.price < retestEntry)
    .filter((z) => z.reaction >= 30)
    .filter((z) => isBuy ? z.price > tp3Price : z.price < tp3Price) // beyond 1.4R
    .sort((a, b) => isBuy ? a.price - b.price : b.price - a.price);
  return candidates.length > 0 ? candidates[0].price : null;
}

/**
 * Compute the retest limit price for a given depth fraction.
 * For BUY: entry - r * SLdist (below entry, toward the stop side).
 * For SELL: entry + r * SLdist (above entry, toward the stop side).
 */
function retestLimitPrice(s: ParsedSignal, depth: number): number {
  const slDist = riskDollars(s);
  const delta = depth * slDist;
  return s.direction === 'BUY' ? s.entry - delta : s.entry + delta;
}

/**
 * Check if a retest level filled within a TTL window using real bar highs/lows.
 * For BUY: price needs to drop to the retest level → bar.low <= retestLimit.
 * For SELL: price needs to rise to the retest level → bar.high >= retestLimit.
 * Returns the fill bar timestamp, or null if not filled within TTL.
 */
function checkRetestFill(
  bars: OhlcBar[],
  genMs: number,
  retestLimit: number,
  ttlMinutes: number,
  direction: 'BUY' | 'SELL',
): number | null {
  const ttlMs = ttlMinutes * 60 * 1000;
  const cutoff = genMs + ttlMs;
  for (const bar of bars) {
    if (bar.timestamp < genMs) continue;
    if (bar.timestamp > cutoff) break;
    const filled = direction === 'BUY' ? bar.low <= retestLimit : bar.high >= retestLimit;
    if (filled) return bar.timestamp;
  }
  return null;
}

/**
 * Compute MAE (max adverse excursion) from entry before the signal reaches
 * TP1 or resolves. Walks bars from generation time.
 * For BUY: adverse = entry - bar.low (deepest dip below entry).
 * For SELL: adverse = bar.high - entry (highest spike above entry).
 * Stops tracking once TP1 is hit or a terminal event occurs.
 */
function computeMAE(s: ParsedSignal, bars: OhlcBar[]): { maeDollars: number; reachedTp1: boolean } {
  const isBuy = s.direction === 'BUY';
  const tp1 = s.tp[0];
  const sl = s.sl;
  let maxAdverse = 0;
  let reachedTp1 = false;

  for (const bar of bars) {
    if (bar.timestamp < s.generatedMs) continue;

    // Check TP1 hit first (if reached, stop tracking MAE)
    const tp1Hit = isBuy ? bar.high >= tp1 : bar.low <= tp1;
    if (tp1Hit) {
      reachedTp1 = true;
      break;
    }

    // Check SL hit (terminal)
    const slHit = isBuy ? bar.low <= sl : bar.high >= sl;
    if (slHit) break;

    // Track adverse excursion
    const adverse = isBuy ? s.entry - bar.low : bar.high - s.entry;
    if (adverse > maxAdverse) maxAdverse = adverse;
  }

  return { maeDollars: maxAdverse, reachedTp1 };
}

/**
 * For SL_HIT losers: check if price subsequently reached original TP1/TP2/TP3
 * within 4h after the stop-out. Walks bars from after the recorded exit time.
 */
function checkPostStopContinuation(
  s: ParsedSignal,
  bars: OhlcBar[],
  stopExitMs: number,
): { reachedTp1: boolean; reachedTp2: boolean; reachedTp3: boolean; tp1Time: number | null } {
  const isBuy = s.direction === 'BUY';
  const tp1 = s.tp[0];
  const tp2 = s.tp[1] ?? tp1;
  const tp3 = s.tp[2] ?? tp1;
  const fourHoursMs = 4 * 60 * 60 * 1000;
  const cutoff = stopExitMs + fourHoursMs;

  let reachedTp1 = false;
  let reachedTp2 = false;
  let reachedTp3 = false;
  let tp1Time: number | null = null;

  for (const bar of bars) {
    if (bar.timestamp <= stopExitMs) continue;
    if (bar.timestamp > cutoff) break;

    if (!reachedTp1 && (isBuy ? bar.high >= tp1 : bar.low <= tp1)) {
      reachedTp1 = true;
      tp1Time = bar.timestamp;
    }
    if (!reachedTp2 && (isBuy ? bar.high >= tp2 : bar.low <= tp2)) {
      reachedTp2 = true;
    }
    if (!reachedTp3 && (isBuy ? bar.high >= tp3 : bar.low <= tp3)) {
      reachedTp3 = true;
    }
  }

  return { reachedTp1, reachedTp2, reachedTp3, tp1Time };
}

/**
 * Build a TradingSignal for the retest counterfactual, re-anchoring the
 * 1.4R ladder at the retest entry with SL behind the zone boundary.
 */
function buildRetestSignal(
  s: ParsedSignal,
  retestEntry: number,
  slPrice: number,
): TradingSignal {
  const isBuy = s.direction === 'BUY';
  const stopDistance = Math.abs(retestEntry - slPrice);

  // TP3 stretch: check if next barrier beyond 1.4R exists
  const nextBarrier = findNextBarrierBeyondTP3(s, retestEntry, stopDistance);
  let tp3R: number = SCALPER_TP_R.tp3;
  const barrierDistance = nextBarrier !== null
    ? Math.abs(nextBarrier - retestEntry) / stopDistance
    : Infinity;
  if (s.confidence >= 89 && barrierDistance >= 3) tp3R = SCALPER_TP3_STRETCH_MAX_R;
  else if (s.confidence >= 82 && barrierDistance >= 2.5) tp3R = SCALPER_TP3_STRETCH_R;

  const tp1Distance = stopDistance * SCALPER_TP_R.tp1;
  const tp2Distance = stopDistance * SCALPER_TP_R.tp2;
  const tp3Distance = stopDistance * tp3R;

  const tp1 = retestEntry + (isBuy ? 1 : -1) * tp1Distance;
  const tp2 = retestEntry + (isBuy ? 1 : -1) * tp2Distance;
  const tp3 = retestEntry + (isBuy ? 1 : -1) * tp3Distance;

  return {
    id: `retest_${s.id}`,
    timestamp: new Date(s.generatedMs) as unknown as Date,
    createdAt: s.generatedMs,
    type: isBuy ? 'BUY' : 'SELL',
    entryPrice: retestEntry,
    entryPriceWithSlippage: retestEntry,
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
    riskJustification: 'retest-counterfactual',
    breakevenReached: false,
  } as unknown as TradingSignal;
}

/**
 * Compute the SL price for the retest counterfactual.
 * SL placed at the ORIGINAL structure boundary (the zone the retest tested),
 * falling back to 1.2xATR behind the retest entry if no zone is resolvable.
 */
function computeRetestSL(s: ParsedSignal, retestEntry: number): number {
  const isBuy = s.direction === 'BUY';
  const zoneBoundary = findZoneBoundaryForStop(s);

  if (zoneBoundary !== null) {
    // SL goes just behind the zone boundary (0.5$ buffer = 5 pips)
    const buffer = 0.5;
    return isBuy ? zoneBoundary - buffer : zoneBoundary + buffer;
  }

  // Fallback: 1.2 x ATR behind retest entry
  const atr = s.atr ?? 5; // sensible default if ATR missing
  const slDistance = atr * MIN_SL_ATR_MULTIPLE;
  return isBuy ? retestEntry - slDistance : retestEntry + slDistance;
}

// ─── Main ───────────────────────────────────────────────────────────────────

interface CounterfactualCell {
  depth: number;
  ttl: number;
  fillRate: number;
  filledCount: number;
  missedCount: number;
  wrFilled: number;
  evPerOriginalSignal: number;
  pf: number;
  netDollars: number;
  baselineNetDollars: number;
}

async function main() {
  const exportPath = process.argv[2] ?? '/tmp/diag_export.txt';
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  PHASE R1 — RETEST COUNTERFACTUAL ANALYSIS (read-only, no engine changes)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const allSignals = parseExport(exportPath);
  console.log(`Parsed ${allSignals.length} signals from export.`);

  // Filter to signals with real Vantage bar coverage (generated >= 2026-07-13)
  const covered = allSignals
    .filter((s) => s.generatedMs >= COVERAGE_START_MS)
    .sort((a, b) => a.generatedMs - b.generatedMs);
  console.log(`Signals with Vantage bar coverage (>= 2026-07-13): ${covered.length}`);

  const coveredSLHit = covered.filter((s) => s.status === 'SL_HIT');
  console.log(`  of which SL_HIT: ${coveredSLHit.length}`);
  const coveredWinners = covered.filter((s) => {
    const r = rMultiple(s);
    return r !== null && r > 0;
  });
  console.log(`  of which winners (R > 0): ${coveredWinners.length}`);

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

  console.log(`\n  Baseline (covered set, n=${covered.length}):`);
  console.log(`    resolved n=${baselineR.length}  WR=${baselineWR.toFixed(1)}%  PF=${baselinePF.toFixed(2)}  EV=${baselineEV.toFixed(4)}R  net=$${baselineNetDollars.toFixed(1)}`);

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

  // ═══ STEP 1 — MAE Distribution ═══════════════════════════════════════════
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 1 — MAE (Max Adverse Excursion) Distribution');
  console.log('─'.repeat(90));

  const winnerMAE: { dollars: number; slMult: number }[] = [];
  const slHitMAE: { dollars: number; slMult: number }[] = [];
  const slHitContinuation: { signal: ParsedSignal; reachedTp1: boolean; reachedTp2: boolean; reachedTp3: boolean; tp1Time: number | null }[] = [];

  for (const s of coveredWithBars) {
    const bars = signalBars.get(s.index)!;
    const { maeDollars, reachedTp1 } = computeMAE(s, bars);
    const slDist = riskDollars(s);
    const maeSlMult = slDist > 0 ? maeDollars / slDist : 0;

    const r = rMultiple(s);
    if (r !== null && r > 0 && reachedTp1) {
      winnerMAE.push({ dollars: maeDollars, slMult: maeSlMult });
    } else if (s.status === 'SL_HIT') {
      slHitMAE.push({ dollars: maeDollars, slMult: maeSlMult });

      // Check post-stop continuation: find the SL hit bar timestamp
      const isBuy = s.direction === 'BUY';
      const sl = s.sl;
      let stopBarTs = s.generatedMs;
      for (const bar of bars) {
        if (bar.timestamp < s.generatedMs) continue;
        const slHit = isBuy ? bar.low <= sl : bar.high >= sl;
        if (slHit) {
          stopBarTs = bar.timestamp;
          break;
        }
      }
      const cont = checkPostStopContinuation(s, bars, stopBarTs);
      slHitContinuation.push({ signal: s, ...cont });
    }
  }

  console.log('\n  MAE — WINNERS (n=' + winnerMAE.length + '):');
  const wDollars = winnerMAE.map((w) => w.dollars);
  const wMults = winnerMAE.map((w) => w.slMult);
  console.log(`    $:  median=${median(wDollars).toFixed(2)}  p25=${percentile(wDollars, 0.25).toFixed(2)}  p75=${percentile(wDollars, 0.75).toFixed(2)}`);
  console.log(`    xSL: median=${median(wMults).toFixed(3)}  p25=${percentile(wMults, 0.25).toFixed(3)}  p75=${percentile(wMults, 0.75).toFixed(3)}`);

  console.log('\n  MAE — SL_HIT LOSERS (n=' + slHitMAE.length + '):');
  const lDollars = slHitMAE.map((w) => w.dollars);
  const lMults = slHitMAE.map((w) => w.slMult);
  console.log(`    $:  median=${median(lDollars).toFixed(2)}  p25=${percentile(lDollars, 0.25).toFixed(2)}  p75=${percentile(lDollars, 0.75).toFixed(2)}`);
  console.log(`    xSL: median=${median(lMults).toFixed(3)}  p25=${percentile(lMults, 0.25).toFixed(3)}  p75=${percentile(lMults, 0.75).toFixed(3)}`);

  // Post-stop continuation
  console.log('\n  POST-STOP CONTINUATION (SL_HIT losers, 4h window after stop-out):');
  const contTp1 = slHitContinuation.filter((c) => c.reachedTp1).length;
  const contTp2 = slHitContinuation.filter((c) => c.reachedTp2).length;
  const contTp3 = slHitContinuation.filter((c) => c.reachedTp3).length;
  const totalSLHit = slHitContinuation.length;
  console.log(`    Total SL_HIT losers with bars: ${totalSLHit}`);
  console.log(`    Subsequently reached TP1: ${contTp1} (${totalSLHit > 0 ? ((contTp1 / totalSLHit) * 100).toFixed(1) : 0}%)`);
  console.log(`    Subsequently reached TP2: ${contTp2} (${totalSLHit > 0 ? ((contTp2 / totalSLHit) * 100).toFixed(1) : 0}%)`);
  console.log(`    Subsequently reached TP3: ${contTp3} (${totalSLHit > 0 ? ((contTp3 / totalSLHit) * 100).toFixed(1) : 0}%)`);

  // Average time to reach TP1 after stop
  const contTp1Times = slHitContinuation
    .filter((c) => c.reachedTp1 && c.tp1Time !== null)
    .map((c) => {
      const isBuy = c.signal.direction === 'BUY';
      const sl = c.signal.sl;
      const bars = signalBars.get(c.signal.index)!;
      let stopTs = c.signal.generatedMs;
      for (const bar of bars) {
        if (bar.timestamp < c.signal.generatedMs) continue;
        if (isBuy ? bar.low <= sl : bar.high >= sl) { stopTs = bar.timestamp; break; }
      }
      return (c.tp1Time! - stopTs) / 60000; // minutes
    });
  if (contTp1Times.length > 0) {
    console.log(`    Avg time to TP1 after stop: ${contTp1Times.reduce((a, b) => a + b, 0) / contTp1Times.length} min (median ${median(contTp1Times)} min)`);
  }

  // ═══ STEP 2 — Retest Fill-Rate Matrix ════════════════════════════════════
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 2 — Retest Fill-Rate Matrix (depth x TTL)');
  console.log('─'.repeat(90));

  const depths = [0.3, 0.5, 0.7];
  const ttls = [30, 60, 120];
  const fillMatrix: Map<string, number[]> = new Map(); // key: "r_ttl" → array of fill timestamps (or -1 for no fill)

  console.log('\n           TTL=30min   TTL=60min   TTL=120min');
  for (const r of depths) {
    const row: string[] = [`  r=${r.toFixed(1)}  `];
    for (const ttl of ttls) {
      let filled = 0;
      const fillTimes: number[] = [];
      for (const s of coveredWithBars) {
        const bars = signalBars.get(s.index)!;
        const limit = retestLimitPrice(s, r);
        const fillTs = checkRetestFill(bars, s.generatedMs, limit, ttl, s.direction);
        if (fillTs !== null) {
          filled++;
          fillTimes.push(fillTs);
        } else {
          fillTimes.push(-1);
        }
      }
      const rate = coveredWithBars.length > 0 ? (filled / coveredWithBars.length) * 100 : 0;
      row.push(`${filled}/${coveredWithBars.length} (${rate.toFixed(1)}%)`);
      fillMatrix.set(`${r}_${ttl}`, fillTimes);
    }
    console.log(row.join('  '));
  }

  // ═══ STEP 3 — Counterfactual Outcomes ════════════════════════════════════
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 3 — Counterfactual Outcomes (retest entry, 1.4R re-anchored, SL behind zone)');
  console.log('─'.repeat(90));

  const cells: CounterfactualCell[] = [];
  const windowEndMs = Date.now(); // for fromScratch maturity check

  for (const r of depths) {
    for (const ttl of ttls) {
      const fillTimes = fillMatrix.get(`${r}_${ttl}`)!;
      const retestResults: { r: number; status: string; pnl: number }[] = [];

      // Silence the resolver's internal console.log during counterfactual
      // resolution so only the summary tables print to stdout.
      const origLog = console.log;
      for (let i = 0; i < coveredWithBars.length; i++) {
        const s = coveredWithBars[i];
        const fillTs = fillTimes[i];

        if (fillTs === -1) {
          // MISSED — zero P/L
          retestResults.push({ r: 0, status: 'MISSED', pnl: 0 });
          continue;
        }

        const bars = signalBars.get(s.index)!;
        const retestEntry = retestLimitPrice(s, r);
        const slPrice = computeRetestSL(s, retestEntry);
        const retestSignal = buildRetestSignal(s, retestEntry, slPrice);

        // Resolve from the fill bar forward using the real resolver
        const fillBarIndex = bars.findIndex((b) => b.timestamp === fillTs);
        const barsFromFill = bars.slice(fillBarIndex);
        // Use the original generation time as createdAt but resolve from fill
        const retestSignalWithFillTime = {
          ...retestSignal,
          createdAt: fillTs,
        } as unknown as TradingSignal;

        console.log = () => {};
        const result = resolveSignalWithBars(retestSignalWithFillTime, barsFromFill, {
          fromScratch: true,
          evalNowMs: Math.min(windowEndMs, fillTs + 4 * 60 * 60 * 1000),
          logPrefix: '',
        });
        console.log = origLog;

        // Compute R-multiple from the retest resolution
        const stopDistance = Math.abs(retestEntry - slPrice);
        const isBuy = s.direction === 'BUY';
        const pnl = result.outcomeResult === 'WIN'
          ? (isBuy ? result.exitPrice - retestEntry : retestEntry - result.exitPrice)
          : result.outcomeResult === 'LOSS'
            ? -stopDistance
            : 0;
        const rMult = stopDistance > 0 ? pnl / stopDistance : 0;
        retestResults.push({ r: rMult, status: result.newStatus, pnl });
      }

      // Compute cell metrics
      const filled = retestResults.filter((x) => x.status !== 'MISSED');
      const filledR = filled.map((x) => x.r);
      const filledWins = filledR.filter((x) => x > 0);
      const filledLosses = filledR.filter((x) => x <= 0);
      const grossWin = filledWins.reduce((a, b) => a + b, 0);
      const grossLoss = Math.abs(filledLosses.reduce((a, b) => a + b, 0));
      const evPerOriginal = retestResults.length > 0
        ? retestResults.reduce((a, b) => a + b.r, 0) / retestResults.length
        : 0;
      const netDollars = retestResults.reduce((a, b) => a + b.pnl, 0);
      const fillRate = coveredWithBars.length > 0 ? (filled.length / coveredWithBars.length) * 100 : 0;
      const wrFilled = filledR.length > 0 ? (filledWins.length / filledR.length) * 100 : 0;
      const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

      cells.push({
        depth: r,
        ttl,
        fillRate,
        filledCount: filled.length,
        missedCount: retestResults.length - filled.length,
        wrFilled,
        evPerOriginalSignal: evPerOriginal,
        pf,
        netDollars,
        baselineNetDollars,
      });
    }
  }

  // Print cell table
  console.log('\n  Cell   | Fill Rate   | Filled | Missed | WR(filled) | EV/signal  | PF     | Net $      | Δ EV vs baseline');
  console.log('  ' + '─'.repeat(105));
  for (const c of cells) {
    const deltaEV = c.evPerOriginalSignal - baselineEV;
    const cellLabel = `r=${c.depth.toFixed(1)},TTL=${c.ttl}`;
    console.log(
      `  ${cellLabel.padEnd(12)}| ${(c.fillRate.toFixed(1) + '%').padStart(9)}   | ${String(c.filledCount).padStart(6)} | ${String(c.missedCount).padStart(6)} | ${(c.wrFilled.toFixed(1) + '%').padStart(9)}  | ${c.evPerOriginalSignal.toFixed(4).padStart(9)}R | ${c.pf.toFixed(2).padStart(6)} | $${c.netDollars.toFixed(1).padStart(9)} | ${deltaEV >= 0 ? '+' : ''}${deltaEV.toFixed(4)}R`,
    );
  }

  // ═══ STEP 4 — Decision Table + HARD GATE ═════════════════════════════════
  console.log('\n' + '─'.repeat(90));
  console.log('  STEP 4 — Decision Table + HARD GATE');
  console.log('─'.repeat(90));

  // Find best cell by EV that also clears fill rate >= 40%
  const eligible = cells.filter((c) => c.fillRate >= 40);
  const bestCell = eligible.length > 0
    ? eligible.reduce((best, c) => c.evPerOriginalSignal > best.evPerOriginalSignal ? c : best)
    : null;

  console.log('\n  BASELINE (BREAKOUT, recorded):');
  console.log(`    n=${covered.length}  resolved=${baselineR.length}  WR=${baselineWR.toFixed(1)}%  PF=${baselinePF.toFixed(2)}  EV=${baselineEV.toFixed(4)}R  net=$${baselineNetDollars.toFixed(1)}`);

  if (bestCell) {
    const deltaEV = bestCell.evPerOriginalSignal - baselineEV;
    console.log(`\n  BEST RETEST CELL (r=${bestCell.depth.toFixed(1)}, TTL=${bestCell.ttl}min):`);
    console.log(`    fillRate=${bestCell.fillRate.toFixed(1)}%  filled=${bestCell.filledCount}  WR(filled)=${bestCell.wrFilled.toFixed(1)}%  PF=${bestCell.pf.toFixed(2)}  EV=${bestCell.evPerOriginalSignal.toFixed(4)}R  net=$${bestCell.netDollars.toFixed(1)}`);
    console.log(`    Δ EV vs baseline = ${deltaEV >= 0 ? '+' : ''}${deltaEV.toFixed(4)}R`);

    console.log('\n  ┌─────────────────────────────────────────────────────────┐');
    if (deltaEV >= 0.05 && bestCell.fillRate >= 40) {
      console.log('  │  ✅ HARD GATE CLEARED — proceed to Phase R2            │');
      console.log(`  │  Δ EV = +${deltaEV.toFixed(4)}R >= +0.05R, fillRate = ${bestCell.fillRate.toFixed(1)}% >= 40%  │`);
    } else if (deltaEV >= 0.05) {
      console.log('  │  ⚠️  GATE PARTIAL — EV clears but fill rate < 40%       │');
      console.log(`  │  Δ EV = +${deltaEV.toFixed(4)}R, but fillRate = ${bestCell.fillRate.toFixed(1)}% < 40%  │`);
      console.log('  │  → STOP. Report findings. Propose alternatives.         │');
    } else {
      console.log('  │  ❌ HARD GATE NOT CLEARED — do NOT proceed to Phase R2  │');
      console.log(`  │  Δ EV = ${deltaEV.toFixed(4)}R < +0.05R threshold              │`);
      console.log('  │  → STOP. Report findings. Propose alternatives.         │');
    }
    console.log('  └─────────────────────────────────────────────────────────┘');
  } else {
    console.log('\n  ❌ NO CELL CLEARS fill rate >= 40% — cannot gate in.');
    console.log('  → STOP. Report findings. Propose alternatives.');
  }

  // Direction-split summary
  console.log('\n' + '─'.repeat(90));
  console.log('  DIRECTION SPLIT (covered set, baseline)');
  console.log('─'.repeat(90));
  for (const dir of ['BUY', 'SELL'] as const) {
    const dirSignals = covered.filter((s) => s.direction === dir);
    const dirResolved = dirSignals.filter((s) => s.exitPrice !== null && s.status !== 'CLOSED');
    const dirR = dirResolved.map(rMultiple).filter((v): v is number => v !== null);
    const dirWins = dirR.filter((r) => r > 0);
    const dirLosses = dirR.filter((r) => r <= 0);
    const dirGross = dirWins.reduce((a, b) => a + b, 0);
    const dirGrossLoss = Math.abs(dirLosses.reduce((a, b) => a + b, 0));
    const dirEV = dirR.length ? dirR.reduce((a, b) => a + b, 0) / dirR.length : 0;
    const dirNet = dirSignals.reduce((a, s) => a + (pnlDollars(s) ?? 0), 0);
    const dirWR = dirR.length ? (dirWins.length / dirR.length) * 100 : 0;
    const dirPF = dirGrossLoss > 0 ? dirGross / dirGrossLoss : Infinity;
    console.log(`  ${dir}: n=${dirSignals.length}  resolved=${dirR.length}  WR=${dirWR.toFixed(1)}%  PF=${dirPF.toFixed(2)}  EV=${dirEV.toFixed(4)}R  net=$${dirNet.toFixed(1)}`);
  }

  // MAE signature interpretation
  console.log('\n' + '─'.repeat(90));
  console.log('  BREAKOUT-CHASE SIGNATURE CHECK');
  console.log('─'.repeat(90));
  if (slHitMAE.length > 0) {
    const medianSLMult = median(slHitMAE.map((w) => w.slMult));
    const nearStopFraction = slHitMAE.filter((w) => w.slMult >= 0.9 && w.slMult <= 1.1).length;
    console.log(`  SL_HIT MAE median = ${medianSLMult.toFixed(3)} x SL distance`);
    console.log(`  SL_HIT losers with MAE in [0.9, 1.1] x SL: ${nearStopFraction}/${slHitMAE.length} (${((nearStopFraction / slHitMAE.length) * 100).toFixed(1)}%)`);
    console.log(`  Post-stop continuation to TP1: ${contTp1}/${totalSLHit} (${totalSLHit > 0 ? ((contTp1 / totalSLHit) * 100).toFixed(1) : 0}%)`);
    if (medianSLMult >= 0.85 && medianSLMult <= 1.15 && contTp1 > totalSLHit * 0.3) {
      console.log('  → SIGNATURE CONFIRMED: losers cluster at MAE ≈ 1.0x SL (stopped by retest),');
      console.log('    and a meaningful fraction continues to TP1 after stop-out.');
      console.log('    Direction right, location wrong — retest entry should help.');
    } else {
      console.log('  → SIGNATURE PARTIAL: retest may help but the MAE/continuation evidence is mixed.');
    }
  }

  console.log('\n' + '═'.repeat(90));
  console.log('  Phase R1 analysis complete. No engine code was modified.');
  console.log('═'.repeat(90));
}

main().catch((e) => {
  console.error('Analysis script error:', e);
  process.exit(1);
});
