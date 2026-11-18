import { removeTempFixture } from "./fixtures/temp.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setupStageProject } from "./fixtures/governance-helper.js";
import { migrateLocalExceptions, previewLocalMigration, executeExceptionAction, previewExceptionAction, assertExceptionGateState } from "../src/core/controller/exception-service.js";
import { executeWorkflowCommand } from "../src/commands/workflow.js";
import { recordEvidence } from "../src/core/controller/deliverable-controller.js";
import { canonicalInventory, RATIFICATION_PHRASE } from "../src/core/ratification.js";
// Isolated synthetic project only: terminal/Git/clock simulation is local to this
// test process. It never writes or claims an approval for the user's repository.
async function syntheticOperator(run: (c: {
    root: string;
    proof: string;
    tick: () => void;
    state: () => any;
    manifest: () => any;
}) => Promise<void>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-exception-service-"));
    const proof = path.join(root, "canonical-proof");
    fs.mkdirSync(path.join(proof, "docs/adr"), { recursive: true });
    const paths = ["docs/adr/amendment-grandfathered-inventory.json", "docs/adr/ADR-20261110-001-two-phase-exception-lifecycle.md", "docs/adr/ARCHITECTURE-SPEC.md", "docs/adr/ADR-20261117-001-release-closure.md", "docs/architecture/operational-controller/design.md", "governance/state-machine.md", "governance/ENGINEERING_CONTROLLER.md", "templates/exception-record-template.md", ".playbook/state.json", ".playbook/manifest.json"];
    const record = { amendment_id: "AMEND-20261110-001", decision: "ratified_for_local_use", assurance: "Level A", ratified_commit_sha: "a".repeat(40), ratified_tree_sha: "b".repeat(40), inventory_sha256: canonicalInventory([]).sha256, specification_blobs: Object.fromEntries(paths.map(p => [p, "c".repeat(40)])), ratifier: "Example Engineer", role: "Lead Architect", ratified_at: "2026-11-17T00:00:00.000Z", confirmation: RATIFICATION_PHRASE };
    fs.writeFileSync(path.join(proof, "docs/adr/RATIFY-20261110-001.md"), "# Synthetic proof\n```json\n" + JSON.stringify(record) + "\n```\n");
    const fixture = setupStageProject(root, { stage: 0, status: "in_progress" });
    fixture.state.current_stage_detail.deliverables[0].status = "completed";
    fixture.state.current_stage_detail.deliverables[0].validation_status = "unvalidated";
    fixture.state.current_stage_detail.deliverables[0].evidence = [];
    fs.writeFileSync(fixture.statePath, JSON.stringify(fixture.state));
    const originalDate = Date;
    let clock = Date.now();
    const environment = Object.fromEntries(["CI", "GITHUB_ACTIONS", "GITLAB_CI"].map(key => [key, process.env[key]]));
    class FixtureDate extends originalDate {
        constructor(value?: string | number) { super(value === undefined ? clock : value); }
        static now() { return clock; }
    }
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY"), stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    const git = mock.method(childProcess, "execFileSync", ((file: string, args: string[]) => {
        assert.equal(file, "git");
        return args[0] === "show" ? "[]" : args[1].endsWith("^{tree}") ? "b".repeat(40) : "c".repeat(40);
    }) as typeof childProcess.execFileSync);
    try {
        for (const key of Object.keys(environment))
            process.env[key] = "false";
        globalThis.Date = FixtureDate as DateConstructor;
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
        syncBuiltinESMExports();
        await run({ root, proof, tick: () => { clock += 1000; }, state: () => JSON.parse(fs.readFileSync(fixture.statePath, "utf8")), manifest: () => JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8")) });
    }
    finally {
        for (const [key, value] of Object.entries(environment))
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        globalThis.Date = originalDate;
        git.mock.restore();
        syncBuiltinESMExports();
        if (stdin)
            Object.defineProperty(process.stdin, "isTTY", stdin);
        else
            delete (process.stdin as {
                isTTY?: boolean;
            }).isTTY;
        if (stdout)
            Object.defineProperty(process.stdout, "isTTY", stdout);
        else
            delete (process.stdout as {
                isTTY?: boolean;
            }).isTTY;
        removeTempFixture(root);
    }
}
function document(root: string) {
    const file = "docs/exceptions/EXC-20261117-001.md";
    fs.writeFileSync(path.join(root, file), `# EXC-20261117-001: Synthetic dependency exception
## 1. Exception Metadata
| Field | Value |
| --- | --- |
| Exception ID | EXC-20261117-001 |
| Exception Status | Proposed |
| Waived Requirement / Deliverable | PRD-CORE |
| Expiration Date | 2030-12-31 |
## 2. Requester & Authorizer Identification
Requester is an agent; actual operator authorization is pending.
## 3. Reason & Justification
An external dependency is unavailable in this isolated test fixture.
## 4. Risk Assessment
The risk is limited to this synthetic document-review fixture.
## 5. Compensating Controls
All original checks remain required before this exception can be retired.
## 6. Remediation Plan & Expiration
Restore the dependency and produce fresh passing verification evidence.
## 7. Human Authorization & Sign-Off
No authorization has been granted by the proposal document.
## 8. Final Outcome & Retirement Record
The exception has not been retired or used as proof of compliance.
`);
    return file;
}
const operator = { operator: "Example Engineer", role: "Lead Architect" };
async function migrate(c: {
    root: string;
    proof: string;
}) {
    const review = previewLocalMigration(c.root, c.proof);
    return migrateLocalExceptions(c.root, c.proof, operator.operator, operator.role, "CONFIRM MIGRATION LOCAL EXCEPTIONS", review.fingerprint);
}
async function authorize(root: string) {
    const review = previewExceptionAction(root, "EXC-20261117-001", "approve");
    return executeExceptionAction({ targetDir: root, action: "approve", id: "EXC-20261117-001", ...operator, confirmation: "CONFIRM AUTHORIZE EXC-20261117-001", reviewedFingerprint: review.fingerprint });
}
test("synthetic migration preserves backups; proposal and authorization write consistent state, seal and audit", async () => syntheticOperator(async (c) => {
    const before = fs.readFileSync(path.join(c.root, ".playbook/state.json"), "utf8"), migration = await migrate(c);
    assert.equal(fs.readFileSync(path.join(c.root, migration.backup, "state.json"), "utf8"), before);
    assert.equal(c.state().schema_version, "1.1.0");
    c.tick();
    const proposed = await executeWorkflowCommand("exception", ["propose", "--id", "PRD-CORE", "--document", document(c.root), "--cwd", c.root, "--json"]);
    assert.equal(proposed.exitCode, 0, JSON.stringify(proposed));
    assert.equal(c.state().current_stage_detail.deliverables[0].status, "completed");
    assert.throws(() => assertExceptionGateState(c.root, c.state(), c.manifest()), /PROPOSED_EXCEPTIONS_PENDING/);
    c.tick();
    await authorize(c.root);
    assert.equal(c.state().current_stage_detail.deliverables[0].status, "waived");
    assertExceptionGateState(c.root, c.state(), c.manifest());
    fs.appendFileSync(path.join(c.root, "docs/exceptions/EXC-20261117-001.md"), "\nChanged after approval.");
    assert.throws(() => assertExceptionGateState(c.root, c.state(), c.manifest()), /TAMPERED/);
    c.tick();
    const review = previewExceptionAction(c.root, "EXC-20261117-001", "revoke");
    fs.unlinkSync(path.join(c.root, "docs/exceptions/EXC-20261117-001.md"));
    await executeExceptionAction({ targetDir: c.root, action: "revoke", id: "EXC-20261117-001", ...operator, confirmation: "CONFIRM REVOKE EXC-20261117-001", reason: "Withdraw a modified synthetic document", reviewedFingerprint: review.fingerprint });
    assert.equal(c.state().current_stage_detail.deliverables[0].status, "in_progress");
    assert.equal(c.state().current_stage_detail.deliverables[0].exception_ref, null);
}));
test("synthetic remediation cannot use historic proof and retires only fresh marker-bound passing evidence", async () => syntheticOperator(async (c) => {
    await migrate(c);
    c.tick();
    await executeExceptionAction({ targetDir: c.root, action: "propose", id: "EXC-20261117-001", targetId: "PRD-CORE", documentPath: document(c.root) });
    c.tick();
    await authorize(c.root);
    c.tick();
    const started = await executeWorkflowCommand("exception", ["remediation-start", "--id", "EXC-20261117-001", "--cwd", c.root, "--json"]);
    assert.equal(started.exitCode, 0, JSON.stringify(started));
    c.tick();
    await assert.rejects(executeExceptionAction({ targetDir: c.root, action: "remediate", id: "EXC-20261117-001" }), /REMEDIATION_UNVERIFIED/);
    const marker = c.state().current_stage_detail.exceptions[0].remediation_id;
    fs.writeFileSync(path.join(c.root, ".playbook/logs/fresh.txt"), "Fresh synthetic review proof.\n");
    c.tick();
    await recordEvidence({ targetDir: c.root, deliverableId: "PRD-CORE", type: "manual_functional", result: "passed", evidenceRef: ".playbook/logs/fresh.txt", remediationRef: marker });
    assert.equal(c.state().current_stage_detail.deliverables[0].status, "waived");
    c.tick();
    const retired = await executeWorkflowCommand("exception", ["remediate", "--id", "EXC-20261117-001", "--cwd", c.root, "--json"]);
    assert.equal(retired.exitCode, 0, JSON.stringify(retired));
    assert.equal(c.state().current_stage_detail.deliverables[0].status, "verified");
    assert.equal(c.state().current_stage_detail.exceptions[0].status, "remediated");
}));
test("real headless authorization and migration have no injectable TTY bypass", async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        await assert.rejects(executeExceptionAction({ targetDir: "does-not-exist", action: "approve", id: "EXC-20261117-001" }), /TTY_REQUIRED/);
        await assert.rejects(migrateLocalExceptions("does-not-exist", undefined, "Example Engineer", "Lead Architect", "CONFIRM MIGRATION LOCAL EXCEPTIONS", "not-a-review"), /TTY_REQUIRED/);
    }
});
test("migration withdraws legacy waivers, preserves originals and rejects stale review", async () => syntheticOperator(async (c) => {
    const stateFile = path.join(c.root, ".playbook/state.json"), legacy = c.state();
    legacy.current_stage_detail.exceptions = [{ exception_id: "EXC-20261117-099", status: "active", waived_requirement: "PRD-CORE", title: "Legacy documentary waiver", authorized_by: "Example Engineer", authorized_at: "2026-11-17T00:00:00.000Z", expiration_date: "2030-12-31", path: "docs/exceptions/EXC-20261117-099.md" }];
    legacy.current_stage_detail.deliverables[0].status = "waived";
    legacy.current_stage_detail.deliverables[0].validation_status = "waived";
    legacy.current_stage_detail.deliverables[0].exception_ref = "EXC-20261117-099";
    fs.writeFileSync(stateFile, JSON.stringify(legacy));
    const review = previewLocalMigration(c.root, c.proof);
    const original = fs.readFileSync(stateFile, "utf8");
    fs.writeFileSync(stateFile, original + "\n");
    await assert.rejects(migrateLocalExceptions(c.root, c.proof, operator.operator, operator.role, "CONFIRM MIGRATION LOCAL EXCEPTIONS", review.fingerprint), /REVIEW_CHANGED/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), original + "\n");
    const result = await migrate(c), after = c.state();
    assert.equal(fs.readFileSync(path.join(c.root, result.backup, "state.json"), "utf8"), original + "\n");
    assert.equal(after.current_stage_detail.exceptions[0].status, "revoked");
    assert.equal(after.current_stage_detail.deliverables[0].status, "in_progress");
    assert.equal(after.current_stage_detail.deliverables[0].validation_status, "unvalidated");
    assert.equal(after.current_stage_detail.deliverables[0].exception_ref, null);
    assert.equal(after.audit_trail.at(-1).action, "EXCEPTION_MIGRATION_REVOKED");
}));
test("review changes, repeat authorization and remote waiver reliance are rejected without mutation", async () => syntheticOperator(async (c) => {
    await migrate(c);
    c.tick();
    const file = document(c.root);
    await executeExceptionAction({ targetDir: c.root, action: "propose", id: "EXC-20261117-001", targetId: "PRD-CORE", documentPath: file });
    c.tick();
    const review = previewExceptionAction(c.root, "EXC-20261117-001", "approve");
    const original = fs.readFileSync(path.join(c.root, file), "utf8");
    fs.appendFileSync(path.join(c.root, file), "\nChanged before approval\n");
    const stateFile = path.join(c.root, ".playbook/state.json"), before = fs.readFileSync(stateFile, "utf8");
    await assert.rejects(executeExceptionAction({ targetDir: c.root, action: "approve", id: "EXC-20261117-001", ...operator, confirmation: "CONFIRM AUTHORIZE EXC-20261117-001", reviewedFingerprint: review.fingerprint }), /REVIEW_CHANGED/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), before);
    fs.writeFileSync(path.join(c.root, file), original);
    await authorize(c.root);
    c.tick();
    await assert.rejects(authorize(c.root), /NOT_PROPOSED/);
    process.env.CI = "true";
    assert.throws(() => assertExceptionGateState(c.root, c.state(), c.manifest()), /REMOTE_AUTHORITY_UNAVAILABLE/);
}));
