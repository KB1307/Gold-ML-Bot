/**
 * ITEM P — BAND-PROXIMITY VETO, CONDITIONAL MODE. SHIPPED 2026-08-28.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SHIP RECORD (pre-registered P.1 gate cascade, evaluated on the canonical
 * era-clean re-derivation, scripts/item241_fingerprint_conditional.ts, real
 * resolver resolveSignalWithBars fromScratch, n=223 snapshot-bearing decided):
 *   GATE-1 PASS: conditional-veto cohort (band rule fires AND fingerprint NOT
 *     active) EV_net = -0.2008R < -0.10R  (n=79, boot 95% CI [-0.3997, 0.0088]).
 *   GATE-2 PASS: fingerprint-AND-vetoable subset EV_net = +0.1924R > 0
 *     (n=4, 3W/1L).
 *   BOTH PASS -> the CONDITIONAL veto ships (branch A). This is a ship decision
 *   made by the pre-registered cascade, NOT a claim that the removed cohort's
 *   EV is significantly negative (its CI still grazes zero).
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * P.3 ABORT GATE (verbatim contract): suppressed signals resolve through the
 * canonical path (ONE instrument — resolveSignalWithBars fromScratch +
 * lib/evCompute computeRNet). At every forward n=30 decided suppressed
 * signals: if their EV_net > 0, set the flag false next round and report;
 * else the veto stands. No other condition modifies the flag.
 *
 * ONE INFORMATION SET: the veto reads ONLY emission-time values from the same
 * inputs the annotation columns are computed from — the signal's OWN
 * sr_zones_snapshot (generation-time zone set), features.rsi (persisted to the
 * rsi column), and the gold_m1_bars A.2 prior-4h move (identical method to the
 * agrees_with_prior_4h_move annotation). priceHistory / Yahoo / TwelveData are
 * NEVER read here (DATA-SOURCE RULE).
 *
 * FINGERPRINT SEMANTIC: the fingerprint is ACTIVE only when all three inputs
 * affirmatively hold (agreement AND stretched-against RSI AND
 * opposing_zone_fraction <= 0.10). A NULL input (bars insufficient, rsi absent)
 * is NOT a default-to-exempt: the candidate is then vetoable, and the NULL is
 * recorded in the shadow row.
 *
 * SUPPRESSED CANDIDATES: never emitted, never Telegram'd, never in live
 * history. They are written to shadow_candidates_v1
 * (candidate_name='BAND_VETO_SUPPRESSED', full geometry + qualifying zone +
 * fingerprint state in inputs jsonb) and accrue the forward book for the abort
 * gate. The write is fire-and-forget: it can never block or alter generation.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** P.3 abort-gate switch: the ONLY condition that may set this false is the
 *  pre-registered abort gate (EV_net > 0 at forward n=30 decided suppressed). */
export const BAND_PROXIMITY_VETO_ENABLED = true;

export const BAND_PROXIMITY_VETO_MODE = 'CONDITIONAL' as const;

export interface BandVetoZone {
  price: number;
  type?: string;
  touches?: number;
  reactionStrength?: number;
}

export interface BandVetoFunnel {
  mode: string;
  /** Candidates that reached the confirmed-emission point this process chain has seen. */
  generated: number;
  /** Passed the veto (rule silent or fingerprint-exempt) and were emitted normally. */
  emitted: number;
  /** Suppressed by the veto — written to shadow_candidates_v1, never emitted. */
  suppressed: number;
  lastSuppressedAt: number | null;
  lastSuppressedId: string | null;
}

export interface BandVetoEvaluation {
  fires: boolean;
  mode: 'CONDITIONAL' | 'PLAIN';
  qualifyingZone: BandVetoZone | null;
  fingerprintActive: boolean;
  rsi: number | null;
  opposingZoneFraction: number | null;
  agreesPrior4h: boolean | null;
  prior4hDelta: number | null;
  suppressedId: string | null;
}

export interface BandVetoInput {
  client: SupabaseClient | null;
  direction: string;
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  rsi: number | null;
  zones: BandVetoZone[] | null | undefined;
  nowMs: number;
}

/**
 * The E.1 band rule, EXACTLY as pre-registered (item234_band_veto.ts bandVetoHit):
 * a zone of the signal's OWN snapshot with touches>=10 AND reactionStrength>=0.5
 * inside [entry-1.0, entry+TP1dist] for BUY, mirrored [entry-TP1dist, entry+1.0]
 * for SELL. No tuning; thresholds are the pre-registered 10 / 0.5.
 */
export function bandRuleHit(direction: 'BUY' | 'SELL', entry: number, tp1: number, zones: BandVetoZone[] | null): BandVetoZone | null {
  if (!zones || !Array.isArray(zones)) return null;
  const tp1d = Math.abs(tp1 - entry);
  const lo = direction === 'BUY' ? entry - 1.0 : entry - tp1d;
  const hi = direction === 'BUY' ? entry + tp1d : entry + 1.0;
  for (const z of zones) {
    if (z === null || typeof z !== 'object') continue;
    const p = Number(z.price);
    if (!Number.isFinite(p)) continue;
    if (Number(z.touches) >= 10 && Number(z.reactionStrength) >= 0.5 && p >= lo && p <= hi) return z;
  }
  return null;
}

/** Opposing-zone fraction, identical to the ITEM I annotation
 *  (emittedSignalService): opposing = RESISTANCE for BUY, SUPPORT for SELL. */
export function opposingZoneFractionOfSnapshot(direction: 'BUY' | 'SELL', zones: BandVetoZone[] | null): number | null {
  if (!zones || zones.length === 0) return null;
  const opp = zones.filter(z => (direction === 'BUY' ? z.type === 'RESISTANCE' : z.type === 'SUPPORT')).length;
  return Math.round((opp / zones.length) * 1000) / 1000;
}

/**
 * The momentum fingerprint (pre-registered, all three inputs must affirmatively
 * hold): agrees with the prior 4h move AND RSI stretched against it (BUY
 * rsi>=60 / SELL rsi<=40) AND opposing_zone_fraction <= 0.10. NULL inputs make
 * it NOT active (never defaulted to exempt).
 */
export function fingerprintActive(direction: 'BUY' | 'SELL', rsi: number | null, opposingZoneFraction: number | null, agreesPrior4h: boolean | null): boolean {
  if (agreesPrior4h !== true) return false;
  if (rsi === null || !(direction === 'BUY' ? rsi >= 60 : rsi <= 40)) return false;
  if (opposingZoneFraction === null || opposingZoneFraction > 0.10) return false;
  return true;
}

/**
 * A.2 prior-4h move — IDENTICAL method to the agrees_with_prior_4h_move
 * annotation (emittedSignalService ITEM A.2 block): 5h window ending at
 * emission, >=150 bars, base = last bar with ts <= last.ts - 4h,
 * delta = last.close - base.close, agrees = BUY ? delta > 0 : delta < 0.
 * gold_m1_bars ONLY. Bars unavailable -> NULL (never a default).
 */
export async function computePrior4hAgreement(client: SupabaseClient, emsMs: number, direction: 'BUY' | 'SELL'): Promise<{ agrees: boolean | null; delta: number | null }> {
  const { data } = await client.from('gold_m1_bars')
    .select('timestamp, close')
    .gte('timestamp', new Date(emsMs - 5 * 3600_000).toISOString())
    .lt('timestamp', new Date(emsMs).toISOString())
    .order('timestamp', { ascending: true }).limit(250);
  const ann = ((data ?? []) as { timestamp: string; close: number | string }[])
    .map(b => ({ ts: new Date(b.timestamp).getTime(), c: Number(b.close) }));
  if (ann.length < 150) return { agrees: null, delta: null };
  let base = ann[0];
  for (const b of ann) {
    if (b.ts <= ann[ann.length - 1].ts - 4 * 3600_000) base = b; else break;
  }
  const delta = Math.round((ann[ann.length - 1].c - base.c) * 100) / 100;
  return { agrees: direction === 'BUY' ? delta > 0 : delta < 0, delta };
}

// ── funnel counters (mutually exclusive: generated == emitted + suppressed) ──
const FUNNEL_KEY = 'band_veto_funnel_v1';
let funnel: BandVetoFunnel = { mode: BAND_PROXIMITY_VETO_MODE, generated: 0, emitted: 0, suppressed: 0, lastSuppressedAt: null, lastSuppressedId: null };
let funnelLoaded = false;

async function storage(): Promise<{ getItem: (k: string) => Promise<string | null>; setItem: (k: string, v: string) => Promise<void> } | null> {
  try {
    const mod = (await import('@react-native-async-storage/async-storage')) as { default: { getItem: (k: string) => Promise<string | null>; setItem: (k: string, v: string) => Promise<void> } };
    return mod.default;
  } catch {
    return null;
  }
}

async function persistFunnel(): Promise<void> {
  const st = await storage();
  if (!st) return;
  try { await st.setItem(FUNNEL_KEY, JSON.stringify(funnel)); } catch { /* durable persistence unavailable — in-memory counters remain */ }
}

async function loadFunnel(): Promise<void> {
  if (funnelLoaded) return;
  funnelLoaded = true;
  const st = await storage();
  if (!st) return;
  try {
    const raw = await st.getItem(FUNNEL_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<BandVetoFunnel>;
      funnel = {
        mode: BAND_PROXIMITY_VETO_MODE,
        generated: saved.generated ?? 0,
        emitted: saved.emitted ?? 0,
        suppressed: saved.suppressed ?? 0,
        lastSuppressedAt: saved.lastSuppressedAt ?? null,
        lastSuppressedId: saved.lastSuppressedId ?? null,
      };
    }
  } catch { /* corrupt or absent counter — start fresh */ }
}

/** Durable funnel state for the diagnostics export. */
export function getVetoFunnel(): BandVetoFunnel {
  return { ...funnel };
}

async function writeSuppressedCandidate(client: SupabaseClient | null, suppressedId: string, input: BandVetoInput, hit: BandVetoZone, lo: number, hi: number, fp: { active: boolean; rsi: number | null; opp: number | null; agrees: boolean | null; delta: number | null }): Promise<void> {
  if (!client) {
    console.warn('[BandProximityVeto] no Supabase client — suppressed candidate NOT persisted (veto still applied)');
    return;
  }
  const { error } = await client.from('shadow_candidates_v1').insert({
    candidate_name: 'BAND_VETO_SUPPRESSED',
    evaluated_at: new Date(input.nowMs).toISOString(),
    direction: input.direction === 'SELL' ? 'SELL' : 'BUY',
    entry: Math.round(input.entry * 100) / 100,
    sl: Math.round(input.sl * 100) / 100,
    tp1: Math.round(input.tp1 * 100) / 100,
    tp2: Math.round(input.tp2 * 100) / 100,
    tp3: Math.round(input.tp3 * 100) / 100,
    inputs: {
      suppressed_id: suppressedId,
      mode: BAND_PROXIMITY_VETO_MODE,
      veto_spec: 'E.1 band rule: touches>=10 && reactionStrength>=0.5 && price in [entry-1.0, entry+TP1dist] (BUY, mirrored for SELL)',
      qualifying_zone: { price: Number(hit.price), touches: Number(hit.touches), reaction_strength: Number(hit.reactionStrength), type: hit.type ?? null },
      band: { lo: Math.round(lo * 100) / 100, hi: Math.round(hi * 100) / 100 },
      fingerprint: {
        active: fp.active,
        rule: 'agrees_prior_4h AND (BUY rsi>=60 / SELL rsi<=40) AND opposing_zone_fraction<=0.10',
        agrees_prior_4h: fp.agrees,
        prior_4h_delta: fp.delta,
        rsi: fp.rsi,
        opposing_zone_fraction: fp.opp,
      },
      candidate_confidence: Math.round(input.confidence * 1000) / 1000,
    },
  });
  if (error) console.warn(`[BandProximityVeto] shadow write FAILED (non-blocking): ${error.message}`);
}

/**
 * The veto decision at the confirmed-emission point. Counts the funnel
 * (generated -> emitted | suppressed, mutually exclusive), and when it fires,
 * persists the suppressed candidate fire-and-forget. The ONLY await on the hot
 * path is one small gold_m1_bars read when the band rule actually fires.
 */
export async function evaluateBandProximityVeto(input: BandVetoInput): Promise<BandVetoEvaluation> {
  void loadFunnel();
  funnel.generated += 1;
  const dir: 'BUY' | 'SELL' = input.direction === 'SELL' ? 'SELL' : 'BUY';
  const hit = bandRuleHit(dir, input.entry, input.tp1, input.zones ?? null);
  if (!hit) {
    funnel.emitted += 1;
    void persistFunnel();
    return { fires: false, mode: BAND_PROXIMITY_VETO_MODE, qualifyingZone: null, fingerprintActive: false, rsi: input.rsi, opposingZoneFraction: null, agreesPrior4h: null, prior4hDelta: null, suppressedId: null };
  }
  const tp1d = Math.abs(input.tp1 - input.entry);
  const lo = dir === 'BUY' ? input.entry - 1.0 : input.entry - tp1d;
  const hi = dir === 'BUY' ? input.entry + tp1d : input.entry + 1.0;
  const opp = opposingZoneFractionOfSnapshot(dir, input.zones ?? null);
  const { agrees, delta } = input.client
    ? await computePrior4hAgreement(input.client, input.nowMs, dir)
    : { agrees: null, delta: null };
  const fpActive = fingerprintActive(dir, input.rsi, opp, agrees);
  const fires = BAND_PROXIMITY_VETO_MODE === 'CONDITIONAL' ? !fpActive : true;
  if (!fires) {
    funnel.emitted += 1;
    void persistFunnel();
    return { fires: false, mode: BAND_PROXIMITY_VETO_MODE, qualifyingZone: hit, fingerprintActive: fpActive, rsi: input.rsi, opposingZoneFraction: opp, agreesPrior4h: agrees, prior4hDelta: delta, suppressedId: null };
  }
  const suppressedId = `shadow_bandveto_${input.nowMs}_${Math.random().toString(36).slice(2, 9)}`;
  funnel.suppressed += 1;
  funnel.lastSuppressedAt = input.nowMs;
  funnel.lastSuppressedId = suppressedId;
  void persistFunnel();
  void writeSuppressedCandidate(input.client, suppressedId, input, hit, lo, hi, { active: fpActive, rsi: input.rsi, opp, agrees, delta });
  return { fires: true, mode: BAND_PROXIMITY_VETO_MODE, qualifyingZone: hit, fingerprintActive: fpActive, rsi: input.rsi, opposingZoneFraction: opp, agreesPrior4h: agrees, prior4hDelta: delta, suppressedId };
}

void loadFunnel();
