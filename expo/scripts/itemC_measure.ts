/**
 * ITEM C — TICK-vs-BAR FEATURE MEASUREMENT ON THE CANONICAL LABEL SET.
 *
 * CANONICAL OUTCOME SET (stated once; the ONLY baseline used anywhere below):
 *   outcome        = REAL resolveSignalWithBars, { fromScratch: true, evalNowMs }
 *   win predicate  = R > 0
 *   denominator    = all 369 export signals
 *   BUY 63.1% (99/157) | SELL 63.2% (134/212) | OVERALL 63.1% (233/369)
 *   EV +0.0605R | PF 1.16
 *
 * OLD (tick) basis  = what the LIVE engine actually produced at generation time,
 *                     recorded as attention scores in the diagnostics export.
 *                     This is the only faithful record of the 5/20/30-tick windows;
 *                     tick history is not replayable from Supabase.
 * NEW (bar) basis   = recomputed from M5/M15 bars aggregated from gold_m1_bars,
 *                     using ONLY buckets closed strictly before the signal.
 *
 * Every row carries n, effect size vs the not-fired complement, the MDE this
 * sample could detect, and a mechanical noise verdict (see itemC_stats.ts).
 *
 * DATA-SOURCE RULE: gold_m1_bars via Supabase anon key + RLS, direct.
 * No Rork backend. No GC=F / TwelveData. No priceHistory ticks.
 */
import { readFileSync } from "node:fs";
import { metrics, fmt, type Canon } from "./preconditions";
import { buildContexts, aggregate, atrFrom, median, type Bar5, type Ctx } from "./itemC_confound";
import { twoProp, bootstrapEvCi, renderRow } from "./itemC_stats";
import type { OhlcBar } from "../services/barStore";

// ── OLD basis: read the engine's own recorded attention scores ───────────────

/** Map export index -> set of attention-score feature names that FIRED live. */
function parseAttention(filePath: string): Map<number, Set<string>> {
  const raw = readFileSync(filePath, "utf-8");
  const out = new Map<number, Set<string>>();
  let idx: number | null = null;
  for (const line of raw.split("\n")) {
    const head = line.match(/^\[(\d+)\]\s+(BUY|SELL)\s+@/);
    if (head) {
      idx = parseInt(head[1]);
      out.set(idx, new Set<string>());
      continue;
    }
    if (idx === null) continue;
    const f = line.match(/^\s+([A-Za-z][A-Za-z_ ]*?)=([\d.]+)\s*$/);
    if (f) {
      const score = parseFloat(f[2]);
      if (!isNaN(score) && score > 0) out.get(idx)!.add(f[1].trim().toUpperCase().replace(/\s+/g, "_"));
    }
  }
  return out;
}

// ── NEW basis: bar-based reimplementations, mirroring the tick versions ──────

function barPattern(m5: Bar5[]): string {
  if (m5.length < 5) return "INSUFFICIENT_DATA";
  const r = m5.slice(-5);
  const trend = r[4].close - r[0].open;
  const vol = Math.max(...r.map((b) => b.high)) - Math.min(...r.map((b) => b.low));
  if (trend > 10 && vol < 20) return "STRONG_UPTREND";
  if (trend < -10 && vol < 20) return "STRONG_DOWNTREND";
  if (Math.abs(trend) < 5 && vol < 10) return "CONSOLIDATION";
  if (vol > 25) return "HIGH_VOLATILITY_BREAKOUT";
  return "NEUTRAL";
}

function barVwap(m5: Bar5[]): number | null {
  if (m5.length < 10) return null;
  const bars = m5.slice(-30);
  let num = 0;
  let den = 0;
  for (const b of bars) {
    const typ = (b.high + b.low + b.close) / 3;
    const w = Math.max(0.1, b.high - b.low);
    num += typ * w;
    den += w;
  }
  return den === 0 ? null : num / den;
}

function barTrendStrength(m5: Bar5[]): number {
  if (m5.length < 20) return 0.5;
  const c = m5.slice(-20).map((b) => b.close);
  const net = Math.abs(c[c.length - 1] - c[0]);
  let total = 0;
  for (let i = 1; i < c.length; i++) total += Math.abs(c[i] - c[i - 1]);
  return total === 0 ? 0 : Math.min(1, net / total);
}

function barRegime(m5: Bar5[]): { type: string; strength: number } {
  if (m5.length < 20) return { type: "RANGING", strength: 0.5 };
  const atr = atrFrom(m5, 14) ?? 0;
  const r10 = m5.slice(-10);
  const o10 = m5.slice(-20, -10);
  const act = (xs: Bar5[]): number => {
    let s = 0;
    for (let i = 1; i < xs.length; i++) s += Math.abs(xs[i].close - xs[i - 1].close);
    return s;
  };
  const olderAct = act(o10);
  const volumeRatio = olderAct === 0 ? 1 : act(r10) / olderAct;
  const ts = barTrendStrength(m5);
  if (atr > 11 && volumeRatio > 1.1) return { type: "VOLATILE", strength: Math.min(1, 0.8 + Math.min(atr - 11, 3) * 0.05) };
  if (atr < 8.5 && volumeRatio < 0.9) return { type: "QUIET", strength: Math.min(1, 0.6 + (8.5 - atr) * 0.05) };
  if (ts > 0.6) return { type: "TRENDING", strength: Math.min(1, 0.7 + ts * 0.2) };
  return { type: "RANGING", strength: Math.min(1, 0.5 + (1 - ts) * 0.3) };
}

function barAdx(m5: Bar5[], period: number = 14): number | null {
  if (m5.length < period + 1) return null;
  const w = m5.slice(-(period + 1));
  let pDM = 0;
  let mDM = 0;
  let tr = 0;
  for (let i = 1; i < w.length; i++) {
    const up = w[i].high - w[i - 1].high;
    const dn = w[i - 1].low - w[i].low;
    pDM += up > dn && up > 0 ? up : 0;
    mDM += dn > up && dn > 0 ? dn : 0;
    tr += Math.max(w[i].high - w[i].low, Math.abs(w[i].high - w[i - 1].close), Math.abs(w[i].low - w[i - 1].close));
  }
  if (tr === 0) return null;
  const pDI = 100 * (pDM / tr);
  const mDI = 100 * (mDM / tr);
  const sum = pDI + mDI;
  return sum === 0 ? 0 : (100 * Math.abs(pDI - mDI)) / sum;
}

// ── Per-signal bar context ───────────────────────────────────────────────────

interface Row {
  ctx: Ctx;
  m5: Bar5[];
  fired: Map<string, boolean>;
}

interface FeatureDef {
  name: string;
  side: "BUY" | "SELL";
  /** OLD basis: did the live tick-window feature fire? */
  oldKey: string[];
  /** NEW basis: recompute from bars. */
  bar: (m5: Bar5[], c: Canon) => boolean;
}

const FEATURES: FeatureDef[] = [
  {
    name: "STRONG_UPTREND",
    side: "BUY",
    oldKey: ["STRONG_UPTREND"],
    bar: (m5) => barPattern(m5) === "STRONG_UPTREND",
  },
  {
    name: "ABOVE_VWAP",
    side: "BUY",
    oldKey: ["ABOVE_VWAP"],
    bar: (m5, c) => {
      const v = barVwap(m5);
      return v !== null && c.p.entry - v > 1.5;
    },
  },
  {
    name: "TRENDING_STRONG",
    side: "BUY",
    oldKey: ["ADX_TREND_STRENGTH"],
    bar: (m5) => {
      const r = barRegime(m5);
      return r.type === "TRENDING" && r.strength > 0.75;
    },
  },
  {
    name: "STRONG_DOWNTREND",
    side: "SELL",
    oldKey: ["STRONG_DOWNTREND"],
    bar: (m5) => barPattern(m5) === "STRONG_DOWNTREND",
  },
  {
    name: "BELOW_VWAP",
    side: "SELL",
    oldKey: ["BELOW_VWAP"],
    bar: (m5, c) => {
      const v = barVwap(m5);
      return v !== null && c.p.entry - v < -1.5;
    },
  },
  {
    name: "TRENDING_STRONG",
    side: "SELL",
    oldKey: ["ADX_TREND_STRENGTH"],
    bar: (m5) => {
      const r = barRegime(m5);
      return r.type === "TRENDING" && r.strength > 0.75;
    },
  },
];

function isWin(c: Canon): boolean {
  return c.r > 0;
}

/** Every test performed anywhere in this report, for the multiplicity audit. */
interface TestRec {
  where: string;
  label: string;
  basis: string;
  n: number;
  wr: number;
  diffPts: number;
  p: number;
  verdict: string;
}
const ALL_TESTS: TestRec[] = [];

/** Report one feature on one subgroup, both bases, with the noise verdict. */
let CURRENT_SUBGROUP = "POOLED";

function reportFeature(f: FeatureDef, rows: Row[], label: string, attn: Map<number, Set<string>>): void {
  const side = rows.filter((r) => r.ctx.c.p.direction === f.side);
  if (side.length === 0) {
    console.log(`    ${label.padEnd(30)}(no ${f.side} signals in this subgroup)`);
    return;
  }

  for (const basis of ["TICK", "BAR"] as const) {
    const firedRows = side.filter((r) =>
      basis === "TICK" ? f.oldKey.some((k) => (attn.get(r.ctx.c.p.index) ?? new Set()).has(k)) : f.bar(r.m5, r.ctx.c),
    );
    const notRows = side.filter((r) => !firedRows.includes(r));
    const kA = firedRows.filter((r) => isWin(r.ctx.c)).length;
    const kB = notRows.filter((r) => isWin(r.ctx.c)).length;
    const t = twoProp(kA, firedRows.length, kB, notRows.length);
    const rs = firedRows.map((r) => r.ctx.c.r);
    const ci = rs.length > 1 ? bootstrapEvCi(rs) : ([NaN, NaN] as [number, number]);
    const ev = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : NaN;
    console.log(renderRow(`${label} [${basis}]`, t, ev, ci));
    ALL_TESTS.push({
      where: CURRENT_SUBGROUP,
      label,
      basis,
      n: firedRows.length,
      wr: t.pA * 100,
      diffPts: t.diffPts,
      p: t.p,
      verdict: t.verdict,
    });
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(126));
  console.log("ITEM C — TICK vs BAR FEATURE MEASUREMENT ON THE CANONICAL LABEL SET");
  console.log(`run at ${new Date().toISOString()}`);
  console.log("=".repeat(126));

  const { ctxs, bars } = await buildContexts();
  const attn = parseAttention("/tmp/diagnostics_export.txt");
  const m5all = aggregate(bars as OhlcBar[], 5);

  const rows: Row[] = [];
  let i5 = 0;
  for (const ctx of ctxs) {
    while (i5 < m5all.length && m5all[i5].ts + 5 * 60_000 <= ctx.c.p.generatedMs) i5++;
    rows.push({ ctx, m5: m5all.slice(Math.max(0, i5 - 60), i5), fired: new Map() });
  }

  const buy = rows.filter((r) => r.ctx.c.p.direction === "BUY").map((r) => r.ctx.c);
  const sell = rows.filter((r) => r.ctx.c.p.direction === "SELL").map((r) => r.ctx.c);
  console.log("\nCANONICAL BASELINE (the only baseline in this report):");
  console.log("  " + fmt("BUY", metrics(buy)).trim());
  console.log("  " + fmt("SELL", metrics(sell)).trim());
  console.log("  " + fmt("OVERALL", metrics(rows.map((r) => r.ctx.c))).trim());
  console.log(`\nsignals: ${rows.length}   M5 bars available: ${m5all.length}   attention records parsed: ${attn.size}`);

  console.log("\nCOLUMN KEY");
  console.log("  n=X/Y          X = signals where the feature FIRED, Y = all signals of that direction in the subgroup");
  console.log("  vs-notfired    win-rate difference against the SAME-direction signals where it did NOT fire");
  console.log("  MDE            smallest WR difference this n could detect at 80% power / alpha 0.05");
  console.log("  EV[lo,hi]      mean R of the fired group with a 4000-sample bootstrap 95% CI");
  console.log("  verdict        mechanical: DISTINGUISHABLE / NOISE / NOT SIGNIFICANT / UNDERPOWERED");

  // ── A. Pooled ──────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(126));
  console.log("A. POOLED (all 369)");
  console.log("=".repeat(126));
  CURRENT_SUBGROUP = "POOLED";
  for (const f of FEATURES) {
    console.log(`\n  ${f.name} (${f.side}-side)`);
    reportFeature(f, rows, f.name, attn);
  }

  // ── B. By 0.6R generation ──────────────────────────────────────────────────
  console.log("\n" + "=".repeat(126));
  console.log("B. BY 0.6R GENERATION SPLIT");
  console.log("=".repeat(126));
  for (const [lbl, set] of [
    ["GEN-A TP1R<0.6", rows.filter((r) => r.ctx.c.tp1R < 0.6)],
    ["GEN-B TP1R>=0.6", rows.filter((r) => r.ctx.c.tp1R >= 0.6)],
  ] as [string, Row[]][]) {
    console.log(`\n  ${lbl}  (n=${set.length})`);
    CURRENT_SUBGROUP = lbl;
    for (const f of FEATURES) reportFeature(f, set, `${f.name}/${f.side}`, attn);
  }

  // ── C. By TP1R tercile ─────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(126));
  console.log("C. BY TP1R TERCILE");
  console.log("=".repeat(126));
  const byT = [...rows].sort((a, b) => a.ctx.c.tp1R - b.ctx.c.tp1R);
  const t3 = Math.floor(byT.length / 3);
  for (const [lbl, set] of [
    ["LOW TP1R", byT.slice(0, t3)],
    ["MID TP1R", byT.slice(t3, 2 * t3)],
    ["HIGH TP1R", byT.slice(2 * t3)],
  ] as [string, Row[]][]) {
    console.log(`\n  ${lbl}  (n=${set.length}, medTP1R=${median(set.map((r) => r.ctx.c.tp1R)).toFixed(3)})`);
    CURRENT_SUBGROUP = lbl;
    for (const f of FEATURES) reportFeature(f, set, `${f.name}/${f.side}`, attn);
  }

  // ── D. By ATR bucket (the confound control) ────────────────────────────────
  console.log("\n" + "=".repeat(126));
  console.log("D. BY ATR(M5,14) BUCKET — the volatility control demanded by the confound test");
  console.log("=".repeat(126));
  const byA = [...rows].sort((a, b) => (a.ctx.atrM5 ?? 0) - (b.ctx.atrM5 ?? 0));
  const a3 = Math.floor(byA.length / 3);
  for (const [lbl, set] of [
    ["ATR-LOW", byA.slice(0, a3)],
    ["ATR-MID", byA.slice(a3, 2 * a3)],
    ["ATR-HIGH", byA.slice(2 * a3)],
  ] as [string, Row[]][]) {
    console.log(`\n  ${lbl}  (n=${set.length}, medATR=$${median(set.map((r) => r.ctx.atrM5 ?? 0)).toFixed(2)})`);
    CURRENT_SUBGROUP = lbl;
    for (const f of FEATURES) reportFeature(f, set, `${f.name}/${f.side}`, attn);
  }

  // ── E. Firing-count census: can any of this support a gate at all? ────────
  console.log("\n" + "=".repeat(126));
  console.log("E. FIRING-COUNT CENSUS — the precondition for ANY gate decision");
  console.log("=".repeat(126));
  console.log("\n    feature                     side   TICK fires   BAR fires   overlap   min n for a 10pt effect");
  console.log("    " + "-".repeat(110));
  for (const f of FEATURES) {
    const side = rows.filter((r) => r.ctx.c.p.direction === f.side);
    const tickF = side.filter((r) => f.oldKey.some((k) => (attn.get(r.ctx.c.p.index) ?? new Set()).has(k)));
    const barF = side.filter((r) => f.bar(r.m5, r.ctx.c));
    const overlap = tickF.filter((r) => barF.includes(r)).length;
    // n per group to detect a 10pt difference around p=0.63 at 80% power
    const p1 = 0.63;
    const p2 = 0.73;
    const pbar = (p1 + p2) / 2;
    const nNeeded = Math.ceil(
      ((1.959964 * Math.sqrt(2 * pbar * (1 - pbar)) + 0.841621 * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2) /
        (p2 - p1) ** 2,
    );
    console.log(
      `    ${f.name.padEnd(28)}${f.side.padEnd(7)}${String(tickF.length).padStart(8)}${String(barF.length).padStart(12)}${String(overlap).padStart(10)}${String(nNeeded).padStart(20)}`,
    );
  }

  // ── F. Multiplicity audit ────────────────────────────────────────────────
  console.log("\n" + "=".repeat(126));
  console.log("F. MULTIPLICITY AUDIT — how many of these tests should look 'significant' by pure chance?");
  console.log("=".repeat(126));
  const testable = ALL_TESTS.filter((t) => Number.isFinite(t.p) && t.n > 0);
  const sig = testable.filter((t) => t.p < 0.05);
  const expectedFalse = testable.length * 0.05;
  console.log(`\n    tests performed (feature x basis x subgroup, with >=1 firing) : ${testable.length}`);
  console.log(`    tests reaching nominal p < 0.05                               : ${sig.length}`);
  console.log(`    expected number of p<0.05 hits under the NULL (pure chance)   : ${expectedFalse.toFixed(1)}`);
  console.log(`    Bonferroni-corrected alpha for this many tests                : ${(0.05 / testable.length).toFixed(5)}`);
  if (sig.length > 0) {
    console.log(`\n    the nominally-significant cells:`);
    for (const t of sig.sort((a, b) => a.p - b.p)) {
      const survives = t.p < 0.05 / testable.length;
      console.log(
        `      ${t.where.padEnd(18)}${(t.label + " [" + t.basis + "]").padEnd(34)}n=${String(t.n).padStart(3)}  WR=${t.wr.toFixed(1)}%  ${(t.diffPts >= 0 ? "+" : "") + t.diffPts.toFixed(1)}pts  p=${t.p.toFixed(4)}  ` +
          `${survives ? "SURVIVES Bonferroni" : "DOES NOT survive Bonferroni"}`,
      );
    }
  }
  console.log(
    `\n    => ${sig.length <= expectedFalse ? "the number of 'significant' hits is AT OR BELOW what pure chance produces. No cell is evidence." : "there are more hits than chance predicts — inspect the survivors above."}`,
  );

  // ── G. Verdict census ────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(126));
  console.log("G. VERDICT CENSUS ACROSS EVERY TEST");
  console.log("=".repeat(126));
  const census = new Map<string, number>();
  for (const t of ALL_TESTS) {
    const k = t.verdict.split(" (")[0];
    census.set(k, (census.get(k) ?? 0) + 1);
  }
  console.log();
  for (const [k, v] of [...census.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(24)}${String(v).padStart(4)}`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
