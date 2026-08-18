// Supabase Edge Function: resolve-emitted-signals
//
// ITEM 52(d) — DURABLE SERVER-SIDE RESOLUTION.
//
// Replays real gold_m1_bars against every unresolved row in emitted_signals_v1
// and upserts the terminal outcome into trade_outcomes_v1. Scheduled by pg_cron
// via pg_net (schedule SQL lives in migration 004). NO Rork backend in the path,
// mirroring refresh-sr-zones.
//
// WHY THIS IS THE LEVER. Corpus capture was 12.9% (51 / 396) because a row only
// landed if the client happened to be RUNNING at the moment of resolution and
// then pushed successfully — conditions that select on app uptime, not on market
// behaviour. Item 45 showed reweighting cannot fix the resulting bias (max |Δw|
// 0.0098 = 5.3% of Item 44's shift); the binding constraint is sample size. A
// cron-driven resolver removes the uptime dependency entirely.
//
// RESOLUTION SEMANTICS — deliberately identical to the CANONICAL basis that Item
// 43e validated, because that basis agreed 51/51 with the durable bar-verified
// labels:
//   * fromScratch: the stored client status is NEVER trusted. Entry, TP and SL
//     are all re-derived from price action alone.
//   * Every terminal path requires a CONFIRMED bar event (a bar whose range
//     actually contains the level), never a single bare tick — this is what
//     Item 42 fixed for TP3 and what Item 50 confirmed is still bare for TP1/TP2
//     on the client. The server resolver has no ticks at all, only completed
//     bars, so it cannot reproduce that defect class.
//   * safeBarStart = emittedAt + 60_000, so the still-forming bar at emission is
//     excluded and evaluation begins at the first FULLY completed bar.
//   * Scratch trades (|R| < 0.15) are flagged, not silently dropped.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * BLOCK A / E-1 — realized_r must be NET of execution cost, not gross.
 * Mirrors expo/constants/executionCost.ts exactly (Deno cannot import that
 * module directly, so the constant and formula are duplicated here with the
 * source cited). ANY change to the client constant must be mirrored here.
 */
const EXECUTION_COST_PER_TRADE_USD = 0.2; // expo/constants/executionCost.ts:37
/** Assumed $/price-unit for a 0.01-lot XAUUSD position (same assumption used project-wide; not verified against a stored per-signal position-size field — PROVISIONAL). */
const DOLLAR_PER_PRICE_UNIT = 1;
function costInR(riskPriceUnits: number): number {
  const riskUsd = riskPriceUnits * DOLLAR_PER_PRICE_UNIT;
  if (!Number.isFinite(riskUsd) || riskUsd <= 0) return 0;
  return EXECUTION_COST_PER_TRADE_USD / riskUsd;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** Matches SCRATCH_R_THRESHOLD in the client resolver. */
const SCRATCH_R_THRESHOLD = 0.15;

/** Bars are open-stamped (Phase 0 item 1), so skip the in-progress bar. */
const SAFE_BAR_OFFSET_MS = 60_000;

/** ITEM 94 — POST-TP1 PROFIT LOCK. Mirrors signalResolver.ts:19 and
 * getPostTP1LockPrice() exactly. Deno cannot import the client module, so the
 * constant and formula are duplicated here with the source cited. ANY change
 * to the client constant must be mirrored here. */
const POST_TP1_PROFIT_LOCK_R = 0.35;
const POST_TP1_PROFIT_LOCK_MIN_PIPS = 5;
const PIP = 0.1;
const POST_TP1_LOCK_MAX_FRACTION_OF_TP1 = 0.9;

function computePostTP1LockPrice(signal: EmittedRow): number {
  const isBuy = signal.direction === "BUY";
  const entry = Number(signal.entry);
  const sl = Number(signal.sl);
  const tp1 = Number(signal.tp1);
  const stopDistance = Math.abs(entry - sl);
  const tp1Distance = Math.abs(tp1 - entry);
  const minDelta = POST_TP1_PROFIT_LOCK_MIN_PIPS * PIP;
  const base = Number.isFinite(stopDistance) && stopDistance > 0
    ? stopDistance * POST_TP1_PROFIT_LOCK_R
    : minDelta;
  const ceiling = Number.isFinite(tp1Distance) && tp1Distance > 0
    ? tp1Distance * POST_TP1_LOCK_MAX_FRACTION_OF_TP1
    : Number.POSITIVE_INFINITY;
  const delta = Math.min(Math.max(base, minDelta), ceiling);
  const raw = isBuy ? entry + delta : entry - delta;
  return Number(raw.toFixed(1));
}

/** ITEM 94 — PROTECTED EXIT PRICE for PARTIAL_WIN_SL_HIT. Mirrors
 * getProtectedExitPrice(signal, 2) in signalResolver.ts:134. After TP2 the
 * runner is protected at the average of TP1/TP2/entry. */
function computeProtectedExitPrice(signal: EmittedRow, targetsHit: number): number {
  const normalized = Math.max(0, Math.min(2, targetsHit));
  const entry = Number(signal.entry);
  const tp1 = Number(signal.tp1);
  const tp2 = Number(signal.tp2);
  if (normalized >= 2) {
    return Number(((tp1 + tp2 + entry) / 3).toFixed(1));
  }
  if (normalized === 1) {
    return computePostTP1LockPrice(signal);
  }
  return entry;
}

/**
 * Give a signal at most this long to reach a terminal event before calling it flat.
 *
 * ITEM 82 / B5 - F-3 FIX. This was 24h while the CLIENT resolver uses 8h
 * (RESOLUTION_WINDOW_MS, contexts/TradingContext.tsx:265). Two resolvers write one
 * corpus, so the same signal could be labelled differently depending on which one
 * landed first - and the upsert below uses ignoreDuplicates:true, so whichever
 * arrived FIRST won permanently. A measurement is only as good as its labels.
 *
 * ALIGNED TO 8h - the client's value. Direction justified on evidence:
 *   - 8h is the only one of the two with a pre-registered gate behind it. Item 41a
 *     (contexts/TradingContext.tsx:244-265) swept 2h/4h/8h/12h/24h across all 382
 *     resolvable corpus signals and closed three gates: G1 correction curve
 *     flattens (8h->12h adds 0 corrections), G2 EV stable (|EV(12h)-EV(8h)| =
 *     0.0000R), G3 bar cost (480 bars/signal vs the 5000 ceiling).
 *   - The 24h had no gate, no sweep and no comment. It was a default, not a finding.
 *   - Item 41a's reasoning applies here unchanged: this resolver answers the
 *     identical question against the identical bar table and the identical ladder.
 *     Running server-side does not change the question.
 *   - Widening the client to 24h instead would loosen a measured constant to match
 *     an unmeasured one - the post-hoc loosening MINDSET rule 1 forbids.
 * On the Item 41a sweep 8h/12h/24h were IDENTICAL (382 signals, +0.0800R, 63.6%),
 * so this is expected to change few or no labels. That is the point: it removes a
 * divergence that could bite later, at no measured cost now.
 */
const MAX_RESOLUTION_WINDOW_MS = 8 * 60 * 60 * 1000;

interface Bar {
  timestamp: number;
  high: number;
  low: number;
  close: number;
}

interface EmittedRow {
  signal_id: string;
  emitted_at: string;
  direction: "BUY" | "SELL";
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
}

type Terminal = "ALL_TARGETS_HIT" | "PARTIAL_WIN_SL_HIT" | "SL_HIT" | "SL_AFTER_BE" | "CLOSED";

interface Resolution {
  status: Terminal;
  exitPrice: number;
  realizedR: number;
  isScratch: boolean;
  resolvedAtBarTs: number;
}

function getAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Paginated bar fetch — PostgREST caps a response at 1000 rows. */
async function fetchBars(
  client: ReturnType<typeof getAdminClient>,
  fromMs: number,
  toMs: number,
): Promise<Bar[]> {
  const out: Bar[] = [];
  let offset = 0;
  for (let page = 0; page < 50; page += 1) {
    const { data, error } = await client
      .from("gold_m1_bars")
      .select("timestamp, high, low, close")
      .gte("timestamp", new Date(fromMs).toISOString())
      .lte("timestamp", new Date(toMs).toISOString())
      .order("timestamp", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`gold_m1_bars read failed: ${error.message}`);
    const batch = data ?? [];
    for (const r of batch as { timestamp: string; high: number; low: number; close: number }[]) {
      out.push({
        timestamp: new Date(r.timestamp).getTime(),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
      });
    }
    if (batch.length < 1000) break;
    offset += 1000;
  }
  return out;
}

/**
 * Canonical bar replay. Mirrors resolveSignalWithBars under fromScratch: no
 * stored status is consulted, and every level must be CONTAINED by a completed
 * bar's range to count as touched.
 */
function resolveFromBars(signal: EmittedRow, bars: Bar[]): Resolution | null {
  const isBuy = signal.direction === "BUY";
  const entry = Number(signal.entry);
  const sl = Number(signal.sl);
  const risk = Math.abs(entry - sl);
  if (risk <= 0 || bars.length === 0) return null;

  const rOfGross = (exit: number): number => ((isBuy ? exit - entry : entry - exit) / risk);
  // BLOCK A / E-1: every realized_r this function returns is NET of the closed
  // $0.20 execution cost, expressed in R via the same risk distance. Both
  // resolvers previously wrote GROSS R (D6 finding) — every EV figure derived
  // from trade_outcomes_v1 was frictionless.
  const rOf = (exit: number): number => rOfGross(exit) - costInR(risk);

  const touched = (bar: Bar, level: number): boolean => bar.low <= level && bar.high >= level;

  let entryFilled = false;
  let tp1Hit = false;
  let tp2Hit = false;
  let lockPrice = sl;

  for (const bar of bars) {
    if (!entryFilled) {
      if (!touched(bar, entry)) continue;
      entryFilled = true;
    }

    // SL / lock first: within a single bar we cannot know ordering, so take the
    // adverse side conservatively rather than inventing a favourable sequence.
    if (touched(bar, lockPrice)) {
      if (tp2Hit) {
        // ITEM 94: after TP2 the detection level is entry (breakeven), but the
        // EXIT PRICE is the protected average (tp1+tp2+entry)/3, NOT the lock
        // level. Previously the exit was at lockPrice=tp1 (wrong level entirely).
        const exitPrice = computeProtectedExitPrice(signal, 2);
        const r = rOf(exitPrice);
        return { status: "PARTIAL_WIN_SL_HIT", exitPrice, realizedR: r, isScratch: Math.abs(r) < SCRATCH_R_THRESHOLD, resolvedAtBarTs: bar.timestamp };
      }
      if (tp1Hit) {
        // ITEM 94: after TP1 the lock is at the 0.35R profit lock (NOT
        // breakeven/entry as before). The exit price IS the lock price.
        // F-29: the old code had lockPrice=entry here, producing rOf(entry)=0-cost<0,
        // which isWin() read as LOSS — corrupting 73 rows (50.7% of SL_AFTER_BE).
        const exitPrice = lockPrice; // = computePostTP1LockPrice(signal)
        const r = rOf(exitPrice);
        // ITEM 94(d) — write-path assertion: SL_AFTER_BE is ALWAYS a WIN
        // (the 0.35R lock minus cost is always positive for any sane risk).
        // If this fires, the lock price computation is broken.
        if (r <= 0) {
          throw new Error(
            `SL_AFTER_BE ASSERTION FAILED: realizedR=${r} <= 0 for signal ${signal.signal_id}` +
            `, lockPrice=${lockPrice}, entry=${entry}, sl=${sl}, risk=${risk}` +
            `. The 0.35R profit lock must produce a positive net R.`,
          );
        }
        return { status: "SL_AFTER_BE", exitPrice, realizedR: r, isScratch: Math.abs(r) < SCRATCH_R_THRESHOLD, resolvedAtBarTs: bar.timestamp };
      }
      const r = rOf(lockPrice);
      return { status: "SL_HIT", exitPrice: lockPrice, realizedR: r, isScratch: Math.abs(r) < SCRATCH_R_THRESHOLD, resolvedAtBarTs: bar.timestamp };
    }

    if (touched(bar, Number(signal.tp3))) {
      const r = rOf(Number(signal.tp3));
      return { status: "ALL_TARGETS_HIT", exitPrice: Number(signal.tp3), realizedR: r, isScratch: false, resolvedAtBarTs: bar.timestamp };
    }
    if (!tp2Hit && touched(bar, Number(signal.tp2))) {
      tp2Hit = true;
      // ITEM 94 FIX: after TP2 the lock is at ENTRY (breakeven), NOT at tp1.
      // The canonical resolver (signalResolver.ts:291) uses entryPrice here.
      // The old code used tp1, which triggered PARTIAL_WIN_SL_HIT immediately
      // on the next bar (tp1 was already touched) at the wrong exit price.
      lockPrice = entry;
    }
    if (!tp1Hit && touched(bar, Number(signal.tp1))) {
      tp1Hit = true;
      // ITEM 94 FIX: after TP1 the lock is at the 0.35R PROFIT LOCK, NOT at
      // entry (breakeven). The canonical resolver (signalResolver.ts:291)
      // uses postTP1Lock here. The old code used entry, producing 0R for
      // SL_AFTER_BE, which was then labelled LOSS by isWin() — F-29.
      lockPrice = computePostTP1LockPrice(signal);
    }
  }

  if (!entryFilled) return null; // never filled — not an outcome, leave unresolved

  const last = bars[bars.length - 1];
  const r = rOf(last.close);
  return {
    status: "CLOSED",
    exitPrice: last.close,
    realizedR: r,
    isScratch: Math.abs(r) < SCRATCH_R_THRESHOLD,
    resolvedAtBarTs: last.timestamp,
  };
}

// ITEM 94: SL_AFTER_BE is ALWAYS a WIN regardless of R value — the 0.35R lock
// guarantees a positive R. The explicit case is belt-and-suspenders alongside
// the assertion in resolveFromBars; even if the assertion somehow doesn't fire,
// the label is still correct.
const isWin = (status: Terminal, realizedR: number): boolean =>
  status === "ALL_TARGETS_HIT" ||
  status === "SL_AFTER_BE" ||
  (status === "PARTIAL_WIN_SL_HIT" && realizedR > 0) ||
  realizedR > 0;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const client = getAdminClient();

    // Only consider emissions old enough to have had a chance to resolve.
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: emitted, error: emittedErr } = await client
      .from("emitted_signals_v1")
      .select("signal_id, emitted_at, direction, entry, sl, tp1, tp2, tp3, confidence")
      .lte("emitted_at", cutoff)
      .order("emitted_at", { ascending: true })
      .limit(1000);
    if (emittedErr) throw new Error(`emitted_signals_v1 read failed: ${emittedErr.message}`);

    const rows = (emitted ?? []) as EmittedRow[];

    // Existing outcomes: durable rows WIN on conflict (ITEM 52(e)), so anything
    // already present is left untouched and merely counted.
    const { data: existing, error: existingErr } = await client
      .from("trade_outcomes_v1")
      .select("signal_id")
      .limit(10000);
    if (existingErr) throw new Error(`trade_outcomes_v1 read failed: ${existingErr.message}`);
    const alreadyResolved = new Set((existing ?? []).map((r) => String((r as { signal_id: string }).signal_id)));

    let resolved = 0;
    let skippedExisting = 0;
    let unresolvable = 0;
    // BLOCK A / E-3: the unresolvable counter previously gave no reason. Split
    // into NO_BARS (bar fetch returned zero rows for the window) vs
    // ENTRY_NEVER_FILLED (bars exist but price never traded through entry).
    const unresolvableReasons: Record<string, number> = { NO_BARS: 0, ENTRY_NEVER_FILLED: 0 };
    const upserts: Record<string, unknown>[] = [];

    for (const row of rows) {
      if (alreadyResolved.has(row.signal_id)) {
        skippedExisting += 1;
        continue;
      }
      const emittedMs = new Date(row.emitted_at).getTime();
      const bars = await fetchBars(client, emittedMs + SAFE_BAR_OFFSET_MS, emittedMs + MAX_RESOLUTION_WINDOW_MS);
      const resolution = resolveFromBars(row, bars);
      if (!resolution) {
        unresolvable += 1;
        const reasonCode = bars.length === 0 ? "NO_BARS" : "ENTRY_NEVER_FILLED";
        unresolvableReasons[reasonCode] = (unresolvableReasons[reasonCode] ?? 0) + 1;
        continue;
      }
      upserts.push({
        signal_id: row.signal_id,
        ts: new Date(resolution.resolvedAtBarTs).toISOString(),
        direction: row.direction,
        result: isWin(resolution.status, resolution.realizedR) ? "WIN" : "LOSS",
        entry_price: row.entry,
        exit_price: resolution.exitPrice,
        pnl: resolution.exitPrice - row.entry,
        confidence: row.confidence,
        realized_r: resolution.realizedR,
        is_scratch: resolution.isScratch,
        signal_duration_ms: resolution.resolvedAtBarTs - emittedMs,
        feature_schema_version: 1,
      });
      resolved += 1;
    }

    if (upserts.length > 0) {
      // Upsert (not insert) so a re-run is idempotent and can never create a
      // conflicting second row for the same signal.
      const { error: writeErr } = await client
        .from("trade_outcomes_v1")
        .upsert(upserts, { onConflict: "signal_id", ignoreDuplicates: true });
      if (writeErr) throw new Error(`trade_outcomes_v1 upsert failed: ${writeErr.message}`);
    }

    const body = {
      ok: true,
      examined: rows.length,
      resolved,
      skippedExisting,
      unresolvable,
      unresolvableReasons,
      at: new Date().toISOString(),
    };
    console.log(`[resolve-emitted-signals] ${JSON.stringify(body)}`);
    return new Response(JSON.stringify(body), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[resolve-emitted-signals] FAILED: ${message}`);
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
