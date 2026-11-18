import { removeTempFixture } from "./fixtures/temp.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setupStageProject } from "./fixtures/governance-helper.js";
import { getRequiredDisciplinesForDeliverable, resolveAuthoritativeVerification } from "../src/core/controller/resolver.js";
import { computeRif } from "../src/core/quality-gates/rif.js";
import { configurationFingerprint, toolFingerprint, parseToolVersionCommand } from "../src/core/quality-gates/evidence-binding.js";
import type { QualityGateCheck } from "../src/types/quality-gates.js";
import type { EvidenceRecord } from "../src/types/state.js";
import { QualityGateVerifier } from "../src/core/quality-gates/verifier.js";
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function fixture(run: (ctx: ReturnType<typeof setup>) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "playbook-resolver-safety-"));
    try {
        run(setup(root));
    }
    finally {
        removeTempFixture(root);
    }
}
function setup(root: string) {
    const project = setupStageProject(root, { stage: 0, status: "in_progress" });
    const deliverable = project.state.current_stage_detail.deliverables[0];
    deliverable.evidence = [];
    fs.writeFileSync(path.join(root, "source.txt"), "original source");
    const checks: QualityGateCheck[] = ["first", "second"].map(id => ({
        id, name: id, type: "automated_test", deliverable_id: deliverable.id,
        command: process.execPath, args: ["-e", "process.exit(0)"], inputs: ["source.txt"], severity: "blocking"
    }));
    const config = {
        $schema: "https://ai-engineering-playbook.org/schemas/quality-gates.schema.json", schema_version: "1.0.0", project_id: project.state.project_id, default_profile: "standard",
        global_settings: { default_timeout_ms: 30000, max_concurrency: 1, mask_secrets: true, log_retention_runs: 5, max_journaled_log_bytes: 1048576, env_allowlist: ["PATH"] },
        gates: [{ stage: 0, stage_name: "Discovery & Problem Formulation", checks }]
    };
    const configPath = path.join(root, ".playbook/quality-gates.json");
    fs.writeFileSync(configPath, JSON.stringify(config));
    function evidence(check: QualityGateCheck): EvidenceRecord {
        const ref = `.playbook/logs/${check.id}.txt`, text = `Check ${check.id}: passed\n`;
        fs.writeFileSync(path.join(root, ref), text);
        return {
            requirement_id: null, type: check.type, procedure: check.command, result: "passed", summary: "Actual synthetic fixture proof", exit_code: 0,
            evidence_ref: ref, evidence_hash: sha(text), verified_at: new Date().toISOString(), verified_by: "agent:test", actor_type: "agent",
            rif: computeRif({ projectDir: root, check, workingTreeClean: true }).rif, working_tree_clean: true,
            quality_gate: { gate_id: "gate-stage-0", check_id: check.id, config_hash: configurationFingerprint(root, project.manifest), tool_fingerprint: toolFingerprint(root, check), tool_version: "v1.0.0" }
        };
    }
    const resolve = () => resolveAuthoritativeVerification(root, 0, deliverable, project.manifest, [deliverable]);
    return { root, project, deliverable, checks, config, configPath, evidence, resolve };
}
test("each mandatory check needs exact proof even when check types are identical", () => fixture(c => {
    c.deliverable.evidence = [c.evidence(c.checks[0])];
    assert.equal(c.resolve().authoritativeResult, "unverified");
    assert.ok(c.resolve().missingRequiredDisciplines.includes("check:second"));
    c.deliverable.evidence.push(c.evidence(c.checks[1]));
    assert.equal(c.resolve().authoritativeResult, "passed");
}));
test("forged metadata, changed evidence bytes and changed input cannot satisfy a gate", () => fixture(c => {
    c.deliverable.evidence = c.checks.map(c.evidence);
    const second = c.deliverable.evidence[1];
    second.quality_gate!.gate_id = "gate-stage-1";
    assert.equal(c.resolve().authoritativeResult, "unverified");
    second.quality_gate!.gate_id = "gate-stage-0";
    fs.writeFileSync(path.join(c.root, second.evidence_ref), "tampered");
    assert.equal(c.resolve().authoritativeResult, "failed");
    c.deliverable.evidence = c.checks.map(c.evidence);
    fs.writeFileSync(path.join(c.root, "source.txt"), "changed source");
    assert.equal(c.resolve().authoritativeResult, "failed");
}));
test("configuration edits and missing tool binding require re-verification", () => fixture(c => {
    c.deliverable.evidence = c.checks.map(c.evidence);
    delete c.deliverable.evidence[0].quality_gate!.tool_fingerprint;
    assert.equal(c.resolve().authoritativeResult, "failed");
    c.deliverable.evidence = c.checks.map(c.evidence);
    c.config.gates[0].checks[0].args = ["-e", "process.exit(1)"];
    fs.writeFileSync(c.configPath, JSON.stringify(c.config));
    assert.equal(c.resolve().authoritativeResult, "failed");
}));
test("missing stages/mappings retain baseline obligations and custom deliverables fail closed", () => fixture(c => {
    c.config.gates = [];
    fs.writeFileSync(c.configPath, JSON.stringify(c.config));
    assert.deepEqual(getRequiredDisciplinesForDeliverable(c.root, 3, { ...c.deliverable, id: "CODE-IMPL" }), ["automated_test"]);
    assert.throws(() => getRequiredDisciplinesForDeliverable(c.root, 0, { ...c.deliverable, id: "CUSTOM" }), /REQUIRED_DISCIPLINES_INDETERMINATE/);
}));
test("missing advisory proof is reported without blocking fresh mandatory checks", () => fixture(c => {
    c.config.gates[0].checks[1].severity = "advisory";
    fs.writeFileSync(c.configPath, JSON.stringify(c.config));
    c.deliverable.evidence = [c.evidence(c.checks[0])];
    fs.writeFileSync(c.project.statePath, JSON.stringify(c.project.state));
    const report = new QualityGateVerifier(c.root).verify();
    assert.equal(report.all_fresh, true);
    assert.equal(report.checks.find(check => check.check_id === "second")?.evidence_status, "missing_evidence");
}));
test("tool binding covers the executed script even with a separate version command", () => fixture(c => {
    const script = path.join(c.root, "check.mjs");
    fs.writeFileSync(script, "process.exit(0)");
    const check = { ...c.checks[0], args: ["check.mjs"], tool_version_command: `"${process.execPath}" --version` };
    const before = toolFingerprint(c.root, check);
    fs.writeFileSync(script, "process.exit(1)");
    assert.notEqual(toolFingerprint(c.root, check), before);
}));

test("version probes preserve quoted paths and never evaluate shell text", () => {
    assert.deepEqual(parseToolVersionCommand('"C:/Program Files/node/node.exe" --version'), ['C:/Program Files/node/node.exe', '--version']);
    assert.deepEqual(parseToolVersionCommand("node -p 'process.versions.node'"), ['node', '-p', 'process.versions.node']);
    assert.deepEqual(parseToolVersionCommand('node "$(ignored)"'), ['node', '$(ignored)']);
    assert.throws(() => parseToolVersionCommand('"unterminated'), /COMMAND_INVALID/);
    assert.throws(() => parseToolVersionCommand(' '), /COMMAND_INVALID/);
});

test("tool binding does not mistake wildcard test arguments for entry scripts", () => fixture(c => {
    assert.doesNotThrow(() => toolFingerprint(c.root, { ...c.checks[0], args: ["--test", "__tests__/**/*.test.js"] }));
}));
