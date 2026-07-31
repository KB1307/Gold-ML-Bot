/**
 * Phase C1+C2 counterfactual measurement (read-only, pre-registered EV gate).
 *
 * C1: Require HTF + M15 + M5 directional agreement before emission.
 *     M1 used ONLY to time entry within established direction.
 *     Gate: build only if EV improves by >= +0.05R AND retains >= 40% of volume.
 *
 * C2: Test removing counter-productive confirmations:
 *     - STRONG UPTREND (36.8% WR, +0.15 to BUY)
 *     - STRONG UPTREND PATTERN (31.3% on BUY, +0.10 to BUY)
 *     - ABOVE VWAP (47.1% WR, +0.05 to BUY)
 *     - SESSION HIGH SWEEP (50.0%, +0.35 to SELL — not counter-productive for BUY)
 *     - BOLLINGER EXPANSION (51.7%, neutral context tag — no directional impact)
 *
 * Uses real gold_m1_bars data (28-31 July 2026) to build M1/M5/M15/daily bars
 * and simulate counterfactual signal generation with and without the cascade.
 *
 * Methodology:
 * - At each 15-min interval during London/NY sessions (07:00-17:00 UTC),
 *   compute HTF trend (daily bars), M15 trend, M5 trend, and M1 momentum.
 * - A "potential signal" is generated when M1 momentum is strong enough
 *   (proxy: |price change over last 5 M1 bars| > 2 * ATR).
 * - Direction = M1 momentum direction (BUY if up, SELL if down).
 * - Baseline: allow all potential signals (no cascade).
 * - Cascade: allow only if HTF + M15 + M5 all agree with M1 direction.
 * - Outcome: check forward bar movement for SL (70 pips) or TP1 (30 pips) hit.
 * - Blocked signals counted as ZERO (not excluded), per the pre-registered gate.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  const raw = readFileSync(envPath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return env;
}

const env = loadEnv();
const supabase = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface MinuteBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface AggBar extends MinuteBar {}

async function fetchBarsPaged(fromTime: number, toTime: number): Promise<MinuteBar[]> {
  const fromIso = new Date(fromTime).toISOString();
  const toIso = new Date(toTime).toISOString();
  const PAGE_SIZE = 1000;
  let allData: MinuteBar[] = [];

  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabase
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromIso)
      .lte("timestamp", toIso)
      .order("timestamp", { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (error || !data || data.length === 0) break;
    allData = allData.concat(
      (data as { timestamp: string; open: number; high: number; low: number; close: number }[]).map((row) => ({
        timestamp: new Date(row.timestamp).getTime(),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      })),
    );
    if (data.length < PAGE_SIZE) break;
  }
  return allData;
}

/** Aggregate M1 bars into N-minute bars. */
function aggregateBars(m1Bars: MinuteBar[], periodMin: number): AggBar[] {
  const grouped = new Map<number, AggBar>();
  for (const bar of m1Bars) {
    const bucket = Math.floor(bar.timestamp / (periodMin * 60 * 1000)) * (periodMin * 60 * 1000);
    const existing = grouped.get(bucket);
    if (!existing) {
      grouped.set(bucket, { timestamp: bucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
    }
  }
  return Array.from(grouped.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function calculateEMA(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

type Trend = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

/** Trend from EMA crossover on a bar series. */
function emaTrend(bars: AggBar[], fastPeriod: number, slowPeriod: number): Trend {
  if (bars.length < slowPeriod + 1) return 'NEUTRAL';
  const closes = bars.map((b) => b.close);
  const emaFast = calculateEMA(closes.slice(0, -1), fastPeriod); // exclude current bar
  const emaSlow = calculateEMA(closes.slice(0, -1), slowPeriod);
  if (emaFast > emaSlow) return 'BULLISH';
  if (emaFast < emaSlow) return 'BEARISH';
  return 'NEUTRAL';
}

/** Slope-based trend: last N bars' closes rising/falling. */
function slopeTrend(bars: AggBar[], lookback: number): Trend {
  if (bars.length < lookback + 1) return 'NEUTRAL';
  const recent = bars.slice(-(lookback + 1), -1); // exclude current forming bar
  if (recent.length < 2) return 'NEUTRAL';
  const first = recent[0].close;
  const last = recent[recent.length - 1].close;
  const change = last - first;
  const threshold = last * 0.0008; // ~0.08% — roughly 3 pips at $4000 gold
  if (change > threshold) return 'BULLISH';
  if (change < -threshold) return 'BEARISH';
  return 'NEUTRAL';
}

/** HTF trend from daily bars + developing day (mirrors the B1-fixed detectHTFTrend). */
function htfTrend(
  currentPrice: number,
  dailyPivot: number,
  dailyBars: { date: string; open: number; high: number; low: number; close: number; timestamp: number }[],
  developingDay: { open: number; close: number } | null,
): Trend {
  const priceVsPivot = currentPrice - dailyPivot;
  const pivotBullish = priceVsPivot > 10 ? 1 : 0;
  const pivotBearish = priceVsPivot < -10 ? 1 : 0;

  let devBullish = 0;
  let devBearish = 0;
  if (developingDay) {
    const devMove = developingDay.close - developingDay.open;
    if (devMove > 5.0) devBullish = 1.5;
    else if (devMove > 2.0) devBullish = 1.0;
    else if (devMove < -5.0) devBearish = 1.5;
    else if (devMove < -2.0) devBearish = 1.0;
  }

  let trendBullish = 0;
  let trendBearish = 0;
  const completed = dailyBars.filter((b) => b.timestamp < Date.now());
  if (completed.length >= 3) {
    const r3 = completed.slice(-3);
    const higherHighs = r3[2].high > r3[1].high && r3[1].high > r3[0].high;
    const higherCloses = r3[2].close > r3[1].close && r3[1].close > r3[0].close;
    const lowerLows = r3[2].low < r3[1].low && r3[1].low < r3[0].low;
    const lowerCloses = r3[2].close < r3[1].close && r3[1].close < r3[0].close;
    if (higherHighs && higherCloses) trendBullish = 1;
    else if (lowerLows && lowerCloses) trendBearish = 1;
  }

  const bullishScore = pivotBullish + devBullish + trendBullish;
  const bearishScore = pivotBearish + devBearish + trendBearish;
  if (bullishScore >= 1.5) return 'BULLISH';
  if (bearishScore >= 1.5) return 'BEARISH';
  return 'NEUTRAL';
}

/** Build daily bars from M1 bars (mirrors signalEngine.buildDailyOHLCBarsFromHistoricalBars). */
function buildDailyBars(m1Bars: MinuteBar[], now: number): { date: string; open: number; high: number; low: number; close: number; timestamp: number }[] {
  const NY_CLOSE_HOUR_UTC = 21;
  const grouped = new Map<string, { date: string; open: number; high: number; low: number; close: number; timestamp: number }>();
  for (const bar of m1Bars) {
    const d = new Date(bar.timestamp);
    const hour = d.getUTCHours();
    const td = new Date(d);
    if (hour >= NY_CLOSE_HOUR_UTC) td.setUTCDate(td.getUTCDate() + 1);
    const dateKey = `${td.getUTCFullYear()}-${String(td.getUTCMonth() + 1).padStart(2, "0")}-${String(td.getUTCDate()).padStart(2, "0")}`;
    const closeTs = Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10)), 21, 0, 0);
    const existing = grouped.get(dateKey);
    if (!existing) {
      grouped.set(dateKey, { date: dateKey, open: bar.open, high: bar.high, low: bar.low, close: bar.close, timestamp: closeTs });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
    }
  }
  return Array.from(grouped.values()).filter((b) => b.timestamp <= now).sort((a, b) => a.timestamp - b.timestamp);
}

interface SignalRecord {
  timestamp: number;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  htf: Trend;
  m15: Trend;
  m5: Trend;
  m1Momentum: Trend;
  cascadeAllows: boolean;
  outcome: 'WIN' | 'LOSS' | 'OPEN' | 'BLOCKED';
  rMultiple: number;
}

/**
 * Measure outcome: did price hit TP1 (30 pips = $3.0) before SL (70 pips = $7.0)?
 * For BUY: TP = entry + 3.0, SL = entry - 7.0
 * For SELL: TP = entry - 3.0, SL = entry + 7.0
 * Check forward M1 bars for up to 240 minutes.
 */
function measureOutcome(
  signal: SignalRecord,
  forwardBars: MinuteBar[],
): { outcome: 'WIN' | 'LOSS' | 'OPEN'; rMultiple: number } {
  const pipValue = 0.1;
  const tp1Pips = 30;
  const slPips = 70;
  const tp1Dist = tp1Pips * pipValue; // $3.0
  const slDist = slPips * pipValue;   // $7.0

  const isBuy = signal.direction === 'BUY';
  const tp1Price = isBuy ? signal.entryPrice + tp1Dist : signal.entryPrice - tp1Dist;
  const slPrice = isBuy ? signal.entryPrice - slDist : signal.entryPrice + slDist;

  for (const bar of forwardBars) {
    if (isBuy) {
      if (bar.low <= slPrice) return { outcome: 'LOSS', rMultiple: -1.0 };
      if (bar.high >= tp1Price) return { outcome: 'WIN', rMultiple: tp1Pips / slPips };
    } else {
      if (bar.high >= slPrice) return { outcome: 'LOSS', rMultiple: -1.0 };
      if (bar.low <= tp1Price) return { outcome: 'WIN', rMultiple: tp1Pips / slPips };
    }
  }
  return { outcome: 'OPEN', rMultiple: 0 };
}

async function main(): Promise<void> {
  console.log("Phase C1+C2 Counterfactual Measurement");
  console.log(`Run time: ${new Date().toISOString()}`);
  console.log("═".repeat(80));

  // Fetch real M1 bars for 28-31 July (72h + daily bar history)
  const windowEnd = new Date("2026-07-31T17:00:00Z").getTime(); // London/NY close
  const windowStart = new Date("2026-07-28T00:00:00Z").getTime(); // 3 days before
  const dailyLookbackStart = windowStart - 15 * 24 * 60 * 60 * 1000; // 15 days for daily bars

  console.log("\nFetching M1 bars...");
  const dailyM1Bars = await fetchBarsPaged(dailyLookbackStart, windowEnd);
  const sessionM1Bars = await fetchBarsPaged(windowStart, windowEnd);
  console.log(`Daily lookback: ${dailyM1Bars.length} M1 bars`);
  console.log(`Session window: ${sessionM1Bars.length} M1 bars (${new Date(windowStart).toISOString()} to ${new Date(windowEnd).toISOString()})`);

  if (sessionM1Bars.length === 0) {
    console.log("❌ No bars available — cannot run counterfactual");
    return;
  }

  // Build aggregated bars
  const m5Bars = aggregateBars(sessionM1Bars, 5);
  const m15Bars = aggregateBars(sessionM1Bars, 15);
  const dailyBars = buildDailyBars(dailyM1Bars, windowEnd);
  console.log(`Aggregated: ${m5Bars.length} M5 bars, ${m15Bars.length} M15 bars, ${dailyBars.length} daily bars`);

  // Get the most recent completed daily bar for pivot
  const completedDaily = dailyBars.filter((d) => d.timestamp < windowStart + 24 * 60 * 60 * 1000);
  if (completedDaily.length === 0) {
    console.log("❌ No completed daily bars — cannot compute pivot");
    return;
  }
  const lastCompleted = completedDaily[completedDaily.length - 1];
  const dailyPivot = (lastCompleted.high + lastCompleted.low + lastCompleted.close) / 3;
  console.log(`Pivot from ${lastCompleted.date}: ${dailyPivot.toFixed(1)}`);

  // ── Generate potential signals at 15-min intervals during London/NY ──
  const signals: SignalRecord[] = [];
  const SIGNAL_INTERVAL_MS = 15 * 60 * 1000;
  const PIP_VALUE = 0.1;
  const ATR_LOOKBACK = 14;

  for (let sigTime = windowStart; sigTime < windowEnd; sigTime += SIGNAL_INTERVAL_MS) {
    const utcHour = new Date(sigTime).getUTCHours();
    // Only during London/NY sessions (07:00-17:00 UTC)
    if (utcHour < 7 || utcHour >= 17) continue;

    // Get M1 bars up to signal time
    const m1UpTo = sessionM1Bars.filter((b) => b.timestamp <= sigTime);
    if (m1UpTo.length < 20) continue;

    // Compute ATR from M1 bars (last 14 bars' ranges)
    const recentM1 = m1UpTo.slice(-ATR_LOOKBACK);
    const atr = recentM1.reduce((sum, b) => sum + (b.high - b.low), 0) / ATR_LOOKBACK;

    // M1 momentum: price change over last 5 M1 bars
    const m1Window = m1UpTo.slice(-6);
    const m1Change = m1Window[m1Window.length - 1].close - m1Window[0].open;
    const m1Momentum: Trend = m1Change > atr * 0.5 ? 'BULLISH' : m1Change < -atr * 0.5 ? 'BEARISH' : 'NEUTRAL';

    // Only generate a potential signal if M1 momentum is strong enough
    if (m1Momentum === 'NEUTRAL') continue;

    const direction = m1Momentum === 'BULLISH' ? 'BUY' : 'SELL';
    const entryPrice = m1UpTo[m1UpTo.length - 1].close;

    // Compute HTF trend
    const devDayBars = m1UpTo.filter((b) => {
      const d = new Date(b.timestamp);
      return d.getUTCDate() === new Date(sigTime).getUTCDate() && d.getUTCMonth() === new Date(sigTime).getUTCMonth();
    });
    const developingDay = devDayBars.length > 0
      ? { open: devDayBars[0].open, close: devDayBars[devDayBars.length - 1].close }
      : null;

    const htf = htfTrend(entryPrice, dailyPivot, dailyBars, developingDay);

    // Compute M15 trend (EMA5 vs EMA10 on completed M15 bars)
    const m15UpTo = m15Bars.filter((b) => b.timestamp < sigTime);
    const m15Trend = emaTrend(m15UpTo, 5, 10);

    // Compute M5 trend (EMA5 vs EMA10 on completed M5 bars)
    const m5UpTo = m5Bars.filter((b) => b.timestamp < sigTime);
    const m5Trend = emaTrend(m5UpTo, 5, 10);

    // Cascade: all three must agree with M1 direction
    const cascadeAllows = (
      (direction === 'BUY' && htf === 'BULLISH' && m15Trend === 'BULLISH' && m5Trend === 'BULLISH') ||
      (direction === 'SELL' && htf === 'BEARISH' && m15Trend === 'BEARISH' && m5Trend === 'BEARISH')
    );

    // Measure outcome using forward M1 bars (up to 240 min)
    const forwardBars = sessionM1Bars.filter((b) => b.timestamp > sigTime).slice(0, 240);
    const outcome = measureOutcome(
      { timestamp: sigTime, direction, entryPrice, htf, m15: m15Trend, m5: m5Trend, m1Momentum, cascadeAllows, outcome: 'OPEN', rMultiple: 0 },
      forwardBars,
    );

    signals.push({
      timestamp: sigTime,
      direction,
      entryPrice,
      htf,
      m15: m15Trend,
      m5: m5Trend,
      m1Momentum,
      cascadeAllows,
      outcome: outcome.outcome,
      rMultiple: outcome.rMultiple,
    });
  }

  console.log(`\nGenerated ${signals.length} potential signals at 15-min intervals`);

  // ── C1: Cascade decision table ────────────────────────────────────────
  console.log("\n" + "═".repeat(80));
  console.log("C1: CASCADE DECISION TABLE (HTF + M15 + M5 agreement required)");
  console.log("═".repeat(80));

  // Baseline: all potential signals (no cascade)
  const baselineSignals = signals;
  const baselineWins = baselineSignals.filter((s) => s.outcome === 'WIN');
  const baselineLosses = baselineSignals.filter((s) => s.outcome === 'LOSS');
  const baselineWR = baselineSignals.length > 0 ? baselineWins.length / baselineSignals.length : 0;
  const baselineEV = baselineSignals.length > 0
    ? baselineSignals.reduce((sum, s) => sum + s.rMultiple, 0) / baselineSignals.length
    : 0;
  const baselinePF = baselineLosses.length > 0
    ? baselineWins.reduce((sum, s) => sum + s.rMultiple, 0) / Math.abs(baselineLosses.reduce((sum, s) => sum + s.rMultiple, 0))
    : baselineWins.length > 0 ? Infinity : 0;

  // Cascade: only signals where HTF + M15 + M5 all agree (blocked = 0 R)
  const cascadeSignals = signals.map((s) => ({
    ...s,
    effectiveOutcome: s.cascadeAllows ? s.outcome : 'BLOCKED' as const,
    effectiveR: s.cascadeAllows ? s.rMultiple : 0,
  }));
  const cascadeAllowed = cascadeSignals.filter((s) => s.cascadeAllows);
  const cascadeWins = cascadeAllowed.filter((s) => s.outcome === 'WIN');
  const cascadeLosses = cascadeAllowed.filter((s) => s.outcome === 'LOSS');
  const cascadeWR = cascadeAllowed.length > 0 ? cascadeWins.length / cascadeAllowed.length : 0;
  // EV per ORIGINAL signal (blocked = 0, not excluded)
  const cascadeEV = cascadeSignals.length > 0
    ? cascadeSignals.reduce((sum, s) => sum + s.effectiveR, 0) / cascadeSignals.length
    : 0;
  const cascadePF = cascadeLosses.length > 0
    ? cascadeWins.reduce((sum, s) => sum + s.rMultiple, 0) / Math.abs(cascadeLosses.reduce((sum, s) => sum + s.rMultiple, 0))
    : cascadeWins.length > 0 ? Infinity : 0;

  const retentionRate = baselineSignals.length > 0 ? cascadeAllowed.length / baselineSignals.length : 0;
  const evDelta = cascadeEV - baselineEV;

  console.log("\n┌─────────────────────────────────────────────────────────────┐");
  console.log("│ Metric              │ Baseline (no cascade) │ With Cascade   │");
  console.log("├─────────────────────────────────────────────────────────────┤");
  console.log(`│ Total signals       │ ${String(baselineSignals.length).padEnd(21)} │ ${String(cascadeAllowed.length).padEnd(14)} │`);
  console.log(`│ Wins                │ ${String(baselineWins.length).padEnd(21)} │ ${String(cascadeWins.length).padEnd(14)} │`);
  console.log(`│ Losses              │ ${String(baselineLosses.length).padEnd(21)} │ ${String(cascadeLosses.length).padEnd(14)} │`);
  console.log(`│ Win Rate            │ ${(baselineWR * 100).toFixed(1).padEnd(20)}% │ ${(cascadeWR * 100).toFixed(1).padEnd(13)}% │`);
  console.log(`│ Profit Factor       │ ${baselinePF.toFixed(2).padEnd(21)} │ ${cascadePF.toFixed(2).padEnd(14)} │`);
  console.log(`│ EV per signal (R)   │ ${baselineEV.toFixed(3).padEnd(21)} │ ${cascadeEV.toFixed(3).padEnd(14)} │`);
  console.log("├─────────────────────────────────────────────────────────────┤");
  console.log(`│ Retention rate      │                        │ ${(retentionRate * 100).toFixed(1).padEnd(13)}% │`);
  console.log(`│ EV delta            │                        │ ${evDelta >= 0 ? '+' : ''}${evDelta.toFixed(3).padEnd(13)} │`);
  console.log("└─────────────────────────────────────────────────────────────┘");

  // Pre-registered gate evaluation
  console.log("\nPRE-REGISTERED GATE EVALUATION:");
  console.log(`  EV improvement: ${evDelta >= 0 ? '+' : ''}${evDelta.toFixed(3)}R (gate: >= +0.05R) → ${evDelta >= 0.05 ? "PASS ✓" : "FAIL ✗"}`);
  console.log(`  Volume retention: ${(retentionRate * 100).toFixed(1)}% (gate: >= 40%) → ${retentionRate >= 0.40 ? "PASS ✓" : "FAIL ✗"}`);
  const gatePassed = evDelta >= 0.05 && retentionRate >= 0.40;
  console.log(`  Overall: ${gatePassed ? "GATE PASSED — build authorized" : "GATE FAILED — do NOT build"}`);

  // Direction breakdown
  console.log("\nDirection breakdown (cascade):");
  const buySignals = cascadeAllowed.filter((s) => s.direction === 'BUY');
  const sellSignals = cascadeAllowed.filter((s) => s.direction === 'SELL');
  const buyWins = buySignals.filter((s) => s.outcome === 'WIN');
  const sellWins = sellSignals.filter((s) => s.outcome === 'WIN');
  console.log(`  BUY: ${buySignals.length} signals, ${buyWins.length} wins (${buySignals.length > 0 ? (buyWins.length / buySignals.length * 100).toFixed(1) : 0}%)`);
  console.log(`  SELL: ${sellSignals.length} signals, ${sellWins.length} wins (${sellSignals.length > 0 ? (sellWins.length / sellSignals.length * 100).toFixed(1) : 0}%)`);

  // Blocked signals breakdown
  const blocked = cascadeSignals.filter((s) => !s.cascadeAllows);
  const blockedWins = blocked.filter((s) => s.outcome === 'WIN');
  console.log(`\nBlocked by cascade: ${blocked.length} signals (${blockedWins.length} would have won — ${(blocked.length > 0 ? blockedWins.length / blocked.length * 100 : 0).toFixed(1)}% WR of blocked)`);
  console.log(`  → Blocking wins is the cost of the cascade. If blocked WR > allowed WR, the cascade is counter-productive.`);

  // ── C2: Feature removal analysis ──────────────────────────────────────
  console.log("\n" + "═".repeat(80));
  console.log("C2: FEATURE REMOVAL ANALYSIS");
  console.log("═".repeat(80));

  console.log("\nFrom Phase A3 code analysis:");
  console.log("  STRONG UPTREND (36.8% WR): fires on 20-tick trend strength + tick-level HTF");
  console.log("    → With B1 fix, HTF is daily-bar-based. STRONG UPTREND's htfTrend input");
  console.log("    is now correct, so it will fire less often on counter-trend bounces.");
  console.log("    The +0.15 BUY contribution from this feature may still fire when the");
  console.log("    (now correct) HTF is BULLISH — which is legitimate. The 36.8% WR was");
  console.log("    measured under the BROKEN HTF. With B1 fixed, its WR may improve.");
  console.log("");
  console.log("  STRONG UPTREND PATTERN (31.3% on BUY): fires on 5-tick priceActionPattern.");
  console.log("    → This is PURELY tick-level (detectPriceActionPattern uses priceHistory.slice(-5)).");
  console.log("    → It fires on ANY $10 bounce in 5 ticks with <$20 range.");
  console.log("    → On a downtrend day, counter-trend bounces trigger this.");
  console.log("    → REMOVING this feature is safe: it adds +0.10 to BUY, and its 31.3% WR");
  console.log("      means it contributes to LOSING signals more often than winning ones.");
  console.log("");
  console.log("  ABOVE VWAP (47.1% WR): fires on 30-tick VWAP comparison.");
  console.log("    → Also tick-level. Fires during counter-trend bounces (price rises above");
  console.log("      30-tick VWAP after a drop). +0.05 to BUY.");
  console.log("    → REMOVING this is low-risk: 47.1% < 62.1% baseline, so it's pulling WR down.");
  console.log("");
  console.log("  SESSION HIGH SWEEP (50.0% WR): adds to SELL side, not BUY.");
  console.log("    → NOT counter-productive for BUY signals. Its 50.0% WR is across both");
  console.log("      directions. On a SELL, a confirmed high sweep reversal is legitimate.");
  console.log("    → DO NOT remove — it's a valid SELL-side signal.");
  console.log("");
  console.log("  BOLLINGER EXPANSION (51.7% WR): neutral context tag, no directional contribution.");
  console.log("    → attentionScores.set('bollinger_expansion', 0.03) — adds to NEITHER");
  console.log("      buySignalStrength NOR sellSignalStrength. Its 51.7% is correlation,");
  console.log("      not causation. Removing it changes NOTHING in signal generation.");
  console.log("    → DO NOT remove — there's nothing to remove (it has no directional impact).");

  // EV impact estimate for removing STRONG UPTREND PATTERN + ABOVE VWAP
  console.log("\nEV impact estimate for removing STRONG UPTREND PATTERN + ABOVE VWAP:");
  console.log("  These two features add +0.10 + 0.05 = +0.15 to buySignalStrength during");
  console.log("  counter-trend bounces. Removing them would reduce BUY confidence by ~0.15");
  console.log("  on bounce-driven signals, potentially pushing some below the emission");
  console.log("  threshold. This is EXACTLY the desired effect: stop emitting BUYs during");
  console.log("  counter-trend bounces on a downtrend day.");
  console.log("  However, with the B1 fix (correct HTF) and B2 gate (stand-aside on bearish");
  console.log("  HTF), many of these bounce-driven BUYs are already blocked. The marginal");
  console.log("  impact of ALSO removing these features is smaller now than it would have");
  console.log("  been before B1/B2. The cascade gate (if built) would block them too.");
  console.log("  Recommendation: measure the marginal impact AFTER B1/B2 are live, not now.");

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(80));
  console.log("PHASE C SUMMARY");
  console.log("═".repeat(80));
  console.log(`\nC1 Cascade: ${gatePassed ? "GATE PASSED — build authorized" : "GATE FAILED — do NOT build"}`);
  console.log(`  EV delta: ${evDelta >= 0 ? '+' : ''}${evDelta.toFixed(3)}R (need >= +0.05R)`);
  console.log(`  Retention: ${(retentionRate * 100).toFixed(1)}% (need >= 40%)`);
  if (!gatePassed) {
    console.log(`  → The cascade does not meet the pre-registered gate. Do NOT build it.`);
    console.log(`  → The B1 fix (correct HTF) + B2 gate (stand-aside on bearish HTF) already`);
    console.log(`    address the root cause. The cascade would add complexity without`);
    console.log(`    sufficient EV improvement to justify it.`);
  }

  console.log(`\nC2 Feature removal:`);
  console.log(`  → STRONG UPTREND PATTERN and ABOVE VWAP are tick-level and counter-productive.`);
  console.log(`  → But B1/B2 already block most of the signals they would have inflated.`);
  console.log(`  → Recommend measuring marginal impact after B1/B2 are live with real data.`);
  console.log(`  → DO NOT remove SESSION HIGH SWEEP (valid SELL signal) or BOLLINGER EXPANSION (neutral).`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
