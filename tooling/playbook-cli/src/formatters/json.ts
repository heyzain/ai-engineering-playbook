import type { InspectionReport } from "../core/diagnostics/types.js";

/**
 * Serializes an InspectionReport into standardized, machine-readable JSON.
 */
export function formatJsonReport(report: InspectionReport): string {
  return JSON.stringify(report, null, 2);
}
