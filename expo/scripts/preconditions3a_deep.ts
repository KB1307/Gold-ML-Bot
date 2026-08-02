/**
 * PRECONDITION 3a — DEEP CHARACTERISATION.
 *
 * The first pass showed TP1's realised R-multiple spans 0.333 -> 0.735 with 261
 * contiguous runs across 369 signals — i.e. NOT piecewise-constant. Before
 * claiming "the export mixes two ladder generations" I need to establish WHICH
 * leg is quantised (the TP distance, the SL distance, or neither) and whether
 * there is a genuine date-boundary regime change underneath the noise.
 *
 * Read-only. DATA-SOURCE RULE: gold_m1_bars via Supabase anon key only.
 */
import { buildCanonical, metrics, fmt, type Canon } from "./preconditions";

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}
function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const { rows } = await buildCanonical();
  const chrono = [...rows].sort((a, b) => a.p.generatedMs - b.p.generatedMs);

  console.log("=".repeat(104));
  console.log("PRECONDITION 3a — DEEP: WHICH LEG IS QUANTISED, AND IS THERE A DATE BOUNDARY?");
  console.log("=".repeat(104));

  // ── 1. Which leg is quantised? ────────────────────────────────────────────
  console.log("\n1. QUANTISATION TEST — TP1 distance (pips) vs SL distance (pips) vs their ratio\n");
  function distinct(vals: number[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const v of vals) {
      const k = v.toFixed(1);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }
  const tpPips = chrono.map((r) => Math.abs(r.p.tp1 - r.p.entry) * 10);
  const slPips = chrono.map((r) => r.slDistance * 10);
  const dTp = distinct(tpPips);
  const dSl = distinct(slPips);
  console.log(`   distinct TP1 distances (0.1-pip resolution): ${dTp.size}`);
  console.log(`   distinct SL  distances (0.1-pip resolution): ${dSl.size}`);
  console.log(`   distinct TP1 R-multiples (2dp)             : ${new Set(chrono.map((r) => r.tp1R.toFixed(2))).size}`);

  console.log("\n   TP1 distance histogram (pips, top 15):");
  for (const [k, v] of [...dTp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`     ${k.padStart(6)}p  n=${String(v).padStart(4)}  ${"#".repeat(Math.min(50, v))}`);
  }
  console.log("\n   SL distance histogram (pips, top 15):");
  for (const [k, v] of [...dSl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`     ${k.padStart(6)}p  n=${String(v).padStart(4)}  ${"#".repeat(Math.min(50, v))}`);
  }

  // ── 2. Per-day medians: is there a step change? ───────────────────────────
  console.log("\n2. PER-DAY MEDIANS — is there a step change in TP1 R, or does it drift with SL?\n");
  const byDay = new Map<string, Canon[]>();
  for (const r of chrono) {
    const d = day(r.p.generatedMs);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }
  const med = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  console.log("   date         n    med TP1R   min-max TP1R    med TPdist(p)  med SLdist(p)");
  console.log("   " + "-".repeat(84));
  for (const [d, set] of [...byDay.entries()].sort()) {
    const rs = set.map((x) => x.tp1R);
    console.log(
      `   ${d}  ${String(set.length).padStart(3)}     ${med(rs).toFixed(3)}    ${Math.min(...rs).toFixed(2)}-${Math.max(...rs).toFixed(2)}` +
        `        ${med(set.map((x) => Math.abs(x.p.tp1 - x.p.entry) * 10)).toFixed(1)}          ${med(set.map((x) => x.slDistance * 10)).toFixed(1)}`,
    );
  }

  // ── 3. TP2/TP3 ratios too ─────────────────────────────────────────────────
  console.log("\n3. THE WHOLE LADDER — TP1 : TP2 : TP3 as R-multiples\n");
  const tp2R = chrono.map((r) => Math.abs(r.p.tp2 - r.p.entry) / r.slDistance);
  const tp3R = chrono.map((r) => Math.abs(r.p.tp3 - r.p.entry) / r.slDistance);
  console.log(`   TP1R  median ${med(chrono.map((r) => r.tp1R)).toFixed(3)}   range ${Math.min(...chrono.map((r) => r.tp1R)).toFixed(3)}-${Math.max(...chrono.map((r) => r.tp1R)).toFixed(3)}`);
  console.log(`   TP2R  median ${med(tp2R).toFixed(3)}   range ${Math.min(...tp2R).toFixed(3)}-${Math.max(...tp2R).toFixed(3)}`);
  console.log(`   TP3R  median ${med(tp3R).toFixed(3)}   range ${Math.min(...tp3R).toFixed(3)}-${Math.max(...tp3R).toFixed(3)}`);
  const ratio21 = chrono.map((r) => Math.abs(r.p.tp2 - r.p.entry) / Math.abs(r.p.tp1 - r.p.entry));
  const ratio31 = chrono.map((r) => Math.abs(r.p.tp3 - r.p.entry) / Math.abs(r.p.tp1 - r.p.entry));
  console.log(`\n   TP2/TP1 distance ratio: median ${med(ratio21).toFixed(3)}   distinct(2dp) ${new Set(ratio21.map((x) => x.toFixed(2))).size}`);
  console.log(`   TP3/TP1 distance ratio: median ${med(ratio31).toFixed(3)}   distinct(2dp) ${new Set(ratio31.map((x) => x.toFixed(2))).size}`);
  console.log(`   => if these two are near-constant, the LADDER SHAPE is fixed and only its R-SCALE floats with SL.`);

  // ── 4. Does TP1R correlate with SL distance? ──────────────────────────────
  console.log("\n4. IS THE R-MULTIPLE SPREAD JUST SL VARIATION?\n");
  const xs = chrono.map((r) => r.slDistance);
  const ys = chrono.map((r) => r.tp1R);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0,
    dx = 0,
    dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const corr = num / Math.sqrt(dx * dy);
  console.log(`   Pearson corr( SL distance , TP1 R-multiple ) = ${corr.toFixed(4)}`);
  console.log(`   corr( TP1 distance , SL distance )           = ${(() => {
    const a = chrono.map((r) => Math.abs(r.p.tp1 - r.p.entry));
    const b = chrono.map((r) => r.slDistance);
    const ma = a.reduce((x, y) => x + y, 0) / a.length;
    const mb = b.reduce((x, y) => x + y, 0) / b.length;
    let n = 0,
      da = 0,
      db = 0;
    for (let i = 0; i < a.length; i++) {
      n += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return (n / Math.sqrt(da * db)).toFixed(4);
  })()}`);

  // ── 5. The two nominal ladders as CONFIGURED, tested against the data ─────
  console.log("\n5. TESTING THE 'TWO CONFIGURED LADDERS' HYPOTHESIS DIRECTLY\n");
  console.log("   Hypothesis: TP1 was configured at RRR 0.50 then changed to 0.70.");
  console.log("   If true, TP1R should cluster tightly at 0.50 and 0.70. Observed clustering:\n");
  for (const target of [0.5, 0.7]) {
    const near = chrono.filter((r) => Math.abs(r.tp1R - target) < 0.02).length;
    console.log(`     within +/-0.02 of ${target.toFixed(2)}R : ${near}/${chrono.length} (${((near / chrono.length) * 100).toFixed(1)}%)`);
  }
  const modes = [...new Set(chrono.map((r) => r.tp1R.toFixed(2)))]
    .map((k) => ({ k, n: chrono.filter((r) => r.tp1R.toFixed(2) === k).length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 6);
  console.log(`\n     actual top-6 modes: ${modes.map((m) => `${m.k}R (n=${m.n})`).join("  ")}`);

  // ── 6. Chronological halves (needed for Item D stability anyway) ──────────
  console.log("\n6. CHRONOLOGICAL HALVES — economics and ladder, side by side\n");
  const half = Math.floor(chrono.length / 2);
  const h1 = chrono.slice(0, half);
  const h2 = chrono.slice(half);
  for (const [lbl, set] of [
    ["H1", h1],
    ["H2", h2],
  ] as [string, Canon[]][]) {
    console.log(
      `   ${lbl}  ${iso(set[0].p.generatedMs)} -> ${iso(set[set.length - 1].p.generatedMs)}   medTP1R=${med(set.map((x) => x.tp1R)).toFixed(3)}`,
    );
    console.log("   " + fmt("  ALL", metrics(set)).trim());
    console.log("   " + fmt("  BUY", metrics(set.filter((x) => x.p.direction === "BUY"))).trim());
    console.log("   " + fmt("  SELL", metrics(set.filter((x) => x.p.direction === "SELL"))).trim());
  }

  // ── 7. TP1R tercile economics — does the ladder scale actually matter? ────
  console.log("\n7. ECONOMICS BY TP1-R TERCILE (does the realised ladder scale change the result?)\n");
  const sorted = [...chrono].sort((a, b) => a.tp1R - b.tp1R);
  const t = Math.floor(sorted.length / 3);
  const terciles: [string, Canon[]][] = [
    [`LOW  TP1R<=${sorted[t - 1].tp1R.toFixed(3)}`, sorted.slice(0, t)],
    [`MID`, sorted.slice(t, 2 * t)],
    [`HIGH TP1R>=${sorted[2 * t].tp1R.toFixed(3)}`, sorted.slice(2 * t)],
  ];
  for (const [lbl, set] of terciles) {
    console.log(`   ${lbl.padEnd(22)} medTP1R=${med(set.map((x) => x.tp1R)).toFixed(3)}`);
    console.log("   " + fmt("  ALL", metrics(set)).trim());
    console.log("   " + fmt("  BUY", metrics(set.filter((x) => x.p.direction === "BUY"))).trim());
    console.log("   " + fmt("  SELL", metrics(set.filter((x) => x.p.direction === "SELL"))).trim());
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
