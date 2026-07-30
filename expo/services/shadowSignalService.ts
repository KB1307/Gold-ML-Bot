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
 * Push a shadow SELL record to the backend. Fire-and-forget.
 * Errors are logged and swallowed — never propagate.
 */
export function pushShadowSellRecord(record: ShadowSellRecord): void {
  const baseUrl = process.env.EXPO_PUBLIC_RORK_FUNCTIONS_URL;
  if (!baseUrl) {
    console.log('[ShadowSell] No backend URL — skipping durable push');
    return;
  }

  const url = `${baseUrl}/shadow.push`;
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ json: record }),
  })
    .then((res) => {
      if (!res.ok) {
        console.warn(`[ShadowSell] push failed: HTTP ${res.status}`);
      }
    })
    .catch((err) => {
      console.warn('[ShadowSell] push error (fire-and-forget):', err instanceof Error ? err.message : 'unknown');
    });
}
