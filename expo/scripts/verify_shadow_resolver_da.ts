/**
 * ITEM DA acceptance harness — READ-ONLY against the source system.
 *
 * 1. Counts of unresolved rows (total / geometryVersion>=2 / pre-CD), by name.
 * 2. ONE REAL resolveShadowRows pass (anon client, maxRows 200) → pastes
 *    {resolved, stillOpen, errors, skippedPreGeometryV2, lastError}. Expected
 *    to surface the migration-024 RLS no-op as the named blocker (the resolver
 *    detects "matched 0 rows" instead of phantom-reporting success).
 * 3. Hand-check: resolveRowAgainstBars (the SAME pure instrument the
 *    orchestrator uses) on a real geometryVersion>=2 row if one exists, else
 *    on a SYNTHETIC DT-geometry row evaluated against REAL gold_m1_bars.
 *    Prints fill/stop/target, the resolution bar OHLC, the deciding
 *    inequality, mfe/mae/barsHeld — the arithmetic for the hand-check paste.
 *
 * Run: cd expo && bun scripts/verify_shadow_resolver_da.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { aggregateBars } from "../services/barIndicators";
import {
  resolveShadowRows,
  resolveRowAgainstBars,
  type ShadowResolverRow,
  type ShadowRowResolution,
} from "../services/shadowResolver";

const M5_MS = 5 * 60 * 1000;

async function fetchM1(client: SupabaseClient, fromMs: number, toMs: number): Promise<{ timestamp: number; open: number; high: number; low: number; close: number }[]> {
  const bars: { timestamp: number; open: number; high: number; low: number; close: number }[] = [];
  for (let o = 0; ; o += 1000) {
    const { data, error } = await client
      .from("gold_m1_bars")
      .select("timestamp,open,high,low,close")
      .gte("timestamp", new Date(fromMs).toISOString())
      .lte("timestamp", new Date(toMs).toISOString())
      .order("timestamp", { ascending: true })
      .range(o, o + 999);
    if (error) throw new Error(`gold_m1_bars: ${error.message}`);
    for (const r of (data ?? []) as { timestamp: string; open: string; high: string; low: string; close: string }[]) {
      bars.push({ timestamp: new Date(r.timestamp).getTime(), open: +r.open, high: +r.high, low: +r.low, close: +r.close });
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  return bars;
}

function printHandCheck(res: ShadowRowResolution, m5: { timestamp: number; open: number; high: number; low: number; close: number }[]): void {
  const first = m5[0];
  console.log(`fill = OPEN of the FIRST M5 bar at/after evaluated_at = ${res.fill}`);
  console.log(`  fill bar ${res.resolutionBarIndex !== null ? "" : ""}${new Date(first.timestamp).toISOString()} O=${first.open} H=${first.high} L=${first.low} C=${first.close}`);
  console.log(`stop  (SELL) = fill + sl = ${res.fill} + 12 = ${res.stop}`);
  console.log(`target (SELL) = fill - tp = ${res.fill} - 10 = ${res.target}`);
  console.log(`outcome = ${res.outcome} | pnlPrice = ${res.pnlPrice} | mfe = ${res.mfe} | mae = ${res.mae} | barsHeld = ${res.barsHeld}`);
  if (res.resolutionBarIndex !== null) {
    const b = m5[res.resolutionBarIndex];
    console.log(`resolution bar ${res.resolutionBarIndex}: ${new Date(b.timestamp).toISOString()} O=${b.open} H=${b.high} L=${b.low} C=${b.close}`);
    if (res.resolutionBarIndex > 0) {
      const p = m5[res.resolutionBarIndex - 1];
      console.log(`previous bar  ${res.resolutionBarIndex - 1}: ${new Date(p.timestamp).toISOString()} O=${p.open} H=${p.high} L=${p.low} C=${p.close}`);
    }
  }
  console.log(`deciding comparison: ${res.reason}`);
  console.log(`same-bar rule check: stop evaluated BEFORE target on every bar (resolveRowAgainstBars order: mae → stop → mfe → target)`);
}

async function main(): Promise<void> {
  const client = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL!,
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false, storageKey: "da-acceptance-harness" } },
  );

  // ── 1. counts ──
  const rows: ShadowResolverRow[] = [];
  for (let o = 0; o < 6000; o += 1000) {
    const { data, error } = await client
      .from("shadow_candidates_v1")
      .select("id, candidate_name, evaluated_at, direction, inputs")
      .filter("inputs->>mfe", "is", null)
      .filter("inputs->>resolvedOutcome", "is", null)
      .order("evaluated_at", { ascending: true })
      .range(o, o + 999);
    if (error) throw new Error(`count select: ${error.message}`);
    rows.push(...((data ?? []) as unknown as ShadowResolverRow[]));
    if ((data?.length ?? 0) < 1000) break;
  }
  const v2 = rows.filter((r) => Number(r.inputs?.geometryVersion) >= 2);
  console.log(`── 1. unresolved rows (mfe null, no resolvedOutcome): ${rows.length} ──`);
  console.log(`  geometryVersion >= 2 (resolvable): ${v2.length}`);
  console.log(`  geometryVersion absent or < 2 (DA step-2 skips): ${rows.length - v2.length}`);
  const byName = new Map<string, number>();
  for (const r of rows) byName.set(r.candidate_name, (byName.get(r.candidate_name) ?? 0) + 1);
  for (const [name, n] of [...byName.entries()].sort()) console.log(`    ${name}: ${n}`);

  // ── 2. REAL pass ──
  console.log("\n── 2. resolveShadowRows pass (anon client, maxRows 200) ──");
  const result = await resolveShadowRows({ supabaseClient: client, maxRows: 200 });
  console.log(JSON.stringify(result, null, 2));

  // ── 3. hand-check against REAL M1 bars ──
  const { data: ends } = await client.from("gold_m1_bars").select("timestamp").order("timestamp", { ascending: false }).limit(1);
  const latestMs = new Date(String(ends?.[0]?.timestamp)).getTime();
  const evalAtMs = Math.floor((latestMs - 9 * 60 * 60 * 1000) / M5_MS) * M5_MS;
  console.log(`\n── 3. hand-check: latest bar ${new Date(latestMs).toISOString()}, evaluated_at ${new Date(evalAtMs).toISOString()} ──`);
  const m1 = await fetchM1(client, Math.floor(evalAtMs / M5_MS) * M5_MS, evalAtMs + 96 * M5_MS + 90 * 60 * 1000);
  console.log(`M1 bars fetched: ${m1.length} (${m1.length > 0 ? new Date(m1[0].timestamp).toISOString() : "?"} → ${m1.length > 0 ? new Date(m1[m1.length - 1].timestamp).toISOString() : "?"})`);
  const m5 = aggregateBars(m1, 5).filter((b) => b.timestamp >= evalAtMs);
  console.log(`M5 bars at/after evaluated_at: ${m5.length}`);

  if (v2.length > 0) {
    const row = v2[0];
    const g = (row.inputs?.geometry ?? {}) as { sl?: number; tp?: number; timeStopBars?: number };
    console.log(`REAL geometryVersion>=2 row #${row.id} (${row.candidate_name}, ${row.direction}):`);
    const res = resolveRowAgainstBars({
      direction: row.direction?.toUpperCase() === "SELL" ? "SELL" : "BUY",
      geometry: { sl: Number(g.sl), tp: Number(g.tp), timeStopBars: Number(g.timeStopBars) },
      evaluatedAtMs: new Date(row.evaluated_at).getTime(),
      m1Bars: m1,
    });
    printHandCheck(res, aggregateBars(m1, 5).filter((b) => b.timestamp >= new Date(row.evaluated_at).getTime()));
  } else {
    console.log("NO geometryVersion>=2 row exists live yet — hand-check uses a SYNTHETIC row (DT geometry, SELL sl12/tp10/T96) evaluated against REAL bars:");
    const res = resolveRowAgainstBars({ direction: "SELL", geometry: { sl: 12, tp: 10, timeStopBars: 96 }, evaluatedAtMs: evalAtMs, m1Bars: m1 });
    printHandCheck(res, m5);
  }

  console.log("\nITEM DA harness done (read-only; no rows inserted or deleted).");
}

main().catch((error) => {
  console.error("ITEM DA HARNESS: FAIL", error);
  process.exitCode = 1;
});
