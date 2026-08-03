/**
 * WRITER <-> PARSER CONTRACT TEST for the forward monitor.
 *
 * The F6 criteria 2, 3 and 4 are only evaluable because the diagnostics export
 * now emits per-signal `forward telemetry:` and SECTION 8. If the writer and the
 * monitor's parser ever drift apart, the monitor would silently print
 * "NOT INSTRUMENTED" against a perfectly good export — a false negative that
 * looks like a data problem. This test builds a REAL export with the REAL
 * writer and feeds it to the REAL parsers. No fixture strings.
 */
import { writeFileSync } from "node:fs";

import { buildDiagnosticsExportText } from "../services/diagnosticsExport";
import type { PerformanceMetrics, TradingSignal } from "../types/trading";
import { parseStandAside, parseTelemetry } from "./forwardMonitor";
import { parseExport } from "./preconditions";

const OUT = "/tmp/fm_contract_export.txt";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}  ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

function makeSignal(id: string, type: "BUY" | "SELL", rsi: number, regime: "TRENDING" | "RANGING" | "VOLATILE" | "QUIET"): TradingSignal {
  const entry = 4050;
  return {
    id,
    timestamp: new Date("2026-08-03T09:00:00Z"),
    type,
    entryPrice: entry,
    entryPriceWithSlippage: entry,
    tp1: type === "BUY" ? entry + 3 : entry - 3,
    tp2: type === "BUY" ? entry + 6 : entry - 6,
    tp3: type === "BUY" ? entry + 9 : entry - 9,
    sl: type === "BUY" ? entry - 4 : entry + 4,
    slMultiplier: 1,
    confidence: 0.78,
    status: "ACTIVE",
    targetsHit: 0,
    entryTime: "2026-08-03T09:00:00Z",
    topFeatures: [],
    riskJustification: "contract test",
    createdAt: Date.parse("2026-08-03T09:00:00Z"),
    learningContext: {
      rsi,
      atr: 1.8,
      volumeRatio: 1,
      dxyChange: 0,
      timeWindowFactor: 1,
      sentiment: { score: 0, label: "NEUTRAL", sources: [] } as never,
      schemaVersion: 2,
      regimeType: regime,
      regimeStrength: 0.42,
      htfTrend: "BULLISH",
      adx: 21.3,
    },
  };
}

const emptyMetrics: PerformanceMetrics = {
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
} as PerformanceMetrics;

function main(): void {
  console.log("=".repeat(90));
  console.log("FORWARD MONITOR — WRITER <-> PARSER CONTRACT");
  console.log("=".repeat(90));

  const signals = [
    makeSignal("fm-contract-buy-1", "BUY", 74.5, "RANGING"),
    makeSignal("fm-contract-sell-1", "SELL", 41.2, "TRENDING"),
  ];

  const text = buildDiagnosticsExportText({
    signalHistory: signals,
    modelWeights: null,
    modelHealth: {
      modelHealthScore: 0,
      featureCorrelationStatus: "n/a",
      confidenceDegradation: 0,
      conceptDriftScore: 0,
      driftAlertLevel: "NONE",
      daysSinceRetrain: 0,
      retrainingRecommended: false,
      retrainScheduled: false,
      featureImportanceDrift: [],
    } as never,
    performanceMetrics: emptyMetrics,
    directionalLayerStats: { checks: 1234, standAsides: 41, readyNow: true },
  });
  writeFileSync(OUT, text, "utf-8");

  // 1 — the geometry parser still works on the new export shape.
  const parsed = parseExport(OUT);
  check("parseExport finds both signals", parsed.length === 2, `n=${parsed.length}`);

  // 2 — telemetry round-trips per signal, keyed by id.
  const tel = parseTelemetry(OUT);
  const buy = tel.get("fm-contract-buy-1");
  const sell = tel.get("fm-contract-sell-1");
  check("telemetry parsed for BUY", buy !== undefined, JSON.stringify(buy ?? null));
  check("telemetry parsed for SELL", sell !== undefined, JSON.stringify(sell ?? null));
  check("BUY rsi round-trips", buy?.rsi === 74.5, `got ${buy?.rsi}`);
  check("BUY regime round-trips", buy?.regime === "RANGING", `got ${buy?.regime}`);
  check("SELL rsi round-trips", sell?.rsi === 41.2, `got ${sell?.rsi}`);
  check("SELL regime round-trips", sell?.regime === "TRENDING", `got ${sell?.regime}`);
  check("atr round-trips", buy?.atr === 1.8, `got ${buy?.atr}`);
  check("htf round-trips", buy?.htf === "BULLISH", `got ${buy?.htf}`);

  // 3 — SECTION 8 round-trips.
  const sa = parseStandAside(OUT);
  check("SECTION 8 parsed", sa !== null, JSON.stringify(sa));
  check("checks round-trip", sa?.checks === 1234, `got ${sa?.checks}`);
  check("stand-asides round-trip", sa?.standAsides === 41, `got ${sa?.standAsides}`);

  // 4 — the NOT-INSTRUMENTED path is distinguishable from zero. An export built
  //     without the stats must parse as null, never as {checks:0, standAsides:0}.
  const legacy = buildDiagnosticsExportText({
    signalHistory: [],
    modelWeights: null,
    modelHealth: {
      modelHealthScore: 0,
      featureCorrelationStatus: "n/a",
      confidenceDegradation: 0,
      conceptDriftScore: 0,
      driftAlertLevel: "NONE",
      daysSinceRetrain: 0,
      retrainingRecommended: false,
      retrainScheduled: false,
      featureImportanceDrift: [],
    } as never,
    performanceMetrics: emptyMetrics,
  });
  writeFileSync("/tmp/fm_contract_legacy.txt", legacy, "utf-8");
  const legacySa = parseStandAside("/tmp/fm_contract_legacy.txt");
  check(
    "absent stats parse as NOT INSTRUMENTED (null), not zero",
    legacySa === null,
    `got ${JSON.stringify(legacySa)}`,
  );
  check(
    "legacy export says NOT INSTRUMENTED in SECTION 8",
    legacy.includes("NOT INSTRUMENTED"),
    "section text",
  );

  console.log("");
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
