import { TradingSignal } from "@/types/trading";

const TELEGRAM_API_URL =
  "https://api.telegram.org/bot8704113854:AAHebld6qMlK2eKGJB0DND3O7FvuLdPypSQ/sendMessage";
const TELEGRAM_CHAT_ID = "-1004409610798";

function formatPrice(value: number): string {
  return value.toFixed(1);
}

function formatConfidence(value: number): string {
  return (value * 100).toFixed(1);
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
    `*ENTRY ZONE:* ${formatPrice(entryPrice)}`,
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
