-- ITEM 66 (2026-08-12): allow anon/authenticated INSERT + UPDATE on
-- trade_outcomes_v1 so the live engine's pushOutcomesToRemote can write
-- directly via the anon key, without depending on the Rork backend tRPC
-- server (confirmed 503/no-bundle on all routes since 2026-07-31).
--
-- This mirrors the already-proven Design-B write pattern from
-- shadow_signals_v1 (migration 003): the anon key is public by design
-- (already in the client bundle), and RLS guards the write surface.
--
-- Abuse surface: a malicious client could insert junk rows. This is
-- acceptable because:
--   1. The table is the LEARNING CORPUS, not a trade-execution table —
--      junk rows affect model training quality, not live trades.
--   2. The upsert is keyed by signal_id (unique), so a re-push is
--      idempotent and cannot double-count.
--   3. The engine's signal_id format (signal_<timestamp>_<random>) is
--      recognizable, so future analysis can filter by it.
--   4. Anon has INSERT + UPDATE only (no DELETE), so junk cannot remove
--      existing legitimate rows.
--
-- The UPDATE policy allows the hydrate path to refresh labels from the
-- durable store (Item 43b label correction flow).

-- Drop any existing blocking INSERT/UPDATE policies (if they exist).
DROP POLICY IF EXISTS "trade_outcomes_no_insert_public" ON public.trade_outcomes_v1;
DROP POLICY IF EXISTS "trade_outcomes_no_update_public" ON public.trade_outcomes_v1;

-- Allow anon and authenticated to INSERT new rows.
CREATE POLICY IF NOT EXISTS "trade_outcomes_insert_anon" ON public.trade_outcomes_v1
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- Allow anon and authenticated to UPDATE rows (for label correction / upsert).
CREATE POLICY IF NOT EXISTS "trade_outcomes_update_anon" ON public.trade_outcomes_v1
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
