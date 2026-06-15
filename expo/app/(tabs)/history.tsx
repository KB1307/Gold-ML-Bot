import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Alert, ActivityIndicator } from "react-native";
import { useEffect, useMemo, useState, useCallback } from "react";
import { LinearGradient } from "expo-linear-gradient";
import { History, TrendingUp, TrendingDown, Trash2, CheckCircle, XCircle, ShieldCheck } from "lucide-react-native";
import { useTrading, computeSignalPnL, getEffectiveExitPrice } from "@/contexts/TradingContext";
import { Stack } from "expo-router";
import { TradingSignal } from "@/types/trading";

const ACTIVE_SIGNAL_STATUSES: TradingSignal["status"][] = ["ACTIVE", "PARTIALLY_MANAGED", "TP1_HIT", "TP2_HIT"];

const TERMINAL_PNL_STATUSES: TradingSignal["status"][] = ["ALL_TARGETS_HIT", "TP3_HIT", "PARTIAL_WIN_SL_HIT", "SL_AFTER_BE", "SL_HIT", "CLOSED", "EXPIRED_MISSED_ENTRY"];

export default function HistoryScreen() {
  const { signalHistory, deleteSignalFromHistory, signalUpdateTrigger, isLoading, settings, runManualAudit } = useTrading();
  const [isAuditing, setIsAuditing] = useState<boolean>(false);

  const handleManualAudit = useCallback(async () => {
    if (isAuditing) return;
    const confirmMsg = "Run a full signal audit?\n\nThis re-evaluates every closed signal against 1-minute bar history (tick-by-wick). False SL/TP outcomes are corrected and performance metrics are refreshed.";
    const proceed = async () => {
      try {
        setIsAuditing(true);
        console.log("[History] Manual audit started by user");
        const result = await runManualAudit();
        const msg = result.corrected > 0
          ? `Audit complete: ${result.corrected} signal(s) corrected out of ${result.total} terminal signals. Performance metrics updated.`
          : `Audit complete: all ${result.total} terminal signals already correct.`;
        if (Platform.OS === "web") {
          alert(msg);
        } else {
          Alert.alert("Audit Complete", msg);
        }
      } catch (err) {
        console.error("[History] Manual audit failed:", err);
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        if (Platform.OS === "web") alert(`Audit failed: ${errMsg}`);
        else Alert.alert("Audit Failed", errMsg);
      } finally {
        setIsAuditing(false);
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(confirmMsg)) {
        void proceed();
      }
    } else {
      Alert.alert(
        "Manual Audit",
        confirmMsg,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Run Audit", onPress: () => { void proceed(); } },
        ],
      );
    }
  }, [isAuditing, runManualAudit]);

  const sortedSignalHistory = useMemo(() => (
    [...signalHistory].sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
  ), [signalHistory]);

  const activeSignals = useMemo(() => (
    sortedSignalHistory.filter((signal) => ACTIVE_SIGNAL_STATUSES.includes(signal.status))
  ), [sortedSignalHistory]);

  const closedSignals = useMemo(() => (
    sortedSignalHistory.filter((signal) => !ACTIVE_SIGNAL_STATUSES.includes(signal.status))
  ), [sortedSignalHistory]);

  useEffect(() => {
    console.log(`📋 History UI update triggered (TP status changed) - Trigger: ${signalUpdateTrigger}`);
  }, [signalUpdateTrigger, signalHistory]);

  const handleDelete = (signalId: string) => {
    if (Platform.OS === "web") {
      if (confirm("Delete this signal from history? This will not affect the learning engine.")) {
        void deleteSignalFromHistory(signalId);
      }
    } else {
      Alert.alert(
        "Delete Signal",
        "Remove this signal from history? This will not affect the learning engine.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => { void deleteSignalFromHistory(signalId); } },
        ]
      );
    }
  };

  const getStatusColor = (status: TradingSignal["status"]) => {
    switch (status) {
      case "ACTIVE":
      case "PARTIALLY_MANAGED":
        return "#38bdf8";
      case "TP2_HIT":
      case "TP1_HIT":
        return "#FFA500";
      case "ALL_TARGETS_HIT":
      case "TP3_HIT":
      case "PARTIAL_WIN_SL_HIT":
        return "#22c55e";
      case "SL_AFTER_BE":
        return "#FFD700";
      case "SL_HIT":
      case "EXPIRED_MISSED_ENTRY":
        return "#ef4444";
      default:
        return "#999";
    }
  };

  const safeDateString = (signal: TradingSignal): string => {
    try {
      return new Date(signal.timestamp).toLocaleString();
    } catch {
      return "Unknown date";
    }
  };

  const safeEntryPrice = (signal: TradingSignal): string => {
    try {
      return `$${(signal.entryPrice ?? 0).toFixed(1)}`;
    } catch {
      return "$0.0";
    }
  };

  const safeTpPrice = (signal: TradingSignal, tpKey: "tp1" | "tp2" | "tp3"): string => {
    try {
      return `$${(signal[tpKey] ?? 0).toFixed(1)}`;
    } catch {
      return "$0.0";
    }
  };

  const safeSlPrice = (signal: TradingSignal): string => {
    try {
      return `${(signal.sl ?? 0).toFixed(1)}`;
    } catch {
      return "0.0";
    }
  };

  const safeConfidence = (signal: TradingSignal): string => {
    try {
      return `${((signal.confidence ?? 0) * 100).toFixed(0)}%`;
    } catch {
      return "0%";
    }
  };

  const safeExitDisplay = (signal: TradingSignal): string => {
    try {
      return `${(signal.exitPrice ?? signal.entryPrice ?? 0).toFixed(1)}`;
    } catch {
      return "0.0";
    }
  };

  const safeEffectiveExitDisplay = (signal: TradingSignal): string => {
    try {
      const exit = getEffectiveExitPrice(signal);
      return `$${exit.toFixed(2)}`;
    } catch {
      return "$0.00";
    }
  };

  const safePnLDisplay = (signal: TradingSignal): { text: string; color: string } => {
    try {
      const pnl = computeSignalPnL(signal, settings.basePositionSize);
      const isWin = pnl > 0.01;
      const isLoss = pnl < -0.01;
      const color = isWin ? "#22c55e" : isLoss ? "#ef4444" : "#999";
      return { text: `${isWin ? "+" : ""}$${pnl.toFixed(2)}`, color };
    } catch {
      return { text: "$0.00", color: "#999" };
    }
  };

  const getStatusIcon = (status: TradingSignal["status"]) => {
    if (status === "SL_HIT" || status === "EXPIRED_MISSED_ENTRY") {
      return <XCircle size={16} color="#ef4444" />;
    }
    return <CheckCircle size={16} color={getStatusColor(status)} />;
  };

  const getStatusLabel = (status: TradingSignal["status"], targetsHit: number) => {
    if (status === "ACTIVE") return "Live Setup";
    if (status === "PARTIALLY_MANAGED") return "Managed Position";
    if (status === "SL_HIT") return "Stop Loss Hit";
    if (status === "SL_AFTER_BE") return "SL After Breakeven • TP1 Banked • No Capital Loss";
    if (status === "EXPIRED_MISSED_ENTRY") return "Missed Entry";
    if (status === "PARTIAL_WIN_SL_HIT") return "TP1 + TP2 Banked • Runner Breakeven";
    if (status === "ALL_TARGETS_HIT" || status === "TP3_HIT" || targetsHit === 3) return "All Targets Acquired";
    if (status === "CLOSED") {
      if (targetsHit === 3) return "All Targets Acquired";
      if (targetsHit > 0) return `Expired (${targetsHit}/3 Targets)`;
      return "Expired";
    }
    if (targetsHit > 0) return `${targetsHit}/3 Targets Hit`;
    return "Active";
  };

  const renderSignalCard = (signal: TradingSignal) => (
    <View key={signal.id} style={styles.signalCard} testID={`history-signal-card-${signal.id}`}>
      <LinearGradient
        colors={signal.type === "BUY"
          ? ["rgba(34, 197, 94, 0.08)", "rgba(34, 197, 94, 0.02)"]
          : ["rgba(239, 68, 68, 0.08)", "rgba(239, 68, 68, 0.02)"]
        }
        style={styles.signalGradient}
      >
        <View style={styles.signalHeader}>
          <View style={styles.signalTypeRow}>
            {signal.type === "BUY" ? (
              <TrendingUp size={24} color="#22c55e" strokeWidth={2} />
            ) : (
              <TrendingDown size={24} color="#ef4444" strokeWidth={2} />
            )}
            <View style={styles.signalInfo}>
              <Text style={styles.signalType}>{signal.type} XAUUSD</Text>
              <Text style={styles.signalDate}>{safeDateString(signal)}</Text>
            </View>
          </View>
          <TouchableOpacity
            onPress={() => handleDelete(signal.id)}
            style={styles.deleteButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            testID={`history-delete-${signal.id}`}
          >
            <Trash2 size={18} color="#666" />
          </TouchableOpacity>
        </View>

        <View style={styles.statusRow}>
          {getStatusIcon(signal.status)}
          <Text style={[styles.statusText, { color: getStatusColor(signal.status) }]}>
            {getStatusLabel(signal.status, signal.targetsHit)}
          </Text>
          <View style={styles.confidenceBadge}>
            <Text style={styles.confidenceText}>{safeConfidence(signal)}</Text>
          </View>
        </View>

        <View style={styles.priceGrid}>
          <View style={styles.priceColumn}>
            <Text style={styles.priceLabel}>Entry</Text>
            <Text style={styles.priceValue}>{safeEntryPrice(signal)}</Text>
          </View>
          <View style={[styles.priceColumn, signal.targetsHit >= 1 && styles.targetHit]}>
            <Text style={styles.priceLabel}>TP1</Text>
            <Text style={[styles.priceValue, signal.targetsHit >= 1 && styles.targetValueHit]}>{safeTpPrice(signal, "tp1")}</Text>
          </View>
          <View style={[styles.priceColumn, signal.targetsHit >= 2 && styles.targetHit]}>
            <Text style={styles.priceLabel}>TP2</Text>
            <Text style={[styles.priceValue, signal.targetsHit >= 2 && styles.targetValueHit]}>{safeTpPrice(signal, "tp2")}</Text>
          </View>
          <View style={[styles.priceColumn, signal.targetsHit >= 3 && styles.targetHit]}>
            <Text style={[styles.priceLabel]}>TP3</Text>
            <Text style={[styles.priceValue, signal.targetsHit >= 3 && styles.targetValueHit]}>{safeTpPrice(signal, "tp3")}</Text>
          </View>
        </View>

        <View style={[
          styles.slRow,
          signal.status === "SL_HIT" && styles.slRowLoss,
          (signal.status === "PARTIAL_WIN_SL_HIT" || signal.status === "SL_AFTER_BE") && styles.slRowWin,
        ]}>
          <Text style={styles.slLabel}>{(signal.status === "PARTIAL_WIN_SL_HIT" || signal.status === "SL_AFTER_BE") ? "Protected Exit" : "Stop Loss"}</Text>
          <Text
            style={[
              styles.slValue,
              signal.status === "SL_HIT"
                ? styles.slValueLoss
                : (signal.status === "PARTIAL_WIN_SL_HIT" || signal.status === "SL_AFTER_BE")
                  ? styles.slValueWin
                  : styles.slValueNeutral,
            ]}
          >
            {(signal.status === "PARTIAL_WIN_SL_HIT" || signal.status === "SL_AFTER_BE")
              ? safeExitDisplay(signal)
              : safeSlPrice(signal)}
          </Text>
        </View>

        {signal.breakevenReached && signal.breakevenTime && signal.status !== "ALL_TARGETS_HIT" ? (
          <View style={styles.breakevenMarker}>
            <View style={styles.breakevenIcon}>
              <Text style={styles.breakevenIconText}>⚖️</Text>
            </View>
            <View style={styles.breakevenContent}>
              <Text style={styles.breakevenTitle}>Breakeven Reached</Text>
              <Text style={styles.breakevenTime}>at {signal.breakevenTime}</Text>
            </View>
          </View>
        ) : null}

        {TERMINAL_PNL_STATUSES.includes(signal.status) ? (() => {
          const pnlData = safePnLDisplay(signal);
          return (
            <View style={styles.pnlRow} testID={`history-pnl-${signal.id}`}>
              <View style={styles.pnlBlock}>
                <Text style={styles.pnlLabel}>Effective Exit</Text>
                <Text style={styles.pnlExit}>{safeEffectiveExitDisplay(signal)}</Text>
              </View>
              <View style={styles.pnlBlock}>
                <Text style={styles.pnlLabel}>Net P/L</Text>
                <Text style={[styles.pnlValue, { color: pnlData.color }]}>
                  {pnlData.text}
                </Text>
              </View>
            </View>
          );
        })() : null}

        {signal.exitTime ? (
          <View style={styles.exitInfo}>
            <Text style={styles.exitText}>Exit: {signal.exitTime}</Text>
          </View>
        ) : null}
      </LinearGradient>
    </View>
  );

  const renderSection = (title: string, signals: TradingSignal[]) => {
    if (signals.length === 0) {
      return null;
    }

    return (
      <View style={styles.sectionBlock} testID={`history-section-${title.toLowerCase().replace(/\s+/g, "-")}`}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{title}</Text>
          <View style={styles.sectionCountBadge}>
            <Text style={styles.sectionCountText}>{signals.length}</Text>
          </View>
        </View>
        <View style={styles.signalList}>
          {signals.map(renderSignalCard)}
        </View>
      </View>
    );
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container}>
        <LinearGradient colors={["#0a0a0a", "#1a1a2e"]} style={styles.gradient}>
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.header}>
              <History size={32} color="#FFD700" strokeWidth={2} />
              <View style={styles.headerTextContainer}>
                <Text style={styles.headerTitle}>Signal History</Text>
                <Text style={styles.headerSubtitle}>
                  {sortedSignalHistory.length} Tracked Signals • {activeSignals.length} Active • {closedSignals.length} Closed
                </Text>
              </View>
              <TouchableOpacity
                onPress={handleManualAudit}
                disabled={isAuditing || isLoading}
                style={[styles.auditButton, (isAuditing || isLoading) && styles.auditButtonDisabled]}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                testID="history-manual-audit"
              >
                {isAuditing ? (
                  <ActivityIndicator size="small" color="#FFD700" />
                ) : (
                  <ShieldCheck size={18} color="#FFD700" strokeWidth={2} />
                )}
                <Text style={styles.auditButtonText}>{isAuditing ? "Auditing" : "Audit"}</Text>
              </TouchableOpacity>
            </View>

            {isLoading ? (
              <View style={styles.emptyState}>
                <History size={64} color="#444" strokeWidth={1.5} />
                <Text style={styles.emptyTitle}>Loading History...</Text>
                <Text style={styles.emptyText}>Retrieving your signal history from storage.</Text>
              </View>
            ) : sortedSignalHistory.length === 0 ? (
              <View style={styles.emptyState}>
                <History size={64} color="#444" strokeWidth={1.5} />
                <Text style={styles.emptyTitle}>No Signal History</Text>
                <Text style={styles.emptyText}>
                  Active and closed signals appear here automatically as soon as the engine creates them.
                </Text>
              </View>
            ) : (
              <View style={styles.signalSections}>
                {renderSection("Active Signals", activeSignals)}
                {renderSection("Closed Signals", closedSignals)}
              </View>
            )}

            <View style={styles.infoCard}>
              <Text style={styles.infoText}>
                Deleting signals from history only removes them from your view. Active and closed trade records continue to drive the learning engine until they are naturally replaced by newer model data.
              </Text>
            </View>
          </ScrollView>
        </LinearGradient>
      </View>
    </>
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
    padding: 20,
    paddingTop: Platform.OS === "ios" ? 60 : 20,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 24,
    gap: 16,
  },
  headerTextContainer: {
    flex: 1,
  },
  auditButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(255, 215, 0, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.35)",
  },
  auditButtonDisabled: {
    opacity: 0.5,
  },
  auditButtonText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#FFD700",
    letterSpacing: 0.3,
  } as const,
  headerTitle: {
    fontSize: 28,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 4,
  } as const,
  headerSubtitle: {
    fontSize: 14,
    color: "#999",
    lineHeight: 20,
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 80,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#666",
    marginTop: 20,
    marginBottom: 8,
  } as const,
  emptyText: {
    fontSize: 14,
    color: "#555",
    textAlign: "center",
    lineHeight: 20,
    paddingHorizontal: 40,
  },
  signalSections: {
    gap: 24,
    marginBottom: 20,
  },
  sectionBlock: {
    gap: 14,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
  } as const,
  sectionCountBadge: {
    minWidth: 28,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 215, 0, 0.14)",
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.24)",
  },
  sectionCountText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#FFD700",
  } as const,
  signalList: {
    gap: 16,
  },
  signalCard: {
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  signalGradient: {
    padding: 16,
  },
  signalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  signalTypeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  signalInfo: {
    flex: 1,
  },
  signalType: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 4,
  } as const,
  signalDate: {
    fontSize: 12,
    color: "#999",
  },
  deleteButton: {
    padding: 4,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 8,
  },
  statusText: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
  } as const,
  confidenceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "rgba(255, 215, 0, 0.15)",
    borderRadius: 6,
  },
  confidenceText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#FFD700",
  } as const,
  priceGrid: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 12,
  },
  priceColumn: {
    flex: 1,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    padding: 12,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  targetHit: {
    borderColor: "rgba(34, 197, 94, 0.3)",
    backgroundColor: "rgba(34, 197, 94, 0.08)",
  },
  targetValueHit: {
    color: "#22c55e",
  },
  priceLabel: {
    fontSize: 11,
    color: "#999",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  priceValue: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
  } as const,
  slRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  slRowLoss: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderColor: "rgba(239, 68, 68, 0.3)",
  },
  slRowWin: {
    backgroundColor: "rgba(34, 197, 94, 0.12)",
    borderColor: "rgba(34, 197, 94, 0.28)",
  },
  slLabel: {
    fontSize: 13,
    color: "#999",
    fontWeight: "600",
  } as const,
  slValue: {
    fontSize: 16,
    fontWeight: "700",
  } as const,
  slValueLoss: {
    color: "#ef4444",
  },
  slValueWin: {
    color: "#22c55e",
  },
  slValueNeutral: {
    color: "#999",
  },
  breakevenMarker: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 215, 0, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.3)",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    gap: 12,
  },
  breakevenIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255, 215, 0, 0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  breakevenIconText: {
    fontSize: 16,
  },
  breakevenContent: {
    flex: 1,
  },
  breakevenTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#FFD700",
    marginBottom: 2,
  } as const,
  breakevenTime: {
    fontSize: 12,
    color: "rgba(255, 215, 0, 0.7)",
  },
  exitInfo: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.05)",
  },
  exitText: {
    fontSize: 12,
    color: "#999",
  },
  pnlRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 12,
  },
  pnlBlock: {
    flex: 1,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  pnlLabel: {
    fontSize: 11,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  pnlExit: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
  } as const,
  pnlValue: {
    fontSize: 16,
    fontWeight: "700",
  } as const,
  infoCard: {
    backgroundColor: "rgba(59, 130, 246, 0.08)",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(59, 130, 246, 0.2)",
    marginTop: 4,
  },
  infoText: {
    fontSize: 13,
    color: "#93c5fd",
    lineHeight: 20,
  },
});
