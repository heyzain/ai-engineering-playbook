"use client";

import { useState } from "react";

export interface CounterProps {
  initialCount?: number;
}

/**
 * Example of a "Leaves-Only" Client Component.
 * Interactivity and local React hooks are isolated to this leaf node,
 * while ancestor layouts and pages remain pure Server Components.
 */
export function Counter({ initialCount = 0 }: CounterProps) {
  const [count, setCount] = useState<number>(initialCount);

  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: "1rem" }}>
      <button
        type="button"
        onClick={() => setCount((c) => c - 1)}
        style={{ padding: "0.25rem 0.75rem", fontSize: "1.2rem", cursor: "pointer" }}
        aria-label="Decrement count"
      >
        -
      </button>
      <span style={{ minWidth: "2rem", textAlign: "center", fontWeight: "bold" }}>
        {count}
      </span>
      <button
        type="button"
        onClick={() => setCount((c) => c + 1)}
        style={{ padding: "0.25rem 0.75rem", fontSize: "1.2rem", cursor: "pointer" }}
        aria-label="Increment count"
      >
        +
      </button>
    </div>
  );
}
