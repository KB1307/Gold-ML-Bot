/**
 * ITEM EC — SWING-STRUCTURE GATE acceptance (detection-side; no DB writes).
 *
 * Verifies the REAL computeSwingStructure (imported from the live service):
 *   1. STRUCTURE — a constructed series with a known fractal swing high (j=50)
 *      and swing low (j=40) returns the exact bars/levels/confirmation bars.
 *   2. CAUSALITY — over 50 seeded random-walk series, every non-null
 *      confirmation bar satisfies swingCausalGap ≥ 1 (the assertion never
 *      fires legitimately), and the LOOKAHEAD throw does not fire.
 *   3. BOUNDARY — a swing at j = n−4 (the most recent knowable swing)
 *      confirms at n−2 with gap exactly 1.
 *   4. NO-SWING — a monotone strictly-increasing series has no fractal swings
 *      → structure all null (the gate cannot block without a swing).
 *   5. FORMULA — the gate formula (replicated from the prompt; the engine
 *      applies it in swingGateFor): BUY blocked iff price > lastSwingHigh −
 *      SWING_TOLERANCE; SELL blocked iff price < lastSwingLow + SWING_TOLERANCE.
 *
 * Run: bun expo/scripts/mock_test_swing_gate_ec.ts
 */
import { computeSwingStructure, SWING_TOLERANCE, type ShadowM5Bar } from "../services/shadowStrategies";

const M5_MS = 5 * 60 * 1000;
const DAY_MS = Date.UTC(2026, 8, 9);

function mkBar(idx: number, o: number, h: number, l: number, c: number): ShadowM5Bar {
  return { timestamp: DAY_MS + idx * M5_MS, open: o, high: h, low: l, close: c };
}

// ── 1. STRUCTURE ──
const bars: ShadowM5Bar[] = [];
for (let k = 0; k < 60; k += 1) bars.push(mkBar(k, 4500, 4500, 4500, 4500));
bars[40] = mkBar(40, 4500, 4500, 4440, 4470); // swing low: 4440 < lows of 38,39,41,42 (4500)
bars[50] = mkBar(50, 4500, 4520, 4500, 4510); // swing high: 4520 > highs of 48,49,51,52 (4500)
const s = computeSwingStructure(bars);
const structureOk =
  s.lastSwingHigh === 4520 &&
  s.lastSwingHighBar === 50 &&
  s.confirmationBarHigh === 52 &&
  s.lastSwingLow === 4440 &&
  s.lastSwingLowBar === 40 &&
  s.confirmationBarLow === 42;
console.log(`structure: ${JSON.stringify(s)}`);

// ── 2. CAUSALITY over seeded random walks ──
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let causalityOk = true;
let swingsSeen = 0;
for (let seed = 1; seed <= 50 && causalityOk; seed += 1) {
  const rng = mulberry32(seed);
  const walk: ShadowM5Bar[] = [];
  let price = 4500;
  for (let k = 0; k < 1000; k += 1) {
    const o = price;
    price += (rng() - 0.5) * 8;
    const h = Math.max(o, price) + rng() * 2;
    const l = Math.min(o, price) - rng() * 2;
    walk.push(mkBar(k, o, h, l, price));
  }
  let st: ReturnType<typeof computeSwingStructure>;
  try {
    st = computeSwingStructure(walk);
  } catch (e) {
    console.log(`CAUSALITY THROW on seed ${seed}: ${e instanceof Error ? e.message : String(e)}`);
    causalityOk = false;
    break;
  }
  const current = walk.length - 1;
  if (st.confirmationBarHigh !== null) {
    swingsSeen += 1;
    if (st.confirmationBarHigh >= current) causalityOk = false;
  }
  if (st.confirmationBarLow !== null) {
    swingsSeen += 1;
    if (st.confirmationBarLow >= current) causalityOk = false;
  }
}

// ── 3. BOUNDARY — most recent knowable swing (j = n−4) ──
const boundaryBars: ShadowM5Bar[] = [];
for (let k = 0; k < 64; k += 1) boundaryBars.push(mkBar(k, 4500, 4500, 4500, 4500));
boundaryBars[60] = mkBar(60, 4500, 4530, 4500, 4520); // j = 60 = n−4
const sb = computeSwingStructure(boundaryBars);
const boundaryOk =
  sb.lastSwingHighBar === 60 &&
  sb.confirmationBarHigh === 62 &&
  63 - (sb.confirmationBarHigh as number) === 1;
console.log(`boundary: ${JSON.stringify(sb)}`);

// ── 4. NO-SWING — monotone strictly increasing ──
const rampBars: ShadowM5Bar[] = [];
for (let k = 0; k < 100; k += 1) {
  const c = 4400 + k;
  rampBars.push(mkBar(k, c, c + 0.5, c - 0.5, c));
}
const sr = computeSwingStructure(rampBars);
const noSwingOk =
  sr.lastSwingHigh === null && sr.lastSwingLow === null &&
  sr.confirmationBarHigh === null && sr.confirmationBarLow === null;

// ── 5. FORMULA (prompt's rule; the engine applies it in swingGateFor) ──
const H = s.lastSwingHigh as number;
const L = s.lastSwingLow as number;
const buyBlocked = (price: number): boolean => price > H - SWING_TOLERANCE;
const sellBlocked = (price: number): boolean => price < L + SWING_TOLERANCE;
const formulaOk =
  buyBlocked(H - 0.99) === true && // 4519.01 > 4519 → blocked
  buyBlocked(H - 1.01) === false && // 4518.99 ≤ 4519 → allowed
  sellBlocked(L + 0.99) === true && // 4440.99 < 4441 → blocked
  sellBlocked(L + 1.01) === false; // 4441.01 ≥ 4441 → allowed

console.log("── GATE CHECKS ──");
const pass = structureOk && causalityOk && swingsSeen > 0 && boundaryOk && noSwingOk && formulaOk;
console.log(
  `ITEM EC GATE: ${pass ? "PASS" : "FAIL"} (structure=${structureOk}, causality=${causalityOk} over ${swingsSeen} swings/50 seeds, boundaryGap1=${boundaryOk}, noSwing=${noSwingOk}, formula=${formulaOk})`,
);
if (!pass) process.exitCode = 1;
