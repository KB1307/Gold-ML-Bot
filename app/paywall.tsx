import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, Platform, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Stack, useRouter } from "expo-router";
import { Crown, Check, X, Zap, Shield, TrendingUp, RotateCcw } from "lucide-react-native";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { useState } from "react";
import { PurchasesPackage } from "react-native-purchases";

const FEATURES = [
  { icon: Zap, label: "Real-time XAUUSD signals", color: "#FFD700" },
  { icon: TrendingUp, label: "Multi-timeframe analysis", color: "#22c55e" },
  { icon: Shield, label: "Advanced risk management", color: "#3b82f6" },
  { icon: Crown, label: "AI-powered market outlook", color: "#a855f7" },
];

export default function PaywallScreen() {
  const router = useRouter();
  const {
    currentOffering,
    purchasePackage,
    restorePurchases,
    isPurchasing,
    isRestoring,
    isLoadingOfferings,
  } = useSubscription();

  const [selectedPkg, setSelectedPkg] = useState<string>("$rc_annual");

  const packages = currentOffering?.availablePackages ?? [];

  const getPackageLabel = (identifier: string): string => {
    if (identifier === "$rc_monthly") return "Monthly";
    if (identifier === "$rc_annual") return "Yearly";
    if (identifier === "$rc_lifetime") return "Lifetime";
    return identifier;
  };

  const getPackageSavings = (identifier: string): string | null => {
    if (identifier === "$rc_annual") return "SAVE 50%";
    if (identifier === "$rc_lifetime") return "BEST VALUE";
    return null;
  };

  const handlePurchase = async (pkg: PurchasesPackage) => {
    try {
      await purchasePackage(pkg);
      if (Platform.OS === "web") {
        alert("Welcome to Bullrun Pro!");
      } else {
        Alert.alert("Welcome!", "You now have access to Bullrun Pro.", [
          { text: "Let's Go", onPress: () => router.back() },
        ]);
      }
    } catch (e: any) {
      if (e?.userCancelled) return;
      const msg = e?.message || "Something went wrong. Please try again.";
      if (Platform.OS === "web") {
        alert(msg);
      } else {
        Alert.alert("Purchase Failed", msg);
      }
    }
  };

  const handleRestore = async () => {
    try {
      const info = await restorePurchases();
      const isActive = info?.entitlements?.active?.["Bullrun Pro"]?.isActive;
      if (isActive) {
        if (Platform.OS === "web") {
          alert("Purchases restored! Welcome back to Pro.");
        } else {
          Alert.alert("Restored!", "Welcome back to Bullrun Pro.", [
            { text: "OK", onPress: () => router.back() },
          ]);
        }
      } else {
        if (Platform.OS === "web") {
          alert("No active subscriptions found.");
        } else {
          Alert.alert("No Purchases", "No active subscriptions found to restore.");
        }
      }
    } catch {
      if (Platform.OS === "web") {
        alert("Failed to restore purchases.");
      } else {
        Alert.alert("Error", "Failed to restore purchases. Please try again.");
      }
    }
  };

  const selectedPackage = packages.find((p) => p.identifier === selectedPkg);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: false,
          presentation: "modal",
        }}
      />
      <View style={styles.container}>
        <LinearGradient
          colors={["#0a0a0a", "#1a1a2e", "#0a0a0a"]}
          style={styles.gradient}
        >
          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => router.back()}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <X size={24} color="#999" />
          </TouchableOpacity>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.heroSection}>
              <View style={styles.crownContainer}>
                <LinearGradient
                  colors={["rgba(255,215,0,0.25)", "rgba(255,215,0,0.05)"]}
                  style={styles.crownGlow}
                >
                  <Crown size={48} color="#FFD700" strokeWidth={1.5} />
                </LinearGradient>
              </View>
              <Text style={styles.heroTitle}>Bullrun Pro</Text>
              <Text style={styles.heroSubtitle}>
                Unlock the full power of AI-driven gold trading signals
              </Text>
            </View>

            <View style={styles.featuresSection}>
              {FEATURES.map((f, i) => (
                <View key={i} style={styles.featureRow}>
                  <View style={[styles.featureIcon, { backgroundColor: f.color + "18" }]}>
                    <f.icon size={18} color={f.color} />
                  </View>
                  <Text style={styles.featureText}>{f.label}</Text>
                  <Check size={16} color="#22c55e" />
                </View>
              ))}
            </View>

            {isLoadingOfferings ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#FFD700" />
                <Text style={styles.loadingText}>Loading plans...</Text>
              </View>
            ) : (
              <View style={styles.packagesSection}>
                {packages.map((pkg) => {
                  const isSelected = pkg.identifier === selectedPkg;
                  const savings = getPackageSavings(pkg.identifier);
                  return (
                    <TouchableOpacity
                      key={pkg.identifier}
                      style={[
                        styles.packageCard,
                        isSelected && styles.packageCardSelected,
                      ]}
                      onPress={() => setSelectedPkg(pkg.identifier)}
                      activeOpacity={0.7}
                    >
                      {savings && (
                        <View style={styles.savingsBadge}>
                          <Text style={styles.savingsText}>{savings}</Text>
                        </View>
                      )}
                      <View style={styles.packageRadio}>
                        <View
                          style={[
                            styles.radioOuter,
                            isSelected && styles.radioOuterSelected,
                          ]}
                        >
                          {isSelected && <View style={styles.radioInner} />}
                        </View>
                      </View>
                      <View style={styles.packageInfo}>
                        <Text
                          style={[
                            styles.packageName,
                            isSelected && styles.packageNameSelected,
                          ]}
                        >
                          {getPackageLabel(pkg.identifier)}
                        </Text>
                        <Text style={styles.packagePrice}>
                          {pkg.product.priceString}
                          {pkg.identifier === "$rc_monthly"
                            ? "/mo"
                            : pkg.identifier === "$rc_annual"
                            ? "/yr"
                            : ""}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.purchaseButton,
                (isPurchasing || !selectedPackage) && styles.purchaseButtonDisabled,
              ]}
              onPress={() => selectedPackage && handlePurchase(selectedPackage)}
              disabled={isPurchasing || !selectedPackage}
              activeOpacity={0.8}
            >
              <LinearGradient
                colors={
                  isPurchasing || !selectedPackage
                    ? ["#333", "#222"]
                    : ["#FFD700", "#FFA500"]
                }
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.purchaseButtonGradient}
              >
                {isPurchasing ? (
                  <ActivityIndicator size="small" color="#000" />
                ) : (
                  <Text style={styles.purchaseButtonText}>
                    Subscribe Now
                  </Text>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.restoreButton}
              onPress={handleRestore}
              disabled={isRestoring}
            >
              <RotateCcw size={14} color="#999" />
              <Text style={styles.restoreText}>
                {isRestoring ? "Restoring..." : "Restore Purchases"}
              </Text>
            </TouchableOpacity>

            <Text style={styles.legalText}>
              Payment will be charged to your account. Subscription automatically
              renews unless cancelled at least 24 hours before the end of the
              current period. Manage subscriptions in your account settings.
            </Text>
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
  closeButton: {
    position: "absolute" as const,
    top: Platform.OS === "ios" ? 56 : 20,
    right: 20,
    zIndex: 10,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: Platform.OS === "ios" ? 80 : 50,
    paddingBottom: 40,
  },
  heroSection: {
    alignItems: "center",
    marginBottom: 36,
  },
  crownContainer: {
    marginBottom: 20,
  },
  crownGlow: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: {
    fontSize: 32,
    fontWeight: "800" as const,
    color: "#fff",
    marginBottom: 10,
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    fontSize: 15,
    color: "#999",
    textAlign: "center" as const,
    lineHeight: 22,
    maxWidth: 280,
  },
  featuresSection: {
    marginBottom: 32,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  featureRow: {
    flexDirection: "row" as const,
    alignItems: "center",
    paddingVertical: 12,
    gap: 12,
  },
  featureIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  featureText: {
    flex: 1,
    fontSize: 14,
    color: "#ccc",
    fontWeight: "500" as const,
  },
  loadingContainer: {
    alignItems: "center",
    paddingVertical: 40,
    gap: 12,
  },
  loadingText: {
    color: "#999",
    fontSize: 14,
  },
  packagesSection: {
    gap: 12,
    marginBottom: 24,
  },
  packageCard: {
    flexDirection: "row" as const,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 14,
    padding: 18,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.08)",
    gap: 14,
  },
  packageCardSelected: {
    borderColor: "rgba(255,215,0,0.5)",
    backgroundColor: "rgba(255,215,0,0.06)",
  },
  savingsBadge: {
    position: "absolute" as const,
    top: -10,
    right: 14,
    backgroundColor: "#FFD700",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
  },
  savingsText: {
    fontSize: 10,
    fontWeight: "800" as const,
    color: "#000",
    letterSpacing: 0.5,
  },
  packageRadio: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  radioOuterSelected: {
    borderColor: "#FFD700",
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#FFD700",
  },
  packageInfo: {
    flex: 1,
  },
  packageName: {
    fontSize: 16,
    fontWeight: "700" as const,
    color: "#ccc",
    marginBottom: 2,
  },
  packageNameSelected: {
    color: "#fff",
  },
  packagePrice: {
    fontSize: 13,
    color: "#999",
  },
  purchaseButton: {
    borderRadius: 14,
    overflow: "hidden" as const,
    marginBottom: 14,
  },
  purchaseButtonDisabled: {
    opacity: 0.5,
  },
  purchaseButtonGradient: {
    paddingVertical: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  purchaseButtonText: {
    fontSize: 17,
    fontWeight: "800" as const,
    color: "#000",
    letterSpacing: 0.3,
  },
  restoreButton: {
    flexDirection: "row" as const,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    gap: 6,
    marginBottom: 20,
  },
  restoreText: {
    fontSize: 13,
    color: "#999",
    fontWeight: "500" as const,
  },
  legalText: {
    fontSize: 11,
    color: "#555",
    textAlign: "center" as const,
    lineHeight: 16,
    paddingHorizontal: 12,
  },
});
