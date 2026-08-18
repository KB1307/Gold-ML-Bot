import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Platform, Switch, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Settings as SettingsIcon, Target, Shield, TrendingUp, LogOut, Save, Trash2, Activity, AlertTriangle, RefreshCw, Bell, Smartphone, Crown, Send, MessageCircle, FileDown, Copy, Check } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { useTrading } from "@/contexts/TradingContext";
import { useSubscription } from "@/contexts/SubscriptionContext";
import { useAuth } from "@/contexts/AuthContext";
import { AccountSettingsCard } from "@/components/AccountSettingsCard";
import { useState, useEffect, useMemo } from "react";
import { Stack, useRouter } from "expo-router";
import { getBackgroundTaskStatus } from "@/services/backgroundTaskService";
import {
  fetchTelegramOutboxSummary,
  getTelegramDeliveryStats,
  sendTelegramMessage,
} from "@/services/telegramNotifier";
import { signalEngine } from "@/services/signalEngine";
import { buildDiagnosticsExportText } from "@/services/diagnosticsExport";
import { publishDiagnosticsExport } from "@/services/diagnosticsExportStore";
import { getRecentDiagnosticEvents } from "@/services/diagnosticEventStore";
import {
  fetchShadowSellSummary,
  getShadowWriteFailures,
  getShadowWriteSuccesses,
} from "@/services/shadowSignalService";
import { getTier0Counters } from "@/services/srZoneTier0Service";
import {
  getLearningCorpusStats,
  hydrateLearningCorpusStats,
  getOutboundPushStats,
  hydrateOutboundPushStats,
  hydratePendingPushQueue,
  getPendingRemotePushCount,
  getPushPathDescriptor,
} from "@/services/learningStore";
import { BUILD_SHA, BUILD_MARKED_AT, BUILD_CLAIMED_ITEMS } from "@/constants/buildMarker";

function getProviderLabel(provider: unknown): string {
  if (provider === "google") {
    return "Google";
  }

  if (provider === "apple") {
    return "Apple";
  }

  if (provider === "email") {
    return "Email";
  }

  return "Email / OAuth";
}

function maskValue(value: string | null): string {
  if (!value) {
    return "Pending";
  }

  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function getSmokeTestStatusLabel(loginValidated: boolean): string {
  return loginValidated ? "Login verified" : "Confirmation required";
}

function formatMetadataValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "Pending";
}

export default function SettingsScreen() {
  const { settings, updateSettings, logout, clearHistory, performanceMetrics, triggerManualRetrain, backgroundTaskActive, signalHistory } = useTrading();
  const { isPro, isProGold, appUserId, isSyncingCustomerIdentity } = useSubscription();
  const {
    isConfigured,
    user,
    isAuthenticated,
    statusMessage,
    errorMessage,
    activeOAuthProvider,
    isLoadingSession,
    isSigningInWithEmail,
    isCreatingAccount,
    isSigningOut,
    isSigningInWithOAuth,
    isRunningSupabaseSmokeTest,
    supabaseSmokeTestResult,
    signInWithEmail,
    signUpWithEmail,
    signInWithOAuth,
    signOut,
    runSupabaseSmokeTest,
  } = useAuth();
  const router = useRouter();
  const [isRetraining, setIsRetraining] = useState<boolean>(false);
  const [bgTaskStatus, setBgTaskStatus] = useState<{ isRegistered: boolean; isAvailable: boolean; } | null>(null);
  
  const [tp1Pips, setTp1Pips] = useState<string>(settings.tp1Pips.toString());
  const [tp2Pips, setTp2Pips] = useState<string>(settings.tp2Pips.toString());
  const [tp3Pips, setTp3Pips] = useState<string>(settings.tp3Pips.toString());
  const [slPips, setSlPips] = useState<string>(settings.slPips.toString());
  const [maxSLPips, setMaxSLPips] = useState<string>(settings.maxSLPips.toString());
  const [useDynamicSL, setUseDynamicSL] = useState<boolean>(settings.useDynamicSL);
  const [minConfidence, setMinConfidence] = useState<string>((settings.minConfidence * 100).toFixed(0));
  const [numberOfTPs, setNumberOfTPs] = useState<1 | 2 | 3>(settings.numberOfTPs);

  const [testMessage, setTestMessage] = useState<string>("");
  const [isSendingTest, setIsSendingTest] = useState<boolean>(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isUrlCopied, setIsUrlCopied] = useState<boolean>(false);

  useEffect(() => {
    async function checkBackgroundTask() {
      if (Platform.OS !== 'web') {
        const status = await getBackgroundTaskStatus();
        setBgTaskStatus(status);
      }
    }
    void checkBackgroundTask();
    const interval = setInterval(checkBackgroundTask, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setTp1Pips(settings.tp1Pips.toString());
    setTp2Pips(settings.tp2Pips.toString());
    setTp3Pips(settings.tp3Pips.toString());
    setSlPips(settings.slPips.toString());
    setMaxSLPips(settings.maxSLPips.toString());
    setUseDynamicSL(settings.useDynamicSL);
    setMinConfidence((settings.minConfidence * 100).toFixed(0));
    setNumberOfTPs(settings.numberOfTPs);
  }, [settings]);

  const authProviderLabel = useMemo(() => {
    return getProviderLabel(user?.app_metadata?.provider);
  }, [user?.app_metadata?.provider]);

  const handleSave = async () => {
    const parsedMinConfidence = parseFloat(minConfidence);
    const normalizedMinConfidence = Number.isFinite(parsedMinConfidence)
      ? Math.max(90, Math.min(98, parsedMinConfidence)) / 100
      : settings.minConfidence;

    await updateSettings({
      tp1Pips: parseFloat(tp1Pips) || settings.tp1Pips,
      tp2Pips: parseFloat(tp2Pips) || settings.tp2Pips,
      tp3Pips: parseFloat(tp3Pips) || settings.tp3Pips,
      slPips: parseFloat(slPips) || settings.slPips,
      maxSLPips: Math.min(90, parseFloat(maxSLPips) || settings.maxSLPips),
      useDynamicSL,
      minConfidence: normalizedMinConfidence,
      numberOfTPs,
      allowShortSignals: settings.allowShortSignals,
    });

    setMinConfidence((normalizedMinConfidence * 100).toFixed(0));
    
    if (Platform.OS === 'web') {
      alert('Settings saved successfully!');
    } else {
      Alert.alert('Success', 'Settings saved successfully!');
    }
  };

  const handleSendTestMessage = async () => {
    const text = testMessage.trim();
    if (!text) {
      setTestResult({ ok: false, message: "Enter a message to send." });
      return;
    }

    setIsSendingTest(true);
    setTestResult(null);

    try {
      const result = await sendTelegramMessage(text);
      if (result.ok) {
        setTestResult({ ok: true, message: "Test message delivered to Telegram." });
        setTestMessage("");
      } else {
        setTestResult({ ok: false, message: result.error ?? "Failed to send message." });
      }
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : "Failed to send message.",
      });
    } finally {
      setIsSendingTest(false);
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

  const handleRunSupabaseSmokeTest = async () => {
    try {
      const result = await runSupabaseSmokeTest();
      const message = result.loginValidated
        ? `Dummy user created, metadata saved, and email login verified for ${result.email}.`
        : `Dummy user created and metadata saved for ${result.email}. Email confirmation is required before login verification can complete.`;

      if (Platform.OS === 'web') {
        alert(message);
      } else {
        Alert.alert('Supabase Test Passed', message);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Supabase smoke test failed.';

      if (Platform.OS === 'web') {
        alert(message);
      } else {
        Alert.alert('Supabase Test Failed', message);
      }
    }
  };

  const handleExportDiagnostics = async () => {
    setIsExporting(true);
    setExportError(null);
    setExportUrl(null);
    setIsUrlCopied(false);

    try {
      // ITEM 7: the shadow summary is now read DIRECTLY from Supabase via the
      // anon key. It used to be fetched through the 503-prone Rork backend
      // route (`shadow.summary`), which is why SECTION 6 reported 5 rows while
      // shadow_signals_v1 actually held 413.
      // ITEM 12(d): load the durable corpus counters BEFORE they are read into the
      // export, so the export reports durable totals rather than this process's slice.
      await hydrateLearningCorpusStats().catch(() => undefined);
      // ITEM 74(b): same reasoning for the OUTBOUND counters and the durable
      // push queue - the export must report install-lifetime totals, not this
      // process's slice, because the event under investigation spans a reload.
      await hydrateOutboundPushStats().catch(() => undefined);
      await hydratePendingPushQueue().catch(() => undefined);

      const [modelWeights, modelHealth, diagnosticEvents, shadowSellSummary, telegramOutbox] =
        await Promise.all([
          signalEngine.getRawModelWeightsForExport(),
          Promise.resolve(signalEngine.getModelHealthMetrics()),
          getRecentDiagnosticEvents(1000).catch(() => []),
          fetchShadowSellSummary(30).catch(() => null),
          fetchTelegramOutboxSummary(72).catch(() => null),
        ]);

      const content = buildDiagnosticsExportText({
        signalHistory,
        modelWeights,
        modelHealth,
        performanceMetrics,
        diagnosticEvents,
        shadowSellSummary,
        shadowWriteFailures: getShadowWriteFailures(),
        shadowWriteSuccesses: getShadowWriteSuccesses(),
        tier0ZoneHealth: {
          ...getTier0Counters(),
          ...signalEngine.getTier0DegradationStats(),
        },
        directionalLayerStats: signalEngine.getDirectionalLayerStats(),
        telegramDeliveryStats: getTelegramDeliveryStats(),
        telegramOutbox,
        // ITEM 12(d): durable corpus-hydration counters (rehydrated above).
        learningCorpusStats: getLearningCorpusStats(),
        // ITEM 74(b)(c): the outbound half, plus reconciliation visibility.
        outboundPushStats: {
          ...getOutboundPushStats(),
          queueDepthNow: getPendingRemotePushCount(),
        },
        // ITEM 74(a): build marker + probes read from the RUNNING bundle.
        buildProvenance: {
          buildSha: BUILD_SHA,
          markedAt: BUILD_MARKED_AT,
          claimedItems: BUILD_CLAIMED_ITEMS,
          probes: [
            {
              label: "Item 64 CONSUMED_MODEL_WEIGHTS length (expect 4)",
              present: signalEngine.getConsumedModelWeightKeys().length === 4,
              observed: `[${signalEngine.getConsumedModelWeightKeys().join(", ")}] length=${signalEngine.getConsumedModelWeightKeys().length}`,
            },
            {
              label: "Item 66 durable pendingRemotePush persistence key",
              present: getPushPathDescriptor().pendingPushKey === "pending_remote_push_v1",
              observed: `AsyncStorage key = "${getPushPathDescriptor().pendingPushKey}", rehydrated=${getPushPathDescriptor().queueHydrated}`,
            },
            {
              label: "Item 66 direct anon-key upsert inside pushOutcomesToRemote",
              present: getPushPathDescriptor().usesDirectAnonUpsert && getPushPathDescriptor().clientConfigured,
              observed: `venue=${getPushPathDescriptor().venue} table=${getPushPathDescriptor().table} onConflict=${getPushPathDescriptor().onConflict} clientConfigured=${getPushPathDescriptor().clientConfigured}`,
            },
          ],
        },
      });

      // ITEM 9: the artifact is published DIRECTLY to Supabase Storage via the
      // anon key. It used to be POSTed to the 503-prone Rork backend and held in
      // a process-lifetime in-memory variable — a flap could deny us the whole
      // evidence base. The URL returned is the IMMUTABLE per-export object, so it
      // can never serve a previous export from a cache.
      const published = await publishDiagnosticsExport(content);
      setExportUrl(published.url);
      if (!published.latestPointerUpdated) {
        setExportError('Export published, but the latest.txt pointer could not be updated.');
      }
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Failed to export diagnostics.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyExportUrl = async () => {
    if (!exportUrl) return;
    try {
      await Clipboard.setStringAsync(exportUrl);
      setIsUrlCopied(true);
      setTimeout(() => setIsUrlCopied(false), 2000);
    } catch (error) {
      console.error('[Settings] Failed to copy export URL:', error);
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
                      <Text style={styles.proCardSubtitle}>Unlock AI-driven gold signals</Text>
                    </View>
                  </View>
                  <View style={styles.proCardArrow}>
                    <Text style={styles.proCardArrowText}>{"\u203A"}</Text>
                  </View>
                </LinearGradient>
              </TouchableOpacity>
            )}

            {isPro && !isProGold && (
              <TouchableOpacity
                style={styles.proActiveBadge}
                onPress={() => router.push("/paywall" as any)}
                activeOpacity={0.8}
              >
                <Crown size={16} color="#3b82f6" />
                <Text style={[styles.proActiveText, { color: "#3b82f6" }]}>Bullrun Pro Active</Text>
                <Text style={styles.upgradeHint}>Upgrade to Pro Gold \u203A</Text>
              </TouchableOpacity>
            )}

            {isProGold && (
              <View style={styles.proActiveBadge}>
                <Crown size={16} color="#FFD700" />
                <Text style={styles.proActiveText}>Bullrun Pro Gold Active</Text>
              </View>
            )}

            <AccountSettingsCard
              isConfigured={isConfigured}
              isAuthenticated={isAuthenticated}
              userEmail={user?.email ?? null}
              userId={user?.id ?? null}
              providerLabel={authProviderLabel}
              revenueCatUserId={appUserId}
              isRevenueCatSyncing={isSyncingCustomerIdentity}
              statusMessage={statusMessage}
              errorMessage={errorMessage}
              isLoadingSession={isLoadingSession}
              isSubmittingEmail={isSigningInWithEmail || isCreatingAccount}
              isSubmittingOAuth={isSigningInWithOAuth}
              isSigningOut={isSigningOut}
              activeOAuthProvider={activeOAuthProvider}
              onSignInWithEmail={signInWithEmail}
              onCreateAccount={signUpWithEmail}
              onSignInWithOAuth={signInWithOAuth}
              onSignOut={signOut}
            />

            <View style={styles.section} testID="settings-supabase-smoke-test-section">
              <View style={styles.sectionHeader}>
                <Shield size={20} color="#60a5fa" />
                <Text style={styles.sectionTitle}>Supabase Smoke Test</Text>
              </View>

              <Text style={styles.helperText}>
                Create a throwaway Supabase user, save metadata, and verify password login when email confirmation allows it.
              </Text>

              <TouchableOpacity
                style={[
                  styles.supabaseTestButton,
                  (!isConfigured || isRunningSupabaseSmokeTest) && styles.supabaseTestButtonDisabled,
                ]}
                onPress={() => {
                  void handleRunSupabaseSmokeTest();
                }}
                disabled={!isConfigured || isRunningSupabaseSmokeTest}
                testID="settings-supabase-smoke-test-button"
              >
                <Shield size={18} color={isRunningSupabaseSmokeTest ? "#94a3b8" : "#60a5fa"} />
                <Text
                  style={[
                    styles.supabaseTestButtonText,
                    isRunningSupabaseSmokeTest && styles.supabaseTestButtonTextDisabled,
                  ]}
                >
                  {isRunningSupabaseSmokeTest
                    ? "Running Supabase smoke test..."
                    : "Create test user & save data"}
                </Text>
              </TouchableOpacity>

              {supabaseSmokeTestResult ? (
                <View style={styles.supabaseResultCard} testID="settings-supabase-smoke-test-result">
                  <Text style={styles.supabaseResultTitle}>Latest verification</Text>
                  <View style={styles.supabaseResultRow}>
                    <Text style={styles.supabaseResultLabel}>Test email</Text>
                    <Text style={styles.supabaseResultValue}>{supabaseSmokeTestResult.email}</Text>
                  </View>
                  <View style={styles.supabaseResultRow}>
                    <Text style={styles.supabaseResultLabel}>Supabase user</Text>
                    <Text style={styles.supabaseResultValue}>
                      {maskValue(supabaseSmokeTestResult.userId)}
                    </Text>
                  </View>
                  <View style={styles.supabaseResultRow}>
                    <Text style={styles.supabaseResultLabel}>Auth status</Text>
                    <Text
                      style={[
                        styles.supabaseResultValue,
                        styles.supabaseResultValueSuccess,
                      ]}
                    >
                      {getSmokeTestStatusLabel(supabaseSmokeTestResult.loginValidated)}
                    </Text>
                  </View>
                  <View style={styles.supabaseResultRow}>
                    <Text style={styles.supabaseResultLabel}>Run ID</Text>
                    <Text style={styles.supabaseResultValue}>
                      {formatMetadataValue(supabaseSmokeTestResult.metadata.runId)}
                    </Text>
                  </View>
                  <View style={styles.supabaseResultRow}>
                    <Text style={styles.supabaseResultLabel}>Created</Text>
                    <Text style={styles.supabaseResultValue}>{supabaseSmokeTestResult.createdAt}</Text>
                  </View>
                  <View style={styles.supabaseResultRow}>
                    <Text style={styles.supabaseResultLabel}>Verified</Text>
                    <Text style={styles.supabaseResultValue}>
                      {supabaseSmokeTestResult.verifiedAt ?? "Awaiting confirmation"}
                    </Text>
                  </View>
                </View>
              ) : null}
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Target size={20} color="#22c55e" />
                <Text style={styles.sectionTitle}>Take Profit Levels (Pips — Used By The Engine)</Text>
              </View>
              
              <View style={styles.inputRow}>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>TP1 (pips)</Text>
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
                  <Text style={styles.inputLabel}>TP2 (pips)</Text>
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
                  <Text style={styles.inputLabel}>TP3 (pips)</Text>
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

              {/*
                ITEM 134 — EVERY SENTENCE OF THE PREVIOUS HELP TEXT WAS FALSE.

                The old copy (written for Item 22) said these fields were "Not used
                by the engine" and that TP distances were derived from the realised
                stop at 0.70R / 1.05R / 1.40R. That was true when it was written,
                but ITEM 109 made these fields AUTHORITATIVE: signalEngine.ts now
                reads `const tp1Distance = settings.tp1Pips` directly (verified live
                at signalEngine.ts:8278), so these numbers set real emitted geometry.
                The R-multiples are now DERIVED OUTPUTS, not inputs — hence the
                read-only ratio readout below rather than R-labelled column headers.

                This is COPY ONLY. No behaviour changed in Item 134.
              */}
              <Text style={styles.helperText}>
                These pip distances ARE the take-profit levels the engine uses. Each TP is
                placed this many pips from the entry price. The resulting reward-to-risk
                ratio is derived from whatever stop the engine actually places, which
                varies with volatility — so the ratios below are a readout, not an input.
              </Text>
              <Text style={styles.helperText}>
                Derived at your current base stop of {slPips || "0"} pips:{" "}
                TP1 {Number(slPips) > 0 ? (Number(tp1Pips) / Number(slPips)).toFixed(2) : "—"}R{" "}
                · TP2 {Number(slPips) > 0 ? (Number(tp2Pips) / Number(slPips)).toFixed(2) : "—"}R{" "}
                · TP3 {Number(slPips) > 0 ? (Number(tp3Pips) / Number(slPips)).toFixed(2) : "—"}R.{" "}
                The live ratio will differ when ATR widens the stop or the Max SL Cap
                truncates it.
              </Text>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Shield size={20} color="#ef4444" />
                <Text style={styles.sectionTitle}>Stop Loss (Pips)</Text>
              </View>
              
              <View style={styles.inputRow}>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Base SL (Used)</Text>
                  <TextInput
                    style={styles.input}
                    value={slPips}
                    onChangeText={setSlPips}
                    keyboardType="decimal-pad"
                    placeholder="70"
                    placeholderTextColor="#666"
                  />
                </View>
                <View style={styles.inputGroup}>
                  <Text style={styles.inputLabel}>Max SL Cap</Text>
                  <TextInput
                    style={styles.input}
                    value={maxSLPips}
                    onChangeText={setMaxSLPips}
                    keyboardType="decimal-pad"
                    placeholder="70"
                    placeholderTextColor="#666"
                  />
                </View>
              </View>

              <View style={styles.switchRow}>
                <View style={styles.switchInfo}>
                  <Text style={styles.switchLabel}>Dynamic Stop Loss</Text>
                  <Text style={styles.switchHelper}>
                    Auto-adjust SL by ATR volatility (capped at Max SL). Off = fixed Base SL.
                  </Text>
                </View>
                <Switch
                  value={useDynamicSL}
                  onValueChange={setUseDynamicSL}
                  trackColor={{ false: "#333", true: "rgba(239, 68, 68, 0.3)" }}
                  thumbColor={useDynamicSL ? "#ef4444" : "#666"}
                  ios_backgroundColor="#333"
                />
              </View>

              {/*
                ITEM 134 — corrected. The old string said "default 70 pips" (the
                default is 90) and "TP zones default 30 pips apart" (they are not —
                the defaults are 25/50/80, which are 25 and 30 apart). Copy only.
              */}
              <Text style={styles.helperText}>
                Base SL is the starting stop distance; the engine widens it to clear a
                1.2 x ATR noise floor when volatility demands it. Max SL Cap (default 90
                pips) is a hard draw-down ceiling — if the noise floor needs more room
                than the cap allows, the stop is CLAMPED to the cap and the signal still
                emits, which means the realised stop can sit inside the noise floor and
                carries a higher chance of being stopped out by noise. Raise the cap to
                give those setups full clearance.
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
                  placeholder="90"
                  placeholderTextColor="#666"
                />
              </View>

              <Text style={styles.helperText}>
                Signals are filtered by confidence threshold. Higher values = fewer but stronger signals (72-96%).
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
                <Send size={20} color="#229ED9" />
                <Text style={styles.sectionTitle}>Telegram Signal Notifier</Text>
              </View>

              <View style={styles.switchRow}>
                <View style={styles.switchInfo}>
                  <Text style={styles.switchLabel}>Enable Telegram Signal Alert</Text>
                  <Text style={styles.switchHelper}>
                    Broadcast new signals to your Telegram channel. Turn off to mute alerts during testing or updates.
                  </Text>
                </View>
                <Switch
                  value={settings.enableTelegramNotifier}
                  onValueChange={(value) => updateSettings({ enableTelegramNotifier: value })}
                  trackColor={{ false: "#333", true: "rgba(34, 158, 217, 0.3)" }}
                  thumbColor={settings.enableTelegramNotifier ? "#229ED9" : "#666"}
                  ios_backgroundColor="#333"
                />
              </View>

              <View style={styles.notifierStatusRow}>
                <View style={[
                  styles.statusBadge,
                  settings.enableTelegramNotifier ? styles.statusBadgeActive : styles.statusBadgeInactive,
                ]}>
                  <Text style={styles.statusBadgeText}>
                    {settings.enableTelegramNotifier ? "NOTIFIER ON" : "NOTIFIER OFF"}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Shield size={20} color="#FFD700" />
                <Text style={styles.sectionTitle}>Signal Direction Control</Text>
              </View>

              <View style={styles.switchRow}>
                <View style={styles.switchInfo}>
                  <Text style={styles.switchLabel}>Allow Short (SELL) Signals</Text>
                  <Text style={styles.switchHelper}>
                    Default ON. The earlier "SELLs are structurally marginal" finding was
                    REVERSED — it was a labelling artifact; corrected canonical figures are
                    BUY 63.1% vs SELL 63.2%, i.e. no directional edge either way. When off,
                    qualifying SELLs are fully scored but not emitted — a shadow record is
                    logged for forward monitoring.
                  </Text>
                </View>
                <Switch
                  value={settings.allowShortSignals}
                  onValueChange={(value) => updateSettings({ allowShortSignals: value })}
                  trackColor={{ false: "#333", true: "rgba(255, 215, 0, 0.3)" }}
                  thumbColor={settings.allowShortSignals ? "#FFD700" : "#666"}
                  ios_backgroundColor="#333"
                />
              </View>

              <View style={styles.notifierStatusRow}>
                <View style={[
                  styles.statusBadge,
                  settings.allowShortSignals ? styles.statusBadgeActive : styles.statusBadgeInactive,
                ]}>
                  <Text style={styles.statusBadgeText}>
                    {settings.allowShortSignals ? "SELLS ENABLED" : "SELLS SUPPRESSED"}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.section} testID="settings-telegram-test-section">
              <View style={styles.sectionHeader}>
                <MessageCircle size={20} color="#229ED9" />
                <Text style={styles.sectionTitle}>Telegram Test Message</Text>
              </View>
              <Text style={styles.switchHelper}>
                Push a custom notice to the Telegram channel — handy for confirming delivery or broadcasting an update.
              </Text>

              <TextInput
                style={styles.testInput}
                value={testMessage}
                onChangeText={(text) => {
                  setTestMessage(text);
                  if (testResult) {
                    setTestResult(null);
                  }
                }}
                placeholder="Type a custom notice to broadcast…"
                placeholderTextColor="#666"
                multiline
                numberOfLines={4}
                textAlignVertical="top"
                editable={!isSendingTest}
                testID="settings-telegram-test-input"
              />

              <TouchableOpacity
                style={[
                  styles.testButton,
                  (isSendingTest || !testMessage.trim()) && styles.testButtonDisabled,
                ]}
                onPress={() => {
                  void handleSendTestMessage();
                }}
                disabled={isSendingTest || !testMessage.trim()}
                testID="settings-telegram-test-button"
              >
                <Send size={18} color={(isSendingTest || !testMessage.trim()) ? "#666" : "#229ED9"} />
                <Text style={[
                  styles.testButtonText,
                  (isSendingTest || !testMessage.trim()) && styles.testButtonTextDisabled,
                ]}>
                  {isSendingTest ? "Sending…" : "Send Test Message"}
                </Text>
              </TouchableOpacity>

              {testResult && (
                <View style={[
                  styles.testResult,
                  testResult.ok ? styles.testResultSuccess : styles.testResultError,
                ]}>
                  <Text style={[
                    styles.testResultText,
                    testResult.ok ? styles.testResultTextSuccess : styles.testResultTextError,
                  ]}>
                    {testResult.ok ? "✅ " : "⚠️ "}{testResult.message}
                  </Text>
                </View>
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

            <View style={styles.section} testID="settings-export-diagnostics-section">
              <View style={styles.sectionHeader}>
                <FileDown size={20} color="#34d399" />
                <Text style={styles.sectionTitle}>Export Diagnostics</Text>
              </View>

              <Text style={styles.helperText}>
                Bundle your full signal history, model weights, model health/drift metrics, and
                performance metrics into a readable text file, hosted at a stable URL you can
                revisit anytime from any device.
              </Text>

              <TouchableOpacity
                style={[styles.exportButton, isExporting && styles.exportButtonDisabled]}
                onPress={() => {
                  void handleExportDiagnostics();
                }}
                disabled={isExporting}
                testID="settings-export-diagnostics-button"
              >
                <FileDown size={18} color={isExporting ? "#666" : "#34d399"} />
                <Text style={[styles.exportButtonText, isExporting && styles.exportButtonTextDisabled]}>
                  {isExporting ? "Generating export\u2026" : "Export Diagnostics"}
                </Text>
              </TouchableOpacity>

              {exportError && (
                <View style={styles.exportErrorBox}>
                  <Text style={styles.exportErrorText}>{exportError}</Text>
                </View>
              )}

              {exportUrl && (
                <View style={styles.exportResultBox} testID="settings-export-diagnostics-url">
                  <Text style={styles.exportResultLabel}>Download anytime at:</Text>
                  <Text selectable style={styles.exportResultUrl}>{exportUrl}</Text>
                  <TouchableOpacity
                    style={styles.copyUrlButton}
                    onPress={() => {
                      void handleCopyExportUrl();
                    }}
                    testID="settings-export-diagnostics-copy"
                  >
                    {isUrlCopied ? (
                      <Check size={16} color="#34d399" />
                    ) : (
                      <Copy size={16} color="#34d399" />
                    )}
                    <Text style={styles.copyUrlButtonText}>
                      {isUrlCopied ? "Copied!" : "Copy URL"}
                    </Text>
                  </TouchableOpacity>
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

            <TouchableOpacity style={styles.saveButton} onPress={handleSave} testID="settings-save-changes">
              <Save size={20} color="#FFD700" />
              <Text style={styles.saveButtonText}>Save Changes</Text>
            </TouchableOpacity>

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

            <TouchableOpacity style={styles.logoutButton} onPress={handleLogout} testID="settings-exit-dashboard-button">
              <LogOut size={20} color="#ef4444" />
              <Text style={styles.logoutText}>Exit Dashboard</Text>
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
  exportButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(52, 211, 153, 0.1)",
    paddingVertical: 14,
    borderRadius: 10,
    marginTop: 4,
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(52, 211, 153, 0.3)",
  },
  exportButtonDisabled: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderColor: "rgba(255, 255, 255, 0.08)",
  },
  exportButtonText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#34d399",
  } as const,
  exportButtonTextDisabled: {
    color: "#666",
  },
  exportErrorBox: {
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
  },
  exportErrorText: {
    fontSize: 12,
    color: "#ef4444",
    lineHeight: 17,
  },
  exportResultBox: {
    marginTop: 12,
    padding: 14,
    borderRadius: 10,
    backgroundColor: "rgba(52, 211, 153, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(52, 211, 153, 0.2)",
  },
  exportResultLabel: {
    fontSize: 11,
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  } as const,
  exportResultUrl: {
    fontSize: 13,
    color: "#fff",
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginBottom: 12,
  },
  copyUrlButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(52, 211, 153, 0.12)",
    gap: 6,
  },
  copyUrlButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#34d399",
  } as const,
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
  notifierStatusRow: {
    flexDirection: "row",
    marginTop: 14,
  },
  testHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  testTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#fff",
  } as const,
  testInput: {
    backgroundColor: "rgba(0, 0, 0, 0.3)",
    borderWidth: 1,
    borderColor: "rgba(34, 158, 217, 0.25)",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: "#fff",
    fontSize: 15,
    minHeight: 96,
    marginTop: 12,
    marginBottom: 12,
  },
  testButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(34, 158, 217, 0.12)",
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(34, 158, 217, 0.35)",
    gap: 8,
  },
  testButtonDisabled: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  testButtonText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#229ED9",
  } as const,
  testButtonTextDisabled: {
    color: "#666",
  },
  testResult: {
    marginTop: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  testResultSuccess: {
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    borderColor: "rgba(34, 197, 94, 0.3)",
  },
  testResultError: {
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderColor: "rgba(239, 68, 68, 0.3)",
  },
  testResultText: {
    fontSize: 13,
    lineHeight: 18,
  },
  testResultTextSuccess: {
    color: "#22c55e",
  },
  testResultTextError: {
    color: "#ef4444",
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
  upgradeHint: {
    fontSize: 12,
    fontWeight: "600" as const,
    color: "#FFD700",
    marginLeft: 4,
  },
  supabaseTestButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(96, 165, 250, 0.12)",
    paddingVertical: 14,
    borderRadius: 12,
    marginTop: 16,
    borderWidth: 1,
    borderColor: "rgba(96, 165, 250, 0.28)",
    gap: 8,
  },
  supabaseTestButtonDisabled: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  supabaseTestButtonText: {
    fontSize: 15,
    fontWeight: "700" as const,
    color: "#60a5fa",
  },
  supabaseTestButtonTextDisabled: {
    color: "#94a3b8",
  },
  supabaseResultCard: {
    marginTop: 16,
    padding: 16,
    borderRadius: 14,
    backgroundColor: "rgba(15, 23, 42, 0.55)",
    borderWidth: 1,
    borderColor: "rgba(96, 165, 250, 0.2)",
    gap: 10,
  },
  supabaseResultTitle: {
    fontSize: 13,
    fontWeight: "700" as const,
    color: "#bfdbfe",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  supabaseResultRow: {
    gap: 4,
  },
  supabaseResultLabel: {
    fontSize: 12,
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  supabaseResultValue: {
    fontSize: 13,
    color: "#e2e8f0",
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  },
  supabaseResultValueSuccess: {
    color: "#4ade80",
  },
});
