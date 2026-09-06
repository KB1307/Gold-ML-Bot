/**
 * ITEM BA ACCEPTANCE — mock test for shadowStrategies.ts (pure detection only,
 * no DB writes). Run: bun expo/scripts/mock_test_shadow_strategies.ts
 *
 * Scenario (SCORED_DT_SHORT): 100 M5 bars spanning 2026-09-01 07:00–15:15 UTC.
 * London session (07:00–12:00 UTC) is FULLY covered → counts for the session
 * confluence; NY (12:00–22:00) is NOT fully covered → excluded (same guard as
 * feat_session_level_count). Flat at 4500, spike to 4510 at bar 50 (inside
 * London), pullback to 4504 (>= $4 below A = 4510), monotone ramp back up
 * (capped at 4508.45 so no later fractal swing high exists), second touch at
 * bar 99: high 4509 (|high - A| = 1 <= 3), red close 4507 (close < open,
 * |close - A| = 3 <= 3, close <= A + 0.5). Expected: detected true,
 * swingHighPrice 4510, swingHighBar 50, pullbackDepth 6, sessionLevelDistance 0,
 * finite score, verdict BELOW.
 */
import { detectDoubleTop, detectScoredReopen, type ShadowM5Bar } from "../services/shadowStrategies";

const DAY_MS = Date.UTC(2026, 8, 1); // 2026-09-01
const M5_MS = 5 * 60 * 1000;

function mkBar(idx: number, open: number, high: number, low: number, close: number): ShadowM5Bar {
  return { timestamp: DAY_MS + 7 * 3600000 + idx * M5_MS, open, high, low, close };
}

const dtBars: ShadowM5Bar[] = [];
for (let k = 0; k <= 49; k += 1) dtBars.push(mkBar(k, 4500, 4500, 4500, 4500));
dtBars.push(mkBar(50, 4500, 4510, 4500, 4509)); // spike — the only fractal swing high (A = 4510)
dtBars.push(mkBar(51, 4509, 4509, 4504, 4505)); // pullback low 4504 <= A - 4
dtBars.push(mkBar(52, 4505, 4506, 4504.5, 4505));
for (let k = 53; k <= 98; k += 1) {
  const c = 4505 + (k - 52) * 0.075; // monotone ramp, max 4508.45 at bar 98 — no later swing high
  dtBars.push(mkBar(k, c, c, c - 0.1, c));
}
dtBars.push(mkBar(99, 4509, 4509, 4506.5, 4507)); // second touch, red close back inside the zone

console.log("── detectDoubleTop (SELL, full pattern) ──");
const dt = detectDoubleTop({ m5Bars: dtBars, entryPrice: 4507, direction: "SELL", rsi: 65 });
console.log(JSON.stringify(dt, null, 2));

console.log("── detectDoubleTop (BUY self-filter) ──");
const dtBuy = detectDoubleTop({ m5Bars: dtBars, entryPrice: 4507, direction: "BUY", rsi: 65 });
console.log(JSON.stringify(dtBuy));

console.log("── SCORED_REOPEN_LONG (isReopen, 400-bar uptrend, gap-down open) ──");
const reopenBars: ShadowM5Bar[] = [];
for (let k = 0; k < 400; k += 1) {
  const c = 4400 + k * 0.25;
  reopenBars.push({ timestamp: DAY_MS + k * M5_MS, open: c, high: c + 0.2, low: c - 0.2, close: c });
}
const priorClose = reopenBars[reopenBars.length - 2].close; // 4497.25 — close of the bar before the gap
const reopen = detectScoredReopen({ m5Bars: reopenBars, isReopen: true, entryPrice: 4490, priorClose });
console.log(JSON.stringify(reopen, null, 2));

console.log("── detectScoredReopen (isReopen=false self-filter) ──");
const reopenNo = detectScoredReopen({ m5Bars: reopenBars, isReopen: false, entryPrice: 4490, priorClose });
console.log(JSON.stringify(reopenNo));

console.log("── GATE CHECKS ──");
const dtPass =
  dt.detected === true &&
  dt.swingHighPrice === 4510 &&
  dt.swingHighBar === 50 &&
  dt.pullbackDepth === 6 &&
  dt.sessionLevelDistance === 0 &&
  dt.score !== null &&
  Number.isFinite(dt.score) &&
  dt.scoreVerdict !== null &&
  dtBuy.detected === false;
const reopenPass =
  reopen.detected === true &&
  reopen.score === 3 &&
  reopen.scoreVerdict === "ABOVE" &&
  reopen.ema20AboveEma50 === true &&
  reopen.gapDown === true &&
  reopen.priorDayBigMove === true &&
  reopenNo.detected === false;
console.log(`ITEM BA MOCK GATE: ${dtPass && reopenPass ? "PASS" : "FAIL"} (dt=${dtPass}, reopen=${reopenPass})`);
