import React, { useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import PriceChart from '@/components/PriceChart';

// Create stable chart instance outside component to prevent recreation
const StablePriceChart = React.memo(() => <PriceChart />, () => true);
StablePriceChart.displayName = 'StablePriceChart';

const DashboardChart = React.memo(() => {
  // Use ref to track mount count for debugging
  const mountCountRef = useRef(0);
  mountCountRef.current++;
  
  // Only log on actual remount, not re-render
  if (mountCountRef.current === 1) {
    console.log('[DashboardChart] Initial mount');
  }
  
  return (
    <View style={styles.chartCard}>
      <View style={styles.chartContainer}>
        <StablePriceChart />
      </View>
    </View>
  );
}, () => true); // strict memoization: never re-render

DashboardChart.displayName = 'DashboardChart';

const styles = StyleSheet.create({
  chartCard: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.05)",
  },
  chartContainer: {
    width: "100%",
    height: 350,
    borderRadius: 8,
    overflow: "hidden",
  },
});

export default DashboardChart;
