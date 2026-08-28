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
 */

export interface SideAwareBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const W = 0.8;
const OUTCOME_BARS = 15;

const lb = (bars: SideAwareBar[], t: number): number => {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m].timestamp < t) lo = m + 1; else hi = m; }
  return lo;
};

export interface TouchEvent {
  label: 'REJ_FROM_BELOW' | 'REJ_FROM_ABOVE' | 'BREAK_UP' | 'BREAK_DOWN';
  ts: number;
}

/** Reference classifier over bars STRICTLY BEFORE cutoff. */
export function classifyZone(bars: SideAwareBar[], cutoffMs: number, zPrice: number): { role: 'SUPPORT' | 'RESISTANCE' | 'NEUTRAL'; events: TouchEvent[] } {
  const events: TouchEvent[] = [];
  let i = lb(bars, cutoffMs) - 1;
  if (i < 1) return { role: 'NEUTRAL', events };
  let inside = Math.abs(bars[i].close - zPrice) < W;
  for (; i >= 1; i--) {
    const b = bars[i], prev = bars[i - 1];
    const insideNow = Math.abs(b.close - zPrice) < W || (b.low - W < zPrice && b.high + W > zPrice && Math.min(Math.abs(b.high - zPrice), Math.abs(b.low - zPrice)) < W);
    if (!inside && insideNow) {
      const fromBelow = prev.close < zPrice - W;
      let j = i;
      let outcome: 'REJ_FROM_BELOW' | 'REJ_FROM_ABOVE' | 'BREAK_UP' | 'BREAK_DOWN' | null = null;
      for (let k = 0; k < OUTCOME_BARS && j - k >= 0; k++) {
        const bb = bars[j - k];
        if (bb.close > zPrice + W) { outcome = fromBelow ? 'BREAK_UP' : 'REJ_FROM_ABOVE'; break; }
        if (bb.close < zPrice - W) { outcome = fromBelow ? 'REJ_FROM_BELOW' : 'BREAK_DOWN'; break; }
      }
      events.push({ label: outcome ?? (fromBelow ? 'REJ_FROM_BELOW' : 'REJ_FROM_ABOVE'), ts: b.timestamp });
    }
    inside = insideNow;
  }
  let rejB = 0, rejA = 0;
  const n = events.length;
  for (let idx = 0; idx < n; idx++) {
    const e = events[idx];
    const weight = idx >= n - 5 ? 2 : 1; // last-5-events double weight (list is newest-first)
    if (e.label === 'REJ_FROM_BELOW') rejB += weight;
    else if (e.label === 'REJ_FROM_ABOVE') rejA += weight;
  }
  const role = rejB > rejA ? 'RESISTANCE' : rejA > rejB ? 'SUPPORT' : 'NEUTRAL';
  return { role, events };
}
