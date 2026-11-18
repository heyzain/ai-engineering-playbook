import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectState, ExceptionRecord, Deliverable } from "../../types/state.js";
import type { ProjectManifest } from "../../types/manifest.js";
import { SchemaValidator } from "../validator.js";
import { verifyLocalRatification } from "../ratification-verifier.js";
import { assertRatificationTerminal } from "../ratification.js";
import { WriteAheadTransactionManager, type FileOperationSpec } from "../transaction/index.js";
import { inspectAndHashEvidenceFile } from "./fs-security.js";
import { validateExceptionDocumentAst } from "./ast-validators.js";
import { resolveAuthoritativeVerification } from "./resolver.js";
import { planExceptionAction, assertEffectiveWaiver, assertExceptionOperator, sha256, type ExceptionActionInput } from "./exception-lifecycle.js";
import { ControllerError } from "./types.js";
function load(targetDir: string) {
    const root = fs.realpathSync(targetDir);
    const stateRaw = fs.readFileSync(path.join(root, ".playbook/state.json"), "utf8");
    const manifestRaw = fs.readFileSync(path.join(root, ".playbook/manifest.json"), "utf8");
    const state = JSON.parse(stateRaw) as ProjectState, manifest = JSON.parse(manifestRaw) as ProjectManifest;
    const validator = new SchemaValidator();
    if (!validator.validateState(state).valid || !validator.validateManifest(manifest).valid || state.project_id !== manifest.project_id ||
        state.milestone_id !== manifest.active_milestone_id || state.current_stage !== manifest.active_lifecycle_stage) {
        throw new ControllerError("PROJECT_CONTRACT_INVALID", "Manifest/state identity, pointers and supported schemas must agree.");
    }
    return { root, state, manifest, stateRaw, manifestRaw, validator };
}
function localOnly(manifest: ProjectManifest): void {
    if (manifest.playbook.approval_mode !== "solo" || [process.env.CI, process.env.GITHUB_ACTIONS, process.env.GITLAB_CI].some(v => v && !/^(false|0)$/i.test(v))) {
        throw new ControllerError("EXCEPTION_REMOTE_AUTHORITY_UNAVAILABLE", "Level A cannot authorize team or remote-CI waivers. Level B is not implemented.");
    }
}
function proof(root: string, manifest: ProjectManifest) {
    localOnly(manifest);
    return verifyLocalRatification(path.resolve(root, manifest.playbook.ratification_root || "."));
}
export function verifyExceptionAuthority(root: string, state: ProjectState, manifest: ProjectManifest, exception: ExceptionRecord): void {
    const binding = proof(root, manifest);
    if (binding.commit !== exception.ratification_commit)
        throw new ControllerError("RATIFICATION_BINDING_CHANGED", "Exception was proposed against a different ratified specification.");
    if (!exception.authorization_path || !exception.authorization_ref || !exception.proposal_hash)
        throw new ControllerError("EXCEPTION_AUTHORIZATION_MISSING", "Sealed authorization is missing.");
    const checked = inspectAndHashEvidenceFile(root, exception.authorization_path);
    if (checked.fileHash !== exception.authorization_ref)
        throw new ControllerError("EXCEPTION_AUTHORIZATION_TAMPERED", "Authorization hash does not match.");
    const sidecar = JSON.parse(fs.readFileSync(checked.absolutePath, "utf8"));
    const doc = inspectAndHashEvidenceFile(root, exception.path);
    const expected = {
        project_id: state.project_id, milestone_id: state.milestone_id, stage: state.current_stage,
        exception_id: exception.exception_id, deliverable_id: exception.waived_requirement, proposal_hash: exception.proposal_hash,
        document_hash: doc.fileHash, expiration_date: exception.expiration_date, authorized_by: exception.authorized_by,
        authorized_at: exception.authorized_at, ratification_commit: exception.ratification_commit, assurance: "local_operator_attestation"
    };
    if (doc.fileHash !== exception.proposal_hash || Object.entries(expected).some(([key, value]) => sidecar[key] !== value)) {
        throw new ControllerError("EXCEPTION_AUTHORIZATION_TAMPERED", "Document or authorization scope has changed.");
    }
}
/** All gate readers share effective expiry and authorization rules; never writes state. */
export function assertExceptionGateState(root: string, state: ProjectState, manifest: ProjectManifest, now = new Date()): void {
    if (state.current_stage_detail.exceptions.some(e => e.status === "proposed")) {
        throw new ControllerError("PROPOSED_EXCEPTIONS_PENDING", "Authorize or withdraw every unresolved proposal before submission.");
    }
    for (const deliverable of state.current_stage_detail.deliverables) {
        if (deliverable.status === "waived")
            assertEffectiveWaiver(state, deliverable, e => verifyExceptionAuthority(root, state, manifest, e), now);
    }
    for (const exception of state.current_stage_detail.exceptions.filter(e => e.status === "active")) {
        const target = state.current_stage_detail.deliverables.find(d => d.id === exception.waived_requirement && d.exception_ref === exception.exception_id);
        if (!target || target.status !== "waived")
            throw new ControllerError("EXCEPTION_SCOPE_MISMATCH", "Active exception must link to its waived deliverable.");
    }
}
export interface ExceptionCommandOptions {
    targetDir: string;
    action: ExceptionActionInput["action"];
    id: string;
    targetId?: string;
    documentPath?: string;
    operator?: string;
    role?: string;
    confirmation?: string;
    reason?: string;
    reviewedFingerprint?: string;
}
export function previewExceptionAction(targetDir: string, id: string, action: "approve" | "revoke") {
    const context = load(targetDir), exception = context.state.current_stage_detail.exceptions.find(e => e.exception_id === id);
    if (!exception)
        throw new ControllerError("EXCEPTION_NOT_FOUND", "Exception does not exist.");
    localOnly(context.manifest);
    const binding = action === "revoke" ? { commit: exception.ratification_commit } : proof(context.root, context.manifest);
    const documentHash = action === "revoke" ? exception.proposal_hash : inspectAndHashEvidenceFile(context.root, exception.path).fileHash;
    return {
        project: context.state.project_id, milestone: context.state.milestone_id, stage: context.state.current_stage,
        exception: exception.exception_id, target: exception.waived_requirement, expiry: exception.expiration_date,
        documentHash, ratificationCommit: binding.commit,
        fingerprint: sha256(JSON.stringify([context.stateRaw, context.manifestRaw, documentHash, binding.commit]))
    };
}
export function previewLocalMigration(targetDir: string, ratificationRoot?: string) {
    const context = load(targetDir);
    localOnly(context.manifest);
    const proofRoot = fs.realpathSync(path.resolve(context.root, ratificationRoot || "."));
    const binding = verifyLocalRatification(proofRoot);
    return {
        project: context.state.project_id, root: context.root, proofRoot, commit: binding.commit, from: context.state.schema_version, to: "1.1.0",
        legacyAuthorityToWithdraw: context.state.current_stage_detail.exceptions.filter(e => e.status === "active").map(e => e.exception_id),
        effect: "Legacy active waivers are withdrawn, not grandfathered. History and backups remain; new proposals require fresh operator authorization.",
        fingerprint: sha256(JSON.stringify([context.stateRaw, context.manifestRaw, proofRoot, binding.commit]))
    };
}
/** Guards real operator-only mutations using real streams; no injectable isTTY flag. */
export async function executeExceptionAction(options: ExceptionCommandOptions) {
    if (["approve", "revoke"].includes(options.action))
        assertRatificationTerminal();
    const context = load(options.targetDir), { root, state, manifest, validator } = context;
    if (state.schema_version !== "1.1.0" || manifest.schema_version !== "1.1.0")
        throw new ControllerError("EXCEPTION_MIGRATION_REQUIRED", "Run explicit exception migration first.");
    localOnly(manifest);
    const originalException = state.current_stage_detail.exceptions.find(e => e.exception_id === options.id);
    const ratification = options.action === "revoke" ? { commit: originalException?.ratification_commit || "" } : proof(root, manifest);
    const existing = state.current_stage_detail.exceptions.find(e => e.exception_id === options.id);
    let documentPath = options.documentPath || existing?.path;
    if (!documentPath)
        throw new ControllerError("EXCEPTION_DOCUMENT_REQUIRED", "Proposal document path is required.");
    const document = options.action === "revoke" ? { relativePath: documentPath, absolutePath: path.resolve(root, documentPath), fileHash: existing?.proposal_hash || "" } : inspectAndHashEvidenceFile(root, documentPath);
    documentPath = document.relativePath;
    const now = new Date().toISOString();
    if (["approve", "revoke"].includes(options.action)) {
        const expected = sha256(JSON.stringify([context.stateRaw, context.manifestRaw, document.fileHash, ratification.commit]));
        if (options.reviewedFingerprint !== expected)
            throw new ControllerError("EXCEPTION_REVIEW_CHANGED", "Present and review the exact proposal before confirmation.");
    }
    let metadata: ExceptionActionInput["metadata"];
    if (options.action === "propose") {
        const parsed = validateExceptionDocumentAst(fs.readFileSync(document.absolutePath, "utf8"), documentPath, options.targetId, new Date(now), "proposal");
        if (!parsed.valid || !parsed.metadata)
            throw new ControllerError("EXCEPTION_DOCUMENT_INVALID", parsed.errors.join("; "));
        metadata = parsed.metadata;
    }
    if (existing?.status === "active" && options.action !== "revoke")
        verifyExceptionAuthority(root, state, manifest, existing);
    const target = state.current_stage_detail.deliverables.find(d => d.id === existing?.waived_requirement);
    let verification: ExceptionActionInput["verification"];
    if (options.action === "remediate") {
        if (!target || !existing?.remediation_id || !existing.remediation_started_at || !existing.remediation_sequence)
            throw new ControllerError("REMEDIATION_NOT_STARTED", "Record remediation initiation first.");
        const fresh: Deliverable = {
            ...target, status: "in_progress", validation_status: "unvalidated", evidence: target.evidence.filter(e => e.remediation_ref === existing.remediation_id && (e.sequence || 0) > existing.remediation_sequence! &&
                Date.parse(e.verified_at) > Date.parse(existing.remediation_started_at!) && Date.parse(e.verified_at) > Date.parse(existing.authorized_at!) &&
                state.audit_trail?.some(a => a.action === "EVIDENCE_RECORDED" && a.sequence === e.sequence && a.deliverable_id === target.id && a.timestamp === e.verified_at))
        };
        verification = resolveAuthoritativeVerification(root, state.current_stage, fresh, manifest, state.current_stage_detail.deliverables, new Date(now));
    }
    else if (options.action === "revoke" && target) {
        // Failure to verify historic evidence cannot prevent an operator from withdrawing authority.
        try {
            verification = resolveAuthoritativeVerification(root, state.current_stage, target, manifest, state.current_stage_detail.deliverables, new Date(now));
        }
        catch { /* revoke still invalidates waiver */ }
    }
    const plan = planExceptionAction(state, {
        ...options, actor: "agent:cli", now, documentPath, documentHash: document.fileHash,
        ratificationCommit: ratification.commit, metadata, verification
    });
    if (!validator.validateState(plan.state).valid)
        throw new ControllerError("STATE_SCHEMA_INVALID", "Exception transition failed schema validation.");
    const event = plan.state.audit_trail!.at(-1)!;
    const operations: FileOperationSpec[] = [
        { operation: "write", targetPath: ".playbook/state.json", content: JSON.stringify(plan.state, null, 2) + "\n", expectedPreviousSha256: sha256(context.stateRaw) },
        { operation: "write", targetPath: `.playbook/logs/exception-${event.sequence}-${randomUUID()}.json`, content: JSON.stringify(event, null, 2) + "\n", createOnly: true },
    ];
    if (plan.sidecar)
        operations.push({ operation: "write", targetPath: plan.sidecar.path, content: plan.sidecar.content, createOnly: true });
    const transaction = await new WriteAheadTransactionManager({ targetDir: root }).withTransaction(event.action, operations, async () => {
        if (["approve", "revoke"].includes(options.action))
            assertRatificationTerminal();
        if (sha256(fs.readFileSync(path.join(root, ".playbook/manifest.json"))) !== sha256(context.manifestRaw) ||
            (options.action !== "revoke" && (inspectAndHashEvidenceFile(root, documentPath!).fileHash !== document.fileHash || proof(root, manifest).commit !== ratification.commit))) {
            throw new ControllerError("EXCEPTION_INPUT_CHANGED", "Authorization inputs changed before commit.");
        }
    });
    return { exception: plan.exception, deliverable: plan.state.current_stage_detail.deliverables.find(d => d.id === plan.exception.waived_requirement), txId: transaction.txId };
}
export async function migrateLocalExceptions(targetDir: string, ratificationRoot: string | undefined, operator: string, role: string, confirmation: string, reviewedFingerprint: string) {
    assertRatificationTerminal();
    assertExceptionOperator(operator, role, confirmation, "CONFIRM MIGRATION LOCAL EXCEPTIONS");
    const context = load(targetDir), { root, state, manifest, validator } = context;
    localOnly(manifest);
    if (state.schema_version !== "1.0.0" || manifest.schema_version !== "1.0.0")
        throw new ControllerError("MIGRATION_VERSION_UNSUPPORTED", "Only explicit 1.0.0 to 1.1.0 migration is supported.");
    if (state.stage_status !== "in_progress") {
        throw new ControllerError("EXCEPTION_MIGRATION_UNVERIFIED", "Migration requires an in-progress project; no implicit grandfathering.");
    }
    const proofRoot = fs.realpathSync(path.resolve(root, ratificationRoot || "."));
    const ratification = verifyLocalRatification(proofRoot);
    if (sha256(JSON.stringify([context.stateRaw, context.manifestRaw, proofRoot, ratification.commit])) !== reviewedFingerprint)
        throw new ControllerError("MIGRATION_REVIEW_CHANGED", "Migration inputs changed after review.");
    const next = structuredClone(state), nextManifest = structuredClone(manifest), now = new Date().toISOString();
    next.schema_version = "1.1.0";
    next.transaction_sequence = 1;
    next.audit_trail = [{ action: "MIGRATE_LOCAL_EXCEPTIONS", sequence: 1, timestamp: now, actor: operator, actor_type: "human_interactive", reason: `Ratified specification ${ratification.commit}` }];
    for (const exception of next.current_stage_detail.exceptions.filter(e => e.status === "active")) {
        exception.status = "revoked";
        exception.revoked_at = now;
        exception.revoked_by = operator;
        exception.revocation_reason = "Legacy documentary authority withdrawn by explicit migration; propose a new ID and obtain fresh authorization.";
        next.transaction_sequence = (next.transaction_sequence || 0) + 1;
        next.audit_trail.push({ action: "EXCEPTION_MIGRATION_REVOKED", sequence: next.transaction_sequence!, timestamp: now, actor: operator, actor_type: "human_interactive", reason: exception.revocation_reason, exception_id: exception.exception_id, deliverable_id: exception.waived_requirement, prior_authorization_ref: null });
    }
    for (const target of next.current_stage_detail.deliverables.filter(d => d.status === "waived")) {
        target.status = "in_progress";
        target.validation_status = "unvalidated";
        target.exception_ref = null;
    }
    next.last_updated = { timestamp: now, updated_by: operator, actor_type: "human", reason: "Explicit local exception schema migration with preserved backups." };
    nextManifest.schema_version = "1.1.0";
    nextManifest.playbook.ratification_root = proofRoot === root ? "." : proofRoot;
    if (!validator.validateState(next).valid || !validator.validateManifest(nextManifest).valid)
        throw new ControllerError("MIGRATION_SCHEMA_INVALID", "Transformed files failed validation.");
    const backup = `.playbook/migrations/${Date.now()}-${randomUUID()}`;
    const tx = await new WriteAheadTransactionManager({ targetDir: root }).withTransaction("MIGRATE_LOCAL_EXCEPTIONS", [
        { operation: "write", targetPath: `${backup}/state.json`, content: context.stateRaw, createOnly: true, readOnlyOnCommit: true },
        { operation: "write", targetPath: `${backup}/manifest.json`, content: context.manifestRaw, createOnly: true, readOnlyOnCommit: true },
        { operation: "write", targetPath: `${backup}/inventory.json`, content: JSON.stringify({ state: sha256(context.stateRaw), manifest: sha256(context.manifestRaw), ratification_commit: ratification.commit }, null, 2) + "\n", createOnly: true, readOnlyOnCommit: true },
        { operation: "write", targetPath: ".playbook/state.json", content: JSON.stringify(next, null, 2) + "\n", expectedPreviousSha256: sha256(context.stateRaw) },
        { operation: "write", targetPath: ".playbook/manifest.json", content: JSON.stringify(nextManifest, null, 2) + "\n", expectedPreviousSha256: sha256(context.manifestRaw) },
        { operation: "write", targetPath: `.playbook/logs/migration-${randomUUID()}.json`, content: JSON.stringify(next.audit_trail, null, 2) + "\n", createOnly: true },
    ], async () => { assertRatificationTerminal(); if (verifyLocalRatification(proofRoot).commit !== ratification.commit)
        throw new ControllerError("RATIFICATION_BINDING_CHANGED", "Ratification changed before migration."); });
    return { schemaVersion: "1.1.0", backup, txId: tx.txId };
}
