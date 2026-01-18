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
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: #0F0F0F;
    }
    .tradingview-widget-container {
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
// WEB IMPLEMENTATION
// -----------------------------------------------------------------------------
const WebChart = React.memo(() => {
  // 1. Create the Blob URL ONLY ONCE per component instance.
  //    This ensures the iframe 'src' never changes, preventing reloads.
  const iframeSrc = useMemo(() => {
    if (typeof window !== 'undefined' && window.Blob && window.URL) {
      const blob = new Blob([HTML_CONTENT], { type: 'text/html' });
      return URL.createObjectURL(blob);
    }
    return '';
  }, []);

  return (
    <View style={styles.webContainer}>
      {/* 
        Using a standard HTML iframe directly.
        This provides complete isolation for the TradingView script.
        The script runs inside the iframe's window, not the main app window.
      */}
      {React.createElement('iframe', {
        src: iframeSrc,
        style: {
          width: '100%',
          height: '100%',
          border: 'none',
          backgroundColor: '#0F0F0F',
        },
        title: "TradingView Chart"
      })}
    </View>
  );
}, () => true); // Strict memoization: Never re-render

WebChart.displayName = 'WebChart';

// -----------------------------------------------------------------------------
// NATIVE IMPLEMENTATION
// -----------------------------------------------------------------------------
const NativeChart = React.memo(() => {
  const source = useMemo(() => ({ html: HTML_CONTENT }), []);

  return (
    <WebView
      originWhitelist={['*']}
      source={source}
      style={styles.webview}
      containerStyle={styles.webviewContainer}
      scrollEnabled={false}
      bounces={false}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      androidLayerType="hardware"
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
    />
  );
}, () => true);

NativeChart.displayName = 'NativeChart';

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------
export default function PriceChart() {
  const { width } = useWindowDimensions();
  
  // FIX: Fixed height for Web to prevent "massive" chart.
  // On mobile (native), we can be a bit more flexible with aspect ratio.
  const chartHeight = Platform.OS === 'web' 
    ? 450 // Fixed 450px height on Web - proven stable size
    : Math.min(width * 1.1, 450); // Mobile: proportional but capped

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
    alignSelf: 'center',
    // Platform specific shadows
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
      web: {
        boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.3)',
      },
    }),
  },
  // Web specific container style to ensure iframe fills it
  webContainer: {
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: '#0F0F0F',
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
