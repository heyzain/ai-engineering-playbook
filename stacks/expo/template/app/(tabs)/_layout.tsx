import React from "react";
import { Tabs } from "expo-router";

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: "#0284c7",
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name="explore"
        options={{
          title: "Explore",
          tabBarAccessibilityLabel: "Explore features navigation tab",
        }}
      />
    </Tabs>
  );
}
