import React, { useRef, useState, useEffect } from "react";
import { View, StyleSheet, Platform, ActivityIndicator, Text } from "react-native";
import { WebView } from "react-native-webview";

const CHART_HEIGHT = 350;

// Module-level singleton for web - completely outside React lifecycle
let globalIframeElement: HTMLIFrameElement | null = null;
let iframeFullyLoaded = false;
let iframeInitialized = false;

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

// Initialize iframe once globally - append to body and never move it
function initializeGlobalIframe(): void {
  if (iframeInitialized) return;
  if (typeof document === 'undefined') return;
  
  iframeInitialized = true;
  console.log('[WebChart] Initializing global iframe (once)');
  
  const iframe = document.createElement('iframe');
  iframe.srcdoc = tradingViewHTML;
  iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;background:#0F0F0F;pointer-events:none;opacity:0;';
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
  iframe.title = 'TradingView Chart';
  iframe.id = 'tradingview-global-iframe';
  
  iframe.onload = () => {
    console.log('[WebChart] Global iframe loaded (final)');
    iframeFullyLoaded = true;
  };
  
  globalIframeElement = iframe;
  document.body.appendChild(iframe);
}

// Position the iframe over a container without moving it in DOM
function positionIframeOverContainer(container: HTMLElement): void {
  if (!globalIframeElement) return;
  
  const rect = container.getBoundingClientRect();
  globalIframeElement.style.cssText = `
    position:fixed;
    top:${rect.top}px;
    left:${rect.left}px;
    width:${rect.width}px;
    height:${rect.height}px;
    border:none;
    background:#0F0F0F;
    pointer-events:auto;
    opacity:1;
    z-index:1;
  `;
}

// Hide the iframe (move offscreen)
function hideIframe(): void {
  if (!globalIframeElement) return;
  globalIframeElement.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none;opacity:0;pointer-events:none;';
}

const WebChart = React.memo(() => {
  const [isLoading, setIsLoading] = useState(!iframeFullyLoaded);
  const [hasError, setHasError] = useState(false);
  const containerRef = useRef<View>(null);
  const mountedRef = useRef(true);
  const lastPositionRef = useRef<string>('');
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    
    if (Platform.OS !== 'web') return;
    
    initializeGlobalIframe();
    
    const updatePosition = () => {
      if (!mountedRef.current) return;
      const domNode = containerRef.current as unknown as HTMLElement;
      if (domNode && globalIframeElement) {
        const rect = domNode.getBoundingClientRect();
        const posKey = `${rect.top.toFixed(0)},${rect.left.toFixed(0)},${rect.width.toFixed(0)},${rect.height.toFixed(0)}`;
        
        if (posKey !== lastPositionRef.current) {
          lastPositionRef.current = posKey;
          positionIframeOverContainer(domNode);
        }
        
        if (iframeFullyLoaded) {
          setIsLoading(false);
        }
      }
    };
    
    const initialTimeout = setTimeout(updatePosition, 100);
    
    let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleScrollResize = () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(updatePosition);
      }, 16);
    };
    
    window.addEventListener('scroll', handleScrollResize, true);
    window.addEventListener('resize', handleScrollResize);
    
    const loadCheckInterval = setInterval(() => {
      if (iframeFullyLoaded && mountedRef.current) {
        setIsLoading(false);
        clearInterval(loadCheckInterval);
      }
    }, 200);
    
    return () => {
      mountedRef.current = false;
      clearTimeout(initialTimeout);
      if (scrollTimeout) clearTimeout(scrollTimeout);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearInterval(loadCheckInterval);
      window.removeEventListener('scroll', handleScrollResize, true);
      window.removeEventListener('resize', handleScrollResize);
      hideIframe();
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
