import { TradingSignal } from "@/types/trading";

const TELEGRAM_API_URL =
  "https://api.telegram.org/bot8704113854:AAHebld6qMlK2eKGJB0DND3O7FvuLdPypSQ/sendMessage";
const TELEGRAM_CHAT_ID = "-5368971735";

function formatPrice(value: number): string {
  return value.toFixed(1);
}

function formatConfidence(value: number): string {
  return (value * 100).toFixed(1);
}

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  const time = d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const day = d.getDate();
  const month = d.toLocaleString("en-US", { month: "long" });
  return `${time} ${day} ${month}`;
}

function buildTelegramMessage(signal: TradingSignal): string {
  const entryPrice = signal.entryPriceWithSlippage || signal.entryPrice;
  const confPct = formatConfidence(signal.confidence);

  const lines = [
    `*New ${signal.type} Signal (${confPct}%)*`,
    "",
    `Entry Price: ${formatPrice(entryPrice)}`,
    "",
    `*SL:* ${formatPrice(signal.sl)}`,
    `*Take Profit 1:* ${formatPrice(signal.tp1)}`,
    `*Take Profit 2:* ${formatPrice(signal.tp2)}`,
    `*Take Profit 3:* ${formatPrice(signal.tp3)}`,
    "",
    `Time: ${formatTime(signal.entryTime)}`,
  ];

  if (signal.topFeatures && signal.topFeatures.length > 0) {
    const topFeatureNames = signal.topFeatures
      .slice(0, 3)
      .map((f) => f.feature)
      .join(", ");
    lines.push(`_Top Drivers: ${topFeatureNames}_`);
  }

  lines.push("", `Signal ID: ${signal.id}`);

  return lines.join("\n");
}

/**
 * Sends a Telegram alert for a newly generated trading signal.
 * Runs silently — network errors are caught and logged without throwing,
 * so the UI and signal pipeline are never blocked.
 */
export async function sendTelegramAlert(signal: TradingSignal): Promise<void> {
  const text = buildTelegramMessage(signal);

  try {
    const response = await fetch(TELEGRAM_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "unknown");
      console.error(
        `[Telegram] API error ${response.status}: ${errorBody.slice(0, 200)}`
      );
      return;
    }

    const result = await response.json();
    if (result?.ok) {
      console.log(`[Telegram] Alert sent for signal ${signal.id}`);
    } else {
      console.error(
        `[Telegram] API returned not-ok: ${JSON.stringify(result).slice(0, 200)}`
      );
    }
  } catch (error: unknown) {
    console.error(
      "[Telegram] Network error sending alert:",
      error instanceof Error ? error.message : String(error)
    );
  }
}
