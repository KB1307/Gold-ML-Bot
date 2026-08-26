-- ITEM C / CHECKPOINT C — SHADOW-MODE CANDIDATE HARNESS TABLE.
--
-- Shadow candidates are recorded WITHOUT emitting anything to users, Telegram or
-- live signal history. They resolve through the SAME canonical path
-- (resolveSignalWithBars fromScratch + lib/evCompute computeRNet) so their book is
-- comparable to the live book. Exactly ONE resolution instrument exists.
--
-- PRE-REGISTERED PROMOTION GATE (verbatim contract — all four conditions, no
-- exceptions, no partial promotion, no "directionally encouraging" promotion):
--   A shadow candidate may be proposed for live emission ONLY when, on FORWARD
--   shadow sample only: n>=100 AND EV_net 95% CI lower bound > 0 AND positive in
--   at least 4 of 6 consecutive calendar weeks AND its EV_net exceeds a
--   same-period random-direction null computed on the same timestamps.

CREATE TABLE IF NOT EXISTS public.shadow_candidates_v1 (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  candidate_name text NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  direction text NULL,
  entry numeric(12, 2) NULL,
  sl numeric(12, 2) NULL,
  tp1 numeric(12, 2) NULL,
  tp2 numeric(12, 2) NULL,
  tp3 numeric(12, 2) NULL,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.shadow_candidates_v1 ENABLE ROW LEVEL SECURITY;

CREATE POLICY shadow_candidates_anon_select ON public.shadow_candidates_v1
  FOR SELECT TO anon USING (true);

COMMENT ON TABLE public.shadow_candidates_v1 IS
  'ITEM C shadow-mode candidate decisions. Never user-facing. Promotion to live emission requires the four-part pre-registered gate recorded in the table comment history of services/shadowCandidates.ts.';
