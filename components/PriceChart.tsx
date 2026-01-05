import React, { useRef, useState, useEffect, useMemo, useCallback } from "react";
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

let globalIframeContainer: HTMLDivElement | null = null;
let globalIframeElement: HTMLIFrameElement | null = null;
let isChartInitialized = false;

function initializeGlobalChart() {
  if (typeof document === 'undefined') return;
  
  if (isChartInitialized && globalIframeElement && globalIframeContainer) {
    // Ensure it's in the body (in case it was removed somehow, though we try to keep it)
    if (!document.body.contains(globalIframeContainer)) {
       document.body.appendChild(globalIframeContainer);
    }
    return;
  }
  
  isChartInitialized = true;
  console.log('[PriceChart] Initializing global chart container');
  
  if (globalIframeContainer && globalIframeContainer.parentNode) {
    globalIframeContainer.parentNode.removeChild(globalIframeContainer);
  }
  
  globalIframeContainer = document.createElement('div');
  globalIframeContainer.id = 'tradingview-global-container';
  // Position fixed to ensure it stays in place relative to viewport
  // We will update its coordinates to match the placeholder
  globalIframeContainer.style.cssText = `
    position: fixed;
    top: -9999px;
    left: -9999px;
    width: 100%;
    max-width: 800px;
    height: ${CHART_HEIGHT}px;
    pointer-events: none;
    opacity: 0;
    z-index: 9999;
    transition: opacity 0.2s ease-in-out;
  `;
  
  globalIframeElement = document.createElement('iframe');
  globalIframeElement.src = CHART_URL;
  globalIframeElement.style.cssText = `
    width: 100%;
    height: 100%;
    border: none;
    border-radius: 8px;
    display: block;
    background-color: #0F0F0F;
  `;
  globalIframeElement.title = 'TradingView Chart';
  globalIframeElement.referrerPolicy = 'no-referrer';
  globalIframeElement.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
  globalIframeElement.setAttribute('loading', 'eager');
  
  globalIframeElement.onload = () => {
    console.log('[PriceChart] Global iframe loaded successfully');
  };
  
  globalIframeContainer.appendChild(globalIframeElement);
  document.body.appendChild(globalIframeContainer);
}

const WebChart = React.memo(() => {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  useEffect(() => {
    initializeGlobalChart();
    
    // We use an Overlay Strategy:
    // The iframe is strictly kept in document.body with position: fixed.
    // We constantly update its position to match the placeholderRef.
    // This PREVENTS reload because the iframe is never moved in the DOM tree.
    
    const updatePosition = () => {
      if (placeholderRef.current && globalIframeContainer) {
        const rect = placeholderRef.current.getBoundingClientRect();
        
        // Simple visibility check
        const isVisible = rect.width > 0 && rect.height > 0 && 
                          rect.bottom > 0 && rect.top < window.innerHeight &&
                          rect.right > 0 && rect.left < window.innerWidth;

        if (!isVisible) {
           globalIframeContainer.style.opacity = '0';
           globalIframeContainer.style.pointerEvents = 'none';
        } else {
           globalIframeContainer.style.left = `${rect.left}px`;
           globalIframeContainer.style.top = `${rect.top}px`;
           globalIframeContainer.style.width = `${rect.width}px`;
           globalIframeContainer.style.height = `${rect.height}px`;
           globalIframeContainer.style.opacity = '1';
           globalIframeContainer.style.pointerEvents = 'auto';
        }
      }
    };

    // Initial check
    updatePosition();
    setTimeout(updatePosition, 100);
    setIsLoading(false);

    // Continuous update loop (using requestAnimationFrame for smoothness, or setInterval for lower CPU)
    // Using setInterval at 30fps to reduce overhead, as precise pixel perf isn't critical for a chart
    const intervalId = setInterval(updatePosition, 33);
    
    // Also listen to events
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    
    return () => {
      clearInterval(intervalId);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
      
      // Hide on unmount
      if (globalIframeContainer) {
         globalIframeContainer.style.opacity = '0';
         globalIframeContainer.style.pointerEvents = 'none';
         globalIframeContainer.style.top = '-9999px';
      }
    };
  }, []);
  
  return (
    <View style={styles.container}>
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#FFD700" />
          <Text style={styles.loadingText}>Loading Chart...</Text>
        </View>
      )}
      <div
        ref={placeholderRef as any}
        style={{
          width: '100%',
          height: CHART_HEIGHT,
          borderRadius: 8,
          // Background to show while loading or if iframe lags
          backgroundColor: '#0F0F0F', 
        }}
      />
    </View>
  );
}, () => true);

WebChart.displayName = 'WebChart';

const NativeChart = React.memo(({ onPriceUpdate }: PriceChartProps) => {
  const webViewRef = useRef<WebView>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  // Memoize source to prevent reloading on re-renders
  const source = useMemo(() => ({ html: tradingViewHTML }), []);

  const handleLoadStart = useCallback(() => {
    console.log('[PriceChart] WebView loading started');
    setIsLoading(true);
    setHasError(false);
  }, []);

  const handleLoadEnd = useCallback(() => {
    console.log('[PriceChart] WebView loading ended');
    setIsLoading(false);
  }, []);

  const handleError = useCallback((syntheticEvent: any) => {
    const { nativeEvent } = syntheticEvent;
    console.error('[PriceChart] WebView error:', nativeEvent);
    setHasError(true);
    setIsLoading(false);
  }, []);

  const handleMessage = useCallback((event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type !== 'price') {
        console.log('[PriceChart] Message received:', data.type);
      }
      
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
  }, [onPriceUpdate]);

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
        source={source}
        style={[styles.webview, isLoading && styles.hidden]}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={false}
        scalesPageToFit={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="always"
        originWhitelist={['*']}
        onLoadStart={handleLoadStart}
        onLoadEnd={handleLoadEnd}
        onError={handleError}
        onHttpError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.error('[PriceChart] HTTP error:', nativeEvent.statusCode);
        }}
        onMessage={handleMessage}
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
