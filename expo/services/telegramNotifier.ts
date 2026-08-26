import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { TradingSignal } from "@/types/trading";

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 6 — THE RORK BACKEND IS OFF THE TELEGRAM DELIVERY PATH.
//
// Previously: client -> Rork Hono/tRPC backend (`telegram.sendAlert`) -> Telegram.
// That backend flaps 503; the client retried for ~2.4s total against outages
// measured in tens of seconds, the send was fire-and-forget, and the error was
// swallowed. Alerts were therefore LOST SILENTLY and the downstream MT5 executor
// never received those trades.
//
// Now:  client --(anon key)--> Supabase Edge Function `send-telegram-alert`
//                        --> api.telegram.org
//
// DATA-SOURCE RULE: no Rork backend anywhere on this path. TELEGRAM_BOT_TOKEN is
// a Supabase SECRET, so it stays server-side; the client only ever holds the
// public anon key.
//
// DURABLE OUTBOX: the alert is first PERSISTED to `telegram_outbox_v1` via the
// anon key (the Design-B write pattern already proven for shadow_signals_v1),
// and only then dispatched. If dispatch fails for any reason — Supabase blip,
// Telegram outage, the app being killed mid-flight — the row stays PENDING and a
// pg_cron drain (every minute) retries it until it is DELIVERED or AGED_OUT.
// Delivery therefore no longer depends on this process staying alive, which a
// wider retry horizon alone could never achieve.
// ─────────────────────────────────────────────────────────────────────────────

function formatPrice(value: number): string {
  return value.toFixed(1);
}

// Half-width of the entry zone band, in price units (gold). The zone spans
// entryPrice ± ENTRY_ZONE_BAND so an alert can still be executed despite the
// lag between sending and receiving the signal. TPs/SL remain anchored to the
// single entry point.
const ENTRY_ZONE_BAND = 2.0;

/**
 * Outbox aging horizon, in minutes. DERIVED, not assumed — see
 * `expo/scripts/measureAlertAgingHorizon.ts`: across 40,000 anchor minutes of
 * gold_m1_bars, the probability that price still touches the ±$2.0 entry band at
 * t0+D is 100% @1m, 95% @2m, 76% @5m, 59.7% @10m, 50.4% @15m, 27.7% @60m. Ten
 * minutes is where a delivered alert becomes about as likely to be unexecutable
 * as executable; past it, firing late would more often push the executor into a
 * stale trade than recover a lost one.
 */
const OUTBOX_TTL_MINUTES = 10;

function formatEntryZone(entryPrice: number): string {
  const low = entryPrice - ENTRY_ZONE_BAND;
  const high = entryPrice + ENTRY_ZONE_BAND;
  return `${formatPrice(low)} - ${formatPrice(high)}`;
}

export interface TelegramSendResult {
  ok: boolean;
  status: number;
  error?: string;
}

// ── Supabase delivery path (anon key only) ──────────────────────────────────

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? "";
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
const OUTBOX_TABLE = "telegram_outbox_v1";
const FUNCTION_NAME = "send-telegram-alert";

let outboxClient: SupabaseClient | null = null;

function getOutboxClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return null;
  }
  if (!outboxClient) {
    outboxClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return outboxClient;
}

interface DeliveryFunctionResponse {
  ok?: boolean;
  delivered?: boolean;
  agedOut?: boolean;
  alreadyDelivered?: boolean;
  attempts?: number;
  error?: string;
}

/**
 * Invokes the Supabase Edge Function that owns Telegram delivery. Returns the
 * HTTP status so a transport failure and a Telegram-side rejection stay
 * distinguishable in the counters.
 */
async function invokeDeliveryFunction(
  body: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<{ status: number; payload: DeliveryFunctionResponse | null; error?: string }> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { status: 0, payload: null, error: "Supabase URL / anon key are not configured" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/${FUNCTION_NAME}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    let payload: DeliveryFunctionResponse | null = null;
    try {
      payload = (await response.json()) as DeliveryFunctionResponse;
    } catch {
      payload = null;
    }
    return { status: response.status, payload, error: payload?.error };
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    return {
      status: 0,
      payload: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 5(d) + ITEM 6(c) — DURABLE ALERT-DELIVERY TELEMETRY
//
// Every failure path used to reach only `console.warn`, so an alert that never
// arrived was INVISIBLE in the diagnostics export. These counters make that
// impossible, and they are DURABLE (AsyncStorage) because Item 4 established
// that process-lifetime counters reset on reload and captured nothing across a
// full trading day.
//
// ITEM 6(c) extends them to the outbox: an alert that this process could not
// deliver but DID persist is not lost — it is pending a drain retry — and the
// counters must say which of the two happened.
// ─────────────────────────────────────────────────────────────────────────────

const TELEGRAM_DELIVERY_COUNTERS_KEY = "telegram_delivery_counters_v1";
const COUNTER_FLUSH_INTERVAL_MS = 15_000;

export interface TelegramDeliveryStats {
  /** Alerts handed to sendTelegramAlert() (one per emitted signal). */
  alertsAttempted: number;
  /** Alerts that reached every configured chat successfully. */
  alertsDelivered: number;
  /** Alerts that could not even be PERSISTED to the outbox — genuinely lost. */
  alertsFailed: number;
  /** Individual HTTP dispatch attempts to the Edge Function, including retries. */
  dispatchAttempts: number;
  /** Individual attempts that failed (transport error or ok:false). */
  dispatchFailures: number;
  /** Alerts durably enrolled in telegram_outbox_v1 by this process. */
  outboxEnqueued: number;
  /** Outbox inserts that failed, forcing the function-side enrollment fallback. */
  outboxEnqueueFailures: number;
  /**
   * Alerts this process could not deliver inline but which ARE persisted and
   * awaiting the pg_cron drain. NOT lost — see the outbox table for final state.
   */
  outboxHandoffs: number;
  lastFailureReason: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  /** True once counters have been rehydrated from durable storage. */
  hydrated: boolean;
}

const deliveryStats: TelegramDeliveryStats = {
  alertsAttempted: 0,
  alertsDelivered: 0,
  alertsFailed: 0,
  dispatchAttempts: 0,
  dispatchFailures: 0,
  outboxEnqueued: 0,
  outboxEnqueueFailures: 0,
  outboxHandoffs: 0,
  lastFailureReason: null,
  lastFailureAt: null,
  lastSuccessAt: null,
  hydrated: false,
};

let hydrationPromise: Promise<void> | null = null;
let lastFlushAt = 0;

type PersistedCounters = Omit<TelegramDeliveryStats, "hydrated">;

function isPersistedCounters(value: unknown): value is Partial<PersistedCounters> {
  return typeof value === "object" && value !== null;
}

/**
 * Rehydrates the delivery counters from AsyncStorage. Safe to call repeatedly —
 * the underlying read happens at most once per process.
 */
export function hydrateTelegramDeliveryStats(): Promise<void> {
  if (hydrationPromise) {
    return hydrationPromise;
  }

  hydrationPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(TELEGRAM_DELIVERY_COUNTERS_KEY);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (isPersistedCounters(parsed)) {
          // ADD the persisted totals to whatever this process has already
          // counted, rather than assigning them. An alert can be dispatched
          // before hydration resolves (the very first signal after launch), and
          // assignment would silently discard that count.
          deliveryStats.alertsAttempted += parsed.alertsAttempted ?? 0;
          deliveryStats.alertsDelivered += parsed.alertsDelivered ?? 0;
          deliveryStats.alertsFailed += parsed.alertsFailed ?? 0;
          deliveryStats.dispatchAttempts += parsed.dispatchAttempts ?? 0;
          deliveryStats.dispatchFailures += parsed.dispatchFailures ?? 0;
          deliveryStats.outboxEnqueued += parsed.outboxEnqueued ?? 0;
          deliveryStats.outboxEnqueueFailures += parsed.outboxEnqueueFailures ?? 0;
          deliveryStats.outboxHandoffs += parsed.outboxHandoffs ?? 0;
          deliveryStats.lastFailureReason = deliveryStats.lastFailureReason ?? parsed.lastFailureReason ?? null;
          deliveryStats.lastFailureAt = deliveryStats.lastFailureAt ?? parsed.lastFailureAt ?? null;
          deliveryStats.lastSuccessAt = deliveryStats.lastSuccessAt ?? parsed.lastSuccessAt ?? null;
        }
      }
    } catch (error: unknown) {
      console.warn(
        "[Telegram] Failed to rehydrate delivery counters:",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      deliveryStats.hydrated = true;
    }
  })();

  return hydrationPromise;
}

function persistDeliveryStats(force: boolean): void {
  // Never write before hydration. Persisting a pre-hydration partial and then
  // adding the stored totals back in would double-count that partial.
  if (!deliveryStats.hydrated) {
    return;
  }

  const now = Date.now();
  if (!force && now - lastFlushAt < COUNTER_FLUSH_INTERVAL_MS) {
    return;
  }
  lastFlushAt = now;

  const payload: PersistedCounters = {
    alertsAttempted: deliveryStats.alertsAttempted,
    alertsDelivered: deliveryStats.alertsDelivered,
    alertsFailed: deliveryStats.alertsFailed,
    dispatchAttempts: deliveryStats.dispatchAttempts,
    dispatchFailures: deliveryStats.dispatchFailures,
    outboxEnqueued: deliveryStats.outboxEnqueued,
    outboxEnqueueFailures: deliveryStats.outboxEnqueueFailures,
    outboxHandoffs: deliveryStats.outboxHandoffs,
    lastFailureReason: deliveryStats.lastFailureReason,
    lastFailureAt: deliveryStats.lastFailureAt,
    lastSuccessAt: deliveryStats.lastSuccessAt,
  };

  AsyncStorage.setItem(TELEGRAM_DELIVERY_COUNTERS_KEY, JSON.stringify(payload)).catch(
    (error: unknown) => {
      console.warn(
        "[Telegram] Failed to persist delivery counters:",
        error instanceof Error ? error.message : String(error),
      );
    },
  );
}

/** Snapshot of the durable alert-delivery counters, for the diagnostics export. */
export function getTelegramDeliveryStats(): TelegramDeliveryStats {
  return { ...deliveryStats };
}

/** ITEM 6(c): live outbox state, read DIRECTLY from Supabase via the anon key. */
export interface TelegramOutboxSummary {
  pending: number;
  delivered: number;
  deliveredOnRetry: number;
  agedOut: number;
  oldestPendingAgeSec: number | null;
  lastError: string | null;
  windowHours: number;
}

/**
 * Reads the durable outbox state for the diagnostics export. DIRECT Supabase
 * read via the anon key (SELECT is RLS-permitted) — never through the Rork
 * backend, which is exactly the defect class this item exists to remove.
 */
export async function fetchTelegramOutboxSummary(
  windowHours = 72,
): Promise<TelegramOutboxSummary | null> {
  const client = getOutboxClient();
  if (!client) {
    return null;
  }

  const sinceIso = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const { data, error } = await client
    .from(OUTBOX_TABLE)
    .select("status, delivered_on_retry, created_at, last_error")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    console.warn(`[Telegram] Outbox summary read failed: ${error.message}`);
    return null;
  }

  const rows = (data ?? []) as {
    status: string;
    delivered_on_retry: boolean | null;
    created_at: string;
    last_error: string | null;
  }[];

  let pending = 0;
  let delivered = 0;
  let deliveredOnRetry = 0;
  let agedOut = 0;
  let oldestPendingMs: number | null = null;
  let lastError: string | null = null;

  for (const row of rows) {
    if (row.status === "PENDING") {
      pending += 1;
      const created = new Date(row.created_at).getTime();
      if (oldestPendingMs === null || created < oldestPendingMs) {
        oldestPendingMs = created;
      }
    } else if (row.status === "DELIVERED") {
      delivered += 1;
      if (row.delivered_on_retry === true) deliveredOnRetry += 1;
    } else if (row.status === "AGED_OUT") {
      agedOut += 1;
    }
    if (lastError === null && row.last_error) {
      lastError = row.last_error;
    }
  }

  return {
    pending,
    delivered,
    deliveredOnRetry,
    agedOut,
    oldestPendingAgeSec:
      oldestPendingMs === null ? null : Math.round((Date.now() - oldestPendingMs) / 1000),
    lastError,
    windowHours,
  };
}

const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends an arbitrary custom message to all configured Telegram chats via the
 * Supabase Edge Function and awaits the result. Used by Settings > "Send test
 * message". Enrolled in the same durable outbox as real alerts so a failure is
 * retried rather than lost, and tagged `kind = 'TEST'` so test traffic never
 * pollutes the alert delivery statistics.
 */
export async function sendTelegramMessage(text: string): Promise<TelegramSendResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, status: 0, error: "Message is empty" };
  }

  let lastResult: TelegramSendResult = { ok: false, status: 0, error: "Unknown error" };

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    const { status, payload, error } = await invokeDeliveryFunction({
      text: trimmed,
      kind: "TEST",
      ttlMinutes: OUTBOX_TTL_MINUTES,
    });

    if (status === 200 && payload?.delivered === true) {
      return { ok: true, status };
    }

    lastResult = { ok: false, status, error: error ?? `delivery function returned ${status}` };
    console.warn(
      `[Telegram] Test message delivery failed (attempt ${attempt}/${MAX_SEND_ATTEMPTS}, status ${status}): ${lastResult.error}`,
    );

    if (attempt < MAX_SEND_ATTEMPTS) {
      await delay(RETRY_DELAY_MS * attempt);
    }
  }

  return lastResult;
}

function buildTelegramMessage(signal: TradingSignal, numberOfTPs: 1 | 2 | 3 = 3): string {
  const entryPrice = signal.entryPriceWithSlippage || signal.entryPrice;
  const dot = signal.type === "BUY" ? "\u{1F7E2}" : "\u{1F534}";

  const lines = [
    `${dot} *SIGNAL ALERT* ${dot}`,
    "",
    `*SYMBOL:* XAUUSD`,
    "",
    `*ACTION:* ${signal.type}`,
    "",
    `*ENTRY ZONE:* ${formatEntryZone(entryPrice)}`,
    "",
    `*STOP LOSS:* ${formatPrice(signal.sl)}`,
    "",
    `*TAKE PROFIT 1:* ${formatPrice(signal.tp1)}`,
  ];

  if (numberOfTPs >= 2) {
    lines.push(`*TAKE PROFIT 2:* ${formatPrice(signal.tp2)}`);
  }
  if (numberOfTPs >= 3) {
    lines.push(`*TAKE PROFIT 3:* ${formatPrice(signal.tp3)}`);
  }

  /**
   * ITEM 225 (B3) — CONFIDENCE IN THE PERSISTED PAYLOAD.
   *
   * telegram_outbox_v1 rows are written BEFORE delivery, which made the outbox
   * the ONLY surviving witness of three live emissions that never reached
   * emitted_signals_v1 (signal_1787083581937_xr6mjtadq 2026-08-18T20:06Z,
   * signal_1787580401459_cpid69ppf 2026-08-24T14:06Z,
   * signal_1787587872040_446kz8aab 2026-08-24T16:11Z). The persisted alert held
   * the whole ladder — direction, entry zone, SL, TP1-3 — so those rows were
   * ALMOST restorable. They were not restorable, for exactly one reason:
   * emitted_signals_v1.confidence is NOT NULL and NO witness had recorded the
   * confidence. That constraint is CORRECT (a live emission with no confidence
   * is not a real record), so the fix belongs here, in the witness, not there.
   *
   * Adding the line makes the outbox a COMPLETE emission witness going forward:
   * the next time the emission write path breaks, the row can be rebuilt from
   * recorded values alone with nothing invented. This is presentational for the
   * human reader and load-bearing for the archaeology.
   */
  const confidencePct = Number.isFinite(signal.confidence)
    ? Math.round(signal.confidence * 100)
    : null;
  if (confidencePct !== null) {
    lines.push("");
    lines.push(`*CONFIDENCE:* ${confidencePct}%`);
  }

  return lines.join("\n");
}

/** Exposed for the delivery test so the executor-facing format is asserted, not assumed. */
export function __buildTelegramMessageForTest(
  signal: TradingSignal,
  numberOfTPs: 1 | 2 | 3 = 3,
): string {
  return buildTelegramMessage(signal, numberOfTPs);
}

/**
 * Persists the alert to the durable outbox, then dispatches it.
 *
 * Order matters: PERSIST FIRST. If the process dies, the network drops, or the
 * Edge Function is briefly unavailable, the row is already durable and the
 * pg_cron drain will deliver it (or age it out at the derived 10-minute
 * horizon). Only an alert that could not be persisted AT ALL is counted as lost.
 */
export function sendTelegramAlert(signal: TradingSignal, numberOfTPs: 1 | 2 | 3 = 3): void {
  const text = buildTelegramMessage(signal, numberOfTPs);
  const signalId = signal.id;

  const recordFailure = (reason: string): void => {
    deliveryStats.dispatchFailures += 1;
    deliveryStats.lastFailureReason = reason;
    deliveryStats.lastFailureAt = Date.now();
  };

  /** The alert is persisted but undelivered by this process — the drain owns it now. */
  const handOffToOutbox = (outboxId: number, reason: string): void => {
    deliveryStats.outboxHandoffs += 1;
    deliveryStats.lastFailureReason = reason;
    deliveryStats.lastFailureAt = Date.now();
    console.warn(
      `[Telegram] ALERT PENDING IN OUTBOX for signal ${signalId} (outboxId=${outboxId}) after ${MAX_SEND_ATTEMPTS} inline attempts: ${reason}. The pg_cron drain will retry until delivered or aged out at ${OUTBOX_TTL_MINUTES}m.`,
    );
    persistDeliveryStats(true);
  };

  /** Neither the outbox insert nor the function-side enrollment worked — genuinely lost. */
  const giveUp = (reason: string): void => {
    deliveryStats.alertsFailed += 1;
    deliveryStats.lastFailureReason = reason;
    deliveryStats.lastFailureAt = Date.now();
    console.error(
      `[Telegram] ALERT LOST for signal ${signalId} — could not persist to the outbox: ${reason}`,
    );
    persistDeliveryStats(true);
  };

  const markDelivered = (): void => {
    deliveryStats.alertsDelivered += 1;
    deliveryStats.lastSuccessAt = Date.now();
    persistDeliveryStats(true);
    console.log(`[Telegram] Alert DELIVERED for signal ${signalId}`);
  };

  const enqueue = async (): Promise<number | null> => {
    const client = getOutboxClient();
    if (!client) {
      deliveryStats.outboxEnqueueFailures += 1;
      return null;
    }
    try {
      const { data, error } = await client
        .from(OUTBOX_TABLE)
        .insert({
          signal_id: signalId,
          message: text,
          parse_mode: "Markdown",
          kind: "ALERT",
          expires_at: new Date(Date.now() + OUTBOX_TTL_MINUTES * 60_000).toISOString(),
        })
        .select("id")
        .maybeSingle();

      if (error || !data) {
        deliveryStats.outboxEnqueueFailures += 1;
        console.warn(
          `[Telegram] Outbox insert failed for signal ${signalId}: ${error?.message ?? "no row returned"}`,
        );
        return null;
      }
      deliveryStats.outboxEnqueued += 1;
      return (data as { id: number }).id;
    } catch (error: unknown) {
      deliveryStats.outboxEnqueueFailures += 1;
      console.warn(
        `[Telegram] Outbox insert threw for signal ${signalId}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  };

  const run = async (): Promise<void> => {
    const outboxId = await enqueue();

    // The dispatch body: an id when the row is ours, otherwise the raw text so
    // the function enrolls the alert itself. Either way it becomes durable
    // before it is ever delivered.
    const body: Record<string, unknown> =
      outboxId !== null
        ? { outboxId }
        : { text, signalId, parseMode: "Markdown", kind: "ALERT", ttlMinutes: OUTBOX_TTL_MINUTES };

    let lastReason = "unknown";
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      deliveryStats.dispatchAttempts += 1;
      const { status, payload, error } = await invokeDeliveryFunction(body);

      if (status === 200 && (payload?.delivered === true || payload?.alreadyDelivered === true)) {
        markDelivered();
        return;
      }

      if (payload?.agedOut === true) {
        lastReason = "aged out before delivery";
        recordFailure(lastReason);
        break;
      }

      lastReason = error ?? `delivery function returned ${status}`;
      recordFailure(lastReason);
      console.warn(
        `[Telegram] Alert dispatch failed for signal ${signalId} (attempt ${attempt}/${MAX_SEND_ATTEMPTS}, status ${status}): ${lastReason}`,
      );

      if (attempt < MAX_SEND_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
      }
    }

    if (outboxId !== null) {
      handOffToOutbox(outboxId, lastReason);
    } else {
      giveUp(lastReason);
    }
  };

  // Count AFTER hydration so the durable totals are the base, never a base that
  // already contains this process's increments.
  void hydrateTelegramDeliveryStats().finally(() => {
    deliveryStats.alertsAttempted += 1;
    void run();
  });
}
