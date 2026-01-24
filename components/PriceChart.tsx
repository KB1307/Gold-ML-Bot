import React, { useRef, useState, useEffect } from "react";
import { View, StyleSheet, Platform, ActivityIndicator, Text } from "react-native";
import { WebView } from "react-native-webview";

const CHART_HEIGHT = 350;

// Module-level singleton for web - completely outside React lifecycle
let globalIframeElement: HTMLIFrameElement | null = null;
let iframeFullyLoaded = false;
let iframeLoadPromise: Promise<void> | null = null;
let chartContainerRegistry = new Map<string, HTMLElement>();

interface PriceChartProps {
  onPriceUpdate?: (price: number) => void;
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

// Create iframe once globally, completely outside React
function ensureGlobalIframe(): Promise<void> {
  if (iframeFullyLoaded && globalIframeElement) {
    return Promise.resolve();
  }
  
  if (iframeLoadPromise) {
    return iframeLoadPromise;
  }
  
  iframeLoadPromise = new Promise((resolve) => {
    console.log('[WebChart] Creating global iframe (once)');
    
    const iframe = document.createElement('iframe');
    iframe.srcdoc = tradingViewHTML;
    iframe.style.cssText = 'width:100%;height:100%;border:none;background:#0F0F0F;display:block;position:absolute;top:0;left:0;';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
    iframe.title = 'TradingView Chart';
    
    iframe.onload = () => {
      console.log('[WebChart] Global iframe loaded');
      iframeFullyLoaded = true;
      resolve();
    };
    
    iframe.onerror = () => {
      console.log('[WebChart] Global iframe error');
      iframeLoadPromise = null;
      resolve();
    };
    
    globalIframeElement = iframe;
    
    // Fallback timeout
    setTimeout(() => {
      if (!iframeFullyLoaded) {
        console.log('[WebChart] Fallback timeout');
        iframeFullyLoaded = true;
        resolve();
      }
    }, 10000);
  });
  
  return iframeLoadPromise;
}

// Attach iframe to a specific container
function attachIframeToContainer(containerId: string, container: HTMLElement) {
  if (!globalIframeElement) return;
  
  // Check if already attached to this container
  if (globalIframeElement.parentElement === container) {
    return;
  }
  
  // Move iframe to new container
  try {
    container.appendChild(globalIframeElement);
    chartContainerRegistry.set(containerId, container);
  } catch (e) {
    console.error('[WebChart] Error attaching iframe:', e);
  }
}

const WebChart = React.memo(() => {
  const [isLoading, setIsLoading] = useState(!iframeFullyLoaded);
  const [hasError, setHasError] = useState(false);
  const containerRef = useRef<View>(null);
  const containerIdRef = useRef(`chart-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    
    if (Platform.OS !== 'web') return;
    
    const containerId = containerIdRef.current;
    
    // Use requestAnimationFrame to ensure DOM is ready
    const rafId = requestAnimationFrame(() => {
      const domNode = containerRef.current as unknown as HTMLElement;
      if (!domNode || !mountedRef.current) return;
      
      ensureGlobalIframe().then(() => {
        if (!mountedRef.current) return;
        
        attachIframeToContainer(containerId, domNode);
        setIsLoading(false);
      }).catch(() => {
        if (mountedRef.current) {
          setHasError(true);
          setIsLoading(false);
        }
      });
    });
    
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafId);
      // Don't remove iframe on unmount - keep it in last container
    };
  }, []);

  if (hasError) {
    return (
      <View style={styles.container} testID="web-chart-container">
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Failed to load chart</Text>
          <Text style={styles.errorSubtext}>Please refresh the page</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="web-chart-container">
      {isLoading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color="#FFD700" />
          <Text style={styles.loadingText}>Loading Chart...</Text>
        </View>
      )}
      <View 
        ref={containerRef}
        style={styles.webChartInner}
      />
    </View>
  );
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
            if (data.type === 'chartReady') {
              setIsLoading(false);
            }
            if (data.type === 'chartError') {
              setHasError(true);
            }
            if (data.type === 'price' && data.value && onPriceUpdate) {
              onPriceUpdate(data.value);
            }
          } catch {
            // Ignore parse errors
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
}, () => true); // Never re-render the main wrapper either

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
  webChartInner: {
    flex: 1,
    width: '100%',
    height: '100%',
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
    width: '100%',
    textAlign: 'center',
  },
  errorSubtext: {
    color: '#666',
    fontSize: 12,
    marginTop: 4,
    width: '100%',
    textAlign: 'center',
  },
});
