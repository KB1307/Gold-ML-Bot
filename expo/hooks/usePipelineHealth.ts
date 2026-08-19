/**
 * Automated pipeline health check — app-side reader.
 *
 * The check itself runs server-side: a pg_cron job (every 15 min, migration
 * backend/migrations/007_pipeline_health.sql) executes get_pipeline_health(),
 * which runs the 149(c) probes (Query 1: non-200 pg_net responses; Query 2:
 * correlation with the cron job that fired them; Query 3: last successful
 * refresh-sr-zones run) and writes the verdict into pipeline_health_v1.
 *
 * This hook polls the latest row of that results table on a short interval so
 * the dashboard status indicator stays current. Read-only via anon key
 * (SELECT-only RLS policy). MEASUREMENT ONLY — nothing here touches emission.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export type PipelineHealthStatus = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";

export interface PipelineHealthFailure {
  id: number;
  status_code: number;
  error_msg: string | null;
  created: string;
  response_body: string | null;
  cron_job: string | null;
  cron_status: string | null;
}

export interface PipelineHealthRow {
  id: number;
  checked_at: string;
  status: PipelineHealthStatus;
  non200_count: number;
  failures: PipelineHealthFailure[] | null;
  last_cron_success_at: string | null;
  cron_lag_minutes: number | null;
  window_hours: number;
  detail: Record<string, unknown> | null;
}

/** Poll cadence: the server checks every 15 min; the client re-reads every 60s. */
const POLL_INTERVAL_MS = 60_000;

/** A row older than this means the server-side checker itself stopped reporting. */
export const CHECK_STALE_MINUTES = 20;

export function usePipelineHealth() {
  return useQuery<PipelineHealthRow | null>({
    queryKey: ["pipeline-health-latest"],
    queryFn: async (): Promise<PipelineHealthRow | null> => {
      if (!supabase) return null;
      const { data, error } = await supabase
        .from("pipeline_health_v1")
        .select(
          "id, checked_at, status, non200_count, failures, last_cron_success_at, cron_lag_minutes, window_hours, detail"
        )
        .order("checked_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return (data?.[0] as PipelineHealthRow | undefined) ?? null;
    },
    staleTime: 30_000,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnMount: "always",
    retry: 1,
  });
}

/**
 * ITEM 158(c) — 7-day rollup over pipeline_health_v1, computed client-side so
 * the card shows unhealthy periods that have since RECOVERED. Same logic as
 * get_pipeline_health_rollup() (migration 008) but readable via the anon key
 * with no new grants. Includes the 158(b) retention warning: when the newest
 * check's http_response_oldest is NEWER than (checked_at − window_hours),
 * net._http_response retention is shorter than the requested window and older
 * failures are structurally invisible — flagged explicitly instead of two
 * numbers silently contradicting each other.
 */
export interface PipelineHealthRollup {
  checks: number;
  worstStatus: PipelineHealthStatus;
  degradedChecks: number;
  downChecks: number;
  maxZoneLagMinutes: number | null;
  distinctFailureBodies: string[];
  retentionWarning: boolean;
  httpVisibilityHours: number | null;
  spanDays: number | null;
}

export function usePipelineHealthRollup() {
  return useQuery<PipelineHealthRollup | null>({
    queryKey: ["pipeline-health-rollup"],
    queryFn: async (): Promise<PipelineHealthRollup | null> => {
      if (!supabase) return null;
      const { data, error } = await supabase
        .from("pipeline_health_v1")
        .select("checked_at, status, failures, detail")
        .order("checked_at", { ascending: false })
        .limit(672);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{
        checked_at: string;
        status: PipelineHealthStatus;
        failures: Array<{ response_body?: string | null }> | null;
        detail: Record<string, unknown> | null;
      }>;
      if (rows.length === 0) return null;
      const degradedChecks = rows.filter((r) => r.status === "DEGRADED").length;
      const downChecks = rows.filter((r) => r.status === "DOWN").length;
      const worstStatus: PipelineHealthStatus =
        downChecks > 0 ? "DOWN" : degradedChecks > 0 ? "DEGRADED" : "HEALTHY";
      const lags = rows
        .map((r) => (typeof r.detail?.zone_lag_minutes === "number" ? r.detail.zone_lag_minutes : null))
        .filter((v): v is number => v !== null);
      const bodies = new Set<string>();
      for (const r of rows) {
        for (const f of r.failures ?? []) {
          if (f?.response_body) bodies.add(f.response_body.slice(0, 80));
        }
      }
      const latest = rows[0];
      const oldest =
        typeof latest.detail?.http_response_oldest === "string" ? latest.detail.http_response_oldest : null;
      const windowHours =
        typeof latest.detail?.window_hours === "number" ? latest.detail.window_hours : 24;
      const checkedMs = new Date(latest.checked_at).getTime();
      const retentionWarning = oldest
        ? new Date(oldest).getTime() > checkedMs - windowHours * 3_600_000
        : false;
      const httpVisibilityHours = oldest ? (checkedMs - new Date(oldest).getTime()) / 3_600_000 : null;
      const spanDays =
        rows.length > 1
          ? (new Date(rows[0].checked_at).getTime() - new Date(rows[rows.length - 1].checked_at).getTime()) /
            86_400_000
          : null;
      return {
        checks: rows.length,
        worstStatus,
        degradedChecks,
        downChecks,
        maxZoneLagMinutes: lags.length ? Math.max(...lags) : null,
        distinctFailureBodies: [...bodies],
        retentionWarning,
        httpVisibilityHours: httpVisibilityHours !== null ? Number(httpVisibilityHours.toFixed(1)) : null,
        spanDays: spanDays !== null ? Number(spanDays.toFixed(1)) : null,
      };
    },
    staleTime: 60_000,
    refetchInterval: 300_000,
    refetchOnMount: "always",
    retry: 1,
  });
}
