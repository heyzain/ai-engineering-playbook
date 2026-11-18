import { parseArgs } from "node:util";
import path from "node:path";
import { startStage, submitStage } from "../core/controller/stage-controller.js";
import { recordDeliverable, recordEvidence } from "../core/controller/deliverable-controller.js";
import type { StageNumber } from "../constants.js";
import readline from "node:readline/promises";
import { assertRatificationTerminal } from "../core/ratification.js";
import { executeExceptionAction, migrateLocalExceptions, previewExceptionAction, previewLocalMigration } from "../core/controller/exception-service.js";
type WorkflowResult = {
    success: true;
    operation: string;
    data: unknown;
} | {
    success: false;
    operation: string;
    error: {
        code: string;
        message: string;
    };
};
export interface WorkflowExecution {
    exitCode: number;
    result: WorkflowResult;
    json: boolean;
}
const HELP = "stage start [--stage N]; stage submit [--stage N --package PATH]; deliverable record --id ID --artifact PATH [--status in_progress|completed]; deliverable evidence --id ID --type TYPE --result passed|failed|inconclusive --evidence PATH --procedure TEXT [--remediation ID]. exception migrate [--ratification-root PATH]; exception propose --id DELIVERABLE_ID --document PATH; exception approve|revoke|remediation-start|remediate --id EXC_ID. Revoke requires --reason TEXT. Migrate/approve/revoke require an actual operator terminal. Common: --cwd PATH --json --help.";
class InvocationError extends Error {
}
const CHECK_TYPES = ["automated_test", "build_typecheck", "static_analysis", "schema_validation", "security_audit", "manual_functional", "visual_review", "accessibility_audit", "architecture_review"];
/** Agent-safe command adapter: core services own mutations; parser never writes state. */
export async function executeWorkflowCommand(group: string, args: string[]): Promise<WorkflowExecution> {
    let json = args.includes("--json"), operation = group;
    try {
        let parsed;
        try {
            parsed = parseArgs({
                args, allowPositionals: true, strict: true, options: {
                    cwd: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" }, stage: { type: "string" }, package: { type: "string" },
                    id: { type: "string" }, artifact: { type: "string" }, status: { type: "string" }, name: { type: "string" }, description: { type: "string" },
                    type: { type: "string" }, result: { type: "string" }, evidence: { type: "string" }, procedure: { type: "string" }, summary: { type: "string" },
                    requirement: { type: "string" }, "exit-code": { type: "string" }, commit: { type: "string" }, document: { type: "string" },
                    remediation: { type: "string" }, operator: { type: "string" }, role: { type: "string" }, reason: { type: "string" }, "ratification-root": { type: "string" },
                    check: { type: "string" }, "tool-version": { type: "string" },
                }
            });
        }
        catch (error) {
            throw new InvocationError(error instanceof Error ? error.message : String(error));
        }
        const { values: v, positionals } = parsed;
        json = Boolean(v.json);
        if (v.help)
            return { exitCode: 0, json, result: { success: true, operation: `${group} help`, data: { usage: HELP } } };
        if (positionals.length !== 1)
            throw new InvocationError("Exactly one action is required.");
        const action = positionals[0];
        operation = `${group} ${action}`;
        const allowed: Record<string, string[]> = {
            "stage start": ["stage"], "stage submit": ["stage", "package"],
            "deliverable record": ["id", "artifact", "status", "name", "description"],
            "deliverable evidence": ["id", "type", "result", "evidence", "procedure", "summary", "requirement", "exit-code", "commit", "remediation", "check", "tool-version"],
            "exception migrate": ["ratification-root", "operator", "role"],
            "exception propose": ["id", "document"], "exception approve": ["id", "operator", "role"], "exception revoke": ["id", "reason", "operator", "role"],
            "exception remediation-start": ["id"], "exception remediate": ["id"]
        };
        if (!allowed[operation])
            throw new InvocationError("Unsupported action. " + HELP);
        for (const key of Object.keys(v))
            if (!["cwd", "json", "help", ...allowed[operation]].includes(key))
                throw new InvocationError(`Flag --${key} is not allowed for ${operation}.`);
        for (const [key, value] of Object.entries(v))
            if (typeof value === "string" && !value.trim())
                throw new InvocationError(`--${key} requires a non-empty value.`);
        const required = (key: keyof typeof v): string => { const value = v[key]; if (typeof value !== "string" || !value.trim())
            throw new InvocationError(`--${key} requires a non-empty value.`); return value; };
        if (v.cwd !== undefined)
            required("cwd");
        let stage: StageNumber | undefined;
        if (v.stage !== undefined) {
            if (!/^[0-6]$/.test(v.stage))
                throw new InvocationError("--stage must be an integer from 0 to 6.");
            stage = Number(v.stage) as StageNumber;
        }
        const base = { targetDir: path.resolve(v.cwd || process.cwd()), actor: "agent:cli", actorType: "agent" as const };
        let data: unknown;
        if (group === "exception") {
            if (action === "migrate" || action === "approve" || action === "revoke") {
                assertRatificationTerminal();
                const id = action === "migrate" ? undefined : required("id");
                const preview = action === "migrate" ? previewLocalMigration(base.targetDir, v["ratification-root"]) : previewExceptionAction(base.targetDir, id!, action);
                if (action === "revoke")
                    required("reason");
                console.error(JSON.stringify({ operation, target: base.targetDir, review: preview, assurance: "Operator-attested local only; no Level B/remote authority" }, null, 2));
                const phrase = action === "migrate" ? "CONFIRM MIGRATION LOCAL EXCEPTIONS" : `CONFIRM ${action === "approve" ? "AUTHORIZE" : "REVOKE"} ${id}`;
                const prompts = readline.createInterface({ input: process.stdin, output: process.stderr });
                let operator: string, role: string, confirmation: string;
                try {
                    operator = v.operator || (await prompts.question("Operator name: ")).trim();
                    role = v.role || (await prompts.question("Declared authority (Lead Architect): ")).trim();
                    confirmation = await prompts.question(`Type ${phrase}: `);
                }
                finally {
                    prompts.close();
                }
                data = action === "migrate" ? await migrateLocalExceptions(base.targetDir, v["ratification-root"], operator, role, confirmation, preview.fingerprint) :
                    await executeExceptionAction({ targetDir: base.targetDir, action, id: id!, operator, role, confirmation, reason: v.reason, reviewedFingerprint: preview.fingerprint });
            }
            else if (action === "propose") {
                const document = required("document"), id = path.basename(document, ".md");
                data = await executeExceptionAction({ targetDir: base.targetDir, action, id, targetId: required("id"), documentPath: document });
            }
            else
                data = await executeExceptionAction({ targetDir: base.targetDir, action: action as "remediation-start" | "remediate", id: required("id") });
        }
        else if (operation === "stage start")
            data = await startStage({ ...base, stage });
        else if (operation === "stage submit")
            data = await submitStage({ ...base, stage, packagePath: v.package, strict: true });
        else if (operation === "deliverable record") {
            if (v.status !== undefined && v.status !== "in_progress" && v.status !== "completed")
                throw new InvocationError("--status must be in_progress or completed.");
            data = await recordDeliverable({ ...base, deliverableId: required("id"), artifactPath: required("artifact"), status: v.status as "in_progress" | "completed" | undefined, name: v.name, description: v.description });
        }
        else {
            const type = required("type"), result = required("result");
            if (!CHECK_TYPES.includes(type))
                throw new InvocationError("Unsupported --type.");
            if (!["passed", "failed", "inconclusive"].includes(result))
                throw new InvocationError("Unsupported --result.");
            let exitCode: number | undefined;
            if (v["exit-code"] !== undefined) {
                if (!/^-?\d+$/.test(v["exit-code"]))
                    throw new InvocationError("--exit-code must be an integer.");
                exitCode = Number(v["exit-code"]);
                if (!Number.isSafeInteger(exitCode))
                    throw new InvocationError("--exit-code exceeds safe integer range.");
            }
            if (v.commit !== undefined && !/^[a-f0-9]{40}$/.test(v.commit))
                throw new InvocationError("--commit must be a full lowercase Git SHA-1.");
            data = await recordEvidence({ ...base, deliverableId: required("id"), type, result: result as "passed" | "failed" | "inconclusive", evidenceRef: required("evidence"), procedure: required("procedure"), summary: v.summary, requirementId: v.requirement, exitCode, commitSha: v.commit, remediationRef: v.remediation, checkId: v.check, toolVersion: v["tool-version"] });
        }
        return { exitCode: 0, json, result: { success: true, operation, data } };
    }
    catch (error) {
        const code = error instanceof InvocationError ? "INVALID_ARGUMENTS" : typeof (error as {
            code?: unknown;
        })?.code === "string" ? (error as {
            code: string;
        }).code : (error instanceof Error ? error.message.match(/^([A-Z_]+):/)?.[1] : undefined) || "WORKFLOW_FAILED";
        return { exitCode: error instanceof InvocationError ? 2 : 1, json, result: { success: false, operation, error: { code, message: error instanceof Error ? error.message : String(error) } } };
    }
}
export async function runWorkflowCommand(group: string, args: string[]): Promise<number> {
    const execution = await executeWorkflowCommand(group, args);
    if (execution.json)
        console.log(JSON.stringify(execution.result));
    else if (execution.result.success)
        console.log(`${execution.result.operation}: success\n${JSON.stringify(execution.result.data, null, 2)}`);
    else
        console.error(`[${execution.result.error.code}] ${execution.result.error.message}`);
    return execution.exitCode;
}
