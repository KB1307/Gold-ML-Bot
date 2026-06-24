import { TradingSignal } from "@/types/trading";

const TELEGRAM_API_URL =
  "https://api.telegram.org/bot8704113854:AAHebld6qMlK2eKGJB0DND3O7FvuLdPypSQ/sendMessage";
const TELEGRAM_CHAT_ID = "-1004409610798";

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
 * Sends an arbitrary custom message to the configured Telegram chat and awaits
 * the result. Unlike {@link sendTelegramAlert}, this resolves with a structured
 * result so callers (e.g. the in-app test panel) can surface success/failure.
 * Sent as plain text (no Markdown) so a custom notice never trips entity-parse
 * errors regardless of the characters the user types.
 */
export async function sendTelegramMessage(text: string): Promise<TelegramSendResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, status: 0, error: "Message is empty" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(TELEGRAM_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: trimmed,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        // ignore body read failures
      }
      const description = extractTelegramError(body);
      console.warn(`[Telegram] Test message failed (${response.status}): ${description}`);
      return { ok: false, status: response.status, error: description };
    }

    console.log("[Telegram] Test message delivered");
    return { ok: true, status: response.status };
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, status: 0, error: "Request timed out" };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[Telegram] Network error sending test message:", message);
    return { ok: false, status: 0, error: message };
  }
}

function buildTelegramMessage(signal: TradingSignal): string {
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
    `*TAKE PROFIT 2:* ${formatPrice(signal.tp2)}`,
    `*TAKE PROFIT 3:* ${formatPrice(signal.tp3)}`,
  ];

  return lines.join("\n");
}

/**
 * Sends a Telegram alert for a newly generated trading signal.
 * Truly fire-and-forget — the fetch is kicked off without waiting for
 * Telegram's response, so the message dispatches in <100ms. Success/failure
 * is logged asynchronously without ever blocking the caller.
 */
export function sendTelegramAlert(signal: TradingSignal): void {
  const text = buildTelegramMessage(signal);
  const signalId = signal.id;

  const controller = new AbortController();
  // Kill the request after 8 seconds — the message is already delivered
  // when Telegram receives the POST body; we don't need the response.
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  fetch(TELEGRAM_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
    }),
    signal: controller.signal,
  })
    .then((response) => {
      clearTimeout(timeoutId);
      if (!response.ok) {
        // Read the body only on failure, and don't block on it.
        // Logged as a warning (not an error) because a delivery failure is an
        // external/config issue (e.g. the bot lacks posting rights in the chat)
        // — it must never surface as an app runtime error or block the pipeline.
        response
          .text()
          .then((body) => {
            console.warn(
              `[Telegram] Delivery failed (${response.status}): ${body.slice(0, 200)}`
            );
          })
          .catch(() => {});
        return;
      }
      console.log(`[Telegram] Alert dispatched for signal ${signalId}`);
    })
    .catch((error: unknown) => {
      clearTimeout(timeoutId);
      if (error instanceof DOMException && error.name === "AbortError") {
        // Timed out — message was almost certainly delivered, Telegram just
        // didn't respond within 8s. Don't log as an error.
        console.log(
          `[Telegram] Request timed out for signal ${signalId} (message likely delivered)`
        );
        return;
      }
      console.warn(
        "[Telegram] Network error dispatching alert:",
        error instanceof Error ? error.message : String(error)
      );
    });
}
