-- ITEM A.2 / CHECKPOINT A.2 — FADE ANNOTATION COLUMNS ON emitted_signals_v1.
--
-- WRITE-ONLY OBSERVATION INSTRUMENTATION. NOTHING READS THESE COLUMNS for gating,
-- scoring, veto, reroute or confidence adjustment this round; the engine's behaviour
-- must stay byte-identical. Fields are computed at generation time from gold_m1_bars
-- ONLY (never priceHistory/Yahoo/TwelveData for direction or label) and set to NULL
-- whenever the required lookback is unavailable — never defaulted (ATR two-constructs
-- defect class).
--
-- PRE-REGISTERED FORWARD GATE (do not drift): the fade condition may be proposed as
-- a LIVE FILTER only when, on signals emitted AFTER this instrumentation ships,
-- the FADE cohort reaches n >= 50 AND its EV_net 95% CI upper bound sits below the
-- WITH cohort's EV_net point estimate. Until then it is an observation, not a lever.

ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS agrees_with_prior_4h_move boolean NULL,
  ADD COLUMN IF NOT EXISTS prior_4h_move_delta numeric(10, 2) NULL;

COMMENT ON COLUMN public.emitted_signals_v1.agrees_with_prior_4h_move IS
  'ITEM A.2 shadow annotation: true when the signal direction agreed with the prior 4h M1 price move (gold_m1_bars only); NULL when lookback unavailable. Write-only this round.';
