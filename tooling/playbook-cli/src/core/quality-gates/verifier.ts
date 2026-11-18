import fs from "node:fs";
import {configurationFingerprint,toolFingerprint} from "./evidence-binding.js";
import {inspectAndHashEvidenceFile} from "../controller/fs-security.js";
import {resolveAuthoritativeVerification,resolveGovernanceProfile} from "../controller/resolver.js";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_PATHS, type GovernanceProfile } from "../../constants.js";
import { SchemaValidator } from "../validator.js";
import type { ProjectState } from "../../types/state.js";
import type { ProjectManifest } from "../../types/manifest.js";
import type {
  QualityGatesConfig,
  QualityGateStage,
  QualityGateVerifyReport,
} from "../../types/quality-gates.js";
import {
  loadQualityGatesConfig,
  getStageQualityGate,
  filterChecksForProfile,
  QualityGateConfigError,
} from "./config.js";
import { computeRif } from "./rif.js";
import { inspectWorkingTree } from "./policy.js";

export class QualityGateVerifier {
  readonly targetDir: string;
  readonly playbookDir: string;
  readonly validator: SchemaValidator;

  constructor(targetDir?: string) {
    this.targetDir = path.resolve(targetDir || process.cwd());
    this.playbookDir = path.join(this.targetDir, DEFAULT_PATHS.playbookDir);
    this.validator = new SchemaValidator();
  }

  /**
   * Fast, read-only verification asserting whether all required quality checks
   * for the active stage have fresh, valid, unexpired evidence.
   * Zero filesystem or state mutations.
   */
  public verify(stageOverride?: number): QualityGateVerifyReport {
    const timestamp = new Date().toISOString();
    const manifestPath = path.join(this.playbookDir, "manifest.json");
    const statePath = path.join(this.playbookDir, "state.json");

    if (!fs.existsSync(manifestPath) || !fs.existsSync(statePath)) {
      throw new Error("Cannot verify quality gates: manifest.json or state.json missing.");
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ProjectManifest;
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as ProjectState;

    const targetStage = stageOverride !== undefined ? stageOverride : state.current_stage;
    const profile: GovernanceProfile = resolveGovernanceProfile(this.targetDir, manifest);

    const config = loadQualityGatesConfig(this.targetDir, { validator: this.validator });
    const stageGate = getStageQualityGate(config, targetStage);

    if (!stageGate) {
      return {
        timestamp,
        stage: targetStage,
        stage_name: `Stage ${targetStage}`,
        all_fresh: state.current_stage_detail.deliverables.length>0 && state.current_stage_detail.deliverables.every(d=>resolveAuthoritativeVerification(this.targetDir,state.current_stage,d,manifest,state.current_stage_detail.deliverables).authoritativeResult==="passed"),
        checks: [],
      };
    }

    const checks = filterChecksForProfile(stageGate.checks, profile);
    const treeStatus = inspectWorkingTree(this.targetDir, "local");

    const checkReports: QualityGateVerifyReport["checks"] = [];
    let allFresh = true;

    const deliverables = state.current_stage_detail?.deliverables || [];

    for (const check of checks) {
      const candidates=(deliverables.find(d=>d.id===check.deliverable_id)?.evidence || [])
        .map((e,index)=>({e,index})).filter(({e})=>e.type===check.type && e.quality_gate?.check_id===check.id && e.quality_gate?.gate_id===`gate-stage-${targetStage}`)
        .sort((a,b)=>Date.parse(b.e.verified_at)-Date.parse(a.e.verified_at) || b.index-a.index);
      const rifResult = computeRif({
        projectDir: this.targetDir,
        check,
        toolVersion:candidates[0]?.e.quality_gate?.tool_version,
        workingTreeClean: treeStatus.isClean,
        ambientEnv: process.env,
        sensitivePatterns: config.global_settings.sensitive_patterns,
      });
      const currentRif = rifResult.rif;

      const deliverable = deliverables.find((d) => d.id === check.deliverable_id);
      if (!deliverable) {
        if (check.severity !== "advisory" && check.severity !== "warning") allFresh = false;
        checkReports.push({
          check_id: check.id,
          deliverable_id: check.deliverable_id,
          is_fresh: false,
          current_rif: currentRif,
          recorded_rif: null,
          evidence_status: "missing_deliverable",
          log_exists: false,
          log_hash_matched: false,
          reason: `Deliverable '${check.deliverable_id}' not found in active stage.`,
        });
        continue;
      }

      const latestEvidence = candidates[0]?.e;

      if (!latestEvidence) {
        if (check.severity !== "advisory" && check.severity !== "warning") allFresh = false;
        checkReports.push({
          check_id: check.id,
          deliverable_id: check.deliverable_id,
          is_fresh: false,
          current_rif: currentRif,
          recorded_rif: null,
          evidence_status: "missing_evidence",
          log_exists: false,
          log_hash_matched: false,
          reason: `No evidence record found for check '${check.id}'.`,
        });
        continue;
      }

      // Check log existence and hash
      const logRelative = latestEvidence.evidence_ref;
      let logAbsolute="",logExists=false;
      try {logAbsolute=inspectAndHashEvidenceFile(this.targetDir,logRelative).absolutePath;logExists=true;}catch{ /* invalid/missing proof stays unverified */ }

      let logHashMatched = false;
      let recordedRif = latestEvidence.rif || null;

      if (logExists) {
        const logBuffer = fs.readFileSync(logAbsolute);
        const calcHash = `sha256:${crypto.createHash("sha256").update(logBuffer).digest("hex")}`;
        logHashMatched = calcHash.toLowerCase() === (latestEvidence.evidence_hash || "").toLowerCase();

        // If recorded rif was not in state directly, parse from log header
        if (!recordedRif) {
          const logStr = logBuffer.toString("utf-8");
          const rifMatch = logStr.match(/^RIF:\s+(sha256:[a-f0-9]{64})$/m);
          if (rifMatch) {
            recordedRif = rifMatch[1];
          }
        }
      }

      const isRifFresh = recordedRif !== null && recordedRif === currentRif;
      const isPassed = latestEvidence.result === "passed";
      const bound=latestEvidence.quality_gate?.config_hash===configurationFingerprint(this.targetDir,manifest) && latestEvidence.quality_gate?.tool_fingerprint===toolFingerprint(this.targetDir,check);
      const isCheckFresh = isRifFresh && logExists && logHashMatched && isPassed && bound && !rifResult.secret_freshness_unbounded;

      if (!isCheckFresh && check.severity!=="advisory" && check.severity!=="warning") {
        allFresh = false;
      }

      let reason: string | undefined;
      if (!bound) reason="Check configuration/profile or resolved tool binding is missing or stale.";
      else if (!logExists) {
        reason = `Evidence log file '${logRelative}' is missing from disk.`;
      } else if (!logHashMatched) {
        reason = `Evidence log file hash does not match recorded state hash.`;
      } else if (!isRifFresh) {
        reason = `Evidence is STALE: input files or environment changed (recorded RIF != current RIF).`;
      } else if (!isPassed) {
        reason = `Latest recorded evidence indicates check execution FAILED.`;
      } else if (rifResult.secret_freshness_unbounded) {
        reason = `Notice: Secret variable(s) [${rifResult.unbounded_secret_keys?.join(", ")}] have no _VERSION identifier; freshness cannot be fully guaranteed against secret rotations.`;
      }

      checkReports.push({
        check_id: check.id,
        deliverable_id: check.deliverable_id,
        is_fresh: isCheckFresh,
        current_rif: currentRif,
        recorded_rif: recordedRif,
        evidence_status: latestEvidence.result,
        log_exists: logExists,
        log_hash_matched: logHashMatched,
        reason,
      });
    }

    // Check for pending unrecovered WAL journal without mutating filesystem
    const journalPath = path.join(this.playbookDir, "tx-journal.json");
    const pendingRecovery = fs.existsSync(journalPath);
    const diagnostics: Array<{ code: string; severity: "warning" | "error" | "info"; message: string }> = [];

    if (pendingRecovery) {
      diagnostics.push({
        code: "PENDING_WAL_RECOVERY",
        severity: "warning",
        message:
          "An interrupted Write-Ahead Transaction Journal was detected at .playbook/tx-journal.json. Read-only verification does not perform crash recovery to preserve zero filesystem mutations. Run a state operation or operator recovery to finalize state.",
      });
    }

    return {
      timestamp,
      stage: targetStage,
      stage_name: stageGate.stage_name,
      all_fresh: allFresh,
      checks: checkReports,
      pending_recovery: pendingRecovery,
      diagnostics,
    };
  }
}
