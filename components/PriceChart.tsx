import React, { useMemo } from "react";
import { View, StyleSheet, Platform } from "react-native";
import { WebView } from "react-native-webview";

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
}

const PriceChart = React.memo(({ data, currentPrice }: PriceChartProps) => {
  const chartUrl = useMemo(() => {
    const params = {
      symbol: "OANDA:XAUUSD",
      interval: "1",
      theme: "dark",
      style: "1",
      timezone: "Etc/UTC",
      studies: "[]",
      backgroundColor: "#0F0F0F",
      gridColor: "rgba(242, 242, 242, 0.06)",
      hide_side_toolbar: "0",
      allow_symbol_change: "1",
      save_image: "0",
      locale: "en",
      toolbar_bg: "#0F0F0F",
      hide_top_toolbar: "0",
      hide_legend: "0",
      hide_volume: "0"
    };
    
    const queryString = Object.entries(params)
      .map(([key, val]) => `${key}=${encodeURIComponent(val)}`)
      .join('&');
      
    return `https://s.tradingview.com/widgetembed/?${queryString}`;
  }, []);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        <iframe
          src={chartUrl}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            borderRadius: 12,
          } as any}
          title="Gold Price Chart"
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        originWhitelist={['*']}
        source={{ uri: chartUrl }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        scrollEnabled={false}
        incognito={true}
        startInLoadingState={true}
        scalesPageToFit={true}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="always"
        thirdPartyCookiesEnabled={true}
      />
    </View>
  );
});

PriceChart.displayName = 'PriceChart';

export default PriceChart;

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: 400,
  },
  webview: {
    flex: 1,
    backgroundColor: '#0F0F0F',
    borderRadius: 12,
    overflow: 'hidden',
  },
});
