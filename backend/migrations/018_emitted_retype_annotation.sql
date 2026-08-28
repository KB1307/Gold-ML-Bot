-- ITEM Q — SIDE-AWARE RETYPE: DUAL-ANNOTATION FORWARD (observation only; NO live
-- change). Pattern of 017. The column records, AT EMISSION, whether the E.1
-- band-veto verdict computed with 48h side-aware roles (reference method exactly
-- as item238: w=0.8, 15-bar first-exit, last-5 double weight, 48h window,
-- gold_m1_bars strictly before emission) differs from the verdict computed with
-- stored types. NULL when bars are insufficient — never defaulted.
--
-- PRE-REGISTERED PROMOTION GATE (verbatim contract): the retype may be proposed
-- live only when forward decided signals with retype_verdict_would_change=true
-- reach n>=80 AND that cohort's canonical EV_net 95% CI upper bound < 0. Until
-- then it is an observation.

ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS retype_verdict_would_change boolean NULL;

COMMENT ON COLUMN public.emitted_signals_v1.retype_verdict_would_change IS
  'ITEM Q (write-only, observation): true when the E.1 veto verdict with 48h side-aware roles differs from the stored-type verdict (G.3 method); NULL when bars insufficient. Promotion gate: n>=80 forward decided true-rows AND cohort EV_net 95% CI upper < 0 — until then never proposed live.';
