import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "../src/templates/state-template.js";
import { planExceptionAction, exceptionExpiry, assertEffectiveWaiver } from "../src/core/controller/exception-lifecycle.js";
import type { ProjectState } from "../src/types/state.js";
function state(): ProjectState {
    const result = createInitialState({ projectId: "exception-test", approvalMode: "solo" });
    result.schema_version = "1.1.0";
    result.stage_status = "in_progress";
    result.transaction_sequence = 0;
    result.audit_trail = [];
    result.last_updated.timestamp = "2026-11-16T00:00:00.000Z";
    return result;
}
const metadata = { exception_id: "EXC-20261117-001", title: "Temporary external audit dependency", waived_requirement: "PRD-CORE", expiration_date: "2026-12-31" };
const base = { id: metadata.exception_id, now: "2026-11-17T00:00:00.000Z", actor: "agent:test", ratificationCommit: "a".repeat(40), documentHash: "sha256:" + "b".repeat(64) };
function propose(s = state()) {
    return planExceptionAction(s, { ...base, action: "propose", targetId: "PRD-CORE", documentPath: "docs/exceptions/EXC-20261117-001.md", metadata });
}
test("proposal is nonprivileged and cannot manufacture waiver from documentary metadata", () => {
    const original = state(), plan = propose(original);
    assert.equal(plan.state.current_stage_detail.exceptions[0].status, "proposed");
    assert.equal(plan.state.current_stage_detail.exceptions[0].authorized_by, null);
    assert.equal(plan.state.current_stage_detail.deliverables[0].status, "not_started");
    assert.equal(original.current_stage_detail.exceptions.length, 0);
    assert.throws(() => assertEffectiveWaiver(plan.state, plan.state.current_stage_detail.deliverables[0], () => { }), /WAIVER/);
});
test("authorization binds exact proposal and creates local-only sidecar with audit atomically planned", () => {
    const p = propose();
    const plan = planExceptionAction(p.state, { ...base, now: "2026-11-17T00:00:01.000Z", action: "approve", operator: "Example Engineer", role: "Lead Architect", confirmation: `CONFIRM AUTHORIZE ${base.id}` });
    assert.equal(plan.state.current_stage_detail.deliverables[0].status, "waived");
    assert.equal(plan.state.current_stage_detail.exceptions[0].status, "active");
    assert.ok(plan.sidecar);
    assert.equal(plan.state.audit_trail?.length, 2);
    assertEffectiveWaiver(plan.state, plan.state.current_stage_detail.deliverables[0], () => { }, new Date("2026-12-31T23:59:59.999Z"));
    assert.throws(() => assertEffectiveWaiver(plan.state, plan.state.current_stage_detail.deliverables[0], () => { }, new Date("2027-01-01T00:00:00.000Z")), /EXCEPTION_EXPIRED/);
    assert.throws(() => planExceptionAction(p.state, { ...base, documentHash: "sha256:" + "c".repeat(64), action: "approve", operator: "Example Engineer", role: "Lead Architect", confirmation: `CONFIRM AUTHORIZE ${base.id}` }), /DOCUMENT_CHANGED/);
});
test("bad operator, role, phrase, duplicate proposal, target, time and version fail closed", () => {
    const p = propose().state;
    for (const change of [{ operator: "Codex" }, { role: "Developer" }, { confirmation: "yes" }]) {
        assert.throws(() => planExceptionAction(p, { ...base, action: "approve", operator: "Example Engineer", role: "Lead Architect", confirmation: `CONFIRM AUTHORIZE ${base.id}`, ...change }));
    }
    assert.throws(() => propose(p), /DUPLICATE/);
    assert.throws(() => planExceptionAction(state(), { ...base, action: "propose", targetId: "wrong", documentPath: "a", metadata }), /TARGET/);
    const old = state();
    old.schema_version = "1.0.0";
    assert.throws(() => propose(old), /MIGRATION_REQUIRED/);
    assert.throws(() => planExceptionAction(p, { ...base, now: "invalid", action: "remediation-start" }), /TIME_INVALID/);
});
test("revocation preserves history and clears only an active waiver, without fabricated failed evidence", () => {
    const approved = planExceptionAction(propose().state, { ...base, action: "approve", operator: "Example Engineer", role: "Lead Architect", confirmation: `CONFIRM AUTHORIZE ${base.id}` });
    const revoked = planExceptionAction(approved.state, { ...base, action: "revoke", reason: "Dependency can now be checked normally", operator: "Example Engineer", role: "Lead Architect", confirmation: `CONFIRM REVOKE ${base.id}` });
    assert.equal(revoked.state.current_stage_detail.deliverables[0].status, "in_progress");
    assert.equal(revoked.state.current_stage_detail.deliverables[0].validation_status, "unvalidated");
    assert.equal(revoked.state.current_stage_detail.deliverables[0].exception_ref, null);
    assert.equal(revoked.state.current_stage_detail.exceptions[0].status, "revoked");
    assert.ok(revoked.state.audit_trail?.[2].prior_authorization_ref);
});
test("remediation marker is fresh and uniquely binds subsequent evidence without prematurely unwaiving", () => {
    const approved = planExceptionAction(propose().state, { ...base, action: "approve", operator: "Example Engineer", role: "Lead Architect", confirmation: `CONFIRM AUTHORIZE ${base.id}` });
    const marked = planExceptionAction(approved.state, { ...base, now: "2026-11-17T00:00:01.000Z", action: "remediation-start" });
    assert.equal(marked.state.current_stage_detail.deliverables[0].status, "waived");
    assert.ok(marked.state.current_stage_detail.exceptions[0].remediation_id);
    assert.equal(marked.state.current_stage_detail.exceptions[0].remediation_sequence, 3);
    assert.throws(() => planExceptionAction(approved.state, { ...base, now: "2026-11-16T00:00:00.000Z", action: "remediation-start" }), /TIME_INVALID/);
});
test("expiry validates real calendar dates and the exclusive next-midnight UTC boundary", () => {
    assert.equal(exceptionExpiry("2026-12-31"), Date.parse("2027-01-01T00:00:00.000Z"));
    for (const date of ["2026-02-30", "2026-13-01", "2026-02-03T00:00:00Z", ""])
        assert.throws(() => exceptionExpiry(date), /DATE_INVALID/);
});
