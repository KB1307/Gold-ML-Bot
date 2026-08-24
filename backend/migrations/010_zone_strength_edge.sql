-- ITEM 212: merged-cluster STRENGTH and ENTRY-EDGE prices.
-- The merge logic must keep BOTH the weighted centroid (price) and the
-- strongest-member price (strength_price), plus the outermost cluster member in
-- the zone-type risk direction (entry_edge_price).  These are needed for forward
-- measurement of the entry-backing gate (Item 212(f)) and are carried on every
-- zone row written by the server-side refresh.

ALTER TABLE public.sr_zones_v1
  ADD COLUMN IF NOT EXISTS strength_price NUMERIC;

ALTER TABLE public.sr_zones_v1
  ADD COLUMN IF NOT EXISTS entry_edge_price NUMERIC;

COMMENT ON COLUMN public.sr_zones_v1.strength_price IS
  'ITEM 212: price of the strongest member in the merged cluster (not the weighted centroid). Used for reaction-strength scoring and gating.';

COMMENT ON COLUMN public.sr_zones_v1.entry_edge_price IS
  'ITEM 212: outermost merged cluster member in the risk direction of the zone type. SUPPORT -> lowest price; RESISTANCE -> highest price. Used for entry-backing geometry checks.';
