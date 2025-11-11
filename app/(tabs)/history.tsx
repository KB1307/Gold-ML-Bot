import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { History, TrendingUp, TrendingDown, Trash2, CheckCircle, XCircle } from "lucide-react-native";
import { useTrading } from "@/contexts/TradingContext";
import { Stack } from "expo-router";
import { TradingSignal } from "@/types/trading";

export default function HistoryScreen() {
  const { signalHistory, deleteSignalFromHistory } = useTrading();

  const handleDelete = (signalId: string) => {
    if (Platform.OS === "web") {
      if (confirm("Delete this signal from history? This will not affect the learning engine.")) {
        deleteSignalFromHistory(signalId);
      }
    } else {
      Alert.alert(
        "Delete Signal",
        "Remove this signal from history? This will not affect the learning engine.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => deleteSignalFromHistory(signalId) },
        ]
      );
    }
  };

  const getStatusColor = (status: TradingSignal["status"]) => {
    switch (status) {
      case "ALL_TARGETS_HIT":
      case "TP3_HIT":
        return "#22c55e";
      case "TP2_HIT":
      case "TP1_HIT":
        return "#FFA500";
      case "SL_HIT":
        return "#ef4444";
      default:
        return "#999";
    }
  };

  const getStatusIcon = (status: TradingSignal["status"]) => {
    if (status === "SL_HIT") {
      return <XCircle size={16} color="#ef4444" />;
    }
    return <CheckCircle size={16} color="#22c55e" />;
  };

  const getStatusLabel = (status: TradingSignal["status"], targetsHit: number) => {
    if (status === "CLOSED" && targetsHit === 3) return "All Targets Acquired";
    if (status === "CLOSED" && targetsHit < 3) return "Stop Loss Hit";
    if (status === "SL_HIT") return "Stop Loss Hit";
    if (status === "ALL_TARGETS_HIT" || targetsHit === 3) return "All Targets Acquired";
    if (targetsHit > 0) return `${targetsHit}/3 Targets Hit`;
    return "Active";
  };

  return (
    <>
      <Stack.Screen options={{ 
        headerShown: false,
      }} />
      <View style={styles.container}>
        <LinearGradient
          colors={["#0a0a0a", "#1a1a2e"]}
          style={styles.gradient}
        >
          <ScrollView 
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.header}>
              <History size={32} color="#FFD700" strokeWidth={2} />
              <View style={styles.headerTextContainer}>
                <Text style={styles.headerTitle}>Signal History</Text>
                <Text style={styles.headerSubtitle}>{signalHistory.length} Total Signals</Text>
              </View>
            </View>

            {signalHistory.length === 0 ? (
              <View style={styles.emptyState}>
                <History size={64} color="#444" strokeWidth={1.5} />
                <Text style={styles.emptyTitle}>No Signal History</Text>
                <Text style={styles.emptyText}>
                  Closed signals will appear here. The learning engine tracks all signals for continuous improvement.
                </Text>
              </View>
            ) : (
              <View style={styles.signalList}>
                {signalHistory.map((signal) => (
                  <View key={signal.id} style={styles.signalCard}>
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
                            <Text style={styles.signalDate}>
                              {signal.timestamp.toLocaleDateString()} {signal.entryTime} UTC
                            </Text>
                          </View>
                        </View>
                        <TouchableOpacity
                          onPress={() => handleDelete(signal.id)}
                          style={styles.deleteButton}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
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
                          <Text style={styles.confidenceText}>{(signal.confidence * 100).toFixed(0)}%</Text>
                        </View>
                      </View>

                      <View style={styles.priceGrid}>
                        <View style={styles.priceColumn}>
                          <Text style={styles.priceLabel}>Entry</Text>
                          <Text style={styles.priceValue}>${signal.entryPrice.toFixed(1)}</Text>
                        </View>
                        <View style={[
                          styles.priceColumn, 
                          signal.targetsHit >= 1 && styles.targetHit
                        ]}>
                          <Text style={styles.priceLabel}>TP1</Text>
                          <Text style={[
                            styles.priceValue, 
                            signal.targetsHit >= 1 && { color: "#22c55e" }
                          ]}>${signal.tp1.toFixed(1)}</Text>
                        </View>
                        <View style={[
                          styles.priceColumn, 
                          signal.targetsHit >= 2 && styles.targetHit
                        ]}>
                          <Text style={styles.priceLabel}>TP2</Text>
                          <Text style={[
                            styles.priceValue, 
                            signal.targetsHit >= 2 && { color: "#22c55e" }
                          ]}>${signal.tp2.toFixed(1)}</Text>
                        </View>
                        <View style={[
                          styles.priceColumn, 
                          signal.targetsHit >= 3 && styles.targetHit
                        ]}>
                          <Text style={styles.priceLabel}>TP3</Text>
                          <Text style={[
                            styles.priceValue, 
                            signal.targetsHit >= 3 && { color: "#22c55e" }
                          ]}>${signal.tp3.toFixed(1)}</Text>
                        </View>
                      </View>

                      <View style={styles.slRow}>
                        <Text style={styles.slLabel}>Stop Loss</Text>
                        <Text style={[
                          styles.slValue,
                          { color: signal.status === "SL_HIT" || signal.status === "CLOSED" ? "#ef4444" : "#999" }
                        ]}>${signal.sl.toFixed(1)}</Text>
                      </View>

                      {signal.exitTime && (
                        <View style={styles.exitInfo}>
                          <Text style={styles.exitText}>Exit: {signal.exitTime} UTC</Text>
                        </View>
                      )}
                    </LinearGradient>
                  </View>
                ))}
              </View>
            )}

            <View style={styles.infoCard}>
              <Text style={styles.infoText}>
                Deleting signals from history only removes them from your view. All signals remain in the learning engine&apos;s database for continuous model improvement.
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
  headerTitle: {
    fontSize: 28,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 4,
  } as const,
  headerSubtitle: {
    fontSize: 14,
    color: "#999",
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
  signalList: {
    gap: 16,
    marginBottom: 20,
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
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 2,
  } as const,
  signalDate: {
    fontSize: 12,
    color: "#999",
  },
  deleteButton: {
    padding: 8,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
    gap: 8,
  },
  statusText: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
  } as const,
  confidenceBadge: {
    backgroundColor: "rgba(255, 215, 0, 0.15)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  confidenceText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#FFD700",
  } as const,
  priceGrid: {
    flexDirection: "row",
    marginBottom: 12,
    gap: 8,
  },
  priceColumn: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.2)",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  targetHit: {
    backgroundColor: "rgba(34, 197, 94, 0.15)",
    borderColor: "rgba(34, 197, 94, 0.3)",
    borderWidth: 1.5,
  },
  priceLabel: {
    fontSize: 10,
    color: "#999",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  priceValue: {
    fontSize: 13,
    fontWeight: "700",
    color: "#fff",
  } as const,
  slRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: "rgba(0, 0, 0, 0.2)",
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  slLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#ef4444",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  } as const,
  slValue: {
    fontSize: 14,
    fontWeight: "700",
  } as const,
  exitInfo: {
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.05)",
  },
  exitText: {
    fontSize: 11,
    color: "#999",
  },
  infoCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  infoText: {
    fontSize: 12,
    color: "#999",
    lineHeight: 18,
  },
});
