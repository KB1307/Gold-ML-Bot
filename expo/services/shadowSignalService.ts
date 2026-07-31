/**
 * Shadow SELL signal service — fire-and-forget push of suppressed SELL records
 * to the durable shadow_signals_v1 Supabase table via the backend tRPC route.
 *
 * When allowShortSignals is false, the engine still fully scores and geometry-
 * computes every qualifying SELL, but does NOT emit it as a live signal. This
 * service pushes the would-be signal (plus the tested +40pip/70-pip-SL/30-60-90
 * variant) to shadow_signals_v1 so the suppression decision stays monitorable
 * against real forward data.
 *
 * ALL calls are fire-and-forget — they must never block, delay, or alter
 * live signal generation. Callers should not await this.
 */

export interface ShadowSellRecord {
  signalId: string;
  createdAt: number;
  direction: 'SELL';
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
  /** +40pip shifted entry variant (77% fill rate in counterfactual) */
  entryShifted: number;
  slShifted: number;
  tp1Shifted: number;
  tp2Shifted: number;
  tp3Shifted: number;
  slMultiplier: number;
  atr: number;
  regime: string;
  sessionName: string;
  hourUtc: number;
  srZonesSnapshot: unknown;
  attentionScores: unknown;
  htfTrend: string | null;
  ltfTrend: string | null;
  rsi: number | null;
}

/**
 * Resolve the live tRPC base origin — same logic as lib/trpc.ts getBaseUrlCandidates.
 * Uses EXPO_PUBLIC_RORK_API_BASE_URL (the alive tRPC host), NOT
 * EXPO_PUBLIC_RORK_FUNCTIONS_URL (which has no bundle deployed and 503s on
 * every route — confirmed live 2026-07-31). The tRPC server at API_BASE_URL
 * hosts the shadow.push mutation, which writes via a server-side service-role
 * client (process.env.SUPABASE_SERVICE_ROLE_KEY) — the service key is NEVER
 * shipped to the browser/client.
 */
const resolveTrpcBaseOrigin = (): string | null => {
  const configured = process.env.EXPO_PUBLIC_RORK_API_BASE_URL;
  if (configured) return configured.trim().replace(/\/+$/, '').replace(/\/api\/trpc$/, '').replace(/\/api$/, '');
  if (typeof window !== 'undefined' && typeof window.location?.origin === 'string') {
    return window.location.origin.trim().replace(/\/+$/, '');
  }
  return null;
};

/**
 * Push a shadow SELL record to the backend tRPC shadow.push mutation.
 * Fire-and-forget — errors are logged and swallowed, never propagate.
 *
 * Wire format: the tRPC httpLink with superjson sends mutations as POST to
 * /api/trpc/{procedure} with body {json: {json: {input}}} — the outer json is
 * the superjson transformer wrapper, the inner json is the procedure's own
 * input field name (shadow.push's schema is z.object({ json: shadowRecordSchema })).
 * Confirmed working via live curl 2026-07-31: POST /api/trpc/shadow.push with
 * double-nested json body returns {result:{data:{json:{ok:true}}}}.
 */
/**
 * Push a shadow SELL record with retry-on-cold-start.
 *
 * The tRPC server (Cloudflare/Deno Deploy) cold-starts and returns 503/429
 * on the first request after idle. A single fire-and-forget fetch will
 * silently fail when the server is cold — which would lose shadow records.
 * This retries on 503/429 with exponential backoff (1s, 2s, 4s) up to 3
 * attempts, still fully fire-and-forget (never blocks the caller).
 */
/**
 * The tRPC hosting (Deno Deploy) aggressively cold-starts — the server spins
 * down within seconds of inactivity and returns 503/429 while spinning back up.
 * A warmup GET before each POST attempt significantly improves delivery rate,
 * because the GET triggers the spin-up and the POST immediately follows on
 * the now-warm instance.
 */
const MAX_PUSH_RETRIES = 5;
const pushWithRetry = async (
  pushUrl: string,
  body: string,
  attempt: number = 0,
): Promise<void> => {
  // Warmup GET before each POST attempt — triggers cold-start spin-up
  if (attempt > 0) {
    const warmupUrl = pushUrl.replace('/shadow.push', '/shadow.recent') + '?input=%7B%22json%22%3A%7B%22limit%22%3A1%7D%7D';
    try {
      await fetch(warmupUrl, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    } catch {
      // warmup failure is non-fatal — the POST may still succeed
    }
  }

  try {
    const res = await fetch(pushUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trpc-source': '1' },
      body,
    });
    if (res.ok) {
      return; // success
    }
    if ((res.status === 503 || res.status === 429) && attempt < MAX_PUSH_RETRIES - 1) {
      const delayMs = 2000 * (attempt + 1); // 2s, 4s, 6s, 8s
      console.log(`[ShadowSell] HTTP ${res.status} on attempt ${attempt + 1}/${MAX_PUSH_RETRIES} — retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
      return pushWithRetry(pushUrl, body, attempt + 1);
    }
    console.warn(`[ShadowSell] push failed after ${attempt + 1} attempts: HTTP ${res.status}`);
  } catch (err) {
    if (attempt < MAX_PUSH_RETRIES - 1) {
      const delayMs = 2000 * (attempt + 1);
      console.log(`[ShadowSell] fetch error on attempt ${attempt + 1}/${MAX_PUSH_RETRIES} — retrying in ${delayMs}ms:`, err instanceof Error ? err.message : 'unknown');
      await new Promise((r) => setTimeout(r, delayMs));
      return pushWithRetry(pushUrl, body, attempt + 1);
    }
    console.warn('[ShadowSell] push error after retries (fire-and-forget):', err instanceof Error ? err.message : 'unknown');
  }
};

export function pushShadowSellRecord(record: ShadowSellRecord): void {
  const baseOrigin = resolveTrpcBaseOrigin();
  if (!baseOrigin) {
    console.log('[ShadowSell] No backend URL — skipping durable push');
    return;
  }

  const url = `${baseOrigin}/api/trpc/shadow.push`;
  const body = JSON.stringify({ json: { json: record } });
  // Fire-and-forget — the async retry loop runs in the background and never
  // blocks or throws to the caller. The record lands once the server warms up.
  void pushWithRetry(url, body);
}
