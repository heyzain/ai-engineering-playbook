import path from "node:path";
import { inspectRawProject } from "../core/diagnostics/inspector.js";
import { DiagnosticsEngine } from "../core/diagnostics/engine.js";
import { formatTerminalReport } from "../formatters/terminal.js";
import { formatJsonReport } from "../formatters/json.js";
import type { InspectionReport } from "../core/diagnostics/types.js";

export interface InspectCommandOptions {
  cwd?: string;
  json?: boolean;
  now?: Date;
  silent?: boolean;
}

export interface InspectCommandResult {
  success: boolean;
  exitCode: number;
  report: InspectionReport;
  output: string;
}

export function runInspect(options: InspectCommandOptions = {}): InspectCommandResult {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const raw = inspectRawProject(targetDir);

  const engine = new DiagnosticsEngine();
  const report = engine.evaluate(raw, options.now);

  const output = options.json ? formatJsonReport(report) : formatTerminalReport(report);
  if (!options.silent) {
    console.log(output);
  }

  // Blocked status (critical errors, missing setup, schema violations, blocking RFCs) yields exit code 1
  const isBlocked = report.readiness.status === "blocked";

  return {
    success: !isBlocked,
    exitCode: isBlocked ? 1 : 0,
    report,
    output,
  };
}
