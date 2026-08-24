-- ITEM 210: entry-backing annotation — nearest opposing zone BEHIND the entry.
-- ITEM 213: driving-zone touch count — touches of the nearest opposing zone AHEAD.
-- Both are computed purely from the per-signal sr_zones_snapshot and stored on the
-- emitted row so forward measurement can reconstruct geometry without engine state.

ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS nearest_opp_zone_behind_entry_price NUMERIC;

ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS nearest_opp_zone_behind_entry_type TEXT;

ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS nearest_opp_zone_behind_entry_dist_atr NUMERIC;

ALTER TABLE public.emitted_signals_v1
  ADD COLUMN IF NOT EXISTS driving_zone_touches INTEGER;

COMMENT ON COLUMN public.emitted_signals_v1.nearest_opp_zone_behind_entry_price IS
  'ITEM 210: price of the nearest opposing zone behind the signal entry (BUY: resistance below entry; SELL: support above entry). NULL when none exists.';

COMMENT ON COLUMN public.emitted_signals_v1.nearest_opp_zone_behind_entry_type IS
  'ITEM 210: type of the nearest opposing zone behind the signal entry (SUPPORT or RESISTANCE). NULL when none exists.';

COMMENT ON COLUMN public.emitted_signals_v1.nearest_opp_zone_behind_entry_dist_atr IS
  'ITEM 210: distance from entry to nearest_opp_zone_behind_entry_price in ATR units. NULL when none exists.';

COMMENT ON COLUMN public.emitted_signals_v1.driving_zone_touches IS
  'ITEM 213: touch count of the nearest opposing zone AHEAD of the entry (the zone used by the path-to-target veto). NULL when none exists.';
