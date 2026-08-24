-- ITEM 191 / PHASE A-A3 — DIRECTED TYPING EVIDENCE ON THE SERVER (flag stays OFF).
--
-- The server refresh types every zone by bare spot comparison
-- (isResistance = cluster.price > currentPrice), and the client snapshot writes
-- `legacyType ?? type` — identical for every TIER_0 zone. Item 191's flip
-- criterion (EV split between legacy and directed typing on the changed set)
-- is therefore UNMEASURABLE on the primary zone source. This migration adds
-- the evidence columns the client has been accumulating on TIER_1 since Item
-- 191, so TIER_0 rows carry the same forward evidence.
--
-- WHAT THIS DOES NOT CHANGE: the `type` column, reaction_strength, cluster
-- merging, or any gating. REJECTION_DIRECTED_ZONES_ENABLED stays false; the
-- server writes the counts and the legacy type but does not retype anything.
-- The directed counts are computed over the server's 24h bar window, while the
-- client counts over ~100 in-memory M1 samples — the label difference is
-- stated here so the two instruments are never silently mixed.

ALTER TABLE public.sr_zones_v1
  ADD COLUMN IF NOT EXISTS legacy_type TEXT;

ALTER TABLE public.sr_zones_v1
  ADD COLUMN IF NOT EXISTS rejections_from_below INTEGER;

ALTER TABLE public.sr_zones_v1
  ADD COLUMN IF NOT EXISTS rejections_from_above INTEGER;

COMMENT ON COLUMN public.sr_zones_v1.legacy_type IS
  'ITEM 191 (Phase A/A3): spot-relative typing the zone carried before directed typing (cluster.price > currentPrice => RESISTANCE). The shipped type column equals this while REJECTION_DIRECTED_ZONES_ENABLED is off; both are stored so the changed-set can be measured forward.';

COMMENT ON COLUMN public.sr_zones_v1.rejections_from_below IS
  'ITEM 191 (Phase A/A3): approaches from below probed into the zone band and were rejected back down (resistance behaviour), counted by the server refresh over the 24h bar window. Evidence only — does not retype the zone while the flag is off.';

COMMENT ON COLUMN public.sr_zones_v1.rejections_from_above IS
  'ITEM 191 (Phase A/A3): approaches from above probed into the zone band and were rejected back up (support behaviour), counted by the server refresh over the 24h bar window. Evidence only — does not retype the zone while the flag is off.';
