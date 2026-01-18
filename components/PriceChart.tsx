import React, { useEffect, useRef } from 'react';
import { StyleSheet, View, Platform } from 'react-native';
import { WebView } from 'react-native-webview';

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------
const CHART_CONFIG = {
  "autosize": true,
  "symbol": "CAPITALCOM:GOLD",
  "interval": "5",
  "timezone": "Etc/UTC",
  "theme": "dark",
  "style": "1",
  "locale": "en",
  "enable_publishing": false,
  "allow_symbol_change": true,
  "hide_side_toolbar": true,
  "hide_top_toolbar": false,
  "hide_legend": false,
  "save_image": false,
  "calendar": false,
  "hide_volume": false,
  "support_host": "https://www.tradingview.com",
  "backgroundColor": "#0F0F0F",
  "gridColor": "rgba(242, 242, 242, 0.06)",
};

const HTML_CONTENT = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <style>
    body, html {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: #0F0F0F;
    }
    .tradingview-widget-container {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
  </style>
</head>
<body>
  <div class="tradingview-widget-container">
    <div class="tradingview-widget-container__widget"></div>
    <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>
      ${JSON.stringify(CHART_CONFIG)}
    </script>
  </div>
</body>
</html>
`;

// -----------------------------------------------------------------------------
// WEB IMPLEMENTATION (Global Singleton)
// -----------------------------------------------------------------------------
// We store the iframe in a global variable so it persists across re-renders/unmounts
// preventing the "loading loop" and state loss.
let globalWebIframe: HTMLIFrameElement | null = null;

const WebChart = React.memo(() => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    // 1. Create global iframe if it doesn't exist (Runs once per app session)
    if (!globalWebIframe) {
      const iframe = document.createElement('iframe');
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = 'none';
      iframe.style.overflow = 'hidden';
      iframe.style.backgroundColor = '#0F0F0F';
      
      // Use Blob to load content securely
      const blob = new Blob([HTML_CONTENT], { type: 'text/html' });
      iframe.src = URL.createObjectURL(blob);
      
      globalWebIframe = iframe;
    }

    // 2. Attach to current container
    const container = containerRef.current;
    if (container && globalWebIframe) {
      // If the iframe is already elsewhere, this moves it here.
      // If it's already here, it does nothing.
      if (!container.contains(globalWebIframe)) {
        container.appendChild(globalWebIframe);
      }
    }
    
    // NOTE: We intentionally DO NOT remove the iframe on cleanup
    // to preserve its state/loading progress. 
    // It stays in memory until attached to a new container.
  }, []);

  return (
    <div 
      ref={containerRef} 
      style={{ 
        width: '100%', 
        height: '100%', 
        overflow: 'hidden',
        backgroundColor: '#0F0F0F'
      }} 
    />
  );
}, () => true); // Strict memoization: Never re-render

WebChart.displayName = 'WebChart';

// -----------------------------------------------------------------------------
// NATIVE IMPLEMENTATION
// -----------------------------------------------------------------------------
const NATIVE_SOURCE = { html: HTML_CONTENT };

const NativeChart = React.memo(() => {
  return (
    <WebView
      originWhitelist={['*']}
      source={NATIVE_SOURCE}
      style={styles.webview}
      containerStyle={styles.webviewContainer}
      scrollEnabled={false}
      bounces={false}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      androidLayerType="hardware"
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      onError={(syntheticEvent) => {
        const { nativeEvent } = syntheticEvent;
        console.warn('WebView error: ', nativeEvent);
      }}
    />
  );
}, () => true); // Strict memoization: Never re-render

NativeChart.displayName = 'NativeChart';

// -----------------------------------------------------------------------------
// MAIN EXPORT
// -----------------------------------------------------------------------------
function PriceChart() {
  return (
    <View style={styles.container}>
      {Platform.OS === 'web' ? <WebChart /> : <NativeChart />}
    </View>
  );
}

// Memoize the main component to prevent any parent-induced re-renders
export default React.memo(PriceChart);

const styles = StyleSheet.create({
  container: {
    width: '100%',
    // Use aspectRatio instead of fixed height calculation to avoid re-renders on resize
    // 1.25 is equivalent to width * 0.8 (1 / 0.8 = 1.25)
    aspectRatio: 1.25, 
    backgroundColor: '#0F0F0F',
    borderRadius: 12,
    overflow: 'hidden',
    // Consistent shadow/elevation
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
      },
      android: {
        elevation: 4,
      },
    }),
  },
  webview: {
    flex: 1,
    backgroundColor: '#0F0F0F',
  },
  webviewContainer: {
    flex: 1, 
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#0F0F0F',
  },
});
