import React, { useMemo, useRef, useState } from "react";
import { View, StyleSheet, Platform, ActivityIndicator, Text } from "react-native";
import { WebView } from "react-native-webview";

const CHART_HEIGHT = 350;

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
  onPriceUpdate?: (price: number) => void;
}

const PriceChart = React.memo(({ data, currentPrice, onPriceUpdate }: PriceChartProps) => {
  const webViewRef = useRef<WebView>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const tradingViewHTML = useMemo(() => `
<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>
      body { margin: 0; padding: 0; overflow: hidden; background: #0F0F0F; }
      .tradingview-widget-container { height: 100vh; width: 100vw; }
      .tradingview-widget-container__widget { height: calc(100% - 32px); width: 100%; }
    </style>
  </head>
  <body>
    <div class="tradingview-widget-container">
      <div id="tradingview_chart" class="tradingview-widget-container__widget"></div>
    </div>
    <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
    <script type="text/javascript">
      (function() {
        let chartWidget = null;
        let isChartReady = false;
        
        // SAFE GATE: Initialize tracking only after chart is ready
        function initializeTracking() {
            if (typeof fbq === 'function') {
                console.log("Chart stable. Initializing Meta Pixel...");
                fbq('track', 'PageView');
            } else {
                console.log("Meta Pixel (fbq) not found, skipping tracking.");
            }
        }
        
        try {
          chartWidget = new TradingView.widget({
            autosize: true,
            symbol: "OANDA:XAUUSD",
            interval: "5",
            timezone: "Etc/UTC",
            theme: "dark",
            style: "1",
            locale: "en",
            toolbar_bg: "#0F0F0F",
            enable_publishing: false,
            allow_symbol_change: true,
            container_id: "tradingview_chart",
            hide_side_toolbar: false,
            studies: [],
            show_popup_button: true,
            popup_width: "1000",
            popup_height: "800",
            
            onChartReady: function() {
              console.log("✅ TradingView chart ready and WebSocket stable");
              isChartReady = true;
              
              if (window.ReactNativeWebView) {
                window.ReactNativeWebView.postMessage(JSON.stringify({ 
                  type: 'chartReady', 
                  timestamp: Date.now() 
                }));
              }
              
              // SAFE GATE: Add buffer before initializing tracking
              setTimeout(initializeTracking, 500);
            }
          });
          
          setInterval(function() {
            if (!isChartReady) return;
            
            try {
              const iframe = document.querySelector('iframe');
              if (iframe && iframe.contentWindow) {
                const priceElement = iframe.contentDocument?.querySelector('.price-axis-last-price');
                if (priceElement) {
                  const price = parseFloat(priceElement.textContent);
                  if (!isNaN(price) && price > 0) {
                    if (window.ReactNativeWebView) {
                      window.ReactNativeWebView.postMessage(JSON.stringify({ 
                        type: 'price', 
                        value: price 
                      }));
                    }
                  }
                }
              }
            } catch (e) {
              console.log('Cannot access chart price:', e);
            }
          }, 2000);
          
        } catch (error) {
          console.error("❌ TradingView widget initialization failed:", error);
          if (window.ReactNativeWebView) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ 
              type: 'chartError', 
              error: error.message 
            }));
          }
        }
      })();
    </script>
  </body>
</html>
  `, []);

  const chartUrl = useMemo(() => {
    const params = {
      frameElementId: "tradingview_chart",
      symbol: "OANDA:XAUUSD",
      interval: "5",
      theme: "dark",
      style: "1",
      timezone: "Etc/UTC",
      studies: "[]",
      hide_side_toolbar: "0",
      allow_symbol_change: "1",
      save_image: "0",
      locale: "en",
      toolbar_bg: "#0F0F0F",
      enable_publishing: "false",
    };
    
    const queryString = Object.entries(params)
      .map(([key, val]) => `${key}=${encodeURIComponent(val)}`)
      .join('&');
      
    return `https://s.tradingview.com/widgetembed/?${queryString}`;
  }, []);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        <View style={styles.iframeContainer}>
          <iframe
            src={chartUrl}
            style={{
              width: '100%',
              height: CHART_HEIGHT,
              border: 'none',
              borderRadius: 8,
            } as React.CSSProperties}
            title="TradingView Chart"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            loading="lazy"
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#FFD700" />
          <Text style={styles.loadingText}>Loading Chart...</Text>
        </View>
      )}
      {hasError && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Failed to load chart</Text>
          <Text style={styles.errorSubtext}>Please check your connection</Text>
        </View>
      )}
      <WebView
        ref={webViewRef}
        source={{ html: tradingViewHTML }}
        style={[styles.webview, isLoading && styles.hidden]}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={false}
        scalesPageToFit={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="always"
        originWhitelist={['*']}
        onLoadStart={() => {
          console.log('[PriceChart] WebView loading started');
          setIsLoading(true);
          setHasError(false);
        }}
        onLoadEnd={() => {
          console.log('[PriceChart] WebView loading ended');
          setIsLoading(false);
        }}
        onError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.error('[PriceChart] WebView error:', nativeEvent);
          setHasError(true);
          setIsLoading(false);
        }}
        onHttpError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.error('[PriceChart] HTTP error:', nativeEvent.statusCode);
        }}
        onMessage={(event) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            console.log('[PriceChart] Message received:', data.type);
            if (data.type === 'chartReady') {
              console.log('[PriceChart] Chart is ready');
              setIsLoading(false);
            }
            if (data.type === 'chartError') {
              console.error('[PriceChart] Chart error:', data.error);
              setHasError(true);
            }
            if (data.type === 'price' && data.value && onPriceUpdate) {
              onPriceUpdate(data.value);
            }
          } catch (e) {
            console.log('[PriceChart] Error parsing WebView message:', e);
          }
        }}
        testID="tradingview-chart"
      />
    </View>
  );
});

PriceChart.displayName = 'PriceChart';

export default PriceChart;

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: CHART_HEIGHT,
    backgroundColor: '#0F0F0F',
    borderRadius: 8,
    overflow: 'hidden',
  },
  iframeContainer: {
    flex: 1,
    width: '100%',
    height: CHART_HEIGHT,
  },
  webview: {
    flex: 1,
    backgroundColor: '#0F0F0F',
    opacity: 1,
  },
  hidden: {
    opacity: 0,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0F0F0F',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  loadingText: {
    color: '#999',
    fontSize: 12,
    marginTop: 12,
  },
  errorContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0F0F0F',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600' as const,
  },
  errorSubtext: {
    color: '#666',
    fontSize: 12,
    marginTop: 4,
  },
});
