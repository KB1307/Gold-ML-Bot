/**
 * ITEM C / CHECKPOINT C — SHADOW-MODE CANDIDATE HARNESS.
 *
 * WHY THIS EXISTS, STATED HONESTLY (carried from the item spec): offline backtests
 * on available data have said everything they can say — two of three holdout
 * survivors sign-flipped out of sample, and a deliberately-bad RSI-fade CONTROL
 * posted the highest raw P&L of any candidate (+107R), which is the tell that raw
 * P&L on that window measures gold's drift, not selection skill. The only remaining
 * honest discriminator is FORWARD sample. This module records what two unproven
 * candidates WOULD have signalled so a forward book can accumulate through the ONE
 * canonical resolution instrument (resolveSignalWithBars fromScratch +
 * lib/evCompute computeRNet). It NEVER touches user emission, Telegram, or the live
 * signal history, and nothing in the emission/gating path imports it this round.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PRE-REGISTERED PROMOTION GATE (verbatim contract — all four conditions).
 * A shadow candidate may be proposed for live emission ONLY when, on FORWARD
 * shadow sample only: n>=100 AND EV_net 95% CI lower bound > 0 AND positive in
 * at least 4 of 6 consecutive calendar weeks AND its EV_net exceeds a
 * same-period random-direction null computed on the same timestamps.
 * All four conditions. No exceptions, no partial promotion, no
 * "directionally encouraging" promotion.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface ShadowBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ShadowCandidateDecision {
  candidate_name: string;
  direction_or_null: 'BUY' | 'SELL' | null;
  entry: number | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  inputs: Record<string, unknown>;
}

/** LDN-FADE window, UTC-only definition (session clock is UTC by data rule). */
const LDN_WINDOW = { startHourUTC: 7, endMinuteOfDay: 12 * 60 };
const MIN_EXTREME_AGE_MINUTES = 30;

const barTs = (b: ShadowBar): number => b.timestamp;

function sessionExtremeBefore(bars: ShadowBar[], idx: number, ageMin: number): number | null {
  const t = barTs(bars[idx]);
  const cutoff = t - ageMin * 60_000;
  // Extreme computed ONLY from bars strictly before the current bar — the look-ahead
  // here would silently manufacture a winner, and did in the item's first offline pass.
  let extreme: number | null = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (barTs(bars[i]) < cutoff) break;
    if (extreme === null) extreme = bars[i].high;
    else extreme = Math.max(extreme, bars[i].high);
  }
  return extreme;
}

/**
 * CANDIDATE 1 "LDN-FADE": during 07:00–11:59 UTC, when price re-tests the running
 * session extreme established at least 30 minutes earlier (computed ONLY from bars
 * strictly before the current bar), and the current bar closes back inside the
 * range → fade signal. SL $5, target $10 (ladder target single level).
 */
export function evaluateLdnFade(bars: ShadowBar[]): ShadowCandidateDecision | null {
  if (bars.length < 40) return null;
  const cur = bars[bars.length - 1];
  const d = new Date(cur.timestamp);
  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (minuteOfDay < LDN_WINDOW.startHourUTC * 60 || minuteOfDay >= LDN_WINDOW.endMinuteOfDay) return null;

  const idxOfCur = bars.length - 1;
  const priorBars = bars.slice(0, idxOfCur);
  const dayStartUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const session = priorBars.filter(b => b.timestamp >= dayStartUtc);
  if (session.length === 0) return null;

  const testExtremeHigh = (ageMin: number): number | null => sessionExtremeBefore(bars, idxOfCur, ageMin);
  void testExtremeHigh; // (kept local; see function below using fixed floor)

  const extremeFloor = cur.timestamp - MIN_EXTREME_AGE_MINUTES * 60_000;
  let runningMax: number | null = null;
  for (const b of session) {
    if (b.timestamp < extremeFloor) continue;
    runningMax = runningMax === null ? b.high : Math.max(runningMax, b.high);
  }
  if (runningMax === null) return null;
  // Re-test: current bar's high touches the standing extreme...
  if (cur.high < runningMax) return null;
  // ...and closes back INSIDE the range (no breakout continuation printed).
  if (cur.close >= runningMax) return null;

  return {
    candidate_name: 'LDN-FADE',
    direction_or_null: 'SELL',
    entry: cur.close,
    sl: cur.close + 5,
    tp1: cur.close - 10,
    tp2: cur.close - 10,
    tp3: cur.close - 10,
    inputs: { session_high_at_retest: runningMax, bars_in_session: session.length },
  };
}

/**
 * CANDIDATE 2 "TREND-CONTINUATION": trend day defined EXPLICITLY as — between
 * 00:00Z and the evaluation bar, |open-of-day − current price| >= 25 USD AND the
 * most recent 4-hour M1 slope carries the same sign as the day move. Signals WITH
 * the established move on a pullback to the 8-bar mean (close re-touching mean from
 * the trend side). SL $7, target $10.
 */
export function evaluateTrendContinuation(bars: ShadowBar[]): ShadowCandidateDecision | null {
  if (bars.length < 60) return null;
  const cur = bars[bars.length - 1];
  const d = new Date(cur.timestamp);
  const dayStartUtcMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const today = bars.filter(b => b.timestamp >= dayStartUtcMs);
  if (today.length < 60) return null;
  const dayMove = cur.close - today[0].open;
  if (Math.abs(dayMove) < 25) return null;

  const fourH = bars.slice(-240);
  const half = Math.floor(fourH.length / 2);
  const slopeSign =
    (fourH[fourH.length - 1].close - fourH[half].close) * Math.sign(dayMove) > 0 ? 1 : -1;
  if (slopeSign < 0) return null;

  const pullbackMean =
    bars.slice(-9, -1).reduce((s, b) => s + b.close, 0) / 8;
  const dir: 'BUY' | 'SELL' = dayMove > 0 ? 'BUY' : 'SELL';
  const pullsBackToMean = dir === 'BUY'
    ? cur.close <= pullbackMean && cur.low <= pullbackMean
    : cur.close >= pullbackMean && cur.high >= pullbackMean;
  if (!pullsBackToMean) return null;

  return {
    candidate_name: 'TREND-CONTINUATION',
    direction_or_null: dir,
    entry: cur.close,
    sl: dir === 'BUY' ? cur.close - 7 : cur.close + 7,
    tp1: dir === 'BUY' ? cur.close + 10 : cur.close - 10,
    tp2: dir === 'BUY' ? cur.close + 10 : cur.close - 10,
    tp3: dir === 'BUY' ? cur.close + 10 : cur.close - 10,
    inputs: {
      day_open: today[0].open,
      day_move_usd: Math.round(dayMove * 100) / 100,
      eight_bar_mean: Math.round(pullbackMean * 100) / 100,
    },
  };
}

/** Evaluate BOTH candidates over one M1 snapshot. Pure — persistence belongs to the caller. */
export function evaluateShadowCandidates(bars: ShadowBar[]): ShadowCandidateDecision[] {
  const out: ShadowCandidateDecision[] = [];
  const a = evaluateLdnFade(bars);
  if (a) out.push(a);
  const b = evaluateTrendContinuation(bars);
  if (b) out.push(b);
  return out;
}
