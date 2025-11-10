import { View, StyleSheet } from "react-native";
import Svg, { Path, Line, Text as SvgText, Circle } from "react-native-svg";

interface PriceDataPoint {
  timestamp: number;
  price: number;
}

interface PriceChartProps {
  data: PriceDataPoint[];
  currentPrice: number;
}

export default function PriceChart({ data, currentPrice }: PriceChartProps) {
  if (!data || data.length < 2) return null;

  const width = 350;
  const height = 200;
  const padding = { top: 20, right: 10, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const prices = data.map(d => d.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice || 1;

  const xScale = (index: number) => padding.left + (index / (data.length - 1)) * chartWidth;
  const yScale = (price: number) => padding.top + chartHeight - ((price - minPrice) / priceRange) * chartHeight;

  const pathData = data.map((point, i) => {
    const x = xScale(i);
    const y = yScale(point.price);
    return i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`;
  }).join(' ');

  const currentY = yScale(currentPrice);

  const gridLines = 5;
  const gridPrices = Array.from({ length: gridLines }, (_, i) => {
    return minPrice + (priceRange / (gridLines - 1)) * i;
  });

  return (
    <View style={styles.container}>
      <Svg width={width} height={height}>
        {gridPrices.map((price, i) => {
          const y = yScale(price);
          return (
            <Line
              key={`grid-${i}`}
              x1={padding.left}
              y1={y}
              x2={width - padding.right}
              y2={y}
              stroke="rgba(255, 255, 255, 0.05)"
              strokeWidth="1"
            />
          );
        })}
        
        {gridPrices.map((price, i) => {
          const y = yScale(price);
          return (
            <SvgText
              key={`label-${i}`}
              x={padding.left - 10}
              y={y + 4}
              fontSize="10"
              fill="#666"
              textAnchor="end"
            >
              {price.toFixed(0)}
            </SvgText>
          );
        })}

        <Line
          x1={padding.left}
          y1={currentY}
          x2={width - padding.right}
          y2={currentY}
          stroke="#FFD700"
          strokeWidth="1"
          strokeDasharray="4,4"
        />

        <Path
          d={pathData}
          stroke="#22c55e"
          strokeWidth="2"
          fill="none"
        />

        {data.map((point, i) => {
          const x = xScale(i);
          const y = yScale(point.price);
          if (i === data.length - 1) {
            return (
              <Circle
                key={`point-${i}`}
                cx={x}
                cy={y}
                r="4"
                fill="#FFD700"
                stroke="#0a0a0a"
                strokeWidth="2"
              />
            );
          }
          return null;
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
