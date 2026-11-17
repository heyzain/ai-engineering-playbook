"use client";

import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Report error to telemetry service if configured
    console.error("Next.js Route Error caught by boundary:", error);
  }, [error]);

  return (
    <div style={{ padding: "2rem", border: "1px solid #e11d48", borderRadius: "8px", margin: "1rem" }}>
      <h2 style={{ color: "#e11d48" }}>Something went wrong!</h2>
      <p>{error.message || "An unexpected error occurred."}</p>
      {error.digest && <p><small>Error Digest: {error.digest}</small></p>}
      <button
        type="button"
        onClick={() => reset()}
        style={{
          padding: "0.5rem 1rem",
          backgroundColor: "#e11d48",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer",
        }}
      >
        Try Again
      </button>
    </div>
  );
}
