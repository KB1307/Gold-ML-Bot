/**
 * ITEM CD — ZONE_RETEST_LONG geometry correction gate (EB-UPDATED).
 *
 * Simulation (live emissions cannot be forced from a sandbox — the same honest
 * note as BA/BB/CA): calls the REAL persistShadowStrategy with a stub Supabase
 * client and prints the exact insert payload it would write to
 * shadow_candidates_v1 for all three candidates.
 *
 * Expected (ITEM EB, 2026-09-09 — supersedes the CD/CE expectations below;
 * CD's and CE's original records stay in the header history):
 *   SCORED_DT_SHORT   {sl:10, tp:12, timeStopBars:96}  (SELL: sl = entry+10, tp1 = entry−12)
 *   SCORED_REOPEN_LONG {sl:23, tp:19, timeStopBars:96} (BUY: sl = entry−23, tp1 = entry+19)
 *   ZONE_RETEST_LONG  unchanged: {sl:25, tp:25, timeStopBars:192}
 *   inputs.geometryVersion = 3 on every row (ITEM EB bump; CE-era rows were 2).
 *
 * Item CD original (2026-09-08): ZONE 15/10/96 → 25/25/192; DT/REOPEN 12/10/96.
 * Item CE original: geometryVersion 2 + mfe/mae/barsHeld null on all rows.
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

type Geo = { sl: number; tp: number; timeStopBars: number };
function geoOf(name: string): Geo | null {
  const row = captured.find((r) => r.payload.candidate_name === name);
  if (!row) return null;
  return (row.payload.inputs as { geometry: Geo }).geometry;
}
function pricesOf(name: string): { entry: number; sl: number; tp1: number } | null {
  const row = captured.find((r) => r.payload.candidate_name === name);
  if (!row) return null;
  return { entry: row.payload.entry as number, sl: row.payload.sl as number, tp1: row.payload.tp1 as number };
}

// ── ITEM CD GATE (EB-UPDATED) ── ZONE 25/25/192 + price consistency, and DT's
// regression target now reflects the EB table (10/12) rather than CD's 12/10.
const zone = geoOf("ZONE_RETEST_LONG");
const zonePrices = pricesOf("ZONE_RETEST_LONG");
const dt = geoOf("SCORED_DT_SHORT");
if (!zone || !zonePrices || !dt) {
  console.log("ITEM CD GATE: FAIL (missing captured rows)");
} else {
  const zoneOk =
    zone.sl === 25 &&
    zone.tp === 25 &&
    zone.timeStopBars === 192 &&
    Math.abs(zonePrices.entry - zonePrices.sl - 25) < 1e-9 &&
    Math.abs(zonePrices.tp1 - zonePrices.entry - 25) < 1e-9;
  const dtOk = dt.sl === 10 && dt.tp === 12 && dt.timeStopBars === 96;
  console.log(`ITEM CD GATE: ${zoneOk && dtOk ? "PASS" : "FAIL"} (zone25=${zoneOk}, dtRegression=${dtOk} — EB values)`);
}

// ── ITEM CE GATE (EB-UPDATED) ── geometryVersion = 3 on EVERY new row (all
// three names; CE-era rows were 2) and the three excursion keys present (null
// at emission — filled by the Item DA resolver).
const reopen = geoOf("SCORED_REOPEN_LONG");
const reopenPrices = pricesOf("SCORED_REOPEN_LONG");
if (!reopen || !reopenPrices) {
  console.log("ITEM CE GATE: FAIL (missing captured REOPEN row)");
} else {
  const ceOk = captured.every((row) => {
    const inputs = row.payload.inputs as Record<string, unknown>;
    return (
      inputs.geometryVersion === 3 &&
      "mfe" in inputs && inputs.mfe === null &&
      "mae" in inputs && inputs.mae === null &&
      "barsHeld" in inputs && inputs.barsHeld === null
    );
  });
  console.log(`ITEM CE GATE: ${ceOk ? "PASS" : "FAIL"} (geometryVersion=3 + mfe/mae/barsHeld null on all ${captured.length} rows)`);
}

// ── ITEM EB GATE ── all three geometries match the EB table EXACTLY, and the
// written sl/tp1 PRICES are consistent with each row's own geometry and side.
if (!zone || !dt || !reopen || !zonePrices || !reopenPrices) {
  console.log("ITEM EB GATE: FAIL (missing captured rows)");
} else {
  const dtPrices = pricesOf("SCORED_DT_SHORT");
  const dtOk = dt.sl === 10 && dt.tp === 12 && dt.timeStopBars === 96;
  const reopenOk = reopen.sl === 23 && reopen.tp === 19 && reopen.timeStopBars === 96;
  const zoneOk = zone.sl === 25 && zone.tp === 25 && zone.timeStopBars === 192;
  const pricesOk =
    dtPrices !== null &&
    Math.abs(dtPrices.entry + 10 - dtPrices.sl) < 1e-9 && // SELL: stop above entry
    Math.abs(dtPrices.entry - 12 - dtPrices.tp1) < 1e-9 && // SELL: target below
    Math.abs(reopenPrices.entry - 23 - reopenPrices.sl) < 1e-9 && // BUY: stop below
    Math.abs(reopenPrices.entry + 19 - reopenPrices.tp1) < 1e-9; // BUY: target above
  const gvOk = captured.every((row) => (row.payload.inputs as Record<string, unknown>).geometryVersion === 3);
  // ITEM ED — the cap keys are written on EVERY row (null at emission when the
  // count is unavailable; the scan fills them per detection).
  const capOk = captured.every((row) => {
    const inputs = row.payload.inputs as Record<string, unknown>;
    return "capSkipped" in inputs && inputs.capSkipped === null && "openPositionsAtSignal" in inputs && inputs.openPositionsAtSignal === null;
  });
  const pass = dtOk && reopenOk && zoneOk && pricesOk && gvOk && capOk;
  console.log(
    `ITEM EB GATE: ${pass ? "PASS" : "FAIL"} (dt10/12=${dtOk}, reopen23/19=${reopenOk}, zone25/25=${zoneOk}, pricesConsistent=${pricesOk}, gv3AllRows=${gvOk}, edCapKeysNull=${capOk})`,
  );
}
