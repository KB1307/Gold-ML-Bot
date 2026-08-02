/**
 * ITEM D ADDENDUM — characterising the sweep optimum. READ-ONLY.
 *
 * The pass-2 optimum (TP1 1.00R, lock 0.3xTP1, TP2/TP3 scaled) FAILED the
 * pre-registered plateau check and the two chronological halves disagreed.
 * Three things must be characterised before the surface can be interpreted:
 *
 *   A. THE OPTIMUM IS ON THE GRID EDGE. TP1 = 1.00R is the top of the mandated
 *      range, so "TP1 +1 step" had no neighbour and the plateau test was
 *      structurally one-sided there. Extend past the edge and see whether EV
 *      keeps climbing. If it does, the sweep is not locating an optimum at all.
 *
 *   B. WHERE DOES THE EV COME FROM? The optimum records ZERO full-loss ->
 *      locked-win conversions and 47 reversions, with WR falling 63.1% -> 50.4%.
 *      That is the opposite of the mechanism TP1 was supposed to exercise.
 *      Decompose the EV delta into its per-signal sources.
 *
 *   C. IS IT TP1 AT ALL? Under tp23=scaled, raising TP1 also widens TP2/TP3 by
 *      the same factor. Control for it: hold TP1 at the live stored geometry and
 *      scale ONLY TP2/TP3. If that alone reproduces the gain, the sweep is
 *      measuring target width, not TP1 placement.
 *
 * CANONICAL SET unchanged: 369 signals, REAL resolveSignalWithBars,
 * fromScratch:true, R>0 predicate. gold_m1_bars direct from Supabase (anon).
 */
import { resolveSignalWithBars, type LadderOverride } from "../services/signalResolver";
import type { OhlcBar } from "../services/barStore";
import { buildCanonical, parseExport, toTradingSignal, type ParsedSignal } from "./preconditions";

const PIP = 0.1;
const r1 = (x: number): number => Number(x.toFixed(1));
const sgn = (x: number): string => (x >= 0 ? "+" : "");

interface Variant {
  label: string;
  /** TP1 distance in R; null = keep the signal's own stored TP1 */
  tp1R: number | null;
  /** scale factor applied to TP2/TP3; "withTp1" = proportional to the TP1 change */
  tp23: "abs" | "withTp1" | number;
  ladder: LadderOverride;
}

interface Row {
  r: number;
  pnl: number;
  dir: "BUY" | "SELL";
  status: string;
}

function evaluate(v: Variant, sigs: ParsedSignal[], slices: OhlcBar[][], evalNowMs: number): Row[] {
  const out: Row[] = [];
  const realLog = console.log;
  console.log = () => {};
  for (let i = 0; i < sigs.length; i++) {
    const p = sigs[i];
    const stop = Math.abs(p.entry - p.sl);
    const s = p.direction === "BUY" ? 1 : -1;
    const oldT1 = Math.abs(p.tp1 - p.entry);
    const oldT2 = Math.abs(p.tp2 - p.entry);
    const oldT3 = Math.abs(p.tp3 - p.entry);
    const newT1 = v.tp1R === null ? oldT1 : v.tp1R * stop;
    const k = v.tp23 === "abs" ? 1 : v.tp23 === "withTp1" ? (oldT1 > 0 ? newT1 / oldT1 : 1) : v.tp23;
    const sig = toTradingSignal(p);
    sig.tp1 = r1(p.entry + s * newT1);
    sig.tp2 = r1(p.entry + s * oldT2 * k);
    sig.tp3 = r1(p.entry + s * oldT3 * k);
    const res = resolveSignalWithBars(sig, slices[i], { fromScratch: true, evalNowMs, ladder: v.ladder });
    const pnl = p.direction === "BUY" ? res.exitPrice - p.entry : p.entry - res.exitPrice;
    out.push({ r: pnl / stop, pnl, dir: p.direction, status: res.newStatus });
  }
  console.log = realLog;
  return out;
}

function summarise(rows: Row[]): string {
  const w = rows.filter((x) => x.r > 0);
  const l = rows.filter((x) => x.r < 0);
  const gw = w.reduce((a, b) => a + b.r, 0);
  const gl = Math.abs(l.reduce((a, b) => a + b.r, 0));
  const ev = rows.reduce((a, b) => a + b.r, 0) / rows.length;
  const pf = gl > 0 ? gw / gl : Number.POSITIVE_INFINITY;
  return (
    `WR=${((w.length / rows.length) * 100).toFixed(1).padStart(5)}%  PF=${(Number.isFinite(pf) ? pf.toFixed(2) : "inf").padStart(5)}` +
    `  EV=${(sgn(ev) + ev.toFixed(4)).padStart(9)}R  net=${(sgn(rows.reduce((a, b) => a + b.pnl, 0)) + "$" + rows.reduce((a, b) => a + b.pnl, 0).toFixed(0)).padStart(7)}`
  );
}

function hr(s: string): void {
  console.log("\n" + "=".repeat(112));
  console.log(s);
  console.log("=".repeat(112));
}

async function main(): Promise<void> {
  const { rows: canon, bars, evalNowMs } = await buildCanonical();
  const sigs = parseExport("/tmp/diagnostics_export.txt").filter(
    (p) => p.sl && p.tp1 && p.tp2 && p.tp3 && p.generatedMs && Math.abs(p.entry - p.sl) > 0,
  );
  const slices = sigs.map((p) => {
    const start = p.generatedMs + 60_000;
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].timestamp < start) lo = mid + 1;
      else hi = mid;
    }
    return bars.slice(lo);
  });
  const byId = new Map(canon.map((c) => [c.p.id, c]));
  const base: Row[] = sigs.map((p) => {
    const c = byId.get(p.id)!;
    return { r: c.r, pnl: c.pnlDollars, dir: p.direction, status: c.newStatus };
  });

  hr("ITEM D ADDENDUM — CHARACTERISING THE SWEEP OPTIMUM (read-only)");
  console.log(`run at ${new Date().toISOString()}`);
  console.log(`  BASELINE (live geometry, live lock)            ${summarise(base)}`);

  const OPT: LadderOverride = { lockFractionOfTP1: 0.3, applyLockCap: true };

  // ── A. beyond the grid edge ──────────────────────────────────────────────
  hr("A. THE OPTIMUM SITS ON THE GRID EDGE — EXTEND PAST IT");
  console.log(`  The mandated sweep stopped at TP1 = 1.00R and the optimum landed exactly there. If EV keeps`);
  console.log(`  climbing beyond the edge, the sweep is not locating an interior optimum — it is reporting a`);
  console.log(`  monotone preference, which is a very different (and far weaker) claim.\n`);
  console.log(`    ${"TP1".padEnd(10)}${"lock=0.3xTP1, tp23=scaled".padEnd(30)}`);
  for (const m of [0.3, 0.5, 0.7, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0]) {
    const rows = evaluate({ label: "", tp1R: m, tp23: "withTp1", ladder: OPT }, sigs, slices, evalNowMs);
    console.log(`    ${(m.toFixed(2) + "R").padEnd(10)}${summarise(rows)}`);
  }
  console.log(`\n  Same scan with TP2/TP3 HELD at their live absolute levels (isolates TP1 alone):`);
  for (const m of [0.3, 0.5, 0.7, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0]) {
    const rows = evaluate({ label: "", tp1R: m, tp23: "abs", ladder: OPT }, sigs, slices, evalNowMs);
    console.log(`    ${(m.toFixed(2) + "R").padEnd(10)}${summarise(rows)}`);
  }

  // ── B. decomposition ─────────────────────────────────────────────────────
  hr("B. WHERE THE OPTIMUM'S EV ACTUALLY COMES FROM");
  const opt = evaluate({ label: "", tp1R: 1.0, tp23: "withTp1", ladder: OPT }, sigs, slices, evalNowMs);
  console.log(`  OPTIMUM (TP1 1.00R, lock 0.3xTP1, tp23 scaled) ${summarise(opt)}\n`);
  const buckets = new Map<string, { n: number; dBase: number; dOpt: number }>();
  for (let i = 0; i < base.length; i++) {
    const k = `${base[i].r > 0 ? "WIN" : base[i].r < 0 ? "LOSS" : "FLAT"} -> ${opt[i].r > 0 ? "WIN" : opt[i].r < 0 ? "LOSS" : "FLAT"}`;
    if (!buckets.has(k)) buckets.set(k, { n: 0, dBase: 0, dOpt: 0 });
    const b = buckets.get(k)!;
    b.n++;
    b.dBase += base[i].r;
    b.dOpt += opt[i].r;
  }
  console.log(`    ${"transition".padEnd(18)}${"n".padStart(5)}${"sum R base".padStart(14)}${"sum R opt".padStart(14)}${"contribution to dEV".padStart(24)}`);
  console.log("    " + "-".repeat(74));
  for (const [k, b] of [...buckets.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const contrib = (b.dOpt - b.dBase) / base.length;
    console.log(
      `    ${k.padEnd(18)}${String(b.n).padStart(5)}${(sgn(b.dBase) + b.dBase.toFixed(2)).padStart(14)}${(sgn(b.dOpt) + b.dOpt.toFixed(2)).padStart(14)}${(sgn(contrib) + contrib.toFixed(4) + "R").padStart(24)}`,
    );
  }
  const totalD = opt.reduce((a, b) => a + b.r, 0) / base.length - base.reduce((a, b) => a + b.r, 0) / base.length;
  console.log(`    ${"TOTAL".padEnd(18)}${String(base.length).padStart(5)}${"".padStart(28)}${(sgn(totalD) + totalD.toFixed(4) + "R").padStart(24)}`);

  const stOpt = new Map<string, number>();
  for (const r of opt) stOpt.set(r.status, (stOpt.get(r.status) ?? 0) + 1);
  const stBase = new Map<string, number>();
  for (const r of base) stBase.set(r.status, (stBase.get(r.status) ?? 0) + 1);
  console.log(`\n    status decomposition   ${"baseline".padStart(10)}${"optimum".padStart(10)}`);
  for (const k of new Set([...stBase.keys(), ...stOpt.keys()]))
    console.log(`      ${k.padEnd(22)}${String(stBase.get(k) ?? 0).padStart(8)}${String(stOpt.get(k) ?? 0).padStart(10)}`);

  // ── C. control: widen TP2/TP3 only ───────────────────────────────────────
  hr("C. CONTROL — IS THIS ABOUT TP1 AT ALL, OR JUST WIDER TP2/TP3?");
  console.log(`  Hold TP1 EXACTLY at the live stored geometry and scale ONLY TP2/TP3.`);
  console.log(`  At the optimum, TP1 1.00R against a median live TP1 of ~0.70R is roughly a 1.43x widening,`);
  console.log(`  so the k=1.4 row is the like-for-like control.\n`);
  console.log(`    ${"TP2/TP3 scale".padEnd(16)}${"TP1 = live stored".padEnd(20)}`);
  for (const k of [1.0, 1.2, 1.4, 1.6, 2.0, 3.0]) {
    const rows = evaluate({ label: "", tp1R: null, tp23: k, ladder: {} }, sigs, slices, evalNowMs);
    console.log(`    ${("x" + k.toFixed(1)).padEnd(16)}${summarise(rows)}`);
  }
  console.log(`\n  Same control, but with the optimum's lock (0.3 x TP1) instead of the live lock:`);
  for (const k of [1.0, 1.2, 1.4, 1.6, 2.0, 3.0]) {
    const rows = evaluate({ label: "", tp1R: null, tp23: k, ladder: OPT }, sigs, slices, evalNowMs);
    console.log(`    ${("x" + k.toFixed(1)).padEnd(16)}${summarise(rows)}`);
  }

  // ── D. lock alone ────────────────────────────────────────────────────────
  hr("D. THE LOCK AXIS ALONE, AT THE LIVE LADDER (the one change that is NOT a target-width change)");
  console.log(`  TP1/TP2/TP3 all held at live stored geometry; only the post-TP1 lock rule varies.\n`);
  const lockVariants: [string, LadderOverride][] = [
    ["live: 0.35 x R, cap on", {}],
    ["0.35 x R, cap OFF", { lockFractionOfR: 0.35, applyLockCap: false }],
    ["0.20 x R, cap on", { lockFractionOfR: 0.2, applyLockCap: true }],
    ["0.50 x R, cap on", { lockFractionOfR: 0.5, applyLockCap: true }],
    ["0.3 x TP1", { lockFractionOfTP1: 0.3, applyLockCap: true }],
    ["0.4 x TP1", { lockFractionOfTP1: 0.4, applyLockCap: true }],
    ["0.5 x TP1", { lockFractionOfTP1: 0.5, applyLockCap: true }],
    ["0.7 x TP1", { lockFractionOfTP1: 0.7, applyLockCap: false }],
    ["0.9 x TP1", { lockFractionOfTP1: 0.9, applyLockCap: false }],
  ];
  for (const [label, ladder] of lockVariants) {
    const rows = evaluate({ label, tp1R: null, tp23: "abs", ladder }, sigs, slices, evalNowMs);
    console.log(`    ${label.padEnd(24)}${summarise(rows)}`);
  }

  hr("END ADDENDUM — NOTHING IMPLEMENTED.");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
