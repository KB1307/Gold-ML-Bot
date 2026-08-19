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
