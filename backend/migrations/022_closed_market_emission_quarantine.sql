-- 022 — WW: QUARANTINE closed-market emissions (containment failure, 2026-08-29/30 weekend)
--
-- ADD-ONLY; NOTHING DESTRUCTIVE; NO ROWS ARE DELETED. Flagged rows are excluded
-- from canonical populations by the measurement scripts (WW.3: every item2xx
-- script + canonicalBook.ts filter on this column) but are RETAINED here
-- permanently as the audit trail of the containment failure.
--
-- The window predicate mirrors the shipped shared predicate
-- (expo/services/signalEngine.ts getGoldMarketClock — the UU.2 single source):
--   - Saturday, all day                    (getUTCDay 6)
--   - Friday 21:00-23:59 UTC               (getUTCDay 5, hour >= 21)
--   - Sunday 00:00-21:59 UTC               (getUTCDay 0, hour < 22)
--   - Daily close break 20:59-21:59 UTC    (inclusive endpoints, every day)
-- Postgres EXTRACT(DOW) uses the same 0=Sunday..6=Saturday mapping as
-- getUTCDay. Emitted before 022 was applied carry NULL — they are treated as
-- NOT flagged (the exclusion predicate is "IS NOT TRUE").
--
-- Scan evidence at hand-off (scripts/ww_closed_market_scan.ts, read-only, real
-- getGoldMarketClock over all 488 rows): 0 rows fall in a closed window. The
-- newest emission (id 903) is 2026-08-28T20:00:13.766Z — 59m47s BEFORE the
-- Friday 21:00 UTC close, an open-market row. The UPDATE below therefore
-- matches 0 rows TODAY; it ships so any future closed-market row is flaggable
-- and excludable by the same predicate.

ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS closed_market_emission boolean NULL;

COMMENT ON COLUMN public.emitted_signals_v1.closed_market_emission IS
  'WW (2026-08-30): TRUE when emitted_at falls inside a closed XAU/USD window per the shared getGoldMarketClock predicate (Saturday; Friday>=21:00Z; Sunday<22:00Z; 20:59-21:59Z daily break). Quarantine flag — excluded from canonical populations, NEVER deleted.';

UPDATE public.emitted_signals_v1
SET closed_market_emission = TRUE
WHERE closed_market_emission IS NOT TRUE
  AND (
       EXTRACT(DOW FROM emitted_at AT TIME ZONE 'UTC') = 6
    OR (EXTRACT(DOW FROM emitted_at AT TIME ZONE 'UTC') = 5 AND EXTRACT(HOUR FROM emitted_at AT TIME ZONE 'UTC') >= 21)
    OR (EXTRACT(DOW FROM emitted_at AT TIME ZONE 'UTC') = 0 AND EXTRACT(HOUR FROM emitted_at AT TIME ZONE 'UTC') < 22)
    OR (EXTRACT(HOUR FROM emitted_at AT TIME ZONE 'UTC') = 20 AND EXTRACT(MINUTE FROM emitted_at AT TIME ZONE 'UTC') >= 59)
    OR  EXTRACT(HOUR FROM emitted_at AT TIME ZONE 'UTC') = 21
  );
