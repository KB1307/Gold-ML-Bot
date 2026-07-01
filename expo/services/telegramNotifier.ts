import { TradingSignal } from "@/types/trading";

const TELEGRAM_API_URL = "https://api.telegram.org/bot8704113854:AAHebld6qMlK2eKGJB0DND3O7FvuLdPypSQ/sendMessage";

// 🌐 Convert the single ID into an array of targets
// ⚠️ Note: Telegram channel IDs almost always start with a "-100" prefix (e.g., "-1001234567890")
const TELEGRAM_CHAT_IDS = [
  "-1004409610798",   
  "-1004310142756" 
];

function formatPrice(value: number): string {
  return value.toFixed(1);
}

const ENTRY_ZONE_BAND = 2.0;

function formatEntryZone(entryPrice: number): string {
  const low = entryPrice - ENTRY_ZONE_BAND;
  const high = entryPrice + ENTRY_ZONE_BAND;
  return `${formatPrice(low)} - ${formatPrice(high)}`;
}

function formatConfidence(value: number): string {
  return (value * 100).toFixed(1);
}

function extractTelegramError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { description?: string };
    if (parsed && typeof parsed.description === "string" && parsed.description.length > 0) {
      return parsed.description;
    }
  } catch {
    // body wasn't JSON — fall through to the raw text
  }
  return body.slice(0, 160) || "Unknown error";
}

export interface TelegramSendResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Sends an arbitrary custom message to ALL configured Telegram chats and awaits
 * the results. Returns success only if all destinations delivered successfully.
 */
export async function sendTelegramMessage(text: string): Promise<TelegramSendResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, status: 0, error: "Message is empty" };
  }

  // Fire off all requests concurrently using Promise.all
  const requests = TELEGRAM_CHAT_IDS.map(async (chatId) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(TELEGRAM_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: trimmed,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        let body = "";
        try { body = await response.text(); } catch {}
        const description = extractTelegramError(body);
        console.warn(`[Telegram] Message failed for chat ${chatId} (${response.status}): ${description}`);
        return { ok: false, status: response.status, error: description };
      }

      console.log(`[Telegram] Message delivered to chat ${chatId}`);
      return { ok: true, status: response.status };
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === "AbortError") {
        return { ok: false, status: 0, error: `Request timed out for chat ${chatId}` };
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Telegram] Network error sending to chat ${chatId}:`, message);
      return { ok: false, status: 0, error: message };
    }
  });

  const results = await Promise.all(requests);
  
  // If any destination fails, surface the first error caught
  const failedResult = results.find((res) => !res.ok);
  if (failedResult) return failedResult;

  return { ok: true, status: 200 };
}

function buildTelegramMessage(signal: TradingSignal): string {
  const entryPrice = signal.entryPriceWithSlippage || signal.entryPrice;
  const dot = signal.type === "BUY" ? "\u{1F7E2}" : "\u{1F534}`;

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
    `*TAKE PROFIT 2:* ${formatPrice(signal.tp2)}`,
    `*TAKE PROFIT 3:* ${formatPrice(signal.tp3)}`,
  ];

  return lines.join("\n");
}

/**
 * Sends a Telegram alert for a newly generated trading signal to multiple rooms.
 * Iterates through destinations instantly so formatting execution remains <100ms.
 */
export function sendTelegramAlert(signal: TradingSignal): void {
  const text = buildTelegramMessage(signal);
  const signalId = signal.id;

  // Spin up parallel async fetches for each ID in the array
  TELEGRAM_CHAT_IDS.forEach((chatId) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    fetch(TELEGRAM_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
      signal: controller.signal,
    })
      .then((response) => {
        clearTimeout(timeoutId);
        if (!response.ok) {
          response
            .text()
            .then((body) => {
              console.warn(
                `[Telegram] Delivery failed for destination ${chatId} (${response.status}): ${body.slice(0, 200)}`
              );
            })
            .catch(() => {});
          return;
        }
        console.log(`[Telegram] Alert dispatched to ${chatId} for signal ${signalId}`);
      })
      .catch((error: unknown) => {
        clearTimeout(timeoutId);
        if (error instanceof DOMException && error.name === "AbortError") {
          console.log(
            `[Telegram] Request timed out for ${chatId} on signal ${signalId} (message likely delivered)`
          );
          return;
        }
        console.warn(
          `[Telegram] Network error dispatching alert to ${chatId}:`,
          error instanceof Error ? error.message : String(error)
        );
      });
  });
}