/**
 * ITEM CF — SECTION 12 acceptance: fetch the shadow forward books DIRECTLY
 * from Supabase (anon key, item249 pattern) and render SECTION 12 through the
 * REAL buildDiagnosticsExportText. Read-only — this script writes nothing.
 *
 * Run: cd expo && bun scripts/verify_section12_shadow_books.ts
 */
import { createClient } from "@supabase/supabase-js";
import {
  buildDiagnosticsExportText,
  fetchShadowForwardBooksStats,
} from "../services/diagnosticsExport";

async function main(): Promise<void> {
  const client = createClient(
    process.env.EXPO_PUBLIC_SUPABASE_URL!,
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  console.log("── Fetching shadow forward books (anon key, paginated) ──");
  const stats = await fetchShadowForwardBooksStats(client);
  console.log(`generatedAt: ${stats.generatedAt}`);

  const input = {
    shadowForwardBooks: stats,
    // Minimal stubs for the REQUIRED (non-optional) section inputs — this
    // script verifies SECTION 12 only; the other sections print their
    // "unavailable" fallbacks. Verified against the format* bodies: these
    // three are the only ones accessed without a null guard.
    signalHistory: [],
    modelHealth: {
      modelHealthScore: 0,
      featureCorrelationStatus: "N/A",
      confidenceDegradation: 0,
      conceptDriftScore: 0,
      driftAlertLevel: "N/A",
      daysSinceRetrain: 0,
      retrainingRecommended: false,
      retrainScheduled: false,
      featureImportanceDrift: [],
    },
    performanceMetrics: {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      profitFactor: 0,
      sharpeRatio: 0,
      expectancy: 0,
      averageWin: 0,
      averageLoss: 0,
      totalProfit: 0,
      totalLoss: 0,
      maxDrawdown: 0,
      currentDrawdown: 0,
    },
  } as unknown as Parameters<typeof buildDiagnosticsExportText>[0];
  const text = buildDiagnosticsExportText(input);

  const start = text.indexOf("SECTION 12");
  const end = text.indexOf("END OF EXPORT");
  if (start < 0 || end < 0) {
    console.log("ITEM CF GATE: FAIL (SECTION 12 not rendered)");
    process.exitCode = 1;
    return;
  }
  console.log(text.slice(start - 72, end));
  console.log("\nITEM CF GATE: PASS (SECTION 12 rendered through the real export builder)");
}

main().catch((error) => {
  console.error("ITEM CF GATE: FAIL", error);
  process.exitCode = 1;
});
