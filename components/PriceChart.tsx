import React, { useEffect, useState } from 'react';
import { StyleSheet, View, Platform, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';

// -----------------------------------------------------------------------------
// WIDGET CONFIGURATION & HTML
// -----------------------------------------------------------------------------
const WIDGET_CONFIG = {
  "allow_symbol_change": true,
  "calendar": false,
  "details": false,
  "hide_side_toolbar": true,
  "hide_top_toolbar": false,
  "hide_legend": false,
  "hide_volume": false,
  "hotlist": false,
  "interval": "5",
  "locale": "en",
  "save_image": true,
  "style": "1",
  "symbol": "CAPITALCOM:GOLD",
  "theme": "dark",
  "timezone": "Etc/UTC",
  "backgroundColor": "#0F0F0F",
  "gridColor": "rgba(242, 242, 242, 0.06)",
  "watchlist": [],
  "withdateranges": false,
  "compareSymbols": [],
  "studies": [],
  "autosize": true
};

const CHART_HTML = `
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
      width: 100% !important;
      height: 100% !important;
    }
    iframe {
      border: none;
    }
    /* Hide copyright on small screens/widgets to save space */
    .tradingview-widget-copyright {
      display: none;
    }
  </style>
</head>
<body>
  <div class="tradingview-widget-container">
    <div class="tradingview-widget-container__widget"></div>
    <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>
    ${JSON.stringify(WIDGET_CONFIG)}
    </script>
  </div>
</body>
</html>
`;

// -----------------------------------------------------------------------------
// WEB IMPLEMENTATION (Stable Iframe)
// -----------------------------------------------------------------------------
// We create the Blob URL *once* outside the component.
// This ensures that even if the component re-renders, the src remains identical,
// preventing the iframe from reloading.
let globalChartUrl: string | null = null;

const getChartUrl = () => {
  if (Platform.OS === 'web' && !globalChartUrl) {
    const blob = new Blob([CHART_HTML], { type: 'text/html' });
    globalChartUrl = URL.createObjectURL(blob);
  }
  return globalChartUrl;
};

const WebChart = () => {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    // Initialize URL only on client-side mount
    setSrc(getChartUrl());
  }, []);

  if (!src) return <View style={styles.loadingPlaceholder} />;

  return (
    <iframe
      src={src}
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        backgroundColor: '#0F0F0F',
      }}
      title="TradingView Chart"
    />
  );
};

// -----------------------------------------------------------------------------
// NATIVE IMPLEMENTATION (WebView)
// -----------------------------------------------------------------------------
const NATIVE_SOURCE = { html: CHART_HTML };

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
      opacity={0.99}
      scalesPageToFit={true}
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
    />
  );
});
NativeChart.displayName = 'NativeChart';

// -----------------------------------------------------------------------------
// MAIN COMPONENT
// -----------------------------------------------------------------------------
export default function PriceChart() {
  const { width } = useWindowDimensions();
  
  // FIX: Fixed height of 350px (or slightly less on very small screens)
  // This solves the "MASSIVE" issue.
  const chartHeight = Math.min(width * 0.9, 350);

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
    // Shadow for depth
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
    backgroundColor: 'transparent',
  },
  webviewContainer: {
    flex: 1, 
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#0F0F0F',
  },
  loadingPlaceholder: {
    flex: 1,
    backgroundColor: '#0F0F0F',
  }
});
