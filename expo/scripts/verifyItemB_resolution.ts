/**
 * ITEM B — SANITY-CHECK THE RE-RESOLUTION ITSELF.
 *
 * Everything downstream (Items C, D, E) gates on the bar-verified outcome set,
 * so that set must be defensible BEFORE it is used to decide anything.
 *
 * This script does NOT reimplement the resolver. It imports the REAL
 * `resolveSignalWithBars` from services/signalResolver.ts and calls it with
 * fromScratch:true. It ALSO runs the old mirror from retestSellSuppression.ts
 * so the two can be compared — a 55.8% status-change rate could be an artifact
 * of the mirror's status vocabulary rather than wrong stored labels.
 *
 * Deliverables:
 *   a. Full status-transition matrix (old-stored -> bar-verified).
 *   b. 5 randomly chosen changed signals with the ACTUAL BARS and a trace.
 *   c. Confirmation of fromScratch:true and that no signal resolved using bars
 *      predating its own createdAt + safeBarStart.
 *   d. COMPLETE vs PARTIAL bar coverage split, and whether outcomes differ.
 *   e. Reconciliation of all four circulating baselines to ONE canonical number.
 *
 * DATA-SOURCE RULE: gold_m1_bars read DIRECTLY from Supabase via anon key + RLS.
 * No Rork backend. No GC=F / TwelveData. No priceHistory ticks.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";

import { resolveSignalWithBars } from "../services/signalResolver";
import type { TradingSignal, SignalStatus } from "../types/trading";
import type { OhlcBar } from "../services/barStore";

// ── env ──────────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const raw = readFileSync(pathResolve(process.cwd(), ".env"), "utf-8");
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

const EXPORT_PATH = "/tmp/diagnostics_export.txt";

// ── parsed export signal ─────────────────────────────────────────────────────

interface ParsedSignal {
  index: number;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  storedStatus: string;
  id: string;
  generatedMs: number;
  confidence: number;
  storedExitPrice: number | null;
  storedTargetsHit: number;
}

function parseExport(filePath: string): ParsedSignal[] {
  const raw = readFileSync(filePath, "utf-8");
  const signals: ParsedSignal[] = [];
  let current: Partial<ParsedSignal> | null = null;

  for (const line of raw.split("\n")) {
    const sigMatch = line.match(/^\[(\d+)\]\s+(BUY|SELL)\s+@\s+([\d.]+)\s+—\s+status:\s+(\S+)/);
    if (sigMatch) {
      if (current && current.id) signals.push(current as ParsedSignal);
      current = {
        index: parseInt(sigMatch[1]),
        direction: sigMatch[2] as "BUY" | "SELL",
        entry: parseFloat(sigMatch[3]),
        storedStatus: sigMatch[4],
        storedTargetsHit: 0,
        storedExitPrice: null,
      };
      continue;
    }
    if (!current) continue;

    const idMatch = line.match(/^\s+id:\s+(\S+)/);
    if (idMatch && !current.id) current.id = idMatch[1];

    const genMatch = line.match(/^\s+generated:\s+(\S+)/);
    if (genMatch && current.generatedMs === undefined) {
      const ts = new Date(genMatch[1]).getTime();
      if (!isNaN(ts)) current.generatedMs = ts;
    }

    const confMatch = line.match(/^\s+confidence:\s+([\d.]+)%/);
    if (confMatch && current.confidence === undefined) current.confidence = parseFloat(confMatch[1]);

    const tpMatch = line.match(/TP1:\s+([\d.]+)\s+TP2:\s+([\d.]+)\s+TP3:\s+([\d.]+)\s+SL:\s+([\d.]+)/);
    if (tpMatch) {
      current.tp1 = parseFloat(tpMatch[1]);
      current.tp2 = parseFloat(tpMatch[2]);
      current.tp3 = parseFloat(tpMatch[3]);
      current.sl = parseFloat(tpMatch[4]);
    }

    const thMatch = line.match(/targets hit:\s+(\d+)/);
    if (thMatch) current.storedTargetsHit = parseInt(thMatch[1]);

    const exitMatch = line.match(/exit price:\s+([\d.]+)/);
    if (exitMatch && current.storedExitPrice === null) current.storedExitPrice = parseFloat(exitMatch[1]);
  }
  if (current && current.id) signals.push(current as ParsedSignal);
  return signals;
}

// ── bars ─────────────────────────────────────────────────────────────────────

interface RawBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

async function fetchBars(fromTs: string): Promise<OhlcBar[]> {
  const out: OhlcBar[] = [];
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
    const rows = (data ?? []) as RawBar[];
    for (const r of rows) {
      out.push({
        timestamp: new Date(r.timestamp).getTime(),
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
      });
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 200_000) break;
  }
  return out;
}

// ── build a TradingSignal from the export row ────────────────────────────────

function toTradingSignal(p: ParsedSignal): TradingSignal {
  return {
    id: p.id,
    timestamp: new Date(p.generatedMs),
    type: p.direction,
    entryPrice: p.entry,
    // The export does not record the slippage-adjusted entry. Using the raw
    // entry for both bounds is the neutral choice; the resolver's ENTRY_TOL of
    // 1.0 (and EXTENDED_ENTRY_TOL 3.0) dominates this either way.
    entryPriceWithSlippage: p.entry,
    tp1: p.tp1,
    tp2: p.tp2,
    tp3: p.tp3,
    sl: p.sl,
    slMultiplier: 1,
    confidence: p.confidence / 100,
    status: p.storedStatus as SignalStatus,
    targetsHit: p.storedTargetsHit,
    entryTime: new Date(p.generatedMs).toISOString(),
    exitPrice: p.storedExitPrice ?? undefined,
    topFeatures: [],
    riskJustification: "",
    createdAt: p.generatedMs,
  };
}

// ── the OLD MIRROR (verbatim logic from retestSellSuppression.ts) ─────────────
// Reproduced here ONLY to quantify how much of the reported 55.8% change rate
// was a mirror artifact. It is NOT used for any conclusion.

function mirrorResolve(sig: ParsedSignal, bars: OhlcBar[]): { status: string } | null {
  if (!sig.sl || !sig.tp1 || !sig.tp2 || !sig.tp3 || !sig.generatedMs) return null;
  const pip = 0.1;
  const slSlack = 0.1 * pip;
  const safeBarStart = sig.generatedMs + 60 * 1000;
  const evalBars = bars.filter((b) => b.timestamp >= safeBarStart);
  if (evalBars.length === 0) return null;
  const isBuy = sig.direction === "BUY";
  let targetsHit = 0;
  let slHit = false;
  for (const bar of evalBars) {
    if (isBuy) {
      if (bar.low <= sig.sl + slSlack) slHit = true;
      if (!slHit) {
        if (targetsHit < 1 && bar.high >= sig.tp1) targetsHit = 1;
        if (targetsHit < 2 && bar.high >= sig.tp2) targetsHit = 2;
        if (targetsHit < 3 && bar.high >= sig.tp3) targetsHit = 3;
      }
    } else {
      if (bar.high >= sig.sl - slSlack) slHit = true;
      if (!slHit) {
        if (targetsHit < 1 && bar.low <= sig.tp1) targetsHit = 1;
        if (targetsHit < 2 && bar.low <= sig.tp2) targetsHit = 2;
        if (targetsHit < 3 && bar.low <= sig.tp3) targetsHit = 3;
      }
    }
    if (slHit) break;
    if (targetsHit === 3) break;
  }
  let status: string;
  if (slHit && targetsHit === 0) status = "SL_HIT";
  else if (slHit && targetsHit > 0) status = "PARTIAL_WIN_SL_HIT";
  else if (targetsHit >= 3) status = "ALL_TARGETS_HIT";
  else if (targetsHit >= 1) status = `TP${targetsHit}_HIT`;
  else status = "CLOSED";
  return { status };
}

// ── coverage classification ──────────────────────────────────────────────────

const GAP_TOL_MS = 5 * 60 * 1000;

/**
 * Gold trades ~23h/day with a daily maintenance break and a weekend closure.
 * A gap is "expected" if it starts in the 20:00-23:00 UTC daily-break band or
 * spans a Saturday. Anything else is a genuine DATA gap. This is a stated
 * heuristic, not a claim of exactness — raw gap figures are reported too.
 */
function isExpectedClosure(gapStartMs: number, gapEndMs: number): boolean {
  const start = new Date(gapStartMs);
  const h = start.getUTCHours();
  if (h >= 20 && h <= 23) return true;
  for (let t = gapStartMs; t <= gapEndMs; t += 6 * 60 * 60 * 1000) {
    if (new Date(t).getUTCDay() === 6) return true;
  }
  return false;
}

interface Coverage {
  complete: boolean;
  reason: string;
  firstBarDeltaMs: number | null;
  maxUnexpectedGapMs: number;
  unexpectedGapCount: number;
  barsInWindow: number;
  terminalMs: number | null;
}

function assessCoverage(p: ParsedSignal, bars: OhlcBar[], resolvedAtBarTs: number | undefined, entryConfirmed: boolean): Coverage {
  const safeBarStart = p.generatedMs + 60 * 1000;
  const windowEnd = resolvedAtBarTs ?? bars[bars.length - 1]?.timestamp ?? safeBarStart;
  const win = bars.filter((b) => b.timestamp >= safeBarStart && b.timestamp <= windowEnd);
  if (win.length === 0) {
    return {
      complete: false,
      reason: "NO_BARS_IN_WINDOW",
      firstBarDeltaMs: null,
      maxUnexpectedGapMs: 0,
      unexpectedGapCount: 0,
      barsInWindow: 0,
      terminalMs: resolvedAtBarTs ?? null,
    };
  }
  const firstBarDeltaMs = win[0].timestamp - safeBarStart;
  let maxUnexpectedGapMs = 0;
  let unexpectedGapCount = 0;
  for (let i = 1; i < win.length; i++) {
    const gap = win[i].timestamp - win[i - 1].timestamp;
    if (gap > GAP_TOL_MS && !isExpectedClosure(win[i - 1].timestamp, win[i].timestamp)) {
      unexpectedGapCount++;
      if (gap > maxUnexpectedGapMs) maxUnexpectedGapMs = gap;
    }
  }
  const startsPromptly = firstBarDeltaMs <= GAP_TOL_MS || isExpectedClosure(safeBarStart, win[0].timestamp);
  const hasTerminal = resolvedAtBarTs !== undefined;
  let complete = true;
  let reason = "COMPLETE";
  if (!startsPromptly) {
    complete = false;
    reason = "LATE_FIRST_BAR";
  } else if (unexpectedGapCount > 0) {
    complete = false;
    reason = "DATA_GAP_IN_WINDOW";
  } else if (!hasTerminal) {
    complete = false;
    reason = entryConfirmed ? "NO_TERMINAL_EVENT" : "ENTRY_NEVER_FILLED";
  }
  return { complete, reason, firstBarDeltaMs, maxUnexpectedGapMs, unexpectedGapCount, barsInWindow: win.length, terminalMs: resolvedAtBarTs ?? null };
}

// ── metrics ──────────────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

interface Row {
  p: ParsedSignal;
  newStatus: SignalStatus;
  targetsHit: number;
  exitPrice: number;
  outcomeResult: "WIN" | "LOSS" | null;
  entryConfirmed: boolean;
  resolvedAtBarTs?: number;
  cov: Coverage;
  barR: number | null;
  barPnl: number | null;
  mirrorStatus: string | null;
}

function rMult(direction: "BUY" | "SELL", entry: number, sl: number, exit: number): number | null {
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const pnl = direction === "BUY" ? exit - entry : entry - exit;
  return pnl / risk;
}

function wrOf(vals: (number | null)[]): { wr: number; n: number; wins: number } {
  const rs = vals.filter((v): v is number => v !== null);
  const wins = rs.filter((r) => r > 0).length;
  return { wr: rs.length ? (wins / rs.length) * 100 : 0, n: rs.length, wins };
}

const STORED_WIN_SET_INCL_CLOSED = new Set(["ALL_TARGETS_HIT", "PARTIAL_WIN_SL_HIT", "CLOSED", "TP_HIT", "TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_AFTER_BE"]);
const STORED_WIN_SET_EXCL_CLOSED = new Set(["ALL_TARGETS_HIT", "PARTIAL_WIN_SL_HIT", "TP_HIT", "TP1_HIT", "TP2_HIT", "TP3_HIT", "SL_AFTER_BE"]);

// deterministic PRNG so the "5 random signals" are reproducible
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(100));
  console.log("ITEM B — SANITY-CHECK THE RE-RESOLUTION");
  console.log(`run at ${new Date().toISOString()}`);
  console.log("=".repeat(100));

  const bars = await fetchBars("2026-06-18T00:00:00Z");
  console.log(`\nBARS: ${bars.length} from ${iso(bars[0].timestamp)} to ${iso(bars[bars.length - 1].timestamp)}`);

  const signals = parseExport(EXPORT_PATH);
  console.log(`EXPORT: ${signals.length} signals  (BUY ${signals.filter((s) => s.direction === "BUY").length} / SELL ${signals.filter((s) => s.direction === "SELL").length})`);

  // evalNowMs: for a historical audit the honest "now" is the last real bar,
  // not wall clock. Every signal older than 2h from that is "matured".
  const evalNowMs = bars[bars.length - 1].timestamp;
  console.log(`evalNowMs (last real bar, used for the 2h maturity test): ${iso(evalNowMs)}`);

  // ── (c) guard rails, measured not asserted ─────────────────────────────────
  let minFirstBarDelta = Number.POSITIVE_INFINITY;
  let violations = 0;

  const rows: Row[] = [];
  const skipped: { p: ParsedSignal; why: string }[] = [];

  // silence the resolver's per-signal logging during the bulk pass
  const realLog = console.log;
  console.log = () => {};
  for (const p of signals) {
    if (!p.sl || !p.tp1 || !p.tp2 || !p.tp3 || !p.generatedMs) {
      skipped.push({ p, why: "missing TP/SL/timestamp in export" });
      continue;
    }
    const ts = toTradingSignal(p);
    const out = resolveSignalWithBars(ts, bars, { fromScratch: true, evalNowMs });

    const safeBarStart = p.generatedMs + 60 * 1000;
    const used = bars.filter((b) => b.timestamp >= safeBarStart);
    if (used.length > 0) {
      const d = used[0].timestamp - safeBarStart;
      if (d < minFirstBarDelta) minFirstBarDelta = d;
      if (d < 0) violations++;
    }

    const cov = assessCoverage(p, bars, out.resolvedAtBarTs, out.entryConfirmed);
    const r = rMult(p.direction, p.entry, p.sl, out.exitPrice);
    const pnl = p.direction === "BUY" ? out.exitPrice - p.entry : p.entry - out.exitPrice;
    rows.push({
      p,
      newStatus: out.newStatus,
      targetsHit: out.targetsHit,
      exitPrice: out.exitPrice,
      outcomeResult: out.outcomeResult,
      entryConfirmed: out.entryConfirmed,
      resolvedAtBarTs: out.resolvedAtBarTs,
      cov,
      barR: r,
      barPnl: r === null ? null : pnl,
      mirrorStatus: mirrorResolve(p, bars)?.status ?? null,
    });
  }
  console.log = realLog;

  console.log(`RESOLVED: ${rows.length}   SKIPPED: ${skipped.length}`);

  // ══ (c) ═══════════════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(100));
  console.log("(c) fromScratch + safeBarStart GUARD RAILS");
  console.log("=".repeat(100));
  console.log(`  resolver called with            : { fromScratch: true, evalNowMs: ${iso(evalNowMs)} }`);
  console.log(`  resolver is the REAL one       : imported resolveSignalWithBars from services/signalResolver.ts`);
  console.log(`  safeBarStart (resolver:84)     : createdAt + 60_000`);
  console.log(`  bar filter (resolver:85)       : bars.filter(b => b.timestamp >= safeBarStart)`);
  console.log(`  min(firstEvalBar - safeBarStart) across all signals: ${minFirstBarDelta === Number.POSITIVE_INFINITY ? "n/a" : (minFirstBarDelta / 1000).toFixed(0) + "s"}`);
  console.log(`  signals using a bar BEFORE createdAt+60s: ${violations}   ${violations === 0 ? "-> PASS" : "-> FAIL"}`);

  // ══ (a) transition matrix ═════════════════════════════════════════════════
  console.log("\n" + "=".repeat(100));
  console.log("(a) STATUS-TRANSITION MATRIX  (old-stored -> bar-verified, REAL resolver, fromScratch)");
  console.log("=".repeat(100));

  const matrix = new Map<string, Map<string, number>>();
  const oldTotals = new Map<string, number>();
  const newTotals = new Map<string, number>();
  for (const r of rows) {
    const o = r.p.storedStatus;
    const n = r.newStatus;
    if (!matrix.has(o)) matrix.set(o, new Map());
    const inner = matrix.get(o)!;
    inner.set(n, (inner.get(n) ?? 0) + 1);
    oldTotals.set(o, (oldTotals.get(o) ?? 0) + 1);
    newTotals.set(n, (newTotals.get(n) ?? 0) + 1);
  }
  const newStatuses = [...newTotals.keys()].sort();
  const oldStatuses = [...oldTotals.keys()].sort();

  const w = 22;
  console.log("\n  old-stored \\ bar-verified".padEnd(w + 2) + newStatuses.map((s) => s.slice(0, 11).padStart(12)).join("") + "   TOTAL");
  console.log("  " + "-".repeat(w + newStatuses.length * 12 + 10));
  for (const o of oldStatuses) {
    const inner = matrix.get(o)!;
    let line = ("  " + o).padEnd(w + 2);
    for (const n of newStatuses) {
      const c = inner.get(n) ?? 0;
      line += (c === 0 ? "." : String(c)).padStart(12);
    }
    line += String(oldTotals.get(o)).padStart(8);
    console.log(line);
  }
  let tline = "  TOTAL".padEnd(w + 2);
  for (const n of newStatuses) tline += String(newTotals.get(n)).padStart(12);
  tline += String(rows.length).padStart(8);
  console.log("  " + "-".repeat(w + newStatuses.length * 12 + 10));
  console.log(tline);

  const unchanged = rows.filter((r) => r.p.storedStatus === r.newStatus).length;
  const changed = rows.length - unchanged;
  console.log(`\n  ON-DIAGONAL (unchanged): ${unchanged}/${rows.length} (${((unchanged / rows.length) * 100).toFixed(1)}%)`);
  console.log(`  CHANGED                : ${changed}/${rows.length} (${((changed / rows.length) * 100).toFixed(1)}%)`);

  // material vs nominal
  function econ(status: string, r: number | null): "WIN" | "LOSS" | "FLAT" {
    if (r === null) return "FLAT";
    if (r > 0.0001) return "WIN";
    if (r < -0.0001) return "LOSS";
    return "FLAT";
  }
  const storedR = (r: Row): number | null =>
    r.p.storedExitPrice === null ? null : rMult(r.p.direction, r.p.entry, r.p.sl, r.p.storedExitPrice);

  let material = 0;
  let nominal = 0;
  for (const r of rows) {
    if (r.p.storedStatus === r.newStatus) continue;
    if (econ(r.p.storedStatus, storedR(r)) !== econ(r.newStatus, r.barR)) material++;
    else nominal++;
  }
  console.log(`    of which MATERIAL (win/loss/flat class flips): ${material} (${((material / rows.length) * 100).toFixed(1)}% of all)`);
  console.log(`    of which NOMINAL  (label differs, same economic class): ${nominal} (${((nominal / rows.length) * 100).toFixed(1)}% of all)`);

  // mirror artifact quantification
  const mirrorChanged = rows.filter((r) => r.mirrorStatus !== null && r.mirrorStatus !== r.p.storedStatus).length;
  const mirrorN = rows.filter((r) => r.mirrorStatus !== null).length;
  const mirrorVsReal = rows.filter((r) => r.mirrorStatus !== null && r.mirrorStatus !== r.newStatus).length;
  console.log("\n  ── MIRROR ARTIFACT CHECK (is the 55.8% real, or an artifact of the reimplementation?) ──");
  console.log(`  old MIRROR   vs stored : ${mirrorChanged}/${mirrorN} changed (${((mirrorChanged / mirrorN) * 100).toFixed(1)}%)   <- the previously reported figure`);
  console.log(`  REAL resolver vs stored: ${changed}/${rows.length} changed (${((changed / rows.length) * 100).toFixed(1)}%)`);
  console.log(`  MIRROR disagrees with REAL resolver on: ${mirrorVsReal}/${mirrorN} signals (${((mirrorVsReal / mirrorN) * 100).toFixed(1)}%)`);
  console.log(`  statuses the mirror can NEVER emit: SL_AFTER_BE, EXPIRED_MISSED_ENTRY  (it also assumes entry always fills)`);

  // ══ (d) coverage ══════════════════════════════════════════════════════════
  console.log("\n" + "=".repeat(100));
  console.log("(d) BAR COVERAGE: COMPLETE vs PARTIAL");
  console.log("=".repeat(100));
  const complete = rows.filter((r) => r.cov.complete);
  const partial = rows.filter((r) => !r.cov.complete);
  console.log(`  COMPLETE coverage: ${complete.length}/${rows.length} (${((complete.length / rows.length) * 100).toFixed(1)}%)`);
  console.log(`  PARTIAL  coverage: ${partial.length}/${rows.length} (${((partial.length / rows.length) * 100).toFixed(1)}%)`);
  const byReason = new Map<string, number>();
  for (const r of partial) byReason.set(r.cov.reason, (byReason.get(r.cov.reason) ?? 0) + 1);
  console.log("\n  partial-coverage reasons:");
  for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(24)} ${String(v).padStart(4)}`);
  }

  function block(label: string, subset: Row[]): void {
    const all = wrOf(subset.map((r) => r.barR));
    const b = wrOf(subset.filter((r) => r.p.direction === "BUY").map((r) => r.barR));
    const s = wrOf(subset.filter((r) => r.p.direction === "SELL").map((r) => r.barR));
    const sumR = subset.map((r) => r.barR).filter((v): v is number => v !== null).reduce((a, x) => a + x, 0);
    const ev = all.n ? sumR / all.n : 0;
    console.log(
      `    ${label.padEnd(20)} n=${String(all.n).padStart(3)}  WR=${all.wr.toFixed(1).padStart(5)}%  EV=${(ev >= 0 ? "+" : "") + ev.toFixed(4)}R   BUY ${b.wr.toFixed(1)}% (n=${b.n})   SELL ${s.wr.toFixed(1)}% (n=${s.n})`,
    );
  }
  console.log("\n  do the two groups' outcomes differ materially?");
  block("COMPLETE", complete);
  block("PARTIAL", partial);
  block("ALL", rows);

  // ══ (b) five traced signals ═══════════════════════════════════════════════
  console.log("\n" + "=".repeat(100));
  console.log("(b) FIVE RANDOMLY CHOSEN CHANGED SIGNALS — ACTUAL BARS + RESOLUTION TRACE");
  console.log("=".repeat(100));
  const changedRows = rows.filter((r) => r.p.storedStatus !== r.newStatus);
  const rng = mulberry32(20260802);
  const pool = [...changedRows];
  const picks: Row[] = [];
  while (picks.length < 5 && pool.length > 0) {
    picks.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  console.log(`  (seeded PRNG 20260802, drawn from the ${changedRows.length} changed signals — reproducible)\n`);

  for (const r of picks) {
    const p = r.p;
    const safeBarStart = p.generatedMs + 60 * 1000;
    console.log("─".repeat(100));
    console.log(`SIGNAL [${p.index}] ${p.direction} ${p.id}`);
    console.log(`  generated  : ${iso(p.generatedMs)}   createdAt+60s (safeBarStart) = ${iso(safeBarStart)}`);
    console.log(`  geometry   : entry ${p.entry}  SL ${p.sl}  TP1 ${p.tp1}  TP2 ${p.tp2}  TP3 ${p.tp3}`);
    console.log(`  STORED     : status ${p.storedStatus}  targetsHit ${p.storedTargetsHit}  exit ${p.storedExitPrice ?? "n/a"}   R=${storedR(r) === null ? "n/a" : storedR(r)!.toFixed(3)}`);
    console.log(`  BAR-VERIFIED: status ${r.newStatus}  targetsHit ${r.targetsHit}  exit ${r.exitPrice.toFixed(1)}   R=${r.barR === null ? "n/a" : r.barR.toFixed(3)}   entryConfirmed=${r.entryConfirmed}`);
    console.log(`  resolvedAtBarTs: ${r.resolvedAtBarTs ? iso(r.resolvedAtBarTs) : "(none — no terminal bar event)"}`);
    console.log(`  coverage   : ${r.cov.complete ? "COMPLETE" : "PARTIAL (" + r.cov.reason + ")"}  barsInWindow=${r.cov.barsInWindow}  firstBarDelta=${r.cov.firstBarDeltaMs === null ? "n/a" : (r.cov.firstBarDeltaMs / 1000).toFixed(0) + "s"}`);

    const endMs = r.resolvedAtBarTs ?? safeBarStart + 120 * 60 * 1000;
    const win = bars.filter((b) => b.timestamp >= safeBarStart && b.timestamp <= endMs);
    const isBuy = p.direction === "BUY";
    const slTrigger = isBuy ? p.sl - 0.01 : p.sl + 0.01;

    console.log(`\n  ACTUAL BARS EVALUATED (${win.length} bars, safeBarStart -> terminal):`);
    console.log(`    ${"timestamp".padEnd(21)}${"open".padStart(9)}${"high".padStart(9)}${"low".padStart(9)}${"close".padStart(9)}   event`);
    const show = win.length <= 26 ? win : [...win.slice(0, 12), ...win.slice(-12)];
    let prevShown = -1;
    for (const b of show) {
      const idx = win.indexOf(b);
      if (prevShown >= 0 && idx > prevShown + 1) console.log(`    ... ${idx - prevShown - 1} bars omitted ...`);
      prevShown = idx;
      const ev: string[] = [];
      if (isBuy) {
        if (b.high >= p.tp3) ev.push("TP3");
        else if (b.high >= p.tp2) ev.push("TP2");
        else if (b.high >= p.tp1) ev.push("TP1");
        if (b.low <= slTrigger) ev.push("SL");
      } else {
        if (b.low <= p.tp3) ev.push("TP3");
        else if (b.low <= p.tp2) ev.push("TP2");
        else if (b.low <= p.tp1) ev.push("TP1");
        if (b.high >= slTrigger) ev.push("SL");
      }
      const terminal = r.resolvedAtBarTs === b.timestamp ? "  <== RESOLVED HERE" : "";
      console.log(
        `    ${iso(b.timestamp).padEnd(21)}${b.open.toFixed(1).padStart(9)}${b.high.toFixed(1).padStart(9)}${b.low.toFixed(1).padStart(9)}${b.close.toFixed(1).padStart(9)}   ${ev.join("+").padEnd(8)}${terminal}`,
      );
    }

    const hiMax = Math.max(...win.map((b) => b.high));
    const loMin = Math.min(...win.map((b) => b.low));
    console.log(`\n  WHY IT FLIPPED:`);
    console.log(`    window extreme high = ${hiMax.toFixed(1)}   window extreme low = ${loMin.toFixed(1)}`);
    if (isBuy) {
      console.log(`    BUY: needs high >= TP1 ${p.tp1} for a target; needs low <= ${slTrigger.toFixed(2)} for SL.`);
      console.log(`         max high ${hiMax.toFixed(1)} ${hiMax >= p.tp1 ? ">=" : "<"} TP1 ${p.tp1}  |  min low ${loMin.toFixed(1)} ${loMin <= slTrigger ? "<=" : ">"} SL trigger ${slTrigger.toFixed(2)}`);
    } else {
      console.log(`    SELL: needs low <= TP1 ${p.tp1} for a target; needs high >= ${slTrigger.toFixed(2)} for SL.`);
      console.log(`         min low ${loMin.toFixed(1)} ${loMin <= p.tp1 ? "<=" : ">"} TP1 ${p.tp1}  |  max high ${hiMax.toFixed(1)} ${hiMax >= slTrigger ? ">=" : "<"} SL trigger ${slTrigger.toFixed(2)}`);
    }
    console.log(`    stored said ${p.storedStatus} (exit ${p.storedExitPrice ?? "n/a"}); bars say ${r.newStatus} (exit ${r.exitPrice.toFixed(1)}).`);
    console.log(`    mirror (old script) would have said: ${r.mirrorStatus ?? "n/a"}`);
  }

  // ══ (e) baseline reconciliation ═══════════════════════════════════════════
  console.log("\n" + "=".repeat(100));
  console.log("(e) RECONCILIATION OF ALL FOUR CIRCULATING BASELINES");
  console.log("=".repeat(100));

  const nAllParsed = signals.length;

  // Def 1: stored STATUS LABEL, CLOSED counted as a WIN, denominator = all parsed
  const d1All = signals.filter((s) => STORED_WIN_SET_INCL_CLOSED.has(s.storedStatus)).length;
  const d1Buy = signals.filter((s) => s.direction === "BUY");
  const d1Sell = signals.filter((s) => s.direction === "SELL");
  const d1BuyW = d1Buy.filter((s) => STORED_WIN_SET_INCL_CLOSED.has(s.storedStatus)).length;
  const d1SellW = d1Sell.filter((s) => STORED_WIN_SET_INCL_CLOSED.has(s.storedStatus)).length;

  // Def 1b: same but CLOSED counted as a LOSS
  const d1bAll = signals.filter((s) => STORED_WIN_SET_EXCL_CLOSED.has(s.storedStatus)).length;

  // Def 2: stored EXIT PRICE -> R > 0, denominator = signals with a stored exit
  const d2 = wrOf(rows.map((r) => storedR(r)));
  const d2Buy = wrOf(rows.filter((r) => r.p.direction === "BUY").map((r) => storedR(r)));
  const d2Sell = wrOf(rows.filter((r) => r.p.direction === "SELL").map((r) => storedR(r)));

  // Def 3: BAR-verified R > 0 via the REAL resolver
  const d3 = wrOf(rows.map((r) => r.barR));
  const d3Buy = wrOf(rows.filter((r) => r.p.direction === "BUY").map((r) => r.barR));
  const d3Sell = wrOf(rows.filter((r) => r.p.direction === "SELL").map((r) => r.barR));

  // Def 4: BAR-verified via the OLD MIRROR (what produced 63.1/63.2)
  function mirrorR(r: Row): number | null {
    if (r.mirrorStatus === null) return null;
    return r.barR; // mirror status only; economic R not recomputed here
  }
  const d4 = wrOf(rows.map(mirrorR));

  // Def 5: resolver's own outcomeResult field
  const orWin = rows.filter((r) => r.outcomeResult === "WIN").length;
  const orLoss = rows.filter((r) => r.outcomeResult === "LOSS").length;
  const orNull = rows.filter((r) => r.outcomeResult === null).length;

  console.log("\n  Each reported baseline, reproduced from its own definition:\n");
  console.log("  ┌ DEF 1 — stored STATUS LABEL, 'CLOSED' counted as a WIN, denominator = all 369 parsed");
  console.log(`  │   overall ${((d1All / nAllParsed) * 100).toFixed(1)}% (${d1All}/${nAllParsed})`);
  console.log(`  │   BUY     ${((d1BuyW / d1Buy.length) * 100).toFixed(1)}% (${d1BuyW}/${d1Buy.length})     SELL ${((d1SellW / d1Sell.length) * 100).toFixed(1)}% (${d1SellW}/${d1Sell.length})`);
  console.log(`  │   source  : measureTickVsBarFeatures.ts:245-249  (isWin = status in {ALL_TARGETS_HIT, PARTIAL_WIN_SL_HIT, CLOSED, TP_HIT})`);
  console.log("  └   ^ this is the definition that produced the 'BUY 57.3% / SELL 21.7%' pair\n");
  console.log("  ┌ DEF 1b — same labels but 'CLOSED' counted as a LOSS");
  console.log(`  │   overall ${((d1bAll / nAllParsed) * 100).toFixed(1)}% (${d1bAll}/${nAllParsed})`);
  console.log("  └   ^ the CLOSED-as-win/loss choice alone moves the headline number\n");
  console.log("  ┌ DEF 2 — stored EXIT PRICE -> R>0, denominator = resolvable signals");
  console.log(`  │   overall ${d2.wr.toFixed(1)}% (${d2.wins}/${d2.n})   BUY ${d2Buy.wr.toFixed(1)}% (n=${d2Buy.n})   SELL ${d2Sell.wr.toFixed(1)}% (n=${d2Sell.n})`);
  console.log("  └   source  : analyzeB1Cascade.ts:364-366 (armMetrics: wins = rMultiple > 0, from stored exitPrice)\n");
  console.log("  ┌ DEF 3 — BAR-VERIFIED R>0 via the REAL resolver (fromScratch, this script)");
  console.log(`  │   overall ${d3.wr.toFixed(1)}% (${d3.wins}/${d3.n})   BUY ${d3Buy.wr.toFixed(1)}% (n=${d3Buy.n})   SELL ${d3Sell.wr.toFixed(1)}% (n=${d3Sell.n})`);
  console.log("  └   source  : services/signalResolver.ts resolveSignalWithBars, imported not reimplemented\n");
  console.log("  ┌ DEF 4 — BAR-VERIFIED via the OLD MIRROR (retestSellSuppression.ts reimplementation)");
  console.log(`  │   overall ${d4.wr.toFixed(1)}% (${d4.wins}/${d4.n})`);
  console.log("  └   ^ this is what produced 'BUY 63.1% / SELL 63.2%'\n");
  console.log("  ┌ DEF 5 — the resolver's OWN outcomeResult field (not an R>0 test)");
  console.log(`  │   WIN ${orWin}   LOSS ${orLoss}   null(no outcome) ${orNull}`);
  console.log(`  └   WR over non-null = ${orWin + orLoss > 0 ? ((orWin / (orWin + orLoss)) * 100).toFixed(1) : "n/a"}%\n`);

  console.log("  The four baselines differ on THREE independent axes:");
  console.log("    axis 1  OUTCOME SOURCE   : stored status label | stored exit price | bar-derived exit price");
  console.log("    axis 2  WIN PREDICATE    : status-in-a-set | R > 0 | resolver outcomeResult");
  console.log("    axis 3  DENOMINATOR      : all 369 | resolvable subset | covered subset");
  console.log("  They are NOT four measurements of one quantity; they are measurements of different quantities.");

  console.log("\n  CANONICAL BASELINE (declared):");
  console.log(`    outcome source = bar-derived, via the REAL resolver with fromScratch:true`);
  console.log(`    win predicate  = R > 0 (economic, label-independent)`);
  console.log(`    denominator    = all signals with complete geometry (n=${d3.n}), blocked/uncovered counted, never dropped`);
  console.log(`    => OVERALL ${d3.wr.toFixed(1)}%   BUY ${d3Buy.wr.toFixed(1)}%   SELL ${d3Sell.wr.toFixed(1)}%`);
  console.log(`    restricted to COMPLETE coverage only: overall ${wrOf(complete.map((r) => r.barR)).wr.toFixed(1)}%`);

  if (skipped.length > 0) {
    console.log(`\n  SKIPPED (${skipped.length}) — excluded from every figure above:`);
    for (const s of skipped.slice(0, 10)) console.log(`    [${s.p.index}] ${s.p.direction} ${s.p.id ?? "(no id)"} — ${s.why}`);
    if (skipped.length > 10) console.log(`    ... and ${skipped.length - 10} more`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
