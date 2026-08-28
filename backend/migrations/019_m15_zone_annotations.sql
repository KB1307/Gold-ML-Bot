-- ITEM V — M15 STRUCTURAL ZONE LAYER — FORWARD ANNOTATIONS for emitted_signals_v1.
-- Pattern: migration 017. Write-only at emission from gold_m1_bars ONLY (never
-- priceHistory / Yahoo GC=F / TwelveData); NULL when bars are insufficient
-- (never a default); byte-identical emissions. Read by NOTHING in the
-- gating/scoring path — the layer is annotation-only with zero live impact.
-- The M15 builder (expo/services/m15ZoneLayer.ts) is the canonical instrument;
-- events are usable only after their 4-bar confirmation window.
ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS m15_opposed boolean NULL,
  ADD COLUMN IF NOT EXISTS m15_endorsed boolean NULL,
  ADD COLUMN IF NOT EXISTS m15_zone_context jsonb NULL;

COMMENT ON COLUMN public.emitted_signals_v1.m15_opposed IS
  'ITEM V (annotation-only): an opposing-role M15 structural zone (user-designed layer: M15, ~14 trading days, strong-rejection events >= 2.0 x ATR(14,M15) within 4 bars, $2 bands, >= 2 rejections, side-typed at birth) sits in the TP1 path (same geometry as the band veto). NULL when bars insufficient. Forward labels only — never a live filter.';
COMMENT ON COLUMN public.emitted_signals_v1.m15_endorsed IS
  'ITEM V (annotation-only): an agreeing-role M15 structural zone within $3 of the entry. The layer measured -0.1808R on endorsement offline — awareness/veto value ONLY; must never feed buy-side scoring or confidence.';
COMMENT ON COLUMN public.emitted_signals_v1.m15_zone_context IS
  'ITEM V (annotation-only): the qualifying M15 zones actually consulted at emission — {opposed: [{price,n,rb,ra,role}], endorsed: [...]} from the signal''s own lookback window.';
