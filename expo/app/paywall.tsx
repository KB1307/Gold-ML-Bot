import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView, Platform, Alert, Animated } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Stack, useRouter } from "expo-router";
import { Crown, Check, X, Zap, RotateCcw, Gem, InfinityIcon } from "lucide-react-native";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { useState, useRef, useCallback } from "react";
import { PurchasesPackage } from "react-native-purchases";

type TierKey = "pro" | "pro_gold";

interface TierConfig {
  key: TierKey;
  title: string;
  subtitle: string;
  monthlyPrice: string;
  annualPrice: string;
  annualMonthly: string;
  savingsLabel: string;
  accent: string;
  accentDim: string;
  icon: typeof Crown;
  features: string[];
  signalLimit: string;
  entitlement: string;
}

const TIERS: TierConfig[] = [
  {
    key: "pro",
    title: "Pro",
    subtitle: "Smart trading essentials",
    monthlyPrice: "$9.99",
    annualPrice: "$69.99",
    annualMonthly: "$5.83",
    savingsLabel: "SAVE 42%",
    accent: "#3b82f6",
    accentDim: "rgba(59,130,246,0.12)",
    icon: Zap,
    features: [
      "Real-time XAUUSD signals",
      "Multi-timeframe analysis",
      "Risk management tools",
      "Up to 5 signals per day",
    ],
    signalLimit: "5/day",
    entitlement: "Bullrun Pro",
  },
  {
    key: "pro_gold",
    title: "Pro Gold",
    subtitle: "Unlimited trading power",
    monthlyPrice: "$15.99",
    annualPrice: "$89.99",
    annualMonthly: "$7.50",
    savingsLabel: "SAVE 53%",
    accent: "#FFD700",
    accentDim: "rgba(255,215,0,0.12)",
    icon: Crown,
    features: [
      "Everything in Pro",
      "Unlimited daily signals",
      "AI-powered market outlook",
      "Priority signal delivery",
    ],
    signalLimit: "Unlimited",
    entitlement: "Bullrun Pro Gold",
  },
];

type BillingCycle = "monthly" | "annual";

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

  const [selectedTier, setSelectedTier] = useState<TierKey>("pro_gold");
  const [billingCycle, setBillingCycle] = useState<BillingCycle>("annual");
  const toggleAnim = useRef(new Animated.Value(1)).current;

  const packages = currentOffering?.availablePackages ?? [];

  const handleToggleBilling = useCallback((cycle: BillingCycle) => {
    setBillingCycle(cycle);
    Animated.spring(toggleAnim, {
      toValue: cycle === "monthly" ? 0 : 1,
      useNativeDriver: false,
      friction: 8,
      tension: 60,
    }).start();
  }, [toggleAnim]);

  const getPackageForTier = (tierKey: TierKey, cycle: BillingCycle): PurchasesPackage | undefined => {
    if (tierKey === "pro") {
      return packages.find((p) =>
        cycle === "monthly" ? p.identifier === "$rc_monthly" : p.identifier === "$rc_annual"
      );
    }
    return packages.find((p) =>
      cycle === "monthly"
        ? p.identifier === "$rc_monthly" || p.identifier.includes("gold_monthly")
        : p.identifier === "$rc_annual" || p.identifier.includes("gold_annual")
    );
  };

  const handlePurchase = async () => {
    const pkg = getPackageForTier(selectedTier, billingCycle);
    if (!pkg) {
      const tier = TIERS.find((t) => t.key === selectedTier);
      const price = billingCycle === "monthly" ? tier?.monthlyPrice : tier?.annualPrice;
      const period = billingCycle === "monthly" ? "month" : "year";
      if (Platform.OS === "web") {
        alert(`${tier?.title} subscription: ${price}/${period}\n\nIn-app purchases are only available on iOS and Android devices.`);
      } else {
        Alert.alert(
          "Package Not Available",
          `The ${tier?.title} ${billingCycle} package is not yet configured in RevenueCat. Please set up the product in your RevenueCat dashboard.`
        );
      }
      return;
    }

    try {
      await purchasePackage(pkg);
      const tierName = TIERS.find((t) => t.key === selectedTier)?.title ?? "Pro";
      if (Platform.OS === "web") {
        alert(`Welcome to Bullrun ${tierName}!`);
      } else {
        Alert.alert("Welcome!", `You now have access to Bullrun ${tierName}.`, [
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
      const hasProGold = info?.entitlements?.active?.["Bullrun Pro Gold"]?.isActive;
      const hasPro = info?.entitlements?.active?.["Bullrun Pro"]?.isActive;
      if (hasProGold || hasPro) {
        const tierName = hasProGold ? "Pro Gold" : "Pro";
        if (Platform.OS === "web") {
          alert(`Purchases restored! Welcome back to ${tierName}.`);
        } else {
          Alert.alert("Restored!", `Welcome back to Bullrun ${tierName}.`, [
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
    } catch (e: any) {
      const msg = e?.message || "Failed to restore purchases.";
      if (Platform.OS === "web") {
        alert(msg);
      } else {
        Alert.alert("Error", msg);
      }
    }
  };

  const activeTier = TIERS.find((t) => t.key === selectedTier)!;
  const displayPrice = billingCycle === "monthly" ? activeTier.monthlyPrice : activeTier.annualPrice;
  const displayPeriod = billingCycle === "monthly" ? "/mo" : "/yr";

  const toggleLeft = toggleAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["2%", "50%"],
  });

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
          colors={["#0a0a0a", "#111118", "#0a0a0a"]}
          style={styles.gradient}
        >
          <TouchableOpacity
            style={styles.closeButton}
            onPress={() => router.back()}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <X size={22} color="#888" />
          </TouchableOpacity>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.heroSection}>
              <Text style={styles.heroTitle}>Choose Your Plan</Text>
              <Text style={styles.heroSubtitle}>
                Unlock AI-driven gold trading signals
              </Text>
            </View>

            <View style={styles.billingToggle}>
              <Animated.View
                style={[
                  styles.toggleIndicator,
                  { left: toggleLeft },
                ]}
              />
              <TouchableOpacity
                style={styles.toggleOption}
                onPress={() => handleToggleBilling("monthly")}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.toggleText,
                    billingCycle === "monthly" && styles.toggleTextActive,
                  ]}
                >
                  Monthly
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.toggleOption}
                onPress={() => handleToggleBilling("annual")}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.toggleText,
                    billingCycle === "annual" && styles.toggleTextActive,
                  ]}
                >
                  Annual
                </Text>
                {billingCycle === "annual" && (
                  <View style={styles.toggleBadge}>
                    <Text style={styles.toggleBadgeText}>SAVE</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            {isLoadingOfferings ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#FFD700" />
                <Text style={styles.loadingText}>Loading plans...</Text>
              </View>
            ) : (
              <View style={styles.tiersContainer}>
                {TIERS.map((tier) => {
                  const isSelected = tier.key === selectedTier;
                  const price = billingCycle === "monthly" ? tier.monthlyPrice : tier.annualPrice;
                  const perMonth = billingCycle === "annual" ? tier.annualMonthly : tier.monthlyPrice;
                  const TierIcon = tier.icon;

                  return (
                    <TouchableOpacity
                      key={tier.key}
                      style={[
                        styles.tierCard,
                        isSelected && {
                          borderColor: tier.accent + "80",
                          backgroundColor: tier.accentDim,
                        },
                      ]}
                      onPress={() => setSelectedTier(tier.key)}
                      activeOpacity={0.7}
                    >
                      {tier.key === "pro_gold" && (
                        <View style={[styles.popularBadge, { backgroundColor: tier.accent }]}>
                          <Text style={styles.popularBadgeText}>MOST POPULAR</Text>
                        </View>
                      )}

                      <View style={styles.tierHeader}>
                        <View style={[styles.tierIconWrap, { backgroundColor: tier.accent + "20" }]}>
                          <TierIcon size={20} color={tier.accent} />
                        </View>
                        <View style={styles.tierTitleGroup}>
                          <Text style={[styles.tierTitle, isSelected && { color: "#fff" }]}>
                            {tier.title}
                          </Text>
                          <Text style={styles.tierSubtitle}>{tier.subtitle}</Text>
                        </View>
                        <View style={styles.tierRadio}>
                          <View
                            style={[
                              styles.radioOuter,
                              isSelected && { borderColor: tier.accent },
                            ]}
                          >
                            {isSelected && (
                              <View style={[styles.radioInner, { backgroundColor: tier.accent }]} />
                            )}
                          </View>
                        </View>
                      </View>

                      <View style={styles.tierPriceRow}>
                        <Text style={[styles.tierPrice, isSelected && { color: "#fff" }]}>
                          {price}
                        </Text>
                        <Text style={styles.tierPricePeriod}>
                          {billingCycle === "monthly" ? "/mo" : "/yr"}
                        </Text>
                        {billingCycle === "annual" && (
                          <View style={[styles.perMonthBadge, { backgroundColor: tier.accent + "18" }]}>
                            <Text style={[styles.perMonthText, { color: tier.accent }]}>
                              {perMonth}/mo
                            </Text>
                          </View>
                        )}
                      </View>

                      <View style={styles.tierSignalRow}>
                        {tier.key === "pro_gold" ? (
                          <InfinityIcon size={14} color={tier.accent} />
                        ) : (
                          <Gem size={14} color={tier.accent} />
                        )}
                        <Text style={[styles.tierSignalText, { color: tier.accent }]}>
                          {tier.signalLimit} signals
                        </Text>
                      </View>

                      {isSelected && (
                        <View style={styles.tierFeatures}>
                          {tier.features.map((feat, i) => (
                            <View key={i} style={styles.tierFeatureRow}>
                              <Check size={14} color={tier.accent} />
                              <Text style={styles.tierFeatureText}>{feat}</Text>
                            </View>
                          ))}
                        </View>
                      )}

                      {billingCycle === "annual" && (
                        <View style={[styles.savingsTag, { backgroundColor: tier.accent + "15" }]}>
                          <Text style={[styles.savingsTagText, { color: tier.accent }]}>
                            {tier.savingsLabel}
                          </Text>
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.purchaseButton,
                isPurchasing && styles.purchaseButtonDisabled,
              ]}
              onPress={handlePurchase}
              disabled={isPurchasing}
              activeOpacity={0.8}
            >
              <LinearGradient
                colors={
                  isPurchasing
                    ? ["#333", "#222"]
                    : selectedTier === "pro_gold"
                    ? ["#FFD700", "#F59E0B"]
                    : ["#3b82f6", "#2563eb"]
                }
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.purchaseButtonGradient}
              >
                {isPurchasing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <View style={styles.purchaseButtonContent}>
                    <Text style={styles.purchaseButtonText}>
                      Subscribe to {activeTier.title}
                    </Text>
                    <Text style={styles.purchaseButtonPrice}>
                      {displayPrice}{displayPeriod}
                    </Text>
                  </View>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.restoreButton}
              onPress={handleRestore}
              disabled={isRestoring}
            >
              <RotateCcw size={13} color="#666" />
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
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: Platform.OS === "ios" ? 80 : 50,
    paddingBottom: 40,
  },
  heroSection: {
    alignItems: "center",
    marginBottom: 28,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: "800" as const,
    color: "#fff",
    marginBottom: 8,
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    fontSize: 14,
    color: "#777",
    textAlign: "center" as const,
    lineHeight: 20,
  },
  billingToggle: {
    flexDirection: "row" as const,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 12,
    padding: 3,
    marginBottom: 24,
    position: "relative" as const,
  },
  toggleIndicator: {
    position: "absolute" as const,
    top: 3,
    bottom: 3,
    width: "48%",
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 10,
  },
  toggleOption: {
    flex: 1,
    flexDirection: "row" as const,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    gap: 6,
  },
  toggleText: {
    fontSize: 14,
    fontWeight: "600" as const,
    color: "#666",
  },
  toggleTextActive: {
    color: "#fff",
  },
  toggleBadge: {
    backgroundColor: "rgba(255,215,0,0.2)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  toggleBadgeText: {
    fontSize: 9,
    fontWeight: "800" as const,
    color: "#FFD700",
    letterSpacing: 0.5,
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
  tiersContainer: {
    gap: 14,
    marginBottom: 24,
  },
  tierCard: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 16,
    padding: 18,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.06)",
    overflow: "hidden" as const,
  },
  popularBadge: {
    position: "absolute" as const,
    top: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderBottomLeftRadius: 10,
  },
  popularBadgeText: {
    fontSize: 9,
    fontWeight: "800" as const,
    color: "#000",
    letterSpacing: 0.8,
  },
  tierHeader: {
    flexDirection: "row" as const,
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  tierIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  tierTitleGroup: {
    flex: 1,
  },
  tierTitle: {
    fontSize: 18,
    fontWeight: "700" as const,
    color: "#bbb",
    marginBottom: 1,
  },
  tierSubtitle: {
    fontSize: 12,
    color: "#666",
  },
  tierRadio: {
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
    borderColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  tierPriceRow: {
    flexDirection: "row" as const,
    alignItems: "baseline",
    gap: 4,
    marginBottom: 10,
  },
  tierPrice: {
    fontSize: 28,
    fontWeight: "800" as const,
    color: "#bbb",
    letterSpacing: -0.5,
  },
  tierPricePeriod: {
    fontSize: 14,
    fontWeight: "500" as const,
    color: "#555",
  },
  perMonthBadge: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  perMonthText: {
    fontSize: 11,
    fontWeight: "700" as const,
  },
  tierSignalRow: {
    flexDirection: "row" as const,
    alignItems: "center",
    gap: 6,
    marginBottom: 12,
  },
  tierSignalText: {
    fontSize: 13,
    fontWeight: "600" as const,
  },
  tierFeatures: {
    gap: 8,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
    marginTop: 4,
  },
  tierFeatureRow: {
    flexDirection: "row" as const,
    alignItems: "center",
    gap: 8,
    paddingVertical: 2,
  },
  tierFeatureText: {
    fontSize: 13,
    color: "#999",
    fontWeight: "500" as const,
  },
  savingsTag: {
    alignSelf: "flex-start" as const,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginTop: 12,
  },
  savingsTagText: {
    fontSize: 10,
    fontWeight: "800" as const,
    letterSpacing: 0.5,
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
  purchaseButtonContent: {
    alignItems: "center",
    gap: 2,
  },
  purchaseButtonText: {
    fontSize: 16,
    fontWeight: "800" as const,
    color: "#000",
    letterSpacing: 0.3,
  },
  purchaseButtonPrice: {
    fontSize: 12,
    fontWeight: "600" as const,
    color: "rgba(0,0,0,0.6)",
  },
  restoreButton: {
    flexDirection: "row" as const,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    gap: 6,
    marginBottom: 16,
  },
  restoreText: {
    fontSize: 13,
    color: "#666",
    fontWeight: "500" as const,
  },
  legalText: {
    fontSize: 11,
    color: "#444",
    textAlign: "center" as const,
    lineHeight: 16,
    paddingHorizontal: 12,
  },
});
