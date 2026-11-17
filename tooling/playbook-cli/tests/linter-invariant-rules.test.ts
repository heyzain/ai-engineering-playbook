import test, { describe } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  RuleRegistry,
  LinterEngine,
  DefaultRuleExecutionContext,
  ruleGovNoAgentApproval,
  ruleGovImmutableWalCi,
  ruleGovEvidenceIntegrity,
  ruleGovExceptionBounds,
  ruleGovStackSovereignty,
  INVARIANT_RULES,
  SCHEMA_RULES,
  DOCUMENTATION_RULES,
  type RuleFinding,
} from "../src/core/linters/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function writeValidManifest(targetDir: string): void {
  const playbookDir = path.join(targetDir, ".playbook");
  fs.mkdirSync(playbookDir, { recursive: true });

  const manifest = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-manifest.schema.json",
    schema_version: "1.0.0",
    project_id: "test-governance-project",
    project_name: "Test Governance Project",
    active_milestone_id: "M-1.0.0",
    description: "Test description",
    playbook: {
      version: "1.0.0",
      governance_profile: "standard",
      approval_mode: "solo",
    },
    tech_stack: {
      ecosystem: "node",
      primary_language: "typescript",
      runtimes: ["node20"],
      frameworks: ["nextjs"],
      package_manager: "npm",
    },
    paths: {
      docs_root: "docs",
      prd_dir: "docs/prd",
      adr_dir: "docs/adr",
      rfc_dir: "docs/rfcs",
      gates_dir: "docs/gates",
      exceptions_dir: "docs/exceptions",
      state_file: ".playbook/state.json",
    },
    active_lifecycle_stage: 0,
    capabilities: ["automated_testing"],
    technology_stacks: ["nextjs"],
  };

  fs.writeFileSync(path.join(playbookDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
}

function writeValidState(targetDir: string, overrides: Record<string, unknown> = {}): void {
  const playbookDir = path.join(targetDir, ".playbook");
  fs.mkdirSync(playbookDir, { recursive: true });

  const state = {
    $schema: "https://ai-engineering-playbook.org/schemas/project-state.schema.json",
    schema_version: "1.0.0",
    project_id: "test-governance-project",
    playbook_version: "1.0.0",
    milestone_id: "M-1.0.0",
    milestone_name: "M-1.0.0 Initial Release",
    lifecycle_status: "active",
    current_stage: 0,
    stage_status: "not_started",
    current_stage_detail: {
      stage: 0,
      stage_name: "Discovery & Problem Formulation",
      started_at: "2026-11-07T00:00:00.000Z",
      deliverables: [
        {
          id: "PRD-CORE",
          name: "Problem Statement Document (PRD Core)",
          description: "Core problem formulation, user goals, non-goals, and measurable success metrics.",
          artifact_path: "docs/prd/PRD-CORE.md",
          status: "not_started",
          validation_status: "unvalidated",
          exception_ref: null,
          evidence: [],
        },
      ],
      rfcs: [],
      adrs: [],
      exceptions: [],
      exit_package: {
        status: "not_drafted",
        path: "docs/gates/GATE-0-EXIT-PACKAGE.md",
        submitted_at: null,
      },
      human_approval: {
        status: "not_requested",
        approved_by: null,
        role: null,
        approval_mode: "solo",
        decision: null,
        signature_reference: null,
        approved_at: null,
        conditions: null,
      },
    },
    stage_history: [],
    archived_milestones: [],
    last_updated: {
      timestamp: "2026-11-07T00:00:00.000Z",
      updated_by: "human-operator",
      actor_type: "human",
      reason: "Initial project state",
    },
    ...overrides,
  };

  fs.writeFileSync(path.join(playbookDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
}

describe("Task 008B.4: Category C Governance Invariants Rules", () => {
  let tmpDir: string;

  test.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linter-invariant-test-"));
  });

  test.afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. RULE-GOV-NO-AGENT-APPROVAL
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. RULE-GOV-NO-AGENT-APPROVAL", () => {
    test("passes cleanly on valid human approval record", async () => {
      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 0,
          stage_name: "Discovery & Problem Formulation",
          status: "approved",
          human_approval: {
            status: "approved",
            approved_by: "Alice Smith",
            role: "lead-engineer",
            signature_reference: "SIG-HUMAN-20261107",
          },
        },
        last_updated: {
          timestamp: "2026-11-07T00:00:00.000Z",
          actor_type: "human",
          updated_by: "Alice Smith",
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovNoAgentApproval.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags approved stage with agent approver name with AGENT_APPROVAL_PROHIBITED", async () => {
      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 0,
          stage_name: "Discovery & Problem Formulation",
          status: "approved",
          human_approval: {
            status: "approved",
            approved_by: "playbook-agent-v1",
            role: "autonomous-agent",
            signature_reference: "AGENT-SIG-001",
          },
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovNoAgentApproval.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "AGENT_APPROVAL_PROHIBITED"));
      assert.strictEqual(findings[0].blocksOperation, true);
    });

    test("flags approved stage with actor_type: 'agent' in last_updated", async () => {
      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 0,
          stage_name: "Discovery & Problem Formulation",
          status: "approved",
          human_approval: {
            status: "approved",
            approved_by: "John Doe",
          },
        },
        last_updated: {
          timestamp: "2026-11-07T00:00:00.000Z",
          actor_type: "agent",
          updated_by: "subagent-runner",
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovNoAgentApproval.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "AGENT_APPROVAL_PROHIBITED" && f.message.includes("actor_type")));
    });

    test("flags historical stage in stage_history with agent approval", async () => {
      writeValidState(tmpDir, {
        stage_history: [
          {
            stage: 0,
            stage_name: "Discovery & Problem Formulation",
            human_approval: {
              status: "approved",
              approved_by: "gemini-cli-agent",
            },
          },
        ],
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovNoAgentApproval.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "AGENT_APPROVAL_PROHIBITED" && f.message.includes("Historical stage 0")));
    });

    test("flags approval sidecar specifying agent approver with FORGED_APPROVAL_SIDECAR", async () => {
      writeValidState(tmpDir);
      const gatesDir = path.join(tmpDir, "docs", "gates");
      fs.mkdirSync(gatesDir, { recursive: true });

      fs.writeFileSync(
        path.join(gatesDir, "GATE-0-APPROVAL.json"),
        JSON.stringify({
          gate: 0,
          status: "approved",
          approver_type: "agent",
          approved_by: "autonomous-ai-controller",
        }),
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovNoAgentApproval.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "FORGED_APPROVAL_SIDECAR"));
    });

    test("flags markdown exit package with agent approver with AGENT_APPROVAL_PROHIBITED", async () => {
      writeValidState(tmpDir);
      const gatesDir = path.join(tmpDir, "docs", "gates");
      fs.mkdirSync(gatesDir, { recursive: true });

      fs.writeFileSync(
        path.join(gatesDir, "GATE-0-EXIT.md"),
        `# Stage 0 Exit Package
## Human Approval
| Field | Value |
| :--- | :--- |
| **Approved By** | \`antigravity-agent\` |
`,
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovNoAgentApproval.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "AGENT_APPROVAL_PROHIBITED"));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. RULE-GOV-IMMUTABLE-WAL-CI
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. RULE-GOV-IMMUTABLE-WAL-CI", () => {
    test("passes cleanly on read-only CI workflows and gate check commands", async () => {
      const wfDir = path.join(tmpDir, ".github", "workflows");
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(
        path.join(wfDir, "ci.yml"),
        `name: CI
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: playbook gate run --headless
      - run: playbook verify-evidence
`,
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovImmutableWalCi.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags CI workflow attempting 'playbook advance' with CI_MUTATION_PROHIBITED", async () => {
      const wfDir = path.join(tmpDir, ".github", "workflows");
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(
        path.join(wfDir, "deploy.yml"),
        `name: Deploy
jobs:
  auto-advance:
    steps:
      - run: playbook advance
`,
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovImmutableWalCi.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "CI_MUTATION_PROHIBITED" && f.message.includes("advance")));
      assert.strictEqual(findings[0].blocksOperation, true);
    });

    test("flags CI workflow attempting 'playbook approve' or 'playbook reopen'", async () => {
      const wfDir = path.join(tmpDir, ".github", "workflows");
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(
        path.join(wfDir, "pipeline.yml"),
        `steps:
  - run: playbook approve --gate 1
  - run: playbook reopen
`,
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovImmutableWalCi.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length >= 2);
      assert.ok(findings.some((f) => f.message.includes("approve")));
      assert.ok(findings.some((f) => f.message.includes("reopen")));
    });

    test("flags quality-gate check executing mutating command with WAL_MUTATION_IN_CI", async () => {
      const playbookDir = path.join(tmpDir, ".playbook");
      fs.mkdirSync(playbookDir, { recursive: true });
      fs.writeFileSync(
        path.join(playbookDir, "quality-gates.json"),
        JSON.stringify({
          gates: [
            {
              stage: 1,
              checks: [
                {
                  id: "bad-check",
                  command: "playbook",
                  args: ["advance", "--force"],
                },
              ],
            },
          ],
        }),
        "utf-8"
      );

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovImmutableWalCi.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "WAL_MUTATION_IN_CI"));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. RULE-GOV-EVIDENCE-INTEGRITY
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. RULE-GOV-EVIDENCE-INTEGRITY", () => {
    test("passes cleanly when verified deliverable has matching evidence file and hash", async () => {
      const logDir = path.join(tmpDir, ".playbook", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const logContent = "All 10 unit tests passed successfully.";
      const logPath = path.join(logDir, "test.log");
      fs.writeFileSync(logPath, logContent, "utf-8");

      const hash = "sha256:" + crypto.createHash("sha256").update(Buffer.from(logContent, "utf-8")).digest("hex");

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          stage_name: "Requirements",
          deliverables: [
            {
              id: "SPEC-CORE",
              status: "verified",
              validation_status: "passed",
              evidence: [
                {
                  procedure: "unit-test",
                  result: "passed",
                  evidence_ref: ".playbook/logs/test.log",
                  evidence_hash: hash,
                },
              ],
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovEvidenceIntegrity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("passes cleanly on in_progress deliverable without evidence (not yet verified)", async () => {
      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "SPEC-CORE",
              status: "in_progress",
              validation_status: "unvalidated",
              evidence: [],
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovEvidenceIntegrity.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags verified deliverable with empty evidence array with MISSING_EVIDENCE_RECORD", async () => {
      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "SPEC-CORE",
              status: "verified",
              validation_status: "passed",
              evidence: [],
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovEvidenceIntegrity.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "MISSING_EVIDENCE_RECORD"));
    });

    test("flags verified deliverable whose evidence file is missing on disk with MISSING_EVIDENCE_RECORD", async () => {
      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "SPEC-CORE",
              status: "verified",
              validation_status: "passed",
              evidence: [
                {
                  result: "passed",
                  evidence_ref: ".playbook/logs/missing.log",
                  evidence_hash: "sha256:" + "a".repeat(64),
                },
              ],
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovEvidenceIntegrity.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "MISSING_EVIDENCE_RECORD" && f.message.includes("missing.log")));
    });

    test("flags verified deliverable with mismatched SHA-256 hash with DELIVERABLE_UNVERIFIED_CLAIM", async () => {
      const logDir = path.join(tmpDir, ".playbook", "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "test.log"), "Content A", "utf-8");

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "SPEC-CORE",
              status: "verified",
              validation_status: "passed",
              evidence: [
                {
                  result: "passed",
                  evidence_ref: ".playbook/logs/test.log",
                  evidence_hash: "sha256:" + "f".repeat(64), // mismatched hash
                },
              ],
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovEvidenceIntegrity.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "DELIVERABLE_UNVERIFIED_CLAIM" && f.message.includes("does not match")));
    });

    test("flags verified deliverable with validation_status not 'passed' with DELIVERABLE_UNVERIFIED_CLAIM", async () => {
      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "SPEC-CORE",
              status: "verified",
              validation_status: "unvalidated",
              evidence: [],
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovEvidenceIntegrity.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "DELIVERABLE_UNVERIFIED_CLAIM"));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. RULE-GOV-EXCEPTION-BOUNDS
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. RULE-GOV-EXCEPTION-BOUNDS", () => {
    function writeValidExceptionRecord(
      excDir: string,
      excId: string,
      overrides?: {
        status?: string;
        expires?: string;
        stage?: string;
        waivedRequirement?: string;
        authorizerName?: string;
        authorizerRole?: string;
        decision?: string;
        signOffRef?: string;
        justification?: string;
        compensatingControls?: string;
      }
    ) {
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const status = overrides?.status ?? "active";
      const expires = overrides?.expires ?? futureDate;
      const stage = overrides?.stage ?? "Stage 1: Requirements";
      const waivedReq = overrides?.waivedRequirement ?? "OPT-PERF";
      const authorizerName = overrides?.authorizerName ?? "Alice Human";
      const authorizerRole = overrides?.authorizerRole ?? "Lead Architect";
      const decision = overrides?.decision ?? "EXCEPTION AUTHORIZED";
      const signOffRef = overrides?.signOffRef ?? "commit-9f8e7d6c5b";
      const justification = overrides?.justification ?? "Temporary waiver of performance threshold during initial discovery phase.";
      const compensatingControls = overrides?.compensatingControls ?? "Feature flags disable background processing until optimization is completed.";

      const content = `# EXC-20261107-001: Defer Performance Optimization for Initial Discovery

## 1. Exception Metadata

| Field | Value |
| :--- | :--- |
| **Exception ID** | \`${excId}\` |
| **Creation Date** | 2026-11-07 |
| **Active Lifecycle Stage** | \`${stage}\` |
| **Bypassed Stage Gate** | \`Gate 1\` |
| **Waived Rule / Requirement** | \`${waivedReq}\` |
| **Exception Status** | \`${status}\` |
| **Expiration / Review Date** | \`${expires}\` |

## 2. Requester & Authorizer Identification

| Role | Name | Title / Contact |
| :--- | :--- | :--- |
| **Requested By** | Jane Engineer | Senior Developer |
| **Authorized By (Human)** | ${authorizerName} | ${authorizerRole} |

## 3. Reason & Justification for Exception
${justification}

## 4. Risk Assessment & Blast Radius Analysis
Risk is low and isolated strictly to non-critical background jobs.

## 5. Compensating Controls
${compensatingControls}

## 6. Remediation Plan & Expiration
Action item REM-001 assigned to optimize pipeline before Gate 2.

## 7. Human Authorization & Sign-Off

| Field | Record |
| :--- | :--- |
| **Authorizer Name** | ${authorizerName} |
| **Title / Authority** | ${authorizerRole} |
| **Authorization Decision** | \`${decision}\` |
| **Authorization Date** | 2026-11-07 |
| **Sign-Off Reference** | \`${signOffRef}\` |
`;
      fs.writeFileSync(path.join(excDir, `${excId}.md`), content, "utf-8");
      return content;
    }

    test("passes cleanly on valid, authorized, correctly scoped, unexpired exception", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      const excId = "EXC-20261107-001";
      writeValidExceptionRecord(excDir, excId);

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          stage_name: "Requirements",
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: `docs/exceptions/${excId}.md`,
            },
          ],
          exceptions: [
            {
              exception_id: excId,
              path: `docs/exceptions/${excId}.md`,
              waived_requirement: "OPT-PERF",
              authorized_by: "Alice Human, Lead Architect",
              authorized_at: "2026-11-07T12:00:00.000Z",
              expiration_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
              status: "active",
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags waived deliverable without exception_ref with UNRESOLVED_EXCEPTION_RECORD", async () => {
      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: null,
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD"));
    });

    test("flags waived deliverable referencing missing exception file with UNRESOLVED_EXCEPTION_RECORD", async () => {
      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: "docs/exceptions/EXC-NONEXISTENT.md",
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD" && f.message.includes("does not exist")));
    });

    test("flags waived deliverable when approval evidence is missing or placeholder", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      const excId = "EXC-20261107-002";
      writeValidExceptionRecord(excDir, excId, {
        signOffRef: "[Commit SHA / PR #XX comment / In-chat confirmation]", // placeholder!
      });

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: `docs/exceptions/${excId}.md`,
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD" && f.message.includes("sign-off reference")));
    });

    test("flags waived deliverable when approver is unauthorized or unverified placeholder", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      const excId = "EXC-20261107-003";
      writeValidExceptionRecord(excDir, excId, {
        authorizerName: "[Human Lead Name]", // placeholder!
      });

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: `docs/exceptions/${excId}.md`,
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD" && f.message.includes("authorizer identification")));
    });

    test("flags waived deliverable when approver is an AI agent", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      const excId = "EXC-20261107-004";
      writeValidExceptionRecord(excDir, excId, {
        authorizerName: "playbook-agent-v1", // AI Agent!
      });

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: `docs/exceptions/${excId}.md`,
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD" && f.message.includes("AI agent")));
    });

    test("flags waived deliverable when exception scope mismatches deliverable or stage", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      const excId = "EXC-20261107-005";
      writeValidExceptionRecord(excDir, excId, {
        waivedRequirement: "ARCH-SPEC", // Mismatch: target is ARCH-SPEC, deliverable is OPT-PERF
      });

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: `docs/exceptions/${excId}.md`,
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD" && f.message.includes("scope mismatch")));
    });

    test("flags waived deliverable when expiration date is missing or malformed", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      const excId = "EXC-20261107-006";
      writeValidExceptionRecord(excDir, excId, {
        expires: "not-a-valid-date",
      });

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: `docs/exceptions/${excId}.md`,
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD" && f.message.includes("malformed expiration date")));
    });

    test("flags waived deliverable referencing revoked exception with UNRESOLVED_EXCEPTION_RECORD", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      const excId = "EXC-20261107-007";
      writeValidExceptionRecord(excDir, excId, {
        status: "revoked",
      });

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: `docs/exceptions/${excId}.md`,
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD" && f.message.includes("revoked")));
    });

    test("flags waived deliverable referencing expired exception with EXPIRED_EXCEPTION_IN_USE", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      const excId = "EXC-20261107-008";
      writeValidExceptionRecord(excDir, excId, {
        expires: "2020-01-01",
      });

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: `docs/exceptions/${excId}.md`,
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "EXPIRED_EXCEPTION_IN_USE" && f.message.includes("expired")));
    });

    test("flags waived deliverable when integrity evidence is corrupt or inconsistent", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      const excId = "EXC-20261107-009";
      writeValidExceptionRecord(excDir, excId);

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: `docs/exceptions/${excId}.md`,
              evidence: [
                {
                  procedure: "integrity-verification",
                  result: "passed",
                  evidence_ref: `docs/exceptions/${excId}.md`,
                  evidence_hash: "sha256:" + "0".repeat(64), // Mismatched SHA-256 hash!
                },
              ],
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD" && f.message.includes("integrity evidence")));
    });

    test("flags waived deliverable when required metadata or compensating controls are missing", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      const excId = "EXC-20261107-010";
      writeValidExceptionRecord(excDir, excId, {
        compensatingControls: "[TODO: Define mitigations]", // Placeholder compensating controls!
      });

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: `docs/exceptions/${excId}.md`,
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD" && f.message.includes("compensating controls")));
    });

    test("fail-closed: file existence and active status alone do not authorize waiver without approval and scope", async () => {
      const excDir = path.join(tmpDir, "docs", "exceptions");
      fs.mkdirSync(excDir, { recursive: true });

      // Minimal file with just status and expires (presence + status alone)
      fs.writeFileSync(
        path.join(excDir, "EXC-20261107-MINIMAL.md"),
        `# Exception Record: Minimal\n| Field | Value |\n| Status | active |\n| Expires | 2099-01-01 |\n`,
        "utf-8"
      );

      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "OPT-PERF",
              status: "waived",
              validation_status: "waived",
              exception_ref: "docs/exceptions/EXC-20261107-MINIMAL.md",
            },
          ],
        },
      });

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovExceptionBounds.evaluate(context)) || []) as RuleFinding[];
      // Fails closed!
      assert.ok(findings.length > 0);
      assert.ok(findings.every((f) => f.blocksOperation));
      assert.ok(findings.some((f) => f.diagnosticCode === "UNRESOLVED_EXCEPTION_RECORD"));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. RULE-GOV-STACK-SOVEREIGNTY
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. RULE-GOV-STACK-SOVEREIGNTY", () => {
    test("passes cleanly on legitimate stack template application files", async () => {
      const tDir = path.join(tmpDir, "stacks", "my-stack", "template");
      fs.mkdirSync(tDir, { recursive: true });
      fs.writeFileSync(path.join(tDir, "app.json"), "{}", "utf-8");
      fs.mkdirSync(path.join(tDir, "src"));
      fs.writeFileSync(path.join(tDir, "src", "index.ts"), "export const x = 1;", "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovStackSovereignty.evaluate(context)) || []) as RuleFinding[];
      assert.strictEqual(findings.length, 0);
    });

    test("flags stack template attempting to overwrite .playbook/manifest.json", async () => {
      const badTDir = path.join(tmpDir, "stacks", "rogue-stack", "template", ".playbook");
      fs.mkdirSync(badTDir, { recursive: true });
      fs.writeFileSync(path.join(badTDir, "manifest.json"), "{}", "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovStackSovereignty.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length > 0);
      assert.ok(findings.some((f) => f.diagnosticCode === "CORE_GOVERNANCE_OVERWRITE_ATTEMPT" && f.message.includes("manifest.json")));
    });

    test("flags stack template attempting to overwrite core/ or governance/ paths", async () => {
      const tDir = path.join(tmpDir, "stacks", "rogue-stack", "template");
      fs.mkdirSync(path.join(tDir, "core"), { recursive: true });
      fs.writeFileSync(path.join(tDir, "core", "engineering-constitution.md"), "# Rogue Constitution", "utf-8");

      fs.mkdirSync(path.join(tDir, "governance"), { recursive: true });
      fs.writeFileSync(path.join(tDir, "governance", "stage-gate-rules.md"), "# Rogue Rules", "utf-8");

      const context = new DefaultRuleExecutionContext(tmpDir);
      const findings = ((await ruleGovStackSovereignty.evaluate(context)) || []) as RuleFinding[];
      assert.ok(findings.length >= 2);
      assert.ok(findings.every((f) => f.diagnosticCode === "CORE_GOVERNANCE_OVERWRITE_ATTEMPT"));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Engine Integration & Regression Consistency
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Engine Integration & Regression Consistency", () => {
    test("runs all 5 Category C rules via LinterEngine producing clean passed status on valid project", async () => {
      writeValidManifest(tmpDir);
      writeValidState(tmpDir);

      const registry = new RuleRegistry();
      for (const rule of INVARIANT_RULES) {
        registry.register(rule);
      }
      assert.strictEqual(registry.size, 5);

      const engine = new LinterEngine(registry);
      const result = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.findings.length, 0);
      assert.strictEqual(result.summary.blocking, 0);
    });

    test("repeated execution produces identical canonical output (idempotence)", async () => {
      writeValidState(tmpDir, {
        current_stage_detail: {
          stage: 1,
          deliverables: [
            {
              id: "DELIV-1",
              status: "verified",
              validation_status: "passed",
              evidence: [], // will emit missing evidence record
            },
          ],
        },
      });

      const registry = new RuleRegistry();
      for (const rule of INVARIANT_RULES) {
        registry.register(rule);
      }

      const engine = new LinterEngine(registry);
      const result1 = await engine.run({ projectDir: tmpDir });
      const result2 = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(result1.status, result2.status);
      assert.strictEqual(result1.findings.length, result2.findings.length);
      assert.deepStrictEqual(result1.findings, result2.findings);
    });

    test("executes Category A, Category B, and Category C rules concurrently without mutual interference", async () => {
      writeValidManifest(tmpDir);
      writeValidState(tmpDir);
      fs.writeFileSync(path.join(tmpDir, "README.md"), "# Valid Readme\n[Valid Link](README.md)");

      const playbookDir = path.join(tmpDir, ".playbook");
      fs.writeFileSync(
        path.join(playbookDir, "quality-gates.json"),
        JSON.stringify({
          $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json",
          schema_version: "1.0.0",
          project_id: "test-governance-project",
          default_profile: "standard",
          global_settings: {
            default_timeout_ms: 30000,
            max_concurrency: 2,
            mask_secrets: true,
            log_retention_runs: 10,
            max_journaled_log_bytes: 1048576,
            env_allowlist: ["PATH", "NODE_ENV"],
          },
          gates: [],
        }),
        "utf-8"
      );

      const registry = new RuleRegistry();
      for (const rule of [...DOCUMENTATION_RULES, ...SCHEMA_RULES, ...INVARIANT_RULES]) {
        registry.register(rule);
      }
      assert.strictEqual(registry.size, 14); // 5 Doc + 4 Schema + 5 Invariant

      const engine = new LinterEngine(registry);
      const result = await engine.run({ projectDir: tmpDir });

      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.findings.length, 0);
      assert.strictEqual(result.executedRuleCount, 14);
    });

    test("strictly read-only: does not mutate state or WAL during linting", async () => {
      writeValidState(tmpDir);
      const statePath = path.join(tmpDir, ".playbook", "state.json");
      const beforeState = fs.readFileSync(statePath, "utf-8");

      const registry = new RuleRegistry();
      for (const rule of INVARIANT_RULES) {
        registry.register(rule);
      }

      const engine = new LinterEngine(registry);
      await engine.run({ projectDir: tmpDir });

      assert.strictEqual(fs.readFileSync(statePath, "utf-8"), beforeState);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", "journal.json")), false);
      assert.strictEqual(fs.existsSync(path.join(tmpDir, ".playbook", ".lock")), false);
    });
  });
});
