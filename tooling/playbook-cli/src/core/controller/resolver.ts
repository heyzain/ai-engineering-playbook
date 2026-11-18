import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PATHS,
  VALID_GOVERNANCE_PROFILES,
  type StageNumber,
  type GovernanceProfile,
} from "../../constants.js";
import type { Deliverable, EvidenceRecord, ProjectState } from "../../types/state.js";
import type { ProjectManifest } from "../../types/manifest.js";
import { getStageBaselineDeliverables } from "../stage-defaults.js";
import {
  loadQualityGatesConfig,
  getStageQualityGate,
  filterChecksForProfile,
  QualityGateConfigError,
} from "../quality-gates/config.js";
import { ControllerError, type AuthoritativeResolutionResult } from "./types.js";
import {inspectAndHashEvidenceFile} from "./fs-security.js";
import {configurationFingerprint,toolFingerprint} from "../quality-gates/evidence-binding.js";
import {computeRif} from "../quality-gates/rif.js";
import {inspectWorkingTree} from "../quality-gates/policy.js";

function baselineDisciplines(stage:StageNumber,deliverable:Deliverable):string[] {
  if (!getStageBaselineDeliverables(stage).some(d=>d.id===deliverable.id)) {
    throw new ControllerError("REQUIRED_DISCIPLINES_INDETERMINATE","Custom deliverables need explicit blocking checks for the selected profile.");
  }
  return stage===3 || stage===4 ? ["automated_test"] : [];
}

/**
 * Resolves authoritative governance profile using the accepted 3-tier precedence:
 * 1. manifest.playbook.governance_profile
 * 2. qualityGatesConfig.default_profile
 * 3. "standard" fallback
 *
 * Fails closed on malformed or inconsistent profile configurations.
 */
export function resolveGovernanceProfile(
  targetDir: string,
  manifest?: ProjectManifest | null
): GovernanceProfile {
  // Tier 1: Explicit manifest governance_profile
  if (manifest?.playbook?.governance_profile) {
    const prof = manifest.playbook.governance_profile;
    if (!VALID_GOVERNANCE_PROFILES.includes(prof as GovernanceProfile)) {
      throw new ControllerError(
        "GOVERNANCE_PROFILE_INVALID",
        `Invalid governance profile "${prof}" in manifest. Must be one of: ${VALID_GOVERNANCE_PROFILES.join(", ")}.`,
        { profile: prof }
      );
    }
    return prof as GovernanceProfile;
  }

  // Tier 2: qualityGatesConfig.default_profile
  const qgPath = path.resolve(targetDir, DEFAULT_PATHS.playbookDir, "quality-gates.json");
  if (fs.existsSync(qgPath)) {
    let qgConfig;
    try {
      qgConfig = loadQualityGatesConfig(targetDir);
    } catch (err: unknown) {
      if (err instanceof ControllerError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new ControllerError(
        "QUALITY_GATE_DEFINITION_INVALID",
        `Quality gates configuration at "${qgPath}" is malformed or invalid: ${msg}`,
        { error: msg }
      );
    }

    if (qgConfig && qgConfig.default_profile) {
      if (!VALID_GOVERNANCE_PROFILES.includes(qgConfig.default_profile as GovernanceProfile)) {
        throw new ControllerError(
          "GOVERNANCE_PROFILE_INVALID",
          `Invalid default_profile "${qgConfig.default_profile}" in quality-gates.json. Must be one of: ${VALID_GOVERNANCE_PROFILES.join(", ")}.`,
          { profile: qgConfig.default_profile }
        );
      }
      return qgConfig.default_profile as GovernanceProfile;
    }
  }

  // Tier 3: Default fallback
  return "standard";
}

/**
 * Resolves the required verification disciplines for a given deliverable.
 *
 * Canonical Source Resolution:
 * 1. Primary Authority: `.playbook/quality-gates.json` conforming to `schemas/quality-gates.schema.json`.
 *    Inspects `gates[stage].checks[]` matching `check.deliverable_id === deliverable.id`.
 * 2. Fallback Baseline: `governance/stage-gate-rules.md` (and compiled `stage-defaults.ts`).
 *    Applies baseline requirements for standard deliverables when quality-gates.json is absent.
 * 3. Fail-Closed on Indeterminate / Malformed / Inconsistent definitions:
 *    - Missing configuration for custom deliverables -> REQUIRED_DISCIPLINES_INDETERMINATE
 *    - Malformed quality-gates.json -> QUALITY_GATE_DEFINITION_INVALID
 *    - Checks referencing undeclared deliverables -> QUALITY_GATE_INCONSISTENT
 */
export function getRequiredDisciplinesForDeliverable(
  targetDir: string,
  stage: StageNumber,
  deliverable: Deliverable,
  manifest?: ProjectManifest | null,
  allDeclaredDeliverables?: Deliverable[]
): string[] {
  const qgPath = path.resolve(targetDir, DEFAULT_PATHS.playbookDir, "quality-gates.json");

  if (fs.existsSync(qgPath)) {
    let qgConfig;
    try {
      qgConfig = loadQualityGatesConfig(targetDir);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ControllerError(
        "QUALITY_GATE_DEFINITION_INVALID",
        `Quality gates configuration at "${qgPath}" is malformed or invalid: ${msg}`,
        { error: msg }
      );
    }

    const stageGate = getStageQualityGate(qgConfig, stage);
    if (!stageGate) {
      // Stage has no checks defined in config
      return baselineDisciplines(stage,deliverable);
    }

    // Verify consistency: check if any check references undeclared deliverables
    if (allDeclaredDeliverables && allDeclaredDeliverables.length > 0) {
      const declaredIds = new Set(allDeclaredDeliverables.map((d) => d.id));
      for (const check of stageGate.checks) {
        if (!declaredIds.has(check.deliverable_id)) {
          throw new ControllerError(
            "QUALITY_GATE_INCONSISTENT",
            `Quality gate check "${check.id}" references undeclared deliverable "${check.deliverable_id}" in stage ${stage}.`,
            { check_id: check.id, deliverable_id: check.deliverable_id, stage }
          );
        }
      }
    }

    const profile = resolveGovernanceProfile(targetDir, manifest);
    const applicableChecks = filterChecksForProfile(stageGate.checks, profile);
    const matchingChecks = applicableChecks.filter((c) => c.deliverable_id === deliverable.id);

    const requiredTypes = new Set<string>();
    for (const c of matchingChecks) {
      // Non-blocking checks (warning, advisory) do not establish mandatory verification disciplines
      if (c.severity === "warning" || c.severity === "advisory") {
        continue;
      }
      requiredTypes.add(c.type);
    }

    return requiredTypes.size ? Array.from(requiredTypes) : baselineDisciplines(stage,deliverable);
  }

  // Fallback Baseline: quality-gates.json does NOT exist
  const baselineDeliverables = getStageBaselineDeliverables(stage);
  const isBaseline = baselineDeliverables.some((d) => d.id === deliverable.id);

  if (!isBaseline) {
    // Custom deliverable without declarative quality-gates.json: fail-closed!
    throw new ControllerError(
      "REQUIRED_DISCIPLINES_INDETERMINATE",
      `Deliverable "${deliverable.id}" is a custom deliverable but no quality-gates.json exists to define its required verification disciplines. Declarative quality gate definition is required.`,
      { deliverable_id: deliverable.id, stage }
    );
  }

  // Baseline discipline requirements per stage-gate-rules.md
  if (stage === 3 || stage === 4) {
    return ["automated_test"];
  }

  // Document deliverables (stages 0, 1, 2, 5, 6) accept document verification disciplines
  return [];
}

/**
 * Deterministically evaluates the authoritative current verification result for a deliverable.
 *
 * Implements the accepted 6-step deterministic contract:
 * 1. Cutoff calculation from invalidation history (if any).
 * 2. Clock-skew anomaly protection (rejecting timestamps > now + 60s).
 * 3. 3-tier deterministic tie-breaking per discipline:
 *    - Tier 1: Highest verified_at timestamp (DESC)
 *    - Tier 2: Highest array index in deliverable.evidence[] (DESC) [Local sorting tie-breaker only]
 *    - Tier 3: Lexicographical order on evidence_hash and evidence_ref (DESC)
 * 4. Required discipline evaluation against canonical source.
 * 5. Fail-closed on missing, failed, or inconclusive disciplines.
 */
export function resolveAuthoritativeVerification(
  targetDir: string,
  stage: StageNumber,
  deliverable: Deliverable,
  manifest?: ProjectManifest | null,
  allDeclaredDeliverables?: Deliverable[],
  now: Date = new Date()
): AuthoritativeResolutionResult {
  const nowMs = now.getTime();
  const maxFutureToleranceMs = 60_000; // 60s clock skew tolerance

  const requiredDisciplines = getRequiredDisciplinesForDeliverable(
    targetDir,
    stage,
    deliverable,
    manifest,
    allDeclaredDeliverables
  );

  const rawEvidence = deliverable.evidence || [];

  // Clock skew validation
  for (const ev of rawEvidence) {
    const evTime = new Date(ev.verified_at).getTime();
    if (isNaN(evTime)) {
      throw new ControllerError(
        "EVIDENCE_TIMESTAMP_INVALID",
        `Evidence record for deliverable "${deliverable.id}" has invalid timestamp: "${ev.verified_at}".`,
        { deliverable_id: deliverable.id, verified_at: ev.verified_at }
      );
    }
    if (evTime > nowMs + maxFutureToleranceMs) {
      throw new ControllerError(
        "CLOCK_SKEW_DETECTED",
        `Evidence record for deliverable "${deliverable.id}" has timestamp in the future: "${ev.verified_at}" (skew > 60s).`,
        { deliverable_id: deliverable.id, verified_at: ev.verified_at, current_time: now.toISOString() }
      );
    }
  }

  // Filter eligible evidence (must be chronological and valid)
  const eligibleEvidenceWithIndex = rawEvidence
    .map((ev, index) => ({ ev, index, time: new Date(ev.verified_at).getTime() }))
    .filter((item) => item.time <= nowMs + maxFutureToleranceMs);

  if (eligibleEvidenceWithIndex.length === 0) {
    return {
      authoritativeResult: "unverified",
      missingRequiredDisciplines: requiredDisciplines,
      failingDisciplines: [],
      evaluatedDisciplines: {},
      isContended: deliverable.status === "verified",
      blockingReasons: [`Deliverable "${deliverable.id}" has zero verification evidence records.`],
    };
  }

  // Group by discipline/type
  const disciplineGroups = new Map<
    string,
    Array<{ ev: EvidenceRecord; index: number; time: number }>
  >();

  for (const item of eligibleEvidenceWithIndex) {
    const type = item.ev.type;
    const existing = disciplineGroups.get(type) || [];
    existing.push(item);
    disciplineGroups.set(type, existing);
  }

  // Apply deterministic 3-tier tie-breaking per discipline
  const evaluatedDisciplines: AuthoritativeResolutionResult["evaluatedDisciplines"] = {};

  for (const [type, items] of disciplineGroups.entries()) {
    items.sort((a, b) => {
      // Tier 1: Latest verified_at timestamp
      if (b.time !== a.time) {
        return b.time - a.time;
      }
      // Tier 2: Highest array index in evidence[] (deterministic local tie-breaker)
      if (b.index !== a.index) {
        return b.index - a.index;
      }
      // Tier 3: Lexicographical order on evidence_hash and evidence_ref
      const hashA = a.ev.evidence_hash || "";
      const hashB = b.ev.evidence_hash || "";
      if (hashA !== hashB) {
        return hashB.localeCompare(hashA);
      }
      return b.ev.evidence_ref.localeCompare(a.ev.evidence_ref);
    });

    const authoritativeItem = items[0].ev;
    evaluatedDisciplines[type] = {
      latestResult: authoritativeItem.result,
      verifiedAt: authoritativeItem.verified_at,
      evidenceRef: authoritativeItem.evidence_ref,
      evidenceHash: authoritativeItem.evidence_hash,
    };
  }

  // Check required disciplines
  const missingRequiredDisciplines: string[] = [];
  for (const reqDisc of requiredDisciplines) {
    if (!evaluatedDisciplines[reqDisc]) {
      missingRequiredDisciplines.push(reqDisc);
    }
  }

  // Check failing and inconclusive disciplines
  const failingDisciplines: string[] = [];
  let hasInconclusive = false;
  const blockingReasons: string[] = [];
  const issues:NonNullable<AuthoritativeResolutionResult["issues"]>=[];

  // Every applicable blocking check must have its own exact, fresh proof.
  const configPath=path.join(targetDir,".playbook/quality-gates.json");
  if (fs.existsSync(configPath)) {
    const config=loadQualityGatesConfig(targetDir);
    const profile=resolveGovernanceProfile(targetDir,manifest);
    const checks=filterChecksForProfile(getStageQualityGate(config,stage)?.checks || [],profile)
      .filter(c=>c.deliverable_id===deliverable.id && c.severity!=="warning" && c.severity!=="advisory");
    const actualManifest=manifest || JSON.parse(fs.readFileSync(path.join(targetDir,".playbook/manifest.json"),"utf8")) as ProjectManifest;
    for (const check of checks) {
      const candidates=eligibleEvidenceWithIndex.filter(item=>item.ev.type===check.type && item.ev.quality_gate?.check_id===check.id && item.ev.quality_gate?.gate_id===`gate-stage-${stage}`)
        .sort((a,b)=>b.time-a.time || b.index-a.index);
      const latest=candidates[0]?.ev;
      const key=`check:${check.id}`;
      if (!latest) {missingRequiredDisciplines.push(key);continue;}
      if (latest.result==="failed") {failingDisciplines.push(key);continue;}
      if (latest.result!=="passed") {hasInconclusive=true;continue;}
      try {
        if (!latest.evidence_hash || inspectAndHashEvidenceFile(targetDir,latest.evidence_ref).fileHash!==latest.evidence_hash) throw new Error("Evidence hash changed.");
        if (latest.quality_gate?.config_hash!==configurationFingerprint(targetDir,actualManifest)) throw new Error("Effective check/profile configuration changed.");
        if (latest.quality_gate?.tool_fingerprint!==toolFingerprint(targetDir,check)) throw new Error("Tool executable or entry script changed.");
        const current=computeRif({projectDir:targetDir,check,toolVersion:latest.quality_gate?.tool_version,
          workingTreeClean:inspectWorkingTree(targetDir,"local").isClean,ambientEnv:process.env,sensitivePatterns:config.global_settings.sensitive_patterns});
        if (!latest.rif || current.rif!==latest.rif || current.secret_freshness_unbounded) throw new Error("Input/environment fingerprint is stale or unbounded.");
      } catch (error) {failingDisciplines.push(key);blockingReasons.push(`${key}: ${error instanceof Error?error.message:String(error)}`);}
    }
  }

  // Latest authoritative evidence is rehashed even without a declarative gate.
  if (!fs.existsSync(configPath)) for (const [discipline,info] of Object.entries(evaluatedDisciplines)) {
    if (requiredDisciplines.length && !requiredDisciplines.includes(discipline)) continue;
    try {
      const automated=["automated_test","build_typecheck","static_analysis","schema_validation","security_audit"].includes(discipline);
      if (!info.evidenceHash && automated) throw new ControllerError("EVIDENCE_HASH_MISMATCH","Automated evidence requires a recorded SHA-256 hash.");
      const actual=inspectAndHashEvidenceFile(targetDir,info.evidenceRef).fileHash;
      if (info.evidenceHash && actual!==info.evidenceHash) throw new ControllerError("EVIDENCE_HASH_MISMATCH","Evidence bytes no longer match.");
    } catch (error) {
      failingDisciplines.push(discipline);blockingReasons.push(error instanceof Error?error.message:String(error));
      const rawCode=error instanceof ControllerError?error.code:"EVIDENCE_HASH_MISMATCH";
      issues.push({code:rawCode==="EVIDENCE_FILE_NOT_FOUND"?"EVIDENCE_FILE_MISSING":rawCode,message:error instanceof Error?error.message:String(error),ref:info.evidenceRef});
    }
  }

  for (const [disc, info] of Object.entries(evaluatedDisciplines)) {
    const isRequiredOrBaseline = requiredDisciplines.includes(disc) || requiredDisciplines.length === 0;
    if (info.latestResult === "failed") {
      if (isRequiredOrBaseline) {
        issues.push({code:"EVIDENCE_RESULT_FAILED",message:`Latest ${disc} proof failed.`,ref:info.evidenceRef});
        failingDisciplines.push(disc);
        blockingReasons.push(
          `Discipline "${disc}" authoritative verification result is "failed" (recorded at ${info.verifiedAt}, ref: "${info.evidenceRef}").`
        );
      }
    } else if (info.latestResult === "inconclusive") {
      if (isRequiredOrBaseline) {
        issues.push({code:"EVIDENCE_RESULT_FAILED",message:`Latest ${disc} proof is inconclusive.`,ref:info.evidenceRef});
        hasInconclusive = true;
        blockingReasons.push(
          `Discipline "${disc}" authoritative verification result is "inconclusive" (recorded at ${info.verifiedAt}).`
        );
      }
    }
  }

  if (missingRequiredDisciplines.length > 0) {
    for (const m of missingRequiredDisciplines) {
      blockingReasons.push(`Missing required verification discipline: "${m}".`);
    }
  }

  let authoritativeResult: AuthoritativeResolutionResult["authoritativeResult"];
  if (failingDisciplines.length > 0) {
    authoritativeResult = "failed";
  } else if (hasInconclusive) {
    authoritativeResult = "inconclusive";
  } else if (missingRequiredDisciplines.length > 0) {
    authoritativeResult = "unverified";
  } else {
    authoritativeResult = "passed";
  }

  const isContended = deliverable.status === "verified" && authoritativeResult !== "passed";

  return {
    authoritativeResult,
    issues,
    missingRequiredDisciplines,
    failingDisciplines,
    evaluatedDisciplines,
    isContended,
    blockingReasons,
  };
}
