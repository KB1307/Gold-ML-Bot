import React from 'react';
import { View, StyleSheet } from 'react-native';
import PriceChart from '@/components/PriceChart';

const DashboardChart = React.memo(() => {
  return (
    <View style={styles.chartCard}>
      <View style={styles.chartContainer}>
        <PriceChart />
      </View>
    </View>
  );
}, () => true); // strict memoization: never re-render

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
