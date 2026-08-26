import { FeatureConfidence, PerformanceMetrics, TradingSignal } from "@/types/trading";
import { renderAttentionAnnotation } from "@/services/attentionTelemetry";
import type { signalEngine } from "@/services/signalEngine";
import type { DiagnosticEvent } from "@/services/diagnosticEventStore";

export type ModelHealthMetrics = ReturnType<typeof signalEngine.getModelHealthMetrics>;
export type RawModelWeights = {
  weights: [string, number][];
  lastTrainingTime: number;
  /**
   * ITEM 12 / 11(b): outcome count the persisted vector was trained on, plus the
   * durable hydrateUnavailableCount at that moment. `null` (NOT 0) means the
   * vector predates this telemetry - provenance unknown is not the same claim as
   * trained on zero outcomes.
   */
  corpusSizeAtTraining?: number | null;
  hydrateUnavailableAtTraining?: number | null;
} | null;

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
  directionalLayerStats?: {
    checks: number;
    standAsides: number;
    readyNow: boolean;
    /** ITEM 167(c)/(d): recent-window rate + reasons. */
    rate24h?: number | null;
    checks24h?: number | null;
    standAsides24h?: number | null;
    recent?: Array<{ ts: number; reason: string; m5Bars: number; newestM5AgeMin: number | null }> | null;
  } | null;
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
  /**
   * ITEM 6(c): live state of the durable Telegram outbox (`telegram_outbox_v1`),
   * read DIRECTLY from Supabase via the anon key. The client-side counters can
   * only describe what THIS process saw; the outbox is the durable record of
   * whether an alert was eventually delivered by the pg_cron drain or aged out.
   * Optional — the section reports NOT INSTRUMENTED rather than zeros.
   */
  telegramOutbox?: TelegramOutboxSummaryInput | null;
  /**
   * ITEM 12(d): durable learning-corpus hydration counters from
   * `learningStore.getLearningCorpusStats()`. The corpus READ is now a DIRECT
   * paginated Supabase read (it used to ride the 503-prone Rork backend), and an
   * unavailable read previously produced NO log, NO counter and NOTHING in the
   * export - so a model trained on a truncated corpus was indistinguishable from
   * one trained on the full corpus. Optional: the block reports NOT INSTRUMENTED
   * rather than zeros, because no data and zero failures are different claims.
   */
  learningCorpusStats?: LearningCorpusStatsInput | null;
  /**
   * ITEM 74(b)(c): durable OUTBOUND push counters + reconciliation visibility.
   * The export previously carried hydrate counters ONLY, so "was a push even
   * attempted?" was UNOBSERVABLE and no mechanism could be asserted about the
   * 149-local vs 51-remote gap. Optional: the block reports NOT INSTRUMENTED
   * rather than zeros, because no data and zero pushes are different claims.
   */
  outboundPushStats?: OutboundPushStatsInput | null;
  /** ITEM 74(a): build marker + RUNTIME-observed symbol probes. */
  buildProvenance?: BuildProvenanceInput | null;
}

/** ITEM 74(b)(c): shape of the durable outbound-push counters for SECTION 2. */
export interface OutboundPushStatsInput {
  pushAttempts: number;
  pushSuccesses: number;
  pushFailures: number;
  rowsPushed: number;
  failuresByStatus: Record<string, number>;
  suppressedByReason: Record<string, number>;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureBody: string | null;
  queueDepthAtInit: number | null;
  lastLocalCount: number | null;
  lastRemoteCount: number | null;
  lastLocalOnlyCount: number | null;
  lastRemoteOnlyCount: number | null;
  lastReconcileAt: number | null;
  hydrated: boolean;
  /** Queue depth read at EXPORT time, not from storage. */
  queueDepthNow: number;
}

/** ITEM 74(a): build marker plus probes whose values are read AT RUNTIME. */
export interface BuildProvenanceInput {
  buildSha: string;
  markedAt: string;
  /** ITEM 168(b): runtime-observed gate configuration (which bundle is running). */
  runtimeConfig?: Record<string, string | number | boolean | null> | null;
  probes: { label: string; present: boolean; observed: string }[];
}

/** ITEM 12(d): shape of the durable corpus-hydration counters for SECTION 2. */
export interface LearningCorpusStatsInput {
  hydrateAttempts: number;
  hydrateSuccesses: number;
  hydrateUnavailableCount: number;
  lastPulled: number | null;
  lastTotal: number | null;
  lastPages: number | null;
  lastTruncatedByLimit: boolean;
  lastUnavailableReason: string | null;
  lastUnavailableAt: number | null;
  lastSuccessAt: number | null;
  hydrated: boolean;
}

/** ITEM 6(c): durable outbox state for SECTION 9. */
export interface TelegramOutboxSummaryInput {
  pending: number;
  delivered: number;
  deliveredOnRetry: number;
  agedOut: number;
  oldestPendingAgeSec: number | null;
  lastError: string | null;
  windowHours: number;
}

/** ITEM 5(d): shape of the durable alert-delivery counters for SECTION 9. */
export interface TelegramDeliveryStatsInput {
  alertsAttempted: number;
  alertsDelivered: number;
  alertsFailed: number;
  dispatchAttempts: number;
  dispatchFailures: number;
  /** ITEM 6(c): durable-outbox counters. Optional so older callers still compile. */
  outboxEnqueued?: number;
  outboxEnqueueFailures?: number;
  outboxHandoffs?: number;
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

/**
 * ITEM 29 - one attention entry, rendered so it can no longer be misread.
 *
 * The OLD rendering printed `Math.abs(score) * 100` with no side, so a -12
 * penalty against the signal's own direction and a +12 bonus for it were the
 * same eight characters, and a bullish-family entry on a SELL row looked like
 * evidence FOR the SELL. Now the SIGNED value is printed (falling back to the
 * legacy magnitude when a pre-ITEM-29 record has no signed value) together with
 * the side the accumulator actually moved and, when it conflicts, an explicit
 * OPPOSES-<direction> marker. `side-unclassified` / `sides not instrumented`
 * are printed rather than assuming agreement.
 */
function renderFeature(f: FeatureConfidence, signalType: "BUY" | "SELL"): string {
  const value = typeof f.signedScore === "number" ? f.signedScore : f.score;
  const magnitude = `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
  if (f.side === undefined) {
    return `${f.feature}=${magnitude}(side-not-instrumented)`;
  }
  return `${f.feature}=${magnitude}(${renderAttentionAnnotation(f.side, signalType)})`;
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
    // ITEM 29 (rendering honesty): a v1 record NEVER HELD these fields, which is
    // a different fact from "the field was expected and came back empty". Both
    // used to print `n/a`, which is how "htf unlabelled on 89% of rows" got read
    // as a live instrumentation failure when it is a historical schema boundary
    // (v2 landed 2026-07-29; every row after it carries htf). `not-instrumented`
    // states the schema boundary explicitly.
    const schema = typeof lc.schemaVersion === "number" ? lc.schemaVersion : 1;
    const wide = (value: unknown, rendered: string): string =>
      value === undefined || value === null ? (schema < 2 ? `not-instrumented(v${schema})` : "n/a") : rendered;
    const parts: string[] = [
      `rsi=${Number.isFinite(lc.rsi) ? lc.rsi.toFixed(2) : "n/a"}`,
      `schemaVersion=${schema}`,
      `regime=${wide(lc.regimeType, String(lc.regimeType))}`,
      `regimeStrength=${wide(lc.regimeStrength, typeof lc.regimeStrength === "number" ? lc.regimeStrength.toFixed(3) : "")}`,
      `atr=${Number.isFinite(lc.atr) ? lc.atr.toFixed(3) : "n/a"}`,
      `htf=${wide(lc.htfTrendAtGate ?? lc.htfTrend, String(lc.htfTrendAtGate ?? lc.htfTrend))}`,
      `adx=${wide(lc.adx, typeof lc.adx === "number" ? lc.adx.toFixed(1) : "")}`,
    ];
    lines.push(`    forward telemetry: ${parts.join("  ")}`);
  }
  // ITEM 28 - COUNTER-TREND GATE RECORD. The classifier and the intraday drift
  // veto used to leave no durable trace of the four values they decided on, so
  // "did the veto see what we think it saw" was unanswerable for every past
  // signal. Read from the signal's own frozen telemetry record, falling back to
  // the identically-named v3 learningContext fields. `not-instrumented` means
  // the signal predates the record and is deliberately distinct from a value.
  const gate = signal.counterTrendTelemetry;
  const gateLc = signal.learningContext;
  const gateSchema = typeof gateLc?.schemaVersion === "number" ? gateLc.schemaVersion : 1;
  if (gate || (gateLc && gateSchema >= 3 && gateLc.counterTrendClassified !== undefined)) {
    const counterTrend = gate?.counterTrendClassified ?? gateLc?.counterTrendClassified;
    const drift = gate?.recentDrift ?? gateLc?.recentDrift ?? null;
    const driftAgainst = gate?.driftAgainst ?? gateLc?.driftAgainst ?? null;
    const threshold = gate?.driftVetoThreshold ?? gateLc?.driftVetoThreshold ?? null;
    const predicate = gate?.driftVetoPredicateTrue ?? gateLc?.driftVetoPredicateTrue;
    const sweepReclaim = gate?.sweepReclaimConfirmed ?? gateLc?.sweepReclaimConfirmedAtGate;
    const override = gate?.driftVetoOverrideApplied ?? gateLc?.driftVetoOverrideApplied;
    const spread = gate?.spreadPipsAtEntry ?? gateLc?.spreadPipsAtEntry ?? null;
    const ltf = gate?.ltfTrendAtGate ?? gateLc?.ltfTrendAtGate;
    lines.push(
      `    counter-trend gate: counterTrend=${counterTrend ?? "n/a"}  htfAtGate=${gate?.htfTrendAtGate ?? gateLc?.htfTrendAtGate ?? "n/a"}  ltfAtGate=${ltf ?? "n/a"}  drift=${drift === null ? "uncomputable" : `$${drift.toFixed(2)}`}  driftAgainst=${driftAgainst === null ? "n/a" : `$${driftAgainst.toFixed(2)}`}  driftVetoThreshold=${threshold === null ? "n/a" : `$${threshold.toFixed(2)}`}  vetoPredicate=${predicate ?? "n/a"}  sweepReclaimConfirmed=${sweepReclaim ?? "n/a"}  vetoOverrideApplied=${override ?? "n/a"}  spreadPipsAtEntry=${spread === null ? "none-observed" : spread.toFixed(2)}`,
    );
  } else {
    lines.push(`    counter-trend gate: not-instrumented (signal predates ITEM 28 telemetry)`);
  }
  if (signal.riskJustification) {
    lines.push(`    rationale: ${signal.riskJustification}`);
  }
  // ITEM 22(c) - GEOMETRY MODE, printed explicitly so a future analysis never
  // has to INFER which code produced a signal's ladder. The 19a measurement had
  // to reconstruct this from the rationale string's format and could only trust
  // 39 of 392 rows as a result. This line is the provenance that was missing.
  // ITEM 109: the engine now uses the user's tp1Pips/tp2Pips/tp3Pips directly.
  // Prior to Item 109, TPs were R-derived (0.70/1.05/1.40R of dynamic SL) and the
  // user's settings were ignored.
  lines.push(`    geometry mode: SL: manual slPips · TPs: user-configured pips (${signal.tp1Distance ?? '?'}p/${signal.tp2Distance ?? '?'}p/${signal.tp3Distance ?? '?'}p)`);
  if (signal.topFeatures?.length) {
    const features = signal.topFeatures.map((f) => renderFeature(f, signal.type)).join(", ");
    lines.push(`    top features: ${features}`);
  }
  if (signal.fullAttentionScores?.length) {
    const opposing = signal.fullAttentionScores.filter((f) => f.opposesSignal === true);
    lines.push(
      `    full attention scores (${signal.fullAttentionScores.length} total${signal.fullAttentionScores.some((f) => f.side !== undefined) ? `, ${opposing.length} OPPOSING this ${signal.type}` : ", sides not instrumented"}):`,
    );
    signal.fullAttentionScores.forEach((f) => {
      lines.push(`      ${renderFeature(f, signal.type)}`);
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
  // ITEM 100(e): market structure telemetry (BoS / ChoCh / Order Blocks).
  // Telemetry ONLY — nothing is wired into scoring. Computed from the signal's
  // learningContext if available, or reported as not-instrumented.
  const lcMs = signal.learningContext;
  if (lcMs && typeof lcMs === 'object') {
    const lcRaw = lcMs as unknown as Record<string, unknown>;
    const obData = lcRaw.orderBlocks;
    const bosData = lcRaw.lastBos;
    const chochData = lcRaw.lastChoch;
    const trendData = lcRaw.prevailingTrend;
    if (trendData || bosData || chochData || obData) {
      lines.push(`    market structure (ITEM 100, telemetry only — NOT wired into scoring):`);
      if (trendData) lines.push(`      prevailing trend: ${String(trendData)}`);
      if (bosData) lines.push(`      last BoS: ${JSON.stringify(bosData)}`);
      if (chochData) lines.push(`      last ChoCh: ${JSON.stringify(chochData)}`);
      if (obData && Array.isArray(obData)) {
        lines.push(`      order blocks (${obData.length}):`);
        for (const ob of obData) {
          lines.push(`        ${String((ob as Record<string, unknown>).direction)} OB [${Number((ob as Record<string, unknown>).low).toFixed(1)}-${Number((ob as Record<string, unknown>).high).toFixed(1)}] mitigated=${String((ob as Record<string, unknown>).mitigated)}`);
        }
      }
    }
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

/**
 * ITEM 12(d) - learning-corpus provenance block, rendered INSIDE SECTION 2 so a
 * weight vector and the corpus it was trained on are never read apart.
 */
function formatLearningCorpusBlock(stats: LearningCorpusStatsInput | null | undefined): string[] {
  const lines: string[] = ["", "Learning corpus (trade_outcomes_v1 - DIRECT paginated Supabase read, anon key):"];
  if (!stats) {
    lines.push("  NOT INSTRUMENTED - caller did not supply learningCorpusStats.");
    lines.push("  (Deliberately distinct from zero: no data was reported, not zero failures.)");
    return lines;
  }
  lines.push(`  Counters rehydrated from durable storage: ${stats.hydrated ? "yes" : "NOT YET (process-only so far)"}`);
  lines.push(`  Hydrate attempts: ${stats.hydrateAttempts}`);
  lines.push(`  Hydrate successes: ${stats.hydrateSuccesses}`);
  lines.push(`  Hydrate UNAVAILABLE: ${stats.hydrateUnavailableCount}`);
  lines.push(`  Last pull: ${stats.lastPulled === null ? "n/a" : stats.lastPulled} row(s) across ${stats.lastPages === null ? "n/a" : stats.lastPages} page(s)`);
  lines.push(`  Local corpus total after last hydrate: ${stats.lastTotal === null ? "n/a" : stats.lastTotal}`);
  lines.push(`  Pull hit the limit (durable corpus is larger): ${stats.lastTruncatedByLimit ? "YES" : "no"}`);
  lines.push(`  Last successful hydrate: ${safeDate(stats.lastSuccessAt)}`);
  if (stats.hydrateUnavailableCount > 0) {
    lines.push("");
    lines.push(`  ** CORPUS WAS UNAVAILABLE ${stats.hydrateUnavailableCount} time(s). Any retrain that ran while it was`);
    lines.push("     unavailable trained on the LOCAL tier only, which on web is wiped on every reload.");
    lines.push(`     Last reason: ${stats.lastUnavailableReason ?? "unknown"}`);
    lines.push(`     Last occurred: ${safeDate(stats.lastUnavailableAt)}`);
  }
  return lines;
}

/**
 * ITEM 74(b)(c) - the OUTBOUND half of the corpus sync, rendered immediately
 * under the hydrate counters so the two directions can never be read apart.
 * ABSENCE of this block in an export is itself an observation: it means the
 * running bundle predates Item 74.
 */
function formatOutboundPushBlock(stats: OutboundPushStatsInput | null | undefined): string[] {
  const lines: string[] = ["", "Outbound push (trade_outcomes_v1 - DIRECT anon-key upsert, onConflict=signal_id):"];
  if (!stats) {
    lines.push("  NOT INSTRUMENTED - caller did not supply outboundPushStats.");
    lines.push("  (Deliberately distinct from zero: no data was reported, not zero pushes.)");
    return lines;
  }
  lines.push(`  Counters rehydrated from durable storage: ${stats.hydrated ? "yes" : "NOT YET (process-only so far)"}`);
  lines.push(`  Push attempts: ${stats.pushAttempts}`);
  lines.push(`  Push successes (chunks accepted): ${stats.pushSuccesses}`);
  lines.push(`  Push failures: ${stats.pushFailures}`);
  lines.push(`  Rows pushed (cumulative ROW count, not call count): ${stats.rowsPushed}`);
  const statuses = Object.entries(stats.failuresByStatus).sort((a, b) => b[1] - a[1]);
  if (statuses.length === 0) {
    lines.push("  Failures by status: none recorded");
  } else {
    lines.push("  Failures by status:");
    for (const [code, n] of statuses) lines.push(`    ${code}: ${n}`);
  }
  const suppressed = Object.entries(stats.suppressedByReason).sort((a, b) => b[1] - a[1]);
  if (suppressed.length === 0) {
    lines.push("  Exited before any network call: none recorded");
  } else {
    lines.push("  Exited before any network call (SUPPRESSED - no request was made):");
    for (const [reason, n] of suppressed) lines.push(`    ${reason}: ${n}`);
  }
  lines.push(`  pendingRemotePush depth RIGHT NOW: ${stats.queueDepthNow}`);
  lines.push(`  pendingRemotePush depth rehydrated at init: ${stats.queueDepthAtInit === null ? "n/a" : stats.queueDepthAtInit}`);
  lines.push(`  Last push attempt: ${safeDate(stats.lastAttemptAt)}`);
  lines.push(`  Last push success: ${safeDate(stats.lastSuccessAt)}`);
  lines.push(`  Last push failure: ${safeDate(stats.lastFailureAt)}`);
  lines.push(`  Last failure body (verbatim, 300 chars): ${stats.lastFailureBody ?? "n/a"}`);
  lines.push("");
  lines.push("  ITEM 74(c) RECONCILIATION (measurement only - recomputed on every hydrate):");
  lines.push(`    Local corpus rows: ${stats.lastLocalCount === null ? "n/a" : stats.lastLocalCount}`);
  lines.push(`    Remote rows returned by the pull: ${stats.lastRemoteCount === null ? "n/a" : stats.lastRemoteCount}`);
  lines.push(`    LOCAL-ONLY (local IDs absent from the remote set): ${stats.lastLocalOnlyCount === null ? "n/a" : stats.lastLocalOnlyCount}`);
  lines.push(`    REMOTE-ONLY (remote IDs absent locally): ${stats.lastRemoteOnlyCount === null ? "n/a" : stats.lastRemoteOnlyCount}`);
  lines.push(`    Last reconcile: ${safeDate(stats.lastReconcileAt)}`);
  lines.push("");
  lines.push("  HOW TO READ THIS. pushAttempts==0 with a non-zero LOCAL-ONLY count means the");
  lines.push("    push was never tried - read the SUPPRESSED reasons. pushAttempts>0 with");
  lines.push("    failures means the path RAN and was REJECTED, and the status code is the");
  lines.push("    answer: 42501 = the anon INSERT policy is absent; 23502 = RLS PASSED and a");
  lines.push("    NOT NULL column is the real problem (Postgres evaluates RLS WITH CHECK");
  lines.push("    BEFORE NOT NULL - established empirically on this project in Item 70).");
  return lines;
}

/**
 * ITEM 74(a) - BUILD PROVENANCE. Repo/production drift is PROVEN here (migration
 * 003 carries invalid CREATE POLICY IF NOT EXISTS syntax in the repo while its
 * policy is live in the database), so a repo grep is not evidence of what runs.
 * Every probe below is a value read AT RUNTIME from the running bundle.
 */
function formatBuildProvenanceBlock(p: BuildProvenanceInput | null | undefined): string[] {
  if (!p) return ["Build provenance: NOT INSTRUMENTED (caller did not supply buildProvenance)."];
  const lines: string[] = [];
  // ITEM 184(a) — substitution failure is LOUD, not silent. Item 168a's marker
  // claimed babel.config.js replaced the placeholders, but no plugin existed,
  // so every export since Item 168 printed literal __BUILD_SHA__.
  //
  // ITEM 201(a) v2 — ROOT CAUSE CORRECTED (was previously mis-attributed to
  // Metro transform-cache staleness): the plugin was accidentally REMOVED
  // from babel.config.js twice on 2026-08-21 — b1c7ca8 (14:48Z, restored by
  // 58a08f1 at 15:00Z) and af7da4a (17:44Z, still absent until 1aacb36+). The
  // 21:21Z export's literal __BUILD_SHA__ needed no staleness theory: with no
  // plugin in the config, no transform substitutes. The MISSING warning had a
  // second, in-repo cause: the original plugin's StringLiteral visitor
  // replaced the placeholders in EVERY module — including THIS detector's own
  // comparison strings — so any plugin-era transform of this file compiled
  // the check to `p.buildSha === "<sha>"`, structurally unable to match a
  // literal placeholder (and a fully-substituted build would FALSELY report
  // FAILED, both sides substituted to the same SHA). The plugin is now SCOPED
  // to constants/buildMarker.ts only, and the sentinels below are built by
  // RUNTIME CONCATENATION so no StringLiteral in this file ever equals the
  // placeholder — no transform, plugin or not, stale or fresh, can defuse
  // this detector. ci_guard_build_marker.ts fails the round if any of this
  // is removed.
  const PLACEHOLDER_SHA = "__BUILD_" + "SHA__";
  const PLACEHOLDER_STAMP = "__BUILD_" + "STAMP__";
  const markerSubstituted =
    p.buildSha !== PLACEHOLDER_SHA && p.markedAt !== PLACEHOLDER_STAMP;
  if (!markerSubstituted) {
    lines.push(
      "⚠️ BUILD MARKER SUBSTITUTION FAILED — the literal placeholder survived into this bundle.",
      "   Either the rork-build-marker plugin is absent from babel.config.js (it was",
      "   accidentally removed twice on 2026-08-21: b1c7ca8, af7da4a) or a stale Metro",
      "   transform cache is serving a pre-plugin module. This export CANNOT be",
      "   attributed to a specific git tree. Run expo/scripts/ci_guard_build_marker.ts",
      "   and rebuild with `expo start -c`. (Items 184a/201a)",
    );
  }
  lines.push(
    `Build marker: ${p.buildSha} (BUILD-DERIVED, babel-injected at transform time — Item 168a)`,
    `Build stamp: ${p.markedAt}`,
    `Build marker substitution: ${markerSubstituted ? "SUCCEEDED (scoped rork-build-marker injected; placeholder absent) — Item 201a" : "FAILED (literal placeholder present — see warning above) — Item 201a"}`,
  );
  lines.push("Runtime symbol probes (read from the RUNNING bundle, never from the repo):");
  for (const probe of p.probes) {
    lines.push(`  [${probe.present ? "PRESENT" : "ABSENT "}] ${probe.label} -> ${probe.observed}`);
  }
  // ITEM 168(b): the claimed-items list is DELETED (Item 168c) — a stale list
  // of claims is worse than none. These RUNTIME-OBSERVED values answer
  // "which bundle is running" from the running code instead.
  if (p.runtimeConfig) {
    lines.push("Runtime configuration probe (gates/modes/counters from the RUNNING code):");
    for (const [key, value] of Object.entries(p.runtimeConfig)) {
      lines.push(`  ${key} = ${String(value)}`);
    }
  }
  return lines;
}

function formatModelWeightsSection(
  modelWeights: RawModelWeights,
  learningCorpusStats?: LearningCorpusStatsInput | null,
  outboundPushStats?: OutboundPushStatsInput | null,
): string {
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
    // ITEM 12 / 11(b): weight provenance. UNKNOWN means the vector predates this
    // telemetry, which is NOT the same claim as trained on 0 outcomes.
    lines.push(
      `Corpus size at training: ${
        modelWeights.corpusSizeAtTraining === null || modelWeights.corpusSizeAtTraining === undefined
          ? "UNKNOWN (vector predates this telemetry - provenance unrecoverable)"
          : `${modelWeights.corpusSizeAtTraining} outcome(s)`
      }`,
    );
    lines.push(
      `Corpus-unavailable count at training: ${
        modelWeights.hydrateUnavailableAtTraining === null || modelWeights.hydrateUnavailableAtTraining === undefined
          ? "UNKNOWN (vector predates this telemetry)"
          : modelWeights.hydrateUnavailableAtTraining
      }`,
    );
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
  // ITEM 12(d): the corpus block renders in BOTH branches - a never-trained model
  // with a repeatedly unavailable corpus is exactly the state worth seeing.
  lines.push(...formatLearningCorpusBlock(learningCorpusStats));
  // ITEM 74(b)(c): the OUTBOUND direction, rendered in both branches for the
  // same reason - a corpus that cannot push is exactly the state worth seeing.
  lines.push(...formatOutboundPushBlock(outboundPushStats));
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
  // ITEM 230(G5) - display-only provenance so Recommended=NO beside Scheduled=YES stops being
  // contradictory ON THE PAGE: the schedule names WHEN it was set and BY WHAT trigger.
  // The trigger logic itself is untouched.
  if (modelHealth.retrainScheduled) {
    lines.push(`Retrain scheduled AT: ${modelHealth.retrainScheduledAtMs ? safeDate(modelHealth.retrainScheduledAtMs) : "unknown (set before Item 230 provenance)"}`);
    lines.push(`Retrain schedule TRIGGER: ${modelHealth.retrainScheduledReason ?? "unknown (set before Item 230 provenance)"}`);
  }
  lines.push("");
  // ITEM 64(d): label corrected from "Feature importance drift" to "Feature value drift"
  // — this metric measures average feature VALUE among winners (central tendency),
  // not marginal contribution / predictive importance.
  lines.push("Feature value drift (avg feature value among winners, not marginal contribution):");
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
  stats: {
    checks: number;
    standAsides: number;
    readyNow: boolean;
    rate24h?: number | null;
    checks24h?: number | null;
    standAsides24h?: number | null;
    recent?: Array<{ ts: number; reason: string; m5Bars: number; newestM5AgeMin: number | null }> | null;
  } | null | undefined,
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
  // ITEM 167(c): the rate above is a LIFETIME cumulative; it hides a degrading
  // layer behind a historical average. The 24h rate is reported separately.
  if (stats.rate24h !== undefined && stats.rate24h !== null && stats.rate24h !== undefined) {
    lines.push(`LAST 24H (separate from lifetime): checks=${stats.checks24h ?? "n/a"} stand-asides=${stats.standAsides24h ?? "n/a"} rate=${(stats.rate24h * 100).toFixed(2)}%`);
  } else {
    lines.push("LAST 24H rate: NOT YET MEASURABLE — hourly snapshots began accumulating at Item 167(d); a 24h rate exists after 24h of runtime.");
  }
  // ITEM 167(d): the WHY. A silent day-long suppressor must be one query away.
  if (stats.recent && stats.recent.length > 0) {
    lines.push("Most recent stand-aside REASONS (why, not just how often):" );
    for (const r of stats.recent.slice(-5)) {
      lines.push(`  ${new Date(r.ts).toISOString()} — ${r.reason} (m5Bars=${r.m5Bars}${r.newestM5AgeMin !== null ? `, newestBarAge=${r.newestM5AgeMin}min` : ""})`);
    }
  }
  lines.push(`Directional layer ready right now: ${stats.readyNow ? "YES" : "NO"}`);
  lines.push("");
  lines.push("ITEM 4: these counters are DURABLE. They are persisted to AsyncStorage under");
  lines.push("  directional_layer_counters_v1 and rehydrated at init, so they survive an app");
  lines.push("  reload and accumulate across the install lifetime, not one process. A flush");
  lines.push("  happens at most once per 15s, so a hard kill can lose up to 15s of counts.");
  lines.push("F6 criterion 4 refutation threshold: stand-aside rate > 5% of market-open attempts.");
  lines.push("  ITEM 26: 5% is the ONLY threshold governing criterion 4, and it is the same");
  lines.push("  number forwardMonitor.ts gates on (REFUTE.standAsideRatePct = 5). The 25% that");
  lines.push("  circulates alongside it is a DIFFERENT quantity from a DIFFERENT criterion:");
  lines.push("  criterion 2's `atrUnchangedBand` = +/-25%, the band within which realised ATR");
  lines.push("  counts as unchanged. It is not a stand-aside threshold and must never be read");
  lines.push("  against the rate above.");
  lines.push("  NUMERATOR = readiness checks where the bar layer was unavailable or stale.");
  lines.push("  DENOMINATOR = market-open readiness checks only: isDirectionalLayerReady() is");
  lines.push("  reached only from generateSignal(), which is not called when the market is");
  lines.push("  closed, so closed-market minutes enter neither number.");
  return lines.join("\n");
}

/**
 * SECTION 9 -- ITEM 5(d) + ITEM 6(c): Telegram alert delivery health.
 *
 * Existed because the alert path ran through the Rork backend, which returns 503
 * in bursts; a burst longer than the client's retry horizon lost the alert
 * outright and nothing recorded it. ITEM 6 moved delivery to the Supabase Edge
 * Function `send-telegram-alert` behind a durable outbox, so this section now
 * reports BOTH what this process saw and what the durable outbox holds.
 */
function formatTelegramDeliverySection(
  stats: TelegramDeliveryStatsInput | null | undefined,
  outbox?: TelegramOutboxSummaryInput | null,
): string {
  const lines = [DRULE, "SECTION 9 - TELEGRAM ALERT DELIVERY (ITEM 5d / ITEM 6c)", DRULE];

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
  lines.push("-- OUTBOX HANDLING BY THIS PROCESS (ITEM 6c) --");
  lines.push(
    `Alerts persisted to telegram_outbox_v1:   ${stats.outboxEnqueued ?? "n/a (pre-ITEM-6 client)"}`,
  );
  lines.push(
    `Outbox insert failures (function enrolled): ${stats.outboxEnqueueFailures ?? "n/a (pre-ITEM-6 client)"}`,
  );
  lines.push(
    `Handed to the drain (persisted, not delivered inline): ${stats.outboxHandoffs ?? "n/a (pre-ITEM-6 client)"}`,
  );
  lines.push("");
  lines.push("-- DURABLE OUTBOX STATE (read DIRECTLY from Supabase, anon key) --");
  if (!outbox) {
    lines.push("NOT INSTRUMENTED - caller supplied no telegramOutbox summary, or the");
    lines.push("  direct Supabase read failed. This is NOT the same as an empty outbox.");
  } else {
    lines.push(`Window: last ${outbox.windowHours}h`);
    lines.push(`PENDING (awaiting a drain retry):     ${outbox.pending}`);
    lines.push(`DELIVERED:                            ${outbox.delivered}`);
    lines.push(`  of which delivered ON RETRY:        ${outbox.deliveredOnRetry}`);
    lines.push(`AGED OUT (never delivered, TTL 10m):  ${outbox.agedOut}`);
    lines.push(
      `Oldest pending age: ${outbox.oldestPendingAgeSec === null ? "n/a" : outbox.oldestPendingAgeSec + "s"}`,
    );
    lines.push(`Most recent outbox error: ${outbox.lastError ?? "none"}`);
    lines.push("");
    lines.push("AGED_OUT is DERIVED, not assumed: across 40,000 anchor minutes of");
    lines.push("  gold_m1_bars the +/-$2.0 entry band is still touched 95% @2m, 76% @5m,");
    lines.push("  59.7% @10m, 50.4% @15m. At 10 minutes an alert is about as likely to be");
    lines.push("  unexecutable as executable, so delivery stops rather than pushing the");
    lines.push("  executor into a stale trade.");
    lines.push("REFUTATION THRESHOLDS: agedOut > 0 means a trade was never sent;");
    lines.push("  pending with oldestPendingAge > 120s means the pg_cron drain is not running.");
  }
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
    // ITEM 74(a): build provenance FIRST - every number below is only
    // interpretable once you know which bundle produced it.
    formatBuildProvenanceBlock(input.buildProvenance).join("\n"),
    "",
    formatSignalHistorySection(input.signalHistory),
    "",
    formatModelWeightsSection(input.modelWeights, input.learningCorpusStats, input.outboundPushStats),
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
    formatTelegramDeliverySection(input.telegramDeliveryStats, input.telegramOutbox),
    "",
    DRULE,
    "END OF EXPORT",
    DRULE,
  ];
  return sections.join("\n");
}
