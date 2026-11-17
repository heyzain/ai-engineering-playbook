import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";

export default function ExploreScreen() {
  const router = useRouter();
  const [counter, setCounter] = useState(0);

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Explore Modular Architecture</Text>
      <Text style={styles.description}>
        This screen demonstrates Expo Router with React Native foundation primitives.
      </Text>

      <Text style={styles.counterValue}>Counter: {counter}</Text>

      <Pressable
        style={styles.actionButton}
        accessibilityRole="button"
        accessibilityLabel="Increment active feature counter"
        onPress={() => setCounter((c) => c + 1)}
      >
        <Text style={styles.actionText}>Increment Counter</Text>
      </Pressable>

      <Pressable
        style={[styles.actionButton, styles.returnButton]}
        accessibilityRole="button"
        accessibilityLabel="Return to home welcome screen"
        onPress={() => router.back()}
      >
        <Text style={styles.actionText}>Back to Welcome</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#ffffff",
  },
  heading: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#0f172a",
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: "#64748b",
    textAlign: "center",
    marginBottom: 20,
  },
  counterValue: {
    fontSize: 18,
    fontWeight: "600",
    color: "#0284c7",
    marginBottom: 16,
  },
  actionButton: {
    backgroundColor: "#0284c7",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    minHeight: 48,
    minWidth: 160,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 6,
  },
  returnButton: {
    backgroundColor: "#475569",
  },
  actionText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "600",
  },
});
