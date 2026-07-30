/**
 * SELL-SIDE COUNTERFACTUAL — Filter treatments on SELL signals only.
 *
 * Same 164 covered signals, same real Vantage bars as the three prior
 * counterfactuals (retest, zone-SL, fixed-120-SL). Unlike those, these are
 * PURE FILTERS: they keep or drop SELL signals without changing entry/SL
 * geometry, so outcomes come from the RECORDED export directly (no
 * re-resolution). BUY signals pass through unchanged in every variant.
 *
 * Treatments:
 *   1. SUPPRESS ALL SELL — drop every SELL. The honest baseline-of-comparison.
 *   2. HTF-ALIGNED SELL — keep SELL only when HTF trend is BEARISH.
 *   3. SESSION-FILTERED SELL — drop SELL in the worst hours/sessions.
 *   4. DRIFT-VETOED SELL — replicate the Phase 2 drift veto retroactively.
 *   5. BEST COMBINATION — stack whichever of 2-4 individually clear.
 *
 * PRE-REGISTERED HARD GATE (stated before running):
 *   A SELL treatment is worth implementing only if:
 *     (a) SELL book's OWN EV >= +0.10R (clearly positive, not just less-negative)
 *     (b) WHOLE system (filtered SELL + unchanged BUY) EV >= +0.1306R
 *         (baseline +0.0806R + 0.05R improvement)
 *     (c) >= 30% of current SELL signals survive (not just option 1 in disguise)
 *
 * CRITICAL HONESTY: flag small-sample cells (n < 20). Report generalizable
 * vs overfit for any treatment that passes.
 *
 * HTF trend derivation:
 *   - Primary: feature signatures in the export (ground truth from the engine's
 *     detectHTFTrend routing). Covers ~50% of SELLs.
 *   - Fallback: reconstructed from real bars (prior-day pivot, EMA9/21,
 *     trendStrength, priceDirection) — labeled APPROXIMATED.
 *
 * Drift derivation:
 *   - Always reconstructed from real bars: aggregate 1m → 5m candles, compute
 *     last 12 5m candle drift (last.close - first.open), matching the engine's
 *     computeRecentDrift(DRIFT_LOOKBACK_CANDLES=12).
 *
 * Read-only. No engine changes. No re-resolution.
 *
 * Usage: bunx tsx expo/scripts/analyzeSellSideFilters.ts <path-to-export.txt>
 */
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ─── Parsing (mirrors analyzeFixedSL120.ts / auditDiagnosticsReport.ts) ──────

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
const COVERAGE_START_MS = new Date('2026-07-13T00:00:00Z').getTime();
const BASELINE_EV_R = 0.0806;
const GATE_EV_IMPROVEMENT_R = 0.05;
const GATE_SELL_EV_MIN_R = 0.10;
const GATE_SELL_SURVIVAL_MIN_PCT = 30;

const COUNTER_TREND_DRIFT_ATR_VETO = 2.0;
const COUNTER_TREND_DRIFT_OVERRIDE_CONFIDENCE = 0.85;
const DRIFT_LOOKBACK_CANDLES = 12;
const BLOCKED_UTC_HOURS: readonly number[] = [4, 11];

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

function session(s: ParsedSignal): 'ASIA' | 'LONDON' | 'NY' | 'NY_PM' {
  const h = new Date(s.generatedMs).getUTCHours();
  if (h >= 0 && h < 7) return 'ASIA';
  if (h >= 7 && h < 12) return 'LONDON';
  if (h >= 12 && h < 17) return 'NY';
  return 'NY_PM';
}

function utcHour(s: ParsedSignal): number {
  return new Date(s.generatedMs).getUTCHours();
}

// ─── HTF trend derivation ────────────────────────────────────────────────────

/**
 * Map engine feature keys to the HTF trend that produced them.
 * These are ground-truth: the engine's detectHTFTrend routing fired these
 * features, so their presence definitively reveals the HTF classification.
 */
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

/**
 * Derive HTF trend from feature signatures (ground truth). Returns null when
 * no HTF-indicating feature is present — caller must fall back to bar
 * reconstruction.
 */
function htfFromFeatures(features: Record<string, number>): 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null {
  // Priority: alignment features > counter-trend > neutral routing > trend strength
  const priority: string[] = [
    'HTF LTF BEARISH ALIGNMENT',
    'HTF LTF BULLISH ALIGNMENT',
    'COUNTER TREND REJECTION SETUP',
    'COUNTER TREND BOUNCE SETUP',
    'INTRADAY CORRECTION IN UPTREND',
    'INTRADAY BOUNCE IN DOWNTREND',
    'NEUTRAL HTF OVERSOLD BUY',
    'NEUTRAL HTF OVERBOUGHT SELL',
    'LTF MOMENTUM BUY',
    'LTF MOMENTUM SELL',
    'STRONG DOWNTREND',
    'STRONG UPTREND',
    'STRONG UPTREND PATTERN',
    'STRONG DOWNTREND PATTERN',
  ];
  for (const key of priority) {
    if (features[key] !== undefined) {
      return HTF_FEATURE_MAP[key] ?? null;
    }
  }
  return null;
}

/**
 * Reconstruct HTF trend from real 1-minute bars, approximating the engine's
 * detectHTFTrend logic. Uses prior-day pivot + trendStrength + EMA9/21.
 * Labeled APPROXIMATED — the engine uses tick-level priceHistory, not 1m closes.
 */
function htfFromBars(entry: number, bars: OhlcBar[]): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (bars.length < 21) return 'NEUTRAL';

  // Prior UTC day's OHLC for pivot computation
  const genDate = new Date(bars[bars.length - 1].timestamp).toISOString().slice(0, 10);
  const priorDayBars = bars.filter((b) => {
    const d = new Date(b.timestamp).toISOString().slice(0, 10);
    return d < genDate;
  });

  let pivot: number;
  if (priorDayBars.length > 0) {
    const highs = priorDayBars.map((b) => b.high);
    const lows = priorDayBars.map((b) => b.low);
    const priorHigh = Math.max(...highs);
    const priorLow = Math.min(...lows);
    const priorClose = priorDayBars[priorDayBars.length - 1].close;
    pivot = (priorHigh + priorLow + priorClose) / 3;
  } else {
    // No prior day bars — use the first available bar's open as a proxy
    pivot = bars[0].open;
  }

  const priceVsPivot = entry - pivot;

  // trendStrength over last 20 1m closes (proxy for 20 tick prices)
  const closes20 = bars.slice(-20).map((b) => b.close);
  const first20 = closes20[0];
  const last20 = closes20[closes20.length - 1];
  const netMove = Math.abs(last20 - first20);
  let totalMove = 0;
  for (let i = 1; i < closes20.length; i++) {
    totalMove += Math.abs(closes20[i] - closes20[i - 1]);
  }
  const trendStrength = totalMove === 0 ? 0 : Math.min(1.0, netMove / totalMove);

  // priceDirection over last 5 1m closes (proxy for 5 tick prices)
  const closes5 = bars.slice(-5).map((b) => b.close);
  const diff5 = closes5[closes5.length - 1] - closes5[0];
  const priceDirection = diff5 > 1 ? 1 : diff5 < -1 ? -1 : 0;

  // EMA9 and EMA21 over 1m closes
  function ema(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1] ?? 0;
    const k = 2 / (period + 1);
    let e = values[0];
    for (let i = 1; i < values.length; i++) {
      e = values[i] * k + e * (1 - k);
    }
    return e;
  }
  const allCloses = bars.map((b) => b.close);
  const emaSignal = ema(allCloses.slice(-50), 9) - ema(allCloses.slice(-50), 21);

  const bullishScore = (priceVsPivot > 10 ? 1 : 0) + (trendStrength > 0.4 && priceDirection > 0 ? 1 : 0) + (emaSignal > 0 ? 0.5 : 0);
  const bearishScore = (priceVsPivot < -10 ? 1 : 0) + (trendStrength > 0.4 && priceDirection < 0 ? 1 : 0) + (emaSignal < 0 ? 0.5 : 0);

  if (bullishScore >= 1.5) return 'BULLISH';
  if (bearishScore >= 1.5) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * Reconstruct LTF trend from 1-minute bars, approximating detectLTFTrend.
 */
function ltfFromBars(bars: OhlcBar[]): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (bars.length < 5) return 'NEUTRAL';
  const recent5 = bars.slice(-5).map((b) => b.close);
  const avg = recent5.reduce((a, b) => a + b, 0) / recent5.length;
  const currentPrice = bars[bars.length - 1].close;
  const momentum = currentPrice - avg;

  // Approximate volatility from bar ranges
  const ranges = bars.slice(-20).map((b) => b.high - b.low);
  const volatility = ranges.length ? mean(ranges) : 0.5;
  const threshold = Math.max(currentPrice * 0.00005, Math.min(currentPrice * 0.0005, volatility * 0.3));

  if (momentum > threshold) return 'BULLISH';
  if (momentum < -threshold) return 'BEARISH';
  return 'NEUTRAL';
}

/**
 * Reconstruct RSI(14) from 1-minute closes.
 */
function rsiFromBars(bars: OhlcBar[], period: number = 14): number {
  if (bars.length < period + 1) return 50;
  const closes = bars.slice(-(period + 1)).map((b) => b.close);
  let gains = 0;
  let losses = 0;
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

/**
 * Compute recent drift from 1-minute bars, matching the engine's
 * computeRecentDrift(DRIFT_LOOKBACK_CANDLES=12): aggregate 1m → 5m candles,
 * take last 12, drift = last.close - first.open.
 */
function driftFromBars(bars: OhlcBar[]): number | null {
  if (bars.length < 60) return null; // need at least 60 1m bars for 12 5m candles

  // Aggregate 1m bars into 5m candles
  const fiveMinCandles: { open: number; high: number; low: number; close: number; ts: number }[] = [];
  const bucketSize = 5 * 60 * 1000; // 5 min in ms

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

// ─── Counter-trend classification (Phase 2 logic) ────────────────────────────

function isCounterTrendSell(
  htf: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  ltf: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
  rsi: number,
): boolean {
  return (
    htf === 'BULLISH' ||
    (htf === 'NEUTRAL' && ltf === 'BULLISH') ||
    (htf === 'NEUTRAL' && rsi > 65)
  );
}

// ─── Metrics computation ─────────────────────────────────────────────────────

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
  const avgRisk = mean(resolved.map(riskDollars));
  const evDollars = evR * avgRisk;

  return {
    n: signals.length,
    nResolved: rs.length,
    winRate,
    pf,
    evR,
    evDollars,
    netDollars,
    avgRiskDollars: avgRisk,
  };
}

function fmtMetrics(m: Metrics): string {
  const pfStr = Number.isFinite(m.pf) ? m.pf.toFixed(2) : 'inf';
  return `n=${String(m.n).padStart(3)} (res=${String(m.nResolved).padStart(3)})  WR=${m.winRate.toFixed(1).padStart(5)}%  PF=${pfStr.padStart(5)}  EV=${m.evR.toFixed(4).padStart(7)}R  EV$=${m.evDollars.toFixed(3).padStart(7)}  net=$${m.netDollars.toFixed(1).padStart(7)}`;
}

// ─── Signal classification for treatments ───────────────────────────────────

interface ClassifiedSignal {
  signal: ParsedSignal;
  htf: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  htfSource: 'FEATURE' | 'APPROXIMATED';
  ltf: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  rsi: number;
  session: 'ASIA' | 'LONDON' | 'NY' | 'NY_PM';
  utcHour: number;
  drift: number | null;
  isCounterTrend: boolean;
  driftVetoed: boolean;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const exportPath = process.argv[2] ?? '/tmp/diag_export.txt';
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  SELL-SIDE COUNTERFACTUAL — FILTER TREATMENTS (read-only)');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  console.log('  PRE-REGISTERED HARD GATE (stated before running):');
  console.log(`    Baseline EV = ${BASELINE_EV_R}R (original-R, from Phase R1)`);
  console.log(`    (a) SELL book OWN EV >= +${GATE_SELL_EV_MIN_R}R (clearly positive)`);
  console.log(`    (b) WHOLE system EV >= +${(BASELINE_EV_R + GATE_EV_IMPROVEMENT_R).toFixed(4)}R (baseline + ${GATE_EV_IMPROVEMENT_R}R)`);
  console.log(`    (c) SELL survival >= ${GATE_SELL_SURVIVAL_MIN_PCT}% of current SELL count`);
  console.log(`    Small-sample flag: n < 20 → gate cannot clear on that cell alone\n`);

  const allSignals = parseExport(exportPath);
  console.log(`Parsed ${allSignals.length} signals from export.`);

  const covered = allSignals
    .filter((s) => s.generatedMs >= COVERAGE_START_MS)
    .sort((a, b) => a.generatedMs - b.generatedMs);
  console.log(`Signals with Vantage bar coverage (>= 2026-07-13): ${covered.length}`);

  const coveredBuy = covered.filter((s) => s.direction === 'BUY');
  const coveredSell = covered.filter((s) => s.direction === 'SELL');
  console.log(`  BUY: ${coveredBuy.length}  SELL: ${coveredSell.length}`);

  // Baseline metrics
  const baselineAll = computeMetrics(covered);
  const baselineBuy = computeMetrics(coveredBuy);
  const baselineSell = computeMetrics(coveredSell);
  console.log(`\n  Baseline (all covered, n=${covered.length}):`);
  console.log(`    ${fmtMetrics(baselineAll)}`);
  console.log(`  Baseline BUY only:`);
  console.log(`    ${fmtMetrics(baselineBuy)}`);
  console.log(`  Baseline SELL only:`);
  console.log(`    ${fmtMetrics(baselineSell)}`);

  // Fetch backward bars for HTF/drift reconstruction
  console.log('\nFetching backward gold_m1_bars (24h lookback) for HTF + drift reconstruction...');
  const backwardBars = new Map<number, OhlcBar[]>();
  let fetched = 0;
  let noBars = 0;
  for (const s of covered) {
    const fromTime = s.generatedMs - 24 * 60 * 60 * 1000; // 24h lookback
    const toTime = s.generatedMs;
    const bars = await fetchSupabaseGoldBars(fromTime, toTime);
    if (bars.length === 0) {
      noBars++;
    } else {
      backwardBars.set(s.index, bars);
      fetched++;
    }
  }
  console.log(`  Fetched bars for ${fetched}/${covered.length} signals (${noBars} had no bars).`);

  // Classify each signal
  console.log('\nClassifying signals (HTF, LTF, RSI, drift, session)...');
  const classified: ClassifiedSignal[] = [];
  let htfFeatureCount = 0;
  let htfApproxCount = 0;
  let driftAvailable = 0;

  for (const s of covered) {
    const bars = backwardBars.get(s.index) ?? [];

    // HTF: feature signature first, then bar reconstruction
    const htfFeature = htfFromFeatures(s.features);
    let htf: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    let htfSource: 'FEATURE' | 'APPROXIMATED';
    if (htfFeature !== null) {
      htf = htfFeature;
      htfSource = 'FEATURE';
      htfFeatureCount++;
    } else {
      htf = htfFromBars(s.entry, bars);
      htfSource = 'APPROXIMATED';
      htfApproxCount++;
    }

    const ltf = ltfFromBars(bars);
    const rsi = rsiFromBars(bars);
    const sess = session(s);
    const hour = utcHour(s);
    const drift = driftFromBars(bars);
    if (drift !== null) driftAvailable++;

    const isCT = s.direction === 'SELL' && isCounterTrendSell(htf, ltf, rsi);

    // Drift veto: only for counter-trend SELLs
    let driftVetoed = false;
    if (s.direction === 'SELL' && isCT && drift !== null && s.atr !== null && s.atr > 0) {
      const driftAgainst = drift; // positive drift = price climbing = against SELL
      const threshold = s.atr * COUNTER_TREND_DRIFT_ATR_VETO;
      if (driftAgainst >= threshold) {
        // Check override: sweep confirmed + confidence >= 85%
        const hasSweep = s.features['SESSION HIGH SWEEP'] !== undefined || s.features['SESSION LOW SWEEP'] !== undefined;
        const highConfidence = s.confidence >= COUNTER_TREND_DRIFT_OVERRIDE_CONFIDENCE * 100;
        if (!(hasSweep && highConfidence)) {
          driftVetoed = true;
        }
      }
    }

    classified.push({
      signal: s,
      htf,
      htfSource,
      ltf,
      rsi,
      session: sess,
      utcHour: hour,
      drift,
      isCounterTrend: isCT,
      driftVetoed,
    });
  }

  console.log(`  HTF from features: ${htfFeatureCount}  HTF approximated: ${htfApproxCount}`);
  console.log(`  Drift available: ${driftAvailable}/${covered.length}`);

  // HTF distribution for SELLs
  const sellClassified = classified.filter((c) => c.signal.direction === 'SELL');
  const sellHtfDist = new Map<string, number>();
  for (const c of sellClassified) {
    const key = `${c.htf} (${c.htfSource})`;
    sellHtfDist.set(key, (sellHtfDist.get(key) ?? 0) + 1);
  }
  console.log('\n  SELL HTF distribution:');
  for (const [k, v] of [...sellHtfDist.entries()].sort()) {
    console.log(`    ${k.padEnd(22)} ${v}`);
  }

  // SELL performance by HTF (diagnostic)
  console.log('\n  SELL performance by HTF (diagnostic):');
  for (const htf of ['BULLISH', 'BEARISH', 'NEUTRAL'] as const) {
    const subset = sellClassified.filter((c) => c.htf === htf).map((c) => c.signal);
    if (subset.length === 0) continue;
    const m = computeMetrics(subset);
    console.log(`    HTF=${htf.padEnd(8)} ${fmtMetrics(m)}`);
  }

  // SELL performance by session (diagnostic)
  console.log('\n  SELL performance by session (diagnostic):');
  for (const sess of ['ASIA', 'LONDON', 'NY', 'NY_PM'] as const) {
    const subset = sellClassified.filter((c) => c.session === sess).map((c) => c.signal);
    if (subset.length === 0) continue;
    const m = computeMetrics(subset);
    const smallFlag = subset.length < 20 ? ' ⚠️ SMALL SAMPLE' : '';
    console.log(`    ${sess.padEnd(8)} ${fmtMetrics(m)}${smallFlag}`);
  }

  // SELL performance by UTC hour (diagnostic)
  console.log('\n  SELL performance by UTC hour (diagnostic):');
  const sellByHour = new Map<number, ParsedSignal[]>();
  for (const c of sellClassified) {
    const arr = sellByHour.get(c.utcHour) ?? [];
    arr.push(c.signal);
    sellByHour.set(c.utcHour, arr);
  }
  for (const h of [...sellByHour.keys()].sort((a, b) => a - b)) {
    const subset = sellByHour.get(h)!;
    const m = computeMetrics(subset);
    const smallFlag = subset.length < 20 ? ' ⚠️ SMALL' : '';
    console.log(`    h${String(h).padStart(2, '0')} ${fmtMetrics(m)}${smallFlag}`);
  }

  // SELL drift veto diagnostic
  console.log('\n  SELL drift veto diagnostic:');
  const ctSells = sellClassified.filter((c) => c.isCounterTrend);
  const ctVetoed = ctSells.filter((c) => c.driftVetoed);
  const ctKept = ctSells.filter((c) => !c.driftVetoed);
  console.log(`    Counter-trend SELLs: ${ctSells.length}  (vetoed: ${ctVetoed.length}, kept: ${ctKept.length})`);
  if (ctKept.length > 0) {
    const mKept = computeMetrics(ctKept.map((c) => c.signal));
    console.log(`    CT kept:    ${fmtMetrics(mKept)}`);
  }
  if (ctVetoed.length > 0) {
    const mVetoed = computeMetrics(ctVetoed.map((c) => c.signal));
    console.log(`    CT vetoed:  ${fmtMetrics(mVetoed)}`);
  }
  const nonCTSells = sellClassified.filter((c) => !c.isCounterTrend);
  if (nonCTSells.length > 0) {
    const mNonCT = computeMetrics(nonCTSells.map((c) => c.signal));
    console.log(`    Non-CT:     ${fmtMetrics(mNonCT)}`);
  }

  // ═══ TREATMENT 1 — SUPPRESS ALL SELL ══════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  TREATMENT 1 — SUPPRESS ALL SELL (BUY-only system)');
  console.log('═'.repeat(90));

  const t1Signals = coveredBuy;
  const t1Metrics = computeMetrics(t1Signals);
  const t1SellSurvivalPct = 0; // all SELLs dropped
  console.log(`\n  ${fmtMetrics(t1Metrics)}`);
  console.log(`  SELL signals retained: 0 / ${coveredSell.length} (0.0%)`);
  console.log(`  Signals/day: ${covered.length}/${30} = ${(covered.length / 30).toFixed(1)}/day → ${t1Signals.length}/${30} = ${(t1Signals.length / 30).toFixed(1)}/day`);

  // ═══ TREATMENT 2 — HTF-ALIGNED SELL ONLY ═══════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  TREATMENT 2 — HTF-ALIGNED SELL ONLY (keep SELL when HTF = BEARISH)');
  console.log('═'.repeat(90));

  const t2SellKept = sellClassified.filter((c) => c.htf === 'BEARISH').map((c) => c.signal);
  const t2Signals = [...coveredBuy, ...t2SellKept];
  const t2Metrics = computeMetrics(t2Signals);
  const t2SellMetrics = computeMetrics(t2SellKept);
  const t2SellSurvivalPct = (t2SellKept.length / coveredSell.length) * 100;
  console.log(`\n  SELL retained: ${t2SellKept.length} / ${coveredSell.length} (${t2SellSurvivalPct.toFixed(1)}%)`);
  console.log(`  SELL-only book:  ${fmtMetrics(t2SellMetrics)}`);
  console.log(`  Whole system:    ${fmtMetrics(t2Metrics)}`);

  // Feature vs approximated breakdown for kept SELLs
  const t2FeatureKept = sellClassified.filter((c) => c.htf === 'BEARISH' && c.htfSource === 'FEATURE').length;
  const t2ApproxKept = sellClassified.filter((c) => c.htf === 'BEARISH' && c.htfSource === 'APPROXIMATED').length;
  console.log(`  HTF source: ${t2FeatureKept} feature-confirmed, ${t2ApproxKept} bar-approximated`);

  // ═══ TREATMENT 3 — SESSION-FILTERED SELL ═══════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  TREATMENT 3 — SESSION-FILTERED SELL (drop SELL in worst hours/sessions)');
  console.log('═'.repeat(90));

  // Test multiple session filters
  const sessionFilters: { name: string; keep: (c: ClassifiedSignal) => boolean }[] = [
    {
      name: 'drop h04/h11/h12',
      keep: (c) => ![4, 11, 12].includes(c.utcHour),
    },
    {
      name: 'drop h04/h11/h12 + NY_PM',
      keep: (c) => ![4, 11, 12].includes(c.utcHour) && c.session !== 'NY_PM',
    },
    {
      name: 'drop NY_PM only (h17-23)',
      keep: (c) => c.session !== 'NY_PM',
    },
    {
      name: 'keep LONDON+NY only (h07-h16)',
      keep: (c) => c.utcHour >= 7 && c.utcHour <= 16,
    },
    {
      name: 'drop h12 + NY_PM',
      keep: (c) => c.utcHour !== 12 && c.session !== 'NY_PM',
    },
  ];

  let bestT3Name = '';
  let bestT3Metrics: Metrics | null = null;
  let bestT3SellKept: ParsedSignal[] = [];
  let bestT3SellMetrics: Metrics | null = null;

  for (const filter of sessionFilters) {
    const sellKept = sellClassified.filter((c) => filter.keep(c)).map((c) => c.signal);
    const allSignalsFiltered = [...coveredBuy, ...sellKept];
    const m = computeMetrics(allSignalsFiltered);
    const sellM = computeMetrics(sellKept);
    const survival = (sellKept.length / coveredSell.length) * 100;
    const smallFlag = sellKept.length < 20 ? ' ⚠️ SMALL' : '';
    console.log(`\n  Filter: ${filter.name}`);
    console.log(`    SELL retained: ${sellKept.length} / ${coveredSell.length} (${survival.toFixed(1)}%)${smallFlag}`);
    console.log(`    SELL-only:  ${fmtMetrics(sellM)}`);
    console.log(`    Whole:      ${fmtMetrics(m)}`);

    if (!bestT3Metrics || m.evR > bestT3Metrics.evR) {
      bestT3Metrics = m;
      bestT3Name = filter.name;
      bestT3SellKept = sellKept;
      bestT3SellMetrics = sellM;
    }
  }

  console.log(`\n  Best session filter: "${bestT3Name}"`);
  console.log(`    ${fmtMetrics(bestT3Metrics!)}`);
  const t3Metrics = bestT3Metrics!;
  const t3SellSurvivalPct = (bestT3SellKept.length / coveredSell.length) * 100;
  const t3SellMetrics = bestT3SellMetrics!;

  // ═══ TREATMENT 4 — DRIFT-VETOED SELL ═══════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  TREATMENT 4 — DRIFT-VETOED SELL (Phase 2 drift veto, measured retroactively)');
  console.log('═'.repeat(90));

  const t4SellKept = sellClassified.filter((c) => !c.driftVetoed).map((c) => c.signal);
  const t4SellDropped = sellClassified.filter((c) => c.driftVetoed).map((c) => c.signal);
  const t4Signals = [...coveredBuy, ...t4SellKept];
  const t4Metrics = computeMetrics(t4Signals);
  const t4SellMetrics = computeMetrics(t4SellKept);
  const t4SellSurvivalPct = (t4SellKept.length / coveredSell.length) * 100;
  console.log(`\n  SELL vetoed (dropped): ${t4SellDropped.length}`);
  console.log(`  SELL retained: ${t4SellKept.length} / ${coveredSell.length} (${t4SellSurvivalPct.toFixed(1)}%)`);
  if (t4SellDropped.length > 0) {
    const droppedM = computeMetrics(t4SellDropped);
    console.log(`  Dropped SELLs (what we avoided): ${fmtMetrics(droppedM)}`);
  }
  console.log(`  SELL-only book:  ${fmtMetrics(t4SellMetrics)}`);
  console.log(`  Whole system:    ${fmtMetrics(t4Metrics)}`);

  // ═══ TREATMENT 5 — BEST COMBINATION ════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  TREATMENT 5 — BEST COMBINATION (stack individually-promising filters)');
  console.log('═'.repeat(90));

  // Test combinations: HTF-aligned + session, HTF-aligned + drift, session + drift, all three
  const combinations: { name: string; keep: (c: ClassifiedSignal) => boolean }[] = [
    {
      name: 'HTF-aligned + best-session',
      keep: (c) => c.htf === 'BEARISH' && (() => {
        const f = sessionFilters.find((sf) => sf.name === bestT3Name)!;
        return f.keep(c);
      })(),
    },
    {
      name: 'HTF-aligned + drift-vetoed',
      keep: (c) => c.htf === 'BEARISH' && !c.driftVetoed,
    },
    {
      name: 'best-session + drift-vetoed',
      keep: (c) => {
        const f = sessionFilters.find((sf) => sf.name === bestT3Name)!;
        return f.keep(c) && !c.driftVetoed;
      },
    },
    {
      name: 'HTF-aligned + best-session + drift-vetoed',
      keep: (c) => c.htf === 'BEARISH' && (() => {
        const f = sessionFilters.find((sf) => sf.name === bestT3Name)!;
        return f.keep(c);
      })() && !c.driftVetoed,
    },
  ];

  let bestT5Name = '';
  let bestT5Metrics: Metrics | null = null;
  let bestT5SellKept: ParsedSignal[] = [];
  let bestT5SellMetrics: Metrics | null = null;

  for (const combo of combinations) {
    const sellKept = sellClassified.filter((c) => combo.keep(c)).map((c) => c.signal);
    const allSignalsFiltered = [...coveredBuy, ...sellKept];
    const m = computeMetrics(allSignalsFiltered);
    const sellM = computeMetrics(sellKept);
    const survival = (sellKept.length / coveredSell.length) * 100;
    const smallFlag = sellKept.length < 20 ? ' ⚠️ SMALL' : '';
    console.log(`\n  Combo: ${combo.name}`);
    console.log(`    SELL retained: ${sellKept.length} / ${coveredSell.length} (${survival.toFixed(1)}%)${smallFlag}`);
    console.log(`    SELL-only:  ${fmtMetrics(sellM)}`);
    console.log(`    Whole:      ${fmtMetrics(m)}`);

    if (!bestT5Metrics || m.evR > bestT5Metrics.evR) {
      bestT5Metrics = m;
      bestT5Name = combo.name;
      bestT5SellKept = sellKept;
      bestT5SellMetrics = sellM;
    }
  }

  console.log(`\n  Best combination: "${bestT5Name}"`);
  const t5Metrics = bestT5Metrics!;
  const t5SellSurvivalPct = (bestT5SellKept.length / coveredSell.length) * 100;
  const t5SellMetrics = bestT5SellMetrics!;

  // ═══ DECISION TABLE ════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  DECISION TABLE — ALL TREATMENTS');
  console.log('═'.repeat(90));

  const treatments: {
    name: string;
    whole: Metrics;
    sell: Metrics;
    sellSurvivalPct: number;
    sellKept: number;
  }[] = [
    { name: 'BASELINE (no filter)', whole: baselineAll, sell: baselineSell, sellSurvivalPct: 100, sellKept: coveredSell.length },
    { name: '1. SUPPRESS ALL SELL', whole: t1Metrics, sell: { n: 0, nResolved: 0, winRate: 0, pf: 0, evR: 0, evDollars: 0, netDollars: 0, avgRiskDollars: 0 }, sellSurvivalPct: 0, sellKept: 0 },
    { name: '2. HTF-ALIGNED SELL', whole: t2Metrics, sell: t2SellMetrics, sellSurvivalPct: t2SellSurvivalPct, sellKept: t2SellKept.length },
    { name: `3. SESSION (${bestT3Name})`, whole: t3Metrics, sell: t3SellMetrics, sellSurvivalPct: t3SellSurvivalPct, sellKept: bestT3SellKept.length },
    { name: '4. DRIFT-VETOED SELL', whole: t4Metrics, sell: t4SellMetrics, sellSurvivalPct: t4SellSurvivalPct, sellKept: t4SellKept.length },
    { name: `5. COMBO (${bestT5Name})`, whole: t5Metrics, sell: t5SellMetrics, sellSurvivalPct: t5SellSurvivalPct, sellKept: bestT5SellKept.length },
  ];

  console.log('\n  ┌──────────────────────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('  │ Treatment                        │    n     │  WR%     │   PF     │  EV(R)   │  net$    │ SELL surv│');
  console.log('  ├──────────────────────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');

  for (const t of treatments) {
    const pfStr = Number.isFinite(t.whole.pf) ? t.whole.pf.toFixed(2) : 'inf';
    const sellSurvStr = t.name === 'BASELINE (no filter)' ? '100.0%' : `${t.sellSurvivalPct.toFixed(1)}%`;
    console.log(
      `  │ ${t.name.padEnd(32)} │ ${String(t.whole.n).padStart(8)} │ ${t.whole.winRate.toFixed(1).padStart(8)} │ ${pfStr.padStart(8)} │ ${t.whole.evR.toFixed(4).padStart(8)} │ $${t.whole.netDollars.toFixed(1).padStart(7)} │ ${sellSurvStr.padStart(8)} │`,
    );
  }
  console.log('  └──────────────────────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

  // SELL-only book comparison
  console.log('\n  SELL-ONLY BOOK COMPARISON:');
  console.log('  ┌──────────────────────────────────┬──────────┬──────────┬──────────┬──────────┬──────────┐');
  console.log('  │ Treatment                        │ SELL n   │  WR%     │   PF     │  EV(R)   │  net$    │');
  console.log('  ├──────────────────────────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤');
  for (const t of treatments) {
    const pfStr = Number.isFinite(t.sell.pf) ? t.sell.pf.toFixed(2) : 'inf';
    console.log(
      `  │ ${t.name.padEnd(32)} │ ${String(t.sell.n).padStart(8)} │ ${t.sell.winRate.toFixed(1).padStart(8)} │ ${pfStr.padStart(8)} │ ${t.sell.evR.toFixed(4).padStart(8)} │ $${t.sell.netDollars.toFixed(1).padStart(7)} │`,
    );
  }
  console.log('  └──────────────────────────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘');

  // ═══ GATE CHECKS ══════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  GATE CHECKS (pre-registered: (a) SELL EV >= +0.10R, (b) whole EV >= +0.1306R, (c) SELL survival >= 30%)');
  console.log('═'.repeat(90));

  const gateThresholdEV = BASELINE_EV_R + GATE_EV_IMPROVEMENT_R;

  for (const t of treatments.slice(1)) { // skip baseline
    const gateA = t.sell.evR >= GATE_SELL_EV_MIN_R;
    const gateB = t.whole.evR >= gateThresholdEV;
    const gateC = t.sellSurvivalPct >= GATE_SELL_SURVIVAL_MIN_PCT;
    const smallSellSample = t.sellKept < 20;

    console.log(`\n  ${t.name}:`);
    console.log(`    (a) SELL EV = ${t.sell.evR.toFixed(4)}R >= +${GATE_SELL_EV_MIN_R}R?  ${gateA ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`    (b) Whole EV = ${t.whole.evR.toFixed(4)}R >= +${gateThresholdEV.toFixed(4)}R?  ${gateB ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`    (c) SELL survival = ${t.sellSurvivalPct.toFixed(1)}% >= ${GATE_SELL_SURVIVAL_MIN_PCT}%?  ${gateC ? '✅ PASS' : '❌ FAIL'}${t.sellKept < coveredSell.length ? ` (${t.sellKept}/${coveredSell.length})` : ''}`);
    if (smallSellSample && t.sellKept > 0) {
      console.log(`    ⚠️  SMALL SAMPLE: only ${t.sellKept} SELLs retained — gate CANNOT clear on this alone`);
    }
    const allPass = gateA && gateB && gateC && !smallSellSample;
    console.log(`    → ${allPass ? '✅ ALL GATES CLEARED' : '❌ GATE NOT CLEARED'}`);
  }

  // ═══ GENERALIZABLE vs OVERFIT ASSESSMENT ═══════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('  GENERALIZABLE vs OVERFIT ASSESSMENT');
  console.log('═'.repeat(90));

  console.log(`
  Treatment 1 (SUPPRESS ALL SELL):
    Generalizability: HIGH. The structural reason shorts underperform is
    well-documented: gold has a persistent long bias (central-bank buying,
    safe-haven flows, negative real rates regime). Shorting gold on 1-minute
    timeframes means fighting both the macro drift and the microstructure
    bid. "Stop doing the unprofitable thing" requires no curve-fitting.
    The cost is signal volume: ${coveredBuy.length} signals / 30 days = ${(coveredBuy.length / 30).toFixed(1)}/day
    (vs ${(covered.length / 30).toFixed(1)}/day baseline). This is a real constraint
    if the system needs 10-20 signals/day.

  Treatment 2 (HTF-ALIGNED SELL):
    Generalizability: MODERATE. The logic is sound — shorts WITH the daily
    trend should outperform counter-trend shorts. BUT:
    - ${t2ApproxKept}/${t2SellKept.length} retained SELLs use APPROXIMATED HTF
      (bar reconstruction, not engine ground truth). The approximation may
      misclassify some signals.
    - The retained sample (${t2SellKept.length} SELLs) is ${t2SellKept.length < 20 ? 'BELOW' : 'above'} the
      n=20 reliability threshold.
    - Even if the filter is real, it only works when detectHTFTrend correctly
      identifies the trend — and the engine's NEUTRAL classification is
      noisy (106/${coveredSell.length} SELLs had no HTF feature signature).

  Treatment 3 (SESSION-FILTERED SELL):
    Generalizability: LOW to MODERATE. Session effects on gold are real
    (London open and NY AM have higher volume, tighter spreads). But:
    - The specific hours flagged (h04/h11/h12, NY_PM) come from ONE 30-day
      sample. Different months may have different worst-hours.
    - Dropping by UTC hour is a blunt instrument — it doesn't distinguish
      "bad because low liquidity" from "bad because of this sample's
      specific price action."
    - The filter that wins is selected POST-HOC from 5 variants tested,
      which inflates the selection's apparent quality.

  Treatment 4 (DRIFT-VETOED SELL):
    Generalizability: MODERATE to HIGH. The Phase 2 drift veto targets a
    real, mechanistic failure mode: firing a SELL into a live upward
    impulse. The logic is "don't short into a strong rally" — this is
    structurally sound and time-invariant.
    - The drift is reconstructed from bars (not the engine's tick-level
      computation), so some vetoed/kept boundary cases may differ.
    - The veto is scoped to counter-trend signals only (Phase 2 design),
      not a blanket filter — this limits overfitting risk.
    - It drops only ${t4SellDropped.length} SELLs (the ones the veto would have
      caught), which is a targeted intervention, not a broad cull.

  Treatment 5 (BEST COMBINATION):
    Generalizability: LOWEST. Stacking filters compounds overfitting risk.
    Each additional filter reduces sample size and increases the chance
    that the result is sample-specific. If the best combo drops SELLs
    to near-zero, it's functionally Treatment 1 with extra steps.
  `);

  // ═══ FINAL VERDICT ════════════════════════════════════════════════════════
  console.log('═'.repeat(90));
  console.log('  FINAL VERDICT');
  console.log('═'.repeat(90));

  // Find best whole-system EV among treatments
  let bestTreatment = treatments[0]; // baseline
  for (const t of treatments.slice(1)) {
    if (t.whole.evR > bestTreatment.whole.evR) {
      bestTreatment = t;
    }
  }

  console.log(`
  Best whole-system EV: "${bestTreatment.name}" at ${bestTreatment.whole.evR.toFixed(4)}R
  Baseline EV:          ${baselineAll.evR.toFixed(4)}R
  Improvement:          ${(bestTreatment.whole.evR - baselineAll.evR >= 0 ? '+' : '')}${(bestTreatment.whole.evR - baselineAll.evR).toFixed(4)}R

  Does any treatment clear ALL three gates? See gate checks above.

  If SUPPRESS ALL SELL (Treatment 1) produces the best whole-system EV,
  that is a legitimate and often correct answer: "stop doing the
  unprofitable thing." The cost is signal volume (~${(coveredBuy.length / 30).toFixed(1)}/day vs
  ${(covered.length / 30).toFixed(1)}/day). Whether that's acceptable depends on the
  10-20 signals/day mandate.

  If no treatment clears all gates, the conclusion is that SELL-side
  weakness on this timeframe is STRUCTURAL — not fixable by filtering
  with the information available in the export. The recommendation would
  be to either (a) suppress SELLs entirely, or (b) accept the lower SELL
  volume from Treatment 1 and re-examine whether the 10-20/day target
  can be met with BUYs alone + a different asset/session.
  `);

  // ═══ HONESTY CHECK: baseline consistency ═══════════════════════════════════
  console.log('═'.repeat(90));
  console.log('  HONESTY CHECK: Baseline consistency with prior counterfactuals');
  console.log('═'.repeat(90));
  console.log(`  This script's baseline EV: ${baselineAll.evR.toFixed(4)}R`);
  console.log(`  Prior scripts' baseline:   ${BASELINE_EV_R.toFixed(4)}R`);
  console.log(`  Match: ${Math.abs(baselineAll.evR - BASELINE_EV_R) < 0.01 ? '✅ YES (within 0.01R)' : '❌ NO — investigate'}`);
  console.log(`  Baseline net $: $${baselineAll.netDollars.toFixed(1)}`);
  console.log(`  BUY-only net $: $${baselineBuy.netDollars.toFixed(1)}`);
  console.log(`  SELL-only net $: $${baselineSell.netDollars.toFixed(1)}`);
  console.log(`  SELL contribution to net $: $${(baselineSell.netDollars).toFixed(1)} (${((baselineSell.netDollars / baselineAll.netDollars) * 100).toFixed(1)}% of total)`);

  console.log('\n' + '═'.repeat(90));
  console.log('  SELL-side counterfactual analysis complete. No engine code was modified.');
  console.log('═'.repeat(90));
}

main().catch((e) => {
  console.error('Analysis script error:', e);
  process.exit(1);
});
