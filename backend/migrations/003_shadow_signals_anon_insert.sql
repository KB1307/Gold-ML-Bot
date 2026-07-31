-- Design B: allow anon/authenticated INSERT on shadow_signals_v1 so the
-- live engine's pushShadowSellRecord can write directly via the anon key,
-- without depending on the backend tRPC server (confirmed 503 on all routes).
--
-- Abuse surface: a malicious client could insert junk rows. This is acceptable
-- because shadow_signals_v1 is a DIAGNOSTIC-ONLY table with zero operational
-- impact on signal generation or trade execution. Anon has SELECT + INSERT
-- only (no UPDATE/DELETE), so junk cannot modify existing data. The engine's
-- signal_id format (shadow-sell-<timestamp>-<random>) is recognizable, so
-- future analysis can filter by it.

-- Replace the blocking INSERT policy with an allowing one.
DROP POLICY IF EXISTS "shadow_signals_no_insert_public" ON public.shadow_signals_v1;

CREATE POLICY IF NOT EXISTS "shadow_signals_insert_anon" ON public.shadow_signals_v1
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- Enforce direction = 'SELL' (the only valid shadow record type).
ALTER TABLE public.shadow_signals_v1
  DROP CONSTRAINT IF EXISTS shadow_signals_direction_check;
ALTER TABLE public.shadow_signals_v1
  ADD CONSTRAINT shadow_signals_direction_check CHECK (direction = 'SELL');
