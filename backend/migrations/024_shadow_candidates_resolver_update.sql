-- ITEM DA — THE SHADOW RESOLVER write-back (shadow_candidates_v1 anon UPDATE)
--
-- The shadow resolver (expo/services/shadowResolver.ts) runs in-app on the
-- anon key and writes resolution fields into the `inputs` jsonb of unresolved
-- rows: mfe, mae, barsHeld, resolvedOutcome, resolvedPnlPrice, resolvedAt —
-- always as a jsonb merge that preserves every existing key. Migrations
-- 016/020 granted anon SELECT and INSERT only, so WITHOUT this policy
-- PostgREST RLS silently no-ops every UPDATE (matches 0 rows, no error) and
-- no shadow book can ever close. The resolver detects that no-op
-- (writeInputsMerged's .select("id") read-back) and counts it as an error.
--
-- Column-narrowed: table-level UPDATE is revoked and re-granted for the
-- `inputs` column ONLY, so even a buggy resolver cannot touch candidate_name,
-- entry, sl, tp1..tp3 or evaluated_at.

REVOKE UPDATE ON TABLE public.shadow_candidates_v1 FROM anon;
GRANT UPDATE (inputs) ON TABLE public.shadow_candidates_v1 TO anon;

CREATE POLICY shadow_candidates_resolver_update_anon
  ON public.shadow_candidates_v1
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (true);

COMMENT ON POLICY shadow_candidates_resolver_update_anon ON public.shadow_candidates_v1 IS
  'ITEM DA: write-back of resolution fields (mfe/mae/barsHeld/resolvedOutcome/resolvedPnlPrice/resolvedAt + skip notes) into inputs by the scheduled shadow resolver. Column grant limits updates to the inputs jsonb only.';
