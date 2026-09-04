/**
 * ITEM AB ENABLER — one-shot, ADDITIVE-ONLY corpus enrichment.
 *
 * Computes the 7 side-relative features for every historical trade_outcomes_v1
 * row via the SHIPPED computeSideRelativeFeatures (same function the engine
 * calls at emission) and writes them into the row's `features` jsonb.
 *
 * HARD GUARANTEES:
 *   - ADDITIVE ONLY: the 7 feat_* keys are merged into a FRESH read of the
 *     row's features; result / exit_price / ts / updated_at / every other
 *     column are never touched. The PATCH payload is the features object only.
 *   - IDEMPOTENT: a row that already carries feat_trend_aligned is skipped.
 *   - LABELS IMMUTABLE: nothing in the label/R/exit path is read for writing.
 *
 * DOCUMENTED APPROXIMATION (training rows only): historical SR zone maps are
 * not persisted, so feat_zone_max_react uses bar-pivot zone levels (2-bar
 * fractals, deduped within $1) over the trailing window — mirroring the
 * engine's own local fallback detector. At emission the live engine zone map
 * is used. Session/day features use the trailing ~25h bar window (the
 * engine's BAR_M5_LOOKBACK=300), not the backtest's 72h.
 *
 * bun expo/scripts/backfill_side_relative_features.ts
 */

import { computeSideRelativeFeatures, type BarInput } from "../services/modelFitting";

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? "https://tcbnqmnzsnjhqkyuhrch.supabase.co").replace(/\/$/, "");
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "sb_publishable__uw7Qn3qPIARNPGPEDWWww_KzseiT8x";
const M5_BAR_MS = 5 * 60 * 1000;
const ENGINE_M5_WINDOW = 300;
const SESSION_BACKFILL_HOURS = 26;

interface CorpusRow {
  signal_id: string;
  result: string;
  entry_price: number | null;
  exit_price: number | null;
  direction: string | null;
  features: Record<string, unknown> | null;
}

interface TapeBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

async function restFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, ...(init.headers ?? {}) },
  });
}

async function fetchAllCorpus(): Promise<CorpusRow[]> {
  const rows: CorpusRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const res = await restFetch(
      `trade_outcomes_v1?select=signal_id,result,entry_price,exit_price,direction,features&order=ts.asc&limit=${pageSize}&offset=${offset}`,
      { method: "GET" },
    );
    if (!res.ok) throw new Error(`corpus read failed: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as CorpusRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

async function fetchTape(fromIso: string, toIso: string): Promise<TapeBar[]> {
  const rows: TapeBar[] = [];
  const pageSize = 1000;
  const base = `select=timestamp,open,high,low,close&timestamp=gte.${fromIso}&timestamp=lte.${toIso}&order=timestamp.asc`;
  for (let offset = 0; ; offset += pageSize) {
    const res = await restFetch(`gold_m1_bars?${base}&limit=${pageSize}&offset=${offset}`, { method: "GET" });
    if (!res.ok) throw new Error(`tape read failed: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as TapeBar[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

function emissionMsFromSignalId(signalId: string): number | null {
  const m = /^signal_(\d+)_/.exec(signalId);
  return m ? Number(m[1]) : null;
}

function aggregateM1ToM5(m1: readonly TapeBar[]): BarInput[] {
  const buckets = new Map<number, { open: number; high: number; low: number; close: number; start: number }>();
  for (const bar of m1) {
    const tsMs = Date.parse(bar.timestamp);
    const start = Math.floor(tsMs / M5_BAR_MS) * M5_BAR_MS;
    const bucket = buckets.get(start);
    if (!bucket) {
      buckets.set(start, { start, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    } else {
      bucket.high = Math.max(bucket.high, bar.high);
      bucket.low = Math.min(bucket.low, bar.low);
      bucket.close = bar.close;
    }
  }
  return [...buckets.values()]
    .sort((a, b) => a.start - b.start)
    .map((b) => ({ timestamp: b.start, open: b.open, high: b.high, low: b.low, close: b.close }));
}

function pivotZoneLevels(bars: readonly BarInput[]): number[] {
  const levels: number[] = [];
  for (let i = 2; i < bars.length - 2; i += 1) {
    const b = bars[i];
    if (
      b.high > bars[i - 1].high && b.high > bars[i - 2].high &&
      b.high > bars[i + 1].high && b.high > bars[i + 2].high
    ) levels.push(b.high);
    if (
      b.low < bars[i - 1].low && b.low < bars[i - 2].low &&
      b.low < bars[i + 1].low && b.low < bars[i + 2].low
    ) levels.push(b.low);
  }
  levels.sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const level of levels) {
    if (deduped.length === 0 || Math.abs(level - deduped[deduped.length - 1]) >= 1) deduped.push(level);
  }
  return deduped;
}

function inferDirection(row: CorpusRow): "BUY" | "SELL" | null {
  if (row.direction === "BUY" || row.direction === "SELL") return row.direction;
  if (row.entry_price === null || row.exit_price === null) return null;
  if (Math.abs(row.exit_price - row.entry_price) < 0.01) return null;
  const exitedAbove = row.exit_price > row.entry_price;
  if (row.result === "WIN") return exitedAbove ? "BUY" : "SELL";
  return exitedAbove ? "SELL" : "BUY";
}

async function main(): Promise<void> {
  console.log("=".repeat(80));
  console.log("ITEM AB ENABLER — ADDITIVE-ONLY side-relative feature backfill");
  console.log("=".repeat(80));

  console.log("Pulling corpus + tape...");
  const rows = await fetchAllCorpus();
  console.log(`Corpus: ${rows.length} row(s).`);
  const emissions = rows
    .map((r) => ({ row: r, emittedAt: emissionMsFromSignalId(r.signal_id) }))
    .filter((e): e is { row: CorpusRow; emittedAt: number } => e.emittedAt !== null)
    .sort((a, b) => a.emittedAt - b.emittedAt);
  if (emissions.length === 0) throw new Error("no parseable emission timestamps");
  const fromIso = new Date(emissions[0].emittedAt - SESSION_BACKFILL_HOURS * 60 * 60 * 1000).toISOString();
  const toIso = new Date(emissions[emissions.length - 1].emittedAt).toISOString();
  const tape = await fetchTape(fromIso, toIso);
  console.log(`Tape: ${tape.length} M1 bar(s) (${tape[0]?.timestamp} .. ${tape[tape.length - 1]?.timestamp}).`);
  const m5 = aggregateM1ToM5(tape);
  console.log(`M5 aggregate: ${m5.length} bar(s).`);

  let updated = 0;
  let skipped = 0;
  let nulls = 0;
  let failures = 0;

  for (let i = 0; i < emissions.length; i += 1) {
    const { row, emittedAt } = emissions[i];
    try {
      const existingFeatures = (row.features ?? {}) as Record<string, unknown>;
      if (existingFeatures.feat_trend_aligned !== undefined) {
        skipped += 1;
        continue;
      }
      const direction = inferDirection(row);
      const barsBefore = m5.filter((b) => b.timestamp + M5_BAR_MS <= emittedAt);
      if (!direction || barsBefore.length < 50) {
        nulls += 1;
        continue; // not computable — leave the row untouched (training excludes it)
      }
      const window = barsBefore.slice(-ENGINE_M5_WINDOW);
      const entryPrice = row.entry_price ?? window[window.length - 1].close;
      const rsiRaw = existingFeatures.rsi;
      const feats = computeSideRelativeFeatures({
        direction,
        entryPrice,
        rsi: typeof rsiRaw === "number" && Number.isFinite(rsiRaw) ? rsiRaw : null,
        m5Bars: window,
        zonePrices: pivotZoneLevels(window),
      });
      const merged = {
        ...existingFeatures,
        feat_trend_aligned: feats.feat_trend_aligned,
        feat_rsi_aligned: feats.feat_rsi_aligned,
        feat_ema_stack: feats.feat_ema_stack,
        feat_session_level_count: feats.feat_session_level_count,
        feat_at_day_extreme: feats.feat_at_day_extreme,
        feat_zone_max_react: feats.feat_zone_max_react,
        feat_near_round50: feats.feat_near_round50,
      };
      const res = await restFetch(`trade_outcomes_v1?signal_id=eq.${encodeURIComponent(row.signal_id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ features: merged }),
      });
      if (!res.ok) {
        failures += 1;
        console.error(`  ✗ ${row.signal_id.slice(-6)}: ${res.status} ${await res.text()}`);
      } else {
        updated += 1;
      }
    } catch (err) {
      failures += 1;
      console.error(`  ✗ ${row.signal_id.slice(-6)}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((i + 1) % 50 === 0) {
      console.log(`  progress ${i + 1}/${emissions.length} — updated ${updated}, skipped ${skipped}, nulls ${nulls}, failures ${failures}`);
    }
  }

  console.log("\nDONE:");
  console.log(`  updated (7 feat_* keys written): ${updated}`);
  console.log(`  skipped (already carried the keys): ${skipped}`);
  console.log(`  not computable (no direction / no tape) — untouched: ${nulls}`);
  console.log(`  failures: ${failures}`);
  console.log("Labels, exits, timestamps and updated_at were NEVER part of any payload.");
}

main().catch((err) => {
  console.error("BACKFILL FAILED:", err);
  process.exit(1);
});
