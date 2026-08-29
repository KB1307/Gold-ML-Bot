-- ITEM Y — REGIME-MAPPED EXIT GEOMETRY — FORWARD ANNOTATIONS for emitted_signals_v1.
-- Pattern: migration 019. Write-only at emission from gold_m1_bars ONLY (never
-- priceHistory / Yahoo GC=F / TwelveData); NULL when bars are insufficient
-- (never a default); byte-identical emissions. Read by NOTHING in the
-- gating/scoring path — the exit-geometry layer is annotation-only with zero
-- live impact. The canonical instrument is services/barIndicators
-- (aggregateBars / sealBarSeries / barADX / barATR): regime = ADX(14,M5) at
-- emission, computed ONLY from M5 bars whose close time is strictly before the
-- emission timestamp (no look-ahead). Map (verbatim): TREND (ADX > 25)
-- SL = 3.5 x ATR(14,M5); MID (20..25) SL = $8.00; RANGE (< 20) SL = 2.5 x
-- ATR(14,M5); TP = 4.0 x SL-distance.
--
-- PRE-REGISTERED PROMOTION GATE (verbatim): a live exit change may be proposed
-- only when forward paired n >= 60 decided AND the chosen arm's paired-difference
-- 95% CI lower bound > 0. Until then it is observation only. Forward paired rows
-- are appended to shadow_candidates_v1 with candidate_name = 'EXIT_SHADOW_LADDER'
-- (STRICT equality filter in every query — keeps the exit gate isolated from the
-- P.3 abort counter, which counts ONLY candidate_name = 'BAND_VETO_SUPPRESSED').
--
-- NOTE: no policies are created here (emitted_signals_v1 already has its write
-- path). Migration 020 lesson applied: CREATE POLICY does not accept
-- IF NOT EXISTS, and no shell-escape sequences appear in any SQL literal.
ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS regime_at_emission text NULL,
  ADD COLUMN IF NOT EXISTS mapped_sl numeric NULL,
  ADD COLUMN IF NOT EXISTS mapped_tp numeric NULL;

COMMENT ON COLUMN public.emitted_signals_v1.regime_at_emission IS
  'ITEM Y (annotation-only): exit-geometry regime at emission from the ADX(14,M5) map — TREND (ADX > 25) / MID (20..25) / RANGE (< 20). Computed from gold_m1_bars ONLY, M5 bars whose close time is strictly before emission (no look-ahead). NULL when bars are insufficient. Forward labels only — never a live filter; read by NOTHING in gating/scoring.';

COMMENT ON COLUMN public.emitted_signals_v1.mapped_sl IS
  'ITEM Y (annotation-only): mapped stop-loss DISTANCE in price units from the regime map (TREND 3.5 x ATR(14,M5) / MID 8.00 / RANGE 2.5 x ATR(14,M5)). Paired forward rows accrue toward the pre-registered promotion gate: a live exit change may be proposed only at forward paired n >= 60 decided AND paired-difference 95% CI lower bound > 0. Observation only until then.';

COMMENT ON COLUMN public.emitted_signals_v1.mapped_tp IS
  'ITEM Y (annotation-only): mapped take-profit DISTANCE in price units = 4.0 x mapped_sl (single-TP mapped geometry, verbatim from the Y.1 canonical re-derivation). NULL when bars are insufficient. Forward labels only — never a live filter.';
