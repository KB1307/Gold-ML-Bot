-- 023 — D8 (72h review, 2026-09-05): STOP THE APP FROM CLOBBERING BACKFILLED feat_* KEYS
--
-- ADD-ONLY; NOTHING DESTRUCTIVE; NO ROWS ARE DELETED OR RELABELLED.
--
-- Finding: expo/services/learningStore.ts toRemoteRow() writes
--   features: outcome.features ?? {}
-- on EVERY upsert of trade_outcomes_v1 (retry queue / re-sync of the outcomes
-- the app still holds locally). The whole `features` jsonb is replaced by the
-- app's local copy, which for pre-Item-AB emissions (and old-bundle sessions)
-- carries NO feat_* keys. Measured 2026-09-05: 5 labelled rows (all LOSS,
-- 2026-08-31 .. 2026-09-03 — exactly the rows still inside the app's local
-- outcome window) had all seven feat_* keys reverted to null AFTER the Item AB
-- backfill wrote 496/496. The logistic fit dropped them as NaN
-- (rowsUsed 122 -> 117). Older rows, no longer local, survived.
--
-- Fix (server-authoritative, so old bundles cannot bypass it): a BEFORE UPDATE
-- trigger that, for each of the seven side-relative keys, KEEPS the existing
-- value when the incoming row lacks the key or carries JSON null. Incoming
-- non-null values ALWAYS win (a new-bundle emission-time value is authoritative
-- over a backfill). Every other key in `features` and every other column are
-- written exactly as before — this trigger can touch nothing but those seven
-- keys, and only in the "incoming is null" direction.
--
-- Scope: UPDATE only. INSERTs have no OLD row; the backfill script's own writes
-- are UPDATEs carrying non-null values, so they pass through unchanged.

CREATE OR REPLACE FUNCTION public.trade_outcomes_v1_preserve_backfilled_features()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  k text;
  keys constant text[] := ARRAY[
    'feat_trend_aligned',
    'feat_rsi_aligned',
    'feat_ema_stack',
    'feat_session_level_count',
    'feat_at_day_extreme',
    'feat_zone_max_react',
    'feat_near_round50'
  ];
BEGIN
  IF OLD.features IS NULL OR jsonb_typeof(OLD.features) <> 'object' THEN
    RETURN NEW;
  END IF;
  IF NEW.features IS NULL OR jsonb_typeof(NEW.features) <> 'object' THEN
    NEW.features := '{}'::jsonb;
  END IF;
  FOREACH k IN ARRAY keys LOOP
    IF (NEW.features -> k) IS NULL OR jsonb_typeof(NEW.features -> k) = 'null' THEN
      IF (OLD.features -> k) IS NOT NULL AND jsonb_typeof(OLD.features -> k) <> 'null' THEN
        NEW.features := jsonb_set(NEW.features, ARRAY[k], OLD.features -> k, true);
      END IF;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trade_outcomes_v1_preserve_backfilled_features ON public.trade_outcomes_v1;

CREATE TRIGGER trade_outcomes_v1_preserve_backfilled_features
  BEFORE UPDATE ON public.trade_outcomes_v1
  FOR EACH ROW
  EXECUTE FUNCTION public.trade_outcomes_v1_preserve_backfilled_features();

COMMENT ON FUNCTION public.trade_outcomes_v1_preserve_backfilled_features() IS
  'D8 (2026-09-05): on UPDATE, keeps the seven backfilled feat_* keys in features when the incoming row lacks them or sends null; incoming non-null always wins. Nothing else is touched.';

-- Post-apply verification (read-only):
--   SELECT tgname, tgenabled FROM pg_trigger
--    WHERE tgrelid = 'public.trade_outcomes_v1'::regclass
--      AND tgname = 'trade_outcomes_v1_preserve_backfilled_features';
-- Then re-run: bun expo/scripts/backfill_side_relative_features.ts
--   (expect exactly 5 rows updated, the ones listed in
--    expo/artifacts/checkpoint_ml_correction_ae_aj.txt ADDENDUM 2026-09-05)
-- and: bun expo/scripts/ml_upgrade_acceptance.ts ac  (expect rowsUsed=122 excludedNaN=0).
