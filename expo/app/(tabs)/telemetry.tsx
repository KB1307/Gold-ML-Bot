import { View, Text, StyleSheet, ScrollView, Platform, RefreshControl, ActivityIndicator } from "react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { Activity, Brain, Zap, TrendingUp, Target, AlertTriangle, BarChart3, Clock, CheckCircle2, XCircle, Radio, Cpu, Gauge, Eye } from "lucide-react-native";
import { Stack } from "expo-router";
import { useTrading, classifySignalOutcome } from "@/contexts/TradingContext";
import { signalEngine } from "@/services/signalEngine";
import { TradingSignal } from "@/types/trading";

interface TelemetrySnapshot {
  generationStats: { attempts: number; successful: number; rate: number };
  modelHealth: ReturnType<typeof signalEngine.getModelHealthMetrics>;
  hypoStats: ReturnType<typeof signalEngine.getHypotheticalTradeStats>;
  perfMetrics: ReturnType<typeof signalEngine.getPerformanceMetrics>;
  nearMisses: ReturnType<typeof signalEngine.getRecentNearMisses>;
  diffBuckets: ReturnType<typeof signalEngine.getDiffBucketStats>;
  currentPrice: number;
  priceSource: string;
  capturedAt: number;
}

const FALLBACK_TELEMETRY: TelemetrySnapshot = {
  generationStats: { attempts: 0, successful: 0, rate: 0 },
  modelHealth: {
    modelHealthScore: 0,
    featureCorrelationStatus: 'N/A',
    confidenceDegradation: 0,
    conceptDriftScore: 0,
    featureImportanceDrift: [],
    driftAlertLevel: 'NONE' as const,
    daysSinceRetrain: 0,
    retrainingRecommended: false,
    retrainScheduled: false,
  },
  hypoStats: { avgSlippageDiff: 0, hypotheticalAccuracy: 0 },
  perfMetrics: { recentWinRate: 0, profitFactor: 0, avgConfidence: 0, recentWinningConfidences: [] },
  nearMisses: [],
  diffBuckets: { low: { wins: 0, losses: 0, ev: 0 }, mid: { wins: 0, losses: 0, ev: 0 }, high: { wins: 0, losses: 0, ev: 0 } },
  currentPrice: 0,
  priceSource: 'unavailable',
  capturedAt: Date.now(),
};

function captureTelemetry(): TelemetrySnapshot {
  try {
    return {
      generationStats: signalEngine.getSignalGenerationStats(),
      modelHealth: signalEngine.getModelHealthMetrics(),
      hypoStats: signalEngine.getHypotheticalTradeStats(),
      perfMetrics: signalEngine.getPerformanceMetrics(),
      nearMisses: signalEngine.getRecentNearMisses(),
      diffBuckets: signalEngine.getDiffBucketStats(),
      currentPrice: signalEngine.getCurrentPrice(),
      priceSource: signalEngine.getPriceSource(),
      capturedAt: Date.now(),
    };
  } catch (err) {
    console.error('[Telemetry] captureTelemetry crashed during render:', err);
    return { ...FALLBACK_TELEMETRY, capturedAt: Date.now() };
  }
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export default function TelemetryScreen() {
  const { signalHistory, performanceMetrics, signalUpdateTrigger, settings } = useTrading();
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot>(() => captureTelemetry());
  const [refreshing, setRefreshing] = useState<boolean>(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setSnapshot(captureTelemetry());
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setSnapshot(captureTelemetry());
  }, [signalUpdateTrigger]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await new Promise((r) => setTimeout(r, 400));
    setSnapshot(captureTelemetry());
    setRefreshing(false);
  }, []);

  const todayStart = useMemo(() => startOfLocalDay(Date.now()), [snapshot.capturedAt]);

  const todaySignals = useMemo<TradingSignal[]>(() => {
    return signalHistory
      .filter((s) => new Date(s.timestamp).getTime() >= todayStart)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [signalHistory, todayStart]);

  const todayStats = useMemo(() => {
    let wins = 0;
    let losses = 0;
    let active = 0;
    let buys = 0;
    let sells = 0;
    for (const s of todaySignals) {
      if (s.type === "BUY") buys++;
      else sells++;
      // Shared classifier keeps these counts in lock-step with the Dashboard
      // performance metrics: a missed entry (no position) is NOT a loss, and a
      // TP3 win is always a win.
      const outcome = classifySignalOutcome(s, settings.basePositionSize);
      if (outcome === "WIN") wins++;
      else if (outcome === "LOSS") losses++;
      else if (outcome === "OPEN") active++;
    }
    const closed = wins + losses;
    const winRate = closed > 0 ? (wins / closed) * 100 : 0;
    return { wins, losses, active, buys, sells, total: todaySignals.length, winRate };
  }, [todaySignals, settings.basePositionSize]);

  const driftColor = (level: string) => {
    switch (level) {
      case "HIGH": return "#ef4444";
      case "MEDIUM": return "#f59e0b";
      case "LOW": return "#eab308";
      default: return "#22c55e";
    }
  };

  const healthColor = (score: number) => {
    if (score >= 80) return "#22c55e";
    if (score >= 60) return "#eab308";
    if (score >= 40) return "#f59e0b";
    return "#ef4444";
  };

  const corrColor = (status: string) => status === "HEALTHY" ? "#22c55e" : status === "DEGRADED" ? "#f59e0b" : "#ef4444";

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container} testID="telemetry-screen">
        <LinearGradient colors={["#0a0a0a", "#0d1117", "#1a1a2e"]} style={styles.gradient}>
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FFD700" />}
          >
            <View style={styles.header}>
              <View style={styles.headerIconWrap}>
                <Activity size={26} color="#FFD700" strokeWidth={2.5} />
              </View>
              <View style={styles.headerTextContainer}>
                <Text style={styles.headerTitle}>Engine Telemetry</Text>
                <Text style={styles.headerSubtitle}>
                  Live diagnostics • {new Date(snapshot.capturedAt).toLocaleTimeString()}
                </Text>
              </View>
              <View style={styles.liveDot} />
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Radio size={18} color="#FFD700" strokeWidth={2.5} />
                <Text style={styles.cardTitle}>Live Price Feed</Text>
              </View>
              <View style={styles.priceRow}>
                <Text style={styles.bigPrice}>
                  {snapshot.currentPrice > 0 ? `$${snapshot.currentPrice.toFixed(2)}` : "—"}
                </Text>
                <Text style={styles.priceSource} numberOfLines={1}>{snapshot.priceSource}</Text>
              </View>
            </View>

            <View style={styles.sectionTitleRow}>
              <Cpu size={16} color="#9ca3af" />
              <Text style={styles.sectionTitle}>Signal Generation</Text>
            </View>

            <View style={styles.grid4}>
              <MetricTile
                icon={<Zap size={16} color="#FFD700" />}
                label="Attempts"
                value={snapshot.generationStats.attempts.toString()}
                accent="#FFD700"
              />
              <MetricTile
                icon={<Target size={16} color="#22c55e" />}
                label="Generated"
                value={snapshot.generationStats.successful.toString()}
                accent="#22c55e"
              />
              <MetricTile
                icon={<TrendingUp size={16} color="#38bdf8" />}
                label="Rate"
                value={`${snapshot.generationStats.rate.toFixed(1)}%`}
                accent="#38bdf8"
              />
              <MetricTile
                icon={<Gauge size={16} color="#a78bfa" />}
                label="Avg Conf"
                value={`${(snapshot.perfMetrics.avgConfidence * 100).toFixed(0)}%`}
                accent="#a78bfa"
              />
            </View>

            <View style={styles.sectionTitleRow}>
              <Brain size={16} color="#9ca3af" />
              <Text style={styles.sectionTitle}>Model Health</Text>
            </View>

            <View style={styles.card}>
              <View style={styles.healthRow}>
                <View style={styles.healthScoreWrap}>
                  <Text style={styles.healthScoreLabel}>Health Score</Text>
                  <Text style={[styles.healthScore, { color: healthColor(snapshot.modelHealth.modelHealthScore) }]}>
                    {snapshot.modelHealth.modelHealthScore.toFixed(0)}
                    <Text style={styles.healthScoreUnit}>/100</Text>
                  </Text>
                </View>
                <View style={styles.healthBarTrack}>
                  <View
                    style={[
                      styles.healthBarFill,
                      {
                        width: `${Math.max(2, Math.min(100, snapshot.modelHealth.modelHealthScore))}%`,
                        backgroundColor: healthColor(snapshot.modelHealth.modelHealthScore),
                      },
                    ]}
                  />
                </View>
              </View>

              <View style={styles.divider} />

              <StatRow
                label="Drift Alert"
                value={snapshot.modelHealth.driftAlertLevel}
                valueColor={driftColor(snapshot.modelHealth.driftAlertLevel)}
              />
              <StatRow
                label="Concept Drift"
                value={snapshot.modelHealth.conceptDriftScore.toFixed(3)}
                valueColor={snapshot.modelHealth.conceptDriftScore > 0.5 ? "#ef4444" : "#fff"}
              />
              <StatRow
                label="Feature Correlation"
                value={snapshot.modelHealth.featureCorrelationStatus}
                valueColor={corrColor(snapshot.modelHealth.featureCorrelationStatus)}
              />
              <StatRow
                label="Confidence Degradation"
                value={`${(snapshot.modelHealth.confidenceDegradation * 100).toFixed(2)}%`}
                valueColor={snapshot.modelHealth.confidenceDegradation > 0.08 ? "#f59e0b" : "#fff"}
              />
              <StatRow
                label="Days Since Retrain"
                value={snapshot.modelHealth.daysSinceRetrain.toString()}
                valueColor={snapshot.modelHealth.daysSinceRetrain > 5 ? "#f59e0b" : "#fff"}
              />
              <StatRow
                label="Retrain Recommended"
                value={snapshot.modelHealth.retrainingRecommended ? "YES" : "NO"}
                valueColor={snapshot.modelHealth.retrainingRecommended ? "#f59e0b" : "#22c55e"}
              />
              {snapshot.modelHealth.retrainScheduled ? (
                <View style={styles.scheduledBanner}>
                  <AlertTriangle size={14} color="#f59e0b" />
                  <Text style={styles.scheduledText}>Retrain scheduled — will run automatically</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.sectionTitleRow}>
              <BarChart3 size={16} color="#9ca3af" />
              <Text style={styles.sectionTitle}>Performance Snapshot</Text>
            </View>

            <View style={styles.grid3}>
              <MetricTile
                icon={<TrendingUp size={16} color="#22c55e" />}
                label="Win Rate"
                value={`${(snapshot.perfMetrics.recentWinRate * 100).toFixed(0)}%`}
                accent="#22c55e"
              />
              <MetricTile
                icon={<BarChart3 size={16} color="#38bdf8" />}
                label="Profit Factor"
                value={snapshot.perfMetrics.profitFactor.toFixed(2)}
                accent="#38bdf8"
              />
              <MetricTile
                icon={<Gauge size={16} color="#FFD700" />}
                label="Sharpe / trade"
                value={performanceMetrics.sharpeRatio.toFixed(3)}
                accent="#FFD700"
              />
            </View>

            <View style={styles.sectionTitleRow}>
              <Clock size={16} color="#9ca3af" />
              <Text style={styles.sectionTitle}>Execution Quality</Text>
            </View>

            <View style={styles.card}>
              <StatRow
                label="Hypothetical Accuracy"
                value={`${snapshot.hypoStats.hypotheticalAccuracy.toFixed(1)}%`}
                valueColor={snapshot.hypoStats.hypotheticalAccuracy >= 85 ? "#22c55e" : "#f59e0b"}
              />
              <StatRow
                label="Avg Slippage Diff"
                value={`${snapshot.hypoStats.avgSlippageDiff.toFixed(2)} pips`}
                valueColor={snapshot.hypoStats.avgSlippageDiff < 2 ? "#22c55e" : "#f59e0b"}
              />
            </View>

            <View style={styles.sectionTitleRow}>
              <Target size={16} color="#9ca3af" />
              <Text style={styles.sectionTitle}>Today's Signals ({todaySignals.length})</Text>
            </View>

            <View style={styles.grid4}>
              <MetricTile label="BUY" value={todayStats.buys.toString()} icon={<TrendingUp size={16} color="#22c55e" />} accent="#22c55e" />
              <MetricTile label="SELL" value={todayStats.sells.toString()} icon={<TrendingUp size={16} color="#ef4444" style={{ transform: [{ rotate: "180deg" }] }} />} accent="#ef4444" />
              <MetricTile label="Wins" value={todayStats.wins.toString()} icon={<CheckCircle2 size={16} color="#22c55e" />} accent="#22c55e" />
              <MetricTile label="Losses" value={todayStats.losses.toString()} icon={<XCircle size={16} color="#ef4444" />} accent="#ef4444" />
            </View>

            <View style={styles.card}>
              <StatRow label="Active / Pending" value={todayStats.active.toString()} valueColor="#38bdf8" />
              <StatRow
                label="Day Win Rate"
                value={todayStats.wins + todayStats.losses > 0 ? `${todayStats.winRate.toFixed(0)}%` : "—"}
                valueColor={todayStats.winRate >= 60 ? "#22c55e" : todayStats.winRate >= 45 ? "#eab308" : "#ef4444"}
              />
            </View>

            {todaySignals.length === 0 ? (
              <View style={styles.emptyToday}>
                <ActivityIndicator size="small" color="#FFD700" />
                <Text style={styles.emptyTodayText}>Engine running — no signals generated yet today</Text>
              </View>
            ) : (
              <View style={styles.todayList}>
                {todaySignals.slice(0, 10).map((s) => (
                  <View key={s.id} style={styles.todayItem} testID={`telemetry-today-${s.id}`}>
                    <View style={[styles.todayBadge, { backgroundColor: s.type === "BUY" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)" }]}>
                      <Text style={[styles.todayBadgeText, { color: s.type === "BUY" ? "#22c55e" : "#ef4444" }]}>{s.type}</Text>
                    </View>
                    <View style={styles.todayItemBody}>
                      <Text style={styles.todayItemPrice}>${s.entryPrice.toFixed(1)}</Text>
                      <Text style={styles.todayItemMeta}>
                        {new Date(s.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} • {(s.confidence * 100).toFixed(0)}%
                      </Text>
                    </View>
                    <Text style={[styles.todayItemStatus, { color: statusColorFor(s.status) }]} numberOfLines={1}>
                      {shortStatus(s.status, s.targetsHit)}
                    </Text>
                  </View>
                ))}
                {todaySignals.length > 10 ? (
                  <Text style={styles.moreText}>+{todaySignals.length - 10} more in History tab</Text>
                ) : null}
              </View>
            )}

            <View style={styles.sectionTitleRow}>
              <Eye size={16} color="#9ca3af" />
              <Text style={styles.sectionTitle}>Setup Brewing ({snapshot.nearMisses.length})</Text>
            </View>

            {snapshot.nearMisses.length === 0 ? (
              <View style={styles.emptyToday}>
                <Text style={styles.emptyTodayText}>No near-misses yet - engine has no filtered setups to show</Text>
              </View>
            ) : (
              <View style={styles.todayList}>
                {snapshot.nearMisses.slice(0, 8).map((nm, idx) => (
                  <View key={`nm-${nm.timestamp}-${idx}`} style={styles.todayItem} testID={`telemetry-nearmiss-${idx}`}>
                    <View style={[styles.todayBadge, { backgroundColor: nm.signalType === "BUY" ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.15)" }]}>
                      <Text style={[styles.todayBadgeText, { color: nm.signalType === "BUY" ? "#22c55e" : "#ef4444" }]}>{nm.signalType}</Text>
                    </View>
                    <View style={styles.todayItemBody}>
                      <Text style={styles.todayItemPrice}>
                        smoothed {(nm.confidence * 100).toFixed(1)}%
                        {nm.rawConfidence !== undefined ? ` · raw ${(nm.rawConfidence * 100).toFixed(1)}%` : ""}
                        {" · diff "}{nm.strengthDiff.toFixed(3)}
                      </Text>
                      <Text style={styles.todayItemMeta} numberOfLines={1}>
                        {new Date(nm.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {nm.reason}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.sectionTitleRow}>
              <BarChart3 size={16} color="#9ca3af" />
              <Text style={styles.sectionTitle}>Diff Bucket EV</Text>
            </View>
            <View style={styles.card}>
              <StatRow label="Low (0.06-0.09)" value={`${snapshot.diffBuckets.low.wins}W/${snapshot.diffBuckets.low.losses}L · ${(snapshot.diffBuckets.low.ev * 100).toFixed(0)}%`} valueColor={snapshot.diffBuckets.low.ev >= 0.55 ? "#22c55e" : "#f59e0b"} />
              <StatRow label="Mid (0.09-0.15)" value={`${snapshot.diffBuckets.mid.wins}W/${snapshot.diffBuckets.mid.losses}L · ${(snapshot.diffBuckets.mid.ev * 100).toFixed(0)}%`} valueColor={snapshot.diffBuckets.mid.ev >= 0.55 ? "#22c55e" : "#f59e0b"} />
              <StatRow label="High (0.15+)" value={`${snapshot.diffBuckets.high.wins}W/${snapshot.diffBuckets.high.losses}L · ${(snapshot.diffBuckets.high.ev * 100).toFixed(0)}%`} valueColor={snapshot.diffBuckets.high.ev >= 0.55 ? "#22c55e" : "#f59e0b"} />
            </View>

            <View style={styles.footerNote}>
              <Text style={styles.footerText}>
                Telemetry refreshes every 5s. Engine runs continuously while the app is open. History tab records every signal generated today.
              </Text>
            </View>
          </ScrollView>
        </LinearGradient>
      </View>
    </>
  );
}

function statusColorFor(status: TradingSignal["status"]): string {
  if (status === "ALL_TARGETS_HIT" || status === "TP3_HIT" || status === "PARTIAL_WIN_SL_HIT") return "#22c55e";
  if (status === "SL_AFTER_BE") return "#FFD700";
  if (status === "TP2_HIT" || status === "TP1_HIT") return "#FFA500";
  if (status === "SL_HIT" || status === "EXPIRED_MISSED_ENTRY") return "#ef4444";
  // ITEM 21: neutral grey, never red — no position was ever opened.
  if (status === "NEVER_FILLABLE") return "#94a3b8";
  if (status === "ACTIVE" || status === "PARTIALLY_MANAGED") return "#38bdf8";
  return "#9ca3af";
}

function shortStatus(status: TradingSignal["status"], targetsHit: number): string {
  switch (status) {
    case "ACTIVE": return "Active";
    case "PARTIALLY_MANAGED": return `Managed ${targetsHit}/3`;
    case "TP1_HIT": return "TP1 ✓";
    case "TP2_HIT": return "TP2 ✓";
    case "TP3_HIT":
    case "ALL_TARGETS_HIT": return "Full Win";
    case "PARTIAL_WIN_SL_HIT": return "Partial Win";
    case "SL_AFTER_BE": return "SL After BE";
    case "SL_HIT": return "SL Hit";
    case "EXPIRED_MISSED_ENTRY": return "Missed";
    case "NEVER_FILLABLE": return "Never Fillable";
    case "CLOSED": return "Closed";
    default: return status;
  }
}

interface MetricTileProps {
  icon?: React.ReactNode;
  label: string;
  value: string;
  accent: string;
}

function MetricTile({ icon, label, value, accent }: MetricTileProps) {
  return (
    <View style={[styles.tile, { borderColor: `${accent}33` }]}>
      <View style={styles.tileHeader}>
        {icon}
        <Text style={styles.tileLabel}>{label}</Text>
      </View>
      <Text style={[styles.tileValue, { color: accent }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

interface StatRowProps {
  label: string;
  value: string;
  valueColor?: string;
}

function StatRow({ label, value, valueColor = "#fff" }: StatRowProps) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  gradient: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingTop: Platform.OS === "ios" ? 60 : 20,
    paddingBottom: 40,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 20,
  },
  headerIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: "rgba(255, 215, 0, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTextContainer: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 2,
  } as const,
  headerSubtitle: {
    fontSize: 12,
    color: "#9ca3af",
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#22c55e",
    shadowColor: "#22c55e",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
  },
  card: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: 14,
    padding: 16,
    marginBottom: 16,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#9ca3af",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  } as const,
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  bigPrice: {
    fontSize: 32,
    fontWeight: "800",
    color: "#FFD700",
    letterSpacing: -0.5,
  } as const,
  priceSource: {
    fontSize: 11,
    color: "#9ca3af",
    maxWidth: "55%",
    textAlign: "right",
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#9ca3af",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  } as const,
  grid4: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 16,
  },
  grid3: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 16,
  },
  tile: {
    flexGrow: 1,
    flexBasis: "22%",
    minWidth: 78,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  tileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  tileLabel: {
    fontSize: 10,
    color: "#9ca3af",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  } as const,
  tileValue: {
    fontSize: 18,
    fontWeight: "800",
  } as const,
  healthRow: {
    gap: 12,
  },
  healthScoreWrap: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  healthScoreLabel: {
    fontSize: 13,
    color: "#9ca3af",
    fontWeight: "600",
  } as const,
  healthScore: {
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: -0.5,
  } as const,
  healthScoreUnit: {
    fontSize: 14,
    color: "#6b7280",
    fontWeight: "600",
  } as const,
  healthBarTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    overflow: "hidden",
  },
  healthBarFill: {
    height: "100%",
    borderRadius: 4,
  },
  divider: {
    height: 1,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    marginVertical: 12,
  },
  statRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
  },
  statLabel: {
    fontSize: 13,
    color: "#9ca3af",
    fontWeight: "500",
  } as const,
  statValue: {
    fontSize: 14,
    fontWeight: "700",
  } as const,
  scheduledBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: "rgba(245, 158, 11, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.25)",
  },
  scheduledText: {
    fontSize: 12,
    color: "#f59e0b",
    fontWeight: "600",
  } as const,
  emptyToday: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 28,
    gap: 10,
    backgroundColor: "rgba(255, 255, 255, 0.02)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 12,
    marginBottom: 16,
  },
  emptyTodayText: {
    fontSize: 12,
    color: "#6b7280",
    textAlign: "center",
  },
  todayList: {
    gap: 8,
    marginBottom: 16,
  },
  todayItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    borderRadius: 10,
    padding: 12,
  },
  todayBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    minWidth: 50,
    alignItems: "center",
  },
  todayBadgeText: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.5,
  } as const,
  todayItemBody: {
    flex: 1,
  },
  todayItemPrice: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
  } as const,
  todayItemMeta: {
    fontSize: 11,
    color: "#6b7280",
    marginTop: 2,
  },
  todayItemStatus: {
    fontSize: 12,
    fontWeight: "700",
    maxWidth: 110,
    textAlign: "right",
  } as const,
  moreText: {
    fontSize: 12,
    color: "#6b7280",
    textAlign: "center",
    marginTop: 4,
  },
  footerNote: {
    padding: 12,
    borderRadius: 10,
    backgroundColor: "rgba(59, 130, 246, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(59, 130, 246, 0.15)",
  },
  footerText: {
    fontSize: 11,
    color: "#93c5fd",
    lineHeight: 16,
    textAlign: "center",
  },
});
