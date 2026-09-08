/**
 * ITEM CD — ZONE_RETEST_LONG geometry correction gate.
 *
 * Simulation (live emissions cannot be forced from a sandbox — the same honest
 * note as BA/BB/CA): calls the REAL persistShadowStrategy with a stub Supabase
 * client and prints the exact insert payload it would write to
 * shadow_candidates_v1 for all three candidates.
 *
 * Expected (Item CD):
 *   ZONE_RETEST_LONG  inputs.geometry = {sl:25, tp:25, timeStopBars:192},
 *                     entry/sl/tp1 consistent with a $25 distance (BUY: sl = entry−25, tp1 = entry+25)
 *   SCORED_DT_SHORT   unchanged: {sl:12, tp:10, timeStopBars:96}  (SELL: sl = entry+12, tp1 = entry−10)
 *   SCORED_REOPEN_LONG unchanged: {sl:12, tp:10, timeStopBars:96}
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { persistShadowStrategy } from "../services/shadowStrategies";

type Captured = { table: string; payload: Record<string, unknown> };
const captured: Captured[] = [];
const stubClient = {
  from: (table: string) => ({
    insert: (payload: Record<string, unknown>) => {
      captured.push({ table, payload });
      return { error: null };
    },
  }),
} as unknown as SupabaseClient;

const cases = [
  { candidateName: "ZONE_RETEST_LONG" as const, direction: "BUY" as const, entryPrice: 4496 },
  { candidateName: "SCORED_DT_SHORT" as const, direction: "SELL" as const, entryPrice: 4502 },
  { candidateName: "SCORED_REOPEN_LONG" as const, direction: "BUY" as const, entryPrice: 4498 },
];

for (const c of cases) {
  await persistShadowStrategy({
    supabaseClient: stubClient,
    signalId: `sim-cd-${c.candidateName}`,
    candidateName: c.candidateName,
    direction: c.direction,
    entryPrice: c.entryPrice,
    emittedAt: "2026-09-08T12:00:00.000Z",
    score: 1,
    scoreVerdict: "ABOVE",
    metadata: { simulated: true },
  });
}

for (const row of captured) {
  console.log(JSON.stringify(row, null, 2));
}

const zone = captured.find((r) => r.payload.candidate_name === "ZONE_RETEST_LONG");
const dt = captured.find((r) => r.payload.candidate_name === "SCORED_DT_SHORT");
if (!zone || !dt) {
  console.log("ITEM CD GATE: FAIL (missing captured rows)");
} else {
  const zGeo = (zone.payload.inputs as { geometry: { sl: number; tp: number; timeStopBars: number } }).geometry;
  const dGeo = (dt.payload.inputs as { geometry: { sl: number; tp: number; timeStopBars: number } }).geometry;
  const entry = zone.payload.entry as number;
  const sl = zone.payload.sl as number;
  const tp1 = zone.payload.tp1 as number;
  const zoneOk =
    zGeo.sl === 25 &&
    zGeo.tp === 25 &&
    zGeo.timeStopBars === 192 &&
    Math.abs(entry - sl - 25) < 1e-9 &&
    Math.abs(tp1 - entry - 25) < 1e-9;
  const dtOk = dGeo.sl === 12 && dGeo.tp === 10 && dGeo.timeStopBars === 96;
  console.log(`ITEM CD GATE: ${zoneOk && dtOk ? "PASS" : "FAIL"} (zone25=${zoneOk}, dtRegression=${dtOk})`);
}
