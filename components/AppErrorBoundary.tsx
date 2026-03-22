import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { AlertTriangle, RefreshCw } from "lucide-react-native";

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  public state: AppErrorBoundaryState = {
    hasError: false,
    errorMessage: "",
  };

  public static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error.message || "Unexpected application error",
    };
  }

  public componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[ErrorBoundary] App render failure detected", error, errorInfo);
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
});
