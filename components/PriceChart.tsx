import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet, ActivityIndicator, Text, Platform } from "react-native";
import { WebView } from "react-native-webview";

const CHART_HEIGHT = 350;
const CHART_READY_TIMEOUT_MS = 8000;

interface PriceChartProps {
  onPriceUpdate?: (price: number) => void;
  isActive?: boolean;
}

interface ChartBridgeMessage {
  instanceId?: string;
  type?: "chartReady" | "chartError" | "price" | "chartBootstrap";
  value?: number;
  message?: string;
}

function buildTradingViewHTML(instanceId: string): string {
  return `
<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { height: 100%; width: 100%; overflow: hidden; background: #0F0F0F; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      #tv_chart_container { height: 100%; width: 100%; }
      .tradingview-widget-copyright { display: none !important; }
    </style>
  </head>
  <body>
    <div id="tv_chart_container"></div>
    <script>
      (function () {
        var chartInstanceId = ${JSON.stringify(instanceId)};

        function bridge(payload) {
          try {
            var message = JSON.stringify(Object.assign({ instanceId: chartInstanceId }, payload));

            if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
              window.ReactNativeWebView.postMessage(message);
            }

            if (window.parent && window.parent !== window) {
              window.parent.postMessage(message, '*');
            }
          } catch (error) {
          }
        }

        window.onerror = function (message) {
          bridge({ type: 'chartError', message: String(message || 'TradingView failed to render') });
          return false;
        };

        function initChart() {
          if (!window.TradingView || typeof window.TradingView.widget !== 'function') {
            bridge({ type: 'chartError', message: 'TradingView widget unavailable' });
            return;
          }

          new window.TradingView.widget({
            autosize: true,
            symbol: 'CAPITALCOM:GOLD',
            interval: '5',
            timezone: 'Etc/UTC',
            theme: 'dark',
            style: '1',
            locale: 'en',
            withdateranges: true,
            allow_symbol_change: true,
            hide_side_toolbar: false,
            hide_top_toolbar: false,
            hide_legend: false,
            save_image: false,
            calendar: false,
            backgroundColor: '#0F0F0F',
            gridColor: 'rgba(242, 242, 242, 0.06)',
            container_id: 'tv_chart_container',
            support_host: 'https://www.tradingview.com'
          });

          window.setTimeout(function () {
            bridge({ type: 'chartReady' });
          }, 1800);
        }

        var script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/tv.js';
        script.async = true;
        script.onload = initChart;
        script.onerror = function () {
          bridge({ type: 'chartError', message: 'Failed to load TradingView script' });
        };
        document.head.appendChild(script);
        bridge({ type: 'chartBootstrap' });
      })();
    </script>
  </body>
</html>
`;
}

const PriceChart = React.memo(({ onPriceUpdate, isActive = true }: PriceChartProps) => {
  const webViewRef = useRef<WebView>(null);
  const instanceIdRef = useRef<string>(`price-chart-${Math.random().toString(36).slice(2, 10)}`);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasError, setHasError] = useState<boolean>(false);

  const htmlSource = useMemo(() => ({ html: buildTradingViewHTML(instanceIdRef.current) }), []);

  const handleBridgePayload = useCallback((payload: ChartBridgeMessage) => {
    if (payload.instanceId !== instanceIdRef.current) {
      return;
    }

    if (payload.type === "chartReady") {
      console.log("[PriceChart] TradingView chart ready");
      setHasError(false);
      setIsLoading(false);
      return;
    }

    if (payload.type === "chartError") {
      console.error("[PriceChart] Chart bridge error:", payload.message ?? "Unknown chart error");
      setHasError(true);
      setIsLoading(false);
      return;
    }

    if (payload.type === "price" && typeof payload.value === "number") {
      onPriceUpdate?.(payload.value);
    }
  }, [onPriceUpdate]);

  useEffect(() => {
    if (!isActive) {
      setIsLoading(false);
      setHasError(false);
      return;
    }

    setIsLoading(true);
    setHasError(false);

    const timeout = setTimeout(() => {
      setIsLoading((previousValue) => {
        if (previousValue) {
          console.warn("[PriceChart] Chart ready signal timed out, revealing container");
          return false;
        }

        return previousValue;
      });
    }, CHART_READY_TIMEOUT_MS);

    return () => {
      clearTimeout(timeout);
    };
  }, [isActive, htmlSource]);

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }

    const webGlobal = globalThis as typeof globalThis & {
      addEventListener?: (type: string, listener: (event: { data?: unknown }) => void) => void;
      removeEventListener?: (type: string, listener: (event: { data?: unknown }) => void) => void;
    };

    const handleWindowMessage = (event: { data?: unknown }) => {
      if (typeof event.data !== "string") {
        return;
      }

      try {
        const payload = JSON.parse(event.data) as ChartBridgeMessage;
        handleBridgePayload(payload);
      } catch (error) {
        console.warn("[PriceChart] Ignoring non-JSON window message", error);
      }
    };

    webGlobal.addEventListener?.("message", handleWindowMessage);

    return () => {
      webGlobal.removeEventListener?.("message", handleWindowMessage);
    };
  }, [handleBridgePayload]);

  const handleLoadStart = useCallback(() => {
    console.log("[PriceChart] Chart loading started");
    setIsLoading(true);
    setHasError(false);
  }, []);

  const handleLoadEnd = useCallback(() => {
    console.log("[PriceChart] Chart document loaded");
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
      const payload = JSON.parse(event.nativeEvent.data) as ChartBridgeMessage;
      handleBridgePayload(payload);
    } catch (error) {
      console.warn("[PriceChart] Ignoring non-JSON WebView message", error);
    }
  }, [handleBridgePayload]);

  const handleWebIframeLoad = useCallback(() => {
    console.log("[PriceChart] Web iframe loaded");
  }, []);

  const webIframeStyle = useMemo(() => ({
    width: "100%",
    height: "100%",
    border: "0",
    backgroundColor: "#0F0F0F",
  }), []);

  const webIframe = useMemo(() => {
    if (Platform.OS !== "web") {
      return null;
    }

    return React.createElement("iframe", {
      title: "TradingView XAUUSD chart",
      srcDoc: htmlSource.html,
      style: webIframeStyle,
      sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
      loading: "eager",
      referrerPolicy: "origin",
      onLoad: handleWebIframeLoad,
      "data-testid": "tradingview-chart-web",
    } as Record<string, unknown>);
  }, [handleWebIframeLoad, htmlSource.html, webIframeStyle]);

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
        Platform.OS === "web" ? (
          <View style={[styles.webview, isLoading ? styles.hidden : null]} testID="tradingview-chart-web-wrapper">
            {webIframe}
          </View>
        ) : (
          <WebView
            ref={webViewRef}
            source={htmlSource}
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
        )
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
