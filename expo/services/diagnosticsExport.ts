import { PerformanceMetrics, TradingSignal } from "@/types/trading";
import type { signalEngine } from "@/services/signalEngine";
import type { DiagnosticEvent } from "@/services/diagnosticEventStore";

export type ModelHealthMetrics = ReturnType<typeof signalEngine.getModelHealthMetrics>;
export type RawModelWeights = { weights: [string, number][]; lastTrainingTime: number } | null;

export interface ShadowSellSummary {
  count: number;
  dateRange: { oldest: string; newest: string } | null;
  sessionBreakdown: Record<string, number>;
  htfBreakdown: Record<string, number>;
  avgGeometry: {
    entry: number;
    sl: number;
    tp1: number;
    tp2: number;
    tp3: number;
    atr: number;
    confidence: number;
  } | null;
  recent: Array<Record<string, unknown>>;
}

export interface DiagnosticsExportInput {
  signalHistory: TradingSignal[];
  modelWeights: RawModelWeights;
  modelHealth: ModelHealthMetrics;
  performanceMetrics: PerformanceMetrics;
  /**
   * Item 3: recent (rolling 24h) structured resolution-decision events from
   * diagnosticEventStore.ts. Optional so callers/tests that predate this field
   * still compile and produce a valid export (section just reports empty).
   */
  diagnosticEvents?: DiagnosticEvent[];
  /**
   * Shadow SELL suppression summary, sourced from the durable
   * shadow_signals_v1 Supabase table. Optional so callers without
   * a backend connection still produce a valid export.
   */
  shadowSellSummary?: ShadowSellSummary | null;
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
  if (signal.fullAttentionScores?.length) {
    lines.push(`    full attention scores (${signal.fullAttentionScores.length} total):`);
    signal.fullAttentionScores.forEach((f) => {
      lines.push(`      ${f.feature}=${f.score.toFixed(2)}`);
    });
  }
  if (signal.srZonesSnapshot?.length) {
    lines.push(`    srZones snapshot at generation time (${signal.srZonesSnapshot.length} zone(s)):`);
    signal.srZonesSnapshot
      .slice()
      .sort((a, b) => b.reactionStrength - a.reactionStrength)
      .forEach((z) => {
        lines.push(
          `      ${z.type} @ ${z.price.toFixed(1)}  touches=${z.touches}  reaction=${(z.reactionStrength * 100).toFixed(0)}%  confluence=${z.confluenceScore}  source=${z.source}  tier=${z.tier ?? 'TIER_1_LOCAL'}`,
        );
      });
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

function formatShadowSellSection(summary: ShadowSellSummary | null | undefined): string {
  const lines: string[] = [RULE, "SECTION 6 — SHADOW SELL SUPPRESSION SUMMARY (shadow_signals_v1)", RULE];
  if (!summary || summary.count === 0) {
    lines.push("No SELL signals suppressed (or allowShortSignals is currently true).");
    lines.push("When allowShortSignals=false, qualifying SELLs are fully scored but not emitted.");
    lines.push("A shadow record is pushed to shadow_signals_v1 for forward monitoring.");
    return lines.join("\n");
  }
  lines.push(`Total suppressed SELLs: ${summary.count}`);
  if (summary.dateRange) {
    lines.push(`Date range: ${summary.dateRange.oldest} to ${summary.dateRange.newest}`);
  }
  lines.push("");
  lines.push("Session breakdown:");
  for (const [s, c] of Object.entries(summary.sessionBreakdown).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${s}: ${c}`);
  }
  lines.push("");
  lines.push("HTF trend breakdown:");
  for (const [h, c] of Object.entries(summary.htfBreakdown).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${h}: ${c}`);
  }
  if (summary.avgGeometry) {
    lines.push("");
    lines.push("Aggregate geometry (avg):");
    lines.push(`  entry=${summary.avgGeometry.entry.toFixed(1)}  sl=${summary.avgGeometry.sl.toFixed(1)}  atr=${summary.avgGeometry.atr.toFixed(2)}`);
    lines.push(`  tp1=${summary.avgGeometry.tp1.toFixed(1)}  tp2=${summary.avgGeometry.tp2.toFixed(1)}  tp3=${summary.avgGeometry.tp3.toFixed(1)}`);
    lines.push(`  avg confidence=${(summary.avgGeometry.confidence * 100).toFixed(1)}%`);
  }
  lines.push("");
  lines.push(`Most recent ${summary.recent.length} record(s) (spot-check):`);
  for (const r of summary.recent) {
    const ts = r.created_at as string;
    const entry = Number(r.entry);
    const sl = Number(r.sl);
    const conf = Number(r.confidence);
    const sess = r.session_name as string;
    const htf = (r.htf_trend as string) ?? "?";
    lines.push(`  [${ts}] SELL @ ${entry.toFixed(1)}  SL=${sl.toFixed(1)}  conf=${(conf * 100).toFixed(1)}%  session=${sess}  htf=${htf}`);
  }
  return lines.join("\n");
}

function formatDiagnosticEventsSection(events: DiagnosticEvent[] | undefined): string {
  const lines: string[] = [RULE, "SECTION 5 — DIAGNOSTIC RESOLUTION EVENT LOG (rolling 24h)", RULE];
  if (!events || events.length === 0) {
    lines.push("No resolution events recorded in the last 24h (or the app hasn't hit a Path 3 catch-up / live-tick SL-breach candidate recently).");
    return lines.join("\n");
  }
  lines.push(`${events.length} event(s), newest first:`);
  lines.push("");
  events.forEach((e) => {
    const detailStr = e.detail ? ` ${JSON.stringify(e.detail)}` : "";
    lines.push(`  [${safeDate(e.ts)}] ${e.eventType}  signal=${e.signalId.slice(-6)}  price=${e.price.toFixed(2)}${detailStr}`);
  });
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
    formatDiagnosticEventsSection(input.diagnosticEvents),
    "",
    formatShadowSellSection(input.shadowSellSummary),
    "",
    DRULE,
    "END OF EXPORT",
    DRULE,
  ];
  return sections.join("\n");
}
