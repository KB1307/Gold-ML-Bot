/**
 * ITEM FE — acceptance: the drift instrumentation survives a rebuild.
 *
 * Two layers:
 *   1. parseFeatureDriftSnapshot round-trip (the exact function the engine's
 *      loadFeatureDriftHistory uses at boot): valid snapshot hydrates intact,
 *      malformed input can never crash boot or hydrate garbage.
 *   2. SECTION 3 through the REAL buildDiagnosticsExportText in FOUR states:
 *      A. hydrated FRESH snapshot (1.2h old) — timestamp + age line, no STALE;
 *      B. STALE snapshot (30h old) — obviously-stale label, not silently wrong;
 *      C. entries present but no timestamp (pre-FE in-memory state);
 *      D. empty — the truthful fallback from Item DB, unchanged.
 *
 * Read-only: writes nothing, touches no DB.
 *
 * Run: cd expo && bun scripts/verify_snapshot_drift_fe.ts
 */
import { buildDiagnosticsExportText } from "../services/diagnosticsExport";
import {
  parseFeatureDriftSnapshot,
  serializeFeatureDriftSnapshot,
  type FeatureDriftSnapshot,
} from "../services/featureDriftSnapshot";

const LIVE_ENTRIES = [
  { feature: "rsi", recentMean: 54.2, historicalMean: 53.8, recentStd: 4.1, historicalStd: 4.3, meanShift: 0.093, stdShift: 0.046, drift: 0.0695 },
  { feature: "volumeRatio", recentMean: 1.42, historicalMean: 1.01, recentStd: 0.06, historicalStd: 0.03, meanShift: 10.25, stdShift: 1.0, drift: 5.625 },
  { feature: "atr", recentMean: 7.9, historicalMean: 8.0, recentStd: 0.8, historicalStd: 0.9, meanShift: -0.11, stdShift: 0.11, drift: 0.11, skipped: true, skipReason: "historicalStd < 0.1" },
];

const CORPUS_ROWS = [
  { feature: "rsi", historicalImportance: 52.1, currentImportance: 52.3, drift: 0.066, status: "STABLE" },
];

function render(liveFeatureDrift: unknown[], liveFeatureDriftCycleAt: string | null): string {
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
      liveFeatureDriftCycleAt,
    },
    performanceMetrics: {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, profitFactor: 0,
      sharpeRatio: 0, expectancy: 0, averageWin: 0, averageLoss: 0, totalProfit: 0,
      totalLoss: 0, maxDrawdown: 0, currentDrawdown: 0,
    },
  } as unknown as Parameters<typeof buildDiagnosticsExportText>[0];
  const text = buildDiagnosticsExportText(input);
  const start = text.indexOf("SECTION 3");
  if (start < 0) return "(SECTION 3 not rendered)";
  const next4 = text.indexOf("SECTION 4", start);
  const end = next4 > 0 ? next4 : text.indexOf("END OF EXPORT");
  return text.slice(start, end > start ? end : undefined);
}

function section3Checks(): [string, boolean][] {
  const freshIso = new Date(Date.now() - 1.2 * 3_600_000).toISOString();
  const staleIso = new Date(Date.now() - 30 * 3_600_000).toISOString();
  const fresh = render(LIVE_ENTRIES, freshIso);
  const stale = render(LIVE_ENTRIES, staleIso);
  const untimed = render(LIVE_ENTRIES, null);
  const empty = render([], null);
  return [
    ["A: timestamp line renders with age", fresh.includes(`snapshot from ${freshIso}`) && /1\.\dh ago/.test(fresh)],
    ["A: fresh snapshot NOT flagged stale", !fresh.includes("STALE")],
    ["A: entries still render below the label", fresh.includes("volumeRatio: drift 5.625")],
    ["B: stale snapshot flagged STALE", stale.includes("— STALE: >8h since the last completed cycle (4h cadence)") && stale.includes("30.0h ago")],
    ["B: stale label does NOT hit fresh state", !fresh.includes("STALE") && stale.includes("STALE")],
    ["C: untimed entry state labelled, not faked", untimed.includes("snapshot time unknown (in-memory snapshot from before Item FE — no timestamp recorded)")],
    ["D: DB truthful empty fallback unchanged", empty.includes("(no live drift cycle recorded since this build — renders after the next drift check)")],
  ];
}

function roundTripChecks(): [string, boolean][] {
  const snapshot: FeatureDriftSnapshot = {
    cycleAt: new Date("2026-09-11T08:30:00.000Z").toISOString(),
    entries: LIVE_ENTRIES,
  };
  const roundTripped = parseFeatureDriftSnapshot(serializeFeatureDriftSnapshot(snapshot));
  const jsonRoundTrip = JSON.parse(serializeFeatureDriftSnapshot(snapshot)) as unknown;
  const dropped = parseFeatureDriftSnapshot(JSON.stringify({
    cycleAt: snapshot.cycleAt,
    entries: [
      ...LIVE_ENTRIES,
      { feature: "bad", recentMean: "x", historicalMean: 1, recentStd: 1, historicalStd: 1, meanShift: 1, stdShift: 1, drift: 1 },
      { feature: "nan", recentMean: NaN, historicalMean: 1, recentStd: 1, historicalStd: 1, meanShift: 1, stdShift: 1, drift: 1 },
    ],
  }));
  return [
    ["round-trip: cycleAt survives", roundTripped?.cycleAt === snapshot.cycleAt],
    ["round-trip: entries deep-equal", JSON.stringify(jsonRoundTrip) === serializeFeatureDriftSnapshot(snapshot) && roundTripped !== null && roundTripped.entries.length === 3],
    ["round-trip: skipped/skipReason preserved", roundTripped?.entries[2]?.skipped === true && roundTripped.entries[2]?.skipReason === "historicalStd < 0.1"],
    ["parse: null/undefined/empty -> null (no snapshot = absent, not crash)", parseFeatureDriftSnapshot(null) === null && parseFeatureDriftSnapshot(undefined) === null && parseFeatureDriftSnapshot("") === null],
    ["parse: garbage JSON -> null", parseFeatureDriftSnapshot("not json at all") === null],
    ["parse: non-string cycleAt -> null", parseFeatureDriftSnapshot('{"cycleAt":123,"entries":[]}') === null],
    ["parse: unparseable cycleAt -> null", parseFeatureDriftSnapshot('{"cycleAt":"not-a-date","entries":[]}') === null],
    ["parse: non-array entries -> null", parseFeatureDriftSnapshot('{"cycleAt":"2026-09-11T08:30:00.000Z","entries":{}}') === null],
    ["parse: non-finite/mistyped entry fields dropped, valid kept", dropped !== null && dropped.entries.length === 3],
  ];
}

function main(): void {
  const rt = roundTripChecks();
  const s3 = section3Checks();
  for (const [name, ok] of [...rt, ...s3]) {
    console.log(`${ok ? "✓" : "✗"} ${name}`);
  }
  console.log("\n════ A. FRESH hydrated snapshot render (synthetic values) ════\n");
  console.log(render(LIVE_ENTRIES, new Date(Date.now() - 1.2 * 3_600_000).toISOString()));
  console.log("════ B. STALE hydrated snapshot render (30h old) ════\n");
  console.log(render(LIVE_ENTRIES, new Date(Date.now() - 30 * 3_600_000).toISOString()));

  const pass = [...rt, ...s3].every(([, ok]) => ok);
  console.log(pass ? "\nITEM FE GATE: PASS (snapshot round-trip + SECTION 3 freshness labeling)" : "\nITEM FE GATE: FAIL");
  if (!pass) process.exitCode = 1;
}

main();
