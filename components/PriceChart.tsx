import { View, StyleSheet, Platform } from "react-native";
import { useState } from "react";
import { WebView } from "react-native-webview";

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
}

export default function PriceChart({ data, currentPrice }: PriceChartProps) {
  const [chartKey] = useState<number>(Date.now());

  const widgetUrl = `https://s.tradingview.com/widgetembed/?frameElementId=tradingview_${chartKey}&symbol=OANDA%3AXAUUSD&interval=1&hidesidetoolbar=0&symboledit=1&saveimage=0&toolbarbg=f1f3f6&studies=%5B%5D&theme=dark&style=1&timezone=Etc%2FUTC&withdateranges=1&studies_overrides=%7B%7D&overrides=%7B%7D&enabled_features=%5B%5D&disabled_features=%5B%5D&locale=en&utm_source=&utm_medium=widget&utm_campaign=chart&utm_term=OANDA%3AXAUUSD`;

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        <iframe
          key={chartKey}
          src={widgetUrl}
          style={{
            width: '100%',
            height: 400,
            border: 'none',
            borderRadius: 12,
            overflow: 'hidden',
          }}
          title="TradingView Chart"
          allow="clipboard-write"
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <WebView
        key={chartKey}
        source={{ uri: widgetUrl }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        scalesPageToFit={true}
        scrollEnabled={false}
        thirdPartyCookiesEnabled={true}
        sharedCookiesEnabled={true}
        originWhitelist={['*']}
      />
    </View>
  );
}

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
