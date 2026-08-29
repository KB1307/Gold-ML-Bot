/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CANONICAL ZONE SEMANTICS — the single source of truth for what a level IS,
 * what it has DONE, and whether it helps or hinders a given trade.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 * The words "support" and "resistance" have caused four separate defects in
 * this project because they conflate THREE INDEPENDENT concepts:
 *
 *   1. GEOMETRIC   — is the level above or below spot right now?
 *                    (signalEngine.ts:4560 `isResistance = cluster.price >
 *                    currentPrice` types purely on this, which is why a band
 *                    that had rejected price from below all day was labelled
 *                    SUPPORT the moment spot ticked above it — the 27-Aug
 *                    02:15Z failure.)
 *   2. BEHAVIOURAL — which side has price actually been rejected from?
 *                    (An M15-layer implementation labelled "local low then
 *                    bounce up" as a rejection-from-BELOW — inverted — and the
 *                    error was invisible because the code ran fine.)
 *   3. TRADE-RELATIVE — does this level block THIS trade's path, or sit
 *                    behind it? (Re-derived by hand in every script; one sign
 *                    error inverts a whole veto.)
 *
 * THE RULE: these three words are BANNED in new zone code —
 *   "support", "resistance", "isResistance"
 * Use the vocabulary below instead. Each term answers exactly one question and
 * cannot be silently confused with the others.
 *
 * PORTING CONTRACT
 * Any reimplementation (TS, Python, SQL, a measurement script) MUST reproduce
 * zone_semantics_golden.json EXACTLY — all 3 behavioural cases and all 5
 * trade-relative cases. The `role_flip_recency` case is the decisive one: raw
 * counts tie 2-2 and only correct side-semantics plus recency weighting yield
 * CEILING_BEHAVING. A port that fails it has the classic inversion.
 * Run the golden check BEFORE reporting any number derived from zone roles.
 */

// ── 1. GEOMETRIC (position only — carries NO behavioural meaning) ────────────
export type ZonePosition = 'ABOVE_SPOT' | 'BELOW_SPOT' | 'AT_SPOT';

export function zonePosition(zoneMid: number, spot: number, tol = 0.5): ZonePosition {
  if (Math.abs(zoneMid - spot) <= tol) return 'AT_SPOT';
  return zoneMid > spot ? 'ABOVE_SPOT' : 'BELOW_SPOT';
}

// ── 2. BEHAVIOURAL (what the level has DONE — the only true "type") ──────────
/**
 * CEILING_BEHAVING: price approached from BELOW and was rejected back DOWN.
 *                   (Historically caps rallies. Blocks BUYS.)
 * FLOOR_BEHAVING:   price approached from ABOVE and was rejected back UP.
 *                   (Historically catches selloffs. Blocks SELLS.)
 * UNTYPED:          no majority, or no qualifying events. NEVER treated as
 *                   opposing — absence of a role is not a role.
 *
 * MNEMONIC that prevents the inversion: name the event by WHERE PRICE CAME
 * FROM, never by where the bar's extreme is. "Local low + bounce up" is price
 * arriving FROM ABOVE and being rejected upward = FLOOR_BEHAVING.
 */
export type ZoneRole = 'CEILING_BEHAVING' | 'FLOOR_BEHAVING' | 'UNTYPED';

export type ApproachEvent =
  | 'REJECTED_APPROACH_FROM_BELOW'   // came from below, returned below  -> ceiling evidence
  | 'REJECTED_APPROACH_FROM_ABOVE'   // came from above, returned above  -> floor evidence
  | 'BROKE_THROUGH_FROM_BELOW'       // came from below, closed above    -> no role evidence
  | 'BROKE_THROUGH_FROM_ABOVE';      // came from above, closed below    -> no role evidence

export interface Bar { ts: number; o: number; h: number; l: number; c: number }

export interface ZoneSemanticsParams {
  /** Half-width of the zone band in $. Default 0.8. */
  bandHalfWidth: number;
  /** Bars allowed for an approach to resolve. Default 15. */
  confirmBars: number;
  /** How many trailing events get extra weight. Default 4. */
  recencyWindow: number;
  /** Weight multiplier for events inside the recency window. Default 2. */
  recencyWeight: number;
}

export const DEFAULT_ZONE_SEMANTICS: ZoneSemanticsParams = {
  bandHalfWidth: 0.8,
  confirmBars: 15,
  recencyWindow: 4,
  recencyWeight: 2,
};

export interface ApproachRecord { event: ApproachEvent; barIndex: number; ts: number }

// ── SHARED DERIVATION PRIMITIVES ────────────────────────────────────────────
// Every instrument (M15 layer, side-aware classifier, measurement scripts) MUST
// obtain its role and its direction mapping from these functions. A local
// `rb > ra ? 'RESISTANCE' : ...` or a hand-written BUY/SELL mapping is exactly
// the re-derivation that produced the historical inversions, so those forms are
// banned in favour of the helpers below. Detection RULES may differ per
// instrument (they are pre-registered measurement choices); SIDE SEMANTICS and
// DIRECTION MAPPING may not.

/** Sign convention, single source: >0 CEILING, <0 FLOOR, 0 UNTYPED. */
export function roleFromScore(score: number): ZoneRole {
  return score > 0 ? 'CEILING_BEHAVING' : score < 0 ? 'FLOOR_BEHAVING' : 'UNTYPED';
}

/**
 * Role from plain (unweighted) rejection counts. `rejectedFromBelow` is
 * CEILING evidence and `rejectedFromAbove` is FLOOR evidence — the mapping the
 * M15 layer previously had inverted.
 */
export function roleFromRejectionCounts(rejectedFromBelow: number, rejectedFromAbove: number): ZoneRole {
  return roleFromScore(rejectedFromBelow - rejectedFromAbove);
}

/**
 * Recency-weighted role score over an OLDEST-FIRST event list — the exact
 * scoring `buildZoneRole` uses, exposed so a classifier with its own detection
 * rules still shares the side semantics and the weighting shape.
 */
export function recencyWeightedScore(
  events: readonly ApproachEvent[],
  recencyWindow: number,
  recencyWeight: number,
): number {
  const rb = events.filter((e) => e === 'REJECTED_APPROACH_FROM_BELOW').length;
  const ra = events.filter((e) => e === 'REJECTED_APPROACH_FROM_ABOVE').length;
  const recent = events.slice(-recencyWindow);
  const rbR = recent.filter((e) => e === 'REJECTED_APPROACH_FROM_BELOW').length;
  const raR = recent.filter((e) => e === 'REJECTED_APPROACH_FROM_ABOVE').length;
  return (rb + rbR * (recencyWeight - 1)) - (ra + raR * (recencyWeight - 1));
}

/**
 * Name a rejection event by WHERE PRICE CAME FROM — the mnemonic that prevents
 * the inversion. 'BELOW' => ceiling evidence, 'ABOVE' => floor evidence.
 */
export function rejectionEvent(cameFrom: 'BELOW' | 'ABOVE'): ApproachEvent {
  return cameFrom === 'BELOW' ? 'REJECTED_APPROACH_FROM_BELOW' : 'REJECTED_APPROACH_FROM_ABOVE';
}

/** Name a breakthrough event by where price came from. Carries no role evidence. */
export function breakthroughEvent(cameFrom: 'BELOW' | 'ABOVE'): ApproachEvent {
  return cameFrom === 'BELOW' ? 'BROKE_THROUGH_FROM_BELOW' : 'BROKE_THROUGH_FROM_ABOVE';
}

/**
 * LEGACY BRIDGE — translate a STORED zone type written by older engine code
 * ('RESISTANCE' / 'SUPPORT', and the M15 layer's pre-port 'NEUTRAL') into the
 * canonical vocabulary. Reading historical rows is the ONLY legitimate use;
 * never write these strings again. Unknown/absent => UNTYPED (never opposing).
 */
export function roleFromLegacyType(legacyType: string | null | undefined): ZoneRole {
  if (legacyType === 'RESISTANCE') return 'CEILING_BEHAVING';
  if (legacyType === 'SUPPORT') return 'FLOOR_BEHAVING';
  return 'UNTYPED';
}

/** Which role BLOCKS a direction. The ONLY definition of this mapping. */
export function blockingRoleFor(direction: 'BUY' | 'SELL'): ZoneRole {
  return direction === 'BUY' ? 'CEILING_BEHAVING' : 'FLOOR_BEHAVING';
}

/** Which role AGREES with a direction. The ONLY definition of this mapping. */
export function agreeingRoleFor(direction: 'BUY' | 'SELL'): ZoneRole {
  return direction === 'BUY' ? 'FLOOR_BEHAVING' : 'CEILING_BEHAVING';
}

/**
 * Detect approach events at `level` from `bars`.
 *
 * DEFINITIONS (fixed; do not vary them without re-deriving every dependent
 * number, because changing them changes what every stored role MEANS):
 *   APPROACH      — the bar's range first enters [level-w, level+w] after being
 *                   outside it on the previous bar.
 *   APPROACH SIDE — determined by the PREVIOUS BAR'S CLOSE relative to the
 *                   band (strictly outside). Ambiguous (previous close inside
 *                   the band) => the approach is DISCARDED, not guessed.
 *   RESOLUTION    — the first side on which a subsequent bar CLOSES strictly
 *                   outside the band, within `confirmBars`. No resolution =>
 *                   discarded (an unresolved approach is not evidence).
 *   REJECTION     — resolution side EQUALS approach side.
 *
 * LOOK-AHEAD: an event is only usable `confirmBars` after `barIndex`. Callers
 * building a map "as of time T" MUST pass only bars strictly before T, and
 * MUST discard events whose confirmation window extends beyond T. See
 * `usableFrom` on the return of `buildZoneRole`.
 */
export function detectApproaches(bars: Bar[], level: number, p: ZoneSemanticsParams = DEFAULT_ZONE_SEMANTICS): ApproachRecord[] {
  const w = p.bandHalfWidth;
  const out: ApproachRecord[] = [];
  let inside = false;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    const now = b.l <= level + w && b.h >= level - w;
    if (now && !inside) {
      let came: 'BELOW' | 'ABOVE' | null = null;
      if (prev.c < level - w) came = 'BELOW';
      else if (prev.c > level + w) came = 'ABOVE';
      if (came) {
        let res: 'BELOW' | 'ABOVE' | null = null;
        const end = Math.min(i + 1 + p.confirmBars, bars.length);
        for (let k = i + 1; k < end; k++) {
          if (bars[k].c < level - w) { res = 'BELOW'; break; }
          if (bars[k].c > level + w) { res = 'ABOVE'; break; }
        }
        if (res) {
          const event: ApproachEvent = res === came ? rejectionEvent(came) : breakthroughEvent(came);
          out.push({ event, barIndex: i, ts: b.ts });
        }
      }
    }
    inside = now;
  }
  return out;
}

export interface ZoneRoleResult {
  role: ZoneRole;
  rejectedFromBelow: number;
  rejectedFromAbove: number;
  brokeThrough: number;
  /** Recency-weighted score: >0 CEILING, <0 FLOOR, 0 UNTYPED. */
  score: number;
  /** MARGIN = |score|. Report it with every role. A role with margin 1 is a
   *  coin flip and must be reported as such, never as a finding. */
  margin: number;
  events: ApproachEvent[];
  /** Earliest time this role is usable without look-ahead. */
  usableFrom: number | null;
}

/**
 * Role = majority of REJECTION evidence, with the last `recencyWindow` events
 * counted `recencyWeight` times. Breakthroughs carry no role evidence but ARE
 * counted and reported (a level with many breakthroughs is weak regardless of
 * role). Ties => UNTYPED.
 */
export function buildZoneRole(bars: Bar[], level: number, p: ZoneSemanticsParams = DEFAULT_ZONE_SEMANTICS): ZoneRoleResult {
  const recs = detectApproaches(bars, level, p);
  const events = recs.map(r => r.event);
  const rb = events.filter(e => e === 'REJECTED_APPROACH_FROM_BELOW').length;
  const ra = events.filter(e => e === 'REJECTED_APPROACH_FROM_ABOVE').length;
  const bt = events.filter(e => e.startsWith('BROKE_THROUGH')).length;
  const score = recencyWeightedScore(events, p.recencyWindow, p.recencyWeight);
  const role: ZoneRole = roleFromScore(score);
  const last = recs.length ? recs[recs.length - 1] : null;
  return {
    role,
    rejectedFromBelow: rb,
    rejectedFromAbove: ra,
    brokeThrough: bt,
    score,
    margin: Math.abs(score),
    events,
    usableFrom: last ? last.ts : null,
  };
}

// ── 3. TRADE-RELATIVE (does it block THIS trade?) ────────────────────────────
/**
 * OPPOSED : the zone lies in the trade's PATH TO TARGET and its role is the one
 *           that historically stops that direction. This is the ONLY relation
 *           that may drive a veto.
 * ALIGNED : the zone's role agrees with the trade and it sits BEHIND the entry.
 *           AWARENESS ONLY. Measured repeatedly at or below zero predictive
 *           value — it must NEVER be added to confidence or buy-side score.
 * NEUTRAL : no qualifying zone, or the zone is UNTYPED. Never opposing.
 */
export type ZoneRelation = 'OPPOSED' | 'ALIGNED' | 'NEUTRAL';

export interface ZoneInterval { lo: number; hi: number; role: ZoneRole }

/**
 * Path geometry is expressed with an explicit sign so the SELL case cannot be
 * derived by hand (that hand-derivation is where sign errors enter):
 *   dir = +1 for BUY, -1 for SELL.
 *   The path to TP1 is the interval between entry and tp1, extended $1 behind
 *   entry (matching the shipped band-veto rule).
 * A zone OPPOSES when it overlaps that interval AND its role blocks `dir`:
 *   BUY  is blocked by CEILING_BEHAVING;  SELL is blocked by FLOOR_BEHAVING.
 */
export function zoneRelation(direction: 'BUY' | 'SELL', entry: number, tp1: number, zone: ZoneInterval, behindBuffer = 1.0): ZoneRelation {
  if (zone.role === 'UNTYPED') return 'NEUTRAL';
  const dir = direction === 'BUY' ? 1 : -1;
  const tp1Dist = Math.abs(tp1 - entry);
  const pathLo = dir === 1 ? entry - behindBuffer : entry - tp1Dist;
  const pathHi = dir === 1 ? entry + tp1Dist : entry + behindBuffer;
  const overlapsPath = zone.lo <= pathHi && zone.hi >= pathLo;
  if (overlapsPath && zone.role === blockingRoleFor(direction)) return 'OPPOSED';
  const behindEntry = dir === 1 ? zone.hi < entry : zone.lo > entry;
  if (behindEntry && zone.role === agreeingRoleFor(direction)) return 'ALIGNED';
  return 'NEUTRAL';
}

/**
 * SELF-CHECK — run this before trusting any zone-derived number.
 * Returns [] when the implementation matches the golden fixtures.
 * Wire it into the CI guard so a future inversion fails the run rather than
 * silently producing backwards labels.
 */
export function verifyAgainstGolden(golden: {
  params: ZoneSemanticsParams;
  cases: { name: string; level: number; bars: Bar[]; expectedEvents: string[]; expectedCounts: { rejectedFromBelow: number; rejectedFromAbove: number; brokeThrough: number }; expectedRole: string }[];
  tradeRelativeCases: { name: string; direction: 'BUY' | 'SELL'; entry: number; tp1: number; zone: ZoneInterval; expected: string }[];
}): string[] {
  const failures: string[] = [];
  for (const c of golden.cases) {
    const r = buildZoneRole(c.bars, c.level, golden.params);
    if (r.role !== c.expectedRole) failures.push(`${c.name}: role ${r.role} != expected ${c.expectedRole}`);
    if (r.events.join(',') !== c.expectedEvents.join(',')) failures.push(`${c.name}: events [${r.events.join(',')}] != expected [${c.expectedEvents.join(',')}]`);
    if (r.rejectedFromBelow !== c.expectedCounts.rejectedFromBelow || r.rejectedFromAbove !== c.expectedCounts.rejectedFromAbove || r.brokeThrough !== c.expectedCounts.brokeThrough) {
      failures.push(`${c.name}: counts b=${r.rejectedFromBelow}/a=${r.rejectedFromAbove}/bt=${r.brokeThrough} != expected`);
    }
  }
  for (const t of golden.tradeRelativeCases) {
    const got = zoneRelation(t.direction, t.entry, t.tp1, t.zone);
    if (got !== t.expected) failures.push(`${t.name}: relation ${got} != expected ${t.expected}`);
  }
  return failures;
}
