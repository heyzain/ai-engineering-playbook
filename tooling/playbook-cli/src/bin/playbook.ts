#!/usr/bin/env node

import { parseArgs } from "node:util";
import { PLAYBOOK_VERSION } from "../constants.js";
import { runInit } from "../commands/init.js";
import { runValidate } from "../commands/validate.js";
import { runInspect } from "../commands/inspect.js";
import { runVerifyEvidence } from "../commands/verify-evidence.js";
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
  help              Show this help message

Options:
  -h, --help              Show help message
  -v, --version           Show CLI and Playbook standard versions
  --json                  Output machine-readable JSON (inspect, verify-evidence)
  -f, --force             Overwrite existing governance files (init command)
  --non-interactive       Execute without interactive terminal prompts
  --project-id <id>       Kebab-case project identifier (e.g. 'my-app')
  --name <name>           Human-readable project display name
  --description <desc>    Project description
  --ecosystem <eco>       Primary ecosystem (node, python, go, rust, java, agnostic)
  --language <lang>       Primary language (typescript, python, go, rust, agnostic)
  --profile <profile>     Governance profile (strict, standard, lightweight)
  --mode <mode>           Approval mode (solo, team)
  --milestone <id>        Milestone identifier (e.g. 'M-1.0.0')
  --cwd <path>            Target directory (defaults to current working directory)

Examples:
  # Inspect project governance state (human-readable)
  playbook inspect

  # Inspect project state as machine-readable JSON
  playbook inspect --json

  # Interactive project initialization
  playbook init

  # Non-interactive headless initialization with defaults
  playbook init --non-interactive --project-id my-service --name "My Service"

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

  console.error(`Error: Unknown command "${command}".\nRun "playbook --help" for available commands.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
