/**
 * ITEM DA — THE SHADOW RESOLVER (standalone instrument).
 *
 * Closes the gap named by the CE resolver finding: nothing resolves
 * shadow_candidates_v1 rows, so no shadow book (the three strategies plus
 * BAND_VETO_SUPPRESSED, MID_RSI_SUPPRESSED, DRIFT_VETO_SUPPRESSED) ever
 * accrued a decided outcome. This module resolves rows against the row's OWN
 * flat geometry from gold_m1_bars M1 data aggregated to M5.
 *
 * SCOPE GUARANTEES (Item DA "what NOT to do"):
 * - Does NOT import, call, or modify the live resolver (signalResolver.ts).
 *   grep-verified: the only imports are @supabase/supabase-js and barIndicators.
 * - Does NOT touch rows with inputs.geometryVersion absent or < 2 (pre-CD
 *   geometry must never enter a forward book; they are marked UNRESOLVED with
 *   a note and skipped).
 * - Flat SL/TP/TIME only — no TP1/lock/TP2/TP3 ladder, no breakeven policy.
 * - Same-bar rule identical to the backtest: on any bar the STOP is checked
 *   BEFORE the target, and a same-bar hit resolves as SL (ambiguity = LOSS).
 *
 * Scheduling: one pass (≤ maxRows, oldest first) per drift-check cycle
 * (DRIFT_CHECK_INTERVAL, signalEngine.ts), fire-and-forget — a resolution
 * failure must never affect emission.
 *
 * WRITE-BACK PREREQUISITE: the app runs on the anon key, and
 * shadow_candidates_v1 (migrations 016/020) has anon SELECT + INSERT only.
 * backend/migrations/024_shadow_candidates_resolver_update.sql adds the anon
 * UPDATE policy (inputs-column grant). Until it is applied, PostgREST RLS
 * silently no-ops the UPDATE (matches 0 rows) — this resolver detects that
 * (`update matched 0 rows`) and counts it as an error rather than reporting
 * a resolution the source system does not hold (mindset rule 4).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateBars, type Bar } from "./barIndicators";

/** One resolved shadow row (Item DA contract). */
export interface ShadowResolution {
  rowId: string;
  candidateName: string;
  outcome: "TP" | "SL" | "TIME" | "UNRESOLVED";
  /** $ of PRICE movement from fill, sign-correct for direction. */
  pnlPrice: number;
  /** Max favourable excursion in $ before resolution. */
  mfe: number;
  /** Max adverse excursion in $ before resolution. */
  mae: number;
  /** M5 bars from fill to resolution (fill bar = 1). */
  barsHeld: number;
}

export interface ShadowResolverGeometry {
  sl: number;
  tp: number;
  timeStopBars: number;
}

/** Minimal row shape the resolver needs from shadow_candidates_v1. */
export interface ShadowResolverRow {
  id: number | string;
  candidate_name: string;
  evaluated_at: string;
  direction: string | null;
  inputs: {
    geometry?: { sl?: unknown; tp?: unknown; timeStopBars?: unknown } | null;
    geometryVersion?: unknown;
    [key: string]: unknown;
  } | null;
}

/** Pure per-row walk result (exported for read-only verification harnesses). */
export interface ShadowRowResolution {
  outcome: "TP" | "SL" | "TIME" | "UNRESOLVED";
  pnlPrice: number;
  mfe: number;
  mae: number;
  barsHeld: number;
  fill: number | null;
  stop: number | null;
  target: number | null;
  resolutionBarIndex: number | null;
  reason: string;
}

const M5_MS = 5 * 60 * 1000;

/**
 * PURE resolution walk — the whole instrument. Given a direction, the row's
 * own flat geometry, and ascending M1 bars, aggregates to M5 (aggregateBars,
 * the engine's own aggregation) and walks forward from the first M5 bar at or
 * after evaluated_at:
 *   per bar, in this exact order:
 *     1. mae update (adverse excursion so far)
 *     2. STOP check  → resolve SL immediately (same-bar rule: no target check)
 *     3. mfe update (favourable excursion so far)
 *     4. TARGET check → resolve TP
 *   neither level hit within timeStopBars → TIME at the last bar's close.
 *
 * pnlPrice is LEVEL-based (−sl / +tp), matching the backtest's flat-geometry
 * convention; the same-bar excursion beyond the level lives in mae/mfe.
 * barsHeld counts bars walked including the resolution bar (fill bar = 1).
 */
export function resolveRowAgainstBars(params: {
  direction: "BUY" | "SELL";
  geometry: ShadowResolverGeometry;
  evaluatedAtMs: number;
  m1Bars: readonly Bar[];
}): ShadowRowResolution {
  const { direction, geometry, evaluatedAtMs, m1Bars } = params;
  const unresolved: ShadowRowResolution = {
    outcome: "UNRESOLVED",
    pnlPrice: 0,
    mfe: 0,
    mae: 0,
    barsHeld: 0,
    fill: null,
    stop: null,
    target: null,
    resolutionBarIndex: null,
    reason: "",
  };

  const m5 = aggregateBars(m1Bars, 5).filter((b) => b.timestamp >= evaluatedAtMs);
  if (m5.length === 0) {
    return {
      ...unresolved,
      reason: "no M5 bar at or after evaluated_at yet (row still open)",
    };
  }

  const fill = m5[0].open;
  const stop = direction === "BUY" ? fill - geometry.sl : fill + geometry.sl;
  const target = direction === "BUY" ? fill + geometry.tp : fill - geometry.tp;
  let mae = 0;
  let mfe = 0;

  const maxBars = Math.min(geometry.timeStopBars, m5.length);
  for (let i = 0; i < maxBars; i++) {
    const bar = m5[i];
    const adverse = direction === "BUY" ? fill - bar.low : bar.high - fill;
    if (adverse > mae) mae = adverse;

    // STOP FIRST — same-bar ambiguity resolves as a LOSS (backtest rule).
    const stopped = direction === "BUY" ? bar.low <= stop : bar.high >= stop;
    if (stopped) {
      return {
        outcome: "SL",
        pnlPrice: -geometry.sl,
        mfe,
        mae,
        barsHeld: i + 1,
        fill,
        stop,
        target,
        resolutionBarIndex: i,
        reason:
          direction === "BUY"
            ? `bar ${i}: low ${bar.low} <= stop ${stop} (fill ${fill}, sl ${geometry.sl})`
            : `bar ${i}: high ${bar.high} >= stop ${stop} (fill ${fill}, sl ${geometry.sl})`,
      };
    }

    const favourable = direction === "BUY" ? bar.high - fill : fill - bar.low;
    if (favourable > mfe) mfe = favourable;

    const hit = direction === "BUY" ? bar.high >= target : bar.low <= target;
    if (hit) {
      return {
        outcome: "TP",
        pnlPrice: geometry.tp,
        mfe,
        mae,
        barsHeld: i + 1,
        fill,
        stop,
        target,
        resolutionBarIndex: i,
        reason:
          direction === "BUY"
            ? `bar ${i}: high ${bar.high} >= target ${target} (fill ${fill}, tp ${geometry.tp})`
            : `bar ${i}: low ${bar.low} <= target ${target} (fill ${fill}, tp ${geometry.tp})`,
      };
    }
  }

  if (m5.length >= geometry.timeStopBars) {
    const last = m5[geometry.timeStopBars - 1];
    const pnl = direction === "BUY" ? last.close - fill : fill - last.close;
    return {
      outcome: "TIME",
      pnlPrice: pnl,
      mfe,
      mae,
      barsHeld: geometry.timeStopBars,
      fill,
      stop,
      target,
      resolutionBarIndex: geometry.timeStopBars - 1,
      reason: `time stop: ${geometry.timeStopBars} M5 bars walked, close ${last.close} vs fill ${fill}`,
    };
  }

  return {
    ...unresolved,
    reason: `bars ended after ${m5.length} of ${geometry.timeStopBars} bars with no stop/target hit (row still open)`,
  };
}

/** Parse and validate the row's own geometry; null when unusable. */
function geometryOf(inputs: ShadowResolverRow["inputs"]): ShadowResolverGeometry | null {
  const g = inputs?.geometry;
  if (!g || typeof g !== "object") return null;
  const sl = Number(g.sl);
  const tp = Number(g.tp);
  const timeStopBars = Number(g.timeStopBars);
  if (!Number.isFinite(sl) || sl <= 0) return null;
  if (!Number.isFinite(tp) || tp <= 0) return null;
  if (!Number.isInteger(timeStopBars) || timeStopBars < 1) return null;
  return { sl, tp, timeStopBars };
}

async function fetchM1Bars(
  client: SupabaseClient,
  fromMs: number,
  toMs: number,
): Promise<{ bars: Bar[]; error?: string }> {
  const bars: Bar[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from("gold_m1_bars")
      .select("timestamp,open,high,low,close")
      .gte("timestamp", new Date(fromMs).toISOString())
      .lte("timestamp", new Date(toMs).toISOString())
      .order("timestamp", { ascending: true })
      .range(offset, offset + 999);
    if (error) return { bars, error: `gold_m1_bars fetch: ${error.message}` };
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[]) {
      bars.push({
        timestamp: new Date(r.timestamp).getTime(),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      });
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  return { bars };
}

/**
 * Write `merged` back into inputs and VERIFY the source system now holds it.
 * Returns null on success, or an error message. The `.select("id")` turns the
 * silent RLS no-op (0 rows matched — anon UPDATE policy missing) into an
 * explicit error instead of a phantom success (mindset rule 4).
 */
async function writeInputsMerged(
  client: SupabaseClient,
  rowId: number | string,
  merged: Record<string, unknown>,
): Promise<string | null> {
  const { data, error } = await client
    .from("shadow_candidates_v1")
    .update({ inputs: merged })
    .eq("id", rowId)
    .select("id");
  if (error) return `update row ${rowId}: ${error.message}`;
  if (!data || data.length === 0) {
    return (
      `update row ${rowId}: matched 0 rows — anon UPDATE policy on ` +
      `shadow_candidates_v1 (migration 024) not applied? RLS silently no-ops the write.`
    );
  }
  return null;
}

/**
 * ITEM DA — resolve one pass of unresolved shadow rows (oldest first).
 * Select: inputs->>mfe IS NULL. The prompt's select would re-fetch
 * skip-noted rows forever (their mfe stays null by design), so the same
 * guard that makes skipping idempotent is added: inputs->>resolvedOutcome
 * IS NULL. Behavior is otherwise exactly as specified.
 */
export async function resolveShadowRows(params: {
  supabaseClient: SupabaseClient;
  maxRows?: number;
}): Promise<{
  resolved: number;
  stillOpen: number;
  errors: number;
  /** Acceptance 4: rows skipped for geometryVersion absent or < 2. */
  skippedPreGeometryV2: number;
  lastError?: string;
}> {
  const maxRows = params.maxRows ?? 200;
  const client = params.supabaseClient;

  const { data: rows, error } = await client
    .from("shadow_candidates_v1")
    .select("id, candidate_name, evaluated_at, direction, inputs")
    .filter("inputs->>mfe", "is", null)
    .filter("inputs->>resolvedOutcome", "is", null)
    .order("evaluated_at", { ascending: true })
    .range(0, maxRows - 1);
  if (error) {
    throw new Error(`shadow_candidates_v1 select: ${error.message}`);
  }

  let resolved = 0;
  let stillOpen = 0;
  let errors = 0;
  let skippedPreGeometryV2 = 0;
  let lastError: string | undefined;

  for (const row of (rows ?? []) as unknown as ShadowResolverRow[]) {
    const inputs = (row.inputs ?? {}) as Record<string, unknown>;
    const evaluatedAtMs = new Date(row.evaluated_at).getTime();
    const geometryVersion = Number(inputs.geometryVersion);

    // Step 2 — pre-CD geometry: mark UNRESOLVED with a note and SKIP.
    if (!Number.isFinite(geometryVersion) || geometryVersion < 2) {
      const writeError = await writeInputsMerged(client, row.id, {
        ...inputs,
        resolvedOutcome: "UNRESOLVED",
        resolverNote: "SKIPPED: geometryVersion absent or <2 (pre-CD geometry) — excluded from forward books (Item DA step 2)",
        resolvedAt: new Date().toISOString(),
      });
      if (writeError) {
        errors += 1;
        lastError = writeError;
      } else {
        skippedPreGeometryV2 += 1;
      }
      continue;
    }

    const geometry = geometryOf(row.inputs);
    const direction = row.direction?.toUpperCase() === "BUY" ? "BUY" : row.direction?.toUpperCase() === "SELL" ? "SELL" : null;
    if (!geometry || !direction) {
      const writeError = await writeInputsMerged(client, row.id, {
        ...inputs,
        resolvedOutcome: "UNRESOLVED",
        resolverNote: `SKIPPED: malformed ${!geometry ? "geometry" : "direction"} on a geometryVersion>=2 row (Item DA)`,
        resolvedAt: new Date().toISOString(),
      });
      if (writeError) {
        errors += 1;
        lastError = writeError;
      } else {
        errors += 1;
      }
      continue;
    }

    // Bars: from the M5 bucket containing evaluated_at (so the fill bar's
    // OHLC is complete) through timeStopBars M5 bars + 90 min margin.
    const fromMs = Math.floor(evaluatedAtMs / M5_MS) * M5_MS;
    const toMs = evaluatedAtMs + geometry.timeStopBars * M5_MS + 90 * 60 * 1000;
    const { bars, error: barError } = await fetchM1Bars(client, fromMs, toMs);
    if (barError) {
      errors += 1;
      lastError = `${row.candidate_name}#${row.id}: ${barError}`;
      continue;
    }

    const result = resolveRowAgainstBars({ direction, geometry, evaluatedAtMs, m1Bars: bars });
    if (result.outcome === "UNRESOLVED" && result.fill === null) {
      stillOpen += 1;
      continue;
    }
    if (result.outcome === "UNRESOLVED") {
      // Partial walk — the market data has not reached the resolution window
      // end yet. Leave the row untouched; a later pass resolves it.
      stillOpen += 1;
      continue;
    }

    const resolution: ShadowResolution = {
      rowId: String(row.id),
      candidateName: row.candidate_name,
      outcome: result.outcome,
      pnlPrice: result.pnlPrice,
      mfe: result.mfe,
      mae: result.mae,
      barsHeld: result.barsHeld,
    };
    const writeError = await writeInputsMerged(client, row.id, {
      ...inputs,
      mfe: resolution.mfe,
      mae: resolution.mae,
      barsHeld: resolution.barsHeld,
      resolvedOutcome: resolution.outcome,
      resolvedPnlPrice: resolution.pnlPrice,
      resolvedAt: new Date().toISOString(),
    });
    if (writeError) {
      errors += 1;
      lastError = writeError;
    } else {
      resolved += 1;
    }
  }

  return { resolved, stillOpen, errors, skippedPreGeometryV2, ...(lastError !== undefined ? { lastError } : {}) };
}
