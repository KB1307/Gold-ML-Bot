import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { getBootLoopCycleCount, getLastFatalDigest } from "@/lib/bootForensics";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { TradingProvider, useTrading } from "@/contexts/TradingContext";
import { SubscriptionProvider } from "@/contexts/SubscriptionContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { View, ActivityIndicator, Text, StyleSheet, LogBox, Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { assertEmittedSchemaContract } from "@/services/emittedSignalService";
import { recordBoot, recordFatalError } from "@/lib/bootForensics";

// Global uncaught error handler for diagnostics — catches module-level crashes
// before the React error boundary can mount.
(function installGlobalErrorTrap() {
  // MM.2 — an error handler that throws is worse than no handler. The ENTIRE
  // trap install is wrapped so no failure here (unexpected runtime shape,
  // missing API) can ever kill module evaluation or boot (ITEM MM, 7f8fb94).
  try {
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
        recordFatalError(error);
        if (originalHandler) {
          try { originalHandler(error, isFatal); } catch { /* must not throw */ }
        }
      });
      console.log("[GlobalTrap] Registered React Native global error handler");
    } catch (e) {
      console.warn("[GlobalTrap] Failed to install RN ErrorUtils handler:", e instanceof Error ? e.message : String(e));
    }
  }

  // Web global handler. MM.1 — capability check, NOT existence: on React Native
  // `window` IS defined (it aliases globalThis) but has no addEventListener, so
  // `typeof window !== "undefined"` alone crashed Android boot before anything
  // mounted (ITEM MM, introduced in 7f8fb94). Same pattern as :79 below.
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("error", (event: ErrorEvent) => {
      logDetails("WEB", event.error ?? event.message);
      // Save the digest so the NEXT boot can report what killed this page —
      // the reload loop dies before the error boundary can paint.
      recordFatalError(event.error ?? event.message);
    });
    window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
      logDetails("WEB-unhandled", event.reason);
      recordFatalError(event.reason);
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
  } catch (trapInstallError) {
    // MM.2 — never let the trap itself kill boot.
    try {
      console.warn(
        "[GlobalTrap] install failed — boot continues without it:",
        trapInstallError instanceof Error ? trapInstallError.message : String(trapInstallError),
      );
    } catch {
      // console unavailable — nothing further we can do
    }
  }
})();

void SplashScreen.preventAutoHideAsync();

if (Platform.OS === 'web') {
  LogBox.ignoreLogs([
    'Cannot listen to the event from the provided iframe',
    'props.pointerEvents is deprecated',
  ]);

  // Runtime-error guard: translation tools (Google Translate and similar browser
  // features/extensions) rewrite the live DOM behind React's back, which makes
  // React's commit phase crash with
  // "removeChild: The node to be removed is not a child of this node".
  // Opting the whole document out of translation keeps the DOM React-owned.
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("translate", "no");
    document.documentElement.classList.add("notranslate");
  }

  // Runtime-error fix (removeChild class) — commit-phase DOM guard.
  //
  // React's commit phase removes nodes with Node.removeChild(parent, child) and
  // hard-crashes the whole tree with
  //   "Node.removeChild: The node to be removed is not a child of this node"
  // when any code re-parents or detaches a React-owned node behind its back
  // (auto-translation that ignores translate=no, browser extensions such as
  // Dark Reader/Grammarly, and preview-harness DOM processing all do this).
  //
  // This guard keeps the exact normal behaviour (parent === child.parentNode ->
  // untouched original call) and ONLY intercepts the pathological case:
  // the child is removed from wherever it actually lives, or treated as already
  // removed when detached. The commit completes; the app never unmounts.
  // Installed once, before React renders, web-only.
  if (typeof Node !== "undefined") {
    type RemoveChildFn = (this: Node, child: Node) => Node;
    type InsertBeforeFn = (this: Node, node: Node, ref: Node | null) => Node;
    type AppendChildFn = (this: Node, node: Node) => Node;
    const proto = Node.prototype as unknown as {
      removeChild: RemoveChildFn;
      insertBefore: InsertBeforeFn;
      appendChild: AppendChildFn;
      __domRemoveChildGuard?: boolean;
    };

    if (!proto.__domRemoveChildGuard) {
      const originalRemoveChild: RemoveChildFn = proto.removeChild;
      const originalInsertBefore: InsertBeforeFn = proto.insertBefore;
      const originalAppendChild: AppendChildFn = proto.appendChild;
      let lastGuardLogAt = 0;
      const warnRecovery = (op: string) => {
        // Rate-limited diagnostics — never spam, never leak node contents.
        const now = Date.now();
        if (now - lastGuardLogAt > 5000) {
          lastGuardLogAt = now;
          console.warn(
            `[DOMGuard] ${op} target was re-parented/detached behind React — recovering instead of crashing`,
          );
        }
      };

      proto.__domRemoveChildGuard = true;
      proto.removeChild = function removeChildGuard(this: Node, child: Node): Node {
        if (child && child.parentNode !== this) {
          warnRecovery("removeChild");
          if (child.parentNode) {
            return originalRemoveChild.call(child.parentNode, child);
          }
          return child;
        }
        return originalRemoveChild.call(this, child);
      };

      // insertBefore: the OTHER commit-phase insert React uses for new sibling
      // subtrees. A node with NO parent is the normal fresh-node case — never
      // intercepted. Only the pathological cases are recovered: the node being
      // inserted still lives under a DIFFERENT parent (re-parented behind
      // React's back), or the reference node is no longer a child of this node.
      proto.insertBefore = function insertBeforeGuard(this: Node, node: Node, ref: Node | null): Node {
        if (node && node.parentNode && node.parentNode !== this) {
          warnRecovery("insertBefore");
          try {
            originalRemoveChild.call(node.parentNode, node);
          } catch {
            // Already detached between check and call — proceed.
          }
        }
        if (ref && ref.parentNode !== this) {
          // Reference node detached behind React's back — appending preserves
          // the commit instead of throwing.
          warnRecovery("insertBefore");
          return originalAppendChild.call(this, node);
        }
        return originalInsertBefore.call(this, node, ref);
      };

      // appendChild: crashes with HierarchyRequestError when the node was
      // re-parented so that it now CONTAINS the target parent. Treat the
      // commit as complete instead of tearing the tree down.
      proto.appendChild = function appendChildGuard(this: Node, node: Node): Node {
        if (node && typeof node.contains === "function" && node.contains(this)) {
          warnRecovery("appendChild");
          return node;
        }
        return originalAppendChild.call(this, node);
      };

      console.log("[DOMGuard] removeChild/insertBefore/appendChild commit guards installed");
    }
  }

  // Boot-cycle forensics — once per page load, before React renders. Detects
  // rapid re-boots (the reload-loop signature) and replays the previous
  // session's uncaught-error digest into the console.
  recordBoot();
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

let lastOverlayLogAt = 0;

const LoadingOverlay = React.memo(() => {
  let isLoading = true;
  let mode: "data" | "context" = "context";
  try {
    const ctx = useTrading();
    isLoading = ctx.isLoading;
    mode = "data";
  } catch {
    // Trading context not ready yet — keep showing loading
  }

  // Overlay attribution: which mode is showing this overlay. "context" means
  // TradingContext is not even mounted — a remount signature, not slow data.
  useEffect(() => {
    if (!isLoading) return;
    const now = Date.now();
    if (now - lastOverlayLogAt < 5000) return;
    lastOverlayLogAt = now;
    if (mode === "context") {
      console.warn("[LoadOverlay] mode=context-unavailable (TradingContext not mounted — remount signature)");
    } else {
      console.log("[LoadOverlay] mode=data-loading (TradingContext.isLoading=true)");
    }
  }, [isLoading, mode]);

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
    /**
     * ITEM 225 / B5 — boot-time emission-schema assertion.
     *
     * Fire-and-forget by design: it must never delay or block boot, because the
     * whole point is to protect live signal capture, not to gate it. It derives
     * its expected column set from the write path's own toRow() keys and probes
     * the LIVE table, so it cannot go stale the way the Item 149 hand-maintained
     * inventory did (that guard printed PASS for days while three live emissions
     * were being silently pruned).
     */
    void assertEmittedSchemaContract();

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
    // Visible failure panel: after 3 rapid re-boots, stop flashing and show
    // the saved error digest so the loop becomes observable.
    const cycleCount = getBootLoopCycleCount();
    const fatal = getLastFatalDigest();
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={styles.bootContainer} testID="root-layout-boot-screen">
          <LinearGradient
            colors={["#050505", "#111827", "#050505"]}
            style={styles.bootGradient}
          >
            {cycleCount >= 3 ? (
              <View style={styles.failurePanel} testID="boot-loop-failure-panel">
                <Text style={styles.failureTitle}>
                  Boot loop detected ({cycleCount} rapid re-boots)
                </Text>
                {fatal ? (
                  <>
                    <Text style={styles.failureText}>last session ended with:</Text>
                    <Text style={styles.failureText}>{fatal.type}: {fatal.message}</Text>
                    {fatal.firstStackLine ? (
                      <Text style={styles.failureStack} numberOfLines={2}>{fatal.firstStackLine}</Text>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.failureText}>
                    no uncaught error captured — check [BootLoop] / [GlobalTrap] console lines
                  </Text>
                )}
              </View>
            ) : (
              <>
                <ActivityIndicator size="large" color="#FFD700" />
                <Text style={styles.loadingText}>Preparing live trading workspace...</Text>
              </>
            )}
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
  failurePanel: {
    paddingHorizontal: 24,
    paddingVertical: 20,
    borderRadius: 12,
    backgroundColor: "rgba(127, 29, 29, 0.35)",
    borderWidth: 1,
    borderColor: "#7f1d1d",
    maxWidth: 340,
    gap: 8,
  },
  failureTitle: {
    fontSize: 15,
    color: "#fca5a5",
    fontWeight: "700" as const,
    textAlign: "center",
  },
  failureText: {
    fontSize: 13,
    color: "#fecaca",
    textAlign: "center",
  },
  failureStack: {
    fontSize: 11,
    color: "#f87171",
    textAlign: "center",
  },
});
