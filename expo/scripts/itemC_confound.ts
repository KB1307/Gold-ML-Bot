/**
 * ITEM C — STEP 0: THE CONFOUND TEST (must be reported BEFORE any feature numbers).
 *
 * CLAIM UNDER TEST (user's, and it is the right question):
 *   TP1R = TP1dist / SLdist, with TP1dist pinned in absolute pips and SLdist
 *   ATR-driven. Therefore TP1R is an INVERSE PROXY FOR VOLATILITY.
 *   Low TP1R => high ATR. High TP1R => low ATR.
 *   If so, the "generation split" and the "TP1R tercile split" are BOTH
 *   volatility-regime splits wearing a TP1 label.
 *
 * MEASUREMENT: median ATR and median SL distance per tercile and per generation,
 * plus separation diagnostics (overlap of ATR distributions, rank correlation,
 * and how well ATR alone predicts tercile membership).
 *
 * CANONICAL OUTCOME SET (declared once, used everywhere in Item C/D):
 *   outcome = REAL resolveSignalWithBars, { fromScratch: true, evalNowMs }
 *   win predicate = R > 0
 *   denominator = all 369 export signals
 *   BUY 63.1% | SELL 63.2% | OVERALL 63.1% | EV +0.0605R | PF 1.16
 *
 * DATA-SOURCE RULE: gold_m1_bars read DIRECTLY from Supabase via anon key + RLS.
 * No Rork backend. No GC=F / TwelveData. No priceHistory ticks.
 */
import { buildCanonical, metrics, fmt, type Canon } from "./preconditions";
import type { OhlcBar } from "../services/barStore";

export interface Bar5 {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Aggregate M1 -> N-minute bars. Bucket key = floor(open / period). */
export function aggregate(m1: OhlcBar[], periodMin: number): Bar5[] {
  const ms = periodMin * 60_000;
  const out: Bar5[] = [];
  let cur: Bar5 | null = null;
  for (const b of m1) {
    const bucket = Math.floor(b.timestamp / ms) * ms;
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

/** Wilder-style simple ATR over the last `period` completed bars. */
export function atrFrom(bars: Bar5[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const w = bars.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < w.length; i++) {
    sum += Math.max(
      w[i].high - w[i].low,
      Math.abs(w[i].high - w[i - 1].close),
      Math.abs(w[i].low - w[i - 1].close),
    );
  }
  return sum / period;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
export function quantile(xs: number[], f: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(f * s.length)))];
}

/** Spearman rank correlation. */
export function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]): number[] => {
    const idx = xs.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const ma = ra.reduce((x, y) => x + y, 0) / ra.length;
  const mb = rb.reduce((x, y) => x + y, 0) / rb.length;
  let n = 0,
    da = 0,
    db = 0;
  for (let i = 0; i < ra.length; i++) {
    n += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return n / Math.sqrt(da * db);
}

export interface Ctx {
  c: Canon;
  atrM5: number | null;
  atrM15: number | null;
  slPips: number;
  tp1Pips: number;
}

/** Attach per-signal volatility context computed from real bars BEFORE the signal. */
export async function buildContexts(): Promise<{ ctxs: Ctx[]; bars: OhlcBar[]; evalNowMs: number }> {
  const { rows, bars, evalNowMs } = await buildCanonical();
  const m5 = aggregate(bars, 5);
  const m15 = aggregate(bars, 15);

  const ctxs: Ctx[] = [];
  let i5 = 0;
  let i15 = 0;
  const chrono = [...rows].sort((a, b) => a.p.generatedMs - b.p.generatedMs);
  for (const c of chrono) {
    const t = c.p.generatedMs;
    // Only bars whose bucket CLOSED strictly before the signal (no lookahead).
    while (i5 < m5.length && m5[i5].ts + 5 * 60_000 <= t) i5++;
    while (i15 < m15.length && m15[i15].ts + 15 * 60_000 <= t) i15++;
    ctxs.push({
      c,
      atrM5: atrFrom(m5.slice(0, i5), 14),
      atrM15: atrFrom(m15.slice(0, i15), 14),
      slPips: c.slDistance * 10,
      tp1Pips: Math.abs(c.p.tp1 - c.p.entry) * 10,
    });
  }
  return { ctxs, bars, evalNowMs };
}

function line(): void {
  console.log("-".repeat(104));
}

async function main(): Promise<void> {
  console.log("=".repeat(104));
  console.log("ITEM C — STEP 0: CONFOUND TEST (is the TP1R split actually a VOLATILITY split?)");
  console.log(`run at ${new Date().toISOString()}`);
  console.log("=".repeat(104));

  const { ctxs, bars } = await buildContexts();
  const withAtr = ctxs.filter((x) => x.atrM5 !== null && x.atrM15 !== null);
  console.log(`\nbars: ${bars.length} M1 from Supabase gold_m1_bars (anon key, direct)`);
  console.log(`signals: ${ctxs.length}   with computable pre-signal ATR(M5,14) & ATR(M15,14): ${withAtr.length}`);
  console.log("ATR is computed ONLY from bars whose bucket closed strictly before the signal — no lookahead.");

  console.log("\nCANONICAL (stated once, used for every number in Item C and Item D):");
  console.log("  " + fmt("BUY", metrics(ctxs.filter((x) => x.c.p.direction === "BUY").map((x) => x.c))).trim());
  console.log("  " + fmt("SELL", metrics(ctxs.filter((x) => x.c.p.direction === "SELL").map((x) => x.c))).trim());
  console.log("  " + fmt("OVERALL", metrics(ctxs.map((x) => x.c))).trim());

  // ── 1. Is TP1R mechanically an inverse volatility proxy? ───────────────────
  console.log("\n" + "=".repeat(104));
  console.log("1. IS TP1R AN INVERSE PROXY FOR VOLATILITY? (direct correlation test)");
  console.log("=".repeat(104));
  const tp1R = withAtr.map((x) => x.c.tp1R);
  console.log(`   n = ${withAtr.length}`);
  console.log(`   Spearman( TP1R , ATR(M5,14) )   = ${spearman(tp1R, withAtr.map((x) => x.atrM5!)).toFixed(4)}`);
  console.log(`   Spearman( TP1R , ATR(M15,14) )  = ${spearman(tp1R, withAtr.map((x) => x.atrM15!)).toFixed(4)}`);
  console.log(`   Spearman( TP1R , SL distance )  = ${spearman(tp1R, withAtr.map((x) => x.slPips)).toFixed(4)}`);
  console.log(`   Spearman( SLdist , ATR(M5,14) ) = ${spearman(withAtr.map((x) => x.slPips), withAtr.map((x) => x.atrM5!)).toFixed(4)}`);
  console.log(`   Spearman( TP1dist , ATR(M5) )   = ${spearman(withAtr.map((x) => x.tp1Pips), withAtr.map((x) => x.atrM5!)).toFixed(4)}`);
  console.log(`\n   (if TP1dist is pinned it should be ~uncorrelated with ATR, while SLdist tracks ATR,`);
  console.log(`    which mechanically forces TP1R = TP1dist/SLdist to be NEGATIVELY correlated with ATR)`);

  // ── 2. Per-tercile ATR and SL ──────────────────────────────────────────────
  console.log("\n" + "=".repeat(104));
  console.log("2. MEDIAN ATR AND MEDIAN SL DISTANCE PER TP1R TERCILE");
  console.log("=".repeat(104));
  const byTp1R = [...withAtr].sort((a, b) => a.c.tp1R - b.c.tp1R);
  const t = Math.floor(byTp1R.length / 3);
  const terciles: [string, Ctx[]][] = [
    ["LOW  TP1R", byTp1R.slice(0, t)],
    ["MID  TP1R", byTp1R.slice(t, 2 * t)],
    ["HIGH TP1R", byTp1R.slice(2 * t)],
  ];
  console.log("\n   tercile      n    medTP1R   medATR(M5)  medATR(M15)  medSLdist(p)  medTP1dist(p)  ATR(M5) p10-p90");
  line();
  for (const [lbl, set] of terciles) {
    console.log(
      `   ${lbl.padEnd(12)}${String(set.length).padStart(3)}   ${median(set.map((x) => x.c.tp1R)).toFixed(3)}` +
        `     $${median(set.map((x) => x.atrM5!)).toFixed(3)}` +
        `      $${median(set.map((x) => x.atrM15!)).toFixed(3)}` +
        `        ${median(set.map((x) => x.slPips)).toFixed(1)}` +
        `          ${median(set.map((x) => x.tp1Pips)).toFixed(1)}` +
        `        $${quantile(set.map((x) => x.atrM5!), 0.1).toFixed(2)}-$${quantile(set.map((x) => x.atrM5!), 0.9).toFixed(2)}`,
    );
  }

  // separation: how much do LOW and HIGH ATR distributions overlap?
  const lowAtr = terciles[0][1].map((x) => x.atrM5!).sort((a, b) => a - b);
  const highAtr = terciles[2][1].map((x) => x.atrM5!).sort((a, b) => a - b);
  const cut = median([...lowAtr, ...highAtr]);
  // HYPOTHESIS: low TP1R => HIGH atr, high TP1R => LOW atr.
  // So under the hypothesis, LOW-tercile signals should sit ABOVE the cut and
  // HIGH-tercile signals BELOW it. Those are the CORRECT classifications.
  const lowAbove = lowAtr.filter((v) => v > cut).length;
  const highBelow = highAtr.filter((v) => v <= cut).length;
  const acc = (lowAbove + highBelow) / (lowAtr.length + highAtr.length);
  console.log(
    `\n   SEPARATION TEST — classify LOW vs HIGH tercile using ATR(M5) alone at the pooled median cut $${cut.toFixed(3)}:`,
  );
  console.log(
    `     hypothesis-consistent ACCURACY = ${(acc * 100).toFixed(1)}%   (misclassification ${((1 - acc) * 100).toFixed(1)}%)`,
  );
  console.log(`       50% accuracy  = ATR carries NO information about which tercile a signal is in`);
  console.log(`       100% accuracy = the tercile IS purely the volatility regime`);

  // ── 3. Per-generation ATR and SL ───────────────────────────────────────────
  console.log("\n" + "=".repeat(104));
  console.log("3. MEDIAN ATR AND MEDIAN SL DISTANCE PER 0.6R GENERATION SPLIT");
  console.log("=".repeat(104));
  const GEN = 0.6;
  const genA = withAtr.filter((x) => x.c.tp1R < GEN);
  const genB = withAtr.filter((x) => x.c.tp1R >= GEN);
  console.log("\n   generation        n    medTP1R   medATR(M5)  medATR(M15)  medSLdist(p)  medTP1dist(p)");
  line();
  for (const [lbl, set] of [
    [`GEN-A TP1R<${GEN}`, genA],
    [`GEN-B TP1R>=${GEN}`, genB],
  ] as [string, Ctx[]][]) {
    if (set.length === 0) continue;
    console.log(
      `   ${lbl.padEnd(18)}${String(set.length).padStart(3)}   ${median(set.map((x) => x.c.tp1R)).toFixed(3)}` +
        `     $${median(set.map((x) => x.atrM5!)).toFixed(3)}` +
        `      $${median(set.map((x) => x.atrM15!)).toFixed(3)}` +
        `        ${median(set.map((x) => x.slPips)).toFixed(1)}` +
        `          ${median(set.map((x) => x.tp1Pips)).toFixed(1)}`,
    );
  }
  const gaAtr = genA.map((x) => x.atrM5!);
  const gbAtr = genB.map((x) => x.atrM5!);
  if (gaAtr.length && gbAtr.length) {
    const gcut = median([...gaAtr, ...gbAtr]);
    // GEN-A = low TP1R => should be ABOVE cut; GEN-B = high TP1R => BELOW cut.
    const gacc =
      (gaAtr.filter((v) => v > gcut).length + gbAtr.filter((v) => v <= gcut).length) / (gaAtr.length + gbAtr.length);
    console.log(
      `\n   SEPARATION TEST — classify GEN-A vs GEN-B using ATR(M5) alone at cut $${gcut.toFixed(3)}:`,
    );
    console.log(
      `     hypothesis-consistent ACCURACY = ${(gacc * 100).toFixed(1)}%   (misclassification ${((1 - gacc) * 100).toFixed(1)}%)`,
    );
  }

  // ── 4. The ATR buckets that Item C will additionally report by ─────────────
  console.log("\n" + "=".repeat(104));
  console.log("4. THE ATR BUCKETS (independent volatility split — Item C reports every feature by these too)");
  console.log("=".repeat(104));
  const byAtr = [...withAtr].sort((a, b) => a.atrM5! - b.atrM5!);
  const a3 = Math.floor(byAtr.length / 3);
  const atrBuckets: [string, Ctx[]][] = [
    ["ATR-LOW", byAtr.slice(0, a3)],
    ["ATR-MID", byAtr.slice(a3, 2 * a3)],
    ["ATR-HIGH", byAtr.slice(2 * a3)],
  ];
  console.log("\n   bucket        n    medATR(M5)   ATR range          medTP1R   medSLdist(p)");
  line();
  for (const [lbl, set] of atrBuckets) {
    console.log(
      `   ${lbl.padEnd(12)}${String(set.length).padStart(3)}    $${median(set.map((x) => x.atrM5!)).toFixed(3)}` +
        `     $${Math.min(...set.map((x) => x.atrM5!)).toFixed(2)}-$${Math.max(...set.map((x) => x.atrM5!)).toFixed(2)}` +
        `      ${median(set.map((x) => x.c.tp1R)).toFixed(3)}     ${median(set.map((x) => x.slPips)).toFixed(1)}`,
    );
  }

  console.log("\n   ECONOMICS BY ATR BUCKET (canonical outcomes) — does the book's edge track volatility?");
  for (const [lbl, set] of atrBuckets) {
    console.log(`\n   ${lbl}`);
    console.log("   " + fmt("  ALL", metrics(set.map((x) => x.c))).trim());
    console.log("   " + fmt("  BUY", metrics(set.filter((x) => x.c.p.direction === "BUY").map((x) => x.c))).trim());
    console.log("   " + fmt("  SELL", metrics(set.filter((x) => x.c.p.direction === "SELL").map((x) => x.c))).trim());
  }

  console.log("\n   ECONOMICS BY TP1R TERCILE (for side-by-side comparison with the ATR buckets above)");
  for (const [lbl, set] of terciles) {
    console.log(`\n   ${lbl}`);
    console.log("   " + fmt("  ALL", metrics(set.map((x) => x.c))).trim());
    console.log("   " + fmt("  BUY", metrics(set.filter((x) => x.c.p.direction === "BUY").map((x) => x.c))).trim());
    console.log("   " + fmt("  SELL", metrics(set.filter((x) => x.c.p.direction === "SELL").map((x) => x.c))).trim());
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
