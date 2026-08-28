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
 *   - Role ties (rb === ra) are NEUTRAL and can neither oppose nor endorse.
 *
 * Data-source rule: input is gold_m1_bars ONLY (never priceHistory / Yahoo /
 * TwelveData). Zero live impact: this layer is annotation-only; it is read by
 * NOTHING in emission, gating or scoring (grep-verifiable).
 */

export interface M1Bar { ts: number; o: number; h: number; l: number; c: number }
export interface M15Bar { ts: number; o: number; h: number; l: number; c: number }
export interface RejectionEvent { price: number; side: 'below' | 'above'; ts: number; usableTs: number }
export interface M15Zone {
  lo: number; hi: number; mid: number;
  n: number; rb: number; ra: number;
  role: 'RESISTANCE' | 'SUPPORT' | 'NEUTRAL';
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
    // Rejection-FROM-BELOW (RESISTANCE-making): local HIGH, then a strong move DOWN away.
    if (m15[i].h >= Math.max(m15[i - 1].h, m15[i - 2].h) && m15[i].h - awayDn >= MOVE_AWAY_ATR * a) {
      events.push({ price: m15[i].h, side: 'below', ts: m15[i].ts, usableTs });
    }
    // Rejection-FROM-ABOVE (SUPPORT-making): local LOW, then a strong move UP away.
    if (m15[i].l <= Math.min(m15[i - 1].l, m15[i - 2].l) && awayUp - m15[i].l >= MOVE_AWAY_ATR * a) {
      events.push({ price: m15[i].l, side: 'above', ts: m15[i].ts, usableTs });
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
    const rb = b.filter(e => e.side === 'below').length;
    const ra = b.filter(e => e.side === 'above').length;
    zones.push({
      lo: b[0].price, hi: b[b.length - 1].price, mid: (b[0].price + b[b.length - 1].price) / 2,
      n: b.length, rb, ra,
      role: rb > ra ? 'RESISTANCE' : ra > rb ? 'SUPPORT' : 'NEUTRAL',
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

/**
 * M15 path opposition — SAME path geometry as the band veto:
 * BUY band [entry-1.0, entry+|tp1-entry|], mirrored SELL; an
 * opposing-role (RESISTANCE for BUY) zone overlapping the band opposes.
 */
export function m15OpposedHit(zones: M15Zone[], dir: 'BUY' | 'SELL', entry: number, tp1: number): M15Zone | null {
  const tp1d = Math.abs(tp1 - entry);
  const blo = dir === 'BUY' ? entry - 1.0 : entry - tp1d;
  const bhi = dir === 'BUY' ? entry + tp1d : entry + 1.0;
  const want = dir === 'BUY' ? 'RESISTANCE' : 'SUPPORT';
  return zones.find(z => z.role === want && z.lo <= bhi && z.hi >= blo) ?? null;
}

/** M15 endorsement: an agreeing-role zone within $3 of the entry (interval distance). */
export function m15EndorsedHit(zones: M15Zone[], dir: 'BUY' | 'SELL', entry: number): M15Zone | null {
  const want = dir === 'BUY' ? 'SUPPORT' : 'RESISTANCE';
  const dist = (z: M15Zone): number => Math.max(z.lo - entry, 0, entry - z.hi);
  return zones.find(z => z.role === want && dist(z) <= ENDORSE_DISTANCE) ?? null;
}
