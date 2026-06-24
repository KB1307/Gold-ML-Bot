import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import {
  BadgeCheck,
  KeyRound,
  LogIn,
  LogOut,
  Mail,
  ShieldAlert,
  ShieldCheck,
  UserRound,
} from "lucide-react-native";
import { AppleLogo, GoogleLogo } from "@/components/BrandLogos";

export type AccountMode = "sign_in" | "create_account";

interface AccountSettingsCardProps {
  isConfigured: boolean;
  isAuthenticated: boolean;
  userEmail: string | null;
  userId: string | null;
  providerLabel: string;
  revenueCatUserId: string | null;
  isRevenueCatSyncing: boolean;
  statusMessage: string | null;
  errorMessage: string | null;
  isLoadingSession: boolean;
  isSubmittingEmail: boolean;
  isSubmittingOAuth: boolean;
  isSigningOut: boolean;
  activeOAuthProvider: "google" | "apple" | null;
  onSignInWithEmail: (email: string, password: string) => Promise<unknown>;
  onCreateAccount: (email: string, password: string) => Promise<unknown>;
  onSignInWithOAuth: (provider: "google" | "apple") => Promise<unknown>;
  onSignOut: () => Promise<unknown>;
}

function maskIdentifier(value: string | null): string {
  if (!value) {
    return "Pending";
  }

  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function AccountSettingsCard({
  isConfigured,
  isAuthenticated,
  userEmail,
  userId,
  providerLabel,
  revenueCatUserId,
  isRevenueCatSyncing,
  statusMessage,
  errorMessage,
  isLoadingSession,
  isSubmittingEmail,
  isSubmittingOAuth,
  isSigningOut,
  activeOAuthProvider,
  onSignInWithEmail,
  onCreateAccount,
  onSignInWithOAuth,
  onSignOut,
}: AccountSettingsCardProps) {
  const [mode, setMode] = useState<AccountMode>("sign_in");
  const [email, setEmail] = useState<string>(userEmail ?? "");
  const [password, setPassword] = useState<string>("");
  const [localMessage, setLocalMessage] = useState<string | null>(null);

  const effectiveMessage = errorMessage ?? localMessage ?? statusMessage;
  const effectiveMessageTone = errorMessage ?? localMessage ? "error" : "success";

  const accountBadgeLabel = useMemo(() => {
    if (isLoadingSession) {
      return "Checking account";
    }

    return isAuthenticated ? "Account linked" : "Anonymous usage";
  }, [isAuthenticated, isLoadingSession]);

  const validateFields = useCallback(() => {
    const trimmedEmail = email.trim().toLowerCase();

    if (!trimmedEmail.includes("@") || !trimmedEmail.includes(".")) {
      setLocalMessage("Enter a valid email address.");
      return null;
    }

    if (password.trim().length < 8) {
      setLocalMessage("Password must be at least 8 characters.");
      return null;
    }

    setLocalMessage(null);
    return {
      email: trimmedEmail,
      password,
    };
  }, [email, password]);

  const handleEmailSubmit = useCallback(async () => {
    const credentials = validateFields();
    if (!credentials) {
      return;
    }

    if (mode === "create_account") {
      await onCreateAccount(credentials.email, credentials.password);
      return;
    }

    await onSignInWithEmail(credentials.email, credentials.password);
  }, [mode, onCreateAccount, onSignInWithEmail, validateFields]);

  const handleOAuth = useCallback(
    async (provider: "google" | "apple") => {
      setLocalMessage(null);
      await onSignInWithOAuth(provider);
    },
    [onSignInWithOAuth]
  );

  const handleSignOut = useCallback(async () => {
    setLocalMessage(null);
    await onSignOut();
  }, [onSignOut]);

  return (
    <View style={styles.section} testID="account-settings-card">
      <LinearGradient
        colors={["rgba(24, 24, 32, 0.96)", "rgba(12, 12, 18, 0.98)"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.cardGradient}
      >
        <View style={styles.headerRow}>
          <View style={styles.headerIconWrap}>
            <UserRound size={22} color="#FFD700" />
          </View>
          <View style={styles.headerCopy}>
            <Text style={styles.sectionTitle}>Account & Identity</Text>
            <Text style={styles.sectionSubtitle}>
              Link each trader to a Supabase profile and a RevenueCat customer identity.
            </Text>
          </View>
          <View style={[styles.badge, isAuthenticated ? styles.badgeSuccess : styles.badgeNeutral]}>
            <Text style={styles.badgeText}>{accountBadgeLabel}</Text>
          </View>
        </View>

        {!isConfigured && (
          <View style={[styles.messageBox, styles.messageWarning]}>
            <ShieldAlert size={16} color="#f59e0b" />
            <Text style={styles.warningText}>
              Supabase environment variables are missing. Add the project URL and publishable key to enable accounts.
            </Text>
          </View>
        )}

        {effectiveMessage ? (
          <View
            style={[
              styles.messageBox,
              effectiveMessageTone === "error" ? styles.messageError : styles.messageSuccess,
            ]}
          >
            {effectiveMessageTone === "error" ? (
              <ShieldAlert size={16} color="#f87171" />
            ) : (
              <BadgeCheck size={16} color="#4ade80" />
            )}
            <Text
              style={
                effectiveMessageTone === "error" ? styles.errorText : styles.successText
              }
            >
              {effectiveMessage}
            </Text>
          </View>
        ) : null}

        {isAuthenticated ? (
          <View style={styles.identityPanel}>
            <View style={styles.identityTopRow}>
              <View style={styles.identityAvatar}>
                <Text style={styles.identityAvatarText}>
                  {(userEmail?.slice(0, 1) ?? "U").toUpperCase()}
                </Text>
              </View>
              <View style={styles.identityCopy}>
                <Text style={styles.identityTitle}>{userEmail ?? "Authenticated user"}</Text>
                <Text style={styles.identitySubtitle}>Provider: {providerLabel}</Text>
              </View>
            </View>

            <View style={styles.identityGrid}>
              <View style={styles.identityStatCard}>
                <Mail size={15} color="#60a5fa" />
                <Text style={styles.identityStatLabel}>Supabase user</Text>
                <Text style={styles.identityStatValue}>{maskIdentifier(userId)}</Text>
              </View>
              <View style={styles.identityStatCard}>
                <ShieldCheck size={15} color="#34d399" />
                <Text style={styles.identityStatLabel}>RevenueCat ID</Text>
                <Text style={styles.identityStatValue}>{maskIdentifier(revenueCatUserId)}</Text>
              </View>
            </View>

            <View style={styles.syncRow}>
              <View style={styles.syncStatusWrap}>
                <Text style={styles.syncLabel}>Tier sync</Text>
                <Text style={styles.syncHelper}>
                  {isRevenueCatSyncing
                    ? "Updating subscription identity for this user..."
                    : "Subscription status is attached to this account."}
                </Text>
              </View>
              {isRevenueCatSyncing ? (
                <ActivityIndicator size="small" color="#FFD700" />
              ) : (
                <BadgeCheck size={18} color="#4ade80" />
              )}
            </View>

            <TouchableOpacity
              style={[styles.secondaryButton, isSigningOut && styles.buttonDisabled]}
              onPress={handleSignOut}
              disabled={isSigningOut}
              testID="account-sign-out-button"
            >
              {isSigningOut ? (
                <ActivityIndicator size="small" color="#fca5a5" />
              ) : (
                <LogOut size={18} color="#f87171" />
              )}
              <Text style={styles.secondaryButtonText}>
                {isSigningOut ? "Signing out..." : "Sign out account"}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.segmentRow}>
              <TouchableOpacity
                style={[
                  styles.segmentButton,
                  mode === "sign_in" && styles.segmentButtonActive,
                ]}
                onPress={() => setMode("sign_in")}
                testID="account-mode-sign-in"
              >
                <LogIn size={16} color={mode === "sign_in" ? "#111827" : "#9ca3af"} />
                <Text
                  style={[
                    styles.segmentButtonText,
                    mode === "sign_in" && styles.segmentButtonTextActive,
                  ]}
                >
                  Sign in
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.segmentButton,
                  mode === "create_account" && styles.segmentButtonActive,
                ]}
                onPress={() => setMode("create_account")}
                testID="account-mode-create"
              >
                <BadgeCheck
                  size={16}
                  color={mode === "create_account" ? "#111827" : "#9ca3af"}
                />
                <Text
                  style={[
                    styles.segmentButtonText,
                    mode === "create_account" && styles.segmentButtonTextActive,
                  ]}
                >
                  Create account
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.formCard}>
              <View style={styles.inputWrap}>
                <Mail size={16} color="#6b7280" />
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  placeholder="trader@email.com"
                  placeholderTextColor="#6b7280"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  testID="account-email-input"
                />
              </View>

              <View style={styles.inputWrap}>
                <KeyRound size={16} color="#6b7280" />
                <TextInput
                  style={styles.input}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Minimum 8 characters"
                  placeholderTextColor="#6b7280"
                  secureTextEntry
                  testID="account-password-input"
                />
              </View>

              <TouchableOpacity
                style={[styles.primaryButton, (!isConfigured || isSubmittingEmail) && styles.buttonDisabled]}
                onPress={() => {
                  void handleEmailSubmit();
                }}
                disabled={!isConfigured || isSubmittingEmail}
                testID="account-email-submit"
              >
                {isSubmittingEmail ? (
                  <ActivityIndicator size="small" color="#FFD700" />
                ) : (
                  <Mail size={18} color="#FFD700" />
                )}
                <Text style={styles.primaryButtonText}>
                  {mode === "create_account"
                    ? isSubmittingEmail
                      ? "Creating account..."
                      : "Create with email"
                    : isSubmittingEmail
                      ? "Signing in..."
                      : "Sign in with email"}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.oauthDividerRow}>
              <View style={styles.oauthDividerLine} />
              <Text style={styles.oauthDividerText}>or continue with</Text>
              <View style={styles.oauthDividerLine} />
            </View>

            <View style={styles.oauthRow}>
              <TouchableOpacity
                style={[styles.oauthButtonGoogle, (!isConfigured || isSubmittingOAuth) && styles.buttonDisabled]}
                onPress={() => {
                  void handleOAuth("google");
                }}
                disabled={!isConfigured || isSubmittingOAuth}
                testID="account-google-sign-in"
              >
                {isSubmittingOAuth && activeOAuthProvider === "google" ? (
                  <ActivityIndicator size="small" color="#1f1f1f" />
                ) : (
                  <GoogleLogo size={18} />
                )}
                <Text style={styles.oauthButtonGoogleText}>Sign in with Google</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.oauthButtonApple, (!isConfigured || isSubmittingOAuth) && styles.buttonDisabled]}
                onPress={() => {
                  void handleOAuth("apple");
                }}
                disabled={!isConfigured || isSubmittingOAuth}
                testID="account-apple-sign-in"
              >
                {isSubmittingOAuth && activeOAuthProvider === "apple" ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <AppleLogo size={18} />
                )}
                <Text style={styles.oauthButtonAppleText}>Sign in with Apple</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </LinearGradient>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: 28,
    borderRadius: 22,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.12)",
  },
  cardGradient: {
    padding: 20,
    gap: 18,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 14,
  },
  headerIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: "rgba(255, 215, 0, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerCopy: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700" as const,
    color: "#fff",
    marginBottom: 4,
  },
  sectionSubtitle: {
    fontSize: 13,
    lineHeight: 18,
    color: "#a1a1aa",
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
  },
  badgeNeutral: {
    backgroundColor: "rgba(148, 163, 184, 0.12)",
  },
  badgeSuccess: {
    backgroundColor: "rgba(74, 222, 128, 0.12)",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "700" as const,
    color: "#e5e7eb",
    textTransform: "uppercase",
  },
  messageBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  messageWarning: {
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.22)",
  },
  messageError: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.22)",
  },
  messageSuccess: {
    backgroundColor: "rgba(34, 197, 94, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.22)",
  },
  warningText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: "#fcd34d",
  },
  errorText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: "#fca5a5",
  },
  successText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
    color: "#86efac",
  },
  segmentRow: {
    flexDirection: "row",
    gap: 10,
  },
  segmentButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
    paddingVertical: 13,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  segmentButtonActive: {
    backgroundColor: "#FFD700",
    borderColor: "#FFD700",
  },
  segmentButtonText: {
    fontSize: 14,
    fontWeight: "700" as const,
    color: "#a1a1aa",
  },
  segmentButtonTextActive: {
    color: "#111827",
  },
  formCard: {
    gap: 12,
  },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 4,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.07)",
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    color: "#fff",
    fontSize: 15,
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 16,
    backgroundColor: "rgba(255, 215, 0, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(255, 215, 0, 0.35)",
    paddingVertical: 15,
    marginTop: 4,
  },
  primaryButtonText: {
    fontSize: 15,
    fontWeight: "700" as const,
    color: "#FFD700",
  },
  oauthDividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  oauthDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  oauthDividerText: {
    fontSize: 12,
    color: "#71717a",
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
  oauthRow: {
    flexDirection: "row",
    gap: 12,
  },
  oauthButtonGoogle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: 16,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "rgba(0, 0, 0, 0.08)",
    paddingVertical: 15,
  },
  oauthButtonGoogleText: {
    fontSize: 14,
    fontWeight: "600" as const,
    color: "#1f1f1f",
    letterSpacing: 0.1,
  },
  oauthButtonApple: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: 16,
    backgroundColor: "#000000",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    paddingVertical: 15,
  },
  oauthButtonAppleText: {
    fontSize: 14,
    fontWeight: "600" as const,
    color: "#ffffff",
    letterSpacing: 0.1,
  },
  identityPanel: {
    gap: 16,
  },
  identityTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  identityAvatar: {
    width: 50,
    height: 50,
    borderRadius: 18,
    backgroundColor: "rgba(255, 215, 0, 0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  identityAvatarText: {
    fontSize: 20,
    fontWeight: "800" as const,
    color: "#FFD700",
  },
  identityCopy: {
    flex: 1,
  },
  identityTitle: {
    fontSize: 16,
    fontWeight: "700" as const,
    color: "#fff",
    marginBottom: 4,
  },
  identitySubtitle: {
    fontSize: 12,
    color: "#a1a1aa",
  },
  identityGrid: {
    gap: 12,
  },
  identityStatCard: {
    borderRadius: 16,
    padding: 14,
    gap: 8,
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.06)",
  },
  identityStatLabel: {
    fontSize: 11,
    color: "#71717a",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  identityStatValue: {
    fontSize: 14,
    fontWeight: "700" as const,
    color: "#f5f5f5",
  },
  syncRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 16,
    padding: 14,
    backgroundColor: "rgba(16, 185, 129, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.12)",
  },
  syncStatusWrap: {
    flex: 1,
  },
  syncLabel: {
    fontSize: 13,
    fontWeight: "700" as const,
    color: "#ecfccb",
    marginBottom: 4,
  },
  syncHelper: {
    fontSize: 12,
    lineHeight: 17,
    color: "#bbf7d0",
  },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 16,
    paddingVertical: 15,
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.18)",
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: "700" as const,
    color: "#fca5a5",
  },
  buttonDisabled: {
    opacity: 0.55,
  },
});
