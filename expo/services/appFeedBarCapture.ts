/**
 * PHASE C / C1 — APP-FEED M1 BAR CAPTURE (ITEM 214 structural-fix prerequisite).
 *
 * C1 measured the cross-venue basis at 28.4% of TP1 (median, LIVE, current
 * 25-pip ladder; the two failed 2026-08-24 BUYs: 51.6% / 55.2%). The zone map
 * is built in the VANTAGE frame; entries execute in the APP frame. Whether the
 * basis is a persistent level (translatable) or white noise (NOT translatable)
 * is unmeasurable without durable app-feed bar history — this module is that
 * instrument, writing 1-minute OHLC bars aggregated from the app's own price
 * feed into app_m1_bars (migration 013).
 *
 * DESIGN: mirrors the proven fire-and-forget write pattern (shadowSignalService
 * / emittedSignalService). ZERO scoring impact: the capture sits on the tick
 * path but never blocks, never throws, and nothing reads it back during signal
 * generation. Bars are flushed once per completed minute; a partial final
 * minute of a session is simply never written (a bar is only durable once the
 * minute closes).
 *
 * NOT changed: gold_m1_bars, zone computation, entry stamping, any gate.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

interface MinuteBucket {
  minuteTs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

let captureClient: SupabaseClient | null = null;
let currentBucket: MinuteBucket | null = null;
let barsWritten = 0;
let writeFailures = 0;
let captureEnabled = true;

const getClient = (): SupabaseClient | null => {
  if (captureClient) return captureClient;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  captureClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return captureClient;
};

const flushBucket = (bucket: MinuteBucket): void => {
  const client = getClient();
  if (!client) return;
  const rounded = {
    timestamp: new Date(bucket.minuteTs).toISOString(),
    open: parseFloat(bucket.open.toFixed(2)),
    high: parseFloat(bucket.high.toFixed(2)),
    low: parseFloat(bucket.low.toFixed(2)),
    close: parseFloat(bucket.close.toFixed(2)),
    source: 'APP_FEED' as const,
  };
  void (async () => {
    try {
      const { error } = await client
        .from('app_m1_bars')
        .upsert(rounded, { onConflict: 'timestamp' });
      if (error) {
        writeFailures += 1;
        console.warn(`[AppFeedBars] WRITE_FAILED (fire-and-forget): ${error.message}`);
      } else {
        barsWritten += 1;
      }
    } catch (err: unknown) {
      writeFailures += 1;
      console.warn(`[AppFeedBars] WRITE_ERROR (fire-and-forget): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
};

/**
 * Record one app-feed tick. Aggregates into the current minute bucket; when the
 * minute rolls over the completed bucket is flushed (fire-and-forget) and a new
 * bucket opens. Intended to be called from the engine's tick path on EVERY tick
 * — it is O(1) except once per minute.
 */
export function recordAppFeedTick(price: number, tsMs: number = Date.now()): void {
  if (!captureEnabled || !Number.isFinite(price) || price <= 0) return;
  const minuteTs = Math.floor(tsMs / 60_000) * 60_000;
  if (currentBucket && currentBucket.minuteTs === minuteTs) {
    currentBucket.high = Math.max(currentBucket.high, price);
    currentBucket.low = Math.min(currentBucket.low, price);
    currentBucket.close = price;
    return;
  }
  // Minute rolled over (or a late tick arrives after a gap): flush the closed
  // bucket, then open the new one. A gap simply means missing minutes are not
  // written — honest absence, not synthetic fills.
  if (currentBucket) flushBucket(currentBucket);
  currentBucket = { minuteTs, open: price, high: price, low: price, close: price };
}

/** Completed bars durably written since process start. */
export function getAppFeedBarsWritten(): number {
  return barsWritten;
}

/** Capture write failures since process start. */
export function getAppFeedBarWriteFailures(): number {
  return writeFailures;
}

/** Test-only: disable/re-enable capture and reset counters. */
export function __setAppFeedCaptureEnabled(enabled: boolean): void {
  captureEnabled = enabled;
}
