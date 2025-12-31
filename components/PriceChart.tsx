import { View, StyleSheet, Platform } from "react-native";
import { useEffect, useRef, useState } from "react";
import { WebView } from "react-native-webview";

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
}

declare global {
  interface Window {
    TradingView?: any;
  }
}

let widgetInstance: any = null;
const containerId = `tv_chart_container_${Date.now()}`;

export default function PriceChart({ data, currentPrice }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isScriptLoaded, setIsScriptLoaded] = useState(false);
  const initTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web') {
      const script = document.createElement('script');
      script.src = 'https://s3.tradingview.com/tv.js';
      script.async = true;
      script.onload = () => {
        setIsScriptLoaded(true);
      };
      document.head.appendChild(script);

      return () => {
        if (script.parentNode) {
          script.parentNode.removeChild(script);
        }
      };
    }
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web' && isScriptLoaded && containerRef.current) {
      const initWidget = () => {
        if (!window.TradingView || !document.getElementById(containerId)) {
          initTimeoutRef.current = setTimeout(initWidget, 100);
          return;
        }

        try {
          if (widgetInstance) {
            widgetInstance.remove();
            widgetInstance = null;
          }

          widgetInstance = new window.TradingView.widget({
            container_id: containerId,
            autosize: true,
            symbol: "OANDA:XAUUSD",
            interval: "1",
            timezone: "Etc/UTC",
            theme: "dark",
            style: "1",
            locale: "en",
            toolbar_bg: "#0F0F0F",
            enable_publishing: false,
            hide_side_toolbar: false,
            allow_symbol_change: true,
            save_image: false,
            hide_top_toolbar: false,
            hide_legend: false,
            hide_volume: false,
            backgroundColor: "#0F0F0F",
            gridColor: "rgba(242, 242, 242, 0.06)",
            studies: [],
            disabled_features: [],
            enabled_features: []
          });
        } catch {
          console.log('TradingView widget initialization deferred');
        }
      };

      initTimeoutRef.current = setTimeout(initWidget, 300);

      return () => {
        if (initTimeoutRef.current) {
          clearTimeout(initTimeoutRef.current);
        }
        if (widgetInstance) {
          try {
            widgetInstance.remove();
          } catch {
            console.log('Widget cleanup completed');
          }
          widgetInstance = null;
        }
      };
    }
  }, [isScriptLoaded]);

  if (Platform.OS === 'web') {
    return (
      <View style={styles.container}>
        <div 
          ref={containerRef as any}
          id={containerId}
          style={{ height: '100%', width: '100%' }}
        />
      </View>
    );
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
        <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob: 'sha256-OnIRlyPDoHGNireBiH3l4iJuU6eW7LFwBvVSh6rAIZw='; connect-src * 'unsafe-inline'; img-src * data: blob:; style-src * 'unsafe-inline';">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body { height: 100%; width: 100%; overflow: hidden; background-color: #0F0F0F; }
          #tv_chart_container { height: 100%; width: 100%; }
        </style>
      </head>
      <body>
        <div id="tv_chart_container"></div>
        <script type="text/javascript" src="https://s3.tradingview.com/tv.js"></script>
        <script type="text/javascript">
          (function() {
            const originalError = console.error;
            console.error = function() {
              const args = Array.from(arguments);
              const errorStr = args.join(' ');
              if (errorStr.includes('contentWindow') || 
                  errorStr.includes('iframe') || 
                  errorStr.includes('tolt.js') || 
                  errorStr.includes('fbevents.js') ||
                  errorStr.includes('CORS')) {
                return;
              }
              originalError.apply(console, args);
            };

            window.addEventListener('error', function(e) {
              if (e.message && (e.message.includes('contentWindow') || 
                                e.message.includes('iframe') ||
                                e.message.includes('tolt.js') ||
                                e.message.includes('fbevents.js'))) {
                e.preventDefault();
                return false;
              }
            }, true);

            function initWidget() {
              if (window.TradingView && document.getElementById('tv_chart_container')) {
                try {
                  new window.TradingView.widget({
                    container_id: 'tv_chart_container',
                    autosize: true,
                    symbol: 'OANDA:XAUUSD',
                    interval: '1',
                    timezone: 'Etc/UTC',
                    theme: 'dark',
                    style: '1',
                    locale: 'en',
                    toolbar_bg: '#0F0F0F',
                    enable_publishing: false,
                    hide_side_toolbar: true,
                    allow_symbol_change: true,
                    save_image: true,
                    hide_top_toolbar: false,
                    hide_legend: false,
                    hide_volume: false,
                    backgroundColor: '#0F0F0F',
                    gridColor: 'rgba(242, 242, 242, 0.06)',
                    studies: [],
                    disabled_features: ['use_localstorage_for_settings'],
                    enabled_features: ['study_templates']
                  });
                } catch(error) {
                  console.log('TradingView widget initialization deferred');
                  setTimeout(initWidget, 500);
                }
              } else {
                setTimeout(initWidget, 100);
              }
            }

            if (document.readyState === 'complete') {
              initWidget();
            } else {
              window.addEventListener('load', initWidget);
            }
          })();
        </script>
      </body>
    </html>
  `;

  return (
    <View style={styles.container}>
      <WebView
        source={{ html: htmlContent }}
        style={styles.webview}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        startInLoadingState={true}
        scalesPageToFit={true}
        scrollEnabled={false}
        originWhitelist={['*']}
        allowsInlineMediaPlayback={true}
        mediaPlaybackRequiresUserAction={false}
        onError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          if (!nativeEvent.description?.includes('contentWindow') && !nativeEvent.description?.includes('iframe')) {
            console.warn('WebView error:', nativeEvent);
          }
        }}
        onHttpError={(syntheticEvent) => {
          const { nativeEvent } = syntheticEvent;
          console.warn('WebView HTTP error:', nativeEvent);
        }}
        onMessage={(event) => {
          const message = event.nativeEvent.data;
          if (!message.includes('contentWindow') && !message.includes('iframe')) {
            console.log('WebView message:', message);
          }
        }}
        injectedJavaScript={`
          (function() {
            const originalError = console.error;
            console.error = function() {
              const args = Array.from(arguments);
              const errorStr = args.join(' ');
              if (errorStr.includes('contentWindow') || errorStr.includes('iframe')) {
                return;
              }
              originalError.apply(console, args);
            };
          })();
          true;
        `}
        mixedContentMode="always"
        thirdPartyCookiesEnabled={true}
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
