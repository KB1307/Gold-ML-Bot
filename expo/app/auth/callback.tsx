import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";

export default function AuthCallbackScreen() {
  const router = useRouter();

  useEffect(() => {
    const timeout = setTimeout(() => {
      router.replace("/(tabs)/settings" as never);
    }, 900);

    return () => clearTimeout(timeout);
  }, [router]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.container} testID="auth-callback-screen">
        <LinearGradient
          colors={["#050505", "#111827", "#050505"]}
          style={styles.gradient}
        >
          <ActivityIndicator size="large" color="#FFD700" />
          <Text style={styles.title}>Finishing sign-in...</Text>
          <Text style={styles.subtitle}>Securing your profile and subscription access.</Text>
        </LinearGradient>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#050505",
  },
  gradient: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 14,
  },
  title: {
    fontSize: 20,
    fontWeight: "700" as const,
    color: "#fff",
  },
  subtitle: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
    color: "#a1a1aa",
  },
});
