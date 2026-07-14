import { resolveSignalWithBars } from "../services/signalResolver";

const PIP = 0.1;
const P = 3250;
const oneMin = 60_000;
const T0 = new Date("2026-04-24T06:12:00Z").getTime();
const bar = (ts: number, h: number, l: number, c: number) => ({ timestamp: ts, open: c, high: h, low: l, close: c });

const base: any = {
  type: "BUY", entryPrice: P, entryPriceWithSlippage: P + 1.0,
  tp1: P + 30 * PIP, tp2: P + 60 * PIP, tp3: P + 90 * PIP, sl: P - 70 * PIP,
  id: "t", timestamp: new Date(T0), createdAt: T0 + 30_000,
  targetsHit: 0, confidence: 0.75, status: "ACTIVE", slMultiplier: 1.5,
  entryTime: "06:13", topFeatures: [], riskJustification: "test", breakevenReached: false,
};

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail: string) {
  (cond ? pass++ : fail++) && 0;
  console.log(`  ${cond ? "✅" : "❌"} ${label}: ${detail}`);
}

// S1: BUY straight to SL — price only moves down, never comes near TP1
console.log("\nS1: BUY straight to SL");
const r1 = resolveSignalWithBars(base, [
  bar(T0 + 2*oneMin, P+0.5, P-1.5, P-1),
  bar(T0 + 3*oneMin, P-0.5, P-3.5, P-3),
  bar(T0 + 4*oneMin, P-2,   P-6,   P-5),
  bar(T0 + 5*oneMin, P-4,   P-9,   P-7),
]);
check("S1a", r1.newStatus === "SL_HIT", `status=${r1.newStatus}`);
check("S1b", r1.outcomeResult === "LOSS", `outcome=${r1.outcomeResult}`);

// S2: SELL hits all 3 TPs
console.log("S2: SELL hits all 3 TPs");
const sbase: any = { ...base, type: "SELL", id: "s2",
  tp1: P - 30 * PIP, tp2: P - 60 * PIP, tp3: P - 90 * PIP, sl: P + 70 * PIP };
const r2 = resolveSignalWithBars(sbase, [
  bar(T0 + 2*oneMin, P-1, P-3.5, P-3),
  bar(T0 + 3*oneMin, P-3, P-5.5, P-5),
  bar(T0 + 4*oneMin, P-5, P-7,   P-6),
  bar(T0 + 5*oneMin, P-7, P-10,  P-9),
]);
check("S2a", r2.newStatus === "ALL_TARGETS_HIT", `status=${r2.newStatus}`);
check("S2b", r2.outcomeResult === "WIN", `outcome=${r2.outcomeResult}`);

// S3: BUY hits TP1, then retraces past entry+1.5 (15-pip lock)
console.log("S3: BUY TP1 → retrace past entry+1.5");
const r3 = resolveSignalWithBars({ ...base, id: "s3" }, [
  bar(T0 + 2*oneMin, P+1, P-0.5, P+0.5),
  bar(T0 + 3*oneMin, P+4, P+1,   P+3),    // Hits TP1 at P+3
  bar(T0 + 4*oneMin, P+2, P+0.5, P+1),     // Low P+0.5 < lock P+1.5 → lock hit
]);
check("S3a", r3.newStatus === "SL_AFTER_BE", `status=${r3.newStatus} (exit=${r3.exitPrice.toFixed(1)})`);
check("S3b", r3.outcomeResult === "WIN", `outcome=${r3.outcomeResult}`);

// S4: SELL hits TP1, then retraces past entry-1.5
console.log("S4: SELL TP1 → retrace past entry-1.5");
const r4 = resolveSignalWithBars(sbase, [
  bar(T0 + 2*oneMin, P+0.5, P-3, P-2),
  bar(T0 + 3*oneMin, P-2,   P-4, P-3),     // Hits TP1 at P-3
  bar(T0 + 4*oneMin, P,     P-1, P-0.5),    // High P goes above lock P-1.5
]);
check("S4a", r4.newStatus === "SL_AFTER_BE", `status=${r4.newStatus} (exit=${r4.exitPrice.toFixed(1)})`);
check("S4b", r4.outcomeResult === "WIN", `outcome=${r4.outcomeResult}`);

// S5: BUY hits TP1+TP2, then retraces to entry (partial win)
console.log("S5: BUY TP1+TP2 → retrace to entry");
const r5 = resolveSignalWithBars({ ...base, id: "s5" }, [
  bar(T0 + 2*oneMin, P+2, P-0.3, P+1),
  bar(T0 + 3*oneMin, P+4, P+1,   P+3),
  bar(T0 + 4*oneMin, P+7, P+4,   P+6),
  bar(T0 + 5*oneMin, P+3, P-0.3, P-0.1),
]);
check("S5a", r5.newStatus === "PARTIAL_WIN_SL_HIT", `status=${r5.newStatus} (exit=${r5.exitPrice.toFixed(1)})`);
check("S5b", r5.outcomeResult === "WIN", `outcome=${r5.outcomeResult}`);

// S6: SELL pre-TP1 SL hit → LOSS
console.log("S6: SELL pre-TP1 SL hit");
const r6 = resolveSignalWithBars(sbase, [
  bar(T0 + 2*oneMin, P+1, P-0.5, P+0.5),
  bar(T0 + 3*oneMin, P+4, P+1, P+2),
  bar(T0 + 4*oneMin, P+8, P+6, P+7),
]);
check("S6a", r6.newStatus === "SL_HIT", `status=${r6.newStatus}`);
check("S6b", r6.outcomeResult === "LOSS", `outcome=${r6.outcomeResult}`);

// S7: The exact 8:09 SELL scenario — straight to TP3, NO SL wick
console.log("S7: 8:09 SELL straight to TP3");
const r7 = resolveSignalWithBars({ ...sbase, id: "8:09" }, [
  bar(T0 + 2*oneMin, P-1, P-3, P-2.5),
  bar(T0 + 3*oneMin, P-3, P-5, P-4),
  bar(T0 + 4*oneMin, P-5, P-7.5, P-7),
  bar(T0 + 5*oneMin, P-7, P-9.5, P-9),
]);
check("S7a", r7.newStatus === "ALL_TARGETS_HIT", `status=${r7.newStatus}`);
check("S7b", r7.outcomeResult === "WIN", `outcome=${r7.outcomeResult}`);
check("S7c", r7.newStatus !== "SL_HIT", "should NOT be SL_HIT (that was the false recording)");

// S8: fromScratch UNDOES a falsely-recorded ALL_TARGETS_HIT when price action
// shows the trade never reached TP1 (the exact bug: all 3 TP "touched" off a
// phantom spike). createdAt 3h ago so the signal is matured.
console.log("S8: fromScratch corrects false ALL_TARGETS_HIT (price never reached TP1)");
const threeHoursAgo = T0 - 3 * 60 * 60 * 1000;
const falseWin: any = { ...base, id: "false-win", status: "ALL_TARGETS_HIT", targetsHit: 3,
  timestamp: new Date(threeHoursAgo), createdAt: threeHoursAgo };
const falseWinBars = [
  bar(threeHoursAgo + 2*oneMin, P+0.5, P-0.5, P),     // entry filled, hovers
  bar(threeHoursAgo + 3*oneMin, P+1,   P-1,   P+0.2),  // never reaches TP1 (P+3)
  bar(threeHoursAgo + 4*oneMin, P+0.8, P-0.8, P-0.1),
];
const r8 = resolveSignalWithBars(falseWin, falseWinBars, { fromScratch: true, evalNowMs: T0 });
check("S8a", r8.newStatus !== "ALL_TARGETS_HIT", `status=${r8.newStatus} (was falsely ALL_TARGETS_HIT)`);
check("S8b", r8.targetsHit === 0, `targetsHit=${r8.targetsHit}`);
check("S8c", r8.outcomeResult !== "WIN", `outcome=${r8.outcomeResult}`);

// S9: CONTROL — default (forward-seeded) mode still banks a false WIN (it can
// only ratchet forward, here relabelling to PARTIAL_WIN_SL_HIT), proving
// fromScratch is required for the audit to actually undo a false terminal.
console.log("S9: forward-seeded mode still reports a false WIN (control)");
const r9 = resolveSignalWithBars(falseWin, falseWinBars);
check("S9a", r9.outcomeResult === "WIN", `outcome=${r9.outcomeResult} (forward-seeded cannot undo the false win)`);
check("S9b", r8.outcomeResult !== r9.outcomeResult, `fromScratch=${r8.outcomeResult} vs forward=${r9.outcomeResult}`);

// S10: fromScratch still HONORS a genuine win — real move to TP3 stays a win.
console.log("S10: fromScratch keeps a genuine ALL_TARGETS_HIT");
const realWin: any = { ...base, id: "real-win", status: "ALL_TARGETS_HIT", targetsHit: 3,
  timestamp: new Date(threeHoursAgo), createdAt: threeHoursAgo };
const r10 = resolveSignalWithBars(realWin, [
  bar(threeHoursAgo + 2*oneMin, P+2,  P-0.3, P+1),
  bar(threeHoursAgo + 3*oneMin, P+5,  P+1,   P+4),
  bar(threeHoursAgo + 4*oneMin, P+9.5,P+4,   P+9),   // high P+9.5 >= TP3 (P+9)
], { fromScratch: true, evalNowMs: T0 });
check("S10a", r10.newStatus === "ALL_TARGETS_HIT", `status=${r10.newStatus}`);
check("S10b", r10.outcomeResult === "WIN", `outcome=${r10.outcomeResult}`);

// S11: THE 12:55 BUG — a SELL signal's 1-minute bar spans BOTH the original
// SL level AND TP2, with TP2 sitting much closer to the bar's open (i.e. the
// chart really ran to TP2 first before any SL-side wick). The old code always
// resolved the SL side first regardless of proximity to open, discarding the
// real TP2 hit and reporting a false SL_HIT/LOSS. The fix must bank TP1+TP2
// first since they're the closer-to-open levels.
console.log("S11: same-bar ambiguity — SELL bar spans SL AND TP2, TP2 closer to open (the reported 12:55 bug)");
const sellAmbig: any = { ...base, type: "SELL", id: "1255-sell",
  entryPrice: P, entryPriceWithSlippage: P + 1.0,
  tp1: P - 30 * PIP, tp2: P - 60 * PIP, tp3: P - 90 * PIP, sl: P + 70 * PIP };
const r11 = resolveSignalWithBars(sellAmbig, [
  bar(T0 + 2*oneMin, P + 0.5, P - 1, P),                       // entry fill bar
  // open sits right at TP2 (P-6), but the bar's high also wicks through the
  // original SL (P+7) — a genuinely ambiguous single 1-min candle.
  { timestamp: T0 + 3*oneMin, open: P - 6, high: P + 7.2, low: P - 6.5, close: P - 6.2 },
]);
check("S11a", r11.newStatus !== "SL_HIT", `status=${r11.newStatus} (must NOT be the false SL_HIT)`);
check("S11b", r11.targetsHit >= 2, `targetsHit=${r11.targetsHit} (TP2 was closer to open, must be banked)`);
check("S11c", r11.outcomeResult === "WIN", `outcome=${r11.outcomeResult}`);

// S12: CONTROL — same bar shape, but now the original SL level sits closer to
// open than TP2 (i.e. price genuinely stopped out first, then merely wicked
// toward TP2 afterward in the same candle). Must still resolve as a real loss.
console.log("S12: same-bar ambiguity control — SL closer to open than TP2 stays a real SL_HIT");
const sellAmbig2: any = { ...sellAmbig, id: "1255-sell-control" };
const r12 = resolveSignalWithBars(sellAmbig2, [
  bar(T0 + 2*oneMin, P + 0.5, P - 1, P),
  { timestamp: T0 + 3*oneMin, open: P + 6.8, high: P + 7.2, low: P - 6.5, close: P - 6.2 },
]);
check("S12a", r12.newStatus === "SL_HIT", `status=${r12.newStatus} (SL genuinely closer to open here)`);
check("S12b", r12.outcomeResult === "LOSS", `outcome=${r12.outcomeResult}`);

// S13-S15: STEP 3 FIX — the fromScratch "matured, no terminal bar event fired"
// branch (ACTIVE/TP1_HIT/TP2_HIT held past the 2h maturity window with no real
// SL/TP bar crossing) previously never set resolvedAtBarTs, silently falling
// back to whatever the caller substitutes for a missing bar timestamp (real
// wall-clock time at whenever reconciliation happened to run) — the exact
// mechanism confirmed to produce two UNRELATED signals sharing one identical
// exit timestamp. Confirm a genuine bar-derived timestamp (the last real bar
// actually evaluated, NOT Date.now()) is now always set for all three matured
// sub-outcomes.
console.log("S13: fromScratch matured PARTIAL_WIN_SL_HIT (TP1+TP2 banked, runner never resolved) now sets a real resolvedAtBarTs");
const maturedTp2Runner: any = { ...base, id: "matured-tp2-runner", status: "TP2_HIT", targetsHit: 2,
  timestamp: new Date(threeHoursAgo), createdAt: threeHoursAgo };
const maturedTp2Bars = [
  bar(threeHoursAgo + 2*oneMin, P+0.5, P-0.5, P),        // entry fill
  bar(threeHoursAgo + 3*oneMin, P+4,   P+2,   P+3.5),    // banks TP1 (P+3)
  bar(threeHoursAgo + 4*oneMin, P+7,   P+4,   P+6.5),    // banks TP2 (P+6), stays below TP3 (P+9)
  bar(threeHoursAgo + 5*oneMin, P+8,   P+5,   P+7),      // last real bar — stays between TP2/TP3, never breaches entry, never hits TP3
];
const lastMaturedTp2BarTs = maturedTp2Bars[maturedTp2Bars.length - 1].timestamp;
const realNowAtCallTime = Date.now();
const r13 = resolveSignalWithBars(maturedTp2Runner, maturedTp2Bars, { fromScratch: true, evalNowMs: T0 });
check("S13a", r13.newStatus === "PARTIAL_WIN_SL_HIT", `status=${r13.newStatus}`);
check("S13b", r13.resolvedAtBarTs !== undefined, `resolvedAtBarTs=${r13.resolvedAtBarTs} (must not be undefined -- undefined is what previously forced a Date.now() fallback downstream)`);
check("S13c", r13.resolvedAtBarTs === lastMaturedTp2BarTs, `resolvedAtBarTs=${r13.resolvedAtBarTs} matches last real evaluated bar ${lastMaturedTp2BarTs}, not some other value`);
check("S13d", r13.resolvedAtBarTs !== undefined && Math.abs((r13.resolvedAtBarTs as number) - realNowAtCallTime) > 60_000, `resolvedAtBarTs (${r13.resolvedAtBarTs}) is genuinely far from wall-clock call time (${realNowAtCallTime}) -- confirms it's bar-derived, not a disguised Date.now()`);

console.log("S14: fromScratch matured SL_AFTER_BE (TP1 banked only, runner never resolved) now sets a real resolvedAtBarTs");
const maturedTp1Runner: any = { ...base, id: "matured-tp1-runner", status: "TP1_HIT", targetsHit: 1, breakevenReached: true,
  timestamp: new Date(threeHoursAgo), createdAt: threeHoursAgo };
const maturedTp1Bars = [
  bar(threeHoursAgo + 2*oneMin, P+0.5, P-0.5, P),        // entry fill
  bar(threeHoursAgo + 3*oneMin, P+4,   P+2,   P+3.5),    // banks TP1 (P+3), stays above the 1.5-pip lock throughout
  bar(threeHoursAgo + 4*oneMin, P+5,   P+3,   P+4.5),    // stays below TP2 (P+6), above lock
  bar(threeHoursAgo + 5*oneMin, P+5.5, P+3.5, P+4.8),    // last real bar — never retraces to lock, never hits TP2
];
const lastMaturedTp1BarTs = maturedTp1Bars[maturedTp1Bars.length - 1].timestamp;
const r14 = resolveSignalWithBars(maturedTp1Runner, maturedTp1Bars, { fromScratch: true, evalNowMs: T0 });
check("S14a", r14.newStatus === "SL_AFTER_BE", `status=${r14.newStatus}`);
check("S14b", r14.resolvedAtBarTs !== undefined, `resolvedAtBarTs=${r14.resolvedAtBarTs} (must not be undefined)`);
check("S14c", r14.resolvedAtBarTs === lastMaturedTp1BarTs, `resolvedAtBarTs=${r14.resolvedAtBarTs} matches last real evaluated bar ${lastMaturedTp1BarTs}`);

console.log("S15: fromScratch matured CLOSED (entry filled, no TP/SL ever printed) now sets a real resolvedAtBarTs");
const maturedFlat: any = { ...base, id: "matured-flat", status: "ACTIVE", targetsHit: 0,
  timestamp: new Date(threeHoursAgo), createdAt: threeHoursAgo };
const maturedFlatBars = [
  bar(threeHoursAgo + 2*oneMin, P+0.5, P-0.5, P),
  bar(threeHoursAgo + 3*oneMin, P+0.8, P-0.3, P+0.2),
  bar(threeHoursAgo + 4*oneMin, P+0.6, P-0.6, P-0.1),  // last real bar — hovers, never reaches TP1 or SL
];
const lastMaturedFlatBarTs = maturedFlatBars[maturedFlatBars.length - 1].timestamp;
const r15 = resolveSignalWithBars(maturedFlat, maturedFlatBars, { fromScratch: true, evalNowMs: T0 });
check("S15a", r15.newStatus === "CLOSED", `status=${r15.newStatus}`);
check("S15b", r15.resolvedAtBarTs !== undefined, `resolvedAtBarTs=${r15.resolvedAtBarTs} (must not be undefined)`);
check("S15c", r15.resolvedAtBarTs === lastMaturedFlatBarTs, `resolvedAtBarTs=${r15.resolvedAtBarTs} matches last real evaluated bar ${lastMaturedFlatBarTs}`);

console.log(`\n${pass}/${pass+fail} assertions passed.`);
if (fail > 0) { console.error(`❌ ${fail} FAILED`); process.exit(1); }
else console.log("✅ All tick-for-tick scenarios verified — resolver correct.");
