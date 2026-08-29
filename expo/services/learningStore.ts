import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Step 3 — persisted learning memory storage.
 *
 * ── ITEM 12 (2026-08-04) — THE READ IS OFF THE RORK BACKEND ────────────────
 * `hydrateFromRemote()` used to pull the durable corpus through
 * `trpcClient.learning.getOutcomes` — the Rork backend, which FLAPS 503 on the
 * `EXPO_PUBLIC_RORK_API_BASE_URL` origin and is permanently "no bundle
 * deployed" on the FUNCTIONS_URL origin. On web the local tier is an in-memory
 * array wiped on every reload, so a flap at startup meant the model could train
 * on an EMPTY or TRUNCATED corpus with no log, no counter and nothing in the
 * export.
 *
 * DATA-SOURCE RULE as enforced here:
 *   - the READ (`trade_outcomes_v1`) goes DIRECTLY to Supabase via the PUBLIC
 *     anon key (SELECT is RLS-permitted; verified all 51 rows readable), and is
 *     PAGINATED so the 1000-row PostgREST cap can never silently truncate it;
 *   - ITEM 66 (2026-08-12): the WRITE (`pushOutcomesToRemote`) now goes DIRECTLY
 *     to Supabase via the anon key + RLS INSERT/UPDATE policy, mirroring the
 *     already-proven shadow_signals_v1 Design-B write pattern. The Rork backend
 *     (503/no-bundle) is removed from this path. 98 local-only rows were
 *     stranded because the old push went through trpcClient.learning.pushOutcomes
 *     → the Rork backend, which is permanently unavailable. The anon key is
 *     public by design; RLS allows INSERT with WITH CHECK (true) and the
 *     upsert is keyed by signal_id so a re-push is idempotent.
 *   - every unavailable read increments a DURABLE counter surfaced in the
 *     diagnostics export, so a silent truncation is no longer possible.
 *
 * DURABILITY UPGRADE (Supabase-backed): the local tier below (SQLite on native,
 * in-memory on web) is a CACHE in front of the durable `trade_outcomes_v1`
 * table.
 *
 * Why: SQLite made the corpus durable per install but never shared it, and on
 * web/preview the store was purely in-memory, so every browser reload reset the
 * "self-learning" memory to zero. With the remote tier:
 *   - every resolved outcome is upserted server-side, keyed by signalId, so a
 *     re-push is idempotent and can never double-count a trade;
 *   - `hydrateFromRemote()` merges the durable corpus back into the local tier
 *     on startup (union by signalId, re-sorted by timestamp), so a fresh device
 *     or a reloaded browser tab starts with the full history, not an empty one.
 * Remote failures are non-fatal: the local tier keeps working offline and
 * unsynced rows are retried on the next append/hydrate.
 *
 * Previously trade outcomes lived entirely in a single AsyncStorage JSON blob
 * (`trade_outcomes_learning`), capped at 100 entries in-memory. That has two
 * problems: (1) AsyncStorage round-trips the ENTIRE history on every single
 * write (one win/loss recorded -> the whole blob re-serialized and rewritten),
 * and (2) a flat 100-entry cap throws away real trading history far sooner
 * than necessary for a system that retrains on a 14-day rolling window.
 *
 * This module moves outcome storage to expo-sqlite (the pattern already used
 * by barStore.ts for price bars): each outcome is an append-only row, so
 * writes are O(1) instead of O(n), and the retention cap is enforced with a
 * single DELETE rather than a full in-memory slice + full rewrite.
 */

export interface StoredTradeOutcome {
  signalId: string;
  entryPrice: number;
  exitPrice: number;
  result: 'WIN' | 'LOSS';
  pnl: number;
  confidence: number;
  features: unknown;
  timestamp: string | number | Date;
  misleadingFeatures?: unknown;
  signalDuration?: number;
  direction?: 'BUY' | 'SELL';
  realizedR?: number;
  isScratch?: boolean;
  /** Feature-vector schema version of `features` (1 = legacy 6-scalar, 2 = wide). */
  featureSchemaVersion?: number;
  /**
   * ITEM 224 — max favourable excursion, split at the terminal bar. Written to
   * the four additive trade_outcomes_v1 columns by toRemoteRow below.
   *
   * ABSENT IS NOT ZERO. A path with no bars to measure leaves this undefined and
   * the columns go to NULL, which is what makes the A4 backfill's
   * `.is(..., null)` guard a correct idempotency test. Writing 0 for "unknown"
   * would silently make an unmeasured signal look like one that never moved.
   */
  maxFavourable?: {
    targetReachedBeforeExit: number;
    excursionBeforeExitR: number;
    targetAfterExit: number;
    excursionAfterExitR: number;
  };
}

/** Outcomes queued for the remote corpus because a push failed (or was offline). */
let pendingRemotePush: StoredTradeOutcome[] = [];
const MAX_PENDING_REMOTE_PUSH = 200;
let remoteSyncEnabled = true;

// ITEM 66(b): pendingRemotePush is now DURABLE via AsyncStorage, so a reload
// does not discard the queue. Previously it was in-memory only — if the app
// reloaded before the next successful push, the queue was lost and the rows
// could only be re-pushed on the NEXT hydrate (which re-detects them as
// local-only). With the backend permanently 503, that meant they would NEVER
// reach Supabase. Durability ensures the queue survives reloads.
const PENDING_PUSH_KEY = 'pending_remote_push_v1';
let pendingPushHydrated = false;
let pendingPushHydratePromise: Promise<void> | null = null;

/** Rehydrate the pending push queue from AsyncStorage. Reads at most once. */
export function hydratePendingPushQueue(): Promise<void> {
  if (pendingPushHydratePromise) return pendingPushHydratePromise;
  pendingPushHydratePromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(PENDING_PUSH_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // Merge: any in-memory entries (added before hydration completed)
          // are prepended so they are not lost.
          const stored = parsed as StoredTradeOutcome[];
          pendingRemotePush = [...pendingRemotePush, ...stored].slice(-MAX_PENDING_REMOTE_PUSH);
          // ITEM 74(b): record the depth AT INIT so a queue that was drained
          // later in the session is still attributable after the fact.
          pushStats.queueDepthAtInit = stored.length;
          console.log(`📦 [LearningStore] Rehydrated ${stored.length} pending push outcome(s) from AsyncStorage`);
        }
      } else {
        // ITEM 74(b): an ABSENT key is a real observation (queue was empty at
        // init), deliberately distinct from "not yet measured" (null).
        pushStats.queueDepthAtInit = 0;
      }
    } catch (error: unknown) {
      console.warn('[LearningStore] Failed to rehydrate pending push queue:', error instanceof Error ? error.message : String(error));
    } finally {
      pendingPushHydrated = true;
    }
  })();
  return pendingPushHydratePromise;
}

/** Persist the pending push queue to AsyncStorage (throttled internally). */
let lastPendingPushFlush = 0;
const PENDING_PUSH_FLUSH_INTERVAL_MS = 10_000;
function persistPendingPushQueue(force: boolean): void {
  if (!pendingPushHydrated && !force) return;
  const now = Date.now();
  if (!force && now - lastPendingPushFlush < PENDING_PUSH_FLUSH_INTERVAL_MS) return;
  lastPendingPushFlush = now;
  const payload = pendingRemotePush.slice(-MAX_PENDING_REMOTE_PUSH);
  AsyncStorage.setItem(PENDING_PUSH_KEY, JSON.stringify(payload)).catch((error: unknown) => {
    console.warn('[LearningStore] Failed to persist pending push queue:', error instanceof Error ? error.message : String(error));
  });
}

/** Test seam: disables the remote tier so unit tests exercise the local store only. */
export function setRemoteSyncEnabledForTest(enabled: boolean): void {
  remoteSyncEnabled = enabled;
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 74(b) — OUTBOUND PUSH TELEMETRY (DURABLE).
//
// The diagnostics export carried hydrate counters and NOTHING about the
// outbound direction, so "was a push even attempted?" was UNOBSERVABLE and no
// mechanism could be asserted. These counters are durable in exactly the same
// manner as the corpus counters (AsyncStorage, rehydrated at init, ADDED not
// assigned) because the event under investigation happens ACROSS a reload
// boundary — a process-fresh counter cannot answer the question.
// ─────────────────────────────────────────────────────────────────────────────

/** Durable outbound-push counters for `trade_outcomes_v1`. */
export interface OutboundPushStats {
  /** Calls to pushOutcomesToRemote that reached the network stage. */
  pushAttempts: number;
  /** Chunk upserts that returned no error. */
  pushSuccesses: number;
  /** Chunk upserts that returned an error or threw. */
  pushFailures: number;
  /** Cumulative ROW count accepted (not call count). */
  rowsPushed: number;
  /** Failure counts keyed by HTTP status / PostgREST code. */
  failuresByStatus: Record<string, number>;
  /** Calls that exited before any network call, keyed by reason. */
  suppressedByReason: Record<string, number>;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** Verbatim failure body, truncated to 300 chars. */
  lastFailureBody: string | null;
  /** Queue depth rehydrated from AsyncStorage at init. */
  queueDepthAtInit: number | null;
  /** ITEM 74(c): reconciliation visibility, recomputed on every hydrate. */
  lastLocalCount: number | null;
  lastRemoteCount: number | null;
  lastLocalOnlyCount: number | null;
  lastRemoteOnlyCount: number | null;
  lastReconcileAt: number | null;
  /** True once these counters have been rehydrated from durable storage. */
  hydrated: boolean;
}

const PUSH_STATS_KEY = 'outbound_push_stats_v1';
const PUSH_STATS_FLUSH_INTERVAL_MS = 10_000;

const pushStats: OutboundPushStats = {
  pushAttempts: 0,
  pushSuccesses: 0,
  pushFailures: 0,
  rowsPushed: 0,
  failuresByStatus: {},
  suppressedByReason: {},
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureBody: null,
  queueDepthAtInit: null,
  lastLocalCount: null,
  lastRemoteCount: null,
  lastLocalOnlyCount: null,
  lastRemoteOnlyCount: null,
  lastReconcileAt: null,
  hydrated: false,
};

type PersistedPushStats = Omit<OutboundPushStats, 'hydrated'>;
let pushStatsHydrationPromise: Promise<void> | null = null;
let pushStatsLastFlushAt = 0;

/** Rehydrates the outbound-push counters from AsyncStorage. Reads at most once. */
export function hydrateOutboundPushStats(): Promise<void> {
  if (pushStatsHydrationPromise) return pushStatsHydrationPromise;
  pushStatsHydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(PUSH_STATS_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          const p = parsed as Partial<PersistedPushStats>;
          // ADD rather than assign — a push can complete before this load does.
          pushStats.pushAttempts += p.pushAttempts ?? 0;
          pushStats.pushSuccesses += p.pushSuccesses ?? 0;
          pushStats.pushFailures += p.pushFailures ?? 0;
          pushStats.rowsPushed += p.rowsPushed ?? 0;
          for (const [k, v] of Object.entries(p.failuresByStatus ?? {})) {
            pushStats.failuresByStatus[k] = (pushStats.failuresByStatus[k] ?? 0) + v;
          }
          for (const [k, v] of Object.entries(p.suppressedByReason ?? {})) {
            pushStats.suppressedByReason[k] = (pushStats.suppressedByReason[k] ?? 0) + v;
          }
          pushStats.lastAttemptAt = pushStats.lastAttemptAt ?? p.lastAttemptAt ?? null;
          pushStats.lastSuccessAt = pushStats.lastSuccessAt ?? p.lastSuccessAt ?? null;
          pushStats.lastFailureAt = pushStats.lastFailureAt ?? p.lastFailureAt ?? null;
          pushStats.lastFailureBody = pushStats.lastFailureBody ?? p.lastFailureBody ?? null;
          pushStats.lastLocalCount = pushStats.lastLocalCount ?? p.lastLocalCount ?? null;
          pushStats.lastRemoteCount = pushStats.lastRemoteCount ?? p.lastRemoteCount ?? null;
          pushStats.lastLocalOnlyCount = pushStats.lastLocalOnlyCount ?? p.lastLocalOnlyCount ?? null;
          pushStats.lastRemoteOnlyCount = pushStats.lastRemoteOnlyCount ?? p.lastRemoteOnlyCount ?? null;
          pushStats.lastReconcileAt = pushStats.lastReconcileAt ?? p.lastReconcileAt ?? null;
        }
      }
    } catch (error: unknown) {
      console.warn(
        '[LearningStore] Failed to rehydrate outbound push counters:',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      pushStats.hydrated = true;
    }
  })();
  return pushStatsHydrationPromise;
}

function persistPushStats(force: boolean): void {
  if (!pushStats.hydrated && !force) return;
  const now = Date.now();
  if (!force && now - pushStatsLastFlushAt < PUSH_STATS_FLUSH_INTERVAL_MS) return;
  pushStatsLastFlushAt = now;
  const payload: PersistedPushStats = {
    pushAttempts: pushStats.pushAttempts,
    pushSuccesses: pushStats.pushSuccesses,
    pushFailures: pushStats.pushFailures,
    rowsPushed: pushStats.rowsPushed,
    failuresByStatus: pushStats.failuresByStatus,
    suppressedByReason: pushStats.suppressedByReason,
    lastAttemptAt: pushStats.lastAttemptAt,
    lastSuccessAt: pushStats.lastSuccessAt,
    lastFailureAt: pushStats.lastFailureAt,
    lastFailureBody: pushStats.lastFailureBody,
    queueDepthAtInit: pushStats.queueDepthAtInit,
    lastLocalCount: pushStats.lastLocalCount,
    lastRemoteCount: pushStats.lastRemoteCount,
    lastLocalOnlyCount: pushStats.lastLocalOnlyCount,
    lastRemoteOnlyCount: pushStats.lastRemoteOnlyCount,
    lastReconcileAt: pushStats.lastReconcileAt,
  };
  AsyncStorage.setItem(PUSH_STATS_KEY, JSON.stringify(payload)).catch((error: unknown) => {
    console.warn(
      '[LearningStore] Failed to persist outbound push counters:',
      error instanceof Error ? error.message : String(error),
    );
  });
}

/** Records a push that exited WITHOUT attempting a network call. */
function recordPushSuppressed(reason: string): void {
  pushStats.suppressedByReason[reason] = (pushStats.suppressedByReason[reason] ?? 0) + 1;
  persistPushStats(true);
}

/**
 * Extracts an HTTP-status-like key from a Supabase/PostgREST error so failures
 * can be bucketed. PostgREST returns `code` (e.g. 42501 RLS, 23502 NOT NULL).
 * Supabase auth-style errors (e.g. "Invalid API key" from a 401) carry a
 * .message but often no .code or .status — .status is checked as number OR
 * string, and known auth-error phrases in .message are bucketed as '401'.
 * A transport failure (no object properties) buckets as NETWORK.
 */
function pushFailureStatusKey(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.code === 'string' && e.code) return e.code;
    if (typeof e.status === 'number') return String(e.status);
    if (typeof e.status === 'string' && e.status) return e.status;
    if (typeof e.statusCode === 'number') return String(e.statusCode);
    if (typeof e.statusCode === 'string' && e.statusCode) return e.statusCode;
    if (typeof e.message === 'string') {
      const prefixMatch = /^(\d{3})\b/.exec(e.message);
      if (prefixMatch) return prefixMatch[1];
      const msg = e.message.toLowerCase();
      if (msg.includes('invalid api key') || msg.includes('unauthorized') || msg.includes('api_key') || msg.includes('apikey')) {
        return '401';
      }
    }
  }
  if (err instanceof Error) return 'NETWORK';
  return 'UNKNOWN';
}

/** Snapshot of the durable outbound-push counters, for the diagnostics export. */
export function getOutboundPushStats(): OutboundPushStats {
  return {
    ...pushStats,
    failuresByStatus: { ...pushStats.failuresByStatus },
    suppressedByReason: { ...pushStats.suppressedByReason },
  };
}

/**
 * ITEM 66(a): map a StoredTradeOutcome to the snake_case columns in
 * trade_outcomes_v1, mirroring the column mapping the backend tRPC handler
 * used. The anon key is used for INSERT via RLS policy.
 */
/**
 * ITEM 82 / B8 — THE ONE PLACE A WIN/LOSS LABEL IS DECIDED.
 *
 * ROOT CAUSE, measured before fixing (scripts/auditItem82RoundTwo.ts against the
 * live corpus, 2026-08-17):
 *   stored result = WIN            160
 *   realized_r > 0                136
 *   stored WIN but realized_r <= 0 or null : 24   <- ALL 24 have realized_r = NULL
 *   stored LOSS but realized_r > 0         :  0
 * So F-8 and F-9 are ONE defect, not two: the 24 disagreeing rows are a subset of
 * the 61 rows that carry `direction = NULL` AND `realized_r = NULL` (ts range
 * 2026-07-01..2026-07-06, all 61 present in emitted_signals_v1). SL_AFTER_BE is
 * REFUTED as the cause — there is not a single row where a positive R was labelled
 * LOSS, which is the signature that hypothesis predicts.
 *
 * The write path allowed it because `result` and `realized_r` were independent
 * fields: `result: outcome.result` was asserted while `realized_r:
 * outcome.realizedR ?? null` silently wrote NULL. Nothing checked that the two
 * agreed, so a row could claim WIN while carrying no evidence for it.
 *
 * From here the label is DERIVED from R whenever an R exists, so the two can never
 * disagree again. When there is no R the stored label is preserved (deleting a
 * historical label would destroy information) but the disagreement is logged, so a
 * label with no evidence behind it is visible rather than silent.
 */
export function canonicalResult(
  storedResult: 'WIN' | 'LOSS',
  realizedR: number | null | undefined,
): { result: 'WIN' | 'LOSS'; corrected: boolean; evidence: 'R_SIGN' | 'NO_R' } {
  if (realizedR === null || realizedR === undefined || !Number.isFinite(realizedR)) {
    return { result: storedResult, corrected: false, evidence: 'NO_R' };
  }
  const fromR: 'WIN' | 'LOSS' = realizedR > 0 ? 'WIN' : 'LOSS';
  return { result: fromR, corrected: fromR !== storedResult, evidence: 'R_SIGN' };
}

/** Counts label corrections so the export can show the write path is holding. */
let labelCorrectionsOnWrite = 0;
let labelsWithoutEvidenceOnWrite = 0;

/** ITEM 82 / B8 — read-only accessor for the diagnostics export. */
export function getLabelIntegrityCounters(): { correctedOnWrite: number; withoutEvidenceOnWrite: number } {
  return { correctedOnWrite: labelCorrectionsOnWrite, withoutEvidenceOnWrite: labelsWithoutEvidenceOnWrite };
}

function toRemoteRow(outcome: StoredTradeOutcome): Record<string, unknown> {
  const ts = typeof outcome.timestamp === 'number'
    ? new Date(outcome.timestamp).toISOString()
    : outcome.timestamp instanceof Date
      ? outcome.timestamp.toISOString()
      : new Date(outcome.timestamp).toISOString();
  // ITEM 82 / B8: label and R sign can no longer diverge on the way out.
  const label = canonicalResult(outcome.result, outcome.realizedR);
  if (label.corrected) {
    labelCorrectionsOnWrite += 1;
    console.warn(
      `[LearningStore] LABEL_CORRECTED_ON_WRITE ${String(outcome.signalId).slice(-8)}: ` +
        `stored=${outcome.result} but realized_r=${outcome.realizedR} -> writing ${label.result}. ` +
        'R sign is authoritative (F-8).',
    );
  }
  if (label.evidence === 'NO_R') {
    labelsWithoutEvidenceOnWrite += 1;
    console.warn(
      `[LearningStore] LABEL_WITHOUT_EVIDENCE ${String(outcome.signalId).slice(-8)}: ` +
        `result=${outcome.result} with realized_r=null. The label is preserved but has no R behind it (F-8/F-9).`,
    );
  }
  return {
    signal_id: outcome.signalId,
    ts,
    direction: outcome.direction ?? null,
    result: label.result,
    entry_price: outcome.entryPrice,
    exit_price: outcome.exitPrice,
    pnl: outcome.pnl,
    confidence: outcome.confidence,
    realized_r: outcome.realizedR ?? null,
    is_scratch: outcome.isScratch ?? false,
    signal_duration_ms: outcome.signalDuration ?? null,
    features: outcome.features as Record<string, unknown> ?? {},
    misleading_features: (outcome.misleadingFeatures as Record<string, unknown>) ?? null,
    feature_schema_version: outcome.featureSchemaVersion ?? 1,
    // ITEM 224 — additive observational columns. NULL when the recording path
    // had no bars to measure (absent ≠ zero, see StoredTradeOutcome). Every
    // label field above is written exactly as before; this cannot reach a label.
    max_favourable_target_reached_before_exit: outcome.maxFavourable?.targetReachedBeforeExit ?? null,
    max_favourable_excursion_before_exit_r: outcome.maxFavourable?.excursionBeforeExitR ?? null,
    max_favourable_target_after_exit: outcome.maxFavourable?.targetAfterExit ?? null,
    max_favourable_excursion_after_exit_r: outcome.maxFavourable?.excursionAfterExitR ?? null,
  };
}

/**
 * Dedicated anon-key Supabase client for the outcome WRITE. Same pattern as
 * the read client and shadowSignalService: public anon key, never the service
 * key. RLS permits INSERT (WITH CHECK true) on trade_outcomes_v1 after
 * migration 005 is applied.
 */
let pushClient: SupabaseClient | null = null;

function getPushClient(): SupabaseClient | null {
  if (pushClient) return pushClient;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  // OO.2 — distinct storageKey: ends the shared-key "Multiple GoTrueClient instances" warning.
  pushClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, storageKey: "rork-svc-learning-push" },
  });
  return pushClient;
}

/** Serialize a Supabase/Postgres error readably. */
function serializePushError(err: unknown): string {
  if (err === null || err === undefined) return 'null';
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [`message="${String(e.message)}"`];
    if (typeof e.code === 'string' && e.code) parts.push(`code=${e.code}`);
    if (typeof e.details === 'string' && e.details) parts.push(`details=${e.details}`);
    return parts.join(' ');
  }
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * ITEM 66(a): Best-effort push of one or more outcomes into the durable corpus,
 * DIRECTLY to Supabase via the anon key + RLS INSERT policy. Mirrors the
 * shadow_signals_v1 Design-B write pattern already proven in production.
 *
 * The Rork backend (trpcClient.learning.pushOutcomes) is removed from this
 * path — it is permanently 503/no-bundle, and 98 local-only rows were
 * stranded because the old push went through it. The anon key is public by
 * design; RLS allows INSERT on trade_outcomes_v1 (migration 005).
 *
 * Never throws: on failure the rows are queued (durable via AsyncStorage) and
 * retried on the next push/hydrate.
 */
export async function pushOutcomesToRemote(outcomes: StoredTradeOutcome[]): Promise<{ upserted: number; queued: number; failed: number; failureDetail: string | null }> {
  // ITEM 74(b): every early return below is now COUNTED, so a push that never
  // reached the network is distinguishable from a push that was never called.
  await hydrateOutboundPushStats();

  if (!remoteSyncEnabled) {
    recordPushSuppressed('REMOTE_SYNC_DISABLED');
    // ITEM 78(a): queue outcomes so they are retried when sync is re-enabled.
    // Previously these were silently dropped — a data-loss defect.
    const existingIds = new Set(pendingRemotePush.map(o => o.signalId));
    for (const o of outcomes) {
      if (!existingIds.has(o.signalId)) {
        pendingRemotePush.push(o);
        existingIds.add(o.signalId);
      }
    }
    pendingRemotePush = pendingRemotePush.slice(-MAX_PENDING_REMOTE_PUSH);
    persistPendingPushQueue(true);
    return { upserted: 0, queued: pendingRemotePush.length, failed: outcomes.length, failureDetail: 'REMOTE_SYNC_DISABLED' };
  }

  // ITEM 66(b): ensure the durable queue is hydrated before merging new outcomes
  if (!pendingPushHydrated) await hydratePendingPushQueue();

  // ITEM 78(a): deduplicate by signalId so a row already in the queue is not duplicated.
  const batchSeen = new Set<string>();
  const batch: StoredTradeOutcome[] = [];
  for (const o of [...pendingRemotePush, ...outcomes]) {
    if (!batchSeen.has(o.signalId)) {
      batchSeen.add(o.signalId);
      batch.push(o);
    }
  }
  if (batch.length === 0) {
    recordPushSuppressed('EMPTY_BATCH');
    return { upserted: 0, queued: 0, failed: 0, failureDetail: null };
  }

  const client = getPushClient();
  if (!client) {
    pendingRemotePush = batch.slice(-MAX_PENDING_REMOTE_PUSH);
    persistPendingPushQueue(true);
    recordPushSuppressed('SUPABASE_NOT_CONFIGURED');
    console.warn('[LearningStore] Supabase not configured — outcomes queued for later retry');
    return { upserted: 0, queued: pendingRemotePush.length, failed: batch.length, failureDetail: 'SUPABASE_NOT_CONFIGURED' };
  }

  pushStats.pushAttempts += 1;
  pushStats.lastAttemptAt = Date.now();
  persistPushStats(true);

  // ── ITEM 82 / B3 — F-15 FIX: DEDUPE AT THE NETWORK BOUNDARY ───────────────
  // Every one of the 40 recorded push failures was the same Postgres error:
  //   21000  "ON CONFLICT DO UPDATE command cannot affect row a second time"
  // That error has exactly one cause: the same conflict-target value (signal_id)
  // appearing twice in ONE upsert payload. Postgres refuses the whole statement,
  // so a single duplicated id fails the entire 50-row chunk — which is why the
  // failures came in chunk-sized clumps rather than as isolated rows.
  //
  // A dedupe already existed at :431-439, keyed on `o.signalId` over
  // [...pendingRemotePush, ...outcomes]. It was not sufficient, for two reasons:
  //   1. It ran on the StoredTradeOutcome objects, NOT on the rows actually sent.
  //      The conflict target is the ROW's `signal_id` as produced by
  //      toRemoteRow(). Any id that normalises differently between the two (a
  //      non-string signalId, a stringified number, whitespace) passes the object
  //      dedupe and still collides in Postgres. Deduping the payload itself is the
  //      only placement that cannot be bypassed by an upstream caller.
  //   2. It kept the FIRST occurrence, which comes from `pendingRemotePush` —
  //      the STALE queued copy — so a corrected label arriving in `outcomes`
  //      lost to the older row it was meant to replace.
  // Both are fixed here: dedupe the rows, keep the LAST occurrence per id.
  const orderedRows = batch.slice(-MAX_PENDING_REMOTE_PUSH).map(toRemoteRow);
  const rowById = new Map<string, Record<string, unknown>>();
  for (const row of orderedRows) {
    // Key on the exact value Postgres will conflict on, coerced the same way the
    // wire format will coerce it.
    rowById.set(String(row.signal_id), row);
  }
  const rowsToPush = [...rowById.values()];
  const duplicatesDropped = orderedRows.length - rowsToPush.length;
  if (duplicatesDropped > 0) {
    // Visible, not silent: a duplicate reaching this point means an upstream
    // caller produced one, and that is worth seeing in the logs.
    console.warn(
      `[LearningStore] BATCH_DEDUPE dropped ${duplicatesDropped} duplicate signal_id row(s) before upsert ` +
        `(${orderedRows.length} -> ${rowsToPush.length}); kept the most recent row per id. ` +
        'Without this the whole chunk fails with Postgres 21000.',
    );
  }
  // The retry queue is keyed off `batch`, so keep a parallel lookup that maps a
  // pushed row back to its outcome. Queueing/retry semantics are UNCHANGED: a
  // failed chunk still queues its outcomes, deduped, capped, and persisted.
  const outcomeBySignalId = new Map<string, StoredTradeOutcome>();
  for (const o of batch) outcomeBySignalId.set(String(o.signalId), o);
  let upserted = 0;
  let failed: StoredTradeOutcome[] = [];

  // Push in batches of 50 to stay well under PostgREST limits
  const BATCH_SIZE = 50;
  for (let i = 0; i < rowsToPush.length; i += BATCH_SIZE) {
    const chunk = rowsToPush.slice(i, i + BATCH_SIZE);
    try {
      // upsert keyed by signal_id — idempotent, never double-counts
      const { error } = await client
        .from('trade_outcomes_v1')
        .upsert(chunk, { onConflict: 'signal_id' });
      if (error) {
        const body = serializePushError(error);
        console.warn(`[LearningStore] OUTCOME_PUSH_FAILED: ${body}`);
        const key = pushFailureStatusKey(error);
        pushStats.pushFailures += 1;
        pushStats.failuresByStatus[key] = (pushStats.failuresByStatus[key] ?? 0) + 1;
        pushStats.lastFailureAt = Date.now();
        pushStats.lastFailureBody = body.slice(0, 300);
        // Queue the outcomes that correspond to this chunk. B3: resolved by
        // signal_id rather than by positional slice, because rowsToPush is now
        // deduped and its indices no longer line up with `batch`.
        const chunkOutcomes = chunk
          .map((r) => outcomeBySignalId.get(String(r.signal_id)))
          .filter((o): o is StoredTradeOutcome => o !== undefined);
        failed.push(...chunkOutcomes);
      } else {
        upserted += chunk.length;
        pushStats.pushSuccesses += 1;
        pushStats.rowsPushed += chunk.length;
        pushStats.lastSuccessAt = Date.now();
      }
    } catch (err: unknown) {
      const body = serializePushError(err);
      console.warn(`[LearningStore] OUTCOME_PUSH_ERROR: ${body}`);
      const key = pushFailureStatusKey(err);
      pushStats.pushFailures += 1;
      pushStats.failuresByStatus[key] = (pushStats.failuresByStatus[key] ?? 0) + 1;
      pushStats.lastFailureAt = Date.now();
      pushStats.lastFailureBody = body.slice(0, 300);
      const chunkOutcomes = chunk
        .map((r) => outcomeBySignalId.get(String(r.signal_id)))
        .filter((o): o is StoredTradeOutcome => o !== undefined);
      failed.push(...chunkOutcomes);
    }
    persistPushStats(true);
  }

  if (failed.length > 0) {
    // ITEM 78(a): deduplicate failed rows by signalId so a row already in the queue is not duplicated.
    const failedSeen = new Set<string>();
    const dedupedFailed: StoredTradeOutcome[] = [];
    for (const o of failed) {
      if (!failedSeen.has(o.signalId)) {
        failedSeen.add(o.signalId);
        dedupedFailed.push(o);
      }
    }
    pendingRemotePush = dedupedFailed.slice(-MAX_PENDING_REMOTE_PUSH);
    persistPendingPushQueue(true);
    console.warn(`⚠️ [LearningStore] ${pendingRemotePush.length} outcome(s) failed push — queued for retry (durable)`);
    return { upserted, queued: pendingRemotePush.length, failed: pendingRemotePush.length, failureDetail: pushStats.lastFailureBody };
  }

  // ITEM 78(a): a row that succeeds is removed from the queue in the same operation.
  pendingRemotePush = [];
  persistPendingPushQueue(true);
  console.log(`✅ [LearningStore] Pushed ${upserted} outcome(s) to Supabase (direct anon insert)`);
  return { upserted, queued: 0, failed: 0, failureDetail: null };
}

export function getPendingRemotePushCount(): number {
  return pendingRemotePush.length;
}

/**
 * ITEM 74(a) — RUNTIME probe of the push path. Every field is read from the
 * live module state of the RUNNING bundle, not asserted from a changelog:
 * `PENDING_PUSH_KEY` and `OUTCOMES_TABLE` are the actual constants this code
 * uses, `clientConfigured` is the result of actually constructing the anon
 * client, and `queueHydrated` reflects whether the durable queue was read.
 *
 * A bundle that predates Item 66 does not export this function at all, so its
 * ABSENCE is as informative as its contents.
 */
export function getPushPathDescriptor(): {
  venue: string;
  table: string;
  onConflict: string;
  pendingPushKey: string;
  clientConfigured: boolean;
  queueHydrated: boolean;
  usesDirectAnonUpsert: boolean;
} {
  return {
    venue: 'SUPABASE_DIRECT_ANON',
    table: OUTCOMES_TABLE,
    onConflict: 'signal_id',
    pendingPushKey: PENDING_PUSH_KEY,
    clientConfigured: getPushClient() !== null,
    queueHydrated: pendingPushHydrated,
    usesDirectAnonUpsert: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 12(a)(b) — DIRECT, PAGINATED anon read of `trade_outcomes_v1`.
// No Rork backend on this path. No fallback venue: a failed read returns a
// typed unavailable result and the caller keeps the local corpus untouched.
// ─────────────────────────────────────────────────────────────────────────────

const OUTCOMES_TABLE = 'trade_outcomes_v1';
/** PostgREST caps a single response at 1000 rows; page well under it. */
const OUTCOMES_PAGE_SIZE = 500;
/** Hard stop so a runaway table can never spin the loop forever. */
const OUTCOMES_MAX_PAGES = 40;

let outcomesClient: SupabaseClient | null = null;

/** Dedicated anon client for the corpus READ. The service-role key is never
 *  referenced here and is never shipped to the client. */
function getOutcomesClient(): SupabaseClient | null {
  if (outcomesClient) return outcomesClient;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  // OO.2 — distinct storageKey (see pushClient comment above).
  outcomesClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, storageKey: "rork-svc-learning-outcomes" },
  });
  return outcomesClient;
}

/** Serialize a PostgrestError (a plain object, not an Error) readably. */
function serializeOutcomeError(err: unknown): string {
  if (err === null || err === undefined) return 'null';
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
    const e = err as Record<string, unknown>;
    const parts: string[] = [`message="${String(e.message)}"`];
    if (typeof e.code === 'string' && e.code) parts.push(`code=${e.code}`);
    if (typeof e.details === 'string' && e.details) parts.push(`details=${e.details}`);
    return parts.join(' ');
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

interface RemoteOutcomeRow {
  signal_id: string;
  ts: string;
  direction: string | null;
  result: string;
  entry_price: number | string;
  exit_price: number | string;
  pnl: number | string;
  confidence: number | string | null;
  realized_r: number | string | null;
  is_scratch: boolean | null;
  signal_duration_ms: number | string | null;
  feature_schema_version: number | null;
  features: unknown;
  misleading_features: unknown;
}

function mapRemoteRow(row: RemoteOutcomeRow): StoredTradeOutcome {
  return {
    signalId: row.signal_id,
    timestamp: row.ts,
    entryPrice: Number(row.entry_price),
    exitPrice: Number(row.exit_price),
    // ITEM 82 / B8: apply the SAME derivation on the way IN, so the 24 legacy
    // divergent rows already in the corpus cannot train the model on a
    // contradiction. The durable row is left untouched; only the in-memory copy
    // the learner sees is made self-consistent.
    result: canonicalResult(row.result === 'WIN' ? 'WIN' : 'LOSS', row.realized_r === null ? null : Number(row.realized_r)).result,
    pnl: Number(row.pnl),
    confidence: row.confidence === null ? 0.72 : Number(row.confidence),
    direction: row.direction === 'BUY' || row.direction === 'SELL' ? row.direction : undefined,
    realizedR: row.realized_r === null ? undefined : Number(row.realized_r),
    isScratch: row.is_scratch ?? undefined,
    signalDuration: row.signal_duration_ms === null ? undefined : Number(row.signal_duration_ms),
    features: row.features ?? {},
    misleadingFeatures: row.misleading_features ?? undefined,
    featureSchemaVersion: row.feature_schema_version ?? undefined,
  };
}

export interface RemoteOutcomesReadResult {
  available: boolean;
  outcomes: StoredTradeOutcome[];
  /** Number of PostgREST pages actually fetched. Proof the pagination ran. */
  pages: number;
  /** True when `limit` cut the pull short (i.e. the corpus is larger). */
  truncatedByLimit: boolean;
  reason: 'OK' | 'NOT_CONFIGURED' | 'READ_ERROR';
  detail: string | null;
}

/**
 * Reads the durable corpus DIRECTLY from Supabase via the anon key, newest-first
 * internally and returned OLDEST-FIRST to match the local store's ordering.
 * Paginated: the caller's `limit` is honoured across pages, never by truncating
 * a single 1000-row response.
 */
export async function fetchRemoteOutcomesDirect(limit: number): Promise<RemoteOutcomesReadResult> {
  const client = getOutcomesClient();
  if (!client) {
    return {
      available: false,
      outcomes: [],
      pages: 0,
      truncatedByLimit: false,
      reason: 'NOT_CONFIGURED',
      detail: 'EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY is missing',
    };
  }

  const collected: StoredTradeOutcome[] = [];
  let pages = 0;
  let offset = 0;
  let sawFullPage = false;

  while (pages < OUTCOMES_MAX_PAGES && collected.length < limit) {
    const pageSize = Math.min(OUTCOMES_PAGE_SIZE, limit - collected.length);
    try {
      const res = await client
        .from(OUTCOMES_TABLE)
        .select(
          'signal_id, ts, direction, result, entry_price, exit_price, pnl, confidence, realized_r, is_scratch, signal_duration_ms, feature_schema_version, features, misleading_features',
        )
        .order('ts', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (res.error) {
        console.warn(`[LearningStore] CORPUS_READ_UNAVAILABLE reason=READ_ERROR ${serializeOutcomeError(res.error)}`);
        return {
          available: false,
          outcomes: [],
          pages,
          truncatedByLimit: false,
          reason: 'READ_ERROR',
          detail: serializeOutcomeError(res.error),
        };
      }
      const rows = (res.data ?? []) as unknown as RemoteOutcomeRow[];
      pages += 1;
      for (const row of rows) collected.push(mapRemoteRow(row));
      sawFullPage = rows.length === pageSize;
      if (rows.length < pageSize) break;
      offset += pageSize;
    } catch (err: unknown) {
      console.warn(`[LearningStore] CORPUS_READ_UNAVAILABLE reason=READ_ERROR ${serializeOutcomeError(err)}`);
      return {
        available: false,
        outcomes: [],
        pages,
        truncatedByLimit: false,
        reason: 'READ_ERROR',
        detail: serializeOutcomeError(err),
      };
    }
  }

  // Truncation is PROVEN, not inferred: when the pull filled the caller's limit,
  // probe for ONE more row. Inferring it from "the last page was full" reports a
  // corpus that exactly drains the limit as truncated, which is a false alarm.
  let truncatedByLimit = false;
  if (collected.length >= limit && sawFullPage) {
    try {
      const probe = await client
        .from(OUTCOMES_TABLE)
        .select('signal_id')
        .order('ts', { ascending: false })
        .range(offset, offset);
      truncatedByLimit = !probe.error && (probe.data?.length ?? 0) > 0;
    } catch {
      // A failed probe is not evidence either way; leave the flag false.
      truncatedByLimit = false;
    }
  }

  // Reverse to oldest-first, matching getAllOutcomes()'s contract.
  collected.reverse();
  return {
    available: true,
    outcomes: collected,
    pages,
    truncatedByLimit,
    reason: 'OK',
    detail: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 12(d) — DURABLE hydration counters.
//
// Item 4 established that process-lifetime counters reset on reload and capture
// nothing across a trading day, so these are persisted to AsyncStorage exactly
// like the telegram delivery counters. A corpus read that came back
// `available:false` must be visible in the export forever, not just until the
// next reload.
// ─────────────────────────────────────────────────────────────────────────────

const LEARNING_CORPUS_COUNTERS_KEY = 'learning_corpus_counters_v1';
const CORPUS_COUNTER_FLUSH_INTERVAL_MS = 15_000;

export interface LearningCorpusStats {
  /** hydrateFromRemote() calls that reached the read path. */
  hydrateAttempts: number;
  /** Calls where the direct Supabase read returned rows (available === true). */
  hydrateSuccesses: number;
  /** Calls where the corpus was UNAVAILABLE — the silent-truncation counter. */
  hydrateUnavailableCount: number;
  /** Rows pulled on the most recent successful hydrate. */
  lastPulled: number | null;
  /** Local-tier total after the most recent hydrate. */
  lastTotal: number | null;
  /** PostgREST pages fetched on the most recent successful hydrate. */
  lastPages: number | null;
  /** True if the last successful pull hit the caller's limit (corpus is bigger). */
  lastTruncatedByLimit: boolean;
  lastUnavailableReason: string | null;
  lastUnavailableAt: number | null;
  lastSuccessAt: number | null;
  /** True once the counters have been rehydrated from durable storage. */
  hydrated: boolean;
}

const corpusStats: LearningCorpusStats = {
  hydrateAttempts: 0,
  hydrateSuccesses: 0,
  hydrateUnavailableCount: 0,
  lastPulled: null,
  lastTotal: null,
  lastPages: null,
  lastTruncatedByLimit: false,
  lastUnavailableReason: null,
  lastUnavailableAt: null,
  lastSuccessAt: null,
  hydrated: false,
};

type PersistedCorpusStats = Omit<LearningCorpusStats, 'hydrated'>;
let corpusHydrationPromise: Promise<void> | null = null;
let corpusLastFlushAt = 0;

/** Rehydrates the corpus counters from AsyncStorage. Reads at most once. */
export function hydrateLearningCorpusStats(): Promise<void> {
  if (corpusHydrationPromise) return corpusHydrationPromise;
  corpusHydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(LEARNING_CORPUS_COUNTERS_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          const p = parsed as Partial<PersistedCorpusStats>;
          // ADD rather than assign: a hydrate can complete before these counters
          // finish loading, and assignment would silently discard that count.
          corpusStats.hydrateAttempts += p.hydrateAttempts ?? 0;
          corpusStats.hydrateSuccesses += p.hydrateSuccesses ?? 0;
          corpusStats.hydrateUnavailableCount += p.hydrateUnavailableCount ?? 0;
          corpusStats.lastPulled = corpusStats.lastPulled ?? p.lastPulled ?? null;
          corpusStats.lastTotal = corpusStats.lastTotal ?? p.lastTotal ?? null;
          corpusStats.lastPages = corpusStats.lastPages ?? p.lastPages ?? null;
          corpusStats.lastUnavailableReason = corpusStats.lastUnavailableReason ?? p.lastUnavailableReason ?? null;
          corpusStats.lastUnavailableAt = corpusStats.lastUnavailableAt ?? p.lastUnavailableAt ?? null;
          corpusStats.lastSuccessAt = corpusStats.lastSuccessAt ?? p.lastSuccessAt ?? null;
        }
      }
    } catch (error: unknown) {
      console.warn(
        '[LearningStore] Failed to rehydrate corpus counters:',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      corpusStats.hydrated = true;
    }
  })();
  return corpusHydrationPromise;
}

function persistCorpusStats(force: boolean): void {
  if (!corpusStats.hydrated) return;
  const now = Date.now();
  if (!force && now - corpusLastFlushAt < CORPUS_COUNTER_FLUSH_INTERVAL_MS) return;
  corpusLastFlushAt = now;
  const payload: PersistedCorpusStats = {
    hydrateAttempts: corpusStats.hydrateAttempts,
    hydrateSuccesses: corpusStats.hydrateSuccesses,
    hydrateUnavailableCount: corpusStats.hydrateUnavailableCount,
    lastPulled: corpusStats.lastPulled,
    lastTotal: corpusStats.lastTotal,
    lastPages: corpusStats.lastPages,
    lastTruncatedByLimit: corpusStats.lastTruncatedByLimit,
    lastUnavailableReason: corpusStats.lastUnavailableReason,
    lastUnavailableAt: corpusStats.lastUnavailableAt,
    lastSuccessAt: corpusStats.lastSuccessAt,
  };
  AsyncStorage.setItem(LEARNING_CORPUS_COUNTERS_KEY, JSON.stringify(payload)).catch((error: unknown) => {
    console.warn(
      '[LearningStore] Failed to persist corpus counters:',
      error instanceof Error ? error.message : String(error),
    );
  });
}

/** Snapshot of the durable corpus-hydration counters, for the diagnostics export. */
export function getLearningCorpusStats(): LearningCorpusStats {
  return { ...corpusStats };
}

/** Test-only: reset the in-memory counters (does NOT touch AsyncStorage). */
export function __resetLearningCorpusStatsForTest(): void {
  corpusStats.hydrateAttempts = 0;
  corpusStats.hydrateSuccesses = 0;
  corpusStats.hydrateUnavailableCount = 0;
  corpusStats.lastPulled = null;
  corpusStats.lastTotal = null;
  corpusStats.lastPages = null;
  corpusStats.lastTruncatedByLimit = false;
  corpusStats.lastUnavailableReason = null;
  corpusStats.lastUnavailableAt = null;
  corpusStats.lastSuccessAt = null;
}

type SqliteDatabase = {
  execAsync: (sql: string) => Promise<void>;
  runAsync: (sql: string, params?: unknown[]) => Promise<void>;
  getAllAsync: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
};

let db: SqliteDatabase | null = null;
let initPromise: Promise<void> | null = null;

// Web (and any environment without expo-sqlite) falls back to an in-memory
// array, mirroring barStore.ts's webStore pattern. Order is insertion order,
// which matches SQLite's rowid-ordered `ORDER BY id ASC`.
let webOutcomes: StoredTradeOutcome[] = [];

async function initDb(): Promise<void> {
  if (Platform.OS === 'web') return;
  if (db) return;
  try {
    const SQLite = await import('expo-sqlite');
    const opened = await SQLite.openDatabaseAsync('learning.db');
    db = opened as unknown as SqliteDatabase;
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS trade_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trade_outcomes_ts ON trade_outcomes(ts);
    `);
    console.log('🗄️ [LearningStore] sqlite initialized');
  } catch (err) {
    console.warn('⚠️ [LearningStore] sqlite init failed, falling back to memory:', err);
    db = null;
  }
}

export function ensureLearningStoreReady(): Promise<void> {
  if (!initPromise) initPromise = initDb();
  return initPromise;
}

function toTimestampMs(ts: string | number | Date): number {
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  const parsed = new Date(ts).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** Append one outcome row. O(1) — does not touch any other row. */
export async function appendOutcome(outcome: StoredTradeOutcome): Promise<void> {
  await ensureLearningStoreReady();
  const ts = toTimestampMs(outcome.timestamp);
  if (Platform.OS === 'web' || !db) {
    webOutcomes.push(outcome);
    return;
  }
  await db.runAsync(
    'INSERT INTO trade_outcomes (ts, data) VALUES (?, ?)',
    [ts, JSON.stringify(outcome)],
  );
}

/**
 * Replaces the entire local tier with `outcomes` (already in the desired order).
 * Used by hydrateFromRemote() so a merged local+remote corpus can be written
 * back in true timestamp order rather than accidental insertion order.
 */
async function replaceAllOutcomes(outcomes: StoredTradeOutcome[]): Promise<void> {
  await ensureLearningStoreReady();
  if (Platform.OS === 'web' || !db) {
    webOutcomes = outcomes.map(o => ({ ...o }));
    return;
  }
  await db.runAsync('DELETE FROM trade_outcomes');
  for (const outcome of outcomes) {
    await db.runAsync(
      'INSERT INTO trade_outcomes (ts, data) VALUES (?, ?)',
      [toTimestampMs(outcome.timestamp), JSON.stringify(outcome)],
    );
  }
}

/**
 * Merges the durable Supabase corpus into the local tier.
 *
 * - union by `signalId` (remote rows the local tier has never seen are added;
 *   a signalId already present locally is left untouched, so a local record is
 *   never clobbered by a remote copy of the same trade);
 * - the merged set is re-sorted by timestamp and rewritten, so `getAllOutcomes()`
 *   stays genuinely oldest-first after a merge;
 * - any local rows missing from the remote corpus are pushed up, so an existing
 *   on-device history is backfilled into Supabase on first run.
 *
 * Never throws — a remote failure leaves the local tier exactly as it was.
 */
export async function hydrateFromRemote(options?: { limit?: number; cap?: number }): Promise<{
  available: boolean;
  pulled: number;
  merged: number;
  /** ITEM 43(b): local rows whose stored label was corrected from the durable corpus. */
  refreshed: number;
  backfilled: number;
  total: number;
}> {
  await ensureLearningStoreReady();
  const local = await getAllOutcomes();

  if (!remoteSyncEnabled) {
    // Test seam only — deliberately NOT counted as an unavailable corpus read.
    return { available: false, pulled: 0, merged: 0, refreshed: 0, backfilled: 0, total: local.length };
  }

  // ITEM 12(d): count the attempt BEFORE the read, so an unavailable read is
  // always attributable (attempts - successes === unavailable).
  await hydrateLearningCorpusStats();
  corpusStats.hydrateAttempts += 1;

  // ITEM 12(a)(b): DIRECT, PAGINATED Supabase read via the anon key. The Rork
  // backend is NOT on this path. There is deliberately no fallback source.
  const read = await fetchRemoteOutcomesDirect(options?.limit ?? 300);
  if (!read.available) {
    corpusStats.hydrateUnavailableCount += 1;
    corpusStats.lastUnavailableReason = `${read.reason}${read.detail ? `: ${read.detail}` : ''}`;
    corpusStats.lastUnavailableAt = Date.now();
    persistCorpusStats(true);
    console.warn(
      `⚠️ [LearningStore] CORPUS_UNAVAILABLE reason=${read.reason} — keeping local corpus (${local.length} outcome(s)); the model may train on a TRUNCATED set`,
    );
    return { available: false, pulled: 0, merged: 0, refreshed: 0, backfilled: 0, total: local.length };
  }

  const remote: StoredTradeOutcome[] = read.outcomes;
  const available = true;
  corpusStats.hydrateSuccesses += 1;
  corpusStats.lastPulled = remote.length;
  corpusStats.lastPages = read.pages;
  corpusStats.lastTruncatedByLimit = read.truncatedByLimit;
  corpusStats.lastSuccessAt = Date.now();
  if (read.truncatedByLimit) {
    console.warn(
      `⚠️ [LearningStore] Corpus pull hit the limit (${remote.length}) across ${read.pages} page(s) — the durable corpus is LARGER than the pull window`,
    );
  }

  // D2 / F-16 FIX: normalize ALL signalIds to String for set operations so the
  // membership checks are symmetric. The prior code could report local_only=0
  // while remote_only=338 with shared=100 one way and shared=63 the other —
  // an arithmetic impossibility caused by type-coerced signalIds comparing
  // asymmetrically (a number 123 in localIds vs string "123" in remote).
  const localIds = new Set(local.map(o => String(o.signalId)));
  const remoteById = new Map(remote.map(o => [String(o.signalId), o]));
  const remoteIds = new Set(remoteById.keys());
  const newFromRemote = remote.filter(o => !localIds.has(String(o.signalId)));

  // ── ITEM 43(b) — THE DURABLE STORE IS AUTHORITATIVE ON A LABEL CONFLICT ────
  // This used to be a pure union: a signalId already present locally was left
  // untouched, on the reasoning that "a local record is never clobbered by a
  // remote copy of the same trade". That reasoning is wrong for the one case
  // that matters. `trade_outcomes_v1` is the corpus of record and is the ONLY
  // tier that can be corrected — Item 43 rewrote 17 rows there to their
  // bar-verified truth. Under the old union those corrections could never reach
  // a device that already held the stale row, so the model would keep training
  // on labels the durable store no longer agrees with, with nothing in the logs
  // to show it.
  //
  // A local row is only ever a CACHE of a durable row (learningStore's own
  // contract, see the header), so on a genuine conflict the remote value wins.
  // Local-only rows are still never discarded — they are backfilled upward
  // below, exactly as before.
  const refreshedRows: { signalId: string; from: string; to: string }[] = [];
  const reconciledLocal = local.map(o => {
    const r = remoteById.get(o.signalId);
    if (!r) return o;
    const labelChanged = r.result !== o.result;
    const rChanged = (r.realizedR ?? null) !== (o.realizedR ?? null);
    if (!labelChanged && !rChanged) return o;
    if (labelChanged) {
      refreshedRows.push({ signalId: o.signalId, from: o.result, to: r.result });
    }
    return { ...r };
  });

  let merged = 0;
  if (newFromRemote.length > 0 || refreshedRows.length > 0 || reconciledLocal.some((o, i) => o !== local[i])) {
    const cap = options?.cap ?? 500;
    const combined = [...reconciledLocal, ...newFromRemote]
      .sort((a, b) => toTimestampMs(a.timestamp) - toTimestampMs(b.timestamp))
      .slice(-cap);
    await replaceAllOutcomes(combined);
    merged = newFromRemote.length;
  }
  if (refreshedRows.length > 0) {
    console.log(
      `🩹 [LearningStore] ${refreshedRows.length} local outcome(s) relabelled from the durable corpus: ` +
        refreshedRows.map(r => `${r.signalId.slice(-6)} ${r.from}->${r.to}`).join(', '),
    );
  }

  // D2: same String() normalization on the missing-remotely check.
  const missingRemotely = local.filter(o => !remoteIds.has(String(o.signalId)));

  // ITEM 74(c) / D2: RECONCILIATION VISIBILITY — all four counters computed from
  // the SAME pre-merge snapshot (local captured at :1096, remote at :1122), so
  // shared must be identical both ways: local - local_only === remote - remote_only.
  // If it does not, the normalization above was wrong and the export will show it.
  await hydrateOutboundPushStats();
  const sharedFromLocal = local.length - missingRemotely.length;
  const sharedFromRemote = remote.length - newFromRemote.length;
  pushStats.lastLocalCount = local.length;
  pushStats.lastRemoteCount = remote.length;
  pushStats.lastLocalOnlyCount = missingRemotely.length;
  pushStats.lastRemoteOnlyCount = newFromRemote.length;
  pushStats.lastReconcileAt = Date.now();
  persistPushStats(true);
  const sharedMatch = sharedFromLocal === sharedFromRemote ? 'OK' : `MISMATCH (${sharedFromLocal} vs ${sharedFromRemote})`;
  console.log(
    `📐 [LearningStore] RECONCILE local=${local.length} remote=${remote.length} ` +
      `local_only=${missingRemotely.length} remote_only=${newFromRemote.length} ` +
      `shared=${sharedFromLocal} (${sharedMatch})`,
  );

  let backfilled = 0;
  if (missingRemotely.length > 0) {
    const pushResult = await pushOutcomesToRemote(missingRemotely);
    backfilled = pushResult.upserted;
    // ITEM 78(b): caller now sees failure detail, not just .upserted.
    if (pushResult.failed > 0) {
      console.warn(`⚠️ [LearningStore] Hydrate push failed for ${pushResult.failed} row(s): ${pushResult.failureDetail ?? 'unknown'}`);
    }
  }

  const total = await getOutcomeCount();
  corpusStats.lastTotal = total;
  persistCorpusStats(true);
  console.log(`🔄 [LearningStore] Remote hydrate (direct Supabase, ${read.pages} page(s)): pulled ${remote.length}, merged ${merged} new, relabelled ${refreshedRows.length}, backfilled ${backfilled} local-only, total ${total}`);
  return { available, pulled: remote.length, merged, refreshed: refreshedRows.length, backfilled, total };
}

/** Delete the oldest rows beyond `cap`, keeping the most recent `cap` by insertion order. */
export async function pruneToCap(cap: number): Promise<void> {
  await ensureLearningStoreReady();
  if (Platform.OS === 'web' || !db) {
    if (webOutcomes.length > cap) webOutcomes = webOutcomes.slice(-cap);
    return;
  }
  await db.runAsync(
    'DELETE FROM trade_outcomes WHERE id NOT IN (SELECT id FROM trade_outcomes ORDER BY id DESC LIMIT ?)',
    [cap],
  );
}

/** Returns every stored outcome, oldest first (matches prior array-push ordering). */
export async function getAllOutcomes(): Promise<StoredTradeOutcome[]> {
  await ensureLearningStoreReady();
  if (Platform.OS === 'web' || !db) {
    return webOutcomes.map(o => ({ ...o }));
  }
  const rows = await db.getAllAsync<{ data: string }>('SELECT data FROM trade_outcomes ORDER BY id ASC');
  return rows.map(r => JSON.parse(r.data) as StoredTradeOutcome);
}

export async function getOutcomeCount(): Promise<number> {
  await ensureLearningStoreReady();
  if (Platform.OS === 'web' || !db) return webOutcomes.length;
  const rows = await db.getAllAsync<{ cnt: number }>('SELECT COUNT(*) as cnt FROM trade_outcomes');
  return rows[0]?.cnt ?? 0;
}

/**
 * One-time migration path: if the SQLite store is empty but legacy
 * AsyncStorage data exists, copy every legacy outcome in (preserving order)
 * and return how many rows were migrated. Idempotent — if the store already
 * has rows (from a prior migration or fresh SQLite-native writes) this is a
 * no-op and returns 0, so it's safe to call on every app start.
 */
export async function migrateLegacyOutcomesIfEmpty(legacyOutcomes: StoredTradeOutcome[]): Promise<number> {
  await ensureLearningStoreReady();
  const existing = await getOutcomeCount();
  if (existing > 0) return 0;
  if (!Array.isArray(legacyOutcomes) || legacyOutcomes.length === 0) return 0;
  for (const outcome of legacyOutcomes) {
    await appendOutcome(outcome);
  }
  return legacyOutcomes.length;
}

/** Test-only helper: wipes all rows so migration tests start from a clean slate. */
export async function clearAllOutcomesForTest(): Promise<void> {
  await ensureLearningStoreReady();
  if (Platform.OS === 'web' || !db) {
    webOutcomes = [];
    return;
  }
  await db.runAsync('DELETE FROM trade_outcomes');
}
