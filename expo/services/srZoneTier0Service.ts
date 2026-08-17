/**
 * TIER_0 S/R zone read service — DIRECT Supabase, anon key, no backend.
 *
 * ── WHY THIS EXISTS (B2(a)) ────────────────────────────────────────────────
 * TIER_0 zones were previously read through the Rork backend tRPC route
 * `srZones.getZones`. On 31 July that path failed on BOTH configured base URLs
 * (503 "no bundle deployed"), and the engine fell back to TIER_1_LOCAL
 * micro-zones SILENTLY. TIER_1 zones — computed from ~100 minutes of in-memory
 * M1 samples — were then the dominant scoring feature in all four losing BUYs.
 *
 * `sr_zones_v1` is a plain Supabase table with anon SELECT already enabled
 * (verified empirically: anon returns the same rows as the service role), so
 * there is no reason for the backend to sit in this READ path at all. This is
 * the same Design B treatment already applied to the shadow-write path.
 *
 * DATA-SOURCE RULE enforced here:
 *   - reads `sr_zones_v1` DIRECTLY from Supabase via the PUBLIC anon key;
 *   - the Rork backend is NOT involved in this read path;
 *   - there is NO fallback to GC=F / TwelveData / any other venue — if this
 *     read fails, it returns a typed failure and the caller stands aside.
 *   - the backend keeps ONLY the refresh/compute WRITE, which genuinely needs
 *     the service-role key.
 *
 * ── FAILURE VISIBILITY (B2(c)) ─────────────────────────────────────────────
 * Every failure mode increments a distinct counter and logs a distinct
 * greppable warning tagged `[SRZoneTier0]`, mirroring the shadow-write pattern.
 * A silent fallback to TIER_1_LOCAL must never happen invisibly again.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Zones untouched for longer than this are dropped at read time. Mirrors the
 *  backend route's EXPIRY_HOURS so client and server agree on freshness. */
const EXPIRY_HOURS = 96;

/** Sources that are structurally significant and recomputed fresh each refresh,
 *  so they are never "stale" by construction. Mirrors the backend route. */
const ALWAYS_FRESH_SOURCES = new Set<string>([
  "PIVOT",
  "PREV_DAY",
  "ASIAN_RANGE",
  "ORH_ORL",
  "WEEKLY",
  "SESSION_BLOCK",
]);

/**
 * The reactionStrength every downstream consumer in signalEngine.ts requires
 * before a zone may contribute to scoring or gating. A zone set in which NOTHING
 * clears this bar is functionally empty even though rows exist — which is exactly
 * how TIER_0 failed a third way on 31 July (12 rows present, all 0.015-0.043).
 */
export const TIER0_CONSUMER_THRESHOLD = 0.3;

export type Tier0ZoneSource =
  | "PRICE_ACTION"
  | "PIVOT"
  | "PREV_DAY"
  | "ASIAN_RANGE"
  | "ORH_ORL"
  | "WEEKLY"
  | "SESSION_BLOCK";

export interface Tier0SRZone {
  price: number;
  type: "SUPPORT" | "RESISTANCE";
  touches: number;
  rejectionWicks: number;
  reactionStrength: number;
  source: Tier0ZoneSource;
  confluenceScore: number;
  lastTouchTs: string | null;
}

/** Why a TIER_0 read did not yield usable zones. Explicit so the caller can
 *  react differently to "unreachable" vs "present but too weak to use". */
export type Tier0FailureReason =
  | "NOT_CONFIGURED"
  | "READ_ERROR"
  | "EMPTY_TABLE"
  | "ALL_EXPIRED"
  | "BELOW_CONSUMER_THRESHOLD"
  | "NOT_YET_LOADED";

export interface Tier0ReadResult {
  ok: boolean;
  zones: Tier0SRZone[];
  /** Zones surviving expiry but BELOW the consumer threshold. Reported so the
   *  "rows exist but are all too weak" failure is distinguishable from empty. */
  weakZoneCount: number;
  reason: Tier0FailureReason | null;
  detail: string | null;
}

// ── failure-visibility counters (B2(c)) ──────────────────────────────────────

interface Tier0Counters {
  reads: number;
  successes: number;
  failures: number;
  notConfigured: number;
  readErrors: number;
  emptyTable: number;
  allExpired: number;
  belowThreshold: number;
  /** D3 / F-19: cold-start race — fetch was launched but not yet resolved on
   *  the first generation pass. NOT a read failure; the read simply hadn't
   *  completed yet. Separated from the failure counters so the export can
   *  distinguish "fetch failed" from "fetch not yet resolved". */
  notYetLoaded: number;
  /** Times the engine actually ran a generation pass on TIER_1_LOCAL because
   *  TIER_0 was unusable. This is the number that matters for trust. */
  tier1FallbackUses: number;
  lastFailureReason: Tier0FailureReason | null;
  lastFailureDetail: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastZoneCount: number;
  lastMaxReactionStrength: number | null;
}

const counters: Tier0Counters = {
  reads: 0,
  successes: 0,
  failures: 0,
  notConfigured: 0,
  readErrors: 0,
  emptyTable: 0,
  allExpired: 0,
  belowThreshold: 0,
  notYetLoaded: 0,
  tier1FallbackUses: 0,
  lastFailureReason: null,
  lastFailureDetail: null,
  lastFailureAt: null,
  lastSuccessAt: null,
  lastZoneCount: 0,
  lastMaxReactionStrength: null,
};

/** Snapshot of the TIER_0 read-path health counters, for the diagnostics export. */
export function getTier0Counters(): Readonly<Tier0Counters> {
  return { ...counters };
}

/** Called by the engine when a generation pass actually proceeds on TIER_1_LOCAL
 *  zones because TIER_0 was unusable. Kept separate from read failures because
 *  one failed read can cover many generation passes via the TTL. */
export function recordTier0FallbackUse(): void {
  counters.tier1FallbackUses += 1;
}

/** Test-only: reset counters so a forced-failure test starts from a known state. */
export function __resetTier0CountersForTest(): void {
  counters.reads = 0;
  counters.successes = 0;
  counters.failures = 0;
  counters.notConfigured = 0;
  counters.readErrors = 0;
  counters.emptyTable = 0;
  counters.allExpired = 0;
  counters.belowThreshold = 0;
  counters.notYetLoaded = 0;
  counters.tier1FallbackUses = 0;
  counters.lastFailureReason = null;
  counters.lastFailureDetail = null;
  counters.lastFailureAt = null;
  counters.lastSuccessAt = null;
  counters.lastZoneCount = 0;
  counters.lastMaxReactionStrength = null;
}

/**
 * Serialize a Supabase PostgrestError (a plain object, NOT an Error instance)
 * into a readable single-line string. Same fix already applied to the shadow
 * write path — `String(err)` on a PostgrestError yields '[object Object]',
 * which defeats the entire purpose of logging it.
 */
function serializeTier0Error(err: unknown): string {
  if (err === null || err === undefined) return "null";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && typeof (err as Record<string, unknown>).message === "string") {
    const e = err as Record<string, unknown>;
    const parts: string[] = [`message="${e.message}"`];
    if (typeof e.code === "string" && e.code) parts.push(`code=${e.code}`);
    if (typeof e.details === "string" && e.details) parts.push(`details=${e.details}`);
    if (typeof e.hint === "string" && e.hint) parts.push(`hint=${e.hint}`);
    return parts.join(" ");
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

let tier0Client: SupabaseClient | null = null;

/** Dedicated anon client for TIER_0 reads. PUBLIC anon key only — the service
 *  role key is never shipped to the client and is never referenced here. */
function getTier0Client(): SupabaseClient | null {
  if (tier0Client) return tier0Client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  tier0Client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return tier0Client;
}

function recordFailure(reason: Tier0FailureReason, detail: string): Tier0ReadResult {
  counters.failures += 1;
  counters.lastFailureReason = reason;
  counters.lastFailureDetail = detail;
  counters.lastFailureAt = Date.now();
  switch (reason) {
    case "NOT_CONFIGURED":
      counters.notConfigured += 1;
      break;
    case "READ_ERROR":
      counters.readErrors += 1;
      break;
    case "EMPTY_TABLE":
      counters.emptyTable += 1;
      break;
    case "ALL_EXPIRED":
      counters.allExpired += 1;
      break;
    case "BELOW_CONSUMER_THRESHOLD":
      counters.belowThreshold += 1;
      break;
    case "NOT_YET_LOADED":
      counters.notYetLoaded += 1;
      break;
  }
  // Distinct, greppable warning. Tag is stable: [SRZoneTier0] TIER0_UNAVAILABLE
  console.warn(`[SRZoneTier0] TIER0_UNAVAILABLE reason=${reason} ${detail}`);
  return { ok: false, zones: [], weakZoneCount: 0, reason, detail };
}

/**
 * Read TIER_0 zones directly from Supabase `sr_zones_v1` using the anon key.
 *
 * Returns ok=false with an explicit reason on every failure mode, including the
 * non-obvious one where rows exist but every zone is below the consumer
 * threshold — a state that previously looked like success while delivering
 * nothing usable.
 *
 * There is deliberately NO fallback data source inside this function.
 */
export async function fetchTier0SRZones(): Promise<Tier0ReadResult> {
  counters.reads += 1;

  const client = getTier0Client();
  if (!client) {
    return recordFailure(
      "NOT_CONFIGURED",
      "EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY is missing",
    );
  }

  let data: Record<string, unknown>[] | null = null;
  try {
    const res = await client
      .from("sr_zones_v1")
      .select(
        "price, type, touches, rejection_wicks, reaction_strength, source, confluence_score, last_touch_ts",
      )
      .order("reaction_strength", { ascending: false })
      .limit(32);
    if (res.error) {
      return recordFailure("READ_ERROR", serializeTier0Error(res.error));
    }
    data = (res.data ?? []) as Record<string, unknown>[];
  } catch (err: unknown) {
    return recordFailure("READ_ERROR", serializeTier0Error(err));
  }

  if (data.length === 0) {
    return recordFailure(
      "EMPTY_TABLE",
      "sr_zones_v1 returned 0 rows — the refresh/compute WRITE has not populated the cache",
    );
  }

  const now = Date.now();
  const unexpired: Tier0SRZone[] = data
    .filter((row) => {
      const source = String(row.source);
      if (ALWAYS_FRESH_SOURCES.has(source)) return true;
      const lt = row.last_touch_ts;
      if (typeof lt !== "string" || !lt) return false;
      const ageHours = (now - new Date(lt).getTime()) / 3_600_000;
      return ageHours <= EXPIRY_HOURS;
    })
    .map((row) => ({
      price: Number(row.price),
      type: String(row.type) === "RESISTANCE" ? ("RESISTANCE" as const) : ("SUPPORT" as const),
      touches: Number(row.touches ?? 0),
      rejectionWicks: Number(row.rejection_wicks ?? 0),
      reactionStrength: Number(row.reaction_strength ?? 0),
      source: String(row.source) as Tier0ZoneSource,
      confluenceScore: Number(row.confluence_score ?? 0),
      lastTouchTs: typeof row.last_touch_ts === "string" ? row.last_touch_ts : null,
    }));

  if (unexpired.length === 0) {
    return recordFailure(
      "ALL_EXPIRED",
      `all ${data.length} row(s) exceeded EXPIRY_HOURS=${EXPIRY_HOURS} — the refresh WRITE is stale`,
    );
  }

  const usable = unexpired.filter((z) => z.reactionStrength >= TIER0_CONSUMER_THRESHOLD);
  const maxRs = Math.max(...unexpired.map((z) => z.reactionStrength));

  if (usable.length === 0) {
    counters.lastMaxReactionStrength = maxRs;
    return recordFailure(
      "BELOW_CONSUMER_THRESHOLD",
      `${unexpired.length} unexpired row(s) present but max reactionStrength=${maxRs.toFixed(3)} < ${TIER0_CONSUMER_THRESHOLD} — no zone can influence scoring`,
    );
  }

  counters.successes += 1;
  counters.lastSuccessAt = Date.now();
  counters.lastZoneCount = usable.length;
  counters.lastMaxReactionStrength = maxRs;

  return {
    ok: true,
    zones: usable,
    weakZoneCount: unexpired.length - usable.length,
    reason: null,
    detail: null,
  };
}
