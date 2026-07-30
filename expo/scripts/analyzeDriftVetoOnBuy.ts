/**
 * Drift-veto-on-BUY investigation (READ-ONLY).
 *
 * The SELL-filter counterfactual found the Phase 2 counter-trend drift veto
 * is over-firing on the SELL side — the 7 SELLs it would have dropped were
 * 100% winners (+0.411R each). Since we're now suppressing SELL entirely,
 * this is lower priority for the short side. BUT: the same drift veto logic
 * applies symmetrically to BUY/counter-trend-long signals. If it's over-firing
 * symmetrically, it may be costing winning LONGS too — which matters greatly
 * now that longs are the entire system.
 *
 * Methodology (same as the six prior counterfactuals):
 *   - Same 164 covered signals from the diagnostic export.
 *   - For each BUY, reconstruct 5-min drift at generation time from real bars.
 *   - Classify which BUYs would be vetoed by the Phase 2 drift veto:
 *       counter-trend BUY (HTF=BEARISH, or HTF=NEUTRAL+LTF=BEARISH, or
 *       HTF=NEUTRAL+RSI<35) AND drift >= 2.0*ATR adverse (price falling)
 *       AND no confirmed sweep override.
 *   - Compare WR/EV/net $ of vetoed vs non-vetoed BUYs.
 *   - Report whether the veto is over-firing on longs and quantify EV impact.
 *
 * No engine changes. Report only.
 *
 * Usage: bunx tsx expo/scripts/analyzeDriftVetoOnBuy.ts <path-to-export.txt>
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface OhlcBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
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
  atr: number | null;
  features: Record<string, number>;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const COVERAGE_START_MS = new Date('2026-07-13T00:00:00Z').getTime();
const PIP = 0.1;
const COUNTER_TREND_DRIFT_ATR_VETO = 2.0;
const COUNTER_TREND_DRIFT_OVERRIDE_CONFIDENCE = 0.85;
const DRIFT_LOOKBACK_CANDLES = 12;

// ─── Parsing (mirrors prior scripts) ─────────────────────────────────────────

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
    const regime = block.match(/\((High|Low|Normal) Volatility \| ATR: ([\d.]+)\)/);

    const features: Record<string, number> = {};
    const fullBlock = block.match(/full attention scores \(\d+ total\):\n([\s\S]*?)(?:\n\s{4}\S|\n\n|$)/);
    if (fullBlock) {
      for (const line of fullBlock[1].split('\n')) {
        const m = line.match(/^\s+([A-Z0-9 _/-]+)=(-?[\d.]+)/);
        if (m) features[m[1].trim()] = parseFloat(m[2]);
      }
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
      atr: num(regime?.[2]),
      features,
    });
  }
  return signals;
}

// ─── Supabase bar fetch ──────────────────────────────────────────────────────

async function fetchSupabaseGoldBars(fromTime: number, toTime: number): Promise<OhlcBar[]> {
  const { data, error } = await supabase
    .from('gold_m1_bars')
    .select('timestamp, open, high, low, close')
    .gte('timestamp', new Date(fromTime).toISOString())
    .lte('timestamp', new Date(toTime).toISOString())
    .order('timestamp', { ascending: true });
  if (error) return [];
  return (data ?? []).map((row: Record<string, unknown>): OhlcBar => ({
    timestamp: new Date(row.timestamp as string).getTime(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function mean(arr: number[]): number {
  if (!arr.length) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ─── HTF trend derivation (same as SELL-filter script) ──────────────────────

const HTF_FEATURE_MAP: Record<string, 'BULLISH' | 'BEARISH' | 'NEUTRAL'> = {
  'HTF LTF BEARISH ALIGNMENT': 'BEARISH',
  'HTF LTF BULLISH ALIGNMENT': 'BULLISH',
  'COUNTER TREND REJECTION SETUP': 'BEARISH',
  'COUNTER TREND BOUNCE SETUP': 'BULLISH',
  'INTRADAY CORRECTION IN UPTREND': 'BULLISH',
  'INTRADAY BOUNCE IN DOWNTREND': 'BEARISH',
  'NEUTRAL HTF OVERSOLD BUY': 'NEUTRAL',
  'NEUTRAL HTF OVERBOUGHT SELL': 'NEUTRAL',
  'LTF MOMENTUM BUY': 'NEUTRAL',
  'LTF MOMENTUM SELL': 'NEUTRAL',
  'STRONG DOWNTREND': 'BEARISH',
  'STRONG UPTREND': 'BULLISH',
  'STRONG UPTREND PATTERN': 'BULLISH',
  'STRONG DOWNTREND PATTERN': 'BEARISH',
};

function htfFromFeatures(features: Record<string, number>): 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null {
  const priority: string[] = [
    'HTF LTF BEARISH ALIGNMENT', 'HTF LTF BULLISH ALIGNMENT',
    'COUNTER TREND REJECTION SETUP', 'COUNTER TREND BOUNCE SETUP',
    'INTRADAY CORRECTION IN UPTREND', 'INTRADAY BOUNCE IN DOWNTREND',
    'NEUTRAL HTF OVERSOLD BUY', 'NEUTRAL HTF OVERBOUGHT SELL',
    'LTF MOMENTUM BUY', 'LTF MOMENTUM SELL',
    'STRONG DOWNTREND', 'STRONG UPTREND',
    'STRONG UPTREND PATTERN', 'STRONG DOWNTREND PATTERN',
  ];
  for (const key of priority) {
    if (features[key] !== undefined) return HTF_FEATURE_MAP[key] ?? null;
  }
  return null;
}

function ltfFromBars(bars: OhlcBar[]): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (bars.length < 5) return 'NEUTRAL';
  const recent5 = bars.slice(-5).map((b) => b.close);
  const avg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
  const currentPrice = bars[bars.length - 1].close;
  const momentum = currentPrice - avg;
  const ranges = bars.slice(-20).map((b) => b.high - b.low);
  const volatility = ranges.length ? mean(ranges) : 0.5;
  const threshold = Math.max(currentPrice * 0.00005, Math.min(currentPrice * 0.0005, volatility * 0.3));
  if (momentum > threshold) return 'BULLISH';
  if (momentum < -threshold) return 'BEARISH';
  return 'NEUTRAL';
}

function rsiFromBars(bars: OhlcBar[], period: number = 14): number {
  if (bars.length < period + 1) return 50;
  const closes = bars.slice(-(period + 1)).map((b) => b.close);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function driftFromBars(bars: OhlcBar[]): number | null {
  if (bars.length < 60) return null;
  const fiveMinCandles: { open: number; high: number; low: number; close: number; ts: number }[] = [];
  const bucketSize = 5 * 60 * 1000;
  for (const bar of bars) {
    const bucket = Math.floor(bar.timestamp / bucketSize) * bucketSize;
    const existing = fiveMinCandles.find((c) => c.ts === bucket);
    if (existing) {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
    } else {
      fiveMinCandles.push({ open: bar.open, high: bar.high, low: bar.low, close: bar.close, ts: bucket });
    }
  }
  if (fiveMinCandles.length < 3) return null;
  const window = fiveMinCandles.slice(-Math.max(3, DRIFT_LOOKBACK_CANDLES));
  const first = window[0];
  const last = window[window.length - 1];
  if (!first || !last) return null;
  return last.close - first.open;
}

// ─── Counter-trend classification for BUY ────────────────────────────────────

function isCounterTrendBuy(
  htf: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  ltf: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  rsi: number,
): boolean {
  // Symmetric to the SELL counter-trend classification:
  // BUY is counter-trend when HTF is BEARISH, or HTF=NEUTRAL+LTF=BEARISH, or HTF=NEUTRAL+RSI<35
  return (
    htf === 'BEARISH' ||
    (htf === 'NEUTRAL' && ltf === 'BEARISH') ||
    (htf === 'NEUTRAL' && rsi < 35)
  );
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

interface Metrics {
  n: number;
  nResolved: number;
  winRate: number;
  pf: number;
  evR: number;
  netDollars: number;
}

function computeMetrics(signals: ParsedSignal[]): Metrics {
  const resolved = signals.filter((s) => s.exitPrice !== null && s.status !== 'CLOSED');
  const rs = resolved.map(rMultiple).filter((v): v is number => v !== null);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const gross = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const evR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  const winRate = rs.length ? (wins.length / rs.length) * 100 : 0;
  const pf = grossLoss > 0 ? gross / grossLoss : (gross > 0 ? Infinity : 0);
  const dollars = resolved.map(pnlDollars).filter((v): v is number => v !== null);
  const netDollars = dollars.reduce((a, b) => a + b, 0);
  return { n: signals.length, nResolved: rs.length, winRate, pf, evR, netDollars };
}

function fmtMetrics(m: Metrics): string {
  const pfStr = Number.isFinite(m.pf) ? m.pf.toFixed(2) : 'inf';
  return `n=${String(m.n).padStart(3)} (res=${String(m.nResolved).padStart(3)})  WR=${m.winRate.toFixed(1).padStart(5)}%  PF=${pfStr.padStart(5)}  EV=${m.evR.toFixed(4).padStart(7)}R  net=$${m.netDollars.toFixed(1).padStart(7)}`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const exportPath = process.argv[2] ?? '/tmp/diag_export.txt';
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  DRIFT-VETO-ON-BUY INVESTIGATION (read-only)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const allSignals = parseExport(exportPath);
  const covered = allSignals
    .filter((s) => s.generatedMs >= COVERAGE_START_MS)
    .sort((a, b) => a.generatedMs - b.generatedMs);
  console.log(`Covered signals: ${covered.length}`);

  const buySignals = covered.filter((s) => s.direction === 'BUY');
  console.log(`BUY signals: ${buySignals.length}\n`);

  // Fetch backward bars for drift reconstruction
  console.log('Fetching backward gold_m1_bars (24h lookback) for drift reconstruction...');
  const backwardBars = new Map<number, OhlcBar[]>();
  let fetched = 0;
  for (const s of buySignals) {
    const bars = await fetchSupabaseGoldBars(s.generatedMs - 24 * 60 * 60 * 1000, s.generatedMs);
    if (bars.length > 0) {
      backwardBars.set(s.index, bars);
      fetched++;
    }
  }
  console.log(`  Fetched bars for ${fetched}/${buySignals.length} BUY signals`);

  // Classify each BUY
  console.log('\nClassifying BUYs (HTF, LTF, RSI, drift, counter-trend, veto)...');
  interface BuyClassification {
    signal: ParsedSignal;
    htf: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    ltf: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    rsi: number;
    drift: number | null;
    isCounterTrend: boolean;
    driftVetoed: boolean;
  }

  const classified: BuyClassification[] = [];
  let ctCount = 0;
  let vetoedCount = 0;

  for (const s of buySignals) {
    const bars = backwardBars.get(s.index) ?? [];
    const htfFeature = htfFromFeatures(s.features);
    const htf = htfFeature ?? 'NEUTRAL';
    const ltf = ltfFromBars(bars);
    const rsi = rsiFromBars(bars);
    const drift = driftFromBars(bars);

    const isCT = isCounterTrendBuy(htf, ltf, rsi);
    if (isCT) ctCount++;

    // Drift veto: counter-trend BUY + adverse drift (price falling, drift < 0)
    // drift < 0 means price is falling = adverse for BUY
    let driftVetoed = false;
    if (isCT && drift !== null && s.atr !== null && s.atr > 0) {
      const driftAdverse = -drift; // negative drift = falling = adverse for BUY
      const threshold = s.atr * COUNTER_TREND_DRIFT_ATR_VETO;
      if (driftAdverse >= threshold) {
        // Check override: sweep confirmed + confidence >= 85%
        const hasSweep = s.features['SESSION HIGH SWEEP'] !== undefined || s.features['SESSION LOW SWEEP'] !== undefined;
        const highConfidence = s.confidence >= COUNTER_TREND_DRIFT_OVERRIDE_CONFIDENCE * 100;
        if (!(hasSweep && highConfidence)) {
          driftVetoed = true;
          vetoedCount++;
        }
      }
    }

    classified.push({ signal: s, htf, ltf, rsi, drift, isCounterTrend: isCT, driftVetoed });
  }

  console.log(`  Counter-trend BUYs: ${ctCount}/${buySignals.length}`);
  console.log(`  Drift-vetoed BUYs: ${vetoedCount}/${buySignals.length}`);

  // Split into vetoed vs kept
  const vetoed = classified.filter((c) => c.driftVetoed).map((c) => c.signal);
  const kept = classified.filter((c) => !c.driftVetoed).map((c) => c.signal);
  const ctKept = classified.filter((c) => c.isCounterTrend && !c.driftVetoed).map((c) => c.signal);
  const nonCT = classified.filter((c) => !c.isCounterTrend).map((c) => c.signal);

  // Report metrics
  console.log('\n' + '═'.repeat(90));
  console.log('  RESULTS');
  console.log('═'.repeat(90));

  console.log('\n  All BUYs (baseline):');
  console.log(`    ${fmtMetrics(computeMetrics(buySignals))}`);

  console.log('\n  Non-counter-trend BUYs (not subject to drift veto):');
  if (nonCT.length > 0) {
    console.log(`    ${fmtMetrics(computeMetrics(nonCT))}`);
  } else {
    console.log('    (none)');
  }

  console.log('\n  Counter-trend BUYs kept (veto did NOT fire):');
  if (ctKept.length > 0) {
    console.log(`    ${fmtMetrics(computeMetrics(ctKept))}`);
  } else {
    console.log('    (none)');
  }

  console.log('\n  Counter-trend BUYs VETOED (drift veto would have dropped these):');
  if (vetoed.length > 0) {
    const vetoedMetrics = computeMetrics(vetoed);
    console.log(`    ${fmtMetrics(vetoedMetrics)}`);
    const vetoedRs = vetoed.map(rMultiple).filter((v): v is number => v !== null);
    const vetoedWinRate = vetoedMetrics.winRate;
    const allWinners = vetoedRs.every((r) => r > 0);
    console.log(`    Win rate: ${vetoedWinRate.toFixed(1)}%`);
    console.log(`    All winners? ${allWinners ? '⚠️ YES — veto is over-firing, dropping winning longs' : 'no'}`);
    if (vetoedRs.length > 0) {
      console.log(`    R-multiples: ${vetoedRs.map((r) => r.toFixed(3)).join(', ')}`);
      const avgR = mean(vetoedRs);
      console.log(`    Average R: ${avgR.toFixed(4)}`);
      console.log(`    Total EV lost if vetoed: ${(avgR * vetoedRs.length).toFixed(4)}R = $${vetoedMetrics.netDollars.toFixed(1)}`);
    }
  } else {
    console.log('    (none — drift veto did not fire on any BUY)');
  }

  // System-wide impact
  console.log('\n' + '═'.repeat(90));
  console.log('  SYSTEM-WIDE IMPACT');
  console.log('═'.repeat(90));

  const allBuyMetrics = computeMetrics(buySignals);
  const keptMetrics = computeMetrics(kept);
  const evDelta = allBuyMetrics.evR - keptMetrics.evR;
  const netDelta = allBuyMetrics.netDollars - keptMetrics.netDollars;

  console.log(`\n  All BUYs:    ${fmtMetrics(allBuyMetrics)}`);
  console.log(`  Kept BUYs:   ${fmtMetrics(keptMetrics)}`);
  console.log(`  EV delta:    ${evDelta >= 0 ? '+' : ''}${evDelta.toFixed(4)}R per signal`);
  console.log(`  Net $ delta: ${netDelta >= 0 ? '+' : ''}$${netDelta.toFixed(1)}`);
  console.log(`  Signals dropped by veto: ${vetoed.length}/${buySignals.length} (${((vetoed.length / buySignals.length) * 100).toFixed(1)}%)`);

  // Verdict
  console.log('\n' + '═'.repeat(90));
  console.log('  VERDICT');
  console.log('═'.repeat(90));

  if (vetoed.length === 0) {
    console.log('\n  The drift veto did NOT fire on any BUY in the covered sample.');
    console.log('  → No evidence of over-firing on longs. The veto appears SELL-side only');
    console.log('    in practice (BUYs rarely have HTF=BEARISH + adverse drift >= 2.0*ATR).');
    console.log('  → No action needed for the long side.');
  } else {
    const vetoedMetrics = computeMetrics(vetoed);
    const vetoedIsProfitable = vetoedMetrics.evR > 0;
    const allWinners = vetoed.map(rMultiple).filter((v): v is number => v !== null).every((r) => r > 0);

    if (vetoedIsProfitable) {
      console.log(`\n  ⚠️  The drift veto IS over-firing on BUYs: it dropped ${vetoed.length} BUYs`);
      console.log(`  that had positive EV (${vetoedMetrics.evR.toFixed(4)}R).`);
      if (allWinners) {
        console.log(`  ALL ${vetoed.length} vetoed BUYs were winners.`);
      }
      console.log(`  → The veto is costing the long book ${Math.abs(netDelta).toFixed(1)} in net $`);
      console.log(`  and ${Math.abs(evDelta).toFixed(4)}R in EV per signal.`);
      console.log(`  → Now that longs are the entire system, this is a real finding that`);
      console.log(`    deserves a fix investigation. The veto threshold (2.0*ATR) may be too`);
      console.log(`    low for BUYs, or the counter-trend classification may be too broad.`);
      console.log(`  → REPORT ONLY — do not fix yet (per the approved plan).`);
    } else {
      console.log(`\n  The drift veto dropped ${vetoed.length} BUYs with EV ${vetoedMetrics.evR.toFixed(4)}R.`);
      console.log(`  These were NOT profitable (EV <= 0), so the veto appears to be working`);
      console.log(`  correctly on the long side — it's dropping genuinely bad counter-trend longs.`);
      console.log(`  → No evidence of over-firing on BUYs.`);
    }
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
