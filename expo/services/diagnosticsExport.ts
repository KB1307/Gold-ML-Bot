import { FeatureConfidence, PerformanceMetrics, TradingSignal, SignalLearningContext } from "@/types/trading";
import { renderAttentionAnnotation } from "@/services/attentionTelemetry";
import { formatWeightSignAudit } from "@/services/modelFitting";
import type { signalEngine } from "@/services/signalEngine";
import type { DiagnosticEvent } from "@/services/diagnosticEventStore";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ModelHealthMetrics = ReturnType<typeof signalEngine.getModelHealthMetrics>;
/** ITEM AD — shadow-mode aggregates + promotion-gate verdict (read-only). */
export type ModelShadowStats = ReturnType<typeof signalEngine.getModelShadowStats>;
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
  /**
   * ITEM AA — corpus-cleanup provenance. What the vector was actually fitted
   * on: raw corpus size, how many rows carried featuresSource=
   * 'app-bar-reconstruction' (excluded from fitting, read-side only), and how
   * many engine-native rows were used. `null` means the vector predates the
   * Item AA filter — provenance unknown is not the same claim as excluded 0.
   */
  corpusTotal?: number | null;
  corpusExcludedReconstruction?: number | null;
  /** ITEM AE — of the excluded, how many carried the explicit marker. */
  corpusExcludedReconstructionMarked?: number | null;
  /** ITEM AE — of the excluded, how many were caught by the defaulted-feature fingerprint alone. */
  corpusExcludedReconstructionFingerprint?: number | null;
  corpusUsedForTraining?: number | null;
  /**
   * ITEM AC — architecture + fit provenance. 'logistic_regression_v1' once the
   * centroid scorer has been replaced and a logistic fit has been persisted;
   * null on a vector that predates Item AC.
   */
  architecture?: string | null;
  fitIterations?: number | null;
  fitFinalLoss?: number | null;
  fitRowsUsed?: number | null;
  fitExcludedNaN?: number | null;
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

export interface RecentSignalModelView {
  signalId: string;
  timestamp: string;
  type: "BUY" | "SELL";
  confidence: number;
  learningContext: SignalLearningContext | null;
}

/** ITEM DC — structural view of the engine's per-path M5 feed failure diagnostics. */
interface M5FeedPathDiagnosticsInput {
  counters: { fetch_error: number; zero_rows: number; all_stale: number; interval_guard: number };
  lastReason: string | null;
  lastReasonAt: number | null;
  lastDetail: string | null;
}

export interface DiagnosticsExportInput {
  signalHistory: TradingSignal[];
  modelWeights: RawModelWeights;
  modelHealth: ModelHealthMetrics;
  performanceMetrics: PerformanceMetrics;
  /**
   * ITEM AB — the most recent emitted signal's model telemetry (its learning
   * context), rendered under SECTION 2 so the feature vector — including the
   * seven new side-relative features — is visible in every export.
   */
  recentSignalModel?: RecentSignalModelView | null;

  /**
   * ITEM AD — shadow-mode aggregates (getModelShadowStats): counts, win rates
   * and EV for the AGREE/DISAGREE buckets plus the promotion-gate verdict.
   * Rendered as SECTION 11. Read-only — nothing here suppresses a signal.
   */
  modelShadowStats?: ModelShadowStats | null;

  /**
   * ITEM CF — SECTION 12: shadow forward books for the three scored strategies
   * (SCORED_DT_SHORT / SCORED_REOPEN_LONG / ZONE_RETEST_LONG), fetched DIRECTLY
   * from Supabase via `fetchShadowForwardBooksStats` (anon read, paginated —
   * Item 12 pattern). Read-only: the section REPORTS the pre-registered
   * PROMOTION/ABORT gates and the backtest FINGERPRINT check; nothing in the
   * emission or gating path consumes it. Optional so older callers still
   * compile; the section then reports NOT INSTRUMENTED rather than zeros.
   */
  shadowForwardBooks?: ShadowForwardBooksStats | null;

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
    /**
     * ITEM DC — per-reason M5 feed failure diagnostics
     * (`signalEngine.getM5FeedDiagnostics()`, flowing through
     * getDirectionalLayerStats()). Diagnostic only; counters are in-process
     * (not persisted) and nothing in gating reads them.
     */
    m5FeedDiagnostics?: {
      item3: M5FeedPathDiagnosticsInput;
      f1: M5FeedPathDiagnosticsInput;
    } | null;
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
   * ITEM P: mutually-exclusive emission-funnel counters for the CONDITIONAL
   * band-proximity veto (bandProximityVeto.getVetoFunnel()). generated ==
   * emitted + suppressed; suppressed candidates are written to
   * shadow_candidates_v1 and are never emitted/Telegram'd. Optional so older
   * callers still compile; the section then reports NOT INSTRUMENTED.
   */
  vetoFunnel?: VetoFunnelInput | null;
  /**
   * EMISSION FUNNEL: mutually-exclusive exit-path counters from the engine
   * (`signalEngine.getEmissionFunnel()`). One bucket per generateSignal() exit;
   * attempts == the engine's signalGenerationAttempts counter. Optional so older
   * callers still compile; the section then reports NOT INSTRUMENTED.
   */
  emissionFunnel?: {
    attempts: number;
    rejections: Record<string, number>;
    rejectionTotal: number;
    emitted: number;
    accounted: number;
    invariantOk: boolean;
    /**
     * Durable copy (AsyncStorage, hydrated at boot, max-merged, 15s flush) —
     * survives app reloads. Optional so older callers still compile; the
     * section then reports the durable block as NOT INSTRUMENTED.
     */
    durableAttempts?: number;
    durableRejections?: Record<string, number>;
    durableRejectionTotal?: number;
    durableEmitted?: number;
    durableAccounted?: number;
    durableInvariantOk?: boolean;
    durableHydrated?: boolean;
  } | null;
  /**
   * ITEM 17b/17c: entry-anchor + geometry gate counters
   * (`signalEngine.getEntryAnchorGateStats()`), rendered alongside the funnel.
   * anchorChecks/anchorStaleRejections and geometryChecks/
   * geometryUnwinnableRejections count EVALUATIONS (pre-existing counters), not
   * 1:1 with attempts — they are sub-gate detail under the funnel buckets
   * ENTRY_ANCHOR_STALE / GEOMETRY_UNWINNABLE.
   */
  entryAnchorGateStats?: {
    anchorChecks: number;
    anchorStaleRejections: number;
    geometryChecks: number;
    geometryUnwinnableRejections: number;
  } | null;
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

/**
 * ITEM AB — renders the most recent emitted signal's 13-value model vector
 * (the six legacy scalars plus the seven side-relative features) under
 * SECTION 2, so feature-vector changes are visible in every export. A null
 * feature prints as "null (not computable)" — insufficient bars at emission,
 * which training excludes and scoring standardises.
 */
function formatRecentSignalModelBlock(recent: RecentSignalModelView | null | undefined): string[] {
  const lines: string[] = [""];
  lines.push("Most recent signal — model vector (Item AB):");
  if (!recent || !recent.learningContext) {
    lines.push("  (no emitted signal available yet)");
    return lines;
  }
  const lc = recent.learningContext;
  lines.push(`  signal ${recent.signalId} | ${recent.timestamp} | ${recent.type} | confidence ${recent.confidence.toFixed(4)}`);
  const fmt = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(6) : "null (not computable)");
  lines.push(
    `  legacy: rsi=${fmt(lc.rsi)} | atr=${fmt(lc.atr)} | volumeRatio=${fmt(lc.volumeRatio)} | ` +
    `sentiment=${fmt(lc.sentiment?.score)} | dxyChange=${fmt(lc.dxyChange)} | timeWindowFactor=${fmt(lc.timeWindowFactor)}`,
  );
  lines.push(
    `  side-relative: feat_trend_aligned=${fmt(lc.feat_trend_aligned)} | feat_rsi_aligned=${fmt(lc.feat_rsi_aligned)} | ` +
    `feat_ema_stack=${fmt(lc.feat_ema_stack)} | feat_session_level_count=${fmt(lc.feat_session_level_count)} | ` +
    `feat_at_day_extreme=${fmt(lc.feat_at_day_extreme)} | feat_zone_max_react=${fmt(lc.feat_zone_max_react)} | ` +
    `feat_near_round50=${fmt(lc.feat_near_round50)}`,
  );
  return lines;
}

function formatModelWeightsSection(
  modelWeights: RawModelWeights,
  learningCorpusStats?: LearningCorpusStatsInput | null,
  outboundPushStats?: OutboundPushStatsInput | null,
  recentSignalModel?: RecentSignalModelView | null,
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
    // ITEM AA + AE — what the vector was actually fitted on after the read-side
    // reconstruction-row exclusion. The operator sees BOTH exclusion sub-counts:
    // the explicit featuresSource marker and the Item AE defaulted-feature
    // fingerprint. Sub-counts UNKNOWN when the vector predates Item AE.
    const aeUnknown = "UNKNOWN (predates Item AE)";
    lines.push(
      `Corpus cleanup (Item AA+AE): total ${
        modelWeights.corpusTotal ?? "UNKNOWN (vector predates Item AA)"
      } | excluded reconstruction (marked + fingerprint) ${
        modelWeights.corpusExcludedReconstructionMarked ?? aeUnknown
      } + ${
        modelWeights.corpusExcludedReconstructionFingerprint ?? aeUnknown
      } = ${
        modelWeights.corpusExcludedReconstruction ?? "UNKNOWN (vector predates Item AA)"
      } | used for training ${
        modelWeights.corpusUsedForTraining ?? "UNKNOWN (vector predates Item AA)"
      }`,
    );
    // ITEM AC — which scorer produced this vector, and how the fit went.
    lines.push(
      `Scorer architecture (Item AC): ${
        modelWeights.architecture ?? "centroid (vector predates Item AC)"
      }`,
    );
    if (modelWeights.architecture === "logistic_regression_v1") {
      lines.push(
        `Logistic fit: iterations ${modelWeights.fitIterations ?? "?"} | final loss ${
          modelWeights.fitFinalLoss !== null && modelWeights.fitFinalLoss !== undefined
            ? modelWeights.fitFinalLoss.toFixed(6)
            : "?"
        } | rows used ${modelWeights.fitRowsUsed ?? "?"} (NaN-excluded ${modelWeights.fitExcludedNaN ?? "?"}) | lambda 1.0, lr 0.01`,
      );
    }
    // ITEM AG (ML round, weight-sign audit — not the counter-trend AG.2/AG.4)
    // — rendered from the STORED weights. The three
    // backtest expectations are hardcoded reference strings from the completed
    // study (not live measurements). Documentation only — no weight changes.
    lines.push(...formatWeightSignAudit(modelWeights.weights));
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
  // ITEM AB — the most recent signal's feature vector, next to the weights
  // it will be scored against.
  lines.push(...formatRecentSignalModelBlock(recentSignalModel));
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
  // ITEM DB — the SECOND drift instrument, rendered NEXT TO the corpus table so
  // the two are never conflated: these values come from detectConceptDrift (the
  // live window average that SETS driftAlertLevel), while the table below comes
  // from analyzeFeatureValueDrift (trade corpus, diagnostics only, does NOT gate).
  lines.push("LIVE WINDOW DRIFT (detectConceptDrift — this is what sets driftAlertLevel):");
  if (!modelHealth.liveFeatureDrift || modelHealth.liveFeatureDrift.length === 0) {
    lines.push("  (no live drift cycle recorded since this build — renders after the next drift check)");
  } else {
    const v = (x: number): string => String(Number(x.toFixed(4)));
    for (const d of modelHealth.liveFeatureDrift) {
      lines.push(`  ${d.feature}: drift ${d.drift.toFixed(3)}  (recentMean ${v(d.recentMean)} vs historicalMean ${v(d.historicalMean)}, historicalStd ${v(d.historicalStd)})`);
    }
    lines.push(`  average (sentiment_score excluded per Item BE): ${modelHealth.conceptDriftScore.toFixed(4)}  ->  alert ${modelHealth.driftAlertLevel}`);
  }
  lines.push("");
  lines.push("CORPUS DRIFT (analyzeFeatureValueDrift — diagnostics only, does NOT gate):");
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

/**
 * ITEM AD — SECTION 11: shadow-mode performance of the fitted model, computed
 * from resolved rows that carry the emission-time verdict. READ-ONLY: no
 * suppression, filtering, demotion or delay exists anywhere in this pipeline.
 */
function formatModelShadowPerformanceSection(stats: ModelShadowStats | null | undefined): string {
  const lines: string[] = [RULE, "SECTION 11 — MODEL SHADOW PERFORMANCE (Item AD)", RULE];
  if (!stats) {
    lines.push("  (shadow stats unavailable — engine did not provide them)");
    return lines.join("\n");
  }
  lines.push(`Signals with modelVerdict + resolved outcome: ${stats.eligibleCount}`);
  lines.push(
    `  AGREE:    n=${stats.agreeCount} | win rate ${stats.agreeWinRate !== null ? (stats.agreeWinRate * 100).toFixed(1) + "%" : "n/a"} | EV ${stats.agreeEV !== null ? stats.agreeEV.toFixed(4) + "R" : "n/a"}`,
  );
  lines.push(
    `  DISAGREE: n=${stats.disagreeCount} | win rate ${stats.disagreeWinRate !== null ? (stats.disagreeWinRate * 100).toFixed(1) + "%" : "n/a"} | EV ${stats.disagreeEV !== null ? stats.disagreeEV.toFixed(4) + "R" : "n/a"}`,
  );
  lines.push(`  EV delta (AGREE - DISAGREE): ${stats.evDelta !== null ? stats.evDelta.toFixed(4) + "R" : "n/a"}`);
  lines.push(
    `  PROMOTION GATE: ${stats.gate}${stats.gate === "INSUFFICIENT DATA" ? " (needs >= 100 signals with both modelVerdict and a resolved outcome)" : ""}`,
  );
  lines.push("  Shadow mode: the model watches and logs; NOTHING is suppressed or altered.");
  return lines.join("\n");
}

// ═══ ITEM CF — SECTION 12: SHADOW FORWARD BOOKS ═══
// Read-only forward accounting for the three shadow strategies written by
// shadowStrategies.persistShadowStrategy (Items BA/BB/CA/CD/CE). This section
// REPORTS the pre-registered PROMOTION/ABORT gates — it never acts on them:
// no promotion, suppression, delay or demotion is wired to these numbers.
//
// Data sources (verified against live code; ITEM EE revision 2026-09-09):
//  • shadow_candidates_v1 rows for the three candidate names, EXCLUDING every
//    row with inputs.geometryVersion < 3 (ITEM EB: pre-EB DT/REOPEN rows carry
//    SL12/TP10, pre-CD ZONE rows carry SL $15, pre-CE rows lack the key
//    entirely — Items CD/CE/EB).
//  • ITEM EE — strategy-book outcomes come from the ITEM DA resolver's jsonb
//    write-back (inputs.resolvedOutcome TP/SL/TIME + resolvedPnlPrice, already
//    $ of the row's OWN geometry and sign-correct for direction) — NOT a
//    trade_outcomes_v1 join. The join is GONE: EA rows carry signalId: null
//    (no emitted signal exists to join), and the resolver's resolved $ is the
//    row's own flat-geometry outcome, superseding the CF-era realized_r × sl
//    approximation. The corpus fetch is removed with it.
//  • FINGERPRINT median MFE reads inputs.mfe — written by the DA resolver at
//    resolution time (own-$ MFE), no longer a corpus approximation.
//
// EV$ = sum(resolvedPnlPrice) / resolved — each row's OWN $, never a shared
// constant. EV is computed ONLY over resolved rows; unresolved rows never
// contribute a cent. Per-arm verdicts print INSUFFICIENT DATA below their
// pre-registered n (swing arms ≥100 decided, cap arm ≥50).

export type ShadowForwardCandidateName =
  | "SCORED_DT_SHORT"
  | "SCORED_REOPEN_LONG"
  | "ZONE_RETEST_LONG";

interface ShadowCandidateRow {
  candidate_name: string;
  evaluated_at: string;
  direction: string;
  entry: number;
  inputs: {
    signalId?: string;
    scoreVerdict?: "ABOVE" | "BELOW" | null;
    geometryVersion?: number;
    geometry?: { sl?: number; tp?: number; timeStopBars?: number } | null;
    mfe?: number | null;
    /** Item EC — swing gate (report-only), both arms written. */
    swingBlocked?: boolean | null;
    lastSwingHigh?: number | null;
    lastSwingLow?: number | null;
    swingCausalGap?: number | null;
    /** Item ED — concurrency cap (report-only); null = count unavailable that scan. */
    capSkipped?: boolean | null;
    openPositionsAtSignal?: number | null;
    /** Item DA resolver write-back (suppressed-gate books + Item EE strategy books). */
    resolvedOutcome?: string | null;
    resolvedPnlPrice?: number | null;
  } | null;
}

/** ITEM EE — one cohort arm of a strategy book (resolver write-back outcomes). */
export interface ShadowForwardArmStats {
  rows: number;
  /** resolvedOutcome TP/SL/TIME with finite resolvedPnlPrice. */
  resolved: number;
  wins: number;
  stopOuts: number;
  flat: number;
  /** resolvedOutcome null — still open or not yet reached by the resolver. */
  unresolved: number;
  /** Outcome present but not TP/SL/TIME, or pnl not finite — counted, never dropped. */
  malformed: number;
  sumPnl$: number;
  evPerTrade$: number | null;
  winRate: number | null;
}

export interface ShadowForwardBookStats {
  candidateName: ShadowForwardCandidateName;
  firstEntryAt: string | null;
  totalRows: number;
  /** ITEM EB — rows below geometryVersion 3 excluded (see the block header). */
  excludedPreV3: number;
  /** Geometry read from the rows' OWN inputs.geometry (e.g. "SL$10/TP$12/T96"); null when no v3 rows. */
  geometryLabel: string | null;
  above: ShadowForwardArmStats;
  below: ShadowForwardArmStats;
  swingAllowed: ShadowForwardArmStats;
  swingBlocked: ShadowForwardArmStats;
  capSkipped: ShadowForwardArmStats;
  /** v3 rows without a swingBlocked key (EB→EC deploy gap) — never force-classified. */
  swingUnmeasured: number;
  /** v3 rows without a capSkipped key (EB→ED deploy gap). */
  capUnmeasured: number;
  /** ITEM EE — the tradeable cohort: ABOVE + swing-allowed + not cap-skipped. */
  portfolio: ShadowForwardArmStats;
  /** FINGERPRINT — median inputs.mfe ($, resolver-written) over resolved ABOVE rows. */
  medianMfe$: number | null;
  mfeSampleCount: number;
}

/** ITEM DD — the three suppressed-gate candidate names (strict equality, never a range). */
export type SuppressedBookName =
  | "BAND_VETO_SUPPRESSED"
  | "DRIFT_VETO_SUPPRESSED"
  | "MID_RSI_SUPPRESSED";

/**
 * ITEM DD — one suppressed-gate book. "Decided" = the Item DA shadow resolver
 * wrote resolvedOutcome TP/SL/TIME; resolvedPnlPrice is ALREADY $ of price
 * movement sign-correct for direction (−sl / +tp / TIME close delta), so
 * sumPnl$ accumulates it directly. Win/stop-out/flat classify by OUTCOME
 * (TIME can carry either sign — its $ lands in sumPnl$ regardless).
 */
export interface SuppressedBookStats {
  candidateName: SuppressedBookName;
  firstEntryAt: string | null;
  totalRows: number;
  /** Resolver step-2 skips (pre-CD geometry, marked UNRESOLVED with a note). */
  excludedPreV2: number;
  /** v2 rows with a malformed outcome/pnl — counted, never silently dropped. */
  malformedV2: number;
  /** resolvedOutcome null — still open or not yet reached by the resolver. */
  unresolved: number;
  decided: number;
  wins: number;
  stopOuts: number;
  flat: number;
  sumPnl$: number;
  evPerTrade$: number | null;
}

export interface ShadowForwardBooksStats {
  generatedAt: string;
  books: Record<ShadowForwardCandidateName, ShadowForwardBookStats>;
  /**
   * ITEM DD — the three suppressed-gate books. Their rows are never emitted
   * (no signalId), so their outcomes do NOT come from the trade_outcomes_v1
   * join: the Item DA shadow resolver resolves each row against its own flat
   * geometry and writes resolvedOutcome + resolvedPnlPrice into inputs.
   */
  suppressedBooks: Record<SuppressedBookName, SuppressedBookStats>;
  /** ITEM EE — portfolio across the three books (same cohort definition). */
  portfolio: {
    decided: number;
    wins: number;
    stopOuts: number;
    sumPnl$: number;
    evPerTrade$: number | null;
    winRate: number | null;
  };
  /** ITEM EE — mean pairwise monthly correlation of the books' portfolio PnL. */
  correlation: {
    /** null = INSUFFICIENT DATA (needs ≥6 shared months per pair). */
    value: number | null;
    monthsUsed: number;
    detail: string;
  };
}

/**
 * Pre-registered promotion/abort gates, locked per candidate. The backtest
 * reference figures are the BD-era corpus values — retained as labelled
 * context ONLY; ITEM EE's reporting computes NOTHING against them (the EB
 * measured-basis figures are n=633 55% +$1.95 / n=147 71% +$6.73 / n=318 58%
 * +$3.63).
 */
const SECTION12_BOOKS: ReadonlyArray<{
  name: ShadowForwardCandidateName;
  tag: string;
  promoDecidedAbove: number;
  abortWindowDecidedAbove: number;
  backtest: { n: number; winRate: number; evPerTrade: number; stopOutRate: number; medianMfe: number };
  expectedPerDay: number;
}> = [
  {
    name: "SCORED_DT_SHORT",
    tag: "DT",
    promoDecidedAbove: 100,
    abortWindowDecidedAbove: 50,
    backtest: { n: 623, winRate: 0.62, evPerTrade: 1.56, stopOutRate: 0.36, medianMfe: 3.36 },
    expectedPerDay: 1.6,
  },
  {
    name: "SCORED_REOPEN_LONG",
    tag: "REOPEN",
    promoDecidedAbove: 60,
    abortWindowDecidedAbove: 40,
    backtest: { n: 148, winRate: 0.66, evPerTrade: 2.49, stopOutRate: 0.31, medianMfe: 4.2 },
    expectedPerDay: 0.4,
  },
  {
    name: "ZONE_RETEST_LONG",
    tag: "ZONE",
    promoDecidedAbove: 100,
    abortWindowDecidedAbove: 50,
    backtest: { n: 322, winRate: 0.58, evPerTrade: 4.07, stopOutRate: 0.39, medianMfe: 6.36 },
    expectedPerDay: 0.8,
  },
];

/**
 * ITEM DD — the suppressed-gate forward books: the gates' own refutation
 * instrument. Pre-registered gate per book (the P.3 abort-gate contract
 * generalized to all three): at forward n >= 30 decided rows, EV_net > 0 means
 * the gate is suppressing net winners → the section prints the refutation
 * line. REPORT-ONLY; nothing auto-acts on it.
 */
const SUPPRESSED_BOOKS: ReadonlyArray<{
  name: SuppressedBookName;
  tag: string;
  gateDecided: number;
}> = [
  { name: "BAND_VETO_SUPPRESSED", tag: "BAND", gateDecided: 30 },
  { name: "DRIFT_VETO_SUPPRESSED", tag: "DRIFT", gateDecided: 30 },
  { name: "MID_RSI_SUPPRESSED", tag: "MID", gateDecided: 30 },
];

/** ITEM EE — pre-registered verdict thresholds (locked): swing arms and cap arm. */
const SWING_VERDICT_MIN_DECIDED = 100;
const CAP_VERDICT_MIN_DECIDED = 50;

/** ITEM EE — a zeroed cohort arm. */
function emptyArm(): ShadowForwardArmStats {
  return { rows: 0, resolved: 0, wins: 0, stopOuts: 0, flat: 0, unresolved: 0, malformed: 0, sumPnl$: 0, evPerTrade$: null, winRate: null };
}

/**
 * ITEM EE — route one row into a cohort arm. Resolution state per the Item DA
 * write-back: resolvedOutcome null → unresolved; TP/SL/TIME with finite
 * resolvedPnlPrice → decided (pnl accumulated as written — each row's OWN $,
 * never a shared constant); anything else → malformed (counted, never dropped).
 */
function routeArm(arm: ShadowForwardArmStats, inputs: NonNullable<ShadowCandidateRow["inputs"]>): void {
  arm.rows += 1;
  const outcome = inputs.resolvedOutcome;
  if (outcome === null || outcome === undefined) {
    arm.unresolved += 1;
    return;
  }
  const pnl = Number(inputs.resolvedPnlPrice);
  if ((outcome !== "TP" && outcome !== "SL" && outcome !== "TIME") || !Number.isFinite(pnl)) {
    arm.malformed += 1;
    return;
  }
  arm.resolved += 1;
  arm.sumPnl$ += pnl;
  if (outcome === "TP") arm.wins += 1;
  else if (outcome === "SL") arm.stopOuts += 1;
  else arm.flat += 1;
}

/** ITEM EE — derived arm stats; EV/WR over RESOLVED rows only. */
function finalizeArm(arm: ShadowForwardArmStats): void {
  if (arm.resolved > 0) {
    arm.evPerTrade$ = arm.sumPnl$ / arm.resolved;
    arm.winRate = arm.wins / arm.resolved;
  }
}

/** ITEM EE — Pearson r; null when degenerate (constant series / length < 2). */
function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * DIRECT paginated anon-key read of the three shadow forward books and the
 * three suppressed-gate books (Item DD). ITEM EE: strategy-book outcomes come
 * from the Item DA resolver's write-back (resolvedOutcome/resolvedPnlPrice) —
 * the trade_outcomes_v1 corpus join is REMOVED (EA rows carry signalId: null;
 * the resolver's resolved $ supersedes the realized_r × sl approximation).
 * `.in` with the SIX exact names preserves candidate-name isolation — the
 * item249 strict-equality rule generalized, never a range or prefix match.
 */
export async function fetchShadowForwardBooksStats(
  client: SupabaseClient,
): Promise<ShadowForwardBooksStats> {
  const names = [...SECTION12_BOOKS.map((b) => b.name), ...SUPPRESSED_BOOKS.map((b) => b.name)];

  const candidateRows: ShadowCandidateRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client
      .from("shadow_candidates_v1")
      .select("candidate_name, evaluated_at, direction, entry, inputs")
      .in("candidate_name", [...names])
      .order("evaluated_at", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw error;
    const rows = (data ?? []) as unknown as ShadowCandidateRow[];
    candidateRows.push(...rows);
    if (rows.length < 1000) break;
  }

  const books = {} as Record<ShadowForwardCandidateName, ShadowForwardBookStats>;
  // ITEM EE — monthly resolved portfolio PnL per book, for the correlation check.
  const monthlyPnl = new Map<ShadowForwardCandidateName, Map<string, { sum: number; n: number }>>();
  for (const book of SECTION12_BOOKS) {
    const rows = candidateRows.filter((r) => r.candidate_name === book.name);
    const stats: ShadowForwardBookStats = {
      candidateName: book.name,
      firstEntryAt: rows[0]?.evaluated_at ?? null,
      totalRows: rows.length,
      excludedPreV3: 0,
      geometryLabel: null,
      above: emptyArm(),
      below: emptyArm(),
      swingAllowed: emptyArm(),
      swingBlocked: emptyArm(),
      capSkipped: emptyArm(),
      swingUnmeasured: 0,
      capUnmeasured: 0,
      portfolio: emptyArm(),
      medianMfe$: null,
      mfeSampleCount: 0,
    };
    const mfeSamples: number[] = [];
    for (const row of rows) {
      const inputs = row.inputs ?? {};
      // ITEM EB — the geometry era moved 2 → 3 (per-strategy DT/REOPEN split);
      // every row below 3 carries superseded geometry and is excluded, alongside
      // the pre-CD/pre-CE rows the v2 line already caught.
      const gv = Number(inputs.geometryVersion);
      if (!Number.isFinite(gv) || gv < 3) {
        stats.excludedPreV3 += 1;
        continue;
      }
      const geo = inputs.geometry;
      if (
        stats.geometryLabel === null &&
        typeof geo?.sl === "number" && typeof geo?.tp === "number" && typeof geo?.timeStopBars === "number"
      ) {
        stats.geometryLabel = `SL$${geo.sl}/TP$${geo.tp}/T${geo.timeStopBars}`;
      }
      const above = inputs.scoreVerdict === "ABOVE";
      routeArm(above ? stats.above : stats.below, inputs);
      // ITEM EC — swing gate, both arms written; unmeasured rows (EB→EC deploy
      // gap) are counted separately, never force-classified.
      if (inputs.swingBlocked === true) routeArm(stats.swingBlocked, inputs);
      else if (inputs.swingBlocked === false) routeArm(stats.swingAllowed, inputs);
      else stats.swingUnmeasured += 1;
      // ITEM ED — the cap arm receives ONLY genuinely skipped rows; unmeasured
      // rows (EB→ED deploy gap) counted separately.
      if (inputs.capSkipped === true) routeArm(stats.capSkipped, inputs);
      else if (inputs.capSkipped !== false) stats.capUnmeasured += 1;
      // ITEM EE — portfolio: the tradeable cohort (ABOVE + swing-allowed + not
      // cap-skipped). Its monthly resolved PnL feeds the correlation check.
      if (above && inputs.swingBlocked === false && inputs.capSkipped !== true) {
        routeArm(stats.portfolio, inputs);
        const pnl = Number(inputs.resolvedPnlPrice);
        if (
          (inputs.resolvedOutcome === "TP" || inputs.resolvedOutcome === "SL" || inputs.resolvedOutcome === "TIME") &&
          Number.isFinite(pnl)
        ) {
          const month = row.evaluated_at.slice(0, 7);
          let series = monthlyPnl.get(book.name);
          if (!series) {
            series = new Map<string, { sum: number; n: number }>();
            monthlyPnl.set(book.name, series);
          }
          const entry = series.get(month) ?? { sum: 0, n: 0 };
          entry.sum += pnl;
          entry.n += 1;
          series.set(month, entry);
        }
      }
      // FINGERPRINT — resolver-written own-$ MFE on resolved ABOVE rows.
      if (above) {
        const mfe = Number(inputs.mfe);
        const outcome = inputs.resolvedOutcome;
        if (
          (outcome === "TP" || outcome === "SL" || outcome === "TIME") &&
          Number.isFinite(Number(inputs.resolvedPnlPrice)) &&
          Number.isFinite(mfe)
        ) {
          mfeSamples.push(mfe);
        }
      }
    }
    finalizeArm(stats.above);
    finalizeArm(stats.below);
    finalizeArm(stats.swingAllowed);
    finalizeArm(stats.swingBlocked);
    finalizeArm(stats.capSkipped);
    finalizeArm(stats.portfolio);
    if (mfeSamples.length > 0) {
      const sorted = [...mfeSamples].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      stats.medianMfe$ = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      stats.mfeSampleCount = sorted.length;
    }
    books[book.name] = stats;
  }

  // ITEM DD — suppressed-gate books: outcomes come from the Item DA resolver's
  // write-back (resolvedOutcome/resolvedPnlPrice), NOT the trade_outcomes join
  // (suppressed candidates are never emitted — they have no signalId).
  const suppressedBooks = {} as Record<SuppressedBookName, SuppressedBookStats>;
  for (const book of SUPPRESSED_BOOKS) {
    const rows = candidateRows.filter((r) => r.candidate_name === book.name);
    const s: SuppressedBookStats = {
      candidateName: book.name,
      firstEntryAt: rows[0]?.evaluated_at ?? null,
      totalRows: rows.length,
      excludedPreV2: 0,
      malformedV2: 0,
      unresolved: 0,
      decided: 0,
      wins: 0,
      stopOuts: 0,
      flat: 0,
      sumPnl$: 0,
      evPerTrade$: null,
    };
    for (const row of rows) {
      const inputs = row.inputs ?? {};
      const gv = Number(inputs.geometryVersion);
      if (!Number.isFinite(gv) || gv < 2) {
        s.excludedPreV2 += 1;
        continue;
      }
      const outcome = inputs.resolvedOutcome;
      if (outcome === null || outcome === undefined) {
        // Still open, or not yet reached by the resolver (oldest-first, 200/pass).
        s.unresolved += 1;
        continue;
      }
      if (outcome === "UNRESOLVED") {
        // Resolver step-2 skip note (pre-CD geometry or malformed row).
        s.excludedPreV2 += 1;
        continue;
      }
      const pnl = Number(inputs.resolvedPnlPrice);
      if ((outcome !== "TP" && outcome !== "SL" && outcome !== "TIME") || !Number.isFinite(pnl)) {
        s.malformedV2 += 1;
        continue;
      }
      s.decided += 1;
      s.sumPnl$ += pnl;
      if (outcome === "TP") s.wins += 1;
      else if (outcome === "SL") s.stopOuts += 1;
      else s.flat += 1;
    }
    if (s.decided > 0) s.evPerTrade$ = s.sumPnl$ / s.decided;
    suppressedBooks[book.name] = s;
  }

  // ITEM EE — combined portfolio across the three books.
  const portfolio = {
    decided: 0,
    wins: 0,
    stopOuts: 0,
    sumPnl$: 0,
    evPerTrade$: null as number | null,
    winRate: null as number | null,
  };
  for (const book of SECTION12_BOOKS) {
    const p = books[book.name].portfolio;
    portfolio.decided += p.resolved;
    portfolio.wins += p.wins;
    portfolio.stopOuts += p.stopOuts;
    portfolio.sumPnl$ += p.sumPnl$;
  }
  if (portfolio.decided > 0) {
    portfolio.evPerTrade$ = portfolio.sumPnl$ / portfolio.decided;
    portfolio.winRate = portfolio.wins / portfolio.decided;
  }

  // ITEM EE — mean pairwise monthly correlation (portfolio cohort, resolved $).
  // A pair contributes only with ≥6 SHARED months (both books resolved ≥1 row
  // that month); the reported value is the mean over contributing pairs.
  // Backtest reference: mean −0.11 (DT × ZONE −0.47 strongest).
  const tagOf = Object.fromEntries(SECTION12_BOOKS.map((b) => [b.name, b.tag])) as Record<ShadowForwardCandidateName, string>;
  const pairs: ReadonlyArray<[ShadowForwardCandidateName, ShadowForwardCandidateName]> = [
    ["SCORED_DT_SHORT", "SCORED_REOPEN_LONG"],
    ["SCORED_DT_SHORT", "ZONE_RETEST_LONG"],
    ["SCORED_REOPEN_LONG", "ZONE_RETEST_LONG"],
  ];
  const pairDetails: string[] = [];
  let corrSum = 0;
  let corrPairs = 0;
  let minMonths = Number.POSITIVE_INFINITY;
  for (const [a, b] of pairs) {
    const ma = monthlyPnl.get(a);
    const mb = monthlyPnl.get(b);
    if (!ma || !mb) {
      pairDetails.push(`${tagOf[a]}×${tagOf[b]}: no data`);
      continue;
    }
    const months = [...new Set([...ma.keys()].filter((m) => mb.has(m)))].sort();
    if (months.length < 6) {
      pairDetails.push(`${tagOf[a]}×${tagOf[b]}: ${months.length}mo`);
      continue;
    }
    const r = pearson(months.map((m) => ma.get(m)!.sum), months.map((m) => mb.get(m)!.sum));
    if (r === null) {
      pairDetails.push(`${tagOf[a]}×${tagOf[b]}: degenerate`);
      continue;
    }
    corrSum += r;
    corrPairs += 1;
    minMonths = Math.min(minMonths, months.length);
    pairDetails.push(`${tagOf[a]}×${tagOf[b]} r=${r.toFixed(2)} (${months.length}mo)`);
  }
  const correlation = {
    value: corrPairs > 0 ? corrSum / corrPairs : null,
    monthsUsed: corrPairs > 0 ? minMonths : 0,
    detail: pairDetails.join("; "),
  };

  return { generatedAt: new Date().toISOString(), books, suppressedBooks, portfolio, correlation };
}

/** ITEM EE — one arm line; WR shown only where the spec asks for it. */
function formatArmLine(label: string, arm: ShadowForwardArmStats, showWinRate: boolean): string {
  const parts = [`  ${label.padEnd(16)} [${arm.rows}]  resolved [${arm.resolved}]`];
  if (showWinRate) parts.push(arm.winRate !== null ? `WR ${(arm.winRate * 100).toFixed(1)}%` : "WR n/a");
  parts.push(arm.evPerTrade$ !== null ? `EV $${arm.evPerTrade$.toFixed(2)}` : "EV n/a");
  if (arm.malformed > 0) parts.push(`malformed ${arm.malformed}`);
  return parts.join("  ");
}

function formatShadowForwardBooksSection(stats: ShadowForwardBooksStats | null | undefined): string {
  const lines: string[] = [RULE, "SECTION 12 — SHADOW FORWARD BOOKS (ITEM CF, read-only)", RULE];
  if (!stats) {
    lines.push("  NOT INSTRUMENTED this run — shadowForwardBooks was null (fetch failed or Supabase env missing).");
    lines.push("  fetchShadowForwardBooksStats() IS wired into the export caller (Item CF wiring).");
    lines.push("  The pre-registered gates below are REPORT-ONLY; nothing acts on them.");
    return lines.join("\n");
  }
  // ITEM EE — reporting revision: strategy-book outcomes come from the Item DA
  // resolver's jsonb write-back (resolvedPnlPrice, each row's own geometry);
  // the trade_outcomes_v1 join is REMOVED (EA rows carry signalId: null and
  // the resolved $ supersedes the realized_r × sl approximation). Rows below
  // geometryVersion 3 are excluded (EB). Per-arm books + portfolio + the
  // correlation check render per the EE spec; verdicts print INSUFFICIENT DATA
  // below their pre-registered n.
  lines.push("  ITEM EE — outcomes: Item DA resolver write-back (resolvedPnlPrice, row's own geometry); strategy rows below geometryVersion 3 excluded (EB).");
  for (const book of SECTION12_BOOKS) {
    const s = stats.books[book.name];
    if (!s) continue;
    lines.push("");
    lines.push(`${book.name}  (${s.geometryLabel ?? "geometry n/a"}, v3)`);
    if (s.totalRows === 0) {
      lines.push(`  no entries yet — expected ~${book.expectedPerDay}/day (${book.tag})`);
      continue;
    }
    const notes: string[] = [];
    if (s.swingUnmeasured > 0) notes.push(`swing-unmeasured ${s.swingUnmeasured}`);
    if (s.capUnmeasured > 0) notes.push(`cap-unmeasured ${s.capUnmeasured}`);
    lines.push(`  entries [${s.totalRows - s.excludedPreV3}]  excluded (v<3) [${s.excludedPreV3}]  since ${s.firstEntryAt ?? "?"}${notes.length > 0 ? `  ${notes.join("  ")}` : ""}`);
    lines.push(formatArmLine("ABOVE:", s.above, true));
    lines.push(formatArmLine("BELOW:", s.below, true));
    lines.push(formatArmLine("swing-ALLOWED:", s.swingAllowed, true));
    lines.push(formatArmLine("swing-BLOCKED:", s.swingBlocked, false));
    if (
      s.swingAllowed.resolved >= SWING_VERDICT_MIN_DECIDED &&
      s.swingBlocked.resolved >= SWING_VERDICT_MIN_DECIDED &&
      s.swingAllowed.evPerTrade$ !== null &&
      s.swingBlocked.evPerTrade$ !== null
    ) {
      lines.push(
        s.swingBlocked.evPerTrade$ < s.swingAllowed.evPerTrade$
          ? `    → gate verdict: gate is working, keep (BLOCKED EV $${s.swingBlocked.evPerTrade$.toFixed(2)} < ALLOWED EV $${s.swingAllowed.evPerTrade$.toFixed(2)})`
          : `    → ⚠️ THE SWING GATE IS REMOVING PROFITABLE SIGNALS (BLOCKED EV $${s.swingBlocked.evPerTrade$.toFixed(2)} >= ALLOWED EV $${s.swingAllowed.evPerTrade$.toFixed(2)}) — remove the gate`,
      );
    } else {
      lines.push(
        `    → INSUFFICIENT DATA — swing verdict needs >=${SWING_VERDICT_MIN_DECIDED} decided per arm (allowed ${s.swingAllowed.resolved}, blocked ${s.swingBlocked.resolved})`,
      );
    }
    lines.push(formatArmLine("cap-SKIPPED:", s.capSkipped, false));
    if (s.capSkipped.resolved >= CAP_VERDICT_MIN_DECIDED && s.capSkipped.evPerTrade$ !== null) {
      lines.push(
        s.capSkipped.evPerTrade$ > 0
          ? `    → the cap is costing money — skipped-cohort EV $${s.capSkipped.evPerTrade$.toFixed(2)} > 0 at n>=${CAP_VERDICT_MIN_DECIDED} — raise the cap`
          : `    → cap cost contained (skipped-cohort EV $${s.capSkipped.evPerTrade$.toFixed(2)} <= 0 at n>=${CAP_VERDICT_MIN_DECIDED})`,
      );
    } else {
      lines.push(`    → INSUFFICIENT DATA — cap verdict needs >=${CAP_VERDICT_MIN_DECIDED} decided skipped rows (have ${s.capSkipped.resolved})`);
    }
    // Pre-registered promotion/abort gates (locked, Items BC/CB) — now read
    // the resolver write-back instead of the corpus join.
    if (s.above.resolved >= book.promoDecidedAbove && s.above.evPerTrade$ !== null && s.above.evPerTrade$ > 0) {
      lines.push(`  GATE: PROMOTION CLEARED (pre-registered: >=${book.promoDecidedAbove} decided-ABOVE AND EV>0) — REPORT ONLY`);
    } else if (s.above.resolved >= book.abortWindowDecidedAbove && s.above.evPerTrade$ !== null && s.above.evPerTrade$ <= 0) {
      lines.push(`  GATE: ABORT WINDOW MET (EV<=0 within first ${book.abortWindowDecidedAbove} decided-ABOVE) — REPORT ONLY`);
    } else {
      lines.push(
        `  GATE: ACCUMULATING — decided-ABOVE ${s.above.resolved}/${book.promoDecidedAbove} toward promotion, ${Math.min(s.above.resolved, book.abortWindowDecidedAbove)}/${book.abortWindowDecidedAbove} through abort window`,
      );
    }
    if (s.mfeSampleCount < 20) {
      lines.push(`  FINGERPRINT: INSUFFICIENT DATA (needs >=20 resolved-ABOVE rows with mfe, have ${s.mfeSampleCount})`);
    } else {
      lines.push(`  FINGERPRINT: median MFE $${(s.medianMfe$ as number).toFixed(2)} over ${s.mfeSampleCount} resolved-ABOVE rows (resolver-written inputs.mfe)`);
    }
  }
  lines.push("");
  lines.push("PORTFOLIO (ABOVE + swing-allowed + not cap-skipped):");
  const p = stats.portfolio;
  if (p.decided === 0) {
    lines.push("  INSUFFICIENT DATA — no resolved portfolio rows yet");
  } else {
    lines.push(
      `  decided [${p.decided}]  WR ${p.winRate !== null ? `${(p.winRate * 100).toFixed(1)}%` : "n/a"}  EV ${p.evPerTrade$ !== null ? `$${p.evPerTrade$.toFixed(2)}` : "n/a"}  sum $${p.sumPnl$.toFixed(2)}`,
    );
  }
  lines.push("  backtest expectation: 47 trades/month, WR 46%, EV +$3.27/0.01 lot");
  if (stats.correlation.value !== null) {
    lines.push(`  correlation check (needs >=6 months): mean pairwise monthly ${stats.correlation.value.toFixed(2)}  (backtest -0.11)  [${stats.correlation.detail}]`);
  } else {
    lines.push(`  correlation check (needs >=6 months): INSUFFICIENT DATA  (backtest -0.11)${stats.correlation.detail ? `  [${stats.correlation.detail}]` : ""}`);
  }

  // ITEM DD — the suppressed-gate books: what the gates' rejections WOULD have done.
  lines.push("");
  lines.push("SUPPRESSED-GATE FORWARD BOOKS (ITEM DD — outcomes from the Item DA shadow resolver):");
  lines.push("  These gates suppress real setups; these books record what the suppressed setups");
  lines.push("  WOULD have done (flat 12/10/96 geometry, resolved against gold_m1_bars M5).");
  lines.push("  Pre-registered gate: at n >= 30 decided, EV_net > 0 refutes the gate (REPORT-ONLY).");
  for (const book of SUPPRESSED_BOOKS) {
    const s = stats.suppressedBooks[book.name];
    if (!s) continue;
    lines.push("");
    lines.push(`${book.name} (${book.tag}):`);
    if (s.totalRows === 0) {
      lines.push("  no rows yet");
      continue;
    }
    lines.push(
      `  rows ${s.totalRows} since ${s.firstEntryAt ?? "?"} | pre-CD excluded ${s.excludedPreV2} | malformed ${s.malformedV2} | still open ${s.unresolved}`,
    );
    if (s.decided === 0) {
      lines.push(`  GATE: NOT DECIDED — 0/${book.gateDecided} decided (no resolver outcomes yet)`);
      continue;
    }
    lines.push(
      `  decided ${s.decided} (TP ${s.wins} / SL ${s.stopOuts} / TIME ${s.flat}) | EV $${
        (s.evPerTrade$ ?? 0).toFixed(2)
      }/trade (resolver resolvedPnlPrice, row's own geometry)`,
    );
    if (s.decided >= book.gateDecided && s.evPerTrade$ !== null && s.evPerTrade$ > 0) {
      lines.push(
        `  GATE: ⚠️ THIS GATE IS REMOVING PROFITABLE SIGNALS. (n=${s.decided} decided, EV $${s.evPerTrade$.toFixed(2)}/trade > 0)`,
      );
    } else if (s.decided >= book.gateDecided) {
      lines.push(`  GATE: VETO STANDS (EV <= 0 at n=${s.decided} decided) — REPORT ONLY`);
    } else {
      lines.push(`  GATE: NOT DECIDED — ${s.decided}/${book.gateDecided} decided (accumulating)`);
    }
  }
  lines.push("  Read-only: this section REPORTS the pre-registered gates; no promotion, suppression, delay or demotion is wired to it.");
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
    m5FeedDiagnostics?: {
      item3: M5FeedPathDiagnosticsInput;
      f1: M5FeedPathDiagnosticsInput;
    } | null;
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
  // ITEM DC — WHY the feed itself ends up empty: per-reason counters for BOTH
  // gold_m1_bars fetch paths (item3 = refreshM5SupabaseBars; f1 = refreshBarSeries,
  // the path whose series the ABSENT/STALE reasons above are computed from).
  // Diagnostic only — counters are in-process (reset on app restart), never gating.
  const feed = stats.m5FeedDiagnostics;
  if (feed) {
    lines.push("M5 FEED FAILURE REASONS (Item DC — in-process counters, reset on app restart):");
    const fmtFeedPath = (p: M5FeedPathDiagnosticsInput): string =>
      `fetch_error=${p.counters.fetch_error} zero_rows=${p.counters.zero_rows} all_stale=${p.counters.all_stale} interval_guard=${p.counters.interval_guard}`;
    lines.push(`  ITEM 3 refresh (refreshM5SupabaseBars): ${fmtFeedPath(feed.item3)}`);
    lines.push(`  F1 bar series (refreshBarSeries — the series the reasons above read): ${fmtFeedPath(feed.f1)}`);
    const feedCandidates: Array<{ path: string; p: M5FeedPathDiagnosticsInput }> = [
      { path: "item3", p: feed.item3 },
      { path: "f1", p: feed.f1 },
    ];
    const lastFeedFailure = feedCandidates
      .filter((c) => c.p.lastReason !== null)
      .sort((a, b) => (b.p.lastReasonAt ?? 0) - (a.p.lastReasonAt ?? 0))[0];
    if (lastFeedFailure) {
      lines.push(`  last failure: [${lastFeedFailure.path}] ${lastFeedFailure.p.lastReason} at ${new Date(lastFeedFailure.p.lastReasonAt ?? 0).toISOString()}`);
      if (lastFeedFailure.p.lastDetail) lines.push(`    ${lastFeedFailure.p.lastDetail}`);
    } else {
      lines.push("  last failure: none this process");
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

interface VetoFunnelInput {
  mode: string;
  generated: number;
  emitted: number;
  suppressed: number;
  lastSuppressedAt: number | null;
  lastSuppressedId: string | null;
}

function formatVetoFunnelSection(f: VetoFunnelInput | null | undefined): string {
  const lines: string[] = [];
  lines.push("-- ITEM P: BAND-PROXIMITY VETO FUNNEL --");
  if (!f) {
    lines.push("NOT INSTRUMENTED - caller supplied no veto funnel summary.");
    return lines.join("\n");
  }
  lines.push(`Mode: ${f.mode} (BAND_PROXIMITY_VETO_ENABLED = true)`);
  lines.push(`Candidates reaching the confirmed-emission point: ${f.generated}`);
  lines.push(`Emitted (rule silent or fingerprint-exempt):      ${f.emitted}`);
  lines.push(`Suppressed by the veto:                           ${f.suppressed}`);
  lines.push(`Last suppression: ${f.lastSuppressedAt ? safeDate(f.lastSuppressedAt) : "never"} (${f.lastSuppressedId ?? "-"})`);
  lines.push("");
  lines.push("Mutual exclusivity: generated == emitted + suppressed. A mismatch here");
  lines.push("  means the funnel counters are broken and must be investigated.");
  lines.push("Suppressed candidates are NEVER emitted / Telegram'd / in live history;");
  lines.push("  they live in shadow_candidates_v1 ('BAND_VETO_SUPPRESSED') and resolve");
  lines.push("  through the ONE canonical instrument.");
  lines.push("P.3 ABORT GATE: at every forward n=30 decided suppressed signals, if their");
  lines.push("  EV_net > 0 the flag is set false next round and reported; no other");
  lines.push("  condition modifies the flag.");
  return lines.join("\n");
}

/**
 * SECTION 10 — EMISSION FUNNEL. One mutually-exclusive bucket per
 * generateSignal() exit path; the invariant sum(rejections) + emitted ==
 * attempts is CHECKED here so an unaccounted exit is visible instead of
 * silently redistributing attribution. The ITEM 17b/17c anchor/geometry gate
 * counters render alongside as sub-gate detail.
 */
function formatEmissionFunnelSection(
  funnel: {
    attempts: number;
    rejections: Record<string, number>;
    rejectionTotal: number;
    emitted: number;
    accounted: number;
    invariantOk: boolean;
    /** Durable copy (AsyncStorage) — optional so older callers still compile. */
    durableAttempts?: number;
    durableRejections?: Record<string, number>;
    durableRejectionTotal?: number;
    durableEmitted?: number;
    durableAccounted?: number;
    durableInvariantOk?: boolean;
    durableHydrated?: boolean;
  } | null | undefined,
  anchorStats: {
    anchorChecks: number;
    anchorStaleRejections: number;
    geometryChecks: number;
    geometryUnwinnableRejections: number;
  } | null | undefined,
): string {
  const lines: string[] = [RULE, "SECTION 10 — EMISSION FUNNEL (generateSignal exit paths, mutually exclusive)", RULE];
  if (!funnel) {
    lines.push("NOT INSTRUMENTED — the caller supplied no emissionFunnel.");
    lines.push("This is NOT the same as zero rejections. Attribution is impossible without it.");
    return lines.join("\n");
  }
  lines.push(`Generation attempts: ${funnel.attempts}`);
  const sorted = Object.entries(funnel.rejections).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (sorted.length === 0) {
    lines.push("  (no rejections recorded)");
  } else {
    for (const [label, count] of sorted) {
      const pct = funnel.attempts > 0 ? ((count / funnel.attempts) * 100).toFixed(1) : "n/a";
      lines.push(`  ❌ REJECTED ${label}: ${count} (${pct}% of attempts)`);
    }
  }
  lines.push("  ↓");
  lines.push(`EMITTED: ${funnel.emitted}`);
  lines.push("");
  lines.push(
    `INVARIANT: sum(rejections) ${funnel.rejectionTotal} + emitted ${funnel.emitted} = ${funnel.accounted}` +
    ` vs attempts ${funnel.attempts} → ${funnel.invariantOk ? "PASS" : "FAIL — an exit path is unaccounted; investigate before trusting any rate above"}`,
  );
  lines.push("");
  if (typeof funnel.durableAttempts === "number") {
    lines.push("DURABLE (survives app reloads — AsyncStorage, max-merged at boot, 15s flush throttle):");
    lines.push(`  attempts: ${funnel.durableAttempts}`);
    const durableSorted = Object.entries(funnel.durableRejections ?? {}).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    if (durableSorted.length === 0) {
      lines.push("  (no durable rejections recorded)");
    } else {
      for (const [label, count] of durableSorted) {
        const pct = funnel.durableAttempts > 0 ? ((count / funnel.durableAttempts) * 100).toFixed(1) : "n/a";
        lines.push(`  ❌ REJECTED ${label}: ${count} (${pct}% of durable attempts)`);
      }
    }
    lines.push(`EMITTED (durable): ${funnel.durableEmitted ?? 0}`);
    if (funnel.durableHydrated === false) {
      lines.push("  (not yet hydrated from storage at export time — durable block may trail the live counters)");
    }
    lines.push(
      `INVARIANT (durable): sum(rejections) ${funnel.durableRejectionTotal ?? 0} + emitted ${funnel.durableEmitted ?? 0} = ${funnel.durableAccounted ?? 0}` +
      ` vs durable attempts ${funnel.durableAttempts} → ${
        funnel.durableInvariantOk
          ? "PASS"
          : "SHORT — a hard reload can lose the last ≤15s of counts (flush throttle); a small shortfall is flush-tail loss, not an unaccounted exit"
      }`,
    );
    lines.push("");
  } else {
    lines.push("Durable funnel counters: NOT INSTRUMENTED in this bundle (funnel resets on every reload).");
    lines.push("");
  }
  if (anchorStats) {
    lines.push("ITEM 17b/17c anchor + geometry gate counters (sub-gate detail; these count evaluations, not 1:1 with attempts):");
    lines.push(`  anchorChecks: ${anchorStats.anchorChecks}`);
    lines.push(`  anchorStaleRejections: ${anchorStats.anchorStaleRejections}`);
    lines.push(`  geometryChecks: ${anchorStats.geometryChecks}`);
    lines.push(`  geometryUnwinnableRejections: ${anchorStats.geometryUnwinnableRejections}`);
  } else {
    lines.push("ITEM 17b/17c anchor/geometry gate counters: NOT INSTRUMENTED in this export.");
  }
  lines.push("");
  lines.push("Counter semantics: the top block is process-lifetime, in-memory (like");
  lines.push("signalGenerationAttempts); the DURABLE block survives app reloads in");
  lines.push("AsyncStorage and is max-merged at boot — a reload never resets it down.");
  lines.push("One bucket per generateSignal() exit — the ❌ REJECTED log line and the bucket");
  lines.push("always move together. The conviction/strength-difference ❌ lines inside");
  lines.push("enhancedTransformerAnalysis are NOT exits and have no bucket by design.");
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
    formatModelWeightsSection(input.modelWeights, input.learningCorpusStats, input.outboundPushStats, input.recentSignalModel),
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
    formatVetoFunnelSection(input.vetoFunnel),
    "",
    formatEmissionFunnelSection(input.emissionFunnel, input.entryAnchorGateStats),
    "",
    // ITEM AD — shadow performance (the model watches and logs; no suppression).
    formatModelShadowPerformanceSection(input.modelShadowStats),
    "",
    // ITEM CF — SECTION 12: shadow forward books (read-only reporting).
    formatShadowForwardBooksSection(input.shadowForwardBooks),
    "",
    DRULE,
    "END OF EXPORT",
    DRULE,
  ];
  return sections.join("\n");
}
