/**
 * ITEM CF (wiring) — headless run of the WIRED settings.tsx export path.
 * handleExportDiagnostics() cannot be tapped from the sandbox (no device
 * streaming), so this script reproduces the exact wiring added to
 * app/(tabs)/settings.tsx: the same dedicated Supabase client (same
 * storageKey), the same fetchShadowForwardBooksStats(client) Promise.all
 * slot, and the same `shadowForwardBooks` input into the REAL
 * buildDiagnosticsExportText. Engine/context-derived inputs (signalHistory,
 * modelWeights, modelHealth, performanceMetrics, ...) cannot run headless —
 * they keep the minimal stubs; none affects SECTION 12, which depends only
 * on shadowForwardBooks.
 *
 * Run: cd expo && bun scripts/verify_section12_live_wiring.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  buildDiagnosticsExportText,
  fetchShadowForwardBooksStats,
} from "../services/diagnosticsExport";

// VERBATIM mirror of the module-level client in app/(tabs)/settings.tsx.
let section12BooksClient: SupabaseClient | null = null;
const getSection12BooksClient = (): SupabaseClient | null => {
  if (section12BooksClient) return section12BooksClient;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  section12BooksClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, storageKey: "rork-svc-section12-books" },
  });
  return section12BooksClient;
};

async function main(): Promise<void> {
  console.log("── Running the wired settings.tsx SECTION 12 path ──");

  // Same Promise.all slot the wired settings.tsx uses. Its Supabase-backed
  // siblings (getRecentDiagnosticEvents, fetchShadowSellSummary,
  // fetchTelegramOutboxSummary) import react-native/AsyncStorage and cannot
  // run headless — here only the SECTION 12 fetch executes.
  const shadowForwardBooks = await (async () => {
    const client = getSection12BooksClient();
    return client ? await fetchShadowForwardBooksStats(client) : null;
  })().catch(() => null);

  if (!shadowForwardBooks) {
    console.log("ITEM CF WIRING GATE: FAIL (shadowForwardBooks null — wiring did not fetch)");
    process.exitCode = 1;
    return;
  }

  const input = {
    shadowForwardBooks,
    // Same minimal stubs as the sandbox cannot run the engine singletons.
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
    console.log("ITEM CF WIRING GATE: FAIL (SECTION 12 not rendered by the wired path)");
    process.exitCode = 1;
    return;
  }
  console.log(text.slice(start - 72, end));
  console.log("\nITEM CF WIRING GATE: PASS (SECTION 12 rendered via the wired settings.tsx path)");
}

main().catch((error) => {
  console.error("ITEM CF WIRING GATE: FAIL", error);
  process.exitCode = 1;
});
