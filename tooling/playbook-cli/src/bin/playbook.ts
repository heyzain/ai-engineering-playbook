#!/usr/bin/env node

import fs from "node:fs";
import { runWorkflowCommand } from "../commands/workflow.js";
import { parseArgs } from "node:util";
import { PLAYBOOK_VERSION } from "../constants.js";
import { runInit } from "../commands/init.js";
import { runValidate } from "../commands/validate.js";
import { runInspect } from "../commands/inspect.js";
import { runVerifyEvidence } from "../commands/verify-evidence.js";
import { runLint } from "../commands/lint.js";
import { runApprove } from "../commands/approve.js";
import { runAdvance } from "../commands/advance.js";
import { runReopen } from "../commands/reopen.js";
import { runPivot } from "../commands/pivot.js";
import { runGateList, runGateRun, runGateVerify, runGateRecover } from "../commands/gate.js";
import { runHookInstall, runHookStatus, runHookUninstall, runHookRun } from "../commands/hook.js";
import { runCiInit, runCiValidate, runCiStatus, runCiReport } from "../commands/ci.js";
import { runStackList, runStackApply, runStackCompose } from "../commands/stack.js";
import type { GovernanceProfile, ApprovalMode } from "../constants.js";

const CLI_VERSION = "1.0.0";

const HELP_TEXT = `
AI Engineering Playbook CLI (v${CLI_VERSION})
Governance and project lifecycle management for AI-assisted engineering.

Usage:
  playbook <command> [options]

Commands:
  stage             Start a stage or submit its verified exit package (stage start|submit)
  deliverable       Record authored work or append evidence (deliverable record|evidence)
  exception         Local proposal/authorization/revocation/remediation; explicit migration and operator boundaries
  inspect           Inspect project governance state, deliverables, and readiness (read-only)
  verify-evidence   Verify evidence files and SHA-256 integrity hashes (read-only)
  lint              Evaluate governance rules across Categories A-E (read-only):
                      lint [--category <name>] [--strict] [--format <terminal|json>] [--json] [--rule <id>]
  init              Initialize a downstream project with standard manifest and state
  validate          Validate project manifest and state against JSON Schemas
  approve           Interactively review and approve/reject active stage gate (human only)
  advance           Advance to the next lifecycle stage following formal human approval
  reopen            Reopen a completed project lifecycle for maintenance (human only)
  pivot             Pivot active maintenance milestone from Stage 1 to Stage 0 (human only)
  recover           Interactively recover a blocked stage following human remediation (human only)
  gate              Quality gate management and execution:
                      gate list [--stage <N>] [--all] [--json]
                      gate run [--stage <N>] [--check <id>] [--headless] [--fail-fast] [--halt-on-failure] [--json]
                      gate verify [--stage <N>] [--json]
                      gate recover [--stage <N>] [--reason <text>] [--operator <name>] [--role <role>] [--json]
  hook              Git hook lifecycle and wrapper management:
                      hook install [--hooks-dir <path>] [--dry-run] [--force] [--allow-inert]
                      hook status [--hooks-dir <path>] [--json]
                      hook uninstall [--hooks-dir <path>] [--force] [--json]
  ci                Remote CI workflow scaffolding and validation:
                      ci init [--provider <type>] [--output <path>] [--force] [--dry-run]
                      ci validate [--provider <type>] [--file <path>] [--json]
                      ci status [--provider <type>] [--file <path>] [--json]
                      ci report [--output <path>] [--raw <path>] [--summary] [--json]
  stack             Technology stack lifecycle and modular extension management:
                      stack list [--json]
                      stack apply <name> [--cwd <path>] [--force] [--json]
                      stack compose [--cwd <path>] [--json]
  help              Show this help message

Options:
  -h, --help              Show help message
  -v, --version           Show CLI and Playbook standard versions
  --gate <N>              Gate number to review/approve (0 to 6)
  --stage <0|1>           Entry stage for maintenance reopening (0 or 1) or pivot (0)
  --reviewer <name>       Claimed human reviewer full name
  --authorized-by <name>  Claimed human authorizer full name (reopen and pivot commands)
  --role <role>           Engineering role or title
  --reason <text>         Reopening or pivot rationale or justification
  --mode <mode>           Approval mode (solo, team)
  --signature <ref>       Signature or review reference (e.g. PR #42)
  --conditions <conds>    Approval conditions or mandatory rework reasons
  --reject                Record formal gate rejection rather than approval
  --json                  Output machine-readable JSON (inspect, verify-evidence, advance, reopen, pivot)
  -f, --force             Overwrite existing governance files (init command)
  --non-interactive       Execute without interactive terminal prompts
  --project-id <id>       Kebab-case project identifier (e.g. 'my-app')
  --name <name>           Human-readable project display name
  --description <desc>    Project description
  --ecosystem <eco>       Primary ecosystem (node, python, go, rust, java, agnostic)
  --language <lang>       Primary language (typescript, python, go, rust, agnostic)
  --profile <profile>     Governance profile (strict, standard, lightweight)
  --milestone <id>        Milestone identifier (e.g. 'M-1.0.0')
  --stack <name>          Technology stack to initialize/apply (e.g. 'nextjs')
  --category <name>       Rule category filter (documentation, schema, governance, stack, security, all)
  --strict                Promote warnings to blocking violations (mandatory in CI)
  --format <type>         Output format (terminal, json)
  --rule <id>             Specific rule identifier filter (e.g. RULE-DOC-REF-INTEGRITY)
  --cwd <path>            Target directory (defaults to current working directory)

Examples:
  # Inspect project governance state (human-readable)
  playbook inspect

  # Interactively approve active Stage Gate 1
  playbook approve --gate 1

  # Advance lifecycle stage following human gate approval
  playbook advance

  # Validate existing project governance files against schemas
  playbook validate

  # Pivot active maintenance milestone to Stage 0
  playbook pivot --stage 0
`;

async function main(): Promise<void> {
  const workflowGroup = process.argv[2];
  if (["stage", "deliverable", "exception"].includes(workflowGroup)) {
    process.exit(await runWorkflowCommand(workflowGroup, process.argv.slice(3)));
  }
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      json: { type: "boolean" },
      force: { type: "boolean", short: "f" },
      "non-interactive": { type: "boolean" },
      "project-id": { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      ecosystem: { type: "string" },
      language: { type: "string" },
      profile: { type: "string" },
      mode: { type: "string" },
      milestone: { type: "string" },
      stack: { type: "string" },
      "stacks-dir": { type: "string" },
      cwd: { type: "string" },
      gate: { type: "string" },
      operator: { type: "string" },
      stage: { type: "string" },
      reviewer: { type: "string" },
      "authorized-by": { type: "string" },
      role: { type: "string" },
      reason: { type: "string" },
      signature: { type: "string" },
      conditions: { type: "string" },
      reject: { type: "boolean" },
      "confirmation-phrase": { type: "string" },
      check: { type: "string" },
      headless: { type: "boolean" },
      "fail-fast": { type: "boolean" },
      "halt-on-failure": { type: "boolean" },
      all: { type: "boolean" },
      "hooks-dir": { type: "string" },
      "dry-run": { type: "boolean" },
      "allow-inert": { type: "boolean" },
      provider: { type: "string" },
      output: { type: "string" },
      file: { type: "string" },
      path: { type: "string" },
      raw: { type: "string" },
      summary: { type: "boolean" },
      category: { type: "string" },
      strict: { type: "boolean" },
      format: { type: "string" },
      rule: { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.version) {
    console.log(`@ai-engineering-playbook/cli v${CLI_VERSION} (Playbook Standard v${PLAYBOOK_VERSION})`);
    process.exit(0);
  }

  const command = positionals[0];

  if (values.help || !command || command === "help") {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (command === "inspect") {
    const res = runInspect({
      cwd: values.cwd as string | undefined,
      json: Boolean(values.json),
    });

    process.exit(res.exitCode);
  }

  if (command === "verify-evidence") {
    const res = runVerifyEvidence({
      cwd: values.cwd as string | undefined,
      json: Boolean(values.json),
    });

    process.exit(res.exitCode);
  }

  if (command === "lint") {
    const res = await runLint({
      cwd: values.cwd as string | undefined,
      category: values.category as string | undefined,
      rule: values.rule as string | undefined,
      format: values.format as string | undefined,
      json: Boolean(values.json),
      strict: Boolean(values.strict),
    });

    process.exit(res.exitCode);
  }

  if (command === "init") {
    const res = await runInit({
      cwd: values.cwd as string | undefined,
      projectId: values["project-id"] as string | undefined,
      name: values.name as string | undefined,
      description: values.description as string | undefined,
      ecosystem: values.ecosystem as string | undefined,
      language: values.language as string | undefined,
      profile: values.profile as GovernanceProfile | undefined,
      approvalMode: values.mode as ApprovalMode | undefined,
      milestone: values.milestone as string | undefined,
      stack: values.stack as string | undefined,
      force: Boolean(values.force),
      nonInteractive: Boolean(values["non-interactive"]),
    });

    if (!res.success) {
      console.error(`\nError: ${res.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (command === "validate") {
    const target = positionals[1] as "manifest" | "state" | "all" | undefined;
    const res = runValidate({
      cwd: values.cwd as string | undefined,
      target,
    });

    if (!res.success) {
      process.exit(1);
    }
    process.exit(0);
  }

  if (command === "approve") {
    const gateStr = values.gate as string | undefined;
    const gate = gateStr !== undefined ? parseInt(gateStr, 10) : undefined;
    const res = await runApprove({
      cwd: values.cwd as string | undefined,
      gate,
      reviewer: values.reviewer as string | undefined,
      role: values.role as string | undefined,
      mode: values.mode as ApprovalMode | undefined,
      signature: values.signature as string | undefined,
      conditions: values.conditions as string | undefined,
      reject: Boolean(values.reject),
      confirmationPhrase: values["confirmation-phrase"] as string | undefined,
      nonInteractive: Boolean(values["non-interactive"]),
      json: Boolean(values.json),
    });

    process.exit(res.exitCode);
  }

  if (command === "advance") {
    const res = await runAdvance({
      cwd: values.cwd as string | undefined,
      json: Boolean(values.json),
    });

    process.exit(res.exitCode);
  }

  if (command === "reopen") {
    const stageStr = values.stage as string | undefined;
    const stage = stageStr !== undefined ? parseInt(stageStr, 10) : undefined;
    const res = await runReopen({
      cwd: values.cwd as string | undefined,
      milestone: values.milestone as string | undefined,
      name: values.name as string | undefined,
      stage,
      reason: values.reason as string | undefined,
      authorizedBy: values["authorized-by"] as string | undefined,
      role: values.role as string | undefined,
      confirmationPhrase: values["confirmation-phrase"] as string | undefined,
      nonInteractive: Boolean(values["non-interactive"]),
      json: Boolean(values.json),
    });

    process.exit(res.exitCode);
  }

  if (command === "pivot") {
    const stageStr = values.stage as string | undefined;
    const stage = stageStr !== undefined ? parseInt(stageStr, 10) : undefined;
    const res = await runPivot({
      cwd: values.cwd as string | undefined,
      stage,
      authorizedBy: values["authorized-by"] as string | undefined,
      role: values.role as string | undefined,
      reason: values.reason as string | undefined,
      confirmationPhrase: values["confirmation-phrase"] as string | undefined,
      nonInteractive: Boolean(values["non-interactive"]),
      json: Boolean(values.json),
    });

    process.exit(res.exitCode);
  }

  if (command === "gate") {
    const action = positionals[1];
    const stageStr = values.stage as string | undefined;
    const stage = stageStr !== undefined ? parseInt(stageStr, 10) : undefined;

    if (action === "list") {
      const res = runGateList({
        cwd: values.cwd as string | undefined,
        stage,
        all: Boolean(values.all),
        json: Boolean(values.json),
      });
      process.exit(res.exitCode);
    }

    if (action === "run") {
      const res = await runGateRun({
        cwd: values.cwd as string | undefined,
        stage,
        checkId: values.check as string | undefined,
        headless: Boolean(values.headless),
        failFast: Boolean(values["fail-fast"]),
        haltOnFailure: Boolean(values["halt-on-failure"]),
        json: Boolean(values.json),
        profile: values.profile as GovernanceProfile | undefined,
      });
      process.exit(res.exitCode);
    }

    if (action === "verify") {
      const res = runGateVerify({
        cwd: values.cwd as string | undefined,
        stage,
        json: Boolean(values.json),
      });
      process.exit(res.exitCode);
    }

    if (action === "recover") {
      const res = await runGateRecover({
        cwd: values.cwd as string | undefined,
        stage,
        operator: (values.operator || values["authorized-by"] || values.reviewer) as string | undefined,
        role: values.role as string | undefined,
        reason: values.reason as string | undefined,
        confirmationPhrase: values["confirmation-phrase"] as string | undefined,
        nonInteractive: Boolean(values["non-interactive"]),
        json: Boolean(values.json),
      });
      process.exit(res.exitCode);
    }

    console.error(
      `Error: Invalid gate action "${action || ""}".\nAvailable actions:\n  playbook gate list\n  playbook gate run\n  playbook gate verify\n  playbook gate recover`
    );
    process.exit(2);
  }

  if (command === "hook") {
    const action = positionals[1];
    const hooksDir = values["hooks-dir"] as string | undefined;

    if (action === "install") {
      const res = runHookInstall({
        cwd: values.cwd as string | undefined,
        hooksDir,
        dryRun: Boolean(values["dry-run"]),
        force: Boolean(values.force),
        allowInert: Boolean(values["allow-inert"]),
        json: Boolean(values.json),
      });
      process.exit(res.exitCode);
    }

    if (action === "status") {
      const res = runHookStatus({
        cwd: values.cwd as string | undefined,
        hooksDir,
        json: Boolean(values.json),
      });
      process.exit(res.exitCode);
    }

    if (action === "uninstall") {
      const res = runHookUninstall({
        cwd: values.cwd as string | undefined,
        hooksDir,
        force: Boolean(values.force),
        json: Boolean(values.json),
      });
      process.exit(res.exitCode);
    }

    if (action === "run") {
      const hookType = positionals[2];
      const rawArgs = positionals.slice(3);
      const allowInert = Boolean(values["allow-inert"]) || rawArgs.includes("--allow-inert");
      const args = rawArgs.filter((a) => a !== "--allow-inert");

      let stdinContent: string | undefined;
      if (!process.stdin.isTTY) {
        try {
          stdinContent = fs.readFileSync(0, "utf-8");
        } catch {
          stdinContent = undefined;
        }
      }

      const res = await runHookRun({
        cwd: values.cwd as string | undefined,
        hookType,
        args,
        stdin: stdinContent,
        allowInert,
      });
      process.exit(res.exitCode);
    }

    console.error(
      `Error: Invalid hook action "${action || ""}".\nAvailable actions:\n  playbook hook install\n  playbook hook status\n  playbook hook uninstall`
    );
    process.exit(2);
  }

  if (command === "ci") {
    const action = positionals[1];

    if (action === "init") {
      const res = runCiInit({
        cwd: values.cwd as string | undefined,
        provider: values.provider as string | undefined,
        output: (values.output || values.file || values.path) as string | undefined,
        force: Boolean(values.force),
        dryRun: Boolean(values["dry-run"]),
        json: Boolean(values.json),
      });
      process.exit(res.exitCode);
    }

    if (action === "validate") {
      const res = runCiValidate({
        cwd: values.cwd as string | undefined,
        provider: values.provider as string | undefined,
        file: (values.file || values.path || values.output) as string | undefined,
        json: Boolean(values.json),
      });
      process.exit(res.exitCode);
    }

    if (action === "status") {
      const res = runCiStatus({
        cwd: values.cwd as string | undefined,
        provider: values.provider as string | undefined,
        file: (values.file || values.path || values.output) as string | undefined,
        json: Boolean(values.json),
      });
      process.exit(res.exitCode);
    }

    if (action === "report") {
      const res = runCiReport({
        cwd: values.cwd as string | undefined,
        output: (values.output || values.file || values.path) as string | undefined,
        raw: values.raw as string | undefined,
        summary: values.summary !== false,
        json: Boolean(values.json),
      });
      process.exit(res.exitCode);
    }

    console.error(
      `Error: Invalid ci action "${action || ""}".\nAvailable actions:\n  playbook ci init\n  playbook ci validate\n  playbook ci status\n  playbook ci report`
    );
    process.exit(2);
  }

  if (command === "recover") {
    const stageStr = values.stage as string | undefined;
    const stage = stageStr !== undefined ? parseInt(stageStr, 10) : undefined;
    const res = await runGateRecover({
      cwd: values.cwd as string | undefined,
      stage,
      operator: (values.operator || values["authorized-by"] || values.reviewer) as string | undefined,
      role: values.role as string | undefined,
      reason: values.reason as string | undefined,
      confirmationPhrase: values["confirmation-phrase"] as string | undefined,
      nonInteractive: Boolean(values["non-interactive"]),
      json: Boolean(values.json),
    });
    process.exit(res.exitCode);
  }

  if (command === "stack") {
    const action = positionals[1];

    if (action === "list" || !action) {
      const res = runStackList({
        json: Boolean(values.json),
        stacksDir: values["stacks-dir"] as string | undefined,
      });
      process.exit(res.exitCode);
    }

    if (action === "apply") {
      const targetStack = positionals[2] || (values.stack as string | undefined);
      if (!targetStack) {
        console.error("Error: Missing required stack identifier.\nUsage: playbook stack apply <name> [--force]");
        process.exit(2);
      }
      const res = runStackApply(targetStack, {
        cwd: values.cwd as string | undefined,
        force: Boolean(values.force),
        json: Boolean(values.json),
        stacksDir: values["stacks-dir"] as string | undefined,
      });
      process.exit(res.exitCode);
    }

    if (action === "compose") {
      const targetStack = positionals[2] || (values.stack as string | undefined);
      const res = runStackCompose({
        cwd: values.cwd as string | undefined,
        json: Boolean(values.json),
        stacksDir: values["stacks-dir"] as string | undefined,
        stacks: targetStack ? [targetStack] : undefined,
      });
      process.exit(res.exitCode);
    }

    console.error(
      `Error: Invalid stack action "${action}".\nAvailable actions:\n  playbook stack list\n  playbook stack apply <name>\n  playbook stack compose`
    );
    process.exit(2);
  }

  console.error(`Error: Unknown command "${command}".\nRun "playbook --help" for available commands.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
