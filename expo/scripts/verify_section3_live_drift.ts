/**
 * ITEM DB — SECTION 3 acceptance: renders the new LIVE WINDOW DRIFT block and
 * the CORPUS DRIFT header through the REAL buildDiagnosticsExportText, in BOTH
 * states the engine can produce:
 *   A. a populated snapshot — entries shaped EXACTLY as detectConceptDrift
 *      writes them (property names/types), reproducing the reported scenario
 *      scale (conceptDriftScore 1.1872 / HIGH). The VALUES are synthetic: the
 *      engine populates them on-device at the next 4h drift cycle, so the live
 *      "which feature dominates" answer comes from the user's export.
 *   B. an empty snapshot — proves the truthful fallback for a build that has
 *      not completed a drift cycle yet.
 * Read-only: writes nothing, touches no DB.
 *
 * Run: cd expo && bun scripts/verify_section3_live_drift.ts
 */
import { buildDiagnosticsExportText } from "../services/diagnosticsExport";

const CORPUS_ROWS = [
  { feature: "rsi", historicalImportance: 52.1, currentImportance: 52.3, drift: 0.066, status: "STABLE" },
  { feature: "atr", historicalImportance: 8.2, currentImportance: 8.1, drift: 0.139, status: "STABLE" },
  { feature: "volumeRatio", historicalImportance: 1.02, currentImportance: 1.03, drift: 0.113, status: "STABLE" },
  { feature: "dxyChange", historicalImportance: -0.1, currentImportance: -0.1, drift: 0.0, status: "STABLE" },
  { feature: "sentiment_score", historicalImportance: 0.2, currentImportance: 0.9, drift: 0.972, status: "CRITICAL" },
];

// Shape mirrors the engine's liveFeatureDrift push (signalEngine.ts, ITEM DB).
const LIVE_SNAPSHOT = [
  { feature: "rsi", recentMean: 54.2, historicalMean: 53.8, recentStd: 4.1, historicalStd: 4.3, meanShift: 0.093, stdShift: 0.046, drift: 0.0695 },
  { feature: "atr", recentMean: 7.9, historicalMean: 8.0, recentStd: 0.8, historicalStd: 0.9, meanShift: 0.11, stdShift: 0.11, drift: 0.11 },
  { feature: "dxyChange", recentMean: 0.0009, historicalMean: 0.0007, recentStd: 0.0004, historicalStd: 0.0005, meanShift: 0.333, stdShift: 0.133, drift: 0.233 },
  { feature: "volumeRatio", recentMean: 1.42, historicalMean: 1.01, recentStd: 0.06, historicalStd: 0.03, meanShift: 10.25, stdShift: 1.0, drift: 5.625 },
  { feature: "orderFlow_volumeImbalance", recentMean: 0.12, historicalMean: 0.1, recentStd: 0.2, historicalStd: 0.21, meanShift: 0.095, stdShift: 0.048, drift: 0.0715 },
];

function render(liveFeatureDrift: typeof LIVE_SNAPSHOT | []): string {
  const input = {
    signalHistory: [],
    modelHealth: {
      modelHealthScore: 74,
      featureCorrelationStatus: "HEALTHY",
      confidenceDegradation: 0.021,
      conceptDriftScore: 1.1872,
      driftAlertLevel: "HIGH",
      daysSinceRetrain: 2.3,
      retrainingRecommended: true,
      retrainScheduled: false,
      featureImportanceDrift: CORPUS_ROWS,
      liveFeatureDrift,
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
  const start = text.indexOf("SECTION 3");
  if (start < 0) return "(SECTION 3 not rendered)";
  const next4 = text.indexOf("SECTION 4", start);
  const end = next4 > 0 ? next4 : text.indexOf("END OF EXPORT");
  return text.slice(start, end > start ? end : undefined);
}

function main(): void {
  const populated = render(LIVE_SNAPSHOT);
  const empty = render([]);

  console.log("════ A. POPULATED snapshot (synthetic values, engine-shaped) ════\n");
  console.log(populated);
  console.log("════ B. EMPTY snapshot (no drift cycle since build) ════\n");
  console.log(empty);

  const checks: [string, boolean][] = [
    ["A: LIVE WINDOW header", populated.includes("LIVE WINDOW DRIFT (detectConceptDrift — this is what sets driftAlertLevel):")],
    ["A: per-feature line format", /  volumeRatio: drift 5\.625  \(recentMean 1\.42 vs historicalMean 1\.01, historicalStd 0\.03\)/.test(populated)],
    ["A: average + alert line", populated.includes("average (sentiment_score excluded per Item BE): 1.1872  ->  alert HIGH")],
    ["A: CORPUS DRIFT header", populated.includes("CORPUS DRIFT (analyzeFeatureValueDrift — diagnostics only, does NOT gate):")],
    ["A: existing corpus table untouched", populated.includes("Feature value drift (avg feature value among winners, not marginal contribution):") && populated.includes("rsi: 52.100 -> 52.300 (drift 0.066, STABLE)")],
    ["B: truthful empty fallback", empty.includes("(no live drift cycle recorded since this build — renders after the next drift check)")],
  ];
  let pass = true;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${name}`);
    if (!ok) pass = false;
  }
  console.log(pass ? "\nITEM DB GATE: PASS (SECTION 3 LIVE WINDOW DRIFT renders through the real export builder)" : "\nITEM DB GATE: FAIL");
  if (!pass) process.exitCode = 1;
}

main();
