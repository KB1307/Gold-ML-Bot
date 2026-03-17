import React, { useCallback, useMemo, useRef, useState } from "react";
import { View, StyleSheet, ActivityIndicator, Text } from "react-native";
import { WebView } from "react-native-webview";

const CHART_HEIGHT = 350;

interface PriceChartProps {
  onPriceUpdate?: (price: number) => void;
  isActive?: boolean;
}

const tradingViewHTML = `
<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { height: 100%; width: 100%; overflow: hidden; background: #0F0F0F; }
      .tradingview-widget-container { height: 100%; width: 100%; }
      .tradingview-widget-container__widget { height: 100%; width: 100%; }
      .tradingview-widget-copyright { display: none !important; }
    </style>
  </head>
  <body>
    <div class="tradingview-widget-container">
      <div class="tradingview-widget-container__widget"></div>
      <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>
      {
        "autosize": true,
        "symbol": "CAPITALCOM:GOLD",
        "interval": "5",
        "timezone": "Etc/UTC",
        "theme": "dark",
        "style": "1",
        "locale": "en",
        "backgroundColor": "rgba(15, 15, 15, 1)",
        "gridColor": "rgba(242, 242, 242, 0.06)",
        "allow_symbol_change": true,
        "calendar": false,
        "hide_top_toolbar": false,
        "hide_legend": false,
        "save_image": false,
        "hide_volume": false,
        "support_host": "https://www.tradingview.com"
      }
      </script>
    </div>
  </body>
</html>
`;

const PriceChart = React.memo(({ onPriceUpdate, isActive = true }: PriceChartProps) => {
  const webViewRef = useRef<WebView>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);

  const webSource = useMemo(() => ({ html: tradingViewHTML }), []);

  const handleLoadStart = useCallback(() => {
    console.log("[PriceChart] WebView loading started");
    setIsLoading(true);
    setHasError(false);
  }, []);

  const handleLoadEnd = useCallback(() => {
    console.log("[PriceChart] WebView loading ended");
    setIsLoading(false);
  }, []);

  const handleError = useCallback((syntheticEvent: { nativeEvent: unknown }) => {
    console.error("[PriceChart] WebView error:", syntheticEvent.nativeEvent);
    setHasError(true);
    setIsLoading(false);
  }, []);

  const handleHttpError = useCallback((syntheticEvent: { nativeEvent: { statusCode: number } }) => {
    console.error("[PriceChart] HTTP error:", syntheticEvent.nativeEvent.statusCode);
  }, []);

  const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const data = JSON.parse(event.nativeEvent.data) as { type?: string; value?: number };

      if (data.type === "chartReady") {
        setIsLoading(false);
      }

      if (data.type === "chartError") {
        setHasError(true);
      }

      if (data.type === "price" && typeof data.value === "number") {
        onPriceUpdate?.(data.value);
      }
    } catch (error) {
      console.warn("[PriceChart] Ignoring non-JSON WebView message", error);
    }
  }, [onPriceUpdate]);

  return (
    <View style={styles.container} testID="price-chart-container">
      {isLoading ? (
        <View style={styles.loadingOverlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#FFD700" />
          <Text style={styles.loadingText}>Loading Chart...</Text>
        </View>
      ) : null}

      {hasError ? (
        <View style={styles.errorContainer} pointerEvents="none">
          <Text style={styles.errorText}>Failed to load chart</Text>
          <Text style={styles.errorSubtext}>Please check your connection</Text>
        </View>
      ) : null}

      {isActive ? (
        <WebView
          ref={webViewRef}
          source={webSource}
          style={[styles.webview, isLoading ? styles.hidden : null]}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={false}
          scalesPageToFit={true}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          mixedContentMode="always"
          originWhitelist={["*"]}
          onLoadStart={handleLoadStart}
          onLoadEnd={handleLoadEnd}
          onError={handleError}
          onHttpError={handleHttpError}
          onMessage={handleMessage}
          testID="tradingview-chart"
        />
      ) : (
        <View style={styles.inactiveState} testID="price-chart-inactive" />
      )}
    </View>
  );
}, (prevProps, nextProps) => prevProps.isActive === nextProps.isActive && prevProps.onPriceUpdate === nextProps.onPriceUpdate);

PriceChart.displayName = "PriceChart";

export default PriceChart;

const styles = StyleSheet.create({
  container: {
    width: "100%",
    height: CHART_HEIGHT,
    backgroundColor: "#0F0F0F",
    borderRadius: 8,
    overflow: "hidden",
  },
  webview: {
    flex: 1,
    backgroundColor: "#0F0F0F",
    opacity: 1,
  },
  hidden: {
    opacity: 0,
  },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#0F0F0F",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  loadingText: {
    color: "#999",
    fontSize: 12,
    marginTop: 12,
  },
  errorContainer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#0F0F0F",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 10,
  },
  errorText: {
    color: "#ef4444",
    fontSize: 14,
    fontWeight: "600" as const,
    width: "100%",
    textAlign: "center",
  },
  errorSubtext: {
    color: "#666",
    fontSize: 12,
    marginTop: 4,
    width: "100%",
    textAlign: "center",
  },
  inactiveState: {
    flex: 1,
    backgroundColor: "#0F0F0F",
  },
});
