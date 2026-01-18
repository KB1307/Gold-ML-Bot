import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Platform, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';

// -----------------------------------------------------------------------------
// HTML CONTENT
// -----------------------------------------------------------------------------
// Using the exact snippet structure provided to ensure correct layout.
// logic: height: calc(100% - 32px) leaves space for the copyright footer.
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
      background-color: #0F0F0F;
    }
    .tradingview-widget-container {
      width: 100% !important;
      height: 100% !important;
    }
    iframe {
      border: none;
    }
    /* Hide the copyright text if desired, or style it to match */
    .tradingview-widget-copyright {
      font-size: 13px !important;
      line-height: 32px !important;
      text-align: center !important;
      vertical-align: middle !important;
      font-family: -apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif !important;
      color: #9db2bd !important;
    }
    .tradingview-widget-copyright .blue-text {
      color: #2962FF !important;
    }
    .tradingview-widget-copyright a {
      text-decoration: none !important;
      color: #9db2bd !important;
    }
    .tradingview-widget-copyright a:visited {
      color: #9db2bd !important;
    }
    .tradingview-widget-copyright a:hover .blue-text {
      color: #1E53E5 !important;
    }
    .tradingview-widget-copyright a:hover {
      color: #1E53E5 !important;
    }
  </style>
</head>
<body>
  <div class="tradingview-widget-container" style="height:100%;width:100%">
    <div class="tradingview-widget-container__widget" style="height:calc(100% - 32px);width:100%"></div>
    <div class="tradingview-widget-copyright">
      <a href="https://www.tradingview.com/symbols/CAPITALCOM-GOLD/" rel="noopener nofollow" target="_blank">
        <span class="blue-text">GOLD chart</span>
      </a>
      <span class="trademark"> by TradingView</span>
    </div>
    <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>
    {
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
    }
    </script>
  </div>
</body>
</html>
`;

// Native WebView Source Object (Memoized outside to prevent reload on re-render)
const CHART_SOURCE = { html: tradingViewHTML };

// -----------------------------------------------------------------------------
// WEB IMPLEMENTATION
// -----------------------------------------------------------------------------
// Using a stable Blob URL pattern. This is more robust than moving iframes.
// We generate the URL once and reuse it.
let cachedBlobUrl: string | null = null;

const WebChart = () => {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!cachedBlobUrl) {
      const blob = new Blob([tradingViewHTML], { type: 'text/html' });
      cachedBlobUrl = URL.createObjectURL(blob);
    }
    setSrc(cachedBlobUrl);
  }, []);

  if (!src) return <View style={styles.container} />;

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
// NATIVE IMPLEMENTATION
// -----------------------------------------------------------------------------
const NativeChart = React.memo(() => {
  return (
    <WebView
      originWhitelist={['*']}
      source={CHART_SOURCE}
      style={styles.webview}
      containerStyle={styles.webviewContainer}
      scrollEnabled={false}
      bounces={false}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      androidLayerType="hardware"
      opacity={0.99} // Prevents white flash
      scalesPageToFit={true} // Ensures viewport meta tag is respected
    />
  );
});

NativeChart.displayName = 'NativeChart';

// -----------------------------------------------------------------------------
// MAIN EXPORT
// -----------------------------------------------------------------------------
export default function PriceChart() {
  const { width } = useWindowDimensions();
  
  // Dynamic height calculation
  // 1.2 aspect ratio gives a good height for the chart on mobile
  const chartHeight = width * 1.2; 

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
    // Removed margin to let parent handle spacing if needed, 
    // but kept rounded corners for design
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
});
