import React from "react";
import { StyleSheet, Text, TouchableOpacity, View, Platform } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { AlertTriangle, RefreshCw } from "lucide-react-native";

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
  errorStack: string;
}

function safeMessage(caught: unknown): string {
  if (caught instanceof Error) {
    return caught.message || `Error (${caught.name || "unknown"})`;
  }
  if (typeof caught === "string") {
    return caught;
  }
  if (caught === null) {
    return "null thrown";
  }
  if (caught === undefined) {
    return "undefined thrown";
  }
  if (typeof caught === "object" && caught !== null) {
    const keys = Object.keys(caught as Record<string, unknown>);
    if (keys.length === 0) {
      const proto = Object.getPrototypeOf(caught);
      const ctor = proto?.constructor?.name;
      return ctor ? `Empty ${ctor} (no properties)` : "Empty object thrown — check console for component stack";
    }
  }
  try {
    return JSON.stringify(caught);
  } catch {
    return String(caught);
  }
}

function safeStack(caught: unknown, componentStack?: string): string {
  const parts: string[] = [];
  if (caught instanceof Error && caught.stack) {
    parts.push(caught.stack.slice(0, 800));
  } else if (typeof caught === "object" && caught !== null) {
    try {
      parts.push(JSON.stringify(caught, null, 2).slice(0, 600));
    } catch {
      // ignore
    }
  }
  if (componentStack) {
    parts.push("\n-- Component Stack --\n" + componentStack.slice(0, 600));
  }
  return parts.join("");
}

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  public state: AppErrorBoundaryState = {
    hasError: false,
    errorMessage: "",
    errorStack: "",
  };

  private static lastComponentStack: string = "";

  private static lastErrorRaw: unknown = null;

  public static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    AppErrorBoundary.lastErrorRaw = error;
    // Log immediately so we capture it even if componentDidCatch hasn't fired
    console.error("[ErrorBoundary] getDerivedStateFromError caught:", typeof error, error);
    if (error instanceof Error) {
      console.error("[ErrorBoundary] Error name:", error.name, "message:", error.message);
      console.error("[ErrorBoundary] Error stack:", error.stack?.slice(0, 600));
    } else if (typeof error === "object" && error !== null) {
      const ctor = (error as object).constructor?.name ?? "unknown";
      const keys = Object.keys(error as Record<string, unknown>);
      console.error("[ErrorBoundary] non-Error object: constructor=", ctor, "keys=", keys);
      try {
        console.error("[ErrorBoundary] JSON:", JSON.stringify(error).slice(0, 400));
      } catch { /* not serializable */ }
    }
    return {
      hasError: true,
      errorMessage: safeMessage(error),
      errorStack: safeStack(error, AppErrorBoundary.lastComponentStack),
    };
  }

  public componentDidCatch(error: unknown, errorInfo: React.ErrorInfo): void {
    AppErrorBoundary.lastComponentStack = errorInfo.componentStack ?? "";
    console.error(
      "[ErrorBoundary] App render failure detected",
      error,
      errorInfo,
    );
    console.error("[ErrorBoundary] Component stack:", errorInfo.componentStack);
    if (error instanceof Error) {
      console.error("[ErrorBoundary] name:", error.name);
      console.error("[ErrorBoundary] message:", error.message);
      console.error("[ErrorBoundary] stack:", error.stack?.slice(0, 800));
    } else if (typeof error === "object" && error !== null) {
      console.error("[ErrorBoundary] non-Error thrown: typeof=", typeof error);
      console.error("[ErrorBoundary] constructor:", (error as object).constructor?.name);
      console.error("[ErrorBoundary] keys:", Object.keys(error as Record<string, unknown>));
      try {
        console.error("[ErrorBoundary] JSON:", JSON.stringify(error));
      } catch {
        console.error("[ErrorBoundary] (not JSON-serializable)");
      }
    } else {
      console.error("[ErrorBoundary] non-Error thrown:", typeof error, error);
    }
  }

  private handleRetry = (): void => {
    console.log("[ErrorBoundary] User requested UI retry");
    this.setState({ hasError: false, errorMessage: "" });
  };

  public render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <View style={styles.container} testID="app-error-boundary-screen">
        <LinearGradient
          colors={["#050505", "#111827", "#050505"]}
          style={styles.gradient}
        >
          <View style={styles.iconWrap}>
            <AlertTriangle size={28} color="#FFD700" />
          </View>
          <Text style={styles.title}>Something went off track</Text>
          <Text style={styles.subtitle}>{this.state.errorMessage}</Text>
          {this.state.errorStack ? (
            <View style={styles.stackBox}>
              <Text style={styles.stackText} numberOfLines={12}>
                {this.state.errorStack}
              </Text>
            </View>
          ) : null}
          <TouchableOpacity
            style={styles.retryButton}
            onPress={this.handleRetry}
            testID="app-error-boundary-retry-button"
          >
            <RefreshCw size={18} color="#111827" />
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </LinearGradient>
      </View>
    );
  }
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
    gap: 16,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 215, 0, 0.12)",
  },
  title: {
    fontSize: 22,
    fontWeight: "700" as const,
    color: "#fff",
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    color: "#a1a1aa",
  },
  retryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: "#FFD700",
  },
  retryText: {
    fontSize: 15,
    fontWeight: "700" as const,
    color: "#111827",
  },
  stackBox: {
    maxWidth: "90%",
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  stackText: {
    fontSize: 10,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: "#666",
    lineHeight: 14,
  },
});
