import fs from "node:fs";
import { TransactionLockManager } from "../../src/core/lock/lock-manager.js";

async function main() {
  const args = process.argv.slice(2);
  let targetDir = "";
  let id = "";
  let holdMs = 100;
  let logFile = "";
  let timeoutMs = 10000;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--targetDir" && i + 1 < args.length) {
      targetDir = args[++i];
    } else if (args[i] === "--id" && i + 1 < args.length) {
      id = args[++i];
    } else if (args[i] === "--holdMs" && i + 1 < args.length) {
      holdMs = parseInt(args[++i], 10);
    } else if (args[i] === "--logFile" && i + 1 < args.length) {
      logFile = args[++i];
    } else if (args[i] === "--timeoutMs" && i + 1 < args.length) {
      timeoutMs = parseInt(args[++i], 10);
    }
  }

  if (!targetDir || !id || !logFile) {
    process.stderr.write("Usage: lock-worker --targetDir <dir> --id <id> --logFile <file> [--holdMs <ms>] [--timeoutMs <ms>]\n");
    process.exit(2);
  }

  const appendLog = (event: string, extra?: Record<string, unknown>) => {
    const entry = JSON.stringify({ id, event, timestamp: Date.now(), pid: process.pid, ...extra }) + "\n";
    fs.appendFileSync(logFile, entry, "utf-8");
  };

  const lockManager = new TransactionLockManager({ targetDir, timeoutMs });

  try {
    appendLog("competing");
    const lock = await lockManager.acquire({ timeoutMs });
    appendLog("acquired", { nonce: lock.nonce });

    await new Promise((resolve) => setTimeout(resolve, holdMs));

    appendLog("releasing", { nonce: lock.nonce });
    await lock.release();
    appendLog("released", { nonce: lock.nonce });
    process.exit(0);
  } catch (err: unknown) {
    appendLog("error", { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

main();
