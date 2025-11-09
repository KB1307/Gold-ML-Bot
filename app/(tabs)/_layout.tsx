import { Tabs } from "expo-router";
import { TrendingUp, Globe, History, Settings } from "lucide-react-native";
import React from "react";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#FFD700",
        tabBarInactiveTintColor: "#666",
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#0f0f0f",
          borderTopWidth: 1,
          borderTopColor: "rgba(255, 255, 255, 0.1)",
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
        },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color }) => <TrendingUp size={24} color={color} strokeWidth={2} />,
        }}
      />
      <Tabs.Screen
        name="outlook"
        options={{
          title: "Outlook",
          tabBarIcon: ({ color }) => <Globe size={24} color={color} strokeWidth={2} />,
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: "History",
          tabBarIcon: ({ color }) => <History size={24} color={color} strokeWidth={2} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color }) => <Settings size={24} color={color} strokeWidth={2} />,
        }}
      />
    </Tabs>
  );
}
