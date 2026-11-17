import path from "node:path";
import fs from "node:fs";

export interface ResolvedCommand {
  file: string;
  args: string[];
}

export interface ResolveExecutableOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Searches standard system and Node.js installation layouts to locate
 * the authoritative JavaScript entrypoint for npm or npx.
 */
export function findNpmCliScript(binName: "npm" | "npx"): string | null {
  const cliScript = binName === "npx" ? "npx-cli.js" : "npm-cli.js";
  const nodeDir = path.dirname(process.execPath);

  // Layout 1: Windows official installer, nvm-windows, portable zip:
  // <nodeDir>/node_modules/npm/bin/<cliScript>
  const candidate1 = path.join(nodeDir, "node_modules", "npm", "bin", cliScript);
  if (fs.existsSync(candidate1)) {
    return candidate1;
  }

  // Layout 2: POSIX standard layout (/usr/bin/node -> /usr/lib/node_modules/npm/bin/<cliScript>
  // or /usr/local/bin/node -> /usr/local/lib/node_modules/npm/bin/<cliScript>)
  const candidate2 = path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", cliScript);
  if (fs.existsSync(candidate2)) {
    return candidate2;
  }

  // Layout 3: Direct lib sibling (<nodeDir>/lib/node_modules/npm/bin/<cliScript>)
  const candidate3 = path.join(nodeDir, "lib", "node_modules", "npm", "bin", cliScript);
  if (fs.existsSync(candidate3)) {
    return candidate3;
  }

  // Layout 4: Resolvable module inside active node_modules tree
  try {
    const resolved = require.resolve(`npm/bin/${cliScript}`);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // ignore
  }

  // Layout 5: Windows roaming AppData npm directory
  if (process.platform === "win32" && process.env.APPDATA) {
    const candidate5 = path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", cliScript);
    if (fs.existsSync(candidate5)) {
      return candidate5;
    }
  }

  return null;
}

/**
 * Resolves a command and its argument vector for secure, cross-platform subprocess spawning.
 *
 * Security and Portability Invariants:
 * 1. NEVER invokes a shell (`shell: false`). Arguments are strictly preserved as an array
 *    of discrete strings, preventing command concatenation and shell injection (CWE-78).
 * 2. On Windows, Node-bundled CLI tools (npm, npx) are executed via `process.execPath`
 *    pointing directly to the underlying CLI script, completely avoiding Windows batch file
 *    spawning restrictions (CVE-2024-27980, spawn EINVAL / ENOENT).
 * 3. On Windows, commands without file extensions are checked against PATHEXT and resolved to .exe.
 * 4. On POSIX platforms, standard commands pass through to POSIX execve while benefiting from
 *    Node entrypoint resolution for npm/npx if present.
 */
export function resolveExecutable(
  command: string,
  args: string[] = [],
  options: ResolveExecutableOptions = {}
): ResolvedCommand {
  const trimmed = command.trim();

  // 1. Explicit node invocation -> use current runtime executable
  if (trimmed === "node" || trimmed === "node.exe") {
    return {
      file: process.execPath,
      args: [...args],
    };
  }

  // 2. npm or npx -> resolve to Node running the entrypoint script
  if (trimmed === "npm" || trimmed === "npx" || trimmed === "npm.cmd" || trimmed === "npx.cmd") {
    const binName = trimmed.startsWith("npx") ? "npx" : "npm";
    const cliScript = findNpmCliScript(binName);
    if (cliScript) {
      return {
        file: process.execPath,
        args: [cliScript, ...args],
      };
    }
    // Fallback if script not found (e.g. customized container packaging)
    return {
      file: trimmed,
      args: [...args],
    };
  }

  // 3. Local node_modules TypeScript compiler check (e.g. command: "tsc")
  if (trimmed === "tsc" && options.cwd) {
    const localTsc = path.join(options.cwd, "node_modules", "typescript", "bin", "tsc");
    if (fs.existsSync(localTsc)) {
      return {
        file: process.execPath,
        args: [localTsc, ...args],
      };
    }
  }

  // 4. Windows executable resolution with PATH and PATHEXT
  if (process.platform === "win32") {
    const hasExt = path.extname(trimmed).length > 0;

    // Relative or absolute path
    if (path.isAbsolute(trimmed) || trimmed.includes(path.sep) || trimmed.includes("/")) {
      const resolvedPath = path.resolve(options.cwd || process.cwd(), trimmed);
      if (hasExt && fs.existsSync(resolvedPath)) {
        return { file: resolvedPath, args: [...args] };
      }
      for (const ext of getWindowsPathExt(options.env)) {
        const candidate = resolvedPath + ext;
        if (fs.existsSync(candidate)) {
          return { file: candidate, args: [...args] };
        }
      }
      return { file: trimmed, args: [...args] };
    }

    // Lookup in PATH
    const pathEnv =
      (options.env && (options.env.PATH || options.env.Path)) ||
      process.env.PATH ||
      process.env.Path ||
      "";
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);
    const exts = getWindowsPathExt(options.env);

    for (const dir of dirs) {
      if (hasExt) {
        const candidate = path.join(dir, trimmed);
        if (fs.existsSync(candidate)) {
          return { file: candidate, args: [...args] };
        }
      } else {
        for (const ext of exts) {
          const candidate = path.join(dir, trimmed + ext);
          if (fs.existsSync(candidate)) {
            return { file: candidate, args: [...args] };
          }
        }
      }
    }
  }

  return {
    file: trimmed,
    args: [...args],
  };
}

function getWindowsPathExt(env?: Record<string, string>): string[] {
  const pathext = (env && (env.PATHEXT || env.Pathext)) || process.env.PATHEXT || process.env.Pathext || ".COM;.EXE;.BAT;.CMD";
  return pathext
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
