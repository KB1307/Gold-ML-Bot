// Supabase Edge Function: send-telegram-alert
//
// ITEM 6 — TAKE THE RORK BACKEND OFF THE TELEGRAM DELIVERY PATH.
//
// The alert used to be dispatched through the Rork Hono/tRPC backend
// (`telegram.sendAlert`), which flaps 503. The client's retry horizon was ~2.4s
// against outages measured in tens of seconds, the send was fire-and-forget and
// the error was swallowed — so alerts were LOST SILENTLY and the downstream MT5
// executor simply never received those trades.
//
// This function replaces that path entirely. No Rork backend anywhere:
//   client --(anon key)--> Supabase Edge Function --> api.telegram.org
//
// TELEGRAM_BOT_TOKEN is a Supabase secret, so it stays server-side; the client
// only ever holds the public anon key.
//
// DURABLE OUTBOX: every alert is a row in `telegram_outbox_v1`. Delivery state
// is mutated ONLY here, with the service role (anon has INSERT + SELECT only).
// An undelivered alert stays PENDING and is retried — by the next client
// dispatch, or by the pg_cron drain — until it is DELIVERED or AGED_OUT.
//
// AGING POLICY (derived, not assumed — see expo/scripts/measureAlertAgingHorizon.ts):
// the executor takes the alert's entry zone (entryPrice +/- $2.0) at face value,
// so a late alert is dangerous rather than merely late. Measured on 40,000
// anchor minutes of gold_m1_bars, the probability that price still touches that
// band at t0+D is 100% @1m, 95% @2m, 76% @5m, 59.7% @10m, 50.4% @15m, 27.7% @60m.
// DEFAULT_TTL_MINUTES = 10 is the point where the alert is about as likely to be
// unexecutable as executable; past it, firing would more often mislead the
// executor into a stale trade than win back a lost one. Retries are therefore
// aggressive INSIDE 10 minutes and stop dead at the boundary.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Same destinations as the retired backend route — the MT5 executor needs ZERO changes.
const TELEGRAM_CHAT_IDS = ["-1004409610798", "-1004310142756"];

const DEFAULT_TTL_MINUTES = 10;
const MAX_DRAIN_ROWS = 25;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const TELEGRAM_TIMEOUT_MS = 12_000;

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

interface OutboxRow {
  id: number;
  signal_id: string | null;
  message: string;
  parse_mode: string | null;
  kind: string;
  status: string;
  attempts: number;
  created_at: string;
  expires_at: string;
}

function getAdminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not available");
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function getBotToken(): string | null {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
  return token && token.length > 0 ? token : null;
}

function extractTelegramError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { description?: string };
    if (parsed && typeof parsed.description === "string" && parsed.description.length > 0) {
      return parsed.description;
    }
  } catch {
    // not JSON — fall through to raw text
  }
  return body.slice(0, 160) || "Unknown error";
}

interface ChatSendResult {
  chatId: string;
  ok: boolean;
  status: number;
  error?: string;
}

async function sendToChat(
  token: string,
  chatId: string,
  text: string,
  parseMode: string | null,
): Promise<ChatSendResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
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
      try {
        body = await response.text();
      } catch {
        // ignore
      }
      return { chatId, ok: false, status: response.status, error: extractTelegramError(body) };
    }
    return { chatId, ok: true, status: response.status };
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    const message = error instanceof Error ? error.message : String(error);
    return { chatId, ok: false, status: 0, error: message };
  }
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)), BACKOFF_MAX_MS);
}

interface AttemptOutcome {
  outboxId: number;
  signalId: string | null;
  delivered: boolean;
  agedOut: boolean;
  attempts: number;
  deliveredOnRetry: boolean;
  error?: string;
  chats?: ChatSendResult[];
}

/**
 * Attempts one delivery of a single outbox row and records the resulting state.
 * The row is only ever marked DELIVERED when EVERY configured chat accepted it —
 * a partial delivery stays PENDING so the missing chat is retried.
 */
async function attemptRow(
  admin: SupabaseClient,
  token: string,
  row: OutboxRow,
): Promise<AttemptOutcome> {
  const nowMs = Date.now();
  const expiresMs = new Date(row.expires_at).getTime();

  if (nowMs > expiresMs) {
    await admin
      .from("telegram_outbox_v1")
      .update({
        status: "AGED_OUT",
        last_error: `aged out after ${row.attempts} attempts (entry zone no longer executable)`,
      })
      .eq("id", row.id);
    return {
      outboxId: row.id,
      signalId: row.signal_id,
      delivered: false,
      agedOut: true,
      attempts: row.attempts,
      deliveredOnRetry: false,
      error: "aged out",
    };
  }

  const attempts = row.attempts + 1;
  const chats = await Promise.all(
    TELEGRAM_CHAT_IDS.map((chatId) => sendToChat(token, chatId, row.message, row.parse_mode)),
  );
  const allOk = chats.every((c) => c.ok);

  if (allOk) {
    const deliveredOnRetry = row.attempts > 0;
    await admin
      .from("telegram_outbox_v1")
      .update({
        status: "DELIVERED",
        attempts,
        delivered_at: new Date().toISOString(),
        delivered_on_retry: deliveredOnRetry,
        last_error: null,
      })
      .eq("id", row.id);
    return {
      outboxId: row.id,
      signalId: row.signal_id,
      delivered: true,
      agedOut: false,
      attempts,
      deliveredOnRetry,
      chats,
    };
  }

  const failure = chats.find((c) => !c.ok);
  const reason = `chat ${failure?.chatId ?? "?"} status ${failure?.status ?? 0}: ${failure?.error ?? "unknown"}`;
  await admin
    .from("telegram_outbox_v1")
    .update({
      attempts,
      last_error: reason,
      next_attempt_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
    })
    .eq("id", row.id);

  return {
    outboxId: row.id,
    signalId: row.signal_id,
    delivered: false,
    agedOut: false,
    attempts,
    deliveredOnRetry: false,
    error: reason,
    chats,
  };
}

interface RequestBody {
  outboxId?: number;
  text?: string;
  signalId?: string;
  parseMode?: string | null;
  kind?: string;
  ttlMinutes?: number;
  drain?: boolean;
  probe?: boolean;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  let body: RequestBody = {};
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    body = {};
  }

  const token = getBotToken();

  // Config probe — never sends anything. Lets the delivery path be verified end
  // to end (function reachable, secret present, DB writable) without spamming
  // the live executor chats.
  if (body.probe === true) {
    let dbOk = false;
    let dbError: string | null = null;
    try {
      const admin = getAdminClient();
      const { error } = await admin.from("telegram_outbox_v1").select("id").limit(1);
      dbOk = !error;
      dbError = error?.message ?? null;
    } catch (error: unknown) {
      dbError = error instanceof Error ? error.message : String(error);
    }
    return json({
      probe: true,
      tokenConfigured: token !== null,
      chatCount: TELEGRAM_CHAT_IDS.length,
      outboxReadable: dbOk,
      dbError,
      ttlMinutesDefault: DEFAULT_TTL_MINUTES,
    });
  }

  if (!token) {
    return json({ ok: false, error: "TELEGRAM_BOT_TOKEN secret is not configured" }, 500);
  }

  let admin: SupabaseClient;
  try {
    admin = getAdminClient();
  } catch (error: unknown) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }

  // ── DRAIN MODE (pg_cron) ───────────────────────────────────────────────────
  // Retries every PENDING row whose backoff has elapsed and ages out the ones
  // past their TTL. This is what makes the outbox durable rather than a longer
  // retry loop: delivery no longer depends on the client still being open.
  if (body.drain === true) {
    const { data, error } = await admin
      .from("telegram_outbox_v1")
      .select("id, signal_id, message, parse_mode, kind, status, attempts, created_at, expires_at")
      .eq("status", "PENDING")
      .lte("next_attempt_at", new Date().toISOString())
      .order("created_at", { ascending: true })
      .limit(MAX_DRAIN_ROWS);

    if (error) {
      return json({ ok: false, drain: true, error: error.message }, 500);
    }

    const rows = (data ?? []) as OutboxRow[];
    const outcomes: AttemptOutcome[] = [];
    for (const row of rows) {
      outcomes.push(await attemptRow(admin, token, row));
    }

    return json({
      ok: true,
      drain: true,
      considered: rows.length,
      delivered: outcomes.filter((o) => o.delivered).length,
      agedOut: outcomes.filter((o) => o.agedOut).length,
      stillPending: outcomes.filter((o) => !o.delivered && !o.agedOut).length,
      outcomes,
    });
  }

  // ── SINGLE-ROW MODE ───────────────────────────────────────────────────────
  let row: OutboxRow | null = null;

  if (typeof body.outboxId === "number") {
    const { data, error } = await admin
      .from("telegram_outbox_v1")
      .select("id, signal_id, message, parse_mode, kind, status, attempts, created_at, expires_at")
      .eq("id", body.outboxId)
      .maybeSingle();
    if (error) return json({ ok: false, error: error.message }, 500);
    if (!data) return json({ ok: false, error: `outbox row ${body.outboxId} not found` }, 404);
    row = data as OutboxRow;
    if (row.status === "DELIVERED") {
      return json({ ok: true, alreadyDelivered: true, outboxId: row.id });
    }
    if (row.status === "AGED_OUT") {
      return json({ ok: false, agedOut: true, outboxId: row.id });
    }
  } else if (typeof body.text === "string" && body.text.trim().length > 0) {
    // Fallback: the caller could not insert the outbox row itself (e.g. its own
    // Supabase write failed), so the function enrolls the alert instead. The
    // alert still becomes durable — it is never delivered off-book.
    const ttl = typeof body.ttlMinutes === "number" ? body.ttlMinutes : DEFAULT_TTL_MINUTES;
    const { data, error } = await admin
      .from("telegram_outbox_v1")
      .insert({
        signal_id: body.signalId ?? null,
        message: body.text,
        parse_mode: body.parseMode ?? null,
        kind: body.kind ?? "ALERT",
        expires_at: new Date(Date.now() + ttl * 60_000).toISOString(),
      })
      .select("id, signal_id, message, parse_mode, kind, status, attempts, created_at, expires_at")
      .maybeSingle();
    if (error) return json({ ok: false, error: error.message }, 500);
    row = data as OutboxRow;
  } else {
    return json({ ok: false, error: "provide { outboxId } or { text }" }, 400);
  }

  const outcome = await attemptRow(admin, token, row);
  return json({ ok: outcome.delivered, ...outcome }, outcome.delivered ? 200 : 502);
});
