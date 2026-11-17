import YAML from "yaml";
import {
  type CiAdapter,
  type CiProviderType,
  type CiWorkflowOptions,
  type CiWorkflowValidationResult,
  CI_WORKFLOW_MARKERS,
  CI_REQUIRED_CHECK_NAME,
  DEFAULT_GITHUB_WORKFLOW_PATH,
} from "../types.js";
import { PLAYBOOK_VERSION } from "../../../constants.js";

const DEFAULT_CANONICAL_TIMESTAMP = "2026-11-03T16:00:00.000Z";

export const CANONICAL_GITHUB_WORKFLOW_BODY = `name: Playbook Quality Gates & Verification

on:
  pull_request:
    branches: [main, master, release/*]
    types: [opened, synchronize, reopened]
  push:
    branches: [main, master, release/*]
  workflow_dispatch:
    inputs:
      stage:
        description: "Target lifecycle stage to evaluate (leave empty for project state default)"
        required: false
        type: string

# Least-privilege permissions: Strictly read-only for repository contents.
# Zero write scopes. Step summaries write to runner environment without API tokens.
permissions:
  contents: read

# Concurrency policy: Cancel redundant in-flight runs on the same PR branch.
# Push events to main are never cancelled to guarantee complete audit trails.
concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
  quality-gates:
    name: "Playbook / Quality Gates"
    runs-on: ubuntu-latest
    timeout-minutes: 20

    steps:
      - name: Checkout Code Snapshot
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2 (Pinned immutable SHA)
        with:
          fetch-depth: 0 # Full history required for RIF verification and diff boundary detection

      - name: Setup Node.js Runtime
        uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0 (Pinned immutable SHA)
        with:
          node-version: 20
          cache: "npm"

      - name: Install Dependencies & Build CLI
        run: |
          if [ -f "tooling/playbook-cli/package.json" ]; then
            npm --prefix tooling/playbook-cli ci
            npm --prefix tooling/playbook-cli run build
            npm --prefix tooling/playbook-cli link
          elif [ -f "package.json" ]; then
            npm ci
          fi

      # Step 1: Governance Schema Conformance
      - name: Validate Manifest and State Schemas
        run: npx @ai-engineering-playbook/cli validate

      # Step 2: Governance Static Analysis & Policy Linting
      - name: Lint Governance Policies & Invariants
        run: playbook lint --strict --format json > lint-raw-report.json

      # Step 3: Governance Readiness & Blocker Inspection
      - name: Inspect Governance Readiness
        run: npx @ai-engineering-playbook/cli inspect --json

      # Step 4: Reproducible Input Fingerprint (RIF) Verification
      - name: Verify Reproducible Input Fingerprints (RIF)
        run: npx @ai-engineering-playbook/cli gate verify --json

      # Step 5: Tier 3 Headless Gate Execution (Clean Repo Mandated)
      - name: Execute Quality Gates (Headless)
        run: npx @ai-engineering-playbook/cli gate run --headless --json > gate-raw-report.json

      # Step 6: Cryptographic Evidence Byte-Hash Verification
      - name: Verify Evidence Hashes
        run: npx @ai-engineering-playbook/cli verify-evidence --json

      # Step 7: Generate CI Evidence Report & Step Summary
      - name: Publish Playbook Step Summary & Telemetry
        if: always()
        env:
          GITHUB_REPOSITORY: \${{ github.repository }}
          GITHUB_WORKFLOW: \${{ github.workflow }}
          GITHUB_RUN_ID: \${{ github.run_id }}
          GITHUB_RUN_ATTEMPT: \${{ github.run_attempt }}
          GITHUB_EVENT_NAME: \${{ github.event_name }}
          GITHUB_SHA: \${{ github.sha }}
          GITHUB_REF: \${{ github.ref }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          PR_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          PR_BASE_REF: \${{ github.event.pull_request.base.ref }}
          PR_BASE_SHA: \${{ github.event.pull_request.base.sha }}
          JOB_STATUS: \${{ job.status }}
        run: |
          if [ ! -f "gate-report.json" ]; then
            npx @ai-engineering-playbook/cli ci report --output gate-report.json --raw gate-raw-report.json --summary || true
          fi
          if [ ! -f "gate-report.json" ]; then
            node -e '
              const fs = require("fs");
              const runId = process.env.GITHUB_RUN_ID || "unknown";
              const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
              const repo = process.env.GITHUB_REPOSITORY || "unknown";
              const report = {
                "$schema": "https://ai-engineering-playbook.org/schemas/ci-run-evidence.schema.json",
                "schema_version": "1.0.0",
                "report_generation_method": "emergency_fallback",
                "gate_execution_started": false,
                "gate_execution_completed": false,
                "evidence_completeness": "incomplete",
                "run_identity": {
                  "provider": "github_actions",
                  "repository": repo,
                  "workflow_name": process.env.GITHUB_WORKFLOW || "Playbook Quality Gates & Verification",
                  "run_id": String(runId),
                  "run_attempt": Number(attempt),
                  "run_url": "https://github.com/" + repo + "/actions/runs/" + runId,
                  "trigger_event": process.env.GITHUB_EVENT_NAME || "push",
                  "ref": process.env.GITHUB_REF || null,
                  "pull_request_number": process.env.PR_NUMBER ? parseInt(process.env.PR_NUMBER, 10) : null,
                  "head_branch": null,
                  "base_branch": process.env.PR_BASE_REF || null,
                  "pr_head_sha": process.env.PR_HEAD_SHA || null,
                  "pr_base_sha": process.env.PR_BASE_SHA || null,
                  "checked_out_commit_sha": process.env.GITHUB_SHA || "0000000000000000000000000000000000000000",
                  "checked_out_tree_sha": "0000000000000000000000000000000000000000",
                  "head_commit_sha": process.env.PR_HEAD_SHA || process.env.GITHUB_SHA || "0000000000000000000000000000000000000000",
                  "head_tree_sha": "0000000000000000000000000000000000000000",
                  "is_merge_commit": false,
                  "commit_verified": false
                },
                "runtime_environment": {
                  "os_platform": process.platform,
                  "os_release": process.version,
                  "node_version": process.version,
                  "cli_version": "unavailable",
                  "runner_arch": process.arch
                },
                "governance_evaluation": {
                  "stage": 0,
                  "stage_name": "Discovery",
                  "profile": "standard",
                  "working_tree_clean": false,
                  "overall_outcome": "incomplete",
                  "started_at": new Date().toISOString(),
                  "completed_at": new Date().toISOString(),
                  "duration_ms": 0
                },
                "summary": { "total": 0, "passed": 0, "failed": 0, "warning": 0, "skipped": 0 },
                "checks": [],
                "artifacts": [{ "name": "playbook-ci-evidence-" + runId + "-" + attempt, "path": "gate-report.json", "retention_days": 30 }],
                "diagnostics": ["Early CI pipeline failure: CLI was unavailable or failed before report generation."],
                "limitations": [
                  "Emergency fallback report generated due to early CI pipeline failure before CLI availability.",
                  "A matching SHA-256 hash confirms only byte-level artifact integrity; it does NOT establish runner authenticity or cryptographic non-repudiation.",
                  "Evidence produced within a cloud runner execution environment is subject to provider retention policies (default 30 days on GitHub).",
                  "Long-term governance immutability is rooted in Git-committed hashes and human approval fingerprints, not ephemeral cloud runner storage.",
                  "Checked-out tree SHA verifies the state of the filesystem tree evaluated by quality gates; merge commits may differ from the PR branch tip."
                ]
              };
              fs.writeFileSync("gate-report.json", JSON.stringify(report, null, 2));
              if (process.env.GITHUB_STEP_SUMMARY) {
                fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\\n## AI Engineering Playbook Quality Gates & Verification\\n\\n> [!WARNING]\\n> **Verdict**: :warning: **INCOMPLETE** — Workflow failed before CLI could execute quality gates.\\n");
              }
            '
          fi

      # Step 7: Upload Run-Scoped Hash-Verifiable Evidence
      - name: Upload CI Execution Evidence
        if: always()
        uses: actions/upload-artifact@b4b15b8c7c6ac21ea08fcf65892d2ee8f75cf882 # v4.4.3 (Pinned immutable SHA)
        with:
          name: playbook-ci-evidence-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: |
            .playbook/logs/
            gate-report.json
            lint-raw-report.json
          retention-days: 30
`;

export class GitHubActionsAdapter implements CiAdapter {
  readonly provider: CiProviderType = "github";
  readonly defaultWorkflowPath: string = DEFAULT_GITHUB_WORKFLOW_PATH;
  readonly requiredCheckName: string = CI_REQUIRED_CHECK_NAME;

  /**
   * Generates the canonical GitHub Actions workflow with Playbook managed metadata header.
   */
  generateWorkflow(options: CiWorkflowOptions): string {
    const timestamp = options.timestamp ?? DEFAULT_CANONICAL_TIMESTAMP;
    const header = [
      CI_WORKFLOW_MARKERS.start,
      `# Playbook CLI Version: ${PLAYBOOK_VERSION}`,
      `# Provider: ${this.provider}`,
      `# Generated At: ${timestamp}`,
      CI_WORKFLOW_MARKERS.end,
      "",
    ].join("\n");

    return `${header}\n${CANONICAL_GITHUB_WORKFLOW_BODY.trim()}\n`;
  }

  /**
   * Statically asserts workflow permissions, triggers, check names, metadata, and action SHA pinning.
   */
  validateWorkflow(content: string, filePath: string): CiWorkflowValidationResult {
    const normalized = content.replace(/\r\n/g, "\n");
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Check managed markers
    const startCount = (normalized.match(new RegExp(escapeRegex(CI_WORKFLOW_MARKERS.start), "g")) || []).length;
    const endCount = (normalized.match(new RegExp(escapeRegex(CI_WORKFLOW_MARKERS.end), "g")) || []).length;

    let isPlaybookManaged = false;
    let version: string | undefined;

    // 0. YAML Syntax Check using real YAML parser
    try {
      YAML.parse(normalized);
    } catch (err) {
      errors.push(`YAML syntax error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (startCount === 0 && endCount === 0) {
      isPlaybookManaged = false;
      errors.push("Workflow file is missing Playbook management markers.");
    } else if (startCount !== 1 || endCount !== 1) {
      isPlaybookManaged = false;
      errors.push("Malformed or corrupted Playbook managed markers in workflow file.");
    } else {
      const startIndex = normalized.indexOf(CI_WORKFLOW_MARKERS.start);
      const endIndex = normalized.indexOf(CI_WORKFLOW_MARKERS.end);

      if (startIndex > endIndex) {
        errors.push("Corrupted marker ordering: end marker appears before start marker.");
      } else {
        isPlaybookManaged = true;
        const headerBlock = normalized.substring(startIndex, endIndex);

        const versionMatch = headerBlock.match(/#\s*Playbook CLI Version:\s*([^\s\r\n]+)/);
        if (versionMatch) {
          version = versionMatch[1];
        } else {
          errors.push("Managed workflow header is missing 'Playbook CLI Version' metadata.");
        }

        const providerMatch = headerBlock.match(/#\s*Provider:\s*([^\s\r\n]+)/);
        if (!providerMatch || providerMatch[1].trim() !== "github") {
          errors.push(
            `Managed workflow header specifies invalid provider '${providerMatch ? providerMatch[1] : "unknown"}'. Expected 'github'.`
          );
        }
      }
    }

    // 2. Forbidden triggers: pull_request_target is strictly prohibited
    if (/\bpull_request_target\b/.test(normalized)) {
      errors.push(
        "Workflow uses forbidden trigger 'pull_request_target', which creates critical elevation of privilege vulnerabilities for fork pull requests."
      );
    }

    // 3. Required triggers: pull_request and push
    if (!/\bpull_request\s*:/.test(normalized)) {
      errors.push("Workflow is missing mandatory trigger 'pull_request'.");
    }
    if (!/\bpush\s*:/.test(normalized)) {
      errors.push("Workflow is missing mandatory trigger 'push'.");
    }

    // 4. Permissions check: strictly read-only
    if (!/\bcontents\s*:\s*read\b/.test(normalized)) {
      errors.push("Workflow permissions must explicitly grant read-only access ('contents: read').");
    }

    // Check for any forbidden write permissions
    const writePermissionMatch = normalized.match(
      /\b(contents|pull-requests|issues|checks|statuses|id-token|actions|packages|deployments|pages|security-events)\s*:\s*write\b/i
    );
    if (writePermissionMatch) {
      errors.push(
        `Workflow contains forbidden write permission '${writePermissionMatch[0]}'. Playbook CI workflows must be strictly read-only.`
      );
    }

    if (/\bpermissions\s*:\s*write-all\b/i.test(normalized)) {
      errors.push("Workflow uses forbidden 'permissions: write-all'. Playbook CI workflows must be strictly read-only.");
    }

    // 5. Action SHA Pinning check: all actions must use full 40-character commit SHAs
    const usesRegex = /\buses\s*:\s*['"]?([a-zA-Z0-9_\-\.\/]+)@([^\s#'"]+)/g;
    let match: RegExpExecArray | null;
    let checkedActionsCount = 0;

    while ((match = usesRegex.exec(normalized)) !== null) {
      checkedActionsCount++;
      const actionName = match[1];
      const actionRef = match[2];

      // Local actions or docker actions may have other conventions, but third-party GitHub actions require full SHA
      const isSha = /^[a-fA-F0-9]{40}$/.test(actionRef);
      if (!isSha) {
        errors.push(
          `Action '${actionName}' is not pinned to an immutable 40-character commit SHA (found '@${actionRef}'). Mutable action references violate supply chain security policy.`
        );
      }
    }

    if (checkedActionsCount === 0) {
      warnings.push("No third-party action invocations detected in workflow.");
    }

    // 6. Required check name
    if (!/name:\s*["']?Playbook \/ Quality Gates["']?/.test(normalized)) {
      errors.push("Workflow is missing required check name 'Playbook / Quality Gates'.");
    }

    // 7. Core steps verification
    if (!/actions\/checkout@/.test(normalized)) {
      errors.push("Workflow is missing required checkout step ('actions/checkout').");
    }
    if (!/(?:playbook|@ai-engineering-playbook\/cli)\s+validate/.test(normalized)) {
      errors.push("Workflow is missing required step 'playbook validate'.");
    }
    if (!/(?:playbook|@ai-engineering-playbook\/cli)\s+lint/.test(normalized)) {
      errors.push("Workflow is missing required step 'playbook lint'.");
    }
    if (!/(?:playbook|@ai-engineering-playbook\/cli)\s+inspect/.test(normalized)) {
      errors.push("Workflow is missing required step 'playbook inspect'.");
    }
    if (!/(?:playbook|@ai-engineering-playbook\/cli)\s+gate\s+verify/.test(normalized)) {
      errors.push("Workflow is missing required step 'playbook gate verify'.");
    }
    if (!/(?:playbook|@ai-engineering-playbook\/cli)\s+gate\s+run\s+--headless/.test(normalized)) {
      errors.push("Workflow is missing required step 'playbook gate run --headless'.");
    }
    if (!/(?:playbook|@ai-engineering-playbook\/cli)\s+verify-evidence/.test(normalized)) {
      errors.push("Workflow is missing required step 'playbook verify-evidence'.");
    }
    if (!/(?:playbook|@ai-engineering-playbook\/cli)\s+ci\s+report/.test(normalized)) {
      errors.push("Workflow is missing required step 'playbook ci report'.");
    }
    if (!/actions\/upload-artifact@/.test(normalized)) {
      errors.push("Workflow is missing required evidence upload step ('actions/upload-artifact').");
    }

    // 8. Concurrency Configuration Check: PR isolation and push run protection
    if (!/\bconcurrency\s*:/.test(normalized)) {
      errors.push("Workflow is missing required 'concurrency' configuration to prevent race conditions.");
    } else {
      if (
        !/\bgroup\s*:\s*[^\n]*github\.event\.pull_request\.number/.test(normalized) &&
        !/\bgroup\s*:\s*[^\n]*github\.head_ref/.test(normalized)
      ) {
        errors.push(
          "Workflow concurrency group must include pull request number or head ref to ensure different pull requests do not cancel each other."
        );
      }
      if (
        !/cancel-in-progress\s*:\s*\$\{\{\s*github\.event_name\s*==\s*['"]pull_request['"]\s*\}\}/.test(normalized)
      ) {
        errors.push(
          "Workflow concurrency must set 'cancel-in-progress: ${{ github.event_name == \\'pull_request\\' }}' to prevent cancelling main push audits."
        );
      }
    }

    // 9. Workflow Attempt Isolation: Evidence artifact upload name must include run_attempt
    const uploadArtifactStep = normalized.match(/actions\/upload-artifact@[\s\S]*?(?=(?:- name:|$))/);
    if (uploadArtifactStep) {
      if (!/name:\s*[^\n]*github\.run_attempt/.test(uploadArtifactStep[0])) {
        errors.push(
          "Evidence artifact upload name must include 'github.run_attempt' to ensure re-run attempts retain distinct evidence identity."
        );
      }
    }

    // 10. Early Failure Guarantees: Step 6 and Step 7 must have 'if: always()'
    const reportStepMatch = normalized.match(
      /name:\s*["']?[^"'\n]*Publish Playbook Step Summary[^"'\n]*["']?[\s\S]*?(?=(?:- name:|$))/
    );
    if (reportStepMatch && !/\bif\s*:\s*always\(\)/.test(reportStepMatch[0])) {
      errors.push("Step 'Publish Playbook Step Summary & Telemetry' must include 'if: always()' to guarantee reporting on early failures.");
    }

    const uploadStepMatch = normalized.match(
      /name:\s*["']?[^"'\n]*Upload CI Execution Evidence[^"'\n]*["']?[\s\S]*?(?=(?:- name:|$))/
    );
    if (uploadStepMatch && !/\bif\s*:\s*always\(\)/.test(uploadStepMatch[0])) {
      errors.push("Step 'Upload CI Execution Evidence' must include 'if: always()' to guarantee evidence persistence on failure.");
    }

    // 10. Shell Injection Protection: PR context values must NOT be interpolated directly in run: commands
    if (/\brun:\s*[^\n]*\$\{\{\s*github\.(?:head_ref|event\.(?:pull_request|issue|comment|head_commit))/i.test(normalized)) {
      errors.push(
        "Workflow directly interpolates untrusted PR/event context into shell run command. Use env: mappings to prevent command injection."
      );
    }

    const permissionsValid = !errors.some((e) => e.includes("permission"));
    const triggersValid = !errors.some((e) => e.includes("trigger"));
    const pinnedActionsValid = !errors.some((e) => e.includes("commit SHA") || e.includes("pinned"));

    return {
      valid: errors.length === 0,
      provider: "github",
      filePath,
      errors,
      warnings,
      isPlaybookManaged,
      version,
      requiredCheckName: CI_REQUIRED_CHECK_NAME,
      permissionsValid,
      triggersValid,
      pinnedActionsValid,
    };
  }

  getRequiredCheckNames(): string[] {
    return [this.requiredCheckName];
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
