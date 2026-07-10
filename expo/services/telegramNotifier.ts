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

  const attemptSend = async (attempt: number): Promise<void> => {
    try {
      const result = await trpcClient.telegram.sendAlert.mutate({ text });
      if (result.ok) {
        console.log(`[Telegram] Alert dispatched for signal ${signalId}`);
        return;
      }
      console.warn(`[Telegram] Alert dispatch reported failures for signal ${signalId} (attempt ${attempt}/${MAX_SEND_ATTEMPTS})`);
      if (attempt < MAX_SEND_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
        await attemptSend(attempt + 1);
      }
    } catch (error: unknown) {
      console.warn(
        `[Telegram] Network error dispatching alert for signal ${signalId} (attempt ${attempt}/${MAX_SEND_ATTEMPTS}):`,
        error instanceof Error ? error.message : String(error),
      );
      if (attempt < MAX_SEND_ATTEMPTS) {
        await delay(RETRY_DELAY_MS * attempt);
        await attemptSend(attempt + 1);
      }
    }
  };

  void attemptSend(1);
}
