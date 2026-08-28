-- ITEM P — BAND-PROXIMITY VETO: allow anon INSERT on shadow_candidates_v1 so the
-- live engine's veto can write suppressed candidates (candidate_name =
-- 'BAND_VETO_SUPPRESSED') directly via the anon key, without depending on the
-- backend tRPC server (pattern of 003_shadow_signals_anon_insert.sql).
--
-- Abuse surface: a malicious client could insert junk rows. Acceptable because
-- shadow_candidates_v1 is a DIAGNOSTIC-ONLY table with zero operational impact
-- on signal generation or trade execution. Anon gets SELECT + INSERT only (no
-- UPDATE/DELETE), so junk cannot modify existing data.

CREATE POLICY IF NOT EXISTS "shadow_candidates_insert_anon" ON public.shadow_candidates_v1
  FOR INSERT TO anon, authenticated WITH CHECK (true);

COMMENT ON POLICY "shadow_candidates_insert_anon" ON public.shadow_candidates_v1 IS
  'ITEM P: the engine writes BAND_VETO_SUPPRESSED rows (never emitted, never Telegram'"'"'d) for the pre-registered P.3 abort gate (EV_net > 0 at forward n=30 decided suppressed -> flag false next round).';
