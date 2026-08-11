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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** Matches SCRATCH_R_THRESHOLD in the client resolver. */
const SCRATCH_R_THRESHOLD = 0.15;

/** Bars are open-stamped (Phase 0 item 1), so skip the in-progress bar. */
const SAFE_BAR_OFFSET_MS = 60_000;

/** Give a signal at most this long to reach a terminal event before calling it flat. */
const MAX_RESOLUTION_WINDOW_MS = 24 * 60 * 60 * 1000;

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

  const rOf = (exit: number): number => ((isBuy ? exit - entry : entry - exit) / risk);

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
      const r = rOf(lockPrice);
      if (tp2Hit) {
        return { status: "PARTIAL_WIN_SL_HIT", exitPrice: lockPrice, realizedR: r, isScratch: Math.abs(r) < SCRATCH_R_THRESHOLD, resolvedAtBarTs: bar.timestamp };
      }
      if (tp1Hit) {
        return { status: "SL_AFTER_BE", exitPrice: lockPrice, realizedR: r, isScratch: Math.abs(r) < SCRATCH_R_THRESHOLD, resolvedAtBarTs: bar.timestamp };
      }
      return { status: "SL_HIT", exitPrice: lockPrice, realizedR: r, isScratch: Math.abs(r) < SCRATCH_R_THRESHOLD, resolvedAtBarTs: bar.timestamp };
    }

    if (touched(bar, Number(signal.tp3))) {
      const r = rOf(Number(signal.tp3));
      return { status: "ALL_TARGETS_HIT", exitPrice: Number(signal.tp3), realizedR: r, isScratch: false, resolvedAtBarTs: bar.timestamp };
    }
    if (!tp2Hit && touched(bar, Number(signal.tp2))) {
      tp2Hit = true;
      lockPrice = Number(signal.tp1); // runner locked at TP1 once TP2 banks
    }
    if (!tp1Hit && touched(bar, Number(signal.tp1))) {
      tp1Hit = true;
      lockPrice = entry; // breakeven lock armed
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

const isWin = (status: Terminal, realizedR: number): boolean =>
  status === "ALL_TARGETS_HIT" || (status === "PARTIAL_WIN_SL_HIT" && realizedR > 0) || realizedR > 0;

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
