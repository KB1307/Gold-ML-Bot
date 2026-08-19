-- ITEM 158 — CLOSE THE 6-HOUR BLIND SPOT.
--
-- FACT (measured 2026-08-19): net._http_response retains ~6 HOURS, not 24. A
-- non200_count over a 24h window is structurally incapable of seeing a failure
-- that ran and stopped more than ~6h ago. pipeline_health_v1 retains 7 days and
-- runs every 15 min, so the history table IS the long-term record — it just had
-- no rollup. This migration adds one.
--
-- 158(a) get_pipeline_health_rollup(): over the last 7 days of pipeline_health_v1:
--   worst status, DEGRADED/DOWN check counts, max zone_lag_minutes, distinct
--   failure bodies, plus the check count and first/last check times. ONE query
--   answers "has this pipeline been unhealthy at any point this week".
-- 158(b) retention_warning: when the newest row's detail.http_response_oldest is
--   NEWER than (checked_at - window_hours), the non200 window is truncated by
--   retention and older failures are invisible — flagged explicitly instead of
--   reporting two numbers that silently contradict.
--
-- This migration does NOT replace get_pipeline_health (v2, applied 2026-08-19;
-- its source lives in the SQL Editor history, not this repo). It only ADDS the
-- rollup function. RLS posture: SECURITY DEFINER revoked from PUBLIC/anon/
-- authenticated — it is callable only from the SQL Editor / postgres role
-- (migration 002 posture). Clients read pipeline_health_v1 directly and compute
-- the same rollup in the app (usePipelineHealth), so no anon EXECUTE is needed.

create or replace function public.get_pipeline_health_rollup(p_days int default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_rows int;
  v_worst text;
  v_degraded int;
  v_down int;
  v_max_zone_lag double precision;
  v_first timestamptz;
  v_last timestamptz;
  v_bodies jsonb;
  v_retention_warning bool := false;
  v_retention_detail jsonb;
  v_window_hours int;
begin
  select count(*),
         min(checked_at),
         max(checked_at),
         count(*) filter (where status = 'DEGRADED'),
         count(*) filter (where status = 'DOWN'),
         max(nullif(detail->>'zone_lag_minutes', '')::double precision)
  into v_rows, v_first, v_last, v_degraded, v_down, v_max_zone_lag
  from public.pipeline_health_v1
  where checked_at > now() - make_interval(days => greatest(coalesce(p_days, 7), 1));

  if v_rows = 0 then
    return jsonb_build_object('days', p_days, 'checks', 0,
      'answer', 'NO DATA — the health checker has never run or history was pruned');
  end if;

  select case
           when v_down > 0 then 'DOWN'
           when v_degraded > 0 then 'DEGRADED'
           else 'HEALTHY'
         end
  into v_worst;

  -- Distinct failure bodies seen in the window (deduped by body text).
  select coalesce(jsonb_agg(distinct body), '[]'::jsonb)
  into v_bodies
  from (
    select distinct left(f->>'response_body', 200) as body
    from public.pipeline_health_v1 r,
         jsonb_array_elements(r.failures) f
    where r.checked_at > now() - make_interval(days => greatest(coalesce(p_days, 7), 1))
      and f->>'response_body' is not null
  ) d;

  -- 158(b) retention fact, from the newest row's own output.
  v_window_hours := coalesce((select (detail->>'window_hours')::int
                              from public.pipeline_health_v1
                              order by checked_at desc limit 1), 24);
  select (detail->>'http_response_oldest')::timestamptz > (checked_at - make_interval(hours => v_window_hours)),
         jsonb_build_object(
           'http_response_oldest', detail->>'http_response_oldest',
           'requested_window_hours', v_window_hours,
           'effective_visibility_hours',
             round(extract(epoch from (checked_at - (detail->>'http_response_oldest')::timestamptz)) / 3600.0, 1)
         )
  into v_retention_warning, v_retention_detail
  from public.pipeline_health_v1
  order by checked_at desc limit 1;

  return jsonb_build_object(
    'days', p_days,
    'checks', v_rows,
    'worst_status', v_worst,
    'degraded_checks', v_degraded,
    'down_checks', v_down,
    'max_zone_lag_minutes', round(v_max_zone_lag::numeric, 1),
    'distinct_failure_bodies', v_bodies,
    'first_check_at', v_first,
    'last_check_at', v_last,
    'retention_warning', v_retention_warning,
    'retention', v_retention_detail,
    'answer', case
      when v_worst = 'HEALTHY' and not v_retention_warning
        then 'PIPELINE HEALTHY ALL WEEK'
      when v_worst = 'HEALTHY' and v_retention_warning
        then 'HEALTHY, but http-response retention is shorter than the window — failures older than retention are invisible (see retention)'
      else 'PIPELINE WAS UNHEALTHY THIS WEEK — see worst_status/counts/bodies'
    end
  );
exception when others then
  return jsonb_build_object('error', sqlerrm);
end;
$fn$;

revoke execute on function public.get_pipeline_health_rollup(int) from public;
revoke execute on function public.get_pipeline_health_rollup(int) from anon;
revoke execute on function public.get_pipeline_health_rollup(int) from authenticated;

-- Run after applying (SQL Editor):
--   select public.get_pipeline_health_rollup(7);
