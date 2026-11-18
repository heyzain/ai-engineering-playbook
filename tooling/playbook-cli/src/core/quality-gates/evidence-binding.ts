import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ProjectManifest } from "../../types/manifest.js";
import type { QualityGateCheck } from "../../types/quality-gates.js";
import { resolveExecutable } from "../process-execution.js";
const digest = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** Tokenize the configured version probe without shell evaluation or expansion. */
export function parseToolVersionCommand(command: string): string[] {
    const tokens: string[] = [];
    let token = "", quote = "", started = false;
    for (const character of command) {
        if (quote) {
            if (character === quote) quote = "";
            else token += character;
        } else if (character === '"' || character === "'") {
            quote = character;
            started = true;
        } else if (/\s/.test(character)) {
            if (started) tokens.push(token);
            token = "";
            started = false;
        } else {
            token += character;
            started = true;
        }
    }
    if (quote) throw new Error("TOOL_VERSION_COMMAND_INVALID: Unclosed quote.");
    if (started) tokens.push(token);
    if (!tokens[0]) throw new Error("TOOL_VERSION_COMMAND_INVALID: Missing executable.");
    return tokens;
}
export function configurationFingerprint(root: string, manifest: ProjectManifest): string {
    return digest(JSON.stringify({
        config: fs.readFileSync(path.join(root, ".playbook/quality-gates.json"), "utf8"),
        project: manifest.project_id, profile: manifest.playbook.governance_profile, mode: manifest.playbook.approval_mode,
        stacks: manifest.technology_stacks || [], technology: manifest.tech_stack, paths: manifest.paths, capabilities: manifest.capabilities
    }));
}
/** Hash the resolved tool and explicit entry scripts, without executing a command. */
export function toolFingerprint(root: string, check: QualityGateCheck): string {
    const commands = [[check.command, ...check.args]];
    if (check.tool_version_command)
        commands.push(parseToolVersionCommand(check.tool_version_command));
    const bindings = commands.map((command, index) => {
        const cwd = index === 0 && check.working_dir ? path.resolve(root, check.working_dir) : root;
        const env = { ...process.env, ...(index === 0 ? check.env : {}) } as Record<string, string>;
        if (env.Path && !env.PATH) env.PATH = env.Path;
        const resolved = resolveExecutable(command[0], command.slice(1), { cwd, env });
        let executable = resolved.file;
        if (!path.isAbsolute(executable)) {
            const match = (env.PATH || "").split(path.delimiter).map(dir => path.join(dir, executable)).find(f => fs.existsSync(f));
            if (!match)
                throw new Error(`TOOL_FINGERPRINT_UNAVAILABLE: ${executable}`);
            executable = match;
        }
        const files = [executable, ...resolved.args.filter(arg => {
            if (arg.startsWith("-") || /[*?\[\]{}]/.test(arg)) return false;
            const candidate = path.resolve(cwd, arg);
            return /\.(?:[cm]?js|py|cmd|ps1)$/i.test(arg) || (fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        }).map(arg => path.resolve(cwd, arg))];
        return files.map(file => [fs.realpathSync(file), digest(fs.readFileSync(file))]);
    });
    return digest(JSON.stringify(bindings));
}
