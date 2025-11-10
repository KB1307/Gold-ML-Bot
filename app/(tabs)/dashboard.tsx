import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { TrendingUp, TrendingDown, Target, Shield, Clock, Zap, BarChart3, Percent, AlertTriangle, Activity } from "lucide-react-native";
import { useTrading } from "@/contexts/TradingContext";
import { Stack } from "expo-router";
import PriceChart from "@/components/PriceChart";

export default function DashboardScreen() {
  const { currentSignal, marketOutlook, performanceMetrics, positionSizing, currentPrice, priceHistory } = useTrading();

  if (!marketOutlook) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#FFD700" />
      </View>
    );
  }

  const getProgressPercentage = () => {
    if (!currentSignal) return 0;
    
    const entry = currentSignal.entryPrice;
    const target = currentSignal.type === "BUY" ? currentSignal.tp3 : currentSignal.tp3;
    const range = Math.abs(target - entry);
    const progress = Math.abs(currentPrice - entry);
    
    return Math.min(100, (progress / range) * 100);
  };

  const calculatePnL = () => {
    if (!currentSignal) return 0;
    
    const diff = currentSignal.type === "BUY" 
      ? currentPrice - currentSignal.entryPrice 
      : currentSignal.entryPrice - currentPrice;
    
    return diff;
  };

  const pnl = calculatePnL();
  const progress = getProgressPercentage();

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
              <View>
                <Text style={styles.headerTitle}>XAUUSD</Text>
                <Text style={styles.headerSubtitle}>Gold Trading Signals</Text>
              </View>
              <View style={styles.priceContainer}>
                <Text style={styles.currentPrice}>${currentPrice.toFixed(1)}</Text>
                <View style={[styles.sessionBadge, marketOutlook.isMarketOpen && styles.sessionBadgeActive]}>
                  <View style={[styles.sessionDot, marketOutlook.isMarketOpen && styles.sessionDotActive]} />
                  <Text style={styles.sessionText}>
                    {marketOutlook.isMarketOpen ? marketOutlook.currentSession : "CLOSED"}
                  </Text>
                </View>
              </View>
            </View>

            {priceHistory && priceHistory.length > 1 && (
              <View style={styles.chartCard}>
                <View style={styles.chartContainer}>
                  <PriceChart data={priceHistory} currentPrice={currentPrice} />
                </View>
              </View>
            )}

            {!marketOutlook.isMarketOpen && (
              <View style={styles.closedBanner}>
                <Clock size={16} color="#FFA500" />
                <Text style={styles.closedText}>Market is currently closed. No signals will be generated.</Text>
              </View>
            )}

            {currentSignal ? (
              <View style={styles.signalCard}>
                <LinearGradient
                  colors={currentSignal.type === "BUY" 
                    ? ["rgba(34, 197, 94, 0.15)", "rgba(34, 197, 94, 0.05)"]
                    : ["rgba(239, 68, 68, 0.15)", "rgba(239, 68, 68, 0.05)"]
                  }
                  style={styles.signalGradient}
                >
                  <View style={styles.signalHeader}>
                    <View style={styles.signalTypeContainer}>
                      {currentSignal.type === "BUY" ? (
                        <TrendingUp size={32} color="#22c55e" strokeWidth={2.5} />
                      ) : (
                        <TrendingDown size={32} color="#ef4444" strokeWidth={2.5} />
                      )}
                      <View>
                        <Text style={styles.signalType}>{currentSignal.type} SIGNAL</Text>
                        <Text style={styles.signalTime}>{currentSignal.entryTime} UTC</Text>
                      </View>
                    </View>
                    <View style={styles.confidenceContainer}>
                      <Zap size={16} color="#FFD700" fill="#FFD700" />
                      <Text style={styles.confidenceText}>{(currentSignal.confidence * 100).toFixed(0)}%</Text>
                    </View>
                  </View>

                  {currentSignal.latencyWarning && currentSignal.latencyWarning > 100 && (
                    <View style={styles.warningBanner}>
                      <AlertTriangle size={14} color="#FFA500" />
                      <Text style={styles.warningText}>High Latency: {currentSignal.latencyWarning}ms - Entry price may have shifted</Text>
                    </View>
                  )}

                  {currentSignal.nextMoveContext && (
                    <View style={styles.contextBanner}>
                      <Activity size={14} color="#9C27B0" />
                      <Text style={styles.contextText}>{currentSignal.nextMoveContext}</Text>
                    </View>
                  )}

                  <View style={styles.divider} />

                  <View style={styles.priceGrid}>
                    <View style={styles.priceItem}>
                      <Text style={styles.priceLabel}>Entry</Text>
                      <Text style={styles.priceValue}>${currentSignal.entryPrice.toFixed(1)}</Text>
                    </View>
                    <View style={styles.priceItem}>
                      <Text style={[styles.priceLabel, { color: pnl >= 0 ? "#22c55e" : "#ef4444" }]}>P/L</Text>
                      <Text style={[styles.priceValue, { color: pnl >= 0 ? "#22c55e" : "#ef4444" }]}>
                        {pnl >= 0 ? "+" : ""}{pnl.toFixed(1)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.progressContainer}>
                    <View style={styles.progressBar}>
                      <View style={[
                        styles.progressFill, 
                        { 
                          width: `${progress}%`,
                          backgroundColor: currentSignal.type === "BUY" ? "#22c55e" : "#ef4444"
                        }
                      ]} />
                    </View>
                    <Text style={styles.progressText}>{progress.toFixed(0)}% to TP3</Text>
                  </View>

                  <View style={styles.targetsContainer}>
                    <View style={styles.targetRow}>
                      <Target size={16} color="#22c55e" />
                      <Text style={styles.targetLabel}>TP1</Text>
                      <Text style={styles.targetValue}>${currentSignal.tp1.toFixed(1)}</Text>
                      {currentSignal.targetsHit >= 1 && (
                        <View style={styles.hitBadge}>
                          <Text style={styles.hitText}>HIT</Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.targetRow}>
                      <Target size={16} color="#22c55e" />
                      <Text style={styles.targetLabel}>TP2</Text>
                      <Text style={styles.targetValue}>${currentSignal.tp2.toFixed(1)}</Text>
                      {currentSignal.targetsHit >= 2 && (
                        <View style={styles.hitBadge}>
                          <Text style={styles.hitText}>HIT</Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.targetRow}>
                      <Target size={16} color="#22c55e" />
                      <Text style={styles.targetLabel}>TP3</Text>
                      <Text style={styles.targetValue}>${currentSignal.tp3.toFixed(1)}</Text>
                      {currentSignal.targetsHit >= 3 && (
                        <View style={styles.hitBadge}>
                          <Text style={styles.hitText}>HIT</Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.targetRow}>
                      <Shield size={16} color="#ef4444" />
                      <Text style={[styles.targetLabel, { color: "#ef4444" }]}>SL</Text>
                      <Text style={[styles.targetValue, { color: "#ef4444" }]}>${currentSignal.sl.toFixed(1)}</Text>
                    </View>
                  </View>
                </LinearGradient>
              </View>
            ) : (
              <View style={styles.noSignalCard}>
                <TrendingUp size={48} color="#444" strokeWidth={1.5} />
                <Text style={styles.noSignalTitle}>No Active Signal</Text>
                <Text style={styles.noSignalText}>
                  {marketOutlook.isMarketOpen 
                    ? "Analyzing market conditions. New signal will appear when high-confidence setup is detected."
                    : "Market is closed. Signals will resume when market opens."
                  }
                </Text>
              </View>
            )}

            {performanceMetrics.totalTrades > 0 && (
              <View style={styles.metricsCard}>
                <View style={styles.metricsHeader}>
                  <BarChart3 size={20} color="#FFD700" />
                  <Text style={styles.sectionTitle}>Performance Metrics</Text>
                </View>
                
                {performanceMetrics.modelHealthScore !== undefined && (
                  <View style={[
                    styles.healthScoreBanner,
                    performanceMetrics.modelHealthScore < 70 && styles.healthScoreWarning
                  ]}>
                    <Activity size={16} color={performanceMetrics.modelHealthScore < 70 ? "#FFA500" : "#22c55e"} />
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={styles.healthScoreLabel}>Model Health Score</Text>
                        <Text style={[
                          styles.healthScoreValue,
                          { color: performanceMetrics.modelHealthScore < 70 ? "#FFA500" : "#22c55e" }
                        ]}>{performanceMetrics.modelHealthScore.toFixed(0)}/100</Text>
                      </View>
                      {performanceMetrics.featureCorrelationStatus && (
                        <Text style={styles.healthScoreSubtext}>Feature Correlation: {performanceMetrics.featureCorrelationStatus}</Text>
                      )}
                      {performanceMetrics.modelHealthScore < 70 && (
                        <Text style={styles.healthScoreWarningText}>System check recommended before degradation</Text>
                      )}
                    </View>
                  </View>
                )}
                
                <View style={styles.metricsGrid}>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Total Trades</Text>
                    <Text style={styles.metricValue}>{performanceMetrics.totalTrades}</Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Win Rate</Text>
                    <Text style={[styles.metricValue, { color: performanceMetrics.winRate >= 60 ? "#22c55e" : "#ef4444" }]}>
                      {performanceMetrics.winRate.toFixed(1)}%
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Profit Factor</Text>
                    <Text style={[styles.metricValue, { color: performanceMetrics.profitFactor >= 2 ? "#22c55e" : "#ef4444" }]}>
                      {performanceMetrics.profitFactor.toFixed(2)}
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Sharpe Ratio</Text>
                    <Text style={[styles.metricValue, { color: performanceMetrics.sharpeRatio >= 1.5 ? "#22c55e" : "#ef4444" }]}>
                      {performanceMetrics.sharpeRatio.toFixed(2)}
                    </Text>
                  </View>
                </View>

                <View style={styles.divider} />

                <View style={styles.metricsGrid}>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Total P/L</Text>
                    <Text style={[styles.metricValue, { color: (performanceMetrics.totalProfit - performanceMetrics.totalLoss) >= 0 ? "#22c55e" : "#ef4444" }]}>
                      ${(performanceMetrics.totalProfit - performanceMetrics.totalLoss).toFixed(2)}
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Max Drawdown</Text>
                    <Text style={[styles.metricValue, { color: "#ef4444" }]}>
                      {performanceMetrics.maxDrawdown.toFixed(2)}%
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Avg Win</Text>
                    <Text style={[styles.metricValue, { color: "#22c55e" }]}>
                      ${performanceMetrics.averageWin.toFixed(2)}
                    </Text>
                  </View>
                  <View style={styles.metricBox}>
                    <Text style={styles.metricLabel}>Avg Loss</Text>
                    <Text style={[styles.metricValue, { color: "#ef4444" }]}>
                      ${performanceMetrics.averageLoss.toFixed(2)}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {positionSizing && currentSignal && (
              <View style={styles.positionCard}>
                <View style={styles.positionHeader}>
                  <Percent size={16} color="#FFD700" />
                  <Text style={styles.sectionTitle}>Dynamic Position Sizing</Text>
                </View>
                
                <View style={styles.positionGrid}>
                  <View style={styles.positionItem}>
                    <Text style={styles.positionLabel}>Base Size</Text>
                    <Text style={styles.positionValue}>{positionSizing.baseSize.toFixed(2)} lots</Text>
                  </View>
                  <View style={styles.positionItem}>
                    <Text style={styles.positionLabel}>Confidence Multiplier</Text>
                    <Text style={[styles.positionValue, { color: "#FFD700" }]}>{positionSizing.confidenceMultiplier}x</Text>
                  </View>
                  <View style={styles.positionItem}>
                    <Text style={styles.positionLabel}>Recommended Size</Text>
                    <Text style={[styles.positionValue, { color: "#22c55e" }]}>{positionSizing.recommendedSize.toFixed(2)} lots</Text>
                  </View>
                  <View style={styles.positionItem}>
                    <Text style={styles.positionLabel}>Risk %</Text>
                    <Text style={[styles.positionValue, { color: positionSizing.riskPercentage > 5 ? "#ef4444" : "#22c55e" }]}>
                      {positionSizing.riskPercentage.toFixed(2)}%
                    </Text>
                  </View>
                </View>
              </View>
            )}

            <View style={styles.marketInfoCard}>
              <Text style={styles.sectionTitle}>Market Status</Text>
              <View style={styles.sessionGrid}>
                {marketOutlook.sessions.map((session) => {
                  let hours = "";
                  if (session.name === "ASIAN") {
                    hours = "00:00-06:00\n21:00-24:00 UTC";
                  } else if (session.name === "LONDON") {
                    hours = "06:00-13:00 UTC";
                  } else if (session.name === "NEW_YORK") {
                    hours = "13:00-21:00 UTC";
                  }
                  
                  return (
                    <View 
                      key={session.name} 
                      style={[
                        styles.sessionCard,
                        session.isActive && styles.sessionCardActive
                      ]}
                    >
                      <View style={[
                        styles.sessionIndicator,
                        session.isActive && styles.sessionIndicatorActive
                      ]} />
                      <Text style={[
                        styles.sessionName,
                        session.isActive && styles.sessionNameActive
                      ]}>{session.name}</Text>
                      <Text style={styles.sessionHours}>{hours}</Text>
                    </View>
                  );
                })}
              </View>
              
              <View style={styles.statsRow}>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>Trend</Text>
                  <Text style={[
                    styles.statValue,
                    { color: marketOutlook.trend === "BULLISH" ? "#22c55e" : 
                             marketOutlook.trend === "BEARISH" ? "#ef4444" : "#999" }
                  ]}>{marketOutlook.trend}</Text>
                </View>
                <View style={styles.statItem}>
                  <Text style={styles.statLabel}>Volatility</Text>
                  <Text style={styles.statValue}>{marketOutlook.volatility}</Text>
                </View>
              </View>

              <View style={styles.divider} />

              <Text style={styles.srTitle}>Support & Resistance Zones</Text>
              <View style={styles.srGrid}>
                <View style={styles.srColumn}>
                  <Text style={styles.srColumnTitle}>Resistance</Text>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>R3</Text>
                    <Text style={[styles.srValue, { color: "#ef4444" }]}>${marketOutlook.r3.toFixed(1)}</Text>
                  </View>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>R2</Text>
                    <Text style={[styles.srValue, { color: "#ef4444" }]}>${marketOutlook.r2.toFixed(1)}</Text>
                  </View>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>R1</Text>
                    <Text style={[styles.srValue, { color: "#ef4444" }]}>${marketOutlook.r1.toFixed(1)}</Text>
                  </View>
                </View>
                <View style={styles.srDivider} />
                <View style={styles.srColumn}>
                  <Text style={styles.srColumnTitle}>Support</Text>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>S1</Text>
                    <Text style={[styles.srValue, { color: "#22c55e" }]}>${marketOutlook.s1.toFixed(1)}</Text>
                  </View>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>S2</Text>
                    <Text style={[styles.srValue, { color: "#22c55e" }]}>${marketOutlook.s2.toFixed(1)}</Text>
                  </View>
                  <View style={styles.srItem}>
                    <Text style={styles.srLabel}>S3</Text>
                    <Text style={[styles.srValue, { color: "#22c55e" }]}>${marketOutlook.s3.toFixed(1)}</Text>
                  </View>
                </View>
              </View>
              <View style={styles.pivotRow}>
                <Text style={styles.pivotLabel}>Daily Pivot</Text>
                <Text style={styles.pivotValue}>${marketOutlook.dailyPivot.toFixed(1)}</Text>
              </View>
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
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
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
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
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
  priceContainer: {
    alignItems: "flex-end",
  },
  currentPrice: {
    fontSize: 24,
    fontWeight: "700",
    color: "#FFD700",
    marginBottom: 8,
  } as const,
  sessionBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  sessionBadgeActive: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  sessionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#666",
    marginRight: 6,
  },
  sessionDotActive: {
    backgroundColor: "#22c55e",
  },
  sessionText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#999",
    letterSpacing: 0.5,
  } as const,
  closedBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 165, 0, 0.1)",
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 165, 0, 0.3)",
  },
  closedText: {
    flex: 1,
    fontSize: 13,
    color: "#FFA500",
    marginLeft: 12,
    lineHeight: 18,
  },
  signalCard: {
    marginBottom: 20,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  signalGradient: {
    padding: 20,
  },
  signalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
  },
  signalTypeContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  signalType: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 2,
  } as const,
  signalTime: {
    fontSize: 12,
    color: "#999",
  },
  confidenceContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 215, 0, 0.15)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
  },
  confidenceText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFD700",
  } as const,
  divider: {
    height: 1,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    marginBottom: 20,
  },
  priceGrid: {
    flexDirection: "row",
    marginBottom: 20,
    gap: 16,
  },
  priceItem: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  priceLabel: {
    fontSize: 12,
    color: "#999",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  priceValue: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
  } as const,
  progressContainer: {
    marginBottom: 20,
  },
  progressBar: {
    height: 8,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressFill: {
    height: "100%",
    borderRadius: 4,
  },
  progressText: {
    fontSize: 11,
    color: "#999",
    textAlign: "right",
  },
  targetsContainer: {
    gap: 12,
  },
  targetRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  targetLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#fff",
    marginLeft: 8,
    flex: 1,
  } as const,
  targetValue: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
  } as const,
  hitBadge: {
    backgroundColor: "rgba(34, 197, 94, 0.2)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    marginLeft: 8,
  },
  hitText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#22c55e",
    letterSpacing: 0.5,
  } as const,
  noSignalCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 40,
    borderRadius: 16,
    alignItems: "center",
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  noSignalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#666",
    marginTop: 16,
    marginBottom: 8,
  } as const,
  noSignalText: {
    fontSize: 14,
    color: "#555",
    textAlign: "center",
    lineHeight: 20,
  },
  marketInfoCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 16,
  } as const,
  sessionGrid: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 20,
  },
  sessionCard: {
    flex: 1,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 12,
    borderRadius: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
    minHeight: 90,
  },
  sessionCardActive: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  sessionIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#333",
    marginBottom: 8,
  },
  sessionIndicatorActive: {
    backgroundColor: "#22c55e",
  },
  sessionName: {
    fontSize: 10,
    fontWeight: "600",
    color: "#666",
    textAlign: "center",
  } as const,
  sessionNameActive: {
    color: "#22c55e",
  },
  sessionHours: {
    fontSize: 8,
    color: "#555",
    textAlign: "center",
    marginTop: 6,
    lineHeight: 11,
  },
  statsRow: {
    flexDirection: "row",
    gap: 12,
  },
  statItem: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  statLabel: {
    fontSize: 11,
    color: "#999",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  statValue: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
  } as const,
  srTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#999",
    marginBottom: 12,
    marginTop: 4,
  } as const,
  srGrid: {
    flexDirection: "row",
    gap: 16,
  },
  srColumn: {
    flex: 1,
  },
  srColumnTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#FFD700",
    textAlign: "center",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 1,
  } as const,
  srItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 10,
    borderRadius: 8,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  srLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#999",
  } as const,
  srValue: {
    fontSize: 14,
    fontWeight: "700",
  } as const,
  srDivider: {
    width: 1,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
  pivotRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "rgba(255, 215, 0, 0.1)",
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.3)",
  },
  pivotLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: "#FFD700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  } as const,
  pivotValue: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFD700",
  } as const,
  metricsCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  metricsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
  },
  metricsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  metricBox: {
    flex: 1,
    minWidth: "45%",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  metricLabel: {
    fontSize: 11,
    color: "#999",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  metricValue: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
  } as const,
  positionCard: {
    backgroundColor: "rgba(255, 215, 0, 0.05)",
    padding: 12,
    borderRadius: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.2)",
  },
  positionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
  },
  positionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  positionItem: {
    flex: 1,
    minWidth: "45%",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.1)",
  },
  positionLabel: {
    fontSize: 9,
    color: "#999",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  positionValue: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
  } as const,
  warningBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 165, 0, 0.1)",
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255, 165, 0, 0.3)",
  },
  warningText: {
    flex: 1,
    fontSize: 11,
    color: "#FFA500",
    marginLeft: 8,
    lineHeight: 16,
  },
  contextBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "rgba(156, 39, 176, 0.1)",
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(156, 39, 176, 0.3)",
  },
  contextText: {
    flex: 1,
    fontSize: 11,
    color: "#9C27B0",
    marginLeft: 8,
    lineHeight: 16,
  },
  healthScoreBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  healthScoreWarning: {
    backgroundColor: "rgba(255, 165, 0, 0.1)",
    borderColor: "rgba(255, 165, 0, 0.3)",
  },
  healthScoreLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
  } as const,
  healthScoreValue: {
    fontSize: 18,
    fontWeight: "700",
  } as const,
  healthScoreSubtext: {
    fontSize: 11,
    color: "#999",
    marginTop: 4,
  },
  healthScoreWarningText: {
    fontSize: 10,
    color: "#FFA500",
    marginTop: 4,
    fontStyle: "italic",
  },
  chartCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  chartTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 16,
  } as const,
  chartContainer: {
    width: "100%",
    alignItems: "center",
  },
});
