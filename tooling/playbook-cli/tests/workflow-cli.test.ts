import { createValidExitPackage } from "./fixtures/exit-package.js";
import { validateExitPackageAst } from "../src/core/controller/ast-validators.js";
import { STAGE_NAMES } from "../src/constants.js";
import { removeTempFixture } from "./fixtures/temp.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupStageProject } from "./fixtures/governance-helper.js";
import { executeWorkflowCommand } from "../src/commands/workflow.js";
import { checkGateEligibility } from "../src/core/approval.js";
async function fixture(run: (root: string) => Promise<void>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-workflow-"));
    try {
        const setup = setupStageProject(root, { stage: 0, status: "in_progress" });
        const state = JSON.parse(fs.readFileSync(setup.statePath, "utf8"));
        state.stage_status = "not_started";
        state.current_stage_detail.deliverables[0].status = "not_started";
        state.current_stage_detail.deliverables[0].validation_status = "unvalidated";
        state.current_stage_detail.deliverables[0].evidence = [];
        fs.writeFileSync(setup.statePath, JSON.stringify(state));
        await run(root);
    }
    finally {
        removeTempFixture(root);
    }
}
test("headless workflow starts, records and verifies an authored document truthfully", async () => fixture(async (root) => {
    const call = (group: string, args: string[]) => executeWorkflowCommand(group, [...args, "--cwd", root, "--json"]);
    assert.equal((await call("stage", ["start", "--stage", "0"])).exitCode, 0);
    fs.writeFileSync(path.join(root, "docs/prd/PRD-CORE.md"), "# Discovery\nA test problem and explicit scope.\n");
    assert.equal((await call("deliverable", ["record", "--id", "PRD-CORE", "--artifact", "docs/prd/PRD-CORE.md"])).exitCode, 0);
    const statePath = path.join(root, ".playbook/state.json");
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).current_stage_detail.deliverables[0].validation_status, "unvalidated");
    const proof = ".playbook/logs/review.txt";
    fs.writeFileSync(path.join(root, proof), "Discovery reviewed for test purposes.\n");
    const result = await call("deliverable", ["evidence", "--id", "PRD-CORE", "--type", "manual_functional", "--result", "passed", "--evidence", proof, "--procedure", "Review test artifact"]);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.current_stage_detail.deliverables[0].status, "verified");
    assert.equal(state.current_stage_detail.deliverables[0].evidence[0].actor_type, "agent");
    assert.equal(state.current_stage_detail.human_approval.status, "not_requested");
    const packagePath = "docs/gates/GATE-0-EXIT-PACKAGE.md";
    fs.writeFileSync(path.join(root, packagePath), "# Stage Gate 0 Exit Package\n\n" + [
        "Package & Stage Identification", "Stage Objectives & Scope Summary", "Deliverables Manifest & Status",
        "Verifiable Validation Evidence", "Traceability Matrix", "Outstanding Issues & Accepted Limitations",
        "Related Governance Artifacts", "AI Agent Completion Assertion",
    ].map((heading, i) => `## ${i + 1}. ${heading}\n\nTest fixture: discovery reviewed; evidence retained; human decision remains pending.\n`).join("\n"));
    const submitted = await call("stage", ["submit", "--package", packagePath]);
    assert.equal(submitted.exitCode, 0, JSON.stringify(submitted));
    const reviewed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(reviewed.stage_status, "pending_review");
    assert.equal(reviewed.current_stage_detail.human_approval.status, "pending_review");
    assert.equal(reviewed.current_stage_detail.human_approval.approved_by, null);
}));
test("invalid flags, enums, stages, extra positionals and missing arguments leave bytes unchanged", async () => fixture(async (root) => {
    const file = path.join(root, ".playbook/state.json"), before = fs.readFileSync(file, "utf8");
    for (const [group, args] of [
        ["stage", ["start", "--stage", "3junk"]], ["stage", ["start", "--stage", "7"]],
        ["stage", ["start", "--oops"]], ["stage", ["start", "extra"]],
        ["deliverable", ["record", "--id", "PRD-CORE"]],
        ["deliverable", ["record", "--id", "PRD-CORE", "--artifact", "a", "--status", "approved"]],
        ["stage", ["submit", "--force"]],
        ["stage", ["submit", "--package", ""]],
    ] as [
        string,
        string[]
    ][]) {
        const result = await executeWorkflowCommand(group, [...args, "--cwd", root]);
        assert.equal(result.exitCode, 2, JSON.stringify(result));
        assert.equal(fs.readFileSync(file, "utf8"), before);
    }
}));
test("wrong-stage submission is a structured operation failure, never approval", async () => fixture(async (root) => {
    const result = await executeWorkflowCommand("stage", ["submit", "--stage", "1", "--cwd", root]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.result.success, false);
    assert.ok("error" in result.result);
}));
test("exception routes require explicit migration instead of invoking historical documentary waiver", async () => fixture(async (root) => {
    const file = path.join(root, ".playbook/state.json"), before = fs.readFileSync(file, "utf8");
    const result = await executeWorkflowCommand("exception", ["propose", "--id", "PRD-CORE", "--document", "fake.md", "--cwd", root]);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.result, { success: false, operation: "exception propose", error: { code: "EXCEPTION_MIGRATION_REQUIRED", message: "[EXCEPTION_MIGRATION_REQUIRED] Run explicit exception migration first." } });
    assert.equal(fs.readFileSync(file, "utf8"), before);
}));

test("rejected legacy waiver recovers through original integration proof and submission", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-workflow-legacy-"));
    try {
        const setup = setupStageProject(root, { stage: 4, status: "pending_review" });
        const state = setup.state, target = state.current_stage_detail.deliverables[0];
        target.status = "waived"; target.validation_status = "waived"; target.exception_ref = "EXC-20261118-001"; target.evidence = [];
        state.current_stage_detail.exceptions = [{ exception_id: "EXC-20261118-001", title: "Unsealed synthetic waiver", path: "docs/exceptions/EXC-20261118-001.md", waived_requirement: target.id, authorized_by: "Example Engineer", authorized_at: "2026-11-17T00:00:00.000Z", expiration_date: "2030-12-31", status: "active" }];
        fs.writeFileSync(setup.statePath, JSON.stringify(state));
        const before = fs.readFileSync(setup.statePath, "utf8"), blocked = checkGateEligibility(root, 4);
        assert.equal(blocked.eligible, false);
        assert.ok(blocked.diagnostics.some(d => d.message.includes("EXCEPTION_WAIVER_UNAUTHORIZED")));
        assert.equal(fs.readFileSync(setup.statePath, "utf8"), before);
        // Withdraw invalid metadata in this disposable fixture only; no project authorization.
        state.current_stage_detail.exceptions[0].status = "revoked";
        target.status = "in_progress"; target.validation_status = "unvalidated"; target.exception_ref = null;
        state.stage_status = "in_progress"; state.current_stage_detail.human_approval.status = "not_requested";
        state.current_stage_detail.exit_package.status = "drafted";
        fs.writeFileSync(setup.statePath, JSON.stringify(state));
        fs.mkdirSync(path.join(root, "tests/integration"), { recursive: true });
        fs.writeFileSync(path.join(root, "tests/integration/README.md"), "Synthetic integration fixture.\n");
        const call = (group: string, args: string[]) => executeWorkflowCommand(group, [...args, "--cwd", root, "--json"]);
        assert.equal((await call("deliverable", ["record", "--id", target.id, "--artifact", "tests/integration"])).exitCode, 0);
        assert.equal((await call("deliverable", ["evidence", "--id", target.id, "--type", "automated_test", "--result", "passed", "--evidence", ".playbook/logs/test-stage-4.log", "--procedure", "Synthetic integration check"])).exitCode, 0);
        const headings = ["Package & Stage Identification", "Stage Objectives & Scope Summary", "Deliverables Manifest & Status", "Verifiable Validation Evidence", "Traceability Matrix", "Outstanding Issues & Accepted Limitations", "Related Governance Artifacts", "AI Agent Completion Assertion"];
        fs.writeFileSync(setup.exitPackagePath, "# Synthetic Gate 4 Exit Package\n\n" + headings.map((h, i) => `## ${i + 1}. ${h}\n\nIntegration obligation verified; legacy authority withdrawn; human decision pending.\n`).join("\n"));
        const submitted = await call("stage", ["submit", "--package", "docs/gates/GATE-4-EXIT-PACKAGE.md"]);
        assert.equal(submitted.exitCode, 0, JSON.stringify(submitted));
        const eligible = checkGateEligibility(root, 4);
        assert.equal(eligible.eligible, true, JSON.stringify(eligible.diagnostics));
        assert.equal(JSON.parse(fs.readFileSync(setup.statePath, "utf8")).current_stage_detail.human_approval.status, "pending_review");
    } finally { removeTempFixture(root); }
});


test("executable lifecycle exit-package fixture satisfies strict submission for every stage", () => {
    for (let stage = 0; stage <= 6; stage++) {
        const content = createValidExitPackage(stage, STAGE_NAMES[stage as 0 | 1 | 2 | 3 | 4 | 5 | 6], "Synthetic verified deliverable");
        const result = validateExitPackageAst(content, { stage, strict: true });
        assert.equal(result.valid, true, JSON.stringify(result.errors));
        const truncated = content.replace("## 2. Stage Objectives & Scope Summary", "## 2. Omitted section");
        assert.equal(validateExitPackageAst(truncated, { stage, strict: true }).valid, false);
    }
});
