import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Platform, Switch, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Settings as SettingsIcon, Target, Shield, TrendingUp, LogOut, Save, Trash2 } from "lucide-react-native";
import { useTrading } from "@/contexts/TradingContext";
import { useState } from "react";
import { Stack, useRouter } from "expo-router";

export default function SettingsScreen() {
  const { settings, updateSettings, logout, clearHistory } = useTrading();
  const router = useRouter();
  
  const [tp1Pips, setTp1Pips] = useState<string>(settings.tp1Pips.toString());
  const [tp2Pips, setTp2Pips] = useState<string>(settings.tp2Pips.toString());
  const [tp3Pips, setTp3Pips] = useState<string>(settings.tp3Pips.toString());
  const [slPips, setSlPips] = useState<string>(settings.slPips.toString());
  const [minConfidence, setMinConfidence] = useState<string>((settings.minConfidence * 100).toString());
  const [numberOfTPs, setNumberOfTPs] = useState<1 | 2 | 3>(settings.numberOfTPs);

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
                <Text style={styles.sectionTitle}>Notifications</Text>
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
});
