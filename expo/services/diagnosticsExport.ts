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
  /**
   * Lightweight in-memory counters from the shadow write path
   * (shadowSignalService.ts), capturing fire-and-forget insert success/failure
   * since process start. Surfacing these makes a BROKEN shadow write path
   * VISIBLE in a future export rather than silent. Both default to 0.
   */
  shadowWriteFailures?: number;
  shadowWriteSuccesses?: number;
  /**
   * B2(c): TIER_0 S/R zone read-path health, from srZoneTier0Service.ts plus the
   * engine's degradation counters. TIER_0 failed THREE separate ways on 31 July
   * (backend 503 on both URLs, sr_zones_v1 empty during the signal window, and
   * every surviving zone below the 0.3 consumer threshold) and every one of them
   * was INVISIBLE in the export. Surfacing these makes a silent fallback to
   * TIER_1_LOCAL micro-zones impossible to miss.
   */
  tier0ZoneHealth?: Tier0ZoneHealth | null;
  /**
   * F6 criterion 4: bar-directional-layer stand-aside counters from the engine
   * (`signalEngine.getDirectionalLayerStats()`). Optional so older callers still
   * compile; the section then reports NOT INSTRUMENTED rather than 0/0, because
   * "no data" and "zero stand-asides" are not the same claim.
   */
  directionalLayerStats?: { checks: number; standAsides: number; readyNow: boolean } | null;
  /**
   * ITEM 5(d): durable Telegram alert-delivery counters from
   * `telegramNotifier.getTelegramDeliveryStats()`. The alert dispatch is
   * fire-and-forget and every failure previously reached only `console.warn`,
   * so a lost alert -- a trade the downstream MT5 bot never received -- was
   * completely invisible here. Optional so older callers still compile; the
   * section then reports NOT INSTRUMENTED rather than 0/0, because "no data"
   * and "zero failures" are not the same claim.
   */
  telegramDeliveryStats?: TelegramDeliveryStatsInput | null;
}

/** ITEM 5(d): shape of the durable alert-delivery counters for SECTION 9. */
export interface TelegramDeliveryStatsInput {
  alertsAttempted: number;
  alertsDelivered: number;
  alertsFailed: number;
  dispatchAttempts: number;
  dispatchFailures: number;
  lastFailureReason: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  hydrated: boolean;
}

/** TIER_0 S/R zone read-path health counters for SECTION 7. */
export interface Tier0ZoneHealth {
  reads: number;
  successes: number;
  failures: number;
  notConfigured: number;
  readErrors: number;
  emptyTable: number;
  allExpired: number;
  belowThreshold: number;
  tier1FallbackUses: number;
  lastFailureReason: string | null;
  lastFailureDetail: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  lastZoneCount: number;
  lastMaxReactionStrength: number | null;
  /** From the engine: signals blocked because a TIER_1-only zone was dominant. */
  tier1DominantSuppressions?: number;
  /** From the engine: signals emitted with the degraded-confidence penalty. */
  tier0DegradedPenaltyApplications?: number;
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
  // F6 forward-test telemetry (criteria 2 and 3). These values are already
  // attached to every signal via learningContext; they were simply never
  // exported, which made the regime-distribution and RSI-distribution criteria
  // unevaluable from an export. Emitting them is additive and touches no
  // scoring path. Rendered as one greppable, machine-parsable line.
  const lc = signal.learningContext;
  if (lc) {
    const parts: string[] = [
      `rsi=${Number.isFinite(lc.rsi) ? lc.rsi.toFixed(2) : "n/a"}`,
      `regime=${lc.regimeType ?? "n/a"}`,
      `regimeStrength=${typeof lc.regimeStrength === "number" ? lc.regimeStrength.toFixed(3) : "n/a"}`,
      `atr=${Number.isFinite(lc.atr) ? lc.atr.toFixed(3) : "n/a"}`,
      `htf=${lc.htfTrend ?? "n/a"}`,
      `adx=${typeof lc.adx === "number" ? lc.adx.toFixed(1) : "n/a"}`,
    ];
    lines.push(`    forward telemetry: ${parts.join("  ")}`);
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

function formatShadowSellSection(
  summary: ShadowSellSummary | null | undefined,
  writeFailures: number,
  writeSuccesses: number,
): string {
  const lines: string[] = [RULE, "SECTION 6 — SHADOW SELL SUPPRESSION SUMMARY (shadow_signals_v1)", RULE];
  // Write-path health — surfaced FIRST so a broken path is immediately visible.
  if (writeFailures > 0) {
    lines.push(`⚠ SHADOW WRITE PATH FAILURES: ${writeFailures} since process start (successes: ${writeSuccesses}).`);
    lines.push(`  The fire-and-forget insert to shadow_signals_v1 has been failing. Suppressed SELLs`);
    lines.push(`  are NOT being logged durably. Check: Supabase reachability, anon-key validity, and`);
    lines.push(`  whether migration 003_shadow_signals_anon_insert.sql is applied. Liveness check:`);
    lines.push(`  query shadow_signals_v1 for rows in the last N hours; if suppression is active and`);
    lines.push(`  zero rows exist, the write path is broken.`);
    lines.push("");
  } else {
    lines.push(`Shadow write path health: OK (successes: ${writeSuccesses}, failures: 0 since process start).`);
    lines.push("");
  }
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

function formatTier0ZoneSection(h: Tier0ZoneHealth | null | undefined): string {
  const lines: string[] = [RULE, "SECTION 7 — TIER_0 S/R ZONE READ-PATH HEALTH (sr_zones_v1)", RULE];
  if (!h) {
    lines.push("No TIER_0 zone health data supplied by the caller.");
    lines.push("NOTE: this is itself a gap — if the engine ran, this section should be populated.");
    return lines.join("\n");
  }

  lines.push("Read path: DIRECT Supabase sr_zones_v1 via the anon key (no Rork backend).");
  lines.push("The backend is retained ONLY for the refresh/compute WRITE, which needs the service key.");
  lines.push("");

  if (h.failures > 0 || h.tier1FallbackUses > 0) {
    lines.push(`⚠ TIER_0 ZONE PATH DEGRADED: ${h.failures} failed read(s), ${h.tier1FallbackUses} generation pass(es) fell back to TIER_1_LOCAL.`);
    lines.push("  TIER_1_LOCAL zones are computed from ~100 minutes of in-memory M1 samples. That input");
    lines.push("  supplied the dominant scoring feature in all four losing BUYs on 31 July 2026.");
    lines.push("");
    lines.push("  Failure breakdown:");
    lines.push(`    NOT_CONFIGURED (missing url/anon key):        ${h.notConfigured}`);
    lines.push(`    READ_ERROR (Supabase unreachable / RLS):      ${h.readErrors}`);
    lines.push(`    EMPTY_TABLE (refresh WRITE never populated):  ${h.emptyTable}`);
    lines.push(`    ALL_EXPIRED (refresh WRITE stale):            ${h.allExpired}`);
    lines.push(`    BELOW_CONSUMER_THRESHOLD (rows too weak):     ${h.belowThreshold}`);
    if (h.lastFailureReason) {
      lines.push("");
      lines.push(`  Most recent failure: ${h.lastFailureReason}`);
      lines.push(`    detail: ${h.lastFailureDetail ?? "n/a"}`);
      lines.push(`    at: ${h.lastFailureAt ? safeDate(h.lastFailureAt) : "n/a"}`);
    }
  } else {
    lines.push(`TIER_0 zone path health: OK (${h.successes} successful read(s) of ${h.reads}, 0 failures, 0 TIER_1 fallbacks).`);
  }

  lines.push("");
  lines.push(`Reads attempted: ${h.reads}    successes: ${h.successes}    failures: ${h.failures}`);
  lines.push(`Last successful read: ${h.lastSuccessAt ? safeDate(h.lastSuccessAt) : "never"}`);
  lines.push(`Zones usable at last success: ${h.lastZoneCount}`);
  lines.push(
    `Max reactionStrength last seen: ${h.lastMaxReactionStrength !== null ? h.lastMaxReactionStrength.toFixed(3) : "n/a"}  (consumer threshold is 0.30)`,
  );
  lines.push("");
  lines.push("B2(c) degradation policy outcomes:");
  lines.push(`  signals SUPPRESSED (TIER_1-only zone was the dominant feature): ${h.tier1DominantSuppressions ?? 0}`);
  lines.push(`  signals emitted with reduced-confidence penalty (x0.85):        ${h.tier0DegradedPenaltyApplications ?? 0}`);
  lines.push("");
  lines.push("Greppable log tags for this path: [SRZoneTier0] TIER0_UNAVAILABLE,");
  lines.push("  [SRZoneTier0] TIER0_FALLBACK_TO_TIER1, [SRZoneTier0] SIGNAL_SUPPRESSED.");
  lines.push("Liveness check (source of truth, independent of this export):");
  lines.push("  select count(*), max(updated_at), max(reaction_strength) from sr_zones_v1;");
  return lines.join("\n");
}

/**
 * Builds the full human-readable diagnostics export as plain text (not JSON),
 * combining signal history, raw persisted model weights, model health/drift
 * metrics, and performance metrics into clearly labeled sections. Used by
 * Settings > Export Diagnostics.
 */
/**
 * SECTION 8 — F6 criterion 4. The pre-registered refutation threshold is
 * "stand-asides > 5% of market-open generation attempts", so both the numerator
 * and the denominator have to be exported; a bare count cannot be evaluated.
 */
function formatDirectionalLayerSection(
  stats: { checks: number; standAsides: number; readyNow: boolean } | null | undefined,
): string {
  const lines: string[] = [RULE, "SECTION 8 — DIRECTIONAL BAR LAYER (F6 criterion 4)", RULE];
  if (!stats) {
    lines.push("NOT INSTRUMENTED — the caller supplied no directionalLayerStats.");
    lines.push("This is NOT the same as zero stand-asides. Criterion 4 cannot be evaluated.");
    return lines.join("\n");
  }
  const pct = stats.checks > 0 ? (stats.standAsides / stats.checks) * 100 : 0;
  lines.push(`Readiness checks this process: ${stats.checks}`);
  lines.push(`Stand-asides (bar layer unavailable or stale): ${stats.standAsides}`);
  lines.push(`Stand-aside rate: ${stats.checks > 0 ? pct.toFixed(2) + "%" : "n/a (no checks yet)"}`);
  lines.push(`Directional layer ready right now: ${stats.readyNow ? "YES" : "NO"}`);
  lines.push("");
  lines.push("ITEM 4: these counters are DURABLE. They are persisted to AsyncStorage under");
  lines.push("  directional_layer_counters_v1 and rehydrated at init, so they survive an app");
  lines.push("  reload and accumulate across the install lifetime, not one process. A flush");
  lines.push("  happens at most once per 15s, so a hard kill can lose up to 15s of counts.");
  lines.push("F6 criterion 4 refutation threshold: stand-aside rate > 5% of market-open attempts.");
  return lines.join("\n");
}

/**
 * SECTION 9 -- ITEM 5(d): Telegram alert delivery health.
 *
 * Exists because the alert path runs through the Rork backend, which returns
 * 503 in bursts. A burst longer than the client's retry horizon loses the alert
 * outright, and nothing used to record that.
 */
function formatTelegramDeliverySection(stats: TelegramDeliveryStatsInput | null | undefined): string {
  const lines = [DRULE, "SECTION 9 - TELEGRAM ALERT DELIVERY (ITEM 5d)", DRULE];

  if (!stats) {
    lines.push("NOT INSTRUMENTED - caller did not supply telegramDeliveryStats.");
    lines.push("This is NOT the same as zero failures. Treat as unknown.");
    return lines.join("\n");
  }

  const deliveryRate = stats.alertsAttempted > 0
    ? ((stats.alertsDelivered / stats.alertsAttempted) * 100).toFixed(2) + "%"
    : "n/a (no alerts attempted yet)";

  lines.push(`Alerts attempted (signals emitted): ${stats.alertsAttempted}`);
  lines.push(`Alerts DELIVERED to every chat:     ${stats.alertsDelivered}`);
  lines.push(`Alerts LOST (all retries exhausted): ${stats.alertsFailed}`);
  lines.push(`Delivery rate: ${deliveryRate}`);
  lines.push("");
  lines.push(`Dispatch attempts incl. retries: ${stats.dispatchAttempts}`);
  lines.push(`Dispatch attempt failures:       ${stats.dispatchFailures}`);
  lines.push("");
  lines.push(`Last success: ${stats.lastSuccessAt ? safeDate(stats.lastSuccessAt) : "never"}`);
  lines.push(`Last failure: ${stats.lastFailureAt ? safeDate(stats.lastFailureAt) : "never"}`);
  lines.push(`Last failure reason: ${stats.lastFailureReason ?? "n/a"}`);
  lines.push(`Counters rehydrated from durable storage: ${stats.hydrated ? "YES" : "NO (process-fresh)"}`);
  lines.push("");
  lines.push("These counters are DURABLE (AsyncStorage key telegram_delivery_counters_v1)");
  lines.push("  and survive an app reload, so they accumulate across the install lifetime.");
  lines.push("REFUTATION THRESHOLD: alertsFailed > 0 means at least one emitted signal was");
  lines.push("  never delivered to the MT5 bot. Any non-zero value is a lost trade.");
  return lines.join("\n");
}

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
    formatShadowSellSection(
      input.shadowSellSummary,
      input.shadowWriteFailures ?? 0,
      input.shadowWriteSuccesses ?? 0,
    ),
    "",
    formatTier0ZoneSection(input.tier0ZoneHealth),
    "",
    formatDirectionalLayerSection(input.directionalLayerStats),
    "",
    formatTelegramDeliverySection(input.telegramDeliveryStats),
    "",
    DRULE,
    "END OF EXPORT",
    DRULE,
  ];
  return sections.join("\n");
}
