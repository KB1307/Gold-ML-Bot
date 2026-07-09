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

/**
 * Sends an arbitrary custom message to all configured Telegram chats via the
 * backend proxy and awaits the result.
 */
export async function sendTelegramMessage(text: string): Promise<TelegramSendResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, status: 0, error: "Message is empty" };
  }

  try {
    const result = await trpcClient.telegram.sendMessage.mutate({ text: trimmed });
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[Telegram] sendMessage backend call failed:", message);
    return { ok: false, status: 0, error: message };
  }
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

  trpcClient.telegram.sendAlert
    .mutate({ text })
    .then((result) => {
      if (!result.ok) {
        console.warn(`[Telegram] Alert dispatch reported failures for signal ${signalId}`);
        return;
      }
      console.log(`[Telegram] Alert dispatched for signal ${signalId}`);
    })
    .catch((error: unknown) => {
      console.warn(
        `[Telegram] Network error dispatching alert for signal ${signalId}:`,
        error instanceof Error ? error.message : String(error),
      );
    });
}
