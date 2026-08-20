-- ITEM 167(e) — BAR-FEED FRESHNESS ALARM.
--
-- gold_m1_bars is upstream of EVERYTHING (zones cron, engine directional
-- layer, resolver). Until this migration it had NO alarm: a stalled Windows
-- sync silently suppressed 100% of signal emission for ~24h (Item 167) while
-- every other check read HEALTHY — 12 consecutive HEALTHY rows, non200=0,
-- 32 usable zones. The zone-lag check cannot see a stalled feed because the
-- zones cron keeps succeeding off older bars.
--
-- DESIGN: a SEPARATE function + cron job rather than editing
-- get_pipeline_health(), because the LIVE function is the 007-v2 variant
-- (zone_lag_minutes / usable_zones / http_response_oldest detail keys) and
-- replacing it from the repo's 007 base would regress it. check_bar_freshness
-- writes into the SAME pipeline_health_v1 table, so a stalled feed raises a
-- DEGRADED/DOWN row automatically and is visible in one query (and in the
-- app card's 7-day rollup).
--
-- PRE-REGISTERED thresholds, derived from the M1 cadence (one bar/minute):
--   DEGRADED when the newest bar is older than 15 min — the SAME age at which
--     the engine's own getDirectionalM5() staleness seal (BAR_MAX_AGE_M5_MS =
--     15 min, signalEngine.ts:1621) stands aside. When this alarm fires the
--     engine has ALREADY stopped trading; the health check must say why
--     before anyone asks.
--   DOWN when older than 60 min — a full hour of missing M1 data.
-- Only unhealthy states are written: healthy periods stay in the main
-- check's 15-minute cadence; a stall gets a fresh alarm row every 5 minutes
-- so the latest-row status flips quickly.
--
-- Weekend guard: gold's OTC market is closed Sat/Sun (UTC). A closed market
-- is not an outage — the check skips itself on dow 0/6.
--
-- WHAT THIS DOES NOT CHANGE: get_pipeline_health(), the zone cron (jobid 12),
-- the pipeline-health cron (jobid 13), the 7-day retention, or any existing
-- threshold. It adds one read-only function and one cron schedule.

create or replace function public.check_bar_freshness()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_newest_bar timestamptz;
  v_bar_age double precision;
  v_bars_15m int;
  v_status text;
  v_result jsonb;
begin
  select max(b.timestamp) into v_newest_bar from public.gold_m1_bars b;
  select count(*) into v_bars_15m
  from public.gold_m1_bars b
  where b.timestamp > now() - interval '15 minutes';

  if extract(dow from now()) in (0, 6) then
    return jsonb_build_object('status', 'SKIPPED_WEEKEND', 'checked_at', now());
  end if;

  v_bar_age := case
    when v_newest_bar is null then null
    else extract(epoch from (now() - v_newest_bar)) / 60.0
  end;

  if v_newest_bar is null or v_bar_age > 60 then
    v_status := 'DOWN';
  elsif v_bar_age > 15 then
    v_status := 'DEGRADED';
  else
    v_status := 'HEALTHY';
  end if;

  v_result := jsonb_build_object(
    'status', v_status,
    'checked_at', now(),
    'check', 'bar_freshness',
    'window_hours', 1,
    'non200_count', 0,
    'failures', '[]'::jsonb,
    'bar_age_minutes', case when v_bar_age is null then null else round(v_bar_age::numeric, 1) end,
    'newest_bar_at', v_newest_bar,
    'bars_last_15_min', v_bars_15m
  );

  if v_status <> 'HEALTHY' then
    insert into public.pipeline_health_v1
      (checked_at, status, non200_count, failures, last_cron_success_at, cron_lag_minutes, window_hours, detail)
    values
      (now(), v_status, 0, '[]'::jsonb, null, null, 1, v_result);
  end if;

  return v_result;
exception when others then
  return jsonb_build_object('status', 'UNKNOWN', 'error', sqlerrm, 'checked_at', now());
end;
$fn$;

-- SECURITY DEFINER posture: revoke public execute (migration 002 posture).
revoke execute on function public.check_bar_freshness() from public;
revoke execute on function public.check_bar_freshness() from anon;
revoke execute on function public.check_bar_freshness() from authenticated;

-- Every 5 minutes — faster than the main 15-minute check because bars are the
-- fastest-moving data in the pipeline and the engine stands aside at 15 min.
select cron.schedule(
  'bar-freshness-check',
  '*/5 * * * *',
  $$select public.check_bar_freshness();$$
);
