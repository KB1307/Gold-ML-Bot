/**
 * ITEM V — M15 STRUCTURAL ZONE LAYER (user-designed, offline-validated).
 *
 * Zone-identification method, exactly as specified by the user:
 *   - M15 timeframe, ~14 trading days of memory,
 *   - zones formed by STRONG-REJECTION events: a touch followed by a move
 *     away >= 2.0 x ATR(14, M15) within 4 bars,
 *   - clustered into $2 bands, kept at >= 2 rejections,
 *   - SIDE-TYPED AT BIRTH: role = majority of rejection sides — more
 *     rejections-from-below = RESISTANCE-behaving; more from-above =
 *     SUPPORT-behaving.
 *
 * PRE-STATED implementation choices (this file is the canonical instrument;
 * the provisional offline Python port used first-guess thresholds and its
 * margins are not bit-comparable):
 *   - Touch (rejection-FROM-BELOW, RESISTANCE-making): M15 bar i makes a
 *     2-bar local HIGH (high[i] >= max(high[i-1], high[i-2])); price rallied
 *     INTO the level from below and is rejected — move-away =
 *     high[i] - min(low[i+1..i+4]); strong iff >= 2.0 * ATR(14)[i].
 *     Mirrored for rejection-FROM-ABOVE (SUPPORT-making): 2-bar local low,
 *     move-away = max(high[i+1..i+4]) - low[i]. (v2 of this file had the
 *     sides inverted — caught by the V.3 acceptance run; fixed before any
 *     number was recorded.)
 *   - An event is USABLE only from the close of its 4-bar confirmation
 *     window (usableTs = open(i+4) + 15m) — look-ahead-safe by construction.
 *   - ATR(14, M15) = simple mean of the last 14 true ranges (incl. gaps).
 *   - $2 bands: events sorted by price; an event joins the current band
 *     while it sits within $2 of the band's lowest member; else new band.
 *   - A UTC date counts as a trading day if it has >= 48 M1 bars (gold is
 *     closed ~Fri 22:00Z -> Sun 23:00Z, so partial Sun/Fri sessions count).
 *   - Role ties (rb === ra) are UNTYPED and can neither oppose nor endorse.
 *
 * Data-source rule: input is gold_m1_bars ONLY (never priceHistory / Yahoo /
 * TwelveData). Zero live impact: this layer is annotation-only; it is read by
 * NOTHING in emission, gating or scoring (grep-verifiable).
 *
 * ── PORTED TO CANONICAL SEMANTICS (services/zoneSemantics.ts) ───────────────
 * This file no longer decides what a side MEANS or which role blocks which
 * direction. Its DETECTION RULE (2-bar local extreme + 2.0*ATR(14,M15)
 * move-away within 4 bars, $2 bands, >=2 events) is unchanged and remains its
 * own pre-registered measurement choice; but:
 *   - event sides are named with `rejectionEvent()` (named by WHERE PRICE CAME
 *     FROM — the mnemonic that prevents the historical inversion),
 *   - the role is derived by `roleFromRejectionCounts()`,
 *   - opposition/endorsement are decided by `zoneRelation()`.
 * Role vocabulary is now CEILING_BEHAVING / FLOOR_BEHAVING / UNTYPED. The
 * banned words (support/resistance/isResistance) do not appear in zone logic
 * below. Annotation payloads therefore carry the canonical role strings.
 */

import {
  type ZoneRole,
  type ApproachEvent,
  type ZoneInterval,
  rejectionEvent,
  roleFromRejectionCounts,
  zoneRelation,
} from './zoneSemantics';

export interface M1Bar { ts: number; o: number; h: number; l: number; c: number }
export interface M15Bar { ts: number; o: number; h: number; l: number; c: number }
/** `event` is the canonical side name; `side` is kept as the raw came-from tag. */
export interface RejectionEvent { price: number; side: 'BELOW' | 'ABOVE'; event: ApproachEvent; ts: number; usableTs: number }
export interface M15Zone {
  lo: number; hi: number; mid: number;
  n: number;
  /** rb = rejections of an approach FROM BELOW (ceiling evidence). */
  rb: number;
  /** ra = rejections of an approach FROM ABOVE (floor evidence). */
  ra: number;
  role: ZoneRole;
  lastUsableTs: number;
}

export const M15_MS = 900_000;
export const MEMORY_TRADING_DAYS = 14;
export const MIN_M1_BARS_PER_DAY = 48;
export const BAND_WIDTH = 2.0;
export const MIN_EVENTS = 2;
export const MOVE_AWAY_ATR = 2.0;
export const CONFIRM_BARS = 4;
export const MIN_BUCKET_BARS = 10;
const ATR_LEN = 14;
export const ENDORSE_DISTANCE = 3.0;

/** Aggregate M1 bars into complete M15 buckets; partial buckets (< MIN_BUCKET_BARS bars) are dropped. */
export function resampleM15(bars: M1Bar[]): M15Bar[] {
  const out: M15Bar[] = [];
  let key = -1, o = 0, h = -Infinity, l = Infinity, c = 0, cnt = 0;
  const flush = (): void => { if (key >= 0 && cnt >= MIN_BUCKET_BARS) out.push({ ts: key, o, h, l, c }); };
  for (const b of bars) {
    const k = Math.floor(b.ts / M15_MS) * M15_MS;
    if (k !== key) { flush(); key = k; o = b.o; h = b.h; l = b.l; c = b.c; cnt = 1; }
    else { h = Math.max(h, b.h); l = Math.min(l, b.l); c = b.c; cnt += 1; }
  }
  flush();
  return out;
}

/** Retain only the bars belonging to the last `days` trading days (UTC dates with >= MIN_M1_BARS_PER_DAY bars) at or before asOfMs. */
export function lastTradingDays(bars: M1Bar[], asOfMs: number, days: number = MEMORY_TRADING_DAYS): { bars: M1Bar[]; tradingDays: number } {
  const perDay = new Map<string, number>();
  const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
  for (const b of bars) { if (b.ts >= asOfMs) continue; const k = dayKey(b.ts); perDay.set(k, (perDay.get(k) ?? 0) + 1); }
  const daysWithBars = [...perDay.entries()].filter(([, c]) => c >= MIN_M1_BARS_PER_DAY).map(([d]) => d).sort();
  const keep = new Set(daysWithBars.slice(Math.max(0, daysWithBars.length - days)));
  return { bars: bars.filter(b => b.ts < asOfMs && keep.has(dayKey(b.ts))), tradingDays: keep.size };
}

/** Detect strong-rejection events. Look-ahead-safe: an event's usableTs is the close of its 4-bar confirmation window. */
export function detectRejectionEvents(m15: M15Bar[]): RejectionEvent[] {
  const n = m15.length;
  const tr: number[] = [];
  for (let i = 0; i < n; i++) {
    const pc = i > 0 ? m15[i - 1].c : m15[i].o;
    tr.push(Math.max(m15[i].h - m15[i].l, Math.abs(m15[i].h - pc), Math.abs(m15[i].l - pc)));
  }
  const atr = (i: number): number => {
    if (i < ATR_LEN - 1) return NaN;
    let s = 0; for (let j = i - ATR_LEN + 1; j <= i; j++) s += tr[j];
    return s / ATR_LEN;
  };
  const events: RejectionEvent[] = [];
  for (let i = ATR_LEN; i < n - CONFIRM_BARS; i++) {
    const a = atr(i);
    if (!Number.isFinite(a) || a <= 0) continue;
    let awayUp = -Infinity, awayDn = Infinity;
    for (let j = i + 1; j <= i + CONFIRM_BARS; j++) { awayUp = Math.max(awayUp, m15[j].h); awayDn = Math.min(awayDn, m15[j].l); }
    const usableTs = m15[i + CONFIRM_BARS].ts + M15_MS;
    // Price rallied INTO the level FROM BELOW and was rejected back down:
    // local HIGH, then a strong move DOWN away. => ceiling evidence.
    if (m15[i].h >= Math.max(m15[i - 1].h, m15[i - 2].h) && m15[i].h - awayDn >= MOVE_AWAY_ATR * a) {
      events.push({ price: m15[i].h, side: 'BELOW', event: rejectionEvent('BELOW'), ts: m15[i].ts, usableTs });
    }
    // Price fell INTO the level FROM ABOVE and was rejected back up:
    // local LOW, then a strong move UP away. => floor evidence.
    if (m15[i].l <= Math.min(m15[i - 1].l, m15[i - 2].l) && awayUp - m15[i].l >= MOVE_AWAY_ATR * a) {
      events.push({ price: m15[i].l, side: 'ABOVE', event: rejectionEvent('ABOVE'), ts: m15[i].ts, usableTs });
    }
  }
  return events;
}

/** Cluster events into $2 bands anchored at each band's lowest member; keep bands with >= MIN_EVENTS rejections; side-type at birth. */
export function clusterZones(events: RejectionEvent[]): M15Zone[] {
  const sorted = [...events].sort((a, b) => a.price - b.price);
  const bands: RejectionEvent[][] = [];
  let cur: RejectionEvent[] = [];
  for (const e of sorted) {
    if (cur.length === 0 || e.price - cur[0].price <= BAND_WIDTH) cur.push(e);
    else { bands.push(cur); cur = [e]; }
  }
  if (cur.length > 0) bands.push(cur);
  const zones: M15Zone[] = [];
  for (const b of bands) {
    if (b.length < MIN_EVENTS) continue;
    const rb = b.filter(e => e.event === 'REJECTED_APPROACH_FROM_BELOW').length;
    const ra = b.filter(e => e.event === 'REJECTED_APPROACH_FROM_ABOVE').length;
    zones.push({
      lo: b[0].price, hi: b[b.length - 1].price, mid: (b[0].price + b[b.length - 1].price) / 2,
      n: b.length, rb, ra,
      role: roleFromRejectionCounts(rb, ra),
      lastUsableTs: Math.max(...b.map(e => e.usableTs)),
    });
  }
  return zones;
}

/**
 * Build the M15 zone map as of asOfMs. Returns null when there is no bar
 * data at all; callers must treat tradingDays < MEMORY_TRADING_DAYS as
 * INSUFFICIENT BARS (annotate NULL, never a default).
 */
export function buildM15Zones(bars: M1Bar[], asOfMs: number): { zones: M15Zone[]; tradingDays: number } | null {
  const window = lastTradingDays(bars, asOfMs);
  if (window.bars.length === 0) return null;
  const m15 = resampleM15(window.bars);
  const usable = detectRejectionEvents(m15).filter(e => e.usableTs <= asOfMs);
  return { zones: clusterZones(usable), tradingDays: window.tradingDays };
}

const asInterval = (z: M15Zone): ZoneInterval => ({ lo: z.lo, hi: z.hi, role: z.role });

/**
 * M15 path opposition — the path geometry and the blocking-role mapping are
 * BOTH delegated to `zoneRelation()`, which is the same geometry the band veto
 * uses (BUY path [entry-1.0, entry+|tp1-entry|], mirrored for SELL). No sign
 * or role mapping is re-derived here.
 */
export function m15OpposedHit(zones: M15Zone[], dir: 'BUY' | 'SELL', entry: number, tp1: number): M15Zone | null {
  return zones.find(z => zoneRelation(dir, entry, tp1, asInterval(z)) === 'OPPOSED') ?? null;
}

/**
 * M15 endorsement: an ALIGNED-relation zone within $3 of the entry (interval
 * distance). The agreeing-role mapping comes from `zoneRelation()`; only the
 * proximity constraint is this layer's own.
 */
export function m15EndorsedHit(zones: M15Zone[], dir: 'BUY' | 'SELL', entry: number, tp1: number): M15Zone | null {
  const dist = (z: M15Zone): number => Math.max(z.lo - entry, 0, entry - z.hi);
  return zones.find(z => zoneRelation(dir, entry, tp1, asInterval(z)) === 'ALIGNED' && dist(z) <= ENDORSE_DISTANCE) ?? null;
}
