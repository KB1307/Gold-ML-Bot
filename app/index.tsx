import { View, Text, TouchableOpacity, StyleSheet, Image } from "react-native";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { useTrading } from "@/contexts/TradingContext";

export default function LoginScreen() {
  const { login } = useTrading();
  const router = useRouter();

  const handleLogin = async () => {
    await login("demo_user");
    router.replace("/(tabs)/dashboard");
  };

  return (
    <LinearGradient
      colors={["#0a0a0a", "#1a1a2e", "#16213e"]}
      style={styles.container}
    >
        <View style={styles.content}>
          <View style={styles.logoContainer}>
            <Image
              source={{ uri: 'https://pub-e001eb4506b145aa938b5d3badbff6a5.r2.dev/attachments/f5dnmfatca3k1w5p2htci' }}
              style={styles.logo}
              resizeMode="contain"
            />
            <Text style={styles.title}>GOLD Signal BOT</Text>
            <Text style={styles.subtitle}>Intelligent trading signals</Text>
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
              <Text style={styles.featureText}>95%+ Signal Accuracy</Text>
            </View>
          </View>

          <View style={styles.loginBox}>

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
  logo: {
    width: 200,
    height: 200,
    marginBottom: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 8,
    letterSpacing: 0.5,
  } as const,
  subtitle: {
    fontSize: 16,
    color: "#999",
    letterSpacing: 1,
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
