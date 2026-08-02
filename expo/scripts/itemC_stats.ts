/**
 * Shared statistics layer for ITEM C and ITEM D.
 *
 * CONFIRM 3 IS BINDING, NOT ADVISORY: at EV +0.0605R and PF 1.16 the book has
 * almost no margin. Every win rate reported must carry n, an effect size, and a
 * plain statement of whether the difference is distinguishable from noise.
 * "A 3-point WR move on n=40 is not a result and must not be reported as one."
 *
 * This module makes that mechanical rather than a matter of my judgement.
 */

/** Normal CDF (Abramowitz & Stegun 7.1.26 based erf approximation). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

export interface PropTest {
  nA: number;
  kA: number;
  pA: number;
  nB: number;
  kB: number;
  pB: number;
  diffPts: number;
  z: number;
  p: number;
  /** Minimum detectable difference in percentage points at 80% power, alpha=0.05 two-sided. */
  mdePts: number;
  verdict: string;
}

/**
 * Two-proportion z-test: group A (feature fired) vs group B (feature did not fire).
 * Also reports the minimum effect this sample size COULD have detected, which is
 * what turns "not significant" into an interpretable statement.
 */
export function twoProp(kA: number, nA: number, kB: number, nB: number): PropTest {
  const pA = nA > 0 ? kA / nA : 0;
  const pB = nB > 0 ? kB / nB : 0;
  const diffPts = (pA - pB) * 100;
  let z = 0;
  if (nA > 0 && nB > 0) {
    const pool = (kA + kB) / (nA + nB);
    const se = Math.sqrt(pool * (1 - pool) * (1 / nA + 1 / nB));
    z = se > 0 ? (pA - pB) / se : 0;
  }
  const p = nA > 0 && nB > 0 ? 2 * (1 - normCdf(Math.abs(z))) : 1;

  // MDE at 80% power, alpha 0.05 two-sided: (1.96 + 0.8416) * SE_pooled
  let mdePts = Number.POSITIVE_INFINITY;
  if (nA > 0 && nB > 0) {
    const pool = (kA + kB) / (nA + nB);
    const se = Math.sqrt(Math.max(1e-9, pool * (1 - pool)) * (1 / nA + 1 / nB));
    mdePts = (1.959964 + 0.841621) * se * 100;
  }

  let verdict: string;
  if (nA < 20 || nB < 20) {
    verdict = `UNDERPOWERED (n too small)`;
  } else if (p < 0.05) {
    verdict = `DISTINGUISHABLE (p=${p.toFixed(3)})`;
  } else if (Math.abs(diffPts) < mdePts) {
    verdict = `NOISE (|${diffPts.toFixed(1)}pts| < MDE ${mdePts.toFixed(1)}pts)`;
  } else {
    verdict = `NOT SIGNIFICANT (p=${p.toFixed(3)})`;
  }

  return { nA, kA, pA, nB, kB, pB, diffPts, z, p, mdePts, verdict };
}

/** Bootstrap 95% CI for mean R (EV). Deterministic seed so runs are reproducible. */
export function bootstrapEvCi(rs: number[], iters: number = 4000, seed: number = 20260802): [number, number] {
  if (rs.length === 0) return [NaN, NaN];
  let s = seed >>> 0;
  const rnd = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < rs.length; j++) sum += rs[Math.floor(rnd() * rs.length)];
    means.push(sum / rs.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * iters)], means[Math.floor(0.975 * iters)]];
}

/** One-line renderer used for every feature row so the format cannot drift. */
export function renderRow(label: string, t: PropTest, evFired: number, evCi: [number, number]): string {
  return (
    `    ${label.padEnd(30)}` +
    `n=${String(t.nA).padStart(3)}/${String(t.nA + t.nB).padStart(3)}  ` +
    `WR=${(t.pA * 100).toFixed(1).padStart(5)}%  ` +
    `vs-notfired=${(t.diffPts >= 0 ? "+" : "") + t.diffPts.toFixed(1)}pts  ` +
    `MDE=${Number.isFinite(t.mdePts) ? t.mdePts.toFixed(1) : "inf"}pts  ` +
    `EV=${(evFired >= 0 ? "+" : "") + evFired.toFixed(3)}R[${evCi[0].toFixed(3)},${evCi[1].toFixed(3)}]  ` +
    t.verdict
  );
}
