/**
 * Pipeline Health status indicator (Item 149(c) follow-up).
 *
 * Shows the verdict of the automated server-side health check (migration
 * backend/migrations/007_pipeline_health.sql): a pg_cron job runs the 149(c)
 * probes every 15 minutes — non-200 pg_net responses, their cron-job
 * attribution, and the last successful refresh-sr-zones run — and writes the
 * result to pipeline_health_v1. This card polls that table every 60 seconds
 * and displays HEALTHY / DEGRADED / DOWN / UNKNOWN with a pulsing status dot,
 * a one-line summary, and an expandable failure list.
 *
 * MEASUREMENT/DISPLAY ONLY — touches no signal logic, no gates, no emission.
 */
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Pressable, Animated, Easing, Platform } from "react-native";
import { RefreshCw, ChevronDown, ChevronUp } from "lucide-react-native";
import {
  usePipelineHealth,
  CHECK_STALE_MINUTES,
  type PipelineHealthFailure,
  type PipelineHealthRow,
  type PipelineHealthStatus,
} from "@/hooks/usePipelineHealth";

interface StatusConfig {
  color: string;
  label: string;
}

const STATUS_CONFIG: Record<PipelineHealthStatus, StatusConfig> = {
  HEALTHY: { color: "#22c55e", label: "HEALTHY" },
  DEGRADED: { color: "#FFA500", label: "DEGRADED" },
  DOWN: { color: "#ef4444", label: "DOWN" },
  UNKNOWN: { color: "#8b8b95", label: "UNKNOWN" },
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function buildSummary(row: PipelineHealthRow | null): string {
  if (!row) return "No health data recorded yet.";
  if (row.status === "DOWN") {
    if (row.last_cron_success_at === null) {
      return "No successful zone refresh on record — the refresh cron is not running.";
    }
    return `Zone refresh stalled: ${Math.round(row.cron_lag_minutes ?? 0)}m since the last successful run (3+ missed 15-min cycles).`;
  }
  if (row.status === "DEGRADED") {
    if (row.non200_count >= 1) {
      return `${row.non200_count} failed backend call${row.non200_count === 1 ? "" : "s"} in the last ${row.window_hours}h.`;
    }
    return `Zone refresh lagging: ${Math.round(row.cron_lag_minutes ?? 0)}m since the last successful run.`;
  }
  if (row.status === "HEALTHY") {
    const lag = row.cron_lag_minutes !== null ? `${Math.round(row.cron_lag_minutes)}m ago` : "unknown";
    return `0 failed calls in ${row.window_hours}h · zone refresh ${lag}.`;
  }
  return "Health check could not run — see detail.";
}

function FailureRow({ failure }: { failure: PipelineHealthFailure }) {
  return (
    <View style={styles.failureRow}>
      <View style={styles.failureHeader}>
        <Text style={[styles.failureBadge, { color: failure.status_code >= 500 ? "#ef4444" : "#FFA500" }]}>
          HTTP {failure.status_code}
        </Text>
        <Text style={styles.failureJob}>{failure.cron_job ?? "unattributed"}</Text>
        <Text style={styles.failureTime}>{timeAgo(failure.created)}</Text>
      </View>
      {failure.response_body ? (
        <Text style={styles.failureBody} numberOfLines={2} ellipsizeMode="tail">
          {failure.response_body}
        </Text>
      ) : failure.error_msg ? (
        <Text style={styles.failureBody} numberOfLines={2} ellipsizeMode="tail">
          {failure.error_msg}
        </Text>
      ) : null}
    </View>
  );
}

const FailureRowMemo = React.memo(FailureRow);

export default function PipelineHealthCard() {
  const { data, isLoading, isError, isFetching, refetch } = usePipelineHealth();
  const [expanded, setExpanded] = useState(false);

  const pulse = useRef(new Animated.Value(1)).current;
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);

  useEffect(() => {
    if (!isFetching) return;
    const animation = Animated.timing(spin, {
      toValue: 1,
      duration: 700,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) spin.setValue(0);
    });
    return () => animation.stop();
  }, [isFetching, spin]);

  const spinTransform = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  const failures = data?.failures ?? [];
  const checkedAtMs = data ? new Date(data.checked_at).getTime() : 0;
  const isStale =
    checkedAtMs > 0 && Date.now() - checkedAtMs > CHECK_STALE_MINUTES * 60_000;

  const status: PipelineHealthStatus = isError ? "UNKNOWN" : (data?.status ?? "UNKNOWN");
  const config = STATUS_CONFIG[status];
  const summary = isError
    ? "Health check unavailable — apply backend/migrations/007_pipeline_health.sql in the Supabase SQL Editor."
    : buildSummary(data ?? null);

  const hasExpandableDetail = Boolean(
    failures.length > 0 || data?.last_cron_success_at || data?.detail?.error
  );

  const toggleExpanded = () => {
    if (hasExpandableDetail) setExpanded((prev) => !prev);
  };

  return (
    <View style={styles.card} testID="pipeline-health-card">
      <Pressable
        onPress={toggleExpanded}
        style={({ pressed }) => [styles.cardBody, pressed && styles.cardPressed]}
        accessibilityRole="button"
        accessibilityLabel={`Pipeline health ${config.label}`}
      >
        <View style={styles.headerRow}>
          <Animated.View
            style={[styles.statusDot, { backgroundColor: config.color, opacity: pulse }]}
            testID="pipeline-health-dot"
          />
          <View style={styles.titleWrap}>
            <Text style={styles.cardTitle}>PIPELINE HEALTH</Text>
            <Text style={[styles.statusText, { color: config.color }]} testID="pipeline-health-status">
              {isLoading ? "CHECKING…" : config.label}
            </Text>
          </View>
          {/* Spacer reserves room for the overlay refresh + chevron controls. */}
          <View style={styles.headerSpacer} />
        </View>

        <Text style={styles.summaryText} testID="pipeline-health-summary">
          {summary}
        </Text>

        {isStale && data && (
          <Text style={styles.staleNote}>
            Last server check {timeAgo(data.checked_at)} — expected every 15 min. The checker itself may have stopped.
          </Text>
        )}

        {!isError && !data && !isLoading && (
          <Text style={styles.hintNote}>
            First server-side check runs within 15 minutes of applying the migration (or force one:{" "}
            {"select public.get_pipeline_health(24);"}).
          </Text>
        )}
      </Pressable>

      {/* Refresh + chevron sit in an absolute overlay SIBLING to the toggle
          Pressable: on web each Pressable renders a <button>, and a <button>
          nested inside another <button> is invalid HTML (hydration error). */}
      <View style={styles.actionsOverlay} pointerEvents="box-none">
        <Pressable
          onPress={() => {
            void refetch();
          }}
          hitSlop={8}
          style={({ pressed }) => [styles.refreshButton, pressed && styles.refreshPressed]}
          accessibilityRole="button"
          accessibilityLabel="Refresh pipeline health"
        >
          <Animated.View style={{ transform: [{ rotate: spinTransform }] }}>
            <RefreshCw size={16} color="#8b8b95" />
          </Animated.View>
        </Pressable>
        {hasExpandableDetail ? (
          expanded ? (
            <ChevronUp size={18} color="#8b8b95" />
          ) : (
            <ChevronDown size={18} color="#8b8b95" />
          )
        ) : null}
      </View>

      {expanded && (
        <View style={styles.detailSection} testID="pipeline-health-detail">
          {data?.last_cron_success_at && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Last successful zone refresh</Text>
              <Text style={styles.detailValue}>
                {formatTimestamp(data.last_cron_success_at)} ({timeAgo(data.last_cron_success_at)})
              </Text>
            </View>
          )}
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Failed calls (window {data?.window_hours ?? 24}h)</Text>
            <Text style={[styles.detailValue, { color: (data?.non200_count ?? 0) > 0 ? "#FFA500" : "#22c55e" }]}>
              {data?.non200_count ?? 0}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Last health check</Text>
            <Text style={styles.detailValue}>{data ? timeAgo(data.checked_at) : "never"}</Text>
          </View>
          {typeof data?.detail?.error === "string" && (
            <Text style={styles.errorNote}>{data.detail.error}</Text>
          )}
          {failures.length > 0 && (
            <View style={styles.failureList}>
              <Text style={styles.failureListTitle}>Failed calls ({failures.length} shown, most recent first)</Text>
              {failures.map((failure) => (
                <FailureRowMemo key={`${failure.id}`} failure={failure} />
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    marginBottom: 20,
  },
  cardBody: {
    padding: 14,
    borderRadius: 15,
  },
  cardPressed: {
    backgroundColor: "rgba(255, 255, 255, 0.07)",
  },
  actionsOverlay: {
    position: "absolute",
    top: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    zIndex: 1,
  },
  headerSpacer: {
    width: 60,
  },
  refreshPressed: {
    opacity: 0.6,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  titleWrap: {
    flex: 1,
    flexDirection: "column",
  },
  cardTitle: {
    fontSize: 10,
    fontWeight: "700",
    color: "#8b8b95",
    letterSpacing: 1,
  } as const,
  statusText: {
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.5,
  } as const,
  refreshButton: {
    padding: 6,
  },
  summaryText: {
    fontSize: 13,
    color: "#c8c8d0",
    lineHeight: 18,
  },
  staleNote: {
    fontSize: 11,
    color: "#FFA500",
    marginTop: 6,
    lineHeight: 15,
  },
  hintNote: {
    fontSize: 11,
    color: "#8b8b95",
    marginTop: 6,
    lineHeight: 15,
  },
  errorNote: {
    fontSize: 11,
    color: "#ef4444",
    marginTop: 6,
  },
  detailSection: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.08)",
    gap: 6,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  detailLabel: {
    fontSize: 12,
    color: "#8b8b95",
  },
  detailValue: {
    fontSize: 12,
    fontWeight: "600",
    color: "#c8c8d0",
  } as const,
  failureList: {
    marginTop: 8,
    gap: 8,
  },
  failureListTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#8b8b95",
    letterSpacing: 0.5,
  } as const,
  failureRow: {
    backgroundColor: "rgba(239, 68, 68, 0.08)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.2)",
    padding: 10,
  },
  failureHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  failureBadge: {
    fontSize: 11,
    fontWeight: "700",
  } as const,
  failureJob: {
    fontSize: 11,
    color: "#c8c8d0",
    flex: 1,
  },
  failureTime: {
    fontSize: 11,
    color: "#8b8b95",
  },
  failureBody: {
    fontSize: 11,
    color: "#8b8b95",
    lineHeight: 15,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
});
