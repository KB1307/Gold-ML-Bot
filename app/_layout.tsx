import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { TradingProvider, useTrading } from "@/contexts/TradingContext";
import { View, ActivityIndicator, Text, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function LoadingScreen() {
  return (
    <View style={styles.loadingContainer}>
      <LinearGradient
        colors={["#0a0a0a", "#1a1a2e"]}
        style={styles.loadingGradient}
      >
        <ActivityIndicator size="large" color="#FFD700" />
        <Text style={styles.loadingText}>Loading Trading Data...</Text>
      </LinearGradient>
    </View>
  );
}

function RootLayoutNav() {
  const { isLoading } = useTrading();

  if (isLoading) {
    return <LoadingScreen />;
  }

  return (
    <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="+not-found" />
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => {
    const timer = setTimeout(() => {
      SplashScreen.hideAsync();
    }, 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TradingProvider>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <RootLayoutNav />
        </GestureHandlerRootView>
      </TradingProvider>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  loadingGradient: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    color: "#FFD700",
    fontWeight: "600" as const,
    marginTop: 12,
  },
});
