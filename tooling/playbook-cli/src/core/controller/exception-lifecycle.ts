import { createHash, randomUUID } from "node:crypto";
import type { ProjectState, Deliverable, ExceptionRecord } from "../../types/state.js";
import type { ValidatedExceptionMetadata } from "./ast-validators.js";
import { ControllerError, type AuthoritativeResolutionResult } from "./types.js";
import { isForbiddenAgentName } from "./markdown-ast.js";
export const sha256 = (bytes: string | Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function exceptionExpiry(date: string): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new ControllerError("EXCEPTION_DATE_INVALID", "Expected YYYY-MM-DD.");
    const midnight = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date) {
        throw new ControllerError("EXCEPTION_DATE_INVALID", "Date is not a real calendar day.");
    }
    midnight.setUTCDate(midnight.getUTCDate() + 1);
    return midnight.getTime();
}
export function assertExceptionOperator(name: string, role: string, phrase: string, expected: string): void {
    if (!/^[A-Za-z][A-Za-z .'-]{2,100}$/.test(name) || isForbiddenAgentName(name) || /\bcodex\b/i.test(name)) {
        throw new ControllerError("AGENT_AUTHORIZATION_FORBIDDEN", "A named operator must attest this action.");
    }
    if (role !== "Lead Architect")
        throw new ControllerError("OPERATOR_ROLE_REQUIRED", "Declare Lead Architect authority.");
    if (phrase !== expected)
        throw new ControllerError("CONFIRMATION_MISMATCH", "Exact confirmation phrase required.");
}
export interface ExceptionActionInput {
    action: "propose" | "approve" | "revoke" | "remediation-start" | "remediate";
    id: string;
    actor: string;
    now: string;
    ratificationCommit: string;
    documentHash: string;
    targetId?: string;
    documentPath?: string;
    metadata?: Pick<ValidatedExceptionMetadata, "exception_id" | "title" | "waived_requirement" | "expiration_date">;
    operator?: string;
    role?: string;
    confirmation?: string;
    reason?: string;
    verification?: AuthoritativeResolutionResult;
}
/** Pure transition plan. It is not an authorization entry point and writes no files. */
export function planExceptionAction(original: ProjectState, input: ExceptionActionInput): {
    state: ProjectState;
    exception: ExceptionRecord;
    sidecar?: {
        path: string;
        content: string;
    };
} {
    if (original.schema_version !== "1.1.0")
        throw new ControllerError("EXCEPTION_MIGRATION_REQUIRED", "Explicit local-exception migration is required.");
    if (original.stage_status !== "in_progress" || !["active", "reopened_maintenance"].includes(original.lifecycle_status)) {
        throw new ControllerError("STAGE_NOT_IN_PROGRESS", "Exception work requires an active in-progress stage.");
    }
    const time = Date.parse(input.now);
    if (!Number.isFinite(time) || time < Date.parse(original.last_updated.timestamp))
        throw new ControllerError("TIME_INVALID", "Invalid or backward transition time.");
    const state: ProjectState = structuredClone(original);
    const sequence = (state.transaction_sequence || 0) + 1;
    const exceptions = state.current_stage_detail.exceptions;
    let exception = exceptions.find(e => e.exception_id === input.id);
    let sidecar: {
        path: string;
        content: string;
    } | undefined;
    const target = state.current_stage_detail.deliverables.find(d => d.id === (input.targetId || exception?.waived_requirement));
    if (!target)
        throw new ControllerError("EXCEPTION_TARGET_NOT_FOUND", "The exact target deliverable is required.");
    if (input.action === "propose") {
        if (exception)
            throw new ControllerError("EXCEPTION_DUPLICATE", "Exception IDs cannot be reused.");
        const metadata = input.metadata;
        if (!metadata || metadata.exception_id !== input.id || metadata.waived_requirement !== target.id || !input.documentPath) {
            throw new ControllerError("EXCEPTION_SCOPE_MISMATCH", "Proposal must identify one exact declared deliverable.");
        }
        if (["verified", "waived"].includes(target.status))
            throw new ControllerError("EXCEPTION_TARGET_INELIGIBLE", "A verified or waived deliverable cannot receive a new proposal.");
        if (time >= exceptionExpiry(metadata.expiration_date))
            throw new ControllerError("EXCEPTION_EXPIRED", "Proposal is already expired.");
        exception = {
            exception_id: input.id, title: metadata.title, path: input.documentPath, waived_requirement: target.id,
            authorized_by: null, authorized_at: null, expiration_date: metadata.expiration_date, status: "proposed",
            proposal_hash: input.documentHash, proposed_at: input.now, proposal_actor: input.actor, ratification_commit: input.ratificationCommit
        };
        exceptions.push(exception);
    }
    else {
        if (!exception)
            throw new ControllerError("EXCEPTION_NOT_FOUND", "Exception does not exist.");
        if (input.action !== "revoke" && time >= exceptionExpiry(exception.expiration_date))
            throw new ControllerError("EXCEPTION_EXPIRED", "Exception authority has expired.");
        if (input.action === "approve") {
            if (exception.status !== "proposed")
                throw new ControllerError("EXCEPTION_NOT_PROPOSED", "Only an unresolved proposal may be authorized.");
            if (exception.proposal_hash !== input.documentHash)
                throw new ControllerError("EXCEPTION_DOCUMENT_CHANGED", "The proposed document changed; withdraw and propose a new ID.");
            assertExceptionOperator(input.operator || "", input.role || "", input.confirmation || "", `CONFIRM AUTHORIZE ${input.id}`);
            if (target.status === "verified" || target.status === "waived")
                throw new ControllerError("EXCEPTION_TARGET_INELIGIBLE", "Target is no longer eligible.");
            const payload = {
                schema_version: "1.1.0", project_id: state.project_id, milestone_id: state.milestone_id,
                stage: state.current_stage, exception_id: exception.exception_id, deliverable_id: target.id,
                proposal_hash: exception.proposal_hash, document_hash: input.documentHash, expiration_date: exception.expiration_date,
                authorized_by: input.operator, role: input.role, authorized_at: input.now, ratification_commit: input.ratificationCommit, assurance: "local_operator_attestation"
            };
            sidecar = { path: `.playbook/exception-approvals/${exception.exception_id}.json`, content: JSON.stringify(payload, null, 2) + "\n" };
            exception.status = "active";
            exception.authorized_by = input.operator!;
            exception.authorized_at = input.now;
            exception.authorization_path = sidecar.path;
            exception.authorization_ref = sha256(sidecar.content);
            target.status = "waived";
            target.validation_status = "waived";
            target.exception_ref = exception.exception_id;
        }
        else if (input.action === "revoke") {
            if (!["proposed", "active"].includes(exception.status))
                throw new ControllerError("EXCEPTION_TERMINAL", "Only proposed/active records may be revoked.");
            if (!input.reason || input.reason.trim().length < 10)
                throw new ControllerError("REVOCATION_REASON_REQUIRED", "Provide a substantive reason.");
            assertExceptionOperator(input.operator || "", input.role || "", input.confirmation || "", `CONFIRM REVOKE ${input.id}`);
            exception.status = "revoked";
            exception.revoked_at = input.now;
            exception.revoked_by = input.operator;
            exception.revocation_reason = input.reason;
            if (target.exception_ref === exception.exception_id) {
                target.status = "in_progress";
                target.exception_ref = null;
                target.validation_status = target.evidence.length ? "failed" : "unvalidated";
                if (input.verification?.authoritativeResult === "passed")
                    target.validation_status = "passed";
            }
        }
        else if (input.action === "remediation-start") {
            if (exception.status !== "active")
                throw new ControllerError("EXCEPTION_NOT_ACTIVE", "Remediation requires an active authorization.");
            if (time <= Date.parse(exception.authorized_at!))
                throw new ControllerError("TIME_INVALID", "Remediation must start strictly after authorization.");
            exception.remediation_id = randomUUID();
            exception.remediation_started_at = input.now;
            exception.remediation_sequence = sequence;
        }
        else {
            if (exception.status !== "active" || !exception.remediation_id || !exception.remediation_started_at || !exception.remediation_sequence) {
                throw new ControllerError("REMEDIATION_NOT_STARTED", "Record remediation initiation first.");
            }
            if (input.verification?.authoritativeResult !== "passed")
                throw new ControllerError("REMEDIATION_UNVERIFIED", "Fresh bound evidence must satisfy every mandatory discipline.");
            exception.status = "remediated";
            target.status = "verified";
            target.validation_status = "passed";
            target.exception_ref = null;
        }
    }
    const human = ["approve", "revoke"].includes(input.action);
    const actor = human ? input.operator! : input.actor;
    state.transaction_sequence = sequence;
    state.audit_trail ||= [];
    const actionNames = { propose: "EXCEPTION_PROPOSED", approve: "EXCEPTION_AUTHORIZED", revoke: "EXCEPTION_REVOKED", "remediation-start": "EXCEPTION_REMEDIATION_STARTED", remediate: "EXCEPTION_REMEDIATED" };
    state.audit_trail.push({
        action: actionNames[input.action], sequence,
        timestamp: input.now, actor, actor_type: human ? "human_interactive" : "agent", reason: input.reason || input.action,
        exception_id: exception.exception_id, deliverable_id: target.id, prior_authorization_ref: exception.authorization_ref || null
    });
    state.last_updated = { timestamp: input.now, updated_by: actor, actor_type: human ? "human" : "agent", reason: `Exception ${input.action}: ${exception.exception_id}` };
    return { state, exception, sidecar };
}
/** Shared, read-only eligibility check. The callback verifies documentary provenance and exact local sidecar. */
export function assertEffectiveWaiver(state: ProjectState, deliverable: Deliverable, verifyBinding: (exception: ExceptionRecord) => void, now = new Date()): void {
    const exception = state.current_stage_detail.exceptions.find(e => e.exception_id === deliverable.exception_ref);
    if (exception && (["expired", "revoked"].includes(exception.status) || (exception.status === "active" && now.getTime() >= exceptionExpiry(exception.expiration_date)))) {
        throw new ControllerError("EXCEPTION_EXPIRED", "The referenced waiver has expired or been revoked.");
    }
    if (!exception || exception.status !== "active" || state.schema_version !== "1.1.0" || exception.waived_requirement !== deliverable.id ||
        deliverable.status !== "waived" || deliverable.validation_status !== "waived" || !exception.authorization_ref || !exception.authorization_path) {
        throw new ControllerError("EXCEPTION_WAIVER_UNAUTHORIZED", "An active, scoped, sealed authorization is required.");
    }
    if (!exception.authorized_at || !Number.isFinite(Date.parse(exception.authorized_at)) || now.getTime() < Date.parse(exception.authorized_at))
        throw new ControllerError("TIME_INVALID", "Waiver cannot be effective before its authorization time.");
    if (!Number.isFinite(now.getTime()) || now.getTime() >= exceptionExpiry(exception.expiration_date))
        throw new ControllerError("EXCEPTION_EXPIRED", "Exception authority has expired.");
    verifyBinding(exception);
}
