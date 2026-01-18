import React, { useRef, useEffect } from 'react';
import { StyleSheet, View, Platform, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';

// 1. STABLE HTML SOURCE (Fixes the "Loading Loop")
// We define this OUTSIDE the component so it never changes identity.
const tradingViewHTML = `
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
      background-color: transparent;
    }
    .tradingview-widget-container {
      width: 100% !important;
      height: 100% !important;
    }
    iframe {
      width: 100% !important;
      height: 100% !important;
      border: none;
    }
  </style>
</head>
<body>
  <div class="tradingview-widget-container">
    <div id="tradingview_widget"></div>
    <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
    <script type="text/javascript">
      new TradingView.widget({
        "width": "100%",
        "height": "100%",
        "symbol": "OANDA:XAUUSD",
        "interval": "5",
        "timezone": "Etc/UTC",
        "theme": "dark",
        "style": "1",
        "locale": "en",
        "toolbar_bg": "#f1f3f6",
        "enable_publishing": false,
        "hide_top_toolbar": true,
        "save_image": false,
        "container_id": "tradingview_widget",
        "studies": [],
        "hide_volume": true
      });
    </script>
  </div>
</body>
</html>
`;

// Native WebView Source Object (Memoized outside)
const CHART_SOURCE = { html: tradingViewHTML };

// -----------------------------------------------------------------------------
// WEB IMPLEMENTATION (Fixes "Stays on all tabs")
// -----------------------------------------------------------------------------
let globalIframeElement: HTMLIFrameElement | null = null;

const WebChart = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // If we haven't created the global iframe yet, create it now.
    if (!globalIframeElement) {
      const iframe = document.createElement('iframe');
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = 'none';
      // We use a Blob to load the HTML content on web without cross-origin issues
      const blob = new Blob([tradingViewHTML], { type: 'text/html' });
      iframe.src = URL.createObjectURL(blob);
      globalIframeElement = iframe;
    }

    // APPEND TO THE CURRENT CONTAINER ONLY
    // This ensures it only lives inside this specific component's Div.
    // When you switch tabs, this Div unmounts, taking the chart with it.
    if (containerRef.current && globalIframeElement) {
      containerRef.current.appendChild(globalIframeElement);
    }

    // Cleanup: When leaving the tab, we DON'T destroy the iframe (to keep state),
    // but React will remove the container div from the DOM, naturally hiding the chart.
  }, []);

  return (
    <div 
      ref={containerRef} 
      style={{ width: '100%', height: '100%', overflow: 'hidden' }} 
    />
  );
};

// -----------------------------------------------------------------------------
// NATIVE IMPLEMENTATION
// -----------------------------------------------------------------------------
const NativeChart = React.memo(() => {
  return (
    <WebView
      originWhitelist={['*']}
      source={CHART_SOURCE} // Using the stable constant
      style={styles.webview}
      containerStyle={styles.webviewContainer}
      scrollEnabled={false}
      bounces={false}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      androidLayerType="hardware"
    />
  );
});

NativeChart.displayName = 'NativeChart';

// -----------------------------------------------------------------------------
// MAIN EXPORT
// -----------------------------------------------------------------------------
export default function PriceChart() {
  const { width } = useWindowDimensions();
  
  // Responsive height based on screen width (roughly 16:9 aspect ratio or similar)
  const chartHeight = width * 0.8; 

  return (
    <View style={[styles.container, { height: chartHeight }]}>
      {Platform.OS === 'web' ? <WebChart /> : <NativeChart />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#131722', // Matches TradingView dark theme background
    borderRadius: 12,
    overflow: 'hidden',
    marginVertical: 10,
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  webviewContainer: {
    flex: 1, 
    borderRadius: 12,
    overflow: 'hidden',
  },
});
