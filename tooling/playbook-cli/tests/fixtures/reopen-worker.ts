import { runReopen } from "../../src/commands/reopen.js";
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
  let milestone: string | undefined;
  let name: string | undefined;
  let stage: number | undefined;
  let reason: string | undefined;
  let authorizedBy: string | undefined;
  let role: string | undefined;
  let confirmationPhrase: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cwd" && i + 1 < args.length) {
      cwd = args[++i];
    } else if (args[i] === "--milestone" && i + 1 < args.length) {
      milestone = args[++i];
    } else if (args[i] === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (args[i] === "--stage" && i + 1 < args.length) {
      stage = parseInt(args[++i], 10);
    } else if (args[i] === "--reason" && i + 1 < args.length) {
      reason = args[++i];
    } else if (args[i] === "--authorized-by" && i + 1 < args.length) {
      authorizedBy = args[++i];
    } else if (args[i] === "--role" && i + 1 < args.length) {
      role = args[++i];
    } else if (args[i] === "--confirmation-phrase" && i + 1 < args.length) {
      confirmationPhrase = args[++i];
    } else if (args[i] === "--json") {
      json = true;
    }
  }

  const res = await runReopen({
    cwd,
    milestone,
    name,
    stage,
    reason: reason ?? "Maintenance and performance improvements",
    authorizedBy: authorizedBy ?? "Alice Human",
    role: role ?? "Lead Architect",
    confirmationPhrase,
    isTTY: true,
    json,
    prompter: new WorkerPrompter(),
  });

  if (!res.success) {
    if (json) {
      process.stderr.write(JSON.stringify(res) + "\n");
    } else {
      process.stderr.write((res.message || res.error || "Reopen failed") + "\n");
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
  console.error("Reopen worker error:", err);
  process.exit(1);
});
