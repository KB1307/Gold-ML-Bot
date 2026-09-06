-- 023a — HOTFIX (2026-09-05): the trigger as applied on Supabase NULLs `features`
-- on EVERY UPDATE of trade_outcomes_v1 (verified empirically: identical-features
-- PATCH and features-free PATCH on BOTH a healthy row and a clobbered row all
-- return 23502 "null value in column \"features\"").
--
-- LOCAL REPLICA VERDICT (pglite 0.5.8, real Postgres/plpgsql, 2026-09-05): BOTH
-- bodies — the user's 023 as pasted in chat AND the verified 023a body — pass all
-- four probes (identical-features UPDATE, features-free UPDATE, features='{}',
-- repair-style PATCH) with features never NULL. NEITHER SOURCE can produce 23502.
-- Therefore the function stored in Supabase is NOT the source pasted, or another
-- trigger/rule object exists on the table. Block A below settles which.
--
-- This script, in order:
--   A. DIAGNOSTICS — dump BOTH function-name sources + ALL triggers on the table
--      (paste back).
--   B. FIX — drop BOTH trigger names (user's trg_preserve_backfilled_features and
--      023's trade_outcomes_v1_preserve_backfilled_features) and BOTH functions,
--      then install ONE verified body (+ final paranoia guard so features can
--      NEVER end UPDATE as NULL) with ONE trigger.
--   C. SELF-TEST — inside BEGIN…ROLLBACK (nothing persists): T1 preserve-on-null,
--      T2 incoming-wins, T3 unrelated keys pass through. If any T fails, run the
--      EMERGENCY block at the bottom to restore write service, and paste the
--      DIAGNOSTICS output back.

-- ── A. DIAGNOSTICS ─────────────────────────────────────────────────────────
SELECT proname, prosrc AS live_function_source
FROM pg_proc
WHERE proname IN ('trade_outcomes_v1_preserve_backfilled_features', 'preserve_backfilled_features');

SELECT tgname, pg_get_triggerdef(oid) AS trigger_definition
FROM pg_trigger
WHERE tgrelid = 'public.trade_outcomes_v1'::regclass
  AND NOT tgisinternal;

-- ── B. FIX ─────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trade_outcomes_v1_preserve_backfilled_features ON public.trade_outcomes_v1;
DROP TRIGGER IF EXISTS trg_preserve_backfilled_features ON public.trade_outcomes_v1;
DROP FUNCTION IF EXISTS public.trade_outcomes_v1_preserve_backfilled_features();
DROP FUNCTION IF EXISTS public.preserve_backfilled_features();

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
  -- Paranoia guard (023a): no code path above may leave features NULL.
  IF NEW.features IS NULL THEN
    NEW.features := '{}'::jsonb;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trade_outcomes_v1_preserve_backfilled_features
  BEFORE UPDATE ON public.trade_outcomes_v1
  FOR EACH ROW
  EXECUTE FUNCTION public.trade_outcomes_v1_preserve_backfilled_features();

-- ── C. SELF-TEST (fully rolled back — writes nothing) ──────────────────────
BEGIN;
DO $$
DECLARE
  sid text;
  f jsonb;
BEGIN
  SELECT signal_id INTO sid
  FROM public.trade_outcomes_v1
  WHERE features ->> 'feat_trend_aligned' IS NOT NULL
  ORDER BY ts DESC
  LIMIT 1;

  -- T1: incoming features='{}' → the 7 backfilled keys are restored from OLD.
  UPDATE public.trade_outcomes_v1 SET features = '{}'::jsonb
  WHERE signal_id = sid
  RETURNING features INTO f;
  IF NOT (f ? 'feat_trend_aligned' AND f ? 'feat_session_level_count' AND f ? 'feat_near_round50') THEN
    RAISE EXCEPTION 'T1 FAILED — feat_* keys not restored from OLD: %', f;
  END IF;

  -- T2: incoming NON-NULL always wins.
  UPDATE public.trade_outcomes_v1
  SET features = jsonb_set(f, ARRAY['feat_trend_aligned'], '9'::jsonb)
  WHERE signal_id = sid
  RETURNING features INTO f;
  IF COALESCE((f ->> 'feat_trend_aligned')::numeric, -1) <> 9 THEN
    RAISE EXCEPTION 'T2 FAILED — incoming value was clobbered: %', f;
  END IF;

  -- T3: unrelated keys pass through untouched.
  UPDATE public.trade_outcomes_v1
  SET features = f || '{"probe_023a_t3": 1}'::jsonb
  WHERE signal_id = sid
  RETURNING features INTO f;
  IF (f ->> 'probe_023a_t3') IS NULL THEN
    RAISE EXCEPTION 'T3 FAILED — unrelated key was dropped: %', f;
  END IF;

  RAISE NOTICE 'SELF-TEST 023a: 3/3 PASS on %', sid;
END $$;
ROLLBACK;

-- ── EMERGENCY (run ONLY if a self-test T above failed) ─────────────────────
-- DROP TRIGGER IF EXISTS trade_outcomes_v1_preserve_backfilled_features ON public.trade_outcomes_v1;
-- DROP TRIGGER IF EXISTS trg_preserve_backfilled_features ON public.trade_outcomes_v1;
-- (then paste the DIAGNOSTICS output from block A back to me)
