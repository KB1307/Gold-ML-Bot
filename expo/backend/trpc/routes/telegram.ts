import * as z from "zod";

import { createTRPCRouter, publicProcedure } from "../create-context";
import { readRuntimeEnv } from "../../runtimeEnv";

// 🌐 Telegram destinations. These are not secrets (chat IDs are meaningless
// without the bot token), so they can safely live here. The bot token itself
// is read from the private TELEGRAM_BOT_TOKEN env var below and never sent
// to the client.
const TELEGRAM_CHAT_IDS = [
  "-1004409610798",
  "-1004310142756",
];

function getTelegramBotToken(): string | null {
  const token = readRuntimeEnv("TELEGRAM_BOT_TOKEN")?.trim();
  return token && token.length > 0 ? token : null;
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

type ChatSendResult = { chatId: string; ok: boolean; status: number; error?: string };

async function sendToChat(
  token: string,
  chatId: string,
  text: string,
  parseMode?: "Markdown",
): Promise<ChatSendResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch {}
      const description = extractTelegramError(body);
      console.warn(`[Telegram] Message failed for chat ${chatId} (${response.status}): ${description}`);
      return { chatId, ok: false, status: response.status, error: description };
    }

    console.log(`[Telegram] Message delivered to chat ${chatId}`);
    return { chatId, ok: true, status: response.status };
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      return { chatId, ok: false, status: 0, error: `Request timed out for chat ${chatId}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Telegram] Network error sending to chat ${chatId}:`, message);
    return { chatId, ok: false, status: 0, error: message };
  }
}

export const telegramRouter = createTRPCRouter({
  /**
   * Sends an arbitrary custom message to all configured Telegram chats.
   * Used by Settings > "Send test message".
   */
  sendMessage: publicProcedure
    .input(z.object({ text: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const token = getTelegramBotToken();
      if (!token) {
        console.warn("[Telegram] TELEGRAM_BOT_TOKEN is not configured on the backend");
        return { ok: false as const, status: 0, error: "Telegram bot token is not configured on the server." };
      }

      const results = await Promise.all(
        TELEGRAM_CHAT_IDS.map((chatId) => sendToChat(token, chatId, input.text.trim())),
      );

      const failed = results.find((r) => !r.ok);
      if (failed) {
        return { ok: false as const, status: failed.status, error: failed.error };
      }
      return { ok: true as const, status: 200 };
    }),

  /**
   * Fire-and-forget style signal alert. The mutation itself still resolves
   * once every chat has been attempted; callers that want fire-and-forget
   * semantics simply don't await it (matching the previous client behavior).
   */
  sendAlert: publicProcedure
    .input(z.object({ text: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const token = getTelegramBotToken();
      if (!token) {
        console.warn("[Telegram] TELEGRAM_BOT_TOKEN is not configured on the backend");
        return { ok: false as const, results: [] as ChatSendResult[] };
      }

      const results = await Promise.all(
        TELEGRAM_CHAT_IDS.map((chatId) => sendToChat(token, chatId, input.text, "Markdown")),
      );

      results.forEach((r) => {
        if (!r.ok) {
          console.warn(`[Telegram] Alert delivery failed for destination ${r.chatId}: ${r.error}`);
        }
      });

      return { ok: results.every((r) => r.ok), results };
    }),
});
