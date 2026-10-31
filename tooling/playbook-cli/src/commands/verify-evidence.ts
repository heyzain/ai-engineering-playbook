import path from "node:path";
import { EvidenceVerifier } from "../core/evidence/verifier.js";
import { formatEvidenceTerminalReport } from "../formatters/evidence-terminal.js";
import type { EvidenceVerificationReport } from "../core/evidence/types.js";
import type { ProjectState } from "../types/state.js";

export interface VerifyEvidenceCommandOptions {
  cwd?: string;
  json?: boolean;
  silent?: boolean;
  state?: ProjectState;
}

export interface VerifyEvidenceCommandResult {
  success: boolean;
  exitCode: number;
  report: EvidenceVerificationReport;
  output: string;
}

export function runVerifyEvidence(options: VerifyEvidenceCommandOptions = {}): VerifyEvidenceCommandResult {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const verifier = new EvidenceVerifier();

  const report = verifier.verify(targetDir, options.state);
  const output = options.json
    ? JSON.stringify(report, null, 2)
    : formatEvidenceTerminalReport(report);

  if (!options.silent) {
    console.log(output);
  }

  return {
    success: report.all_passed,
    exitCode: report.all_passed ? 0 : 1,
    report,
    output,
  };
}
