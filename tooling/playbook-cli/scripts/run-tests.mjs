import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Explicit paths avoid shell-specific glob expansion and work on Node 18+.
const root = fileURLToPath(new URL("../", import.meta.url));
function collect(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap(entry => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? collect(target) : entry.isFile() && entry.name.endsWith(".test.js") ? [target] : [];
    })
    .sort();
}
const files = collect("dist/tests");
if (files.length === 0) throw new Error("No compiled tests found; run npm run build.");
console.log(`Running ${files.length} compiled test files with process isolation.`);
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
if (result.error) {
  console.error(`Test runner could not start: ${result.error.message}`);
}
process.exitCode = result.status ?? 1;
