#!/usr/bin/env node

import { parseArgs } from "node:util";
import { PLAYBOOK_VERSION } from "../constants.js";
import { runInit } from "../commands/init.js";
import { runValidate } from "../commands/validate.js";
import { runInspect } from "../commands/inspect.js";
import { runVerifyEvidence } from "../commands/verify-evidence.js";
import { runApprove } from "../commands/approve.js";
import { runAdvance } from "../commands/advance.js";
import { runReopen } from "../commands/reopen.js";
import type { GovernanceProfile, ApprovalMode } from "../constants.js";

const CLI_VERSION = "1.0.0";

const HELP_TEXT = `
AI Engineering Playbook CLI (v${CLI_VERSION})
Governance and project lifecycle management for AI-assisted engineering.

Usage:
  playbook <command> [options]

Commands:
  inspect           Inspect project governance state, deliverables, and readiness (read-only)
  verify-evidence   Verify evidence files and SHA-256 integrity hashes (read-only)
  init              Initialize a downstream project with standard manifest and state
  validate          Validate project manifest and state against JSON Schemas
  approve           Interactively review and approve/reject active stage gate (human only)
  advance           Advance to the next lifecycle stage following formal human approval
  reopen            Reopen a completed project lifecycle for maintenance (human only)
  help              Show this help message

Options:
  -h, --help              Show help message
  -v, --version           Show CLI and Playbook standard versions
  --gate <N>              Gate number to review/approve (0 to 6)
  --stage <0|1>           Entry stage for maintenance reopening (0 or 1)
  --reviewer <name>       Claimed human reviewer full name
  --authorized-by <name>  Claimed human authorizer full name (reopen command)
  --role <role>           Engineering role or title
  --reason <text>         Reopening rationale or justification
  --mode <mode>           Approval mode (solo, team)
  --signature <ref>       Signature or review reference (e.g. PR #42)
  --conditions <conds>    Approval conditions or mandatory rework reasons
  --reject                Record formal gate rejection rather than approval
  --json                  Output machine-readable JSON (inspect, verify-evidence, advance, reopen)
  -f, --force             Overwrite existing governance files (init command)
  --non-interactive       Execute without interactive terminal prompts
  --project-id <id>       Kebab-case project identifier (e.g. 'my-app')
  --name <name>           Human-readable project display name
  --description <desc>    Project description
  --ecosystem <eco>       Primary ecosystem (node, python, go, rust, java, agnostic)
  --language <lang>       Primary language (typescript, python, go, rust, agnostic)
  --profile <profile>     Governance profile (strict, standard, lightweight)
  --milestone <id>        Milestone identifier (e.g. 'M-1.0.0')
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
`;

async function main(): Promise<void> {
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
      cwd: { type: "string" },
      gate: { type: "string" },
      stage: { type: "string" },
      reviewer: { type: "string" },
      "authorized-by": { type: "string" },
      role: { type: "string" },
      reason: { type: "string" },
      signature: { type: "string" },
      conditions: { type: "string" },
      reject: { type: "boolean" },
      "confirmation-phrase": { type: "string" },
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

  console.error(`Error: Unknown command "${command}".\nRun "playbook --help" for available commands.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
