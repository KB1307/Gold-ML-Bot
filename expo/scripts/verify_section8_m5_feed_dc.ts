/**
 * ITEM DC — SECTION 8 acceptance: renders the new M5 FEED FAILURE REASONS block
 * through the REAL buildDiagnosticsExportText, in the THREE states the engine
 * can produce:
 *   A. populated counters reproducing the reported scenario scale (4,001 checks
 *      / 2,346 stand-asides = 58.6%, reason "M5 series ABSENT") — values are
 *      SYNTHETIC: the engine populates them on-device as the two fetch paths
 *      fail; the live "which reason dominates" answer comes from the user's
 *      30-minute observation export.
 *   B. directionalLayerStats WITHOUT m5FeedDiagnostics (older caller shape) —
 *      the block must be absent, nothing may crash.
 *   C. m5FeedDiagnostics present but all-zero — truthful "none this process".
 * Read-only: writes nothing, touches no DB.
 *
 * Run: cd expo && bun scripts/verify_section8_m5_feed_dc.ts
 */
import { buildDiagnosticsExportText } from "../services/diagnosticsExport";

const RECENT = [
  { ts: Date.parse("2026-09-08T15:20:56Z"), reason: "M5 series ABSENT — gold_m1_bars not ingested (sync stalled or cold start)", m5Bars: 0, newestM5AgeMin: null },
];

type FeedPath = {
  counters: { fetch_error: number; zero_rows: number; all_stale: number; interval_guard: number };
  lastReason: string | null;
  lastReasonAt: number | null;
  lastDetail: string | null;
};

const ZERO_PATH: FeedPath = { counters: { fetch_error: 0, zero_rows: 0, all_stale: 0, interval_guard: 0 }, lastReason: null, lastReasonAt: null, lastDetail: null };

function render(withFeed: "populated" | "absent" | "allZero"): string {
  let m5FeedDiagnostics: { item3: FeedPath; f1: FeedPath } | undefined;
  if (withFeed === "populated") {
    m5FeedDiagnostics = {
      item3: { counters: { fetch_error: 1, zero_rows: 3, all_stale: 0, interval_guard: 40 }, lastReason: "interval_guard", lastReasonAt: Date.parse("2026-09-08T15:22:10Z"), lastDetail: "refresh skipped with 212s left on the 5-min guard, series empty" },
      f1: { counters: { fetch_error: 2, zero_rows: 41, all_stale: 1, interval_guard: 0 }, lastReason: "zero_rows", lastReasonAt: Date.parse("2026-09-08T15:20:40Z"), lastDetail: "0 rows from gold_m1_bars — series nulled, not retried (data condition, not transport)" },
    };
  } else if (withFeed === "allZero") {
    m5FeedDiagnostics = { item3: ZERO_PATH, f1: ZERO_PATH };
  }
  const input = {
    signalHistory: [],
    modelHealth: {
      modelHealthScore: 74,
      featureCorrelationStatus: "HEALTHY",
      confidenceDegradation: 0.021,
      conceptDriftScore: 0,
      featureImportanceDrift: [],
      driftAlertLevel: "NONE",
      daysSinceRetrain: 0,
      retrainingRecommended: false,
      retrainScheduled: false,
      retrainScheduledAtMs: null,
      retrainScheduledReason: null,
      liveFeatureDrift: [],
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
    directionalLayerStats: {
      checks: 4001,
      standAsides: 2346,
      readyNow: false,
      rate24h: null,
      checks24h: null,
      standAsides24h: null,
      recent: RECENT,
      m5FeedDiagnostics,
    },
  } as unknown as Parameters<typeof buildDiagnosticsExportText>[0];
  const text = buildDiagnosticsExportText(input);
  const start = text.indexOf("SECTION 8");
  if (start < 0) return "(SECTION 8 not rendered)";
  const next9 = text.indexOf("SECTION 9", start);
  const end = next9 > 0 ? next9 : text.indexOf("END OF EXPORT");
  return text.slice(start, end > start ? end : undefined);
}

function main(): void {
  const populated = render("populated");
  const absent = render("absent");
  const allZero = render("allZero");

  console.log("════ A. POPULATED counters (synthetic values, engine-shaped) ════\n");
  console.log(populated);
  console.log("════ C. ALL-ZERO counters (feed healthy this process) ════\n");
  console.log(allZero.split("\n").filter((l) => l.includes("FEED") || l.includes("last failure") || l.includes("ITEM 3 refresh") || l.includes("F1 bar series")).join("\n"));

  const checks: [string, boolean][] = [
    ["A: header names in-process + reset", populated.includes("M5 FEED FAILURE REASONS (Item DC — in-process counters, reset on app restart):")],
    ["A: item3 path line format", populated.includes("ITEM 3 refresh (refreshM5SupabaseBars): fetch_error=1 zero_rows=3 all_stale=0 interval_guard=40")],
    ["A: f1 path line format", populated.includes("F1 bar series (refreshBarSeries — the series the reasons above read): fetch_error=2 zero_rows=41 all_stale=1 interval_guard=0")],
    ["A: last failure = MOST RECENT across both paths (item3 15:22:10 > f1 15:20:40)", /last failure: \[item3\] interval_guard at 2026-09-08T15:22:10/.test(populated) && populated.includes("refresh skipped with 212s left on the 5-min guard, series empty")],
    ["A: existing SECTION 8 body untouched", populated.includes("Readiness checks this process: 4001") && populated.includes("Stand-aside rate: 58.64%") && populated.includes("M5 series ABSENT — gold_m1_bars not ingested (sync stalled or cold start) (m5Bars=0)")],
    ["B: block absent when not instrumented (no crash)", !absent.includes("M5 FEED FAILURE REASONS") && absent.includes("Readiness checks this process: 4001")],
    ["C: all-zero renders + truthful last failure", allZero.includes("fetch_error=0 zero_rows=0 all_stale=0 interval_guard=0") && allZero.includes("last failure: none this process")],
  ];
  let pass = true;
  for (const [name, ok] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${name}`);
    if (!ok) pass = false;
  }
  console.log(pass ? "\nITEM DC GATE: PASS (SECTION 8 M5 FEED FAILURE REASONS renders through the real export builder)" : "\nITEM DC GATE: FAIL");
  if (!pass) process.exitCode = 1;
}

main();
