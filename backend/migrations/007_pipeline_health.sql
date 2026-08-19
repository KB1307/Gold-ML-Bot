-- ITEM 149(c) FOLLOW-UP: AUTOMATED PIPELINE HEALTH CHECK.
--
-- The user-facing probes (Queries 1-3, run manually in the SQL Editor) answered
-- "are there failing HTTP calls?" once. This migration makes the same probes run
-- AUTOMATICALLY every 15 minutes, forever, so the legacy_reaction_strength class
-- of silent failure (cron says "succeeded" while the HTTP call returns 500) can
-- never again accumulate unnoticed.
--
-- WHAT IT RUNS (identical semantics to the manual probes):
--   Query 1: non-200 responses in net._http_response over the window.
--   Query 2: correlation of each non-200 with the cron job that fired it
--            (time-window join; pg_net and pg_cron share no foreign key).
--   Query 3: last successful refresh-sr-zones run — required to distinguish
--            "zero failures because healthy" from "zero failures because the
--            cron is dead".
--
-- STATUS RULES (pre-registered; the UI colors come from these):
--   DOWN     — no successful refresh-sr-zones run on record, or the last one
--              is older than 45 minutes (three missed 15-minute runs).
--   DEGRADED — at least one non-200 HTTP response in the window, or the last
--              successful zone refresh is older than 30 minutes.
--   HEALTHY  — zero non-200s and the zone refresh fired within 30 minutes.
--   UNKNOWN  — the check itself threw (schema drift, missing extension); the
--              error message is stored in the detail column.
--
-- SECURITY POSTURE (consistent with migration 002):
--   get_pipeline_health() is SECURITY DEFINER because it must read the internal
--   cron.* and net.* schemas, which client keys cannot touch. Its EXECUTE grant
--   is REVOKED from PUBLIC/anon/authenticated — it is invoked ONLY by the
--   pg_cron job below (running as this migration's owner). Clients never call
--   it; they read the pipeline_health_v1 results table through a SELECT-only
--   RLS policy. No privilege-escalation surface is opened.
--
-- Column names verified against pg_net 0.8 (net._http_response: id, status_code,
-- content_type, headers, content, timed_out, error_msg, created) and pg_cron
-- (cron.job_run_details: jobid, runid, status, return_message, start_time,
-- end_time; cron.job: jobid, jobname, schedule, active).

-- ── Results table ─────────────────────────────────────────────────────────────
create table if not exists public.pipeline_health_v1 (
  id bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  status text not null check (status in ('HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN')),
  non200_count int not null default 0,
  failures jsonb not null default '[]'::jsonb,
  last_cron_success_at timestamptz,
  cron_lag_minutes double precision,
  window_hours int not null default 24,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists pipeline_health_v1_checked_at_idx
  on public.pipeline_health_v1 (checked_at desc);

alter table public.pipeline_health_v1 enable row level security;

-- SELECT-only for clients. No INSERT/UPDATE/DELETE policies exist on purpose:
-- the only writer is the SECURITY DEFINER function below.
drop policy if exists "pipeline_health_select_public" on public.pipeline_health_v1;
create policy "pipeline_health_select_public" on public.pipeline_health_v1
  for select
  to anon, authenticated
  using (true);

-- ── The checker ───────────────────────────────────────────────────────────────
create or replace function public.get_pipeline_health(p_window_hours int default 24)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_window interval := make_interval(hours => greatest(coalesce(p_window_hours, 24), 1));
  v_failures jsonb;
  v_non200_count int;
  v_last_success timestamptz;
  v_lag double precision;
  v_status text;
  v_result jsonb;
begin
  -- Query 1 + Query 2 combined: non-200 pg_net responses in the window, each
  -- LEFT JOINed to the cron run that was executing when the response arrived.
  select coalesce(jsonb_agg(row_to_json(t) order by t.created desc), '[]'::jsonb)
  into v_failures
  from (
    select
      r.id,
      r.status_code,
      r.error_msg,
      r.created,
      left(r.content::text, 300) as response_body,
      cj.jobname as cron_job,
      j.status as cron_status
    from net._http_response r
    left join cron.job_run_details j
      on r.created between j.start_time - interval '2 seconds'
                       and j.end_time + interval '10 seconds'
    left join cron.job cj on cj.jobid = j.jobid
    where r.status_code >= 400
      and r.created > now() - v_window
    order by r.created desc
    limit 20
  ) t;

  -- Full count (the list above is capped at 20 for payload size).
  select count(*) into v_non200_count
  from net._http_response r
  where r.status_code >= 400
    and r.created > now() - v_window;

  -- Query 3: last successful refresh-sr-zones run.
  select max(j.end_time)
  into v_last_success
  from cron.job_run_details j
  join cron.job cj on cj.jobid = j.jobid
  where cj.jobname = 'refresh-sr-zones'
    and j.status = 'succeeded';

  -- Pre-registered status rules.
  if v_last_success is null then
    v_lag := null;
    v_status := 'DOWN';
  else
    v_lag := extract(epoch from (now() - v_last_success)) / 60.0;
    if v_lag > 45 then
      v_status := 'DOWN';
    elsif v_non200_count >= 1 or v_lag > 30 then
      v_status := 'DEGRADED';
    else
      v_status := 'HEALTHY';
    end if;
  end if;

  v_result := jsonb_build_object(
    'status', v_status,
    'checked_at', now(),
    'window_hours', extract(hour from v_window),
    'non200_count', v_non200_count,
    'failures', v_failures,
    'last_cron_success_at', v_last_success,
    'cron_lag_minutes', round(v_lag::numeric, 1)
  );

  insert into public.pipeline_health_v1
    (checked_at, status, non200_count, failures, last_cron_success_at, cron_lag_minutes, window_hours, detail)
  values
    (now(), v_status, v_non200_count, v_failures, v_last_success, v_lag, greatest(coalesce(p_window_hours, 24), 1), v_result);

  -- Keep 7 days of history (96 runs/day at 15-minute cadence).
  delete from public.pipeline_health_v1
  where checked_at < now() - interval '7 days';

  return v_result;

exception when others then
  -- Never throw: the cron must record that the check itself is broken.
  insert into public.pipeline_health_v1 (status, non200_count, failures, detail)
  values ('UNKNOWN', 0, '[]'::jsonb, jsonb_build_object('error', sqlerrm, 'checked_at', now()));
  return jsonb_build_object('status', 'UNKNOWN', 'error', sqlerrm, 'checked_at', now());
end;
$fn$;

-- SECURITY DEFINER: revoke public execute (migration 002 posture).
revoke execute on function public.get_pipeline_health(int) from public;
revoke execute on function public.get_pipeline_health(int) from anon;
revoke execute on function public.get_pipeline_health(int) from authenticated;

-- ── Schedule: every 15 minutes, aligned with the zone-refresh cadence ─────────
-- Idempotent: replaces any existing job of the same name first.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'pipeline-health-check') then
    perform cron.unschedule('pipeline-health-check');
  end if;
  perform cron.schedule(
    'pipeline-health-check',
    '*/15 * * * *',
    $$select public.get_pipeline_health(24)$$
  );
end;
$do$;

-- Verify (run manually after applying):
--   select jobname, schedule, active from cron.job where jobname = 'pipeline-health-check';
--   select * from pipeline_health_v1 order by checked_at desc limit 3;
-- Force an immediate first run so the UI has data before 15 minutes elapse:
--   select public.get_pipeline_health(24);
