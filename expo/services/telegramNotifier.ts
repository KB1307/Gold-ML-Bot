import AsyncStorage from "@react-native-async-storage/async-storage";

import { trpcClient } from "@/lib/trpc";
import { TradingSignal } from "@/types/trading";

// The Telegram bot token and chat IDs now live server-side only
// (backend/trpc/routes/telegram.ts, TELEGRAM_BOT_TOKEN env var). This file
// just formats messages and calls the backend — nothing secret is bundled
// into the client anymore.

function formatPrice(value: number): string {
  return value.toFixed(1);
}

// Half-width of the entry zone band, in price units (gold). The zone spans
// entryPrice ± ENTRY_ZONE_BAND so an alert can still be executed despite the
// lag between sending and receiving the signal. TPs/SL remain anchored to the
// single entry point.
const ENTRY_ZONE_BAND = 2.0;

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

// ─────────────────────────────────────────────────────────────────────────────
// ITEM 5(d) — DURABLE ALERT-DELIVERY TELEMETRY
//
// The alert is dispatched fire-and-forget (`void attemptSend(1)`), and every
// failure path below only ever reached `console.warn`. A Telegram alert that
// never arrived was therefore INVISIBLE in the diagnostics export: nothing
// counted it, nothing surfaced it, and the downstream MT5 bot simply never
// received the trade.
//
// These counters make that impossible. They are DURABLE (AsyncStorage), not
// process-lifetime, because Item 4 already established that process-lifetime
// counters reset on app reload and captured nothing across a full trading day.
// ─────────────────────────────────────────────────────────────────────────────

const TELEGRAM_DELIVERY_COUNTERS_KEY = "telegram_delivery_counters_v1";
const COUNTER_FLUSH_INTERVAL_MS = 15_000;

export interface TelegramDeliveryStats {
  /** Alerts handed to sendTelegramAlert() (one per emitted signal). */
  alertsAttempted: number;
  /** Alerts that reached every configured chat successfully. */
  alertsDelivered: number;
  /** Alerts that exhausted every retry without success — a LOST trade. */
  alertsFailed: number;
  /** Individual HTTP/tRPC dispatch attempts, including retries. */
  dispatchAttempts: number;
  /** Individual attempts that failed (transport error or ok:false). */
  dispatchFailures: number;
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

const RETRYABLE_STATUS_CODES = new Set([0, 408, 429, 500, 502, 503, 504]);
const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends an arbitrary custom message to all configured Telegram chats via the
 * backend proxy and awaits the result.
 *
 * Retries a couple of times on transient failures (backend cold start /
 * capacity blips surface as network errors or 5xx/429 statuses) so a
 * one-off hiccup doesn't show up to the user as a hard "failed to send"
 * error when a retry would have gone through fine.
 */
export async function sendTelegramMessage(text: string): Promise<TelegramSendResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, status: 0, error: "Message is empty" };
  }

  let lastResult: TelegramSendResult = { ok: false, status: 0, error: "Unknown error" };

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    try {
      const result = await trpcClient.telegram.sendMessage.mutate({ text: trimmed });
      if (result.ok) {
        return result;
      }
      lastResult = result;
      if (!RETRYABLE_STATUS_CODES.has(result.status)) {
        return result;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Telegram] sendMessage backend call failed (attempt ${attempt}/${MAX_SEND_ATTEMPTS}):`, message);
      lastResult = { ok: false, status: 0, error: message };
    }

    if (attempt < MAX_SEND_ATTEMPTS) {
      await delay(RETRY_DELAY_MS * attempt);
    }
  }

  return lastResult;
}

function buildTelegramMessage(signal: TradingSignal, numberOfTPs: 1 | 2 | 3 = 3): string {
  const entryPrice = signal.entryPriceWithSlippage || signal.entryPrice;
  const dot = signal.type === "BUY" ? "\u{1F7E2}" : "\u{1F534}"; // ✅ Quote syntax mismatch fixed here

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

  return lines.join("\n");
}

/**
 * Sends a Telegram alert for a newly generated trading signal via the
 * backend proxy. Fire-and-forget from the caller's perspective — the
 * mutation is dispatched without awaiting so callers keep returning
 * immediately, matching the previous behavior.
 */
export function sendTelegramAlert(signal: TradingSignal, numberOfTPs: 1 | 2 | 3 = 3): void {
  const text = buildTelegramMessage(signal, numberOfTPs);
  const signalId = signal.id;

  const recordFailure = (reason: string): void => {
    deliveryStats.dispatchFailures += 1;
    deliveryStats.lastFailureReason = reason;
    deliveryStats.lastFailureAt = Date.now();
  };

  /** Marks the alert as permanently lost once every retry is exhausted. */
  const giveUp = (reason: string): void => {
    deliveryStats.alertsFailed += 1;
    deliveryStats.lastFailureReason = reason;
    deliveryStats.lastFailureAt = Date.now();
    console.error(
      `[Telegram] ALERT LOST for signal ${signalId} after ${MAX_SEND_ATTEMPTS} attempts: ${reason}`,
    );
    persistDeliveryStats(true);
  };

  const attemptSend = async (attempt: number): Promise<void> => {
    deliveryStats.dispatchAttempts += 1;
    try {
      const result = await trpcClient.telegram.sendAlert.mutate({ text });
      if (result.ok) {
        deliveryStats.alertsDelivered += 1;
        deliveryStats.lastSuccessAt = Date.now();
        persistDeliveryStats(true);
        console.log(`[Telegram] Alert dispatched for signal ${signalId}`);
        return;
      }
      const reason = `backend reported per-chat failures (attempt ${attempt})`;
      recordFailure(reason);
      console.warn(`[Telegram] Alert dispatch reported failures for signal ${signalId} (attempt ${attempt}/${MAX_SEND_ATTEMPTS})`);
      if (attempt < MAX_SEND_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
        await attemptSend(attempt + 1);
      } else {
        giveUp(reason);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      recordFailure(message);
      console.warn(
        `[Telegram] Network error dispatching alert for signal ${signalId} (attempt ${attempt}/${MAX_SEND_ATTEMPTS}):`,
        message,
      );
      if (attempt < MAX_SEND_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
        await attemptSend(attempt + 1);
      } else {
        giveUp(message);
      }
    }
  };

  // Count AFTER hydration so the durable totals are the base, never a base that
  // already contains this process's increments.
  void hydrateTelegramDeliveryStats().finally(() => {
    deliveryStats.alertsAttempted += 1;
    void attemptSend(1);
  });
}
