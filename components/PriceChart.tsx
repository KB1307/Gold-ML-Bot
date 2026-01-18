import React, { useRef } from 'react';
import { View, Platform, StyleSheet, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';

// 1. Configuration for the chart
const CHART_CONFIG = {
  symbol: "OANDA:XAUUSD",
  interval: "5",
  theme: "dark",
  backgroundColor: "#0F0F0F",
  gridColor: "rgba(242, 242, 242, 0.06)"
};

// -----------------------------------------------------------------------------
// NATIVE IMPLEMENTATION
// -----------------------------------------------------------------------------
const NativeChart = React.memo(() => {
  const webViewRef = useRef<WebView>(null);

  // 2. Native Implementation: HTML String with Widget
  // Uses tv.js which handles the iframe creation inside the WebView cleanly
  const tradingViewHTML = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <style>
          body { margin: 0; padding: 0; overflow: hidden; background: ${CHART_CONFIG.backgroundColor}; }
          .tradingview-widget-container { height: 100vh; width: 100vw; }
          .tradingview-widget-container__widget { height: 100%; width: 100%; }
        </style>
      </head>
      <body>
        <div class="tradingview-widget-container">
          <div id="tradingview_chart" class="tradingview-widget-container__widget"></div>
          <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
          <script type="text/javascript">
            new TradingView.widget({
              "autosize": true,
              "symbol": "${CHART_CONFIG.symbol}",
              "interval": "${CHART_CONFIG.interval}",
              "timezone": "Etc/UTC",
              "theme": "${CHART_CONFIG.theme}",
              "style": "1",
              "locale": "en",
              "toolbar_bg": "${CHART_CONFIG.backgroundColor}",
              "enable_publishing": false,
              "allow_symbol_change": true,
              "container_id": "tradingview_chart",
              "hide_side_toolbar": true,
              "studies": [],
              "show_popup_button": false,
              "hide_volume": false
            });
          </script>
        </div>
      </body>
    </html>
  `;

  return (
    <View style={styles.nativeContainer}>
      <WebView
        ref={webViewRef}
        source={{ html: tradingViewHTML }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        scalesPageToFit={true}
        scrollEnabled={false}
        bounces={false}
        androidLayerType="hardware"
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
      />
    </View>
  );
});
NativeChart.displayName = 'NativeChart';

// -----------------------------------------------------------------------------
// WEB IMPLEMENTATION
// -----------------------------------------------------------------------------
const WebChart = React.memo(() => {
  // 3. Web Implementation: Direct iframe to widgetembed
  // This avoids Blob/Script injection issues that cause loops on Web
  const chartUrl = `https://s.tradingview.com/widgetembed/?frameElementId=tradingview_chart&symbol=${encodeURIComponent(CHART_CONFIG.symbol)}&interval=${CHART_CONFIG.interval}&theme=${CHART_CONFIG.theme}&style=1&timezone=Etc%2FUTC&hide_side_toolbar=1&hide_top_toolbar=0&save_image=0&backgroundColor=${encodeURIComponent(CHART_CONFIG.backgroundColor)}`;

  return (
    <View style={styles.webContainer}>
      <iframe
        src={chartUrl}
        style={{ width: "100%", height: "100%", border: "none", overflow: "hidden" }}
        title="TradingView Chart"
        scrolling="no"
      />
    </View>
  );
});
WebChart.displayName = 'WebChart';

// -----------------------------------------------------------------------------
// MAIN EXPORT
// -----------------------------------------------------------------------------
export default function PriceChart() {
  const { width } = useWindowDimensions();
  
  // Calculate height to be responsive but not massive
  const chartHeight = Platform.OS === 'web' ? 450 : Math.min(width * 1.1, 450);

  return (
    <View style={[styles.container, { height: chartHeight }]}>
      {Platform.OS === 'web' ? <WebChart /> : <NativeChart />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: CHART_CONFIG.backgroundColor,
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
  nativeContainer: {
    flex: 1,
    backgroundColor: CHART_CONFIG.backgroundColor,
  },
  webContainer: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: CHART_CONFIG.backgroundColor,
    overflow: 'hidden',
  },
  webview: {
    flex: 1,
    backgroundColor: CHART_CONFIG.backgroundColor,
  }
});
