import React from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";

export default function NotFoundScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Text style={styles.errorCode}>404</Text>
      <Text style={styles.message}>This route does not exist.</Text>

      <Pressable
        style={styles.homeLink}
        accessibilityRole="button"
        accessibilityLabel="Navigate to home welcome screen"
        onPress={() => router.replace("/")}
      >
        <Text style={styles.linkText}>Go to Home Screen</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#ffffff",
  },
  errorCode: {
    fontSize: 48,
    fontWeight: "bold",
    color: "#e11d48",
  },
  message: {
    fontSize: 16,
    color: "#64748b",
    marginTop: 8,
    marginBottom: 24,
  },
  homeLink: {
    backgroundColor: "#0284c7",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    minHeight: 48,
    minWidth: 160,
    justifyContent: "center",
    alignItems: "center",
  },
  linkText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
});
