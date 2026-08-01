/**
 * ITEM 3a: MEASURE FIRST — read-only counterfactual.
 *
 * For every signal in the diagnostics export, recompute:
 *   - STRONG_UPTREND/STRONG_DOWNTREND (from detectPriceActionPattern)
 *   - above_vwap/below_vwap (from calculateVWAP)
 *   - marketRegime/trendStrength (from calculateTrendStrength → detectMarketRegime)
 *
 * OLD basis: tick windows (5/30/20 ticks from priceHistory — Capital.com/Swissquote)
 * NEW basis: M5/M15 bars aggregated from gold_m1_bars (Vantage MT5, Supabase direct)
 *
 * Reports each feature's win rate under OLD (from export attention scores) vs
 * NEW (from bar-based recompute), against the 62.1% baseline.
 *
 * DATA-SOURCE RULE: reads gold_m1_bars DIRECTLY from Supabase via anon key.
 * No Rork backend, no GC=F/TwelveData, no priceHistory ticks.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv(): Record<string, string> {
  const raw = readFileSync(resolve(process.cwd(), "expo/.env"), "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}

const env = loadEnv();
const anon = createClient(env.EXPO_PUBLIC_SUPABASE_URL, env.EXPO_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface ParsedSignal {
  index: number;
  direction: "BUY" | "SELL";
  entryPrice: number;
  status: string;
  id: string;
  generated: number;
  confidence: number;
  attentionScores: Map<string, number>;
  isWin: boolean;
  rMultiple: number | null;
}

// ── Bar aggregation helpers ──────────────────────────────────────────────────

/** Aggregate M1 bars into M5 (5-minute) or M15 (15-minute) bars. */
function aggregateBars(m1Bars: Bar[], periodMinutes: number): Bar[] {
  const grouped = new Map<number, Bar>();
  for (const bar of m1Bars) {
    const ts = new Date(bar.timestamp).getTime();
    const bucket = Math.floor(ts / (periodMinutes * 60 * 1000)) * (periodMinutes * 60 * 1000);
    const existing = grouped.get(bucket);
    if (!existing) {
      grouped.set(bucket, {
        timestamp: new Date(bucket).toISOString(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
    }
  }
  return [...grouped.values()].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

// ── Bar-based feature recomputation ──────────────────────────────────────────

/** Bar-based detectPriceActionPattern: uses last 5 M5 bars instead of 5 ticks. */
function detectPriceActionPatternBarBased(m5Bars: Bar[]): string {
  if (m5Bars.length < 5) return "INSUFFICIENT_DATA";
  const recent = m5Bars.slice(-5);
  // Use closes for trend, high-low for volatility
  const trend = recent[4].close - recent[0].open;
  const volatility = Math.max(...recent.map(b => b.high)) - Math.min(...recent.map(b => b.low));

  // Same thresholds as tick-based but on M5 bars (5 bars = 25 min, not ~2.5 min)
  // Scale thresholds: 5 ticks ≈ 2.5 min, 5 M5 bars = 25 min → 10x time window
  // Trend threshold: $10 over 2.5 min → $10 over 25 min is conservative
  // Volatility threshold: $20 over 2.5 min → $20 over 25 min is very tight
  // Keep same thresholds for direct comparison
  if (trend > 10 && volatility < 20) return "STRONG_UPTREND";
  if (trend < -10 && volatility < 20) return "STRONG_DOWNTREND";
  if (Math.abs(trend) < 5 && volatility < 10) return "CONSOLIDATION";
  if (volatility > 25) return "HIGH_VOLATILITY_BREAKOUT";
  if (recent[4].close > recent[3].close && recent[3].close < recent[2].close) return "BULLISH_REVERSAL";
  if (recent[4].close < recent[3].close && recent[3].close > recent[2].close) return "BEARISH_REVERSAL";
  return "NEUTRAL";
}

/** Bar-based calculateVWAP: uses last 30 M5 bars instead of 30 ticks. */
function calculateVWAPBarBased(m5Bars: Bar[]): number | null {
  if (m5Bars.length < 10) return null;
  const n = Math.min(30, m5Bars.length);
  const bars = m5Bars.slice(-n);
  let numerator = 0;
  let denominator = 0;
  for (const bar of bars) {
    const typical = (bar.high + bar.low + bar.close) / 3;
    const pseudoVolume = Math.max(0.1, Math.abs(bar.high - bar.low));
    numerator += typical * pseudoVolume;
    denominator += pseudoVolume;
  }
  if (denominator === 0) return null;
  return parseFloat((numerator / denominator).toFixed(2));
}

/** Bar-based calculateTrendStrength: uses last 20 M5 bar closes instead of 20 ticks. */
function calculateTrendStrengthBarBased(m5Bars: Bar[]): number {
  if (m5Bars.length < 20) return 0.5;
  const closes = m5Bars.slice(-20).map(b => b.close);
  const first = closes[0];
  const last = closes[closes.length - 1];
  const netMove = Math.abs(last - first);
  let totalMove = 0;
  for (let i = 1; i < closes.length; i++) {
    totalMove += Math.abs(closes[i] - closes[i - 1]);
  }
  if (totalMove === 0) return 0;
  return Math.min(1.0, netMove / totalMove);
}

/** Bar-based detectMarketRegime: uses M5 bars for ATR + trend strength. */
function detectMarketRegimeBarBased(m5Bars: Bar[]): { type: string; strength: number } {
  if (m5Bars.length < 20) return { type: "RANGING", strength: 0.5 };

  // ATR from M5 bars
  const recent14 = m5Bars.slice(-14);
  let atrSum = 0;
  for (let i = 1; i < recent14.length; i++) {
    const tr = Math.max(
      recent14[i].high - recent14[i].low,
      Math.abs(recent14[i].high - recent14[i - 1].close),
      Math.abs(recent14[i].low - recent14[i - 1].close),
    );
    atrSum += tr;
  }
  const atr = atrSum / (recent14.length - 1);

  // Volume ratio from M5 bars
  const recent10 = m5Bars.slice(-10);
  const older10 = m5Bars.slice(-20, -10);
  let recentActivity = 0;
  for (let i = 1; i < recent10.length; i++) {
    recentActivity += Math.abs(recent10[i].close - recent10[i - 1].close);
  }
  let olderActivity = 0;
  for (let i = 1; i < older10.length; i++) {
    olderActivity += Math.abs(older10[i].close - older10[i - 1].close);
  }
  const volumeRatio = olderActivity === 0 ? 1.0 : recentActivity / olderActivity;

  const trendStrength = calculateTrendStrengthBarBased(m5Bars);

  let type: string;
  let strength: number;

  if (atr > 11 && volumeRatio > 1.1) {
    type = "VOLATILE";
    strength = 0.8 + Math.min(atr - 11, 3) * 0.05;
  } else if (atr < 8.5 && volumeRatio < 0.9) {
    type = "QUIET";
    strength = 0.6 + (8.5 - atr) * 0.05;
  } else if (trendStrength > 0.6) {
    type = "TRENDING";
    strength = 0.7 + trendStrength * 0.2;
  } else {
    type = "RANGING";
    strength = 0.5 + (1 - trendStrength) * 0.3;
  }

  return { type, strength: Math.min(1.0, Math.max(0.3, strength)) };
}

/** Calculate ADX from M5 bar OHLC (mirrors signalEngine.calculateADX). */
function calculateADXFromBars(bars: Bar[], period: number = 14): number | null {
  if (bars.length < period + 1) return null;
  const highs = bars.slice(-(period + 1)).map(b => b.high);
  const lows = bars.slice(-(period + 1)).map(b => b.low);
  const closes = bars.slice(-(period + 1)).map(b => b.close);
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
  }
  const sumTR = trs.reduce((a, b) => a + b, 0);
  if (sumTR === 0) return null;
  const plusDI = 100 * (plusDM.reduce((a, b) => a + b, 0) / sumTR);
  const minusDI = 100 * (minusDM.reduce((a, b) => a + b, 0) / sumTR);
  const diSum = plusDI + minusDI;
  if (diSum === 0) return 0;
  const dx = 100 * Math.abs(plusDI - minusDI) / diSum;
  return parseFloat(dx.toFixed(1));
}

// ── Parse the diagnostics export ─────────────────────────────────────────────

function parseExport(filePath: string): ParsedSignal[] {
  const raw = readFileSync(filePath, "utf-8");
  const signals: ParsedSignal[] = [];
  const lines = raw.split("\n");
  let current: Partial<ParsedSignal> | null = null;

  for (const line of lines) {
    const sigMatch = line.match(/^\[(\d+)\]\s+(BUY|SELL)\s+@\s+([\d.]+)\s+—\s+status:\s+(\S+)/);
    if (sigMatch) {
      if (current && current.id) signals.push(current as ParsedSignal);
      current = {
        index: parseInt(sigMatch[1]),
        direction: sigMatch[2] as "BUY" | "SELL",
        entryPrice: parseFloat(sigMatch[3]),
        status: sigMatch[4],
        attentionScores: new Map<string, number>(),
        isWin: false,
        rMultiple: null,
      };
      // Determine win/loss from status
      const status = sigMatch[4];
      (current as Partial<ParsedSignal>).isWin =
        status === "ALL_TARGETS_HIT" ||
        status === "PARTIAL_WIN_SL_HIT" ||
        status === "CLOSED" ||
        status === "TP_HIT";
      continue;
    }

    if (current) {
      const idMatch = line.match(/^\s+id:\s+(\S+)/);
      if (idMatch && !current.id) current.id = idMatch[1];

      const genMatch = line.match(/^\s+generated:\s+(\S+)/);
      if (genMatch && current.generated === undefined) {
        const ts = new Date(genMatch[1]).getTime();
        if (!isNaN(ts)) current.generated = ts;
      }

      const confMatch = line.match(/^\s+confidence:\s+([\d.]+)%/);
      if (confMatch && current.confidence === undefined) current.confidence = parseFloat(confMatch[1]);

      // Parse attention scores from "top features" and "full attention scores" sections
      const featureMatch = line.match(/^\s+(.+?)=([\d.]+)\s*$/);
      if (featureMatch && current.attentionScores) {
        const name = featureMatch[1].trim().toUpperCase().replace(/\s+/g, "_");
        const score = parseFloat(featureMatch[2]);
        if (!isNaN(score) && score > 0) {
          (current.attentionScores as Map<string, number>).set(name, score);
        }
      }

      // Parse R-multiple if present
      const rMatch = line.match(/R-Multiple|R Multiple|net.*R:\s*(-?[\d.]+)/i);
      if (rMatch && current.rMultiple === null) {
        current.rMultiple = parseFloat(rMatch[1]);
      }
    }
  }
  if (current && current.id) signals.push(current as ParsedSignal);
  return signals;
}

// ── Paginated bar fetch from Supabase ────────────────────────────────────────

async function fetchBars(fromTs: string): Promise<Bar[]> {
  const out: Bar[] = [];
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await anon
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromTs)
      .order("timestamp", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Bar[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 100_000) break;
  }
  return out;
}

// ── Win rate computation ─────────────────────────────────────────────────────

interface FeatureWR {
  feature: string;
  oldFired: number;
  oldWins: number;
  oldWR: number;
  newFired: number;
  newWins: number;
  newWR: number;
  baseline: number;
  oldVsBaseline: string;
  newVsBaseline: string;
}

function computeWR(
  feature: string,
  signals: ParsedSignal[],
  oldFiredFn: (sig: ParsedSignal) => boolean,
  newFiredFn: (sig: ParsedSignal, m5Bars: Bar[]) => boolean,
  m5BarsBySignal: Map<number, Bar[]>,
  baseline: number,
): FeatureWR {
  let oldFired = 0, oldWins = 0;
  let newFired = 0, newWins = 0;

  for (const sig of signals) {
    // Old (tick-based): check if feature was in attention scores
    if (oldFiredFn(sig)) {
      oldFired++;
      if (sig.isWin) oldWins++;
    }

    // New (bar-based): recompute from M5 bars
    const m5Bars = m5BarsBySignal.get(sig.index) ?? [];
    if (newFiredFn(sig, m5Bars)) {
      newFired++;
      if (sig.isWin) newWins++;
    }
  }

  const oldWR = oldFired > 0 ? oldWins / oldFired : 0;
  const newWR = newFired > 0 ? newWins / newFired : 0;

  return {
    feature,
    oldFired,
    oldWins,
    oldWR,
    newFired,
    newWins,
    newWR,
    baseline,
    oldVsBaseline: oldFired > 0 ? `${oldWR > baseline ? "ABOVE" : oldWR < baseline ? "BELOW" : "AT"} baseline` : "no fires",
    newVsBaseline: newFired > 0 ? `${newWR > baseline ? "ABOVE" : newWR < baseline ? "BELOW" : "AT"} baseline` : "no fires",
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(78));
  console.log("ITEM 3a — TICK vs BAR FEATURE WIN RATES (MEASURE FIRST, read-only)");
  console.log(`run at ${new Date().toISOString()}`);
  console.log("=".repeat(78));

  // 1. Fetch ALL M1 bars
  const fromTs = "2026-06-18T00:00:00Z";
  console.log(`\nFetching M1 bars from ${fromTs}...`);
  const m1Bars = await fetchBars(fromTs);
  console.log(`Total M1 bars: ${m1Bars.length}`);

  // 2. Parse the export
  const exportSignals = parseExport("/tmp/diagnostics_export.txt");
  console.log(`Parsed ${exportSignals.length} signals from export`);

  // 3. Compute overall baseline WR
  const totalWins = exportSignals.filter(s => s.isWin).length;
  const baseline = totalWins / exportSignals.length;
  console.log(`Overall baseline WR: ${(baseline * 100).toFixed(1)}% (${totalWins}/${exportSignals.length})`);

  // 4. For each signal, get M5 bars available up to signal time
  console.log(`\nBuilding M5 bars per signal...`);
  const m5BarsBySignal = new Map<number, Bar[]>();

  // Pre-aggregate all M5 bars once
  const allM5Bars = aggregateBars(m1Bars, 5);
  console.log(`Total M5 bars: ${allM5Bars.length}`);

  for (const sig of exportSignals) {
    if (!sig.generated) continue;
    const sigTime = sig.generated;
    // Get M5 bars up to signal time (last bar must be completed before signal)
    const sigM5Bars = allM5Bars.filter(b => new Date(b.timestamp).getTime() < sigTime);
    m5BarsBySignal.set(sig.index, sigM5Bars);
  }
  console.log(`M5 bars per signal: avg=${Math.round([...m5BarsBySignal.values()].reduce((a, b) => a + b.length, 0) / m5BarsBySignal.size)}`);

  // 5. Compute direction-specific baselines
  const buySignals = exportSignals.filter(s => s.direction === "BUY");
  const sellSignals = exportSignals.filter(s => s.direction === "SELL");
  const buyBaseline = buySignals.filter(s => s.isWin).length / buySignals.length;
  const sellBaseline = sellSignals.filter(s => s.isWin).length / sellSignals.length;
  console.log(`\nBUY baseline WR: ${(buyBaseline * 100).toFixed(1)}% (${buySignals.filter(s=>s.isWin).length}/${buySignals.length})`);
  console.log(`SELL baseline WR: ${(sellBaseline * 100).toFixed(1)}% (${sellSignals.filter(s=>s.isWin).length}/${sellSignals.length})`);

  // 6. Compute win rates for each feature, split by direction
  console.log("\n" + "=".repeat(78));
  console.log("FEATURE WIN RATES — OLD (tick) vs NEW (M5 bar), split by direction");
  console.log("=".repeat(78));

  const features: FeatureWR[] = [];

  // BUY-side features (compared against BUY baseline)

  // STRONG_UPTREND (BUY feature)
  features.push(computeWR(
    "STRONG_UPTREND (BUY)",
    buySignals,
    (sig) => sig.attentionScores.has("STRONG_UPTREND") || sig.attentionScores.has("STRONG_UPTREND_PATTERN"),
    (sig, m5) => detectPriceActionPatternBarBased(m5) === "STRONG_UPTREND",
    m5BarsBySignal,
    buyBaseline,
  ));

  // ABOVE_VWAP (BUY feature)
  features.push(computeWR(
    "ABOVE_VWAP (BUY)",
    buySignals,
    (sig) => sig.attentionScores.has("ABOVE_VWAP"),
    (sig, m5) => {
      const vwap = calculateVWAPBarBased(m5);
      return vwap !== null && (sig.entryPrice - vwap) > 1.5;
    },
    m5BarsBySignal,
    buyBaseline,
  ));

  // TRENDING_STRONG contributing to BUY (regime=TRENDING + strength>0.75 + HTF=BULLISH)
  features.push(computeWR(
    "TRENDING_STRONG→BUY (regime strong + bull)",
    buySignals,
    (sig) => sig.attentionScores.has("STRONG_UPTREND"), // strong_uptrend fires when regime=TRENDING+strength>0.75+HTF=BULLISH
    (sig, m5) => {
      const regime = detectMarketRegimeBarBased(m5);
      return regime.type === "TRENDING" && regime.strength > 0.75;
    },
    m5BarsBySignal,
    buyBaseline,
  ));

  // ADX_TREND_STRENGTH (BUY feature — fires when ADX>25 and HTF+LTF bullish)
  features.push(computeWR(
    "ADX_TREND_STRENGTH (BUY)",
    buySignals,
    (sig) => sig.attentionScores.has("ADX_TREND_STRENGTH"),
    (_sig, m5) => {
      // Compute ADX from M5 bars
      if (m5.length < 15) return false;
      const adx = calculateADXFromBars(m5, 14);
      return adx !== null && adx > 25;
    },
    m5BarsBySignal,
    buyBaseline,
  ));

  // SELL-side features (compared against SELL baseline)

  // STRONG_DOWNTREND (SELL feature)
  features.push(computeWR(
    "STRONG_DOWNTREND (SELL)",
    sellSignals,
    (sig) => sig.attentionScores.has("STRONG_DOWNTREND") || sig.attentionScores.has("STRONG_DOWNTREND_PATTERN"),
    (sig, m5) => detectPriceActionPatternBarBased(m5) === "STRONG_DOWNTREND",
    m5BarsBySignal,
    sellBaseline,
  ));

  // BELOW_VWAP (SELL feature)
  features.push(computeWR(
    "BELOW_VWAP (SELL)",
    sellSignals,
    (sig) => sig.attentionScores.has("BELOW_VWAP"),
    (sig, m5) => {
      const vwap = calculateVWAPBarBased(m5);
      return vwap !== null && (sig.entryPrice - vwap) < -1.5;
    },
    m5BarsBySignal,
    sellBaseline,
  ));

  // TRENDING_STRONG contributing to SELL (regime=TRENDING + strength>0.75 + HTF=BEARISH)
  features.push(computeWR(
    "TRENDING_STRONG→SELL (regime strong + bear)",
    sellSignals,
    (sig) => sig.attentionScores.has("STRONG_DOWNTREND"),
    (sig, m5) => {
      const regime = detectMarketRegimeBarBased(m5);
      return regime.type === "TRENDING" && regime.strength > 0.75;
    },
    m5BarsBySignal,
    sellBaseline,
  ));

  // ADX_TREND_STRENGTH (SELL feature)
  features.push(computeWR(
    "ADX_TREND_STRENGTH (SELL)",
    sellSignals,
    (sig) => sig.attentionScores.has("ADX_TREND_STRENGTH"),
    (_sig, m5) => {
      if (m5.length < 15) return false;
      const adx = calculateADXFromBars(m5, 14);
      return adx !== null && adx > 25;
    },
    m5BarsBySignal,
    sellBaseline,
  ));

  // Print results
  console.log(`\nBaseline WR: ${(baseline * 100).toFixed(1)}%\n`);
  console.log(
    `${"Feature".padEnd(40)} ${"OLD fires/wins/WR".padEnd(25)} ${"NEW fires/wins/WR".padEnd(25)} ${"Old vs base".padEnd(20)} ${"New vs base".padEnd(20)}`,
  );
  console.log("-".repeat(130));

  for (const f of features) {
    const oldStr = f.oldFired > 0
      ? `${f.oldFired}/${f.oldWins}/${(f.oldWR * 100).toFixed(1)}%`
      : "0/-/-";
    const newStr = f.newFired > 0
      ? `${f.newFired}/${f.newWins}/${(f.newWR * 100).toFixed(1)}%`
      : "0/-/-";
    console.log(
      `${f.feature.padEnd(40)} ${oldStr.padEnd(25)} ${newStr.padEnd(25)} ${f.oldVsBaseline.padEnd(20)} ${f.newVsBaseline.padEnd(20)}`,
    );
  }

  // 6. Per-feature verdict
  console.log("\n" + "=".repeat(78));
  console.log("PER-FEATURE GATE VERDICT (adopt bar-based only if WR moves toward/above baseline)");
  console.log("=".repeat(78));

  for (const f of features) {
    if (f.oldFired === 0 && f.newFired === 0) {
      console.log(`  ${f.feature}: no fires on either basis — SKIP`);
      continue;
    }
    if (f.newFired === 0) {
      console.log(`  ${f.feature}: bar-based version never fires — feature may be worthless on bars`);
      continue;
    }

    // Use the direction-specific baseline stored in the feature, not the overall
    const dirBaseline = f.baseline;
    const oldDelta = f.oldWR - dirBaseline;
    const newDelta = f.newWR - dirBaseline;
    const improved = newDelta > oldDelta;

    if (f.oldFired > 0 && f.oldWR < dirBaseline && f.newWR >= dirBaseline) {
      console.log(`  ${f.feature}: INVERTED→FIXED — old ${(f.oldWR * 100).toFixed(1)}% (below baseline) → new ${(f.newWR * 100).toFixed(1)}% (at/above baseline) → ADOPT bar-based`);
    } else if (f.oldFired > 0 && f.oldWR < dirBaseline && f.newWR < dirBaseline && improved) {
      console.log(`  ${f.feature}: below baseline on both, but improved — old ${(f.oldWR * 100).toFixed(1)}% → new ${(f.newWR * 100).toFixed(1)}% → CONSIDER adopting (still below baseline but materially better)`);
    } else if (f.oldFired > 0 && f.oldWR < dirBaseline && f.newWR < dirBaseline && !improved) {
      console.log(`  ${f.feature}: below baseline on both, NOT improved — old ${(f.oldWR * 100).toFixed(1)}% → new ${(f.newWR * 100).toFixed(1)}% → DROP (worthless on either basis)`);
    } else if (f.oldFired > 0 && f.oldWR >= dirBaseline && f.newWR >= dirBaseline) {
      console.log(`  ${f.feature}: above baseline on both — old ${(f.oldWR * 100).toFixed(1)}% → new ${(f.newWR * 100).toFixed(1)}% → ADOPT bar-based (both work, bar-based is correct venue)`);
    } else if (f.oldFired > 0 && f.oldWR >= dirBaseline && f.newWR < dirBaseline) {
      console.log(`  ${f.feature}: REGRESSED — old ${(f.oldWR * 100).toFixed(1)}% (above) → new ${(f.newWR * 100).toFixed(1)}% (below) → KEEP tick-based (bar version is worse)`);
    } else {
      console.log(`  ${f.feature}: ambiguous — old ${(f.oldWR * 100).toFixed(1)}% → new ${(f.newWR * 100).toFixed(1)}% → REVIEW`);
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
