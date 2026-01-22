import { View, Text, StyleSheet, ScrollView, Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { TrendingUp, Clock, Activity, BarChart3, Globe } from "lucide-react-native";
import { useTrading } from "@/contexts/TradingContext";
import { Stack } from "expo-router";

export default function OutlookScreen() {
  const { marketOutlook } = useTrading();

  if (!marketOutlook) {
    return <View style={styles.container} />;
  }

  const getPivotColor = (level: "r" | "s") => {
    return level === "r" ? "#22c55e" : "#ef4444";
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
              <Globe size={32} color="#FFD700" strokeWidth={2} />
              <View style={styles.headerTextContainer}>
                <Text style={styles.headerTitle}>Market Outlook</Text>
                <Text style={styles.headerSubtitle}>Real-Time Market Analysis</Text>
              </View>
            </View>

            <View style={styles.statusCard}>
              <LinearGradient
                colors={marketOutlook.isMarketOpen 
                  ? ["rgba(34, 197, 94, 0.15)", "rgba(34, 197, 94, 0.05)"]
                  : ["rgba(239, 68, 68, 0.15)", "rgba(239, 68, 68, 0.05)"]
                }
                style={styles.statusGradient}
              >
                <View style={styles.statusHeader}>
                  <Clock size={24} color={marketOutlook.isMarketOpen ? "#22c55e" : "#ef4444"} />
                  <Text style={styles.statusTitle}>Market Status</Text>
                </View>
                <Text style={[
                  styles.statusValue,
                  { color: marketOutlook.isMarketOpen ? "#22c55e" : "#ef4444" }
                ]}>
                  {marketOutlook.isMarketOpen ? "OPEN" : "CLOSED"}
                </Text>
                <Text style={styles.statusSubtext}>
                  {marketOutlook.isMarketOpen 
                    ? `Active Session: ${marketOutlook.currentSession}`
                    : "Market is currently closed for trading"}
                </Text>
              </LinearGradient>
            </View>

            <View style={styles.sessionCard}>
              <View style={styles.cardHeader}>
                <Activity size={20} color="#FFD700" />
                <Text style={styles.cardTitle}>Trading Sessions</Text>
              </View>
              {marketOutlook.sessions.map((session) => (
                <View 
                  key={session.name} 
                  style={[
                    styles.sessionRow,
                    session.isActive && styles.sessionRowActive
                  ]}
                >
                  <View style={[
                    styles.sessionDot,
                    session.isActive && styles.sessionDotActive
                  ]} />
                  <Text style={[
                    styles.sessionName,
                    session.isActive && styles.sessionNameActive
                  ]}>{session.name}</Text>
                  <Text style={[
                    styles.sessionStatus,
                    session.isActive && styles.sessionStatusActive
                  ]}>
                    {session.isActive ? "ACTIVE" : "INACTIVE"}
                  </Text>
                </View>
              ))}
              <View style={styles.sessionInfo}>
                <Text style={styles.sessionInfoText}>
                  • Asian: 00:00 - 06:00 UTC{"\n"}
                  • London: 06:00 - 13:00 UTC{"\n"}
                  • New York: 13:00 - 21:00 UTC
                </Text>
              </View>
            </View>

            <View style={styles.trendCard}>
              <View style={styles.cardHeader}>
                <TrendingUp size={20} color="#FFD700" />
                <Text style={styles.cardTitle}>Market Conditions</Text>
              </View>
              <View style={styles.conditionsGrid}>
                <View style={styles.conditionItem}>
                  <Text style={styles.conditionLabel}>Trend Direction</Text>
                  <View style={[
                    styles.conditionBadge,
                    { backgroundColor: 
                      marketOutlook.trend === "BULLISH" ? "rgba(34, 197, 94, 0.2)" :
                      marketOutlook.trend === "BEARISH" ? "rgba(239, 68, 68, 0.2)" :
                      "rgba(153, 153, 153, 0.2)"
                    }
                  ]}>
                    <Text style={[
                      styles.conditionValue,
                      { color: 
                        marketOutlook.trend === "BULLISH" ? "#22c55e" :
                        marketOutlook.trend === "BEARISH" ? "#ef4444" :
                        "#999"
                      }
                    ]}>
                      {marketOutlook.trend}
                    </Text>
                  </View>
                </View>
                <View style={styles.conditionItem}>
                  <Text style={styles.conditionLabel}>Volatility</Text>
                  <View style={[
                    styles.conditionBadge,
                    { backgroundColor: 
                      marketOutlook.volatility === "HIGH" ? "rgba(239, 68, 68, 0.2)" :
                      marketOutlook.volatility === "MEDIUM" ? "rgba(255, 165, 0, 0.2)" :
                      "rgba(34, 197, 94, 0.2)"
                    }
                  ]}>
                    <Text style={[
                      styles.conditionValue,
                      { color: 
                        marketOutlook.volatility === "HIGH" ? "#ef4444" :
                        marketOutlook.volatility === "MEDIUM" ? "#FFA500" :
                        "#22c55e"
                      }
                    ]}>
                      {marketOutlook.volatility}
                    </Text>
                  </View>
                </View>
              </View>
            </View>

            <View style={styles.pivotCard}>
              <View style={styles.cardHeader}>
                <BarChart3 size={20} color="#FFD700" />
                <Text style={styles.cardTitle}>Daily Pivot Points</Text>
              </View>
              <View style={styles.pivotRow}>
                <View style={styles.pivotLabelContainer}>
                  <View style={[styles.pivotDot, { backgroundColor: getPivotColor("r") }]} />
                  <Text style={styles.pivotLabel}>R3</Text>
                </View>
                <Text style={[styles.pivotValue, { color: getPivotColor("r") }]}>
                  ${marketOutlook.r3.toFixed(1)}
                </Text>
              </View>
              <View style={styles.pivotRow}>
                <View style={styles.pivotLabelContainer}>
                  <View style={[styles.pivotDot, { backgroundColor: getPivotColor("r") }]} />
                  <Text style={styles.pivotLabel}>R2</Text>
                </View>
                <Text style={[styles.pivotValue, { color: getPivotColor("r") }]}>
                  ${marketOutlook.r2.toFixed(1)}
                </Text>
              </View>
              <View style={styles.pivotRow}>
                <View style={styles.pivotLabelContainer}>
                  <View style={[styles.pivotDot, { backgroundColor: getPivotColor("r") }]} />
                  <Text style={styles.pivotLabel}>R1</Text>
                </View>
                <Text style={[styles.pivotValue, { color: getPivotColor("r") }]}>
                  ${marketOutlook.r1.toFixed(1)}
                </Text>
              </View>
              <View style={[styles.pivotRow, styles.pivotRowPrimary]}>
                <View style={styles.pivotLabelContainer}>
                  <View style={[styles.pivotDot, { backgroundColor: "#FFD700" }]} />
                  <Text style={[styles.pivotLabel, { color: "#FFD700" }]}>Pivot</Text>
                </View>
                <Text style={[styles.pivotValue, { color: "#FFD700", fontWeight: "700" as const }]}>
                  ${marketOutlook.dailyPivot.toFixed(1)}
                </Text>
              </View>
              <View style={styles.pivotRow}>
                <View style={styles.pivotLabelContainer}>
                  <View style={[styles.pivotDot, { backgroundColor: getPivotColor("s") }]} />
                  <Text style={styles.pivotLabel}>S1</Text>
                </View>
                <Text style={[styles.pivotValue, { color: getPivotColor("s") }]}>
                  ${marketOutlook.s1.toFixed(1)}
                </Text>
              </View>
              <View style={styles.pivotRow}>
                <View style={styles.pivotLabelContainer}>
                  <View style={[styles.pivotDot, { backgroundColor: getPivotColor("s") }]} />
                  <Text style={styles.pivotLabel}>S2</Text>
                </View>
                <Text style={[styles.pivotValue, { color: getPivotColor("s") }]}>
                  ${marketOutlook.s2.toFixed(1)}
                </Text>
              </View>
              <View style={styles.pivotRow}>
                <View style={styles.pivotLabelContainer}>
                  <View style={[styles.pivotDot, { backgroundColor: getPivotColor("s") }]} />
                  <Text style={styles.pivotLabel}>S3</Text>
                </View>
                <Text style={[styles.pivotValue, { color: getPivotColor("s") }]}>
                  ${marketOutlook.s3.toFixed(1)}
                </Text>
              </View>
              <View style={styles.pivotInfo}>
                <Text style={styles.pivotInfoText}>
                  Pivot points are calculated from previous day&apos;s high, low, and close prices
                </Text>
              </View>
            </View>

            <View style={styles.infoCard}>
              <Text style={styles.infoTitle}>Market Hours</Text>
              <Text style={styles.infoText}>
                The gold market operates 24 hours during weekdays. Weekend closures occur from Friday 21:00 UTC until Sunday 22:00 UTC.
              </Text>
              <Text style={styles.infoText}>
                Most liquid trading occurs during London and New York sessions with highest volatility.
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
  statusCard: {
    marginBottom: 20,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  statusGradient: {
    padding: 24,
  },
  statusHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
    gap: 12,
  },
  statusTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: "#fff",
  } as const,
  statusValue: {
    fontSize: 32,
    fontWeight: "700",
    marginBottom: 8,
  } as const,
  statusSubtext: {
    fontSize: 14,
    color: "#999",
  },
  sessionCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
    gap: 8,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
  } as const,
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderRadius: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  sessionRowActive: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  sessionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#444",
    marginRight: 12,
  },
  sessionDotActive: {
    backgroundColor: "#22c55e",
  },
  sessionName: {
    flex: 1,
    fontSize: 16,
    fontWeight: "600",
    color: "#999",
  } as const,
  sessionNameActive: {
    color: "#fff",
  },
  sessionStatus: {
    fontSize: 12,
    fontWeight: "600",
    color: "#666",
    letterSpacing: 0.5,
  } as const,
  sessionStatusActive: {
    color: "#22c55e",
  },
  sessionInfo: {
    marginTop: 12,
    padding: 12,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: 8,
  },
  sessionInfoText: {
    fontSize: 12,
    color: "#999",
    lineHeight: 18,
  },
  trendCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  conditionsGrid: {
    flexDirection: "row",
    gap: 12,
  },
  conditionItem: {
    flex: 1,
  },
  conditionLabel: {
    fontSize: 12,
    color: "#999",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  conditionBadge: {
    padding: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  conditionValue: {
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.5,
  } as const,
  pivotCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  pivotRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255, 255, 255, 0.05)",
  },
  pivotRowPrimary: {
    backgroundColor: "rgba(255, 215, 0, 0.05)",
    paddingHorizontal: 12,
    marginHorizontal: -12,
    borderRadius: 8,
    borderBottomWidth: 0,
    marginVertical: 4,
  },
  pivotLabelContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pivotDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  pivotLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#ccc",
  } as const,
  pivotValue: {
    fontSize: 16,
    fontWeight: "600",
  } as const,
  pivotInfo: {
    marginTop: 16,
    padding: 12,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: 8,
  },
  pivotInfoText: {
    fontSize: 11,
    color: "#999",
    lineHeight: 16,
  },
  infoCard: {
    backgroundColor: "rgba(255, 165, 0, 0.05)",
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 165, 0, 0.2)",
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFA500",
    marginBottom: 12,
  } as const,
  infoText: {
    fontSize: 13,
    color: "#ccc",
    lineHeight: 20,
    marginBottom: 8,
  },
});
