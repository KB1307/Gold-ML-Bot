/**
 * ITEM DD — SECTION 12 suppressed-gate books acceptance. Read-only.
 *
 * State A (synthetic, labelled): engine-shaped SuppressedBookStats rendered
 * through the REAL buildDiagnosticsExportText — exercises all three gate
 * states (n>=30 & EV>0 refutation, accumulating <30, VETO STANDS at n>=30
 * & EV<=0).
 * State B (live): the REAL fetchShadowForwardBooksStats via the anon key —
 * prints the suppressed block from live data (all live suppressed rows are
 * pre-CD: excluded by the resolver's step-2 skip notes; decided 0).
 *
 * Run: cd expo && bun scripts/verify_section12_suppressed_books_dd.ts
 */
import { createClient } from "@supabase/supabase-js";
import {
  buildDiagnosticsExportText,
  fetchShadowForwardBooksStats,
  type ShadowForwardBooksStats,
  type SuppressedBookStats,
} from "../services/diagnosticsExport";

function syntheticStats(): ShadowForwardBooksStats {
  const book = (name: SuppressedBookStats["candidateName"], over: Partial<SuppressedBookStats>): SuppressedBookStats => ({
    candidateName: name,
    firstEntryAt: "2026-09-08T06:12:00.000Z",
    totalRows: 0,
    excludedPreV2: 0,
    malformedV2: 0,
    unresolved: 0,
    decided: 0,
    wins: 0,
    stopOuts: 0,
    flat: 0,
    sumPnl$: 0,
    evPerTrade$: null,
    ...over,
  });
  // EV = sumPnl$ / decided (resolver resolvedPnlPrice is already $).
  return {
    generatedAt: "2026-09-09T00:00:00.000Z",
    books: {
      SCORED_DT_SHORT: { candidateName: "SCORED_DT_SHORT", totalRows: 0 } as never,
      SCORED_REOPEN_LONG: { candidateName: "SCORED_REOPEN_LONG", totalRows: 0 } as never,
      ZONE_RETEST_LONG: { candidateName: "ZONE_RETEST_LONG", totalRows: 0 } as never,
    },
    suppressedBooks: {
      BAND_VETO_SUPPRESSED: book("BAND_VETO_SUPPRESSED", {
        totalRows: 47, excludedPreV2: 17, decided: 30, wins: 20, stopOuts: 9, flat: 1,
        sumPnl$: 25.4, evPerTrade$: 25.4 / 30,
      }),
      DRIFT_VETO_SUPPRESSED: book("DRIFT_VETO_SUPPRESSED", {
        totalRows: 2167, excludedPreV2: 2155, decided: 12, wins: 6, stopOuts: 5, flat: 1,
        sumPnl$: 2.5, evPerTrade$: 2.5 / 12,
      }),
      MID_RSI_SUPPRESSED: book("MID_RSI_SUPPRESSED", {
        totalRows: 1116, excludedPreV2: 1076, decided: 40, wins: 18, stopOuts: 20, flat: 2,
        sumPnl$: -16, evPerTrade$: -16 / 40,
      }),
    },
    combined: { aboveRows: 0, decidedAbove: 0, wins: 0, stopOuts: 0, sumR$: 0, evPerTrade$: null },
  } as unknown as ShadowForwardBooksStats;
}

async function main(): Promise<void> {
  let failures = 0;
  const check = (label: string, ok: boolean): void => {
    console.log(`${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures += 1;
  };

  // ── State A: synthetic through the REAL builder ──
  const inputA = {
    shadowForwardBooks: syntheticStats(),
    signalHistory: [],
    modelHealth: {
      modelHealthScore: 0, featureCorrelationStatus: "N/A", confidenceDegradation: 0,
      conceptDriftScore: 0, driftAlertLevel: "N/A", daysSinceRetrain: 0,
      retrainingRecommended: false, retrainScheduled: false, featureImportanceDrift: [],
      liveFeatureDrift: [],
    },
    performanceMetrics: {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, profitFactor: 0,
      sharpeRatio: 0, expectancy: 0, averageWin: 0, averageLoss: 0, totalProfit: 0,
      totalLoss: 0, maxDrawdown: 0, currentDrawdown: 0,
    },
  } as unknown as Parameters<typeof buildDiagnosticsExportText>[0];
  const textA = buildDiagnosticsExportText(inputA);

  check("A: suppressed header present", textA.includes("SUPPRESSED-GATE FORWARD BOOKS (ITEM DD — outcomes from the Item DA shadow resolver):"));
  check("A: BAND EV line (30 decided, EV $0.85/trade)", textA.includes("decided 30 (TP 20 / SL 9 / TIME 1) | EV $0.85/trade (resolver resolvedPnlPrice, row's own geometry)"));
  check("A: refutation line verbatim (BAND, n=30, EV>0)", textA.includes("GATE: ⚠️ THIS GATE IS REMOVING PROFITABLE SIGNALS. (n=30 decided, EV $0.85/trade > 0)"));
  check("A: DRIFT accumulating (12/30)", textA.includes("GATE: NOT DECIDED — 12/30 decided (accumulating)"));
  check("A: MID veto stands (40 decided, EV $-0.40)", textA.includes("decided 40 (TP 18 / SL 20 / TIME 2) | EV $-0.40/trade") && textA.includes("GATE: VETO STANDS (EV <= 0 at n=40 decided) — REPORT ONLY"));
  check("A: pre-CD exclusion + still-open counted", textA.includes("rows 47 since 2026-09-08T06:12:00.000Z | pre-CD excluded 17 | malformed 0 | still open 0"));
  check("A: strategy-books body untouched (CF header)", textA.includes("SECTION 12 — SHADOW FORWARD BOOKS (ITEM CF, read-only)"));

  // ── State B: live fetch through the real path ──
  const client = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL!,
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const stats = await fetchShadowForwardBooksStats(client);
  const names = Object.keys(stats.suppressedBooks);
  check("B: fetch returns all three suppressed books", names.includes("BAND_VETO_SUPPRESSED") && names.includes("DRIFT_VETO_SUPPRESSED") && names.includes("MID_RSI_SUPPRESSED"));
  console.log(
    `B live: BAND rows=${stats.suppressedBooks.BAND_VETO_SUPPRESSED.totalRows} excluded=${stats.suppressedBooks.BAND_VETO_SUPPRESSED.excludedPreV2} decided=${stats.suppressedBooks.BAND_VETO_SUPPRESSED.decided} | ` +
    `DRIFT rows=${stats.suppressedBooks.DRIFT_VETO_SUPPRESSED.totalRows} excluded=${stats.suppressedBooks.DRIFT_VETO_SUPPRESSED.excludedPreV2} decided=${stats.suppressedBooks.DRIFT_VETO_SUPPRESSED.decided} | ` +
    `MID rows=${stats.suppressedBooks.MID_RSI_SUPPRESSED.totalRows} excluded=${stats.suppressedBooks.MID_RSI_SUPPRESSED.excludedPreV2} decided=${stats.suppressedBooks.MID_RSI_SUPPRESSED.decided}`,
  );

  const inputB = { ...inputA, shadowForwardBooks: stats } as unknown as Parameters<typeof buildDiagnosticsExportText>[0];
  const textB = buildDiagnosticsExportText(inputB);
  const start = textB.indexOf("SUPPRESSED-GATE FORWARD BOOKS");
  const end = textB.indexOf("SECTION 13") > 0 ? textB.indexOf("SECTION 13") : textB.indexOf("END OF EXPORT");
  check("B: suppressed block renders from live data (no crash)", start >= 0 && end > start);
  if (start >= 0 && end > start) console.log("\n" + textB.slice(start, end));

  console.log(failures === 0 ? "\nITEM DD GATE: PASS (suppressed-gate books render through the real export builder)" : `\nITEM DD GATE: FAIL (${failures} check(s) failed)`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("ITEM DD GATE: FAIL", error);
  process.exitCode = 1;
});
