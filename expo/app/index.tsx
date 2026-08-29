import { View, Text, TouchableOpacity, StyleSheet, Image } from "react-native";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { useTrading } from "@/contexts/TradingContext";

export default function LoginScreen() {
  // MM.3 — degrade gracefully: the auth context may be undefined (providers not
  // mounted), so read it instead of destructuring — a property access on
  // undefined here turned a provider failure into a full-screen crash.
  const trading = useTrading();
  const authUnavailable = !trading || typeof trading.login !== "function";
  const router = useRouter();

  const handleLogin = async () => {
    if (authUnavailable) return;
    await trading.login("demo_user");
    router.replace("/(tabs)/dashboard" as any);
  };

  return (
    <LinearGradient
      colors={["#0a0a0a", "#1a1a2e", "#16213e"]}
      style={styles.container}
    >
        <View style={styles.content}>
          <View style={styles.logoContainer}>
            <View style={styles.logoImageContainer}>
              <Image
                source={{ uri: 'https://pub-e001eb4506b145aa938b5d3badbff6a5.r2.dev/attachments/4voi8r0f5fxv3yg5tbldu' }}
                style={styles.logo}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.title}>GOLD SIGNAL BOT</Text>
            <Text style={styles.subtitle}>Intelligent Trading Signals</Text>
          </View>

          <View style={styles.featureContainer}>
            <View style={styles.featureRow}>
              <View style={styles.featureDot} />
              <Text style={styles.featureText}>Transformer-Based ML Engine</Text>
            </View>
            <View style={styles.featureRow}>
              <View style={styles.featureDot} />
              <Text style={styles.featureText}>Real-Time Market Analysis</Text>
            </View>
            <View style={styles.featureRow}>
              <View style={styles.featureDot} />
              <Text style={styles.featureText}>High Accuracy</Text>
            </View>
          </View>

          <View style={styles.loginBox}>
            {authUnavailable && (
              <Text style={styles.authErrorText}>
                Sign-in is temporarily unavailable. Please restart the app.
              </Text>
            )}

            <TouchableOpacity
              style={styles.loginButton}
              onPress={handleLogin}
              activeOpacity={0.8}
            >
              <LinearGradient
                colors={["#FFD700", "#FFA500"]}
                style={styles.buttonGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
              >
                <Text style={styles.loginButtonText}>Enter Dashboard</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>

          <View style={styles.disclaimerContainer}>
            <Text style={styles.disclaimer}>
              Trading involves risk. Past performance does not guarantee future results.
            </Text>
          </View>
        </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  logoContainer: {
    alignItems: "center",
    marginBottom: 48,
  },
  logoImageContainer: {
    width: 180,
    height: 180,
    marginBottom: 24,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 30,
    overflow: 'hidden',
  },
  logo: {
    width: '110%',
    height: '110%',
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#FFD700",
    marginBottom: 8,
    letterSpacing: 1.2,
    textAlign: "center",
  } as const,
  subtitle: {
    fontSize: 16,
    color: "#00BFFF",
    letterSpacing: 1.5,
    textAlign: "center",
  },
  featureContainer: {
    marginBottom: 40,
    paddingHorizontal: 20,
  },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },
  featureDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#FFD700",
    marginRight: 12,
  },
  featureText: {
    fontSize: 14,
    color: "#ccc",
  },
  loginBox: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 16,
    padding: 32,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  authErrorText: {
    color: "#FF6B6B",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 16,
    lineHeight: 20,
  },
    loginButton: {
    borderRadius: 12,
    overflow: "hidden",
  },
  buttonGradient: {
    paddingVertical: 18,
    alignItems: "center",
  },
  loginButtonText: {
    color: "#000",
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: 0.5,
  } as const,
  disclaimerContainer: {
    marginTop: 32,
    paddingHorizontal: 20,
  },
  disclaimer: {
    fontSize: 11,
    color: "#555",
    textAlign: "center",
    lineHeight: 16,
  },
});
