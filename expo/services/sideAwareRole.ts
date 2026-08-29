/**
 * ITEM Q — SIDE-AWARE ZONE ROLE CLASSIFIER (emission-time instrument).
 *
 * VERBATIM PORT of the reference classifier in scripts/item235_side_aware.ts
 * (classifyZone) — the exact method pre-registered for the retype: a touch
 * event = price entering [Z-w, Z+w] from outside (w=0.8); approach side from
 * the PRIOR bar's close; outcome = first exit side within 15 bars ->
 * REJ_FROM_BELOW / REJ_FROM_ABOVE / BREAK_UP / BREAK_DOWN. Role = majority of
 * rejections with last-5 events double weight. gold_m1_bars ONLY, strictly
 * before the cutoff (generation-time discipline).
 *
 * The script copy remains the MEASUREMENT reference and is grepped for
 * divergence by review; this service copy exists only because the script
 * imports node:fs (its env loader) and therefore cannot enter the Metro bundle.
 * The port is line-for-line except for the Bar interface name.
 *
 * ── PORTED TO CANONICAL SEMANTICS (services/zoneSemantics.ts) ───────────────
 * The DETECTION RULE and the WEIGHTS are Q's pre-registered instrument and are
 * unchanged on purpose (w=0.8, 15-bar outcome window, last-5 events double
 * weight, newest-first scan). What is no longer re-derived locally: the event
 * side names, and the majority-to-role mapping — both now come from
 * zoneSemantics (`rejectionEvent`, `breakthroughEvent`, `recencyWeightedScore`,
 * `roleFromScore`). Labels are the canonical ApproachEvent strings and the role
 * is the canonical ZoneRole vocabulary.
 *
 * NOTE ON THE RECENCY WINDOW (stated, not silently reconciled): this instrument
 * weights the last 5 events; zoneSemantics.DEFAULT_ZONE_SEMANTICS weights the
 * last 4. That is a genuine parameter difference between two instruments, NOT a
 * semantics difference, so it is passed explicitly below rather than defaulted.
 */

import {
  type ZoneRole,
  type ApproachEvent,
  rejectionEvent,
  breakthroughEvent,
  recencyWeightedScore,
  roleFromScore,
} from './zoneSemantics';

export interface SideAwareBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const W = 0.8;
const OUTCOME_BARS = 15;
/** Q's pre-registered weighting: last 5 events count double. */
const RECENCY_WINDOW = 5;
const RECENCY_WEIGHT = 2;

const lb = (bars: SideAwareBar[], t: number): number => {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; }
  return lo;
};

export interface TouchEvent {
  label: ApproachEvent;
  ts: number;
}

/** Reference classifier over bars STRICTLY BEFORE cutoff. */
export function classifyZone(bars: SideAwareBar[], cutoffMs: number, zPrice: number): { role: ZoneRole; events: TouchEvent[] } {
  const events: TouchEvent[] = [];
  let i = lb(bars, cutoffMs) - 1;
  if (i < 1) return { role: 'UNTYPED', events };
  let inside = Math.abs(bars[i].close - zPrice) < W;
  for (; i >= 1; i--) {
    const b = bars[i], prev = bars[i - 1];
    const insideNow = Math.abs(b.close - zPrice) < W || (b.low - W < zPrice && b.high + W > zPrice && Math.min(Math.abs(b.high - zPrice), Math.abs(b.low - zPrice)) < W);
    if (!inside && insideNow) {
      const cameFrom: 'BELOW' | 'ABOVE' = prev.close < zPrice - W ? 'BELOW' : 'ABOVE';
      let j = i;
      let outcome: ApproachEvent | null = null;
      for (let k = 0; k < OUTCOME_BARS && j - k >= 0; k++) {
        const bb = bars[j - k];
        // Resolved ABOVE the band: a rejection iff price also came from above.
        if (bb.close > zPrice + W) { outcome = cameFrom === 'ABOVE' ? rejectionEvent('ABOVE') : breakthroughEvent('BELOW'); break; }
        // Resolved BELOW the band: a rejection iff price also came from below.
        if (bb.close < zPrice - W) { outcome = cameFrom === 'BELOW' ? rejectionEvent('BELOW') : breakthroughEvent('ABOVE'); break; }
      }
      events.push({ label: outcome ?? rejectionEvent(cameFrom), ts: b.timestamp });
    }
    inside = insideNow;
  }
  // ORDER IS LOAD-BEARING — READ BEFORE CHANGING.
  // `events` is NEWEST-FIRST (the scan walks backwards from the cutoff) and
  // `recencyWeightedScore` double-weights the TAIL of the list it is given.
  // The list is therefore passed AS-IS, which double-weights the tail of a
  // newest-first list = the OLDEST five events.
  //
  // DEFECT ON RECORD (found by scripts/item244_semantics_port_equivalence.ts,
  // 479/18132 grid disagreements): that is NOT what this instrument's own
  // comment claimed — it said "last-5 events double weight", i.e. the most
  // RECENT five. The pre-port code has always weighted the oldest five. The
  // port deliberately REPRODUCES the existing behaviour bit-for-bit rather
  // than quietly correcting it, because Q's retype measurement and its
  // promotion gate were pre-registered against THIS instrument; silently
  // changing the weighting mid-round would redefine every number already
  // recorded (MINDSET 1 + 5). Correcting the direction is a MEASURED change
  // for a future round, not a drive-by fix.
  const asScanned: ApproachEvent[] = events.map((e) => e.label);
  const role = roleFromScore(recencyWeightedScore(asScanned, RECENCY_WINDOW, RECENCY_WEIGHT));
  return { role, events };
}
