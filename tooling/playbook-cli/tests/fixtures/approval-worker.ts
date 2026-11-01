import path from "node:path";
import { runApprove } from "../../src/commands/approve.js";
import type { ApprovalMode } from "../../src/constants.js";
import type { PromptInterface } from "../../src/utils/prompt.js";

class WorkerPrompter implements PromptInterface {
  async ask(_question: string, defaultValue?: string): Promise<string> {
    return defaultValue || "";
  }
  async confirm(_question: string, defaultYes = false): Promise<boolean> {
    return defaultYes;
  }
  async select<T extends string>(_question: string, _options: readonly T[], defaultValue: T): Promise<T> {
    return defaultValue;
  }
  close(): void {}
}

async function main() {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  let gate: number | undefined;
  let reviewer: string | undefined;
  let role: string | undefined;
  let mode: ApprovalMode | undefined;
  let signature: string | undefined;
  let conditions: string | undefined;
  let reject = false;
  let confirmationPhrase: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd" && i + 1 < args.length) {
      cwd = args[++i];
    } else if (args[i] === "--gate" && i + 1 < args.length) {
      gate = parseInt(args[++i], 10);
    } else if (args[i] === "--reviewer" && i + 1 < args.length) {
      reviewer = args[++i];
    } else if (args[i] === "--role" && i + 1 < args.length) {
      role = args[++i];
    } else if (args[i] === "--mode" && i + 1 < args.length) {
      mode = args[++i] as ApprovalMode;
    } else if (args[i] === "--signature" && i + 1 < args.length) {
      signature = args[++i];
    } else if (args[i] === "--conditions" && i + 1 < args.length) {
      conditions = args[++i];
    } else if (args[i] === "--reject") {
      reject = true;
    } else if (args[i] === "--confirmation-phrase" && i + 1 < args.length) {
      confirmationPhrase = args[++i];
    } else if (args[i] === "--json") {
      json = true;
    }
  }

  const res = await runApprove({
    cwd,
    gate,
    reviewer,
    role: role || "Lead Architect",
    mode: mode || "solo",
    signature: signature || `Interactive CLI Session ${gate}`,
    conditions: conditions !== undefined ? conditions : reject ? "Mandatory rework required" : "",
    reject,
    confirmationPhrase,
    isTTY: true,
    json,
    prompter: new WorkerPrompter(),
  });

  if (!res.success) {
    if (json) {
      process.stderr.write(JSON.stringify(res) + "\n");
    } else {
      process.stderr.write((res.message || res.error || "Approval failed") + "\n");
    }
    process.exit(res.exitCode || 1);
  }

  if (json) {
    process.stdout.write(JSON.stringify(res) + "\n");
  } else {
    process.stdout.write(res.message + "\n");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Worker error:", err);
  process.exit(1);
});
