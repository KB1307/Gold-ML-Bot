import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Platform, Switch, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Settings as SettingsIcon, Target, Shield, TrendingUp, LogOut, Save, Trash2, Activity, AlertTriangle, RefreshCw, Bell, Smartphone, Crown } from "lucide-react-native";
import { useTrading } from "@/contexts/TradingContext";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { useState, useEffect } from "react";
import { Stack, useRouter } from "expo-router";
import { getBackgroundTaskStatus } from "@/services/backgroundTaskService";

export default function SettingsScreen() {
  const { settings, updateSettings, logout, clearHistory, performanceMetrics, triggerManualRetrain, backgroundTaskActive } = useTrading();
  const { isPro } = useSubscription();
  const router = useRouter();
  const [isRetraining, setIsRetraining] = useState<boolean>(false);
  const [bgTaskStatus, setBgTaskStatus] = useState<{ isRegistered: boolean; isAvailable: boolean; } | null>(null);
  
  const [tp1Pips, setTp1Pips] = useState<string>(settings.tp1Pips.toString());
  const [tp2Pips, setTp2Pips] = useState<string>(settings.tp2Pips.toString());
  const [tp3Pips, setTp3Pips] = useState<string>(settings.tp3Pips.toString());
  const [slPips, setSlPips] = useState<string>(settings.slPips.toString());
  const [minConfidence, setMinConfidence] = useState<string>((settings.minConfidence * 100).toString());
  const [numberOfTPs, setNumberOfTPs] = useState<1 | 2 | 3>(settings.numberOfTPs);

  useEffect(() => {
    async function checkBackgroundTask() {
      if (Platform.OS !== 'web') {
        const status = await getBackgroundTaskStatus();
        setBgTaskStatus(status);
      }
    }
    checkBackgroundTask();
    const interval = setInterval(checkBackgroundTask, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleSave = async () => {
    await updateSettings({
      tp1Pips: parseFloat(tp1Pips) || settings.tp1Pips,
      tp2Pips: parseFloat(tp2Pips) || settings.tp2Pips,
      tp3Pips: parseFloat(tp3Pips) || settings.tp3Pips,
      slPips: parseFloat(slPips) || settings.slPips,
      minConfidence: parseFloat(minConfidence) / 100 || settings.minConfidence,
      numberOfTPs,
    });
    
    if (Platform.OS === 'web') {
      alert('Settings saved successfully!');
    } else {
      Alert.alert('Success', 'Settings saved successfully!');
    }
  };

  const handleLogout = async () => {
    await logout();
    router.replace("/");
  };

  const handleClearHistory = async () => {
    if (Platform.OS === 'web') {
      const confirm = window.confirm('Are you sure you want to clear all signal history? This cannot be undone.');
      if (confirm) {
        await clearHistory();
        alert('Signal history cleared successfully!');
      }
    } else {
      Alert.alert(
        'Clear History',
        'Are you sure you want to clear all signal history? This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          { 
            text: 'Clear', 
            style: 'destructive',
            onPress: async () => {
              await clearHistory();
              Alert.alert('Success', 'Signal history cleared successfully!');
            }
          },
        ]
      );
    }
  };

  const handleManualRetrain = async () => {
    if (Platform.OS === 'web') {
      const confirm = window.confirm('Trigger manual model retraining? This will recalculate feature weights based on recent trade outcomes.');
      if (!confirm) return;
    } else {
      await new Promise<void>((resolve) => {
        Alert.alert(
          'Manual Retraining',
          'Trigger manual model retraining? This will recalculate feature weights based on recent trade outcomes.',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve() },
            { 
              text: 'Retrain', 
              onPress: () => resolve()
            },
          ]
        );
      });
    }

    setIsRetraining(true);
    
    try {
      const result = await triggerManualRetrain('User-Initiated Bias Correction');
      
      if (Platform.OS === 'web') {
        alert(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
      } else {
        Alert.alert(
          result.success ? 'Success' : 'Error',
          result.message
        );
      }
    } finally {
      setIsRetraining(false);
    }
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
              <SettingsIcon size={32} color="#FFD700" strokeWidth={2} />
              <View style={styles.headerTextContainer}>
                <Text style={styles.headerTitle}>Settings</Text>
                <Text style={styles.headerSubtitle}>Configure Signal Parameters</Text>
              </View>
            </View>

            {!isPro && (
              <TouchableOpacity
                style={styles.proCard}
                onPress={() => router.push("/paywall" as any)}
                activeOpacity={0.8}
              >
                <LinearGradient
                  colors={["rgba(255,215,0,0.15)", "rgba(255,165,0,0.08)"]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.proCardGradient}
                >
                  <View style={styles.proCardLeft}>
                    <Crown size={24} color="#FFD700" />
                    <View>
                      <Text style={styles.proCardTitle}>Upgrade to Pro</Text>
                      <Text style={styles.proCardSubtitle}>Unlock all premium features</Text>
                    </View>
                  </View>
                  <View style={styles.proCardArrow}>
                    <Text style={styles.proCardArrowText}>{"\u203A"}</Text>
                  </View>
                </LinearGradient>
              </TouchableOpacity>
            )}

            {isPro && (
              <View style={styles.proActiveBadge}>
                <Crown size={16} color="#FFD700" />
                <Text style={styles.proActiveText}>Bullrun Pro Active</Text>
              </View>
            )}

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Target size={20} color="#22c55e" />
                <Text style={styles.sectionTitle}>Take Profit Levels (Pips)</Text>
              </View>
              
              <View style={styles.inputRow}>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>TP1</Text>
                  <TextInput
                    style={styles.input}
                    value={tp1Pips}
                    onChangeText={setTp1Pips}
                    keyboardType="decimal-pad"
                    placeholder="15"
                    placeholderTextColor="#666"
                  />
                </View>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>TP2</Text>
                  <TextInput
                    style={styles.input}
                    value={tp2Pips}
                    onChangeText={setTp2Pips}
                    keyboardType="decimal-pad"
                    placeholder="30"
                    placeholderTextColor="#666"
                  />
                </View>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>TP3</Text>
                  <TextInput
                    style={styles.input}
                    value={tp3Pips}
                    onChangeText={setTp3Pips}
                    keyboardType="decimal-pad"
                    placeholder="100"
                    placeholderTextColor="#666"
                  />
                </View>
              </View>

              <Text style={styles.helperText}>
                1 pip = 0.1 XAUUSD. Configure target distances from entry price.
              </Text>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Shield size={20} color="#ef4444" />
                <Text style={styles.sectionTitle}>Stop Loss (Pips)</Text>
              </View>
              
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Stop Loss Distance</Text>
                <TextInput
                  style={[styles.input, styles.inputFull]}
                  value={slPips}
                  onChangeText={setSlPips}
                  keyboardType="decimal-pad"
                  placeholder="120"
                  placeholderTextColor="#666"
                />
              </View>

              <Text style={styles.helperText}>
                Maximum loss tolerance from entry price.
              </Text>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <TrendingUp size={20} color="#FFD700" />
                <Text style={styles.sectionTitle}>Signal Configuration</Text>
              </View>
              
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Minimum Confidence (%)</Text>
                <TextInput
                  style={[styles.input, styles.inputFull]}
                  value={minConfidence}
                  onChangeText={setMinConfidence}
                  keyboardType="decimal-pad"
                  placeholder="70"
                  placeholderTextColor="#666"
                />
              </View>

              <Text style={styles.helperText}>
                Only generate signals with confidence above this threshold (55-98%).
              </Text>

              <View style={styles.tpSelector}>
                <Text style={styles.tpSelectorLabel}>Number of Take Profit Levels</Text>
                <View style={styles.tpButtons}>
                  {[1, 2, 3].map((num) => (
                    <TouchableOpacity
                      key={num}
                      style={[
                        styles.tpButton,
                        numberOfTPs === num && styles.tpButtonActive
                      ]}
                      onPress={() => {
                        setNumberOfTPs(num as 1 | 2 | 3);
                      }}
                    >
                      <Text style={[
                        styles.tpButtonText,
                        numberOfTPs === num && styles.tpButtonTextActive
                      ]}>
                        {num} TP{num > 1 ? "s" : ""}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
                <Save size={20} color="#FFD700" />
                <Text style={styles.saveButtonText}>Save Changes</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Bell size={20} color="#FFD700" />
                <Text style={styles.sectionTitle}>Notifications & Background</Text>
              </View>
              
              <View style={styles.switchRow}>
                <View style={styles.switchInfo}>
                  <Text style={styles.switchLabel}>Enable Signal Alerts</Text>
                  <Text style={styles.switchHelper}>Get notified when new signals are generated</Text>
                </View>
                <Switch
                  value={settings.enableNotifications}
                  onValueChange={(value) => updateSettings({ enableNotifications: value })}
                  trackColor={{ false: "#333", true: "rgba(255, 215, 0, 0.3)" }}
                  thumbColor={settings.enableNotifications ? "#FFD700" : "#666"}
                  ios_backgroundColor="#333"
                />
              </View>

              {Platform.OS !== 'web' && (
                <>
                  <View style={styles.divider} />
                  
                  <View style={styles.statusRow}>
                    <Smartphone size={16} color="#8b5cf6" />
                    <Text style={styles.statusLabel}>Background Task</Text>
                    <View style={[
                      styles.statusBadge,
                      backgroundTaskActive ? styles.statusBadgeActive : styles.statusBadgeInactive
                    ]}>
                      <Text style={styles.statusBadgeText}>
                        {backgroundTaskActive ? 'ACTIVE' : 'INACTIVE'}
                      </Text>
                    </View>
                  </View>

                  <Text style={styles.statusHelper}>
                    {backgroundTaskActive 
                      ? '✅ App will check for signals every 30s even when closed' 
                      : '⚠️ Enable notifications to activate background signal generation'}
                  </Text>

                  {bgTaskStatus && (
                    <View style={styles.techInfoContainer}>
                      <Text style={styles.techInfoTitle}>Technical Status</Text>
                      <View style={styles.techInfoRow}>
                        <Text style={styles.techInfoLabel}>Task Registered:</Text>
                        <Text style={[
                          styles.techInfoValue,
                          bgTaskStatus.isRegistered && styles.techInfoValueSuccess
                        ]}>
                          {bgTaskStatus.isRegistered ? 'YES' : 'NO'}
                        </Text>
                      </View>
                      <View style={styles.techInfoRow}>
                        <Text style={styles.techInfoLabel}>System Available:</Text>
                        <Text style={[
                          styles.techInfoValue,
                          bgTaskStatus.isAvailable && styles.techInfoValueSuccess
                        ]}>
                          {bgTaskStatus.isAvailable ? 'YES' : 'NO'}
                        </Text>
                      </View>
                    </View>
                  )}
                </>
              )}
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Activity size={20} color="#8b5cf6" />
                <Text style={styles.sectionTitle}>Model Health & Drift Detection</Text>
              </View>
              
              <View style={styles.healthRow}>
                <Text style={styles.healthLabel}>Model Health Score</Text>
                <View style={styles.healthValueContainer}>
                  <Text style={[
                    styles.healthValue,
                    (performanceMetrics.modelHealthScore || 100) >= 80 && styles.healthValueGood,
                    (performanceMetrics.modelHealthScore || 100) >= 50 && (performanceMetrics.modelHealthScore || 100) < 80 && styles.healthValueWarning,
                    (performanceMetrics.modelHealthScore || 100) < 50 && styles.healthValueCritical,
                  ]}>
                    {(performanceMetrics.modelHealthScore || 100).toFixed(0)}/100
                  </Text>
                </View>
              </View>

              <View style={styles.healthRow}>
                <Text style={styles.healthLabel}>Concept Drift Score</Text>
                <View style={styles.healthValueContainer}>
                  <Text style={[
                    styles.healthValue,
                    (performanceMetrics.conceptDriftScore || 0) < 0.2 && styles.healthValueGood,
                    (performanceMetrics.conceptDriftScore || 0) >= 0.2 && (performanceMetrics.conceptDriftScore || 0) < 0.4 && styles.healthValueWarning,
                    (performanceMetrics.conceptDriftScore || 0) >= 0.4 && styles.healthValueCritical,
                  ]}>
                    {(performanceMetrics.conceptDriftScore || 0).toFixed(2)}
                  </Text>
                </View>
              </View>

              <View style={styles.healthRow}>
                <Text style={styles.healthLabel}>Drift Alert Level</Text>
                <View style={[
                  styles.alertBadge,
                  performanceMetrics.driftAlertLevel === 'NONE' && styles.alertBadgeNone,
                  performanceMetrics.driftAlertLevel === 'LOW' && styles.alertBadgeLow,
                  performanceMetrics.driftAlertLevel === 'MEDIUM' && styles.alertBadgeMedium,
                  performanceMetrics.driftAlertLevel === 'HIGH' && styles.alertBadgeHigh,
                ]}>
                  <Text style={styles.alertBadgeText}>
                    {performanceMetrics.driftAlertLevel || 'NONE'}
                  </Text>
                </View>
              </View>

              <View style={styles.healthRow}>
                <Text style={styles.healthLabel}>Days Since Retrain</Text>
                <Text style={[
                  styles.healthValue,
                  (performanceMetrics.daysSinceRetrain || 0) < 7 && styles.healthValueGood,
                  (performanceMetrics.daysSinceRetrain || 0) >= 7 && (performanceMetrics.daysSinceRetrain || 0) < 14 && styles.healthValueWarning,
                  (performanceMetrics.daysSinceRetrain || 0) >= 14 && styles.healthValueCritical,
                ]}>
                  {(performanceMetrics.daysSinceRetrain || 0).toFixed(1)} days
                </Text>
              </View>

              <View style={styles.healthRow}>
                <Text style={styles.healthLabel}>Feature Correlation</Text>
                <Text style={[
                  styles.healthValue,
                  performanceMetrics.featureCorrelationStatus === 'HEALTHY' && styles.healthValueGood,
                  performanceMetrics.featureCorrelationStatus === 'MODERATE' && styles.healthValueWarning,
                  performanceMetrics.featureCorrelationStatus === 'POOR' && styles.healthValueCritical,
                ]}>
                  {performanceMetrics.featureCorrelationStatus || 'HEALTHY'}
                </Text>
              </View>

              {performanceMetrics.retrainingRecommended && (
                <View style={styles.retrainAlert}>
                  <AlertTriangle size={16} color="#f59e0b" />
                  <Text style={styles.retrainAlertText}>
                    Model retraining recommended. Drift detected or confidence degradation.
                  </Text>
                </View>
              )}

              {performanceMetrics.featureImportanceDrift && performanceMetrics.featureImportanceDrift.length > 0 && (
                <View style={styles.featureDriftContainer}>
                  <Text style={styles.featureDriftTitle}>Feature Importance Drift</Text>
                  {performanceMetrics.featureImportanceDrift.map((metric, idx) => (
                    <View key={idx} style={styles.featureDriftRow}>
                      <Text style={styles.featureDriftName}>{metric.feature}</Text>
                      <View style={styles.featureDriftValues}>
                        <Text style={styles.featureDriftText}>
                          {metric.historicalImportance.toFixed(3)} → {metric.currentImportance.toFixed(3)}
                        </Text>
                        <View style={[
                          styles.featureStatusBadge,
                          metric.status === 'STABLE' && styles.featureStatusStable,
                          metric.status === 'DEGRADING' && styles.featureStatusDegrading,
                          metric.status === 'CRITICAL' && styles.featureStatusCritical,
                        ]}>
                          <Text style={styles.featureStatusText}>{metric.status}</Text>
                        </View>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>

            <View style={styles.infoCard}>
              <Text style={styles.infoTitle}>About Signal Generation</Text>
              <Text style={styles.infoText}>
                The bot uses a Transformer-based deep learning model trained on historical XAUUSD data. Signal generation considers:{"\n\n"}
                • Asian/London/NY session S/R levels{"\n"}
                • Daily pivot points (R1-R3, S1-S3){"\n"}
                • RSI and ATR indicators{"\n"}
                • DXY correlation analysis{"\n"}
                • Volume ratio patterns{"\n\n"}
                The model continuously learns from live signal performance through reinforcement learning.
              </Text>
            </View>

            <TouchableOpacity 
              style={[styles.retrainButton, isRetraining && styles.retrainButtonDisabled]} 
              onPress={handleManualRetrain}
              disabled={isRetraining}
            >
              <RefreshCw size={20} color={isRetraining ? "#666" : "#8b5cf6"} />
              <Text style={[styles.retrainText, isRetraining && styles.retrainTextDisabled]}>
                {isRetraining ? 'Retraining Model...' : 'Manual Model Retrain'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.clearButton} onPress={handleClearHistory}>
              <Trash2 size={20} color="#f97316" />
              <Text style={styles.clearText}>Clear Signal History</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
              <LogOut size={20} color="#ef4444" />
              <Text style={styles.logoutText}>Logout</Text>
            </TouchableOpacity>

            <View style={styles.footer}>
              <Text style={styles.footerText}>XAUUSD Signal Bot v1.5</Text>
              <Text style={styles.footerText}>Powered by AI & ML</Text>
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
    marginBottom: 32,
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
  section: {
    marginBottom: 28,
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
  } as const,
  inputRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 12,
  },
  inputGroup: {
    flex: 1,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#999",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  } as const,
  input: {
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: "#fff",
    fontSize: 16,
  },
  inputFull: {
    width: "100%",
  },
  helperText: {
    fontSize: 12,
    color: "#666",
    lineHeight: 16,
  },
  tpSelector: {
    marginTop: 20,
  },
  tpSelectorLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#999",
    marginBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  } as const,
  tpButtons: {
    flexDirection: "row",
    gap: 8,
  },
  tpButton: {
    flex: 1,
    paddingVertical: 12,
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
    alignItems: "center",
  },
  tpButtonActive: {
    backgroundColor: "rgba(255, 215, 0, 0.15)",
    borderColor: "rgba(255, 215, 0, 0.3)",
  },
  tpButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#999",
  } as const,
  tpButtonTextActive: {
    color: "#FFD700",
  },
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  switchInfo: {
    flex: 1,
    marginRight: 16,
  },
  switchLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: "#fff",
    marginBottom: 4,
  } as const,
  switchHelper: {
    fontSize: 12,
    color: "#999",
    lineHeight: 16,
  },
  infoCard: {
    backgroundColor: "rgba(255, 215, 0, 0.05)",
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.2)",
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFD700",
    marginBottom: 12,
  } as const,
  infoText: {
    fontSize: 13,
    color: "#ccc",
    lineHeight: 20,
  },
  clearButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(249, 115, 22, 0.1)",
    paddingVertical: 16,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(249, 115, 22, 0.3)",
    gap: 8,
  },
  clearText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#f97316",
  } as const,
  logoutButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    paddingVertical: 16,
    borderRadius: 12,
    marginBottom: 32,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
    gap: 8,
  },
  logoutText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#ef4444",
  } as const,
  footer: {
    alignItems: "center",
    paddingBottom: 20,
  },
  footerText: {
    fontSize: 11,
    color: "#666",
    marginBottom: 4,
  },
  healthRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
    paddingVertical: 8,
  },
  healthLabel: {
    fontSize: 14,
    color: "#999",
    fontWeight: "500",
  } as const,
  healthValueContainer: {
    alignItems: "flex-end",
  },
  healthValue: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  } as const,
  healthValueGood: {
    color: "#22c55e",
  },
  healthValueWarning: {
    color: "#f59e0b",
  },
  healthValueCritical: {
    color: "#ef4444",
  },
  alertBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  alertBadgeNone: {
    backgroundColor: "rgba(34, 197, 94, 0.15)",
  },
  alertBadgeLow: {
    backgroundColor: "rgba(245, 158, 11, 0.15)",
  },
  alertBadgeMedium: {
    backgroundColor: "rgba(249, 115, 22, 0.15)",
  },
  alertBadgeHigh: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
  },
  alertBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#fff",
  } as const,
  retrainAlert: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(245, 158, 11, 0.1)",
    padding: 14,
    borderRadius: 10,
    marginTop: 12,
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.3)",
  },
  retrainAlertText: {
    flex: 1,
    fontSize: 13,
    color: "#f59e0b",
    lineHeight: 18,
  },
  featureDriftContainer: {
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.05)",
  },
  featureDriftTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#8b5cf6",
    marginBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  } as const,
  featureDriftRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  featureDriftName: {
    fontSize: 13,
    color: "#999",
    textTransform: "capitalize",
  },
  featureDriftValues: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  featureDriftText: {
    fontSize: 12,
    color: "#666",
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  featureStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  featureStatusStable: {
    backgroundColor: "rgba(34, 197, 94, 0.15)",
  },
  featureStatusDegrading: {
    backgroundColor: "rgba(245, 158, 11, 0.15)",
  },
  featureStatusCritical: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
  },
  featureStatusText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#fff",
    textTransform: "uppercase",
  } as const,
  saveButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 215, 0, 0.15)",
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 16,
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.3)",
    gap: 8,
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFD700",
  } as const,
  retrainButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(139, 92, 246, 0.1)",
    paddingVertical: 16,
    borderRadius: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(139, 92, 246, 0.3)",
    gap: 8,
  },
  retrainButtonDisabled: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  retrainText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#8b5cf6",
  } as const,
  retrainTextDisabled: {
    color: "#666",
  },
  divider: {
    height: 1,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    marginVertical: 16,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
    gap: 10,
  },
  statusLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: "#fff",
  } as const,
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  statusBadgeActive: {
    backgroundColor: "rgba(34, 197, 94, 0.15)",
  },
  statusBadgeInactive: {
    backgroundColor: "rgba(239, 68, 68, 0.15)",
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#fff",
    textTransform: "uppercase",
  } as const,
  statusHelper: {
    fontSize: 12,
    color: "#999",
    lineHeight: 18,
    marginBottom: 12,
  },
  techInfoContainer: {
    marginTop: 12,
    backgroundColor: "rgba(139, 92, 246, 0.05)",
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(139, 92, 246, 0.2)",
  },
  techInfoTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#8b5cf6",
    marginBottom: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  } as const,
  techInfoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  techInfoLabel: {
    fontSize: 13,
    color: "#999",
  },
  techInfoValue: {
    fontSize: 13,
    fontWeight: "700",
    color: "#ef4444",
  } as const,
  techInfoValueSuccess: {
    color: "#22c55e",
  },
  proCard: {
    marginBottom: 28,
    borderRadius: 16,
    overflow: "hidden" as const,
    borderWidth: 1,
    borderColor: "rgba(255,215,0,0.25)",
  },
  proCardGradient: {
    flexDirection: "row" as const,
    alignItems: "center",
    justifyContent: "space-between",
    padding: 18,
  },
  proCardLeft: {
    flexDirection: "row" as const,
    alignItems: "center",
    gap: 14,
  },
  proCardTitle: {
    fontSize: 16,
    fontWeight: "700" as const,
    color: "#FFD700",
    marginBottom: 2,
  },
  proCardSubtitle: {
    fontSize: 12,
    color: "#999",
  },
  proCardArrow: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(255,215,0,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  proCardArrowText: {
    fontSize: 20,
    color: "#FFD700",
    fontWeight: "600" as const,
    marginTop: -2,
  },
  proActiveBadge: {
    flexDirection: "row" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginBottom: 28,
    paddingVertical: 12,
    backgroundColor: "rgba(255,215,0,0.08)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,215,0,0.2)",
  },
  proActiveText: {
    fontSize: 14,
    fontWeight: "700" as const,
    color: "#FFD700",
  },
});
