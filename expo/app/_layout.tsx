import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { TradingProvider, useTrading } from "@/contexts/TradingContext";
import { SubscriptionProvider } from "@/contexts/SubscriptionContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { View, ActivityIndicator, Text, StyleSheet, LogBox, Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

// Global uncaught error handler for diagnostics — catches module-level crashes
// before the React error boundary can mount.
(function installGlobalErrorTrap() {
  const logDetails = (label: string, error: unknown) => {
    console.error(`[GlobalTrap] ${label}:`, typeof error);
    if (error instanceof Error) {
      console.error(`[GlobalTrap] ${label} name=`, error.name, "msg=", error.message);
      console.error(`[GlobalTrap] ${label} stack=`, error.stack?.slice(0, 800) ?? "(none)");
    } else if (error !== null && typeof error === "object") {
      const keys = Object.keys(error as Record<string, unknown>);
      console.error(`[GlobalTrap] ${label} keys=`, keys.length > 0 ? keys : "(empty object)");
      try {
        console.error(`[GlobalTrap] ${label} json=`, JSON.stringify(error).slice(0, 400));
      } catch {
        console.error(`[GlobalTrap] ${label} (not JSON-serializable)`);
      }
    } else {
      console.error(`[GlobalTrap] ${label} value=`, String(error));
    }
  };

  // React Native global handler (native runtime)
  const g = globalThis as Record<string, unknown>;
  if (typeof g.ErrorUtils !== "undefined" && g.ErrorUtils) {
    try {
      const utils = g.ErrorUtils as { getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void; setGlobalHandler?: (h: (error: unknown, isFatal?: boolean) => void) => void };
      const originalHandler = utils.getGlobalHandler?.();
      utils.setGlobalHandler?.((error: unknown, isFatal?: boolean) => {
        logDetails("RN", error);
        if (originalHandler) {
          try { originalHandler(error, isFatal); } catch { /* must not throw */ }
        }
      });
      console.log("[GlobalTrap] Registered React Native global error handler");
    } catch (e) {
      console.warn("[GlobalTrap] Failed to install RN ErrorUtils handler:", e instanceof Error ? e.message : String(e));
    }
  }

  // Web global handler
  if (typeof window !== "undefined") {
    window.addEventListener("error", (event: ErrorEvent) => {
      logDetails("WEB", event.error ?? event.message);
    });
    window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      logDetails("WEB-unhandled", event.reason);
    });
    console.log("[GlobalTrap] Registered web error listeners");
  }

  // Native unhandled promise rejection handler.
  // React Native 0.81+ uses a 'unhandledrejection' event on the
  // global scope (same as web). Register it on both platforms.
  const rejectionHandler = (event: { reason?: unknown } | PromiseRejectionEvent) => {
    const reason = 'reason' in event ? event.reason : undefined;
    logDetails("NATIVE-unhandled-rejection", reason);
  };
  try {
    if (typeof globalThis !== "undefined" && typeof globalThis.addEventListener === "function") {
      (globalThis as unknown as Window).addEventListener("unhandledrejection", rejectionHandler as EventListener);
      console.log("[GlobalTrap] Registered native unhandledrejection handler");
    }
  } catch {
    // globalThis.addEventListener not available
  }
})();

// Web-only defensive patch for "NotFoundError: Failed to execute 'removeChild'/
// 'insertBefore' on 'Node': the node to be removed/reference node is not a
// child of this node". This fires when something outside React's own
// bookkeeping (a third-party embed script, e.g. the TradingView chart iframe,
// or a browser extension) mutates the DOM tree React manages, so React's own
// reconciliation later tries to remove/insert relative to a node that has
// already moved. It is not fixable from inside React itself, so this patches
// the two DOM primitives to no-op (instead of throwing and tearing down the
// whole app) when the parent/reference relationship no longer holds — a
// well-established, narrowly-scoped safety net used for exactly this class
// of third-party DOM race.
(function installDomMutationGuard() {
  if (Platform.OS !== "web" || typeof Node === "undefined" || !Node.prototype) {
    return;
  }

  try {
    const originalRemoveChild = Node.prototype.removeChild;
    Node.prototype.removeChild = function patchedRemoveChild<T extends Node>(this: Node, child: T): T {
      if (child.parentNode !== this) {
        console.warn("[DomGuard] Ignored removeChild for a node that is no longer a child (likely a third-party DOM mutation race)");
        return child;
      }
      return originalRemoveChild.call(this, child) as T;
    };

    const originalInsertBefore = Node.prototype.insertBefore;
    Node.prototype.insertBefore = function patchedInsertBefore<T extends Node>(this: Node, newNode: T, referenceNode: Node | null): T {
      if (referenceNode && referenceNode.parentNode !== this) {
        console.warn("[DomGuard] Ignored insertBefore for a reference node that is no longer a child (likely a third-party DOM mutation race)");
        return newNode;
      }
      return originalInsertBefore.call(this, newNode, referenceNode) as T;
    };

    console.log("[DomGuard] Installed removeChild/insertBefore mutation guard (web only)");
  } catch (e) {
    console.warn("[DomGuard] Failed to install DOM mutation guard:", e instanceof Error ? e.message : String(e));
  }
})();

void SplashScreen.preventAutoHideAsync();

if (Platform.OS === 'web') {
  LogBox.ignoreLogs([
    'Cannot listen to the event from the provided iframe',
    'props.pointerEvents is deprecated',
  ]);
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
      staleTime: Infinity,
    },
    mutations: {
      retry: false,
    },
  },
});

const LoadingOverlay = React.memo(() => {
  let isLoading = true;
  try {
    const ctx = useTrading();
    isLoading = ctx.isLoading;
  } catch {
    // Trading context not ready yet — keep showing loading
  }
  
  if (!isLoading) return null;
  
  return (
    <View style={[styles.loadingContainer, StyleSheet.absoluteFill]}>
      <View style={styles.loadingFallback}>
        <ActivityIndicator size="large" color="#FFD700" />
        <Text style={styles.loadingText}>Loading Trading Data...</Text>
      </View>
    </View>
  );
});
LoadingOverlay.displayName = 'LoadingOverlay';

const AppNavigation = React.memo(() => {
  return (
    <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="paywall" options={{ presentation: "modal", headerShown: false }} />
      <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
      <Stack.Screen name="+not-found" />
    </Stack>
  );
});
AppNavigation.displayName = 'AppNavigation';

const RootLayoutNav = React.memo(() => {
  return (
    <View style={{ flex: 1 }}>
      <AppNavigation />
      <LoadingOverlay />
    </View>
  );
});
RootLayoutNav.displayName = 'RootLayoutNav';

export default function RootLayout() {
  const [isClientReady, setIsClientReady] = useState<boolean>(Platform.OS !== 'web');

  useEffect(() => {
    const timer = setTimeout(() => {
      void SplashScreen.hideAsync();
    }, 100);

    if (Platform.OS !== 'web') {
      return () => clearTimeout(timer);
    }

    const frame = requestAnimationFrame(() => {
      setIsClientReady(true);
    });

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, []);

  if (!isClientReady) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={styles.bootContainer} testID="root-layout-boot-screen">
          <LinearGradient
            colors={["#050505", "#111827", "#050505"]}
            style={styles.bootGradient}
          >
            <ActivityIndicator size="large" color="#FFD700" />
            <Text style={styles.loadingText}>Preparing live trading workspace...</Text>
          </LinearGradient>
        </View>
      </GestureHandlerRootView>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AppErrorBoundary>
        <AuthProvider>
          <SubscriptionProvider>
            <TradingProvider>
              <GestureHandlerRootView style={{ flex: 1 }}>
                <RootLayoutNav />
              </GestureHandlerRootView>
            </TradingProvider>
          </SubscriptionProvider>
        </AuthProvider>
      </AppErrorBoundary>
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
  loadingFallback: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0a0a0a",
  },
  loadingText: {
    fontSize: 16,
    color: "#FFD700",
    fontWeight: "600" as const,
    marginTop: 12,
  },
  bootContainer: {
    flex: 1,
    backgroundColor: "#050505",
  },
  bootGradient: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
  },
});
