import React, { useRef, useState } from "react";
import { View, StyleSheet, Platform, ActivityIndicator, Text } from "react-native";
import { WebView } from "react-native-webview";

const CHART_HEIGHT = 350;

interface PriceChartProps {
  onPriceUpdate?: (price: number) => void;
}

const CHART_URL = "https://s.tradingview.com/widgetembed/?frameElementId=tradingview_chart&symbol=OANDA%3AXAUUSD&interval=5&theme=dark&style=1&timezone=Etc%2FUTC&studies=%5B%5D&hide_side_toolbar=0&allow_symbol_change=1&save_image=0&locale=en&toolbar_bg=%230F0F0F&enable_publishing=false";

const tradingViewHTML = `
<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval' https://s3.tradingview.com https://www.tradingview-widget.com; frame-src https://s.tradingview.com;">
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
            disable_resolution_rebuild: true,
            
            onChartReady: function() {
              console.log("TradingView chart ready");
              isChartReady = true;
              
              if (window.ReactNativeWebView) {
                window.ReactNativeWebView.postMessage(JSON.stringify({ 
                  type: 'chartReady', 
                  timestamp: Date.now() 
                }));
              }
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
            }
          }, 2000);
          
        } catch (error) {
          console.error("TradingView widget initialization failed:", error);
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
`;

const WebChart = React.memo(() => {
  // Use a ref to ensure we only create the iframe HTML once and avoid React re-creating the iframe element
  const iframeHtml = `<iframe src="${CHART_URL}" style="width: 100%; height: 100%; border: none; background-color: #0F0F0F;" allow="autoplay; encrypted-media" title="TradingView Chart"></iframe>`;
  
  return React.createElement('div', {
    style: { width: '100%', height: '100%', backgroundColor: '#0F0F0F' },
    dangerouslySetInnerHTML: { __html: iframeHtml }
  });
}, () => true);

WebChart.displayName = 'WebChart';

const NativeChart = React.memo(({ onPriceUpdate }: PriceChartProps) => {
  const webViewRef = useRef<WebView>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

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

NativeChart.displayName = 'NativeChart';

const PriceChart = React.memo(({ onPriceUpdate }: PriceChartProps) => {
  if (Platform.OS === 'web') {
    return <WebChart />;
  }
  return <NativeChart onPriceUpdate={onPriceUpdate} />;
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
  loadingHidden: {
    opacity: 0,
    pointerEvents: 'none',
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
