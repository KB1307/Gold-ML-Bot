-- ITEM 136(d): ZONE REFRESH CADENCE — 4h → 15min.
--
-- The zone map was 1255 minutes (20.9 hours) old when signal [1] fired at
-- 2026-08-18T16:25:33Z. The cron `5 */4 * * *` runs every 4 hours, but the
-- last successful write was at 19:30 UTC on Aug 17 — the 00:05, 04:05, 08:05,
-- 12:05, and 16:05 runs on Aug 18 either didn't fire or failed silently.
--
-- MEASUREMENT (expo/scripts/item136_measure.ts):
--   Zone formation time (first touch → qualification [2+ touches or 1 rejection]):
--     p25=0 min, p50=0 min, p75=0 min, p90=0 min
--     96.1% qualify in <5 min, 97.6% in <15 min, 98.0% in <30 min
--
-- The cadence must be materially shorter than the p25. 15 minutes is derived:
--   - 5 minutes over-samples: the 18h half-life decay means the map barely
--     changes in 5 minutes except for the newest level. You pay 3x invocations
--     for information the decay discards.
--   - 15 minutes catches 97.6% of zones within one interval. The 2.4% that
--     take longer to qualify are levels with very little early evidence —
--     exactly the ones that should wait for a second touch anyway.
--
-- INCREMENTAL FETCH: at 15-minute intervals only ~15 new bars are needed
-- plus the existing zone state, roughly 99% less data per run. The current
-- function does a full recompute (~4,187 bars). An incremental optimization
-- is a separate item — this migration changes the SCHEDULE only.
--
-- INVOCATION COST: 96 runs/day vs the current 6. The project already runs
-- drain-telegram-outbox every minute (1,440 invocations/day), so 96 is well
-- within existing practice. The Supabase plan's invocation headroom should be
-- monitored — the dashboard has shown EXCEEDING USAGE LIMITS before.

-- Unschedule the old 4-hour cron if it exists
SELECT cron.unschedule('refresh-sr-zones') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'refresh-sr-zones'
);

-- Schedule the new 15-minute cron
SELECT cron.schedule(
  'refresh-sr-zones',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://tcbnqmnzsnjhqkyuhrch.supabase.co/functions/v1/refresh-sr-zones',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- ── ITEM 136(g): ZONE-AGE TELEMETRY ──────────────────────────────────────
-- Every emitted signal now records how old the zone map was at emission time.
-- This must never again be invisible.

ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS zone_map_age_minutes INTEGER;

COMMENT ON COLUMN public.emitted_signals_v1.zone_map_age_minutes IS
  'ITEM 136(g): minutes between the zone map''s last successful fetch and signal emission. NULL if TIER_0 was not used (TIER_1_LOCAL fallback).';

-- ── ITEM 139(c): ATR RANGE ASSERTION ─────────────────────────────────────
-- The backfill atr column holds values from 0.20 to 124.20. Bar-derived ATR(14)
-- on 1-min gold ranges 0.4–12.4 (p50=1.72). An ATR of 124 is not a market value.
-- This CHECK constraint prevents implausible values from being written again.
-- The range [0, 20] covers the bar-derived max (12.4) with margin for higher
-- volatility regimes, while rejecting the backfill artefacts (max=124.20).

ALTER TABLE public.emitted_signals_v1
  DROP CONSTRAINT IF EXISTS emitted_signals_atr_range_check;

ALTER TABLE public.emitted_signals_v1
  ADD CONSTRAINT emitted_signals_atr_range_check
  CHECK (atr IS NULL OR (atr >= 0 AND atr <= 20));
