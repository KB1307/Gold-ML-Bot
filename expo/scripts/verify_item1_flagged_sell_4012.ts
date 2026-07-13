/**
 * ITEM 1 — fromScratch sweep verification for the flagged SELL signal
 * (entry 4012.2, TP1 4009.6, TP2 4007.5), which was falsely recorded as
 * "TP1 + TP2 Banked" (WIN, +$2.40) at 17:11 by the pre-fix ungated Path 3
 * TP-direction detection, even though the user's real chart shows price
 * moved UP to ~4016.8 by 17:11 — away from both TP levels, never within
 * ~2.6-4.7 points of either.
 *
 * HONEST LIMITATION (same standard as every prior pass this session): the
 * actual stored record for this exact signal lives only in the user's
 * device-local AsyncStorage ('signal_history'), which this sandbox has no
 * access to. What this DOES prove is the MECHANISM: given bars that reflect
 * the user's independently-verified real price action for this window (price
 * only ever moving UP, away from both TP levels), the resolver's
 * fromScratch=true mode — the same mode runManualAudit()/the daily sweep now
 * runs for every terminal signal — no longer reproduces the false
 * TP1+TP2 bank, and instead correctly reports no target reached.
 *
 * This uses the REAL resolveSignalWithBars() (unchanged by this session's
 * work) directly — no sandboxing needed, since signalResolver.ts has no
 * React-Native-only imports.
 */
import { resolveSignalWithBars } from "../services/signalResolver";

const entryTs = new Date("2026-07-13T17:09:00Z").getTime();

const signal: any = {
  id: "flagged-2026-07-13-sell-4012",
  type: "SELL",
  entryPrice: 4012.2,
  entryPriceWithSlippage: 4012.2,
  tp1: 4009.6,
  tp2: 4007.5,
  tp3: 4005.0,
  sl: 4019.2,
  timestamp: new Date(entryTs),
  createdAt: entryTs,
  targetsHit: 0,
  confidence: 0.7,
  status: "ACTIVE",
  entryTime: "17:09",
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

// Synthetic bars matching the user's independently verified real chart data
// for this window: price only ever moves UP from entry (toward 4016.8 by
// 17:11), never down toward either TP level (4009.6 / 4007.5).
const bars = [
  bar("2026-07-13T17:09:00Z", 4012.2, 4013.1, 4012.0, 4012.9),
  bar("2026-07-13T17:10:00Z", 4012.9, 4015.4, 4012.8, 4015.0),
  bar("2026-07-13T17:11:00Z", 4015.0, 4016.9, 4014.9, 4016.8),
];

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) { pass++; } else { fail++; }
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

console.log("\n=== ITEM 1 VERIFICATION: flagged 2026-07-13 SELL signal (entry 4012.2), fromScratch sweep ===");

const result = resolveSignalWithBars(signal, bars, {
  fromScratch: true,
  evalNowMs: new Date("2026-07-13T17:12:00Z").getTime(),
  logPrefix: "   [Item1-Verify]",
});

console.log(`\nResult: status=${result.newStatus} targetsHit=${result.targetsHit} exitPrice=${result.exitPrice.toFixed(2)}`);

check(
  "Does NOT reproduce the false TP1+TP2 bank (targetsHit must be 0, not 2)",
  result.targetsHit === 0,
  `targetsHit=${result.targetsHit} (was falsely recorded as 2 by the pre-fix bug)`,
);
check(
  "Status is NOT a TP-side terminal (TP2_HIT / ALL_TARGETS_HIT / PARTIAL_WIN_SL_HIT)",
  !["TP2_HIT", "ALL_TARGETS_HIT", "PARTIAL_WIN_SL_HIT", "TP1_HIT", "TP3_HIT"].includes(result.newStatus),
  `status=${result.newStatus}`,
);
check(
  "Signal correctly remains ACTIVE (price never reached either TP in this window)",
  result.newStatus === "ACTIVE",
  `status=${result.newStatus}`,
);

console.log(`\n${pass}/${pass + fail} assertions passed.`);
if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
else {
  console.log(
    "✅ Item 1 mechanism verified — given bars reflecting the user's real (upward-only) price action for this\n" +
    "window, fromScratch resolution (the mode runManualAudit()/the daily sweep now runs for every terminal\n" +
    "signal) no longer reproduces the false TP1+TP2 bank.",
  );
}
