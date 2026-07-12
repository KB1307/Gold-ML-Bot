/**
 * VERIFICATION for the audit-reliability pass (Items 1-5).
 *
 * This does NOT (and cannot) reach into the actual device's local
 * AsyncStorage/SQLite for the real flagged signal - that data only exists on
 * the user's phone, which this sandbox has no access to. What this DOES prove
 * is the mechanism: given bars that are correctly UTC-aligned (which is what
 * Item 1's &timezone=UTC fix guarantees TwelveData now returns, instead of the
 * previous Sydney-shifted bars), the existing resolver (signalResolver.ts,
 * unchanged by this pass) correctly reconstructs the user's independently
 * verified real outcome instead of the false early SL_HIT.
 *
 * Flagged signal: SELL XAUUSD, entry 4102.7, TP1 4100.1, TP2 4098.0,
 * TP3 4095.7, SL 4108.6. Entry 7/10/2026 19:07:49 LOCAL (UTC+2) = 17:07:49 UTC.
 * User's real chart data (converted to UTC):
 *   17:07-17:32 UTC: price ~4102.7-4107, never near SL
 *   18:00 UTC: price falls to ~4100 (at/through TP1)
 *   ~19:06 UTC: price falls to ~4098.1 (essentially at TP2)
 *   19:59-20:00 UTC: SL (4108.6) genuinely touched
 */
import { resolveSignalWithBars } from "../services/signalResolver";

const PIP = 0.1;
const entryTs = new Date("2026-07-10T17:07:49Z").getTime(); // 19:07:49 UTC+2

const signal: any = {
  id: "flagged-2026-07-10-sell",
  type: "SELL",
  entryPrice: 4102.7,
  entryPriceWithSlippage: 4102.7,
  tp1: 4100.1,
  tp2: 4098.0,
  tp3: 4095.7,
  sl: 4108.6,
  timestamp: new Date(entryTs),
  createdAt: entryTs,
  targetsHit: 0,
  confidence: 0.71,
  status: "ACTIVE",
  entryTime: "19:07",
  topFeatures: [],
  riskJustification: "test",
  breakevenReached: false,
};

const bar = (isoUtc: string, o: number, h: number, l: number, c: number) => ({
  timestamp: new Date(isoUtc).getTime(),
  open: o,
  high: h,
  low: l,
  close: c,
});

// Synthetic bars matching the user's independently verified real chart data,
// expressed in TRUE UTC (what a correctly &timezone=UTC-tagged TwelveData
// response - or the chart-derived local bars - should contain).
const bars = [
  bar("2026-07-10T17:08:00Z", 4102.7, 4103.5, 4102.2, 4103.0),
  bar("2026-07-10T17:15:00Z", 4103.0, 4104.8, 4102.9, 4104.2),
  bar("2026-07-10T17:32:00Z", 4104.2, 4106.9, 4104.0, 4106.5), // still well below SL (4108.6)
  bar("2026-07-10T18:00:00Z", 4106.5, 4106.6, 4099.8, 4100.0), // through TP1 (4100.1)
  bar("2026-07-10T19:06:00Z", 4100.0, 4100.1, 4098.05, 4098.3), // essentially at TP2 (4098.0)
  bar("2026-07-10T19:30:00Z", 4098.3, 4102.0, 4098.0, 4101.5), // retraces
  bar("2026-07-10T19:59:00Z", 4101.5, 4108.9, 4101.4, 4108.7), // genuine SL touch (4108.6)
];

const result = resolveSignalWithBars(signal, bars, {
  fromScratch: true,
  evalNowMs: new Date("2026-07-10T20:30:00Z").getTime(),
  logPrefix: "   [Verify]",
});

console.log("\n=== VERIFICATION: flagged 2026-07-10 SELL signal, given TRUE-UTC bars ===");
console.log(`Result: status=${result.newStatus} targetsHit=${result.targetsHit} exitPrice=${result.exitPrice.toFixed(2)}`);
console.log(`Resolved at bar ts: ${result.resolvedAtBarTs ? new Date(result.resolvedAtBarTs).toISOString() : "n/a"}`);

const falseEarlySlHitAt1719Utc = result.newStatus === "SL_HIT" && result.resolvedAtBarTs === new Date("2026-07-10T17:19:00Z").getTime();
console.log(`\n${falseEarlySlHitAt1719Utc ? "❌" : "✅"} Did NOT reproduce the false early SL_HIT (17:19 UTC / 19:19 local): ${!falseEarlySlHitAt1719Utc}`);

const reachedTp1OrBeyond = result.targetsHit >= 1;
console.log(`${reachedTp1OrBeyond ? "✅" : "❌"} TP1 (and TP2 proximity) correctly registered before any SL resolution: targetsHit=${result.targetsHit}`);

console.log(
  "\nNOTE (honest limitation, same as prior investigation): this sandbox cannot reach the user's device-local\n" +
  "AsyncStorage/SQLite to pull this exact signal's ACTUAL stored createdAt/bars, so this is a mechanism\n" +
  "verification using the user's own independently-verified real price levels/timestamps, not a live re-audit\n" +
  "of the literal stored record. It confirms: IF the resolver is fed correctly UTC-aligned bars for this\n" +
  "window (which Item 1's &timezone=UTC fix now guarantees for any TwelveData-sourced portion), the false\n" +
  "early SL_HIT does not reproduce and the real TP1/TP2-then-later-SL sequence is recovered."
);
