import { View, StyleSheet, Text, Dimensions } from "react-native";
import { useMemo } from "react";
import Svg, { Polyline, Line, Text as SvgText, Rect } from "react-native-svg";

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
}

export default function PriceChart({ data, currentPrice }: PriceChartProps) {
  const { width } = Dimensions.get('window');
  const chartWidth = width - 80;
  const chartHeight = 300;
  const padding = 40;
  const availableWidth = chartWidth - padding * 2;
  const availableHeight = chartHeight - padding * 2;

  const { points, minPrice, maxPrice, priceRange } = useMemo(() => {
    if (!data || data.length === 0) {
      return { points: '', minPrice: currentPrice - 50, maxPrice: currentPrice + 50, priceRange: 100 };
    }

    const prices = data.map(d => d.price);
    const min = Math.min(...prices, currentPrice);
    const max = Math.max(...prices, currentPrice);
    const range = max - min || 100;

    const pointsStr = data
      .map((point, i) => {
        const x = padding + (i / (data.length - 1 || 1)) * availableWidth;
        const y = padding + availableHeight - ((point.price - min) / range) * availableHeight;
        return `${x},${y}`;
      })
      .join(' ');

    return { points: pointsStr, minPrice: min, maxPrice: max, priceRange: range };
  }, [data, currentPrice, availableWidth, availableHeight, padding]);

  const currentPriceY = padding + availableHeight - ((currentPrice - minPrice) / priceRange) * availableHeight;

  const gridLines = 5;
  const priceStep = priceRange / gridLines;

  if (!data || data.length === 0) {
    return (
      <View style={styles.container}>
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>Loading price data...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.chartWrapper}>
        <Svg width={chartWidth} height={chartHeight}>
          <Rect x={0} y={0} width={chartWidth} height={chartHeight} fill="#0F0F0F" />
          
          {Array.from({ length: gridLines + 1 }).map((_, i) => {
            const y = padding + (i * availableHeight) / gridLines;
            return (
              <Line
                key={`grid-${i}`}
                x1={padding}
                y1={y}
                x2={chartWidth - padding}
                y2={y}
                stroke="rgba(255, 255, 255, 0.05)"
                strokeWidth="1"
              />
            );
          })}

          {Array.from({ length: gridLines + 1 }).map((_, i) => {
            const y = padding + (i * availableHeight) / gridLines;
            const price = maxPrice - (i * priceStep);
            return (
              <SvgText
                key={`label-${i}`}
                x={padding - 10}
                y={y + 5}
                fill="#999"
                fontSize="10"
                textAnchor="end"
              >
                {price.toFixed(0)}
              </SvgText>
            );
          })}

          <Polyline
            points={points}
            fill="none"
            stroke="#FFD700"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          <Line
            x1={padding}
            y1={currentPriceY}
            x2={chartWidth - padding}
            y2={currentPriceY}
            stroke="#22c55e"
            strokeWidth="1.5"
            strokeDasharray="4,4"
          />

          <Rect
            x={chartWidth - padding - 50}
            y={currentPriceY - 12}
            width="45"
            height="20"
            fill="#22c55e"
            rx="4"
          />
          <SvgText
            x={chartWidth - padding - 27.5}
            y={currentPriceY + 3}
            fill="#000"
            fontSize="10"
            fontWeight="bold"
            textAnchor="middle"
          >
            {currentPrice.toFixed(1)}
          </SvgText>
        </Svg>
        
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#FFD700' }]} />
            <Text style={styles.legendText}>Price History (Last Hour)</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#22c55e' }]} />
            <Text style={styles.legendText}>Current Price: ${currentPrice.toFixed(2)}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    alignItems: 'center',
  },
  chartWrapper: {
    width: '100%',
    alignItems: 'center',
  },
  loadingContainer: {
    height: 300,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0F0F0F',
    borderRadius: 12,
    width: '100%',
  },
  loadingText: {
    color: '#999',
    fontSize: 14,
  },
  legend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    marginTop: 16,
    flexWrap: 'wrap',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendText: {
    color: '#999',
    fontSize: 11,
  },
});
