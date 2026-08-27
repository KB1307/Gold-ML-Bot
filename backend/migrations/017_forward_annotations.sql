-- ITEM I + E.2 (shadow) — FORWARD ANNOTATIONS for emitted_signals_v1.
-- Pattern: migration 015. Write-only at emission from gold_m1_bars + the signal's OWN
-- snapshot; NULL when lookback is unavailable (never a default); byte-identical
-- emissions. Read by NOTHING in the gating/scoring path until a pre-registered
-- forward gate passes.
ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS chase_position numeric NULL,
  ADD COLUMN IF NOT EXISTS opposing_zone_fraction numeric NULL,
  ADD COLUMN IF NOT EXISTS pre_signal_drift numeric NULL,
  ADD COLUMN IF NOT EXISTS band_veto_would_fire boolean NULL,
  ADD COLUMN IF NOT EXISTS band_veto_zone_price numeric NULL;

COMMENT ON COLUMN public.emitted_signals_v1.chase_position IS
  'ITEM I: entry position in the running intraday range, 0=at low 1=at high; NULL if range < $3. Forward labels for the at-extreme class.';
COMMENT ON COLUMN public.emitted_signals_v1.opposing_zone_fraction IS
  'ITEM I: fraction of the signal''s own snapshot zones opposing the trade direction. Forward labels.';
COMMENT ON COLUMN public.emitted_signals_v1.pre_signal_drift IS
  'ITEM I: the pre-signal drift $ figure (close-vs-close, prior-4h window, gold_m1_bars only) already shown in telemetry — persisted at emission.';
COMMENT ON COLUMN public.emitted_signals_v1.band_veto_would_fire IS
  'E.2 SHADOW (gate FAILED 2026-08-27, nothing shipped live): would the pre-registered band-proximity veto (touches>=10, rs>=0.5, band [entry-1, entry+TP1dist] mirrored) fire on this signal''s own snapshot? Observation only.';
