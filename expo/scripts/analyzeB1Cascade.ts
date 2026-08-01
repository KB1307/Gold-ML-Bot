/**
 * B1 COUNTERFACTUAL — HTF -> M15 -> M5 directional cascade, M1 for TIMING ONLY.
 *
 * MEASURE BEFORE BUILDING. This script writes NOTHING and changes no engine
 * code. It answers one pre-registered question:
 *
 *   If signal DIRECTION were required to agree across HTF (daily) + M15 + M5,
 *   all aggregated from REAL Vantage M1 bars, how does whole-system EV, win
 *   rate, profit factor and net $ change versus the shipped baseline?
 *
 * PRE-REGISTERED GATE (fixed before running, not after):
 *   BUILD only if   dEV >= +0.05R   AND   volume retained >= 40%.
 *   Blocked signals are counted as ZERO R, NOT excluded.
 *
 * ── DATA-SOURCE RULE (enforced structurally in this file) ────────────────────
 *  - EVERY bar used here is read DIRECTLY from Supabase `gold_m1_bars` with the
 *    anon key, paginated past the PostgREST 1000-row cap.
 *  - There is NO Rork backend call in this file. `trpcClient` is not imported.
 *  - There is NO GC=F / Yahoo / TwelveData / Tiingo path in this file. Those
 *    strings do not appear outside this comment. If the Supabase read returns
 *    insufficient bars for a signal, that signal is reported as NO_COVERAGE and
 *    excluded from BOTH arms — it is never back-filled from another venue.
 *  - priceHistory (Capital.com / Swissquote ticks) is NOT used. Direction here
 *    comes only from aggregated Vantage bars.
 *
 * ── DETECTORS ────────────────────────────────────────────────────────────────
 * No new indicators are invented. Two existing engine detectors are reused,
 * moved onto the correct timeframe:
 *
 *  HTF  = signalEngine.detectHTFTrend() replicated verbatim (4 components:
 *         price-vs-daily-pivot, developing-day move, 3-completed-day structure,
 *         daily EMA5-vs-EMA10; BULLISH/BEARISH at score >= 1.5) but fed daily
 *         candles aggregated from real gold_m1_bars instead of the daily-OHLC
 *         cache that Phase A proved was being fed the wrong thing.
 *  M15/M5 = signalEngine.detectLTFTrend() momentum rule replicated verbatim
 *         (last close vs mean of last 5 closes, threshold
 *         max(p*0.00005, min(p*0.0005, volatility*0.3))) applied to M15 and M5
 *         candles instead of to a 5-TICK window.
 *
 * M1 is deliberately absent from the direction decision. It cannot appear here:
 * the cascade function's signature only receives HTF/M15/M5 verdicts.
 *
 * Usage: bunx tsx expo/scripts/analyzeB1Cascade.ts <path-to-export.txt>
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── env ──────────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "expo/.env"),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error("no .env found");
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}

const env = loadEnv();
const SUPABASE_URL = env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_ANON_KEY = env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY");
  process.exit(1);
}
const anon: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── types ────────────────────────────────────────────────────────────────────

type Dir = "BULLISH" | "BEARISH" | "NEUTRAL";

interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface ParsedSignal {
  index: number;
  direction: "BUY" | "SELL";
  entry: number;
  status: string;
  id: string;
  generatedMs: number;
  confidence: number;
  tp: number[];
  sl: number;
  exitPrice: number | null;
  atr: number | null;
  features: Record<string, number>;
}

// ── export parsing (identical to the six prior counterfactual scripts) ───────

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function parseExport(path: string): ParsedSignal[] {
  const raw = readFileSync(path, "utf8");
  const body = raw.slice(raw.indexOf("SECTION 1"), raw.indexOf("SECTION 2"));
  const blocks = body.split(/\n(?=\[\d+\] (?:BUY|SELL) @ )/).slice(1);
  const out: ParsedSignal[] = [];
  for (const block of blocks) {
    const head = block.match(/^\[(\d+)\] (BUY|SELL) @ ([\d.]+)\s+—\s+status: ([A-Z_]+)/);
    if (!head) continue;
    const tpm = block.match(/TP1: ([\d.]+)\s+TP2: ([\d.]+)\s+TP3: ([\d.]+)\s+SL: ([\d.]+)/);
    const regime = block.match(/\((?:High|Low|Normal) Volatility \| ATR: ([\d.]+)\)/);
    const features: Record<string, number> = {};
    const full = block.match(/full attention scores \(\d+ total\):\n([\s\S]*?)(?:\n\s{4}\S|\n\n|$)/);
    if (full) {
      for (const line of full[1].split("\n")) {
        const m = line.match(/^\s+([A-Z0-9 _/-]+)=(-?[\d.]+)/);
        if (m) features[m[1].trim()] = parseFloat(m[2]);
      }
    }
    out.push({
      index: parseInt(head[1], 10),
      direction: head[2] as "BUY" | "SELL",
      entry: parseFloat(head[3]),
      status: head[4],
      id: block.match(/id: (\S+)/)?.[1] ?? "",
      generatedMs: new Date(block.match(/generated: (\S+)/)?.[1] ?? "").getTime(),
      confidence: num(block.match(/confidence: ([\d.]+)%/)?.[1]) ?? 0,
      tp: tpm ? [parseFloat(tpm[1]), parseFloat(tpm[2]), parseFloat(tpm[3])] : [],
      sl: tpm ? parseFloat(tpm[4]) : 0,
      exitPrice: num(block.match(/exit price: ([\d.]+)/)?.[1]),
      atr: num(regime?.[1]),
      features,
    });
  }
  return out;
}

// ── Supabase M1 read (PAGINATED — the 1000-row cap is real) ──────────────────

async function fetchAllM1Bars(fromIso: string, toIso: string): Promise<Bar[]> {
  const PAGE = 1000;
  const bars: Bar[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await anon
      .from("gold_m1_bars")
      .select("timestamp, open, high, low, close")
      .gte("timestamp", fromIso)
      .lte("timestamp", toIso)
      .order("timestamp", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`gold_m1_bars read failed: ${error.message}`);
    const rows = data ?? [];
    for (const r of rows) {
      bars.push({
        ts: new Date(r.timestamp as string).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      });
    }
    if (rows.length < PAGE) break;
  }
  return bars;
}

// ── aggregation ──────────────────────────────────────────────────────────────

/** Aggregate M1 bars into fixed-width buckets (ms). Bars must be time-sorted. */
function aggregate(m1: Bar[], bucketMs: number): Bar[] {
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of m1) {
    const bucket = Math.floor(b.ts / bucketMs) * bucketMs;
    if (!cur || cur.ts !== bucket) {
      if (cur) out.push(cur);
      cur = { ts: bucket, open: b.open, high: b.high, low: b.low, close: b.close };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** UTC-day aggregation (calendar day, matching the engine's daily OHLC). */
function aggregateDaily(m1: Bar[]): Bar[] {
  return aggregate(m1, 24 * 60 * 60 * 1000);
}

// ── detectors (verbatim replications, moved to the right timeframe) ──────────

function mean(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function calculateEMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

/**
 * signalEngine.detectLTFTrend() momentum rule, applied to BARS of a chosen
 * timeframe rather than to a 5-TICK window. Volatility uses the mean true
 * range of the last 20 bars of that timeframe (the bar-native analogue of
 * calculateRealTimeVolatility, which the engine computes from ticks).
 */
function trendFromBars(bars: Bar[]): Dir {
  if (bars.length < 5) return "NEUTRAL";
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const avg5 = mean(closes.slice(-5));
  const momentum = last - avg5;
  const volatility = mean(bars.slice(-20).map((b) => b.high - b.low));
  const threshold = Math.max(last * 0.00005, Math.min(last * 0.0005, volatility * 0.3));
  if (momentum > threshold) return "BULLISH";
  if (momentum < -threshold) return "BEARISH";
  return "NEUTRAL";
}

interface HtfDetail {
  verdict: Dir;
  bullishScore: number;
  bearishScore: number;
  devMove: number | null;
  completedDays: number;
  pivot: number | null;
}

/**
 * signalEngine.detectHTFTrend() replicated component-for-component, fed daily
 * candles built from real gold_m1_bars.
 */
function htfFromDailyBars(
  completedDaily: Bar[],
  developingDay: Bar | null,
  currentPrice: number,
): HtfDetail {
  // Component 1 — price vs daily pivot (prev completed day, (H+L+C)/3)
  let pivotBullish = 0;
  let pivotBearish = 0;
  let pivot: number | null = null;
  const prev = completedDaily[completedDaily.length - 1];
  if (prev) {
    pivot = (prev.high + prev.low + prev.close) / 3;
    const d = currentPrice - pivot;
    if (d > 10) pivotBullish = 1;
    else if (d < -10) pivotBearish = 1;
  }

  // Component 2 — developing day close-vs-open (dollars; 20p = $2, 50p = $5)
  let devBull = 0;
  let devBear = 0;
  let devMove: number | null = null;
  if (developingDay) {
    devMove = developingDay.close - developingDay.open;
    if (devMove > 5.0) devBull = 1.5;
    else if (devMove > 2.0) devBull = 1.0;
    else if (devMove < -5.0) devBear = 1.5;
    else if (devMove < -2.0) devBear = 1.0;
  }

  // Component 3 — last 3 completed daily bars' structure
  let trendBull = 0;
  let trendBear = 0;
  if (completedDaily.length >= 3) {
    const [b1, b2, b3] = completedDaily.slice(-3);
    const higherHighs = b3.high > b2.high && b2.high > b1.high;
    const higherCloses = b3.close > b2.close && b2.close > b1.close;
    const lowerLows = b3.low < b2.low && b2.low < b1.low;
    const lowerCloses = b3.close < b2.close && b2.close < b1.close;
    if (higherHighs && higherCloses) trendBull = 1;
    else if (lowerLows && lowerCloses) trendBear = 1;
  }

  // Component 4 — daily EMA5 vs EMA10
  let emaBull = 0;
  let emaBear = 0;
  if (completedDaily.length >= 10) {
    const closes = completedDaily.map((b) => b.close);
    const e5 = calculateEMA(closes, 5);
    const e10 = calculateEMA(closes, 10);
    if (e5 > e10) emaBull = 0.5;
    else if (e5 < e10) emaBear = 0.5;
  }

  const bullishScore = pivotBullish + devBull + trendBull + emaBull;
  const bearishScore = pivotBearish + devBear + trendBear + emaBear;
  const verdict: Dir =
    bullishScore >= 1.5 ? "BULLISH" : bearishScore >= 1.5 ? "BEARISH" : "NEUTRAL";
  return {
    verdict,
    bullishScore,
    bearishScore,
    devMove,
    completedDays: completedDaily.length,
    pivot,
  };
}

/**
 * The cascade. Note the signature: it receives ONLY the three higher-timeframe
 * verdicts. There is no M1 or tick argument, so M1 is STRUCTURALLY INCAPABLE of
 * setting direction here — the same property the engine implementation must have.
 */
function cascadeAllows(dir: "BUY" | "SELL", htf: Dir, m15: Dir, m5: Dir): boolean {
  const want: Dir = dir === "BUY" ? "BULLISH" : "BEARISH";
  return htf === want && m15 === want && m5 === want;
}

// ── metrics ──────────────────────────────────────────────────────────────────

function riskDollars(s: ParsedSignal): number {
  return Math.abs(s.entry - s.sl);
}
function pnlDollars(s: ParsedSignal): number | null {
  if (s.exitPrice === null) return null;
  return s.direction === "BUY" ? s.exitPrice - s.entry : s.entry - s.exitPrice;
}
function rMultiple(s: ParsedSignal): number | null {
  const p = pnlDollars(s);
  const r = riskDollars(s);
  if (p === null || r <= 0) return null;
  return p / r;
}

interface Arm {
  label: string;
  nOriginal: number;
  nRetained: number;
  retentionPct: number;
  winRate: number;
  pf: number;
  evPerOriginal: number;
  evPerRetained: number;
  netDollars: number;
}

/** EV is per ORIGINAL signal: blocked signals contribute 0R and 0$, never dropped. */
function armMetrics(label: string, all: ParsedSignal[], retained: Set<number>): Arm {
  const kept = all.filter((s) => retained.has(s.index));
  const rs = kept.map(rMultiple).filter((v): v is number => v !== null);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const gross = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const sumR = rs.reduce((a, b) => a + b, 0);
  const net = kept.map(pnlDollars).filter((v): v is number => v !== null).reduce((a, b) => a + b, 0);
  return {
    label,
    nOriginal: all.length,
    nRetained: kept.length,
    retentionPct: all.length ? (kept.length / all.length) * 100 : 0,
    winRate: rs.length ? (wins.length / rs.length) * 100 : 0,
    pf: grossLoss > 0 ? gross / grossLoss : gross > 0 ? Infinity : 0,
    evPerOriginal: all.length ? sumR / all.length : 0,
    evPerRetained: rs.length ? sumR / rs.length : 0,
    netDollars: net,
  };
}

function row(a: Arm): string {
  const pf = Number.isFinite(a.pf) ? a.pf.toFixed(2) : "inf";
  return [
    a.label.padEnd(34),
    String(a.nRetained).padStart(4) + "/" + String(a.nOriginal).padEnd(4),
    (a.retentionPct.toFixed(1) + "%").padStart(7),
    (a.winRate.toFixed(1) + "%").padStart(7),
    pf.padStart(6),
    (a.evPerOriginal >= 0 ? "+" : "") + a.evPerOriginal.toFixed(4) + "R",
    ((a.evPerRetained >= 0 ? "+" : "") + a.evPerRetained.toFixed(4) + "R").padStart(10),
    ("$" + a.netDollars.toFixed(1)).padStart(10),
  ].join("  ");
}

// ── main ─────────────────────────────────────────────────────────────────────

const GATE_EV = 0.05;
const GATE_RETENTION = 40;
const MIN_M5_BARS = 5;
const MIN_M15_BARS = 5;
const MIN_COMPLETED_DAYS = 3;

async function main(): Promise<void> {
  const exportPath = process.argv[2] ?? "/tmp/export31.txt";
  console.log("═".repeat(108));
  console.log("  B1 COUNTERFACTUAL — HTF + M15 + M5 DIRECTIONAL CASCADE (read-only, no engine change)");
  console.log("═".repeat(108));

  const all = parseExport(exportPath).sort((a, b) => a.generatedMs - b.generatedMs);
  console.log(`\nExport: ${exportPath}`);
  console.log(`Signals parsed: ${all.length}  (BUY ${all.filter((s) => s.direction === "BUY").length} / SELL ${all.filter((s) => s.direction === "SELL").length})`);

  // ── bar read ───────────────────────────────────────────────────────────────
  console.log("\n── DATA SOURCE ─────────────────────────────────────────────────────────");
  const t0 = Date.now();
  const m1 = await fetchAllM1Bars("2026-07-01T00:00:00Z", "2026-08-02T00:00:00Z");
  console.log(`  table      : gold_m1_bars (Supabase, DIRECT, anon key, paginated)`);
  console.log(`  key        : EXPO_PUBLIC_SUPABASE_ANON_KEY  (no service role, no Rork backend)`);
  console.log(`  rows       : ${m1.length}  (fetched in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`  span       : ${new Date(m1[0].ts).toISOString()} → ${new Date(m1[m1.length - 1].ts).toISOString()}`);
  console.log(`  fallbacks  : NONE. No GC=F / Yahoo / TwelveData / Tiingo / backend path exists in this file.`);

  const m5All = aggregate(m1, 5 * 60 * 1000);
  const m15All = aggregate(m1, 15 * 60 * 1000);
  const dailyAll = aggregateDaily(m1);
  console.log(`  aggregates : M5=${m5All.length}  M15=${m15All.length}  D1=${dailyAll.length}  (all derived from the M1 rows above)`);

  // ── per-signal classification ─────────────────────────────────────────────
  interface Row {
    s: ParsedSignal;
    htf: HtfDetail;
    m15: Dir;
    m5: Dir;
    allowed: boolean;
    coverage: "OK" | "NO_M1" | "NO_DAILY";
  }

  const rows: Row[] = [];
  for (const s of all) {
    const cut = s.generatedMs;
    const m5Prior = m5All.filter((b) => b.ts + 5 * 60 * 1000 <= cut);
    const m15Prior = m15All.filter((b) => b.ts + 15 * 60 * 1000 <= cut);
    const dayStart = Math.floor(cut / 86400000) * 86400000;
    const completedDaily = dailyAll.filter((b) => b.ts < dayStart);
    const devBars = m1.filter((b) => b.ts >= dayStart && b.ts <= cut);
    const developing: Bar | null = devBars.length
      ? {
          ts: dayStart,
          open: devBars[0].open,
          high: Math.max(...devBars.map((b) => b.high)),
          low: Math.min(...devBars.map((b) => b.low)),
          close: devBars[devBars.length - 1].close,
        }
      : null;
    const lastM1 = m1.filter((b) => b.ts <= cut).pop();

    let coverage: Row["coverage"] = "OK";
    if (m5Prior.length < MIN_M5_BARS || m15Prior.length < MIN_M15_BARS || !lastM1 || !developing) {
      coverage = "NO_M1";
    } else if (completedDaily.length < MIN_COMPLETED_DAYS) {
      coverage = "NO_DAILY";
    }

    const htf =
      coverage === "OK" && lastM1
        ? htfFromDailyBars(completedDaily, developing, lastM1.close)
        : { verdict: "NEUTRAL" as Dir, bullishScore: 0, bearishScore: 0, devMove: null, completedDays: completedDaily.length, pivot: null };
    const m15 = coverage === "OK" ? trendFromBars(m15Prior) : "NEUTRAL";
    const m5 = coverage === "OK" ? trendFromBars(m5Prior) : "NEUTRAL";
    const allowed = coverage === "OK" && cascadeAllows(s.direction, htf.verdict, m15, m5);
    rows.push({ s, htf, m15, m5, allowed, coverage });
  }

  const noCov = rows.filter((r) => r.coverage !== "OK");
  console.log("\n── COVERAGE ────────────────────────────────────────────────────────────");
  console.log(`  signals with full HTF+M15+M5 bar coverage : ${rows.length - noCov.length}`);
  console.log(`  excluded, no M1 bars in window            : ${rows.filter((r) => r.coverage === "NO_M1").length}`);
  console.log(`  excluded, <${MIN_COMPLETED_DAYS} completed daily bars      : ${rows.filter((r) => r.coverage === "NO_DAILY").length}`);
  console.log("  (excluded signals are dropped from BOTH arms — never back-filled from another venue)");

  // measurement set: covered AND resolved (R is defined)
  const measured = rows.filter((r) => r.coverage === "OK" && rMultiple(r.s) !== null);
  const measuredSignals = measured.map((r) => r.s);
  console.log(`  measurement set (covered AND resolved)    : ${measured.length}`);

  const baselineSet = new Set(measuredSignals.map((s) => s.index));
  const cascadeSet = new Set(measured.filter((r) => r.allowed).map((r) => r.s.index));

  const baseline = armMetrics("BASELINE (as shipped)", measuredSignals, baselineSet);
  const cascade = armMetrics("CASCADE HTF+M15+M5", measuredSignals, cascadeSet);

  // Ablations: which leg does the work?
  const htfOnly = new Set(
    measured.filter((r) => r.htf.verdict === (r.s.direction === "BUY" ? "BULLISH" : "BEARISH")).map((r) => r.s.index),
  );
  const htfM15 = new Set(
    measured
      .filter((r) => {
        const w: Dir = r.s.direction === "BUY" ? "BULLISH" : "BEARISH";
        return r.htf.verdict === w && r.m15 === w;
      })
      .map((r) => r.s.index),
  );
  const notOpposed = new Set(
    measured
      .filter((r) => {
        const opp: Dir = r.s.direction === "BUY" ? "BEARISH" : "BULLISH";
        return r.htf.verdict !== opp && r.m15 !== opp && r.m5 !== opp;
      })
      .map((r) => r.s.index),
  );

  console.log("\n" + "═".repeat(108));
  console.log("  DECISION TABLE — EV IS PER **ORIGINAL** SIGNAL (blocked = 0R, 0$, never excluded)");
  console.log("═".repeat(108));
  console.log(
    ["variant".padEnd(34), "kept/orig".padEnd(9), "retain".padStart(7), "WR".padStart(7), "PF".padStart(6), "EV/orig", "EV/kept".padStart(10), "net $".padStart(10)].join("  "),
  );
  console.log("─".repeat(108));
  console.log(row(baseline));
  console.log(row(armMetrics("HTF only", measuredSignals, htfOnly)));
  console.log(row(armMetrics("HTF + M15", measuredSignals, htfM15)));
  console.log(row(cascade));
  console.log(row(armMetrics("weaker: no TF OPPOSES", measuredSignals, notOpposed)));
  console.log("─".repeat(108));

  const dEV = cascade.evPerOriginal - baseline.evPerOriginal;
  const dNet = cascade.netDollars - baseline.netDollars;

  console.log("\n── PRE-REGISTERED GATE ─────────────────────────────────────────────────");
  console.log(`  baseline EV / original signal : ${baseline.evPerOriginal >= 0 ? "+" : ""}${baseline.evPerOriginal.toFixed(4)}R`);
  console.log(`  cascade  EV / original signal : ${cascade.evPerOriginal >= 0 ? "+" : ""}${cascade.evPerOriginal.toFixed(4)}R`);
  console.log(`  ΔEV                           : ${dEV >= 0 ? "+" : ""}${dEV.toFixed(4)}R      (gate: >= +${GATE_EV.toFixed(2)}R)  ${dEV >= GATE_EV ? "PASS" : "FAIL"}`);
  console.log(`  volume retained               : ${cascade.retentionPct.toFixed(1)}%   (gate: >= ${GATE_RETENTION}%)      ${cascade.retentionPct >= GATE_RETENTION ? "PASS" : "FAIL"}`);
  console.log(`  Δ net $                       : ${dNet >= 0 ? "+" : ""}$${dNet.toFixed(1)}`);
  const gatePass = dEV >= GATE_EV && cascade.retentionPct >= GATE_RETENTION;
  console.log(`\n  GATE VERDICT: ${gatePass ? "PASS — build authorised" : "FAIL — DO NOT BUILD (report and stop)"}`);

  // ── direction split ────────────────────────────────────────────────────────
  console.log("\n── BY DIRECTION ────────────────────────────────────────────────────────");
  for (const d of ["BUY", "SELL"] as const) {
    const subset = measuredSignals.filter((s) => s.direction === d);
    if (!subset.length) continue;
    console.log(row(armMetrics(`  ${d} baseline`, subset, new Set(subset.map((s) => s.index)))));
    console.log(row(armMetrics(`  ${d} cascade`, subset, cascadeSet)));
  }

  // ── the 31 July incident ───────────────────────────────────────────────────
  console.log("\n── 31 JULY INCIDENT — the four losing BUYs ─────────────────────────────");
  const jul31 = rows.filter(
    (r) => r.s.generatedMs >= Date.parse("2026-07-31T00:00:00Z") && r.s.generatedMs < Date.parse("2026-08-01T00:00:00Z"),
  );
  for (const r of jul31) {
    const rm = rMultiple(r.s);
    console.log(
      `  ${new Date(r.s.generatedMs).toISOString().slice(11, 16)}  ${r.s.direction} @${r.s.entry.toFixed(1)}  conf=${r.s.confidence.toFixed(0)}%  ` +
        `HTF=${r.htf.verdict.padEnd(7)}(bull ${r.htf.bullishScore.toFixed(1)}/bear ${r.htf.bearishScore.toFixed(1)}, dev ${r.htf.devMove === null ? "n/a" : r.htf.devMove.toFixed(1)})  ` +
        `M15=${r.m15.padEnd(7)} M5=${r.m5.padEnd(7)}  → ${r.allowed ? "ALLOWED" : "BLOCKED"}  ` +
        `actual ${r.s.status} ${rm === null ? "" : (rm >= 0 ? "+" : "") + rm.toFixed(2) + "R"}  [${r.coverage}]`,
    );
  }
  const jul31Buys = jul31.filter((r) => r.s.direction === "BUY");
  const jul31Blocked = jul31Buys.filter((r) => !r.allowed).length;
  console.log(`\n  31 Jul BUYs: ${jul31Buys.length}, blocked by cascade: ${jul31Blocked}/${jul31Buys.length}`);

  // ── HTF verdict distribution vs the shipped feature label ─────────────────
  console.log("\n── HTF VERDICT DISTRIBUTION (bar-derived, measurement set) ─────────────");
  const dist: Record<string, number> = {};
  for (const r of measured) dist[r.htf.verdict] = (dist[r.htf.verdict] ?? 0) + 1;
  for (const [k, v] of Object.entries(dist)) console.log(`  ${k.padEnd(8)} ${v}`);
  const strongUptrendSignals = measured.filter((r) => r.s.features["STRONG UPTREND"] !== undefined);
  const disagree = strongUptrendSignals.filter((r) => r.htf.verdict !== "BULLISH").length;
  console.log(
    `\n  signals the SHIPPED engine labelled "STRONG UPTREND": ${strongUptrendSignals.length}` +
      `\n  of those, bar-derived HTF is NOT bullish            : ${disagree}` +
      ` (${strongUptrendSignals.length ? ((disagree / strongUptrendSignals.length) * 100).toFixed(1) : "0"}%)`,
  );

  // ── audit 1: are the exclusions genuine (outside bar coverage), or a bug? ──
  console.log("\n── EXCLUSION AUDIT (is the drop-out genuine, or a script artefact?) ────");
  const barsStart = m1[0].ts;
  const barsEnd = m1[m1.length - 1].ts;
  const noM1 = rows.filter((r) => r.coverage === "NO_M1");
  const noDaily = rows.filter((r) => r.coverage === "NO_DAILY");
  const noM1BeforeBars = noM1.filter((r) => r.s.generatedMs < barsStart).length;
  const noM1AfterBars = noM1.filter((r) => r.s.generatedMs > barsEnd).length;
  const noM1Inside = noM1.filter((r) => r.s.generatedMs >= barsStart && r.s.generatedMs <= barsEnd);
  console.log(`  bar coverage window                : ${new Date(barsStart).toISOString()} → ${new Date(barsEnd).toISOString()}`);
  console.log(`  NO_M1 total                        : ${noM1.length}`);
  console.log(`    - generated BEFORE first bar     : ${noM1BeforeBars}  (genuinely uncoverable)`);
  console.log(`    - generated AFTER last bar       : ${noM1AfterBars}  (genuinely uncoverable)`);
  console.log(`    - generated INSIDE bar window    : ${noM1Inside.length}  (would be a gap/weekend, listed below)`);
  for (const r of noM1Inside.slice(0, 12)) {
    console.log(`        ${new Date(r.s.generatedMs).toISOString()}  ${r.s.direction} ${r.s.id}`);
  }
  if (noDaily.length) {
    const span = noDaily.map((r) => r.s.generatedMs);
    console.log(`  NO_DAILY total                     : ${noDaily.length}  span ${new Date(Math.min(...span)).toISOString()} → ${new Date(Math.max(...span)).toISOString()}`);
    console.log(`    (needs >=${MIN_COMPLETED_DAYS} completed daily bars; bars begin ${new Date(barsStart).toISOString().slice(0, 10)})`);
  }

  // ── audit 2: is the measured subsample representative of the whole export? ─
  console.log("\n── REPRESENTATIVENESS OF THE MEASUREMENT SET ───────────────────────────");
  const allResolved = all.filter((s) => rMultiple(s) !== null);
  function quick(label: string, set: ParsedSignal[]): void {
    const rs = set.map(rMultiple).filter((v): v is number => v !== null);
    const wr = rs.length ? (rs.filter((r) => r > 0).length / rs.length) * 100 : 0;
    const ev = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
    console.log(`  ${label.padEnd(46)} n=${String(rs.length).padStart(3)}  WR=${wr.toFixed(1).padStart(5)}%  EV=${(ev >= 0 ? "+" : "") + ev.toFixed(4)}R`);
  }
  quick("WHOLE EXPORT resolved — all", allResolved);
  quick("WHOLE EXPORT resolved — BUY", allResolved.filter((s) => s.direction === "BUY"));
  quick("WHOLE EXPORT resolved — SELL", allResolved.filter((s) => s.direction === "SELL"));
  quick("MEASUREMENT SET (bar-covered) — all", measuredSignals);
  quick("MEASUREMENT SET (bar-covered) — BUY", measuredSignals.filter((s) => s.direction === "BUY"));
  quick("MEASUREMENT SET (bar-covered) — SELL", measuredSignals.filter((s) => s.direction === "SELL"));

  // ── audit 3: why does retention collapse? verdict distributions ────────────
  console.log("\n── WHY RETENTION COLLAPSES — per-timeframe verdict distribution ────────");
  function distOf(pick: (r: Row) => Dir, label: string): void {
    const d: Record<Dir, number> = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 };
    for (const r of measured) d[pick(r)] += 1;
    console.log(`  ${label.padEnd(6)} BULLISH=${String(d.BULLISH).padStart(3)}  BEARISH=${String(d.BEARISH).padStart(3)}  NEUTRAL=${String(d.NEUTRAL).padStart(3)}`);
  }
  distOf((r) => r.htf.verdict, "HTF");
  distOf((r) => r.m15, "M15");
  distOf((r) => r.m5, "M5");
  const agreeWithDir = (r: Row, tf: Dir): boolean => tf === (r.s.direction === "BUY" ? "BULLISH" : "BEARISH");
  console.log(`  agrees with signal direction: HTF=${measured.filter((r) => agreeWithDir(r, r.htf.verdict)).length}  M15=${measured.filter((r) => agreeWithDir(r, r.m15)).length}  M5=${measured.filter((r) => agreeWithDir(r, r.m5)).length}  ALL THREE=${measured.filter((r) => r.allowed).length}`);

  // ── audit 4: opportunity cost of what the cascade blocks ───────────────────
  const blocked = measured.filter((r) => !r.allowed).map((r) => r.s);
  const blockedR = blocked.map(rMultiple).filter((v): v is number => v !== null);
  const blockedWinners = blockedR.filter((r) => r > 0);
  console.log("\n── OPPORTUNITY COST OF BLOCKING ────────────────────────────────────────");
  console.log(`  signals blocked      : ${blocked.length}`);
  console.log(`  of which WINNERS     : ${blockedWinners.length} (${blockedR.length ? ((blockedWinners.length / blockedR.length) * 100).toFixed(1) : "0"}%) worth ${blockedWinners.reduce((a, b) => a + b, 0).toFixed(2)}R`);
  console.log(`  of which LOSERS      : ${blockedR.length - blockedWinners.length} worth ${blockedR.filter((r) => r <= 0).reduce((a, b) => a + b, 0).toFixed(2)}R`);
  console.log(`  net R forgone        : ${blockedR.reduce((a, b) => a + b, 0).toFixed(2)}R`);

  console.log("\n" + "═".repeat(108));
}

main().catch((e: unknown) => {
  console.error("FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
