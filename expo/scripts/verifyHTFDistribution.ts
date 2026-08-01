/**
 * ITEM 2c+2d: Verify dailyEMA can fire + report corrected HTF verdict
 * distribution across the export vs the old one.
 *
 * Reads M1 bars DIRECTLY from Supabase gold_m1_bars (anon key, no backend,
 * no GC=F/TwelveData), builds daily OHLC candles, and runs the fixed
 * detectHTFTrend for every signal in the diagnostics export.
 *
 * Reports:
 *   - How many daily candles are available (must be >= 10 for dailyEMA)
 *   - What dailyEMA returns for each signal
 *   - Old vs new HTF verdict distribution
 *   - How many of the 13 "STRONG UPTREND" signals flip
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

// ── Types ────────────────────────────────────────────────────────────────────

interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface DailyOHLC {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number;
}

interface ExportSignal {
  id: string;
  direction: string;
  createdAt: string;
  entryPrice: number;
  htfTrend?: string;
  signalType?: string;
  confidence?: number;
  outcome?: string;
  rMultiple?: number;
}

// ── NY Trading Day helpers (verbatim from signalEngine.ts) ───────────────────

function getNYTradingDayKey(date: Date): string {
  const NY_CLOSE_HOUR_UTC = 21;
  const hour = date.getUTCHours();
  const tradingDate = new Date(date);
  if (hour >= NY_CLOSE_HOUR_UTC) {
    tradingDate.setUTCDate(tradingDate.getUTCDate() + 1);
  }
  const year = tradingDate.getUTCFullYear();
  const month = String(tradingDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(tradingDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getNYTradingDayCloseTimestamp(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 21, 0, 0, 0);
}

// ── Build daily OHLC from M1 bars (mirrors buildDailyOHLCBarsFromHistoricalBars) ──

function buildDailyOHLC(bars: Bar[], now: number): DailyOHLC[] {
  const grouped = new Map<string, DailyOHLC>();
  const ordered = [...bars].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  for (const bar of ordered) {
    const ts = new Date(bar.timestamp).getTime();
    const dateKey = getNYTradingDayKey(new Date(ts));
    const closeTs = getNYTradingDayCloseTimestamp(dateKey);
    const existing = grouped.get(dateKey);
    if (!existing) {
      grouped.set(dateKey, {
        date: dateKey,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        timestamp: closeTs,
      });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close;
    }
  }

  return Array.from(grouped.values())
    .filter((bar) => bar.timestamp <= now)
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ── EMA (mirrors signalEngine.calculateEMA) ──────────────────────────────────

function calculateEMA(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── detectHTFTrend (OLD — buggy arbitration) ─────────────────────────────────

function detectHTFTrendOld(
  price: number,
  dailyPivot: number,
  dailyBars: DailyOHLC[],
  currentDayOHLC: { open: number; close: number } | null,
): { verdict: string; bull: number; bear: number; components: string } {
  const priceVsPivot = price - dailyPivot;
  const pivotBullish = priceVsPivot > 10 ? 1 : 0;
  const pivotBearish = priceVsPivot < -10 ? 1 : 0;

  let devBull = 0, devBear = 0;
  if (currentDayOHLC) {
    const devMove = currentDayOHLC.close - currentDayOHLC.open;
    if (devMove > 5.0) devBull = 1.5;
    else if (devMove > 2.0) devBull = 1.0;
    else if (devMove < -5.0) devBear = 1.5;
    else if (devMove < -2.0) devBear = 1.0;
  }

  const sorted = [...dailyBars].filter((b) => b.timestamp < Date.now());
  let trendBull = 0, trendBear = 0;
  if (sorted.length >= 3) {
    const [b1, b2, b3] = sorted.slice(-3);
    if (b3.high > b2.high && b2.high > b1.high && b3.close > b2.close && b2.close > b1.close) trendBull = 1;
    else if (b3.low < b2.low && b2.low < b1.low && b3.close < b2.close && b2.close < b1.close) trendBear = 1;
  }

  let emaBull = 0, emaBear = 0;
  if (sorted.length >= 10) {
    const closes = sorted.map((b) => b.close);
    const ema5 = calculateEMA(closes, 5);
    const ema10 = calculateEMA(closes, 10);
    if (ema5 > ema10) emaBull = 0.5;
    else if (ema5 < ema10) emaBear = 0.5;
  }

  const bull = pivotBullish + devBull + trendBull + emaBull;
  const bear = pivotBearish + devBear + trendBear + emaBear;

  // OLD: bull tested first
  let verdict: string;
  if (bull >= 1.5) verdict = "BULLISH";
  else if (bear >= 1.5) verdict = "BEARISH";
  else verdict = "NEUTRAL";

  const components = `pivot(${pivotBullish}/${pivotBearish}) dev(${devBull}/${devBear}) trend(${trendBull}/${trendBear}) ema(${emaBull}/${emaBear})`;
  return { verdict, bull, bear, components };
}

// ── detectHTFTrend (NEW — fixed arbitration) ─────────────────────────────────

function detectHTFTrendNew(
  price: number,
  dailyPivot: number,
  dailyBars: DailyOHLC[],
  currentDayOHLC: { open: number; close: number } | null,
): { verdict: string; bull: number; bear: number; components: string } {
  const priceVsPivot = price - dailyPivot;
  const pivotBullish = priceVsPivot > 10 ? 1 : 0;
  const pivotBearish = priceVsPivot < -10 ? 1 : 0;

  let devBull = 0, devBear = 0;
  if (currentDayOHLC) {
    const devMove = currentDayOHLC.close - currentDayOHLC.open;
    if (devMove > 5.0) devBull = 1.5;
    else if (devMove > 2.0) devBull = 1.0;
    else if (devMove < -5.0) devBear = 1.5;
    else if (devMove < -2.0) devBear = 1.0;
  }

  const sorted = [...dailyBars].filter((b) => b.timestamp < Date.now());
  let trendBull = 0, trendBear = 0;
  if (sorted.length >= 3) {
    const [b1, b2, b3] = sorted.slice(-3);
    if (b3.high > b2.high && b2.high > b1.high && b3.close > b2.close && b2.close > b1.close) trendBull = 1;
    else if (b3.low < b2.low && b2.low < b1.low && b3.close < b2.close && b2.close < b1.close) trendBear = 1;
  }

  let emaBull = 0, emaBear = 0;
  if (sorted.length >= 10) {
    const closes = sorted.map((b) => b.close);
    const ema5 = calculateEMA(closes, 5);
    const ema10 = calculateEMA(closes, 10);
    if (ema5 > ema10) emaBull = 0.5;
    else if (ema5 < ema10) emaBear = 0.5;
  }

  const bull = pivotBullish + devBull + trendBull + emaBull;
  const bear = pivotBearish + devBear + trendBear + emaBear;

  // NEW: higher score wins, ties → NEUTRAL
  let verdict: string;
  if (bull >= 1.5 && bull > bear) verdict = "BULLISH";
  else if (bear >= 1.5 && bear > bull) verdict = "BEARISH";
  else verdict = "NEUTRAL";

  const components = `pivot(${pivotBullish}/${pivotBearish}) dev(${devBull}/${devBear}) trend(${trendBull}/${trendBear}) ema(${emaBull}/${emaBear})`;
  return { verdict, bull, bear, components };
}

// ── Parse the diagnostics export ─────────────────────────────────────────────

interface ParsedSignal {
  index: number;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  status: string;
  id: string;
  generated: number; // epoch ms
  confidence: number;
  hasStrongUptrend: boolean;
  hasStrongDowntrend: boolean;
}

function parseExport(filePath: string): ParsedSignal[] {
  const raw = readFileSync(filePath, "utf-8");
  const signals: ParsedSignal[] = [];
  const lines = raw.split("\n");
  let current: Partial<ParsedSignal> | null = null;

  for (const line of lines) {
    // Signal start: [N] BUY @ 4062.1  —  status: SL_HIT
    const sigMatch = line.match(/^\[(\d+)\]\s+(BUY|SELL)\s+@\s+([\d.]+)\s+—\s+status:\s+(\S+)/);
    if (sigMatch) {
      if (current && current.id) signals.push(current as ParsedSignal);
      current = {
        index: parseInt(sigMatch[1]),
        direction: sigMatch[2] as 'BUY' | 'SELL',
        entryPrice: parseFloat(sigMatch[3]),
        status: sigMatch[4],
        hasStrongUptrend: false,
        hasStrongDowntrend: false,
      };
      continue;
    }

    if (current) {
      // id: signal_1785488164658_f5gk1qkma
      const idMatch = line.match(/^\s+id:\s+(\S+)/);
      if (idMatch && !current.id) current.id = idMatch[1];

      // generated: 2026-07-31T08:56:04.658Z    entry time: 10:56
      const genMatch = line.match(/^\s+generated:\s+(\S+)/);
      if (genMatch && !current.generated) {
        const ts = new Date(genMatch[1]).getTime();
        if (!isNaN(ts)) current.generated = ts;
      }

      // confidence: 91.0%
      const confMatch = line.match(/^\s+confidence:\s+([\d.]+)%/);
      if (confMatch && current.confidence === undefined) current.confidence = parseFloat(confMatch[1]);

      // Check for STRONG UPTREND in attention scores
      if (line.includes('STRONG UPTREND')) current.hasStrongUptrend = true;
      if (line.includes('STRONG DOWNTREND')) current.hasStrongDowntrend = true;
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(78));
  console.log("ITEM 2c+2d — DAILY EMA + HTF VERDICT DISTRIBUTION");
  console.log(`run at ${new Date().toISOString()}`);
  console.log("=".repeat(78));

  // 1. Fetch ALL bars from Supabase
  const fromTs = "2026-06-18T00:00:00Z"; // start of coverage
  console.log(`\nFetching M1 bars from ${fromTs}...`);
  const bars = await fetchBars(fromTs);
  console.log(`Total M1 bars: ${bars.length}`);
  console.log(`Window: ${bars[0]?.timestamp} → ${bars[bars.length - 1]?.timestamp}`);

  // 2. Build daily OHLC
  const now = Date.now();
  const dailyBars = buildDailyOHLC(bars, now);
  console.log(`\nDaily candles built: ${dailyBars.length}`);
  console.log(`Daily candle range: ${dailyBars[0]?.date} → ${dailyBars[dailyBars.length - 1]?.date}`);
  for (const d of dailyBars) {
    console.log(`  ${d.date}: O=${d.open} H=${d.high} L=${d.low} C=${d.close}`);
  }

  // 3. Check dailyEMA viability
  const completedDailyBars = dailyBars.filter((b) => b.timestamp < now);
  console.log(`\nCompleted daily bars: ${completedDailyBars.length}`);
  console.log(`dailyEMA requires >= 10: ${completedDailyBars.length >= 10 ? "CAN FIRE ✓" : "CANNOT FIRE ✗"}`);

  if (completedDailyBars.length >= 10) {
    const closes = completedDailyBars.map((b) => b.close);
    const ema5 = calculateEMA(closes, 5);
    const ema10 = calculateEMA(closes, 10);
    console.log(`ema5=${ema5.toFixed(2)}, ema10=${ema10.toFixed(2)}, ema5>ema10=${ema5 > ema10} → ${ema5 > ema10 ? "BULLISH" : "BEARISH"}`);
  }

  // 4. Parse the export
  const exportPath = "/tmp/diagnostics_export.txt";
  let exportSignals: ParsedSignal[] = [];
  try {
    exportSignals = parseExport(exportPath);
    console.log(`\nParsed ${exportSignals.length} signals from export`);
  } catch {
    console.log(`\nNo export file at ${exportPath} — skipping per-signal analysis`);
  }

  // 5. For each signal, compute old vs new HTF
  if (exportSignals.length > 0) {
    console.log("\n" + "=".repeat(78));
    console.log("HTF VERDICT DISTRIBUTION — OLD vs NEW (reconstructed from Supabase bars)");
    console.log("=".repeat(78));

    const oldDist: Record<string, number> = {};
    const newDist: Record<string, number> = {};
    const flips: { id: string; old: string; new: string; bull: number; bear: number; components: string }[] = [];
    let strongUptrendCount = 0;
    let strongUptrendFlips = 0;
    let processed = 0;
    let skipped = 0;

    for (const sig of exportSignals) {
      if (!sig.generated || !sig.entryPrice) { skipped++; continue; }
      const sigTime = sig.generated;
      if (isNaN(sigTime)) { skipped++; continue; }

      // Build daily bars available UP TO this signal's time
      const sigDailyBars = dailyBars.filter((b) => b.timestamp < sigTime);
      if (sigDailyBars.length === 0) { skipped++; continue; }

      // Daily pivot = (prev day H + L + C) / 3
      const prevDayBars = sigDailyBars.slice(-1);
      const dailyPivot = prevDayBars.length > 0
        ? (prevDayBars[0].high + prevDayBars[0].low + prevDayBars[0].close) / 3
        : sig.entryPrice;

      // Developing day: find M1 bars on the same NY trading day as the signal
      const sigDayKey = getNYTradingDayKey(new Date(sigTime));
      let sigDayOpen = 0;
      let sigDayClose = 0;
      let sigDayCount = 0;
      for (const bar of bars) {
        const bTs = new Date(bar.timestamp).getTime();
        if (bTs > sigTime) break;
        if (getNYTradingDayKey(new Date(bTs)) === sigDayKey) {
          if (sigDayCount === 0) sigDayOpen = bar.open;
          sigDayClose = bar.close;
          sigDayCount++;
        }
      }
      const currentDayOHLC = sigDayCount > 0
        ? { open: sigDayOpen, close: sigDayClose }
        : null;

      const old = detectHTFTrendOld(sig.entryPrice, dailyPivot, sigDailyBars, currentDayOHLC);
      const newRes = detectHTFTrendNew(sig.entryPrice, dailyPivot, sigDailyBars, currentDayOHLC);

      oldDist[old.verdict] = (oldDist[old.verdict] ?? 0) + 1;
      newDist[newRes.verdict] = (newDist[newRes.verdict] ?? 0) + 1;
      processed++;

      // Track "STRONG UPTREND" feature signals
      if (sig.hasStrongUptrend) {
        strongUptrendCount++;
        if (old.verdict !== newRes.verdict) {
          strongUptrendFlips++;
        }
      }

      if (old.verdict !== newRes.verdict) {
        flips.push({
          id: sig.id,
          old: old.verdict,
          new: newRes.verdict,
          bull: newRes.bull,
          bear: newRes.bear,
          components: newRes.components,
        });
      }
    }

    console.log(`\n  Processed: ${processed}, Skipped (no daily bars/no timestamp): ${skipped}`);
    console.log(`\n  OLD distribution: ${JSON.stringify(oldDist)}`);
    console.log(`  NEW distribution: ${JSON.stringify(newDist)}`);
    console.log(`\n  Signals with STRONG UPTREND feature in export: ${strongUptrendCount}`);
    console.log(`  STRONG UPTREND signals whose HTF verdict flips: ${strongUptrendFlips}`);

    console.log(`\n  Total flips: ${flips.length}`);
    for (const f of flips.slice(0, 50)) {
      console.log(`    ${f.id}: ${f.old} → ${f.new}  (B=${f.bull} S=${f.bear}  ${f.components})`);
    }
    if (flips.length > 50) console.log(`    ... and ${flips.length - 50} more`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
