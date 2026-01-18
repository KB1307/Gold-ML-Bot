import React, { useMemo } from 'react';
import { StyleSheet, View, Platform, useWindowDimensions } from 'react-native';
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
      width: 100vw;
      height: 100vh;
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
      border: none;
    }
    /* Hide copyright on small screens */
    .tradingview-widget-copyright {
      display: none !important;
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
// WEB IMPLEMENTATION
// -----------------------------------------------------------------------------
const WebChart = React.memo(() => {
  // Use data URI for Web to prevent blob URL issues and ensure stability
  const src = `data:text/html;charset=utf-8,${encodeURIComponent(HTML_CONTENT)}`;

  return (
    <iframe
      src={src}
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        overflow: 'hidden',
        backgroundColor: '#0F0F0F',
      }}
      title="TradingView Chart"
      scrolling="no"
    />
  );
});
WebChart.displayName = 'WebChart';

// -----------------------------------------------------------------------------
// NATIVE IMPLEMENTATION
// -----------------------------------------------------------------------------
const NativeChart = React.memo(() => {
  return (
    <WebView
      originWhitelist={['*']}
      source={{ html: HTML_CONTENT }}
      style={styles.webview}
      containerStyle={styles.webviewContainer}
      scrollEnabled={false}
      bounces={false}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      androidLayerType="hardware"
      renderToHardwareTextureAndroid={true}
      scalesPageToFit={true}
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      onError={(syntheticEvent) => {
        const { nativeEvent } = syntheticEvent;
        console.warn('WebView error: ', nativeEvent);
      }}
    />
  );
});
NativeChart.displayName = 'NativeChart';

// -----------------------------------------------------------------------------
// MAIN EXPORT
// -----------------------------------------------------------------------------
export default function PriceChart() {
  const { width } = useWindowDimensions();
  
  // Calculate height once based on width, clamp to reasonable limits
  // This ensures the chart is large enough but not "massive"
  const chartHeight = useMemo(() => {
    // 16:9 Aspect Ratio roughly, but capped
    const height = width * 0.85; 
    return Math.min(Math.max(height, 300), 450);
  }, [width]);

  return (
    <View style={[styles.container, { height: chartHeight }]}>
      {Platform.OS === 'web' ? <WebChart /> : <NativeChart />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
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
