import React, { Component, useRef } from 'react';
import { View, Platform, StyleSheet, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';

// 1. Configuration
const CHART_CONFIG = {
  symbol: "OANDA:XAUUSD",
  interval: "5",
  theme: "dark",
  backgroundColor: "#0F0F0F",
  gridColor: "rgba(242, 242, 242, 0.06)"
};

// 2. STABLE URL
// Defined OUTSIDE the component to ensure referential equality.
const WEB_CHART_URL = `https://s.tradingview.com/widgetembed/?frameElementId=tradingview_widget&symbol=${encodeURIComponent(CHART_CONFIG.symbol)}&interval=${CHART_CONFIG.interval}&theme=${CHART_CONFIG.theme}&style=1&timezone=Etc%2FUTC&hide_side_toolbar=1&hide_top_toolbar=1&save_image=0&backgroundColor=${encodeURIComponent(CHART_CONFIG.backgroundColor)}&gridColor=${encodeURIComponent(CHART_CONFIG.gridColor)}`;

const NATIVE_SOURCE = { uri: WEB_CHART_URL };

// 3. WEB COMPONENT (Class Component for STRICT stability)
// using a Class Component allows us to use shouldComponentUpdate() returning false
// to strictly guarantee the component never re-renders, preventing iframe reloads.
class WebChart extends Component {
  shouldComponentUpdate() {
    return false; // NEVER re-render on Web
  }

  render() {
    return (
      <View style={styles.webContainer}>
        <iframe
          src={WEB_CHART_URL}
          style={{ width: '100%', height: '100%', border: 'none' }}
          title="TradingView Chart"
          allow="fullscreen"
          key="tradingview-iframe"
        />
      </View>
    );
  }
}

// 4. NATIVE COMPONENT
const NativeChart = React.memo(() => {
  const webViewRef = useRef<WebView>(null);
  
  const onShouldStartLoadWithRequest = (request: any) => {
    // Only allow the chart URL or about:blank
    const isAllowed = request.url.includes('tradingview.com') || request.url === 'about:blank';
    return isAllowed;
  };

  return (
    <View style={styles.nativeContainer}>
      <WebView
        ref={webViewRef}
        key="chart-webview"
        originWhitelist={['*']}
        source={NATIVE_SOURCE}
        style={styles.webview}
        containerStyle={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        scalesPageToFit={false}
        scrollEnabled={false}
        bounces={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        androidLayerType="hardware"
        renderLoading={() => <View style={{flex: 1, backgroundColor: CHART_CONFIG.backgroundColor}} />}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        setSupportMultipleWindows={false}
      />
    </View>
  );
});
NativeChart.displayName = 'NativeChart';

// 5. MAIN EXPORT
export default function PriceChart() {
  const { width } = useWindowDimensions();
  
  // Responsive height calculation
  // On web, fixed height prevents layout shifts and infinite grow issues.
  // On mobile, proportional height works best.
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
    overflow: 'hidden',
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
    opacity: 0.99,
  }
});
