import { PerformanceMetrics, TradingSignal } from "@/types/trading";
import type { signalEngine } from "@/services/signalEngine";

export type ModelHealthMetrics = ReturnType<typeof signalEngine.getModelHealthMetrics>;
export type RawModelWeights = { weights: [string, number][]; lastTrainingTime: number } | null;

export interface DiagnosticsExportInput {
  signalHistory: TradingSignal[];
  modelWeights: RawModelWeights;
  modelHealth: ModelHealthMetrics;
  performanceMetrics: PerformanceMetrics;
}

const RULE = "-".repeat(70);
const DRULE = "=".repeat(70);

function safeDate(value: unknown): string {
  try {
    const d = value instanceof Date ? value : new Date(value as string | number);
    if (Number.isNaN(d.getTime())) return "unknown";
    return d.toISOString();
  } catch {
    return "unknown";
  }
}

function formatSignal(signal: TradingSignal, index: number): string {
  const lines: string[] = [];
  lines.push(`[${index + 1}] ${signal.type} @ ${signal.entryPrice}  —  status: ${signal.status}`);
  lines.push(`    id: ${signal.id}`);
  lines.push(`    generated: ${safeDate(signal.timestamp)}    entry time: ${signal.entryTime ?? "n/a"}`);
  lines.push(`    confidence: ${(signal.confidence * 100).toFixed(1)}%`);
  lines.push(`    TP1: ${signal.tp1}   TP2: ${signal.tp2}   TP3: ${signal.tp3}   SL: ${signal.sl}`);
  lines.push(`    targets hit: ${signal.targetsHit}`);
  if (signal.exitPrice !== undefined) {
    lines.push(`    exit price: ${signal.exitPrice}    exit time: ${signal.exitTime ?? "n/a"}`);
  }
  if (signal.breakevenReached) {
    lines.push(`    breakeven reached: yes (${signal.breakevenTime ?? "n/a"})`);
  }
  if (signal.riskJustification) {
    lines.push(`    rationale: ${signal.riskJustification}`);
  }
  if (signal.topFeatures?.length) {
    const features = signal.topFeatures.map((f) => `${f.feature}=${f.score.toFixed(2)}`).join(", ");
    lines.push(`    top features: ${features}`);
  }
  return lines.join("\n");
}

function formatSignalHistorySection(signalHistory: TradingSignal[]): string {
  const lines: string[] = [RULE, `SECTION 1 — SIGNAL HISTORY (${signalHistory.length} signal${signalHistory.length === 1 ? "" : "s"})`, RULE];
  if (signalHistory.length === 0) {
    lines.push("No signals have been recorded yet.");
  } else {
    const sorted = [...signalHistory].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    sorted.forEach((signal, index) => {
      lines.push(formatSignal(signal, index));
      lines.push("");
    });
  }
  return lines.join("\n");
}

function formatModelWeightsSection(modelWeights: RawModelWeights): string {
  const lines: string[] = [RULE, "SECTION 2 — MODEL WEIGHTS (model_weights_v1)", RULE];
  if (!modelWeights) {
    lines.push(
      "The model has never been retrained yet. Automatic retraining requires at least 10 " +
      "recorded trade outcomes before the first training pass runs, so no weights have been " +
      "persisted to storage. This is expected behavior for a new or lightly-used installation, " +
      "not an error.",
    );
  } else {
    lines.push(`Last training time: ${safeDate(modelWeights.lastTrainingTime || null)}`);
    lines.push(`Feature count: ${modelWeights.weights.length}`);
    lines.push("");
    lines.push("Feature weights:");
    if (modelWeights.weights.length === 0) {
      lines.push("  (none persisted)");
    } else {
      [...modelWeights.weights]
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .forEach(([feature, weight]) => {
          lines.push(`  ${feature}: ${weight.toFixed(6)}`);
        });
    }
  }
  return lines.join("\n");
}

function formatModelHealthSection(modelHealth: ModelHealthMetrics): string {
  const lines: string[] = [RULE, "SECTION 3 — MODEL HEALTH & DRIFT", RULE];
  lines.push(`Model health score: ${modelHealth.modelHealthScore}/100`);
  lines.push(`Feature correlation status: ${modelHealth.featureCorrelationStatus}`);
  lines.push(`Confidence degradation: ${modelHealth.confidenceDegradation.toFixed(4)}`);
  lines.push(`Concept drift score: ${modelHealth.conceptDriftScore.toFixed(4)}`);
  lines.push(`Drift alert level: ${modelHealth.driftAlertLevel}`);
  lines.push(`Days since retrain: ${modelHealth.daysSinceRetrain}`);
  lines.push(`Retraining recommended: ${modelHealth.retrainingRecommended ? "YES" : "no"}`);
  lines.push(`Retrain scheduled: ${modelHealth.retrainScheduled ? "YES" : "no"}`);
  lines.push("");
  lines.push("Feature importance drift:");
  if (!modelHealth.featureImportanceDrift || modelHealth.featureImportanceDrift.length === 0) {
    lines.push("  (insufficient data — needs 20+ trade outcomes)");
  } else {
    modelHealth.featureImportanceDrift.forEach((metric) => {
      lines.push(
        `  ${metric.feature}: ${metric.historicalImportance.toFixed(3)} -> ${metric.currentImportance.toFixed(3)} ` +
        `(drift ${metric.drift.toFixed(3)}, ${metric.status})`,
      );
    });
  }
  return lines.join("\n");
}

function formatPerformanceMetricsSection(performanceMetrics: PerformanceMetrics): string {
  const lines: string[] = [RULE, "SECTION 4 — PERFORMANCE METRICS", RULE];
  const p = performanceMetrics;
  lines.push(`Total trades: ${p.totalTrades}`);
  lines.push(`Winning / Losing: ${p.winningTrades} / ${p.losingTrades}`);
  lines.push(`Win rate: ${p.winRate.toFixed(1)}%`);
  lines.push(`Profit factor: ${p.profitFactor.toFixed(2)}`);
  lines.push(`Sharpe ratio: ${p.sharpeRatio.toFixed(3)}`);
  lines.push(`Expectancy (R-multiple): ${p.expectancy.toFixed(3)}`);
  lines.push(`Average win: ${p.averageWin.toFixed(2)}    Average loss: ${p.averageLoss.toFixed(2)}`);
  lines.push(`Total profit: ${p.totalProfit.toFixed(2)}    Total loss: ${p.totalLoss.toFixed(2)}`);
  lines.push(`Max drawdown: ${p.maxDrawdown.toFixed(2)}    Current drawdown: ${p.currentDrawdown.toFixed(2)}`);
  if (typeof p.hypotheticalAccuracy === "number") {
    lines.push(`Hypothetical (near-miss) accuracy: ${p.hypotheticalAccuracy.toFixed(1)}%`);
  }
  if (typeof p.avgSlippageDiff === "number") {
    lines.push(`Average slippage difference: ${p.avgSlippageDiff.toFixed(3)}`);
  }
  return lines.join("\n");
}

/**
 * Builds the full human-readable diagnostics export as plain text (not JSON),
 * combining signal history, raw persisted model weights, model health/drift
 * metrics, and performance metrics into clearly labeled sections. Used by
 * Settings > Export Diagnostics.
 */
export function buildDiagnosticsExportText(input: DiagnosticsExportInput): string {
  const sections = [
    DRULE,
    "XAUUSD SIGNAL BOT — DIAGNOSTICS EXPORT",
    DRULE,
    `Generated: ${new Date().toISOString()}`,
    "",
    formatSignalHistorySection(input.signalHistory),
    "",
    formatModelWeightsSection(input.modelWeights),
    "",
    formatModelHealthSection(input.modelHealth),
    "",
    formatPerformanceMetricsSection(input.performanceMetrics),
    "",
    DRULE,
    "END OF EXPORT",
    DRULE,
  ];
  return sections.join("\n");
}
