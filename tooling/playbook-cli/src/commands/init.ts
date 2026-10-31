import fs from "node:fs";
import path from "node:path";
import {
  VALID_GOVERNANCE_PROFILES,
  VALID_APPROVAL_MODES,
  type GovernanceProfile,
  type ApprovalMode,
  type Capability,
  DEFAULT_PATHS,
} from "../constants.js";
import { ProjectScaffolder, OverwriteProtectionError } from "../core/scaffold.js";
import { createInitialManifest } from "../templates/manifest-template.js";
import { createInitialState } from "../templates/state-template.js";
import { TerminalPrompter, type PromptInterface } from "../utils/prompt.js";

export interface InitCommandOptions {
  cwd?: string;
  projectId?: string;
  name?: string;
  description?: string;
  ecosystem?: string;
  language?: string;
  profile?: GovernanceProfile;
  approvalMode?: ApprovalMode;
  milestone?: string;
  capabilities?: Capability[];
  force?: boolean;
  nonInteractive?: boolean;
  prompter?: PromptInterface;
}

export function detectProjectDefaults(targetDir: string): {
  defaultId: string;
  defaultName: string;
  detectedEcosystem: string;
  detectedLanguage: string;
} {
  const dirName = path.basename(path.resolve(targetDir));
  const defaultId = dirName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "my-project";
  const defaultName = defaultId
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");

  let detectedEcosystem = "agnostic";
  let detectedLanguage = "agnostic";

  if (fs.existsSync(path.join(targetDir, "package.json"))) {
    detectedEcosystem = "node";
    detectedLanguage = fs.existsSync(path.join(targetDir, "tsconfig.json")) ? "typescript" : "javascript";
  } else if (
    fs.existsSync(path.join(targetDir, "requirements.txt")) ||
    fs.existsSync(path.join(targetDir, "pyproject.toml"))
  ) {
    detectedEcosystem = "python";
    detectedLanguage = "python";
  } else if (fs.existsSync(path.join(targetDir, "Cargo.toml"))) {
    detectedEcosystem = "rust";
    detectedLanguage = "rust";
  } else if (fs.existsSync(path.join(targetDir, "go.mod"))) {
    detectedEcosystem = "go";
    detectedLanguage = "go";
  }

  return { defaultId, defaultName, detectedEcosystem, detectedLanguage };
}

export async function runInit(options: InitCommandOptions): Promise<{ success: boolean; message: string }> {
  const targetDir = path.resolve(options.cwd || process.cwd());
  const scaffolder = new ProjectScaffolder();

  const isInteractive =
    !options.nonInteractive &&
    Boolean(process.stdin.isTTY) &&
    !options.projectId;

  const prompter = options.prompter || new TerminalPrompter();

  try {
    // 1. Check existing governance state
    const existing = scaffolder.checkExisting(targetDir);
    let allowForce = options.force || false;

    if (existing.exists && !allowForce) {
      if (isInteractive) {
        console.log(`\nExisting governance state detected in ${targetDir}:`);
        for (const file of existing.files) {
          console.log(`  - ${path.basename(file)}`);
        }
        const confirmOverwrite = await prompter.confirm("Overwrite existing governance configuration?", false);
        if (!confirmOverwrite) {
          prompter.close();
          return {
            success: false,
            message: "Initialization aborted by user. Existing governance files were preserved.",
          };
        }
        allowForce = true;
      } else {
        throw new OverwriteProtectionError(
          `Governance state already exists in ${targetDir}. Pass --force to overwrite.`,
          existing.files
        );
      }
    }

    // 2. Resolve project configuration
    const defaults = detectProjectDefaults(targetDir);

    let projectId = options.projectId;
    let projectName = options.name;
    let description = options.description;
    let ecosystem = options.ecosystem;
    let language = options.language;
    let profile = options.profile;
    let approvalMode = options.approvalMode;
    let milestone = options.milestone;

    if (isInteractive) {
      console.log("\n--- AI Engineering Playbook Project Initialization ---\n");

      // Validate project_id format
      const idPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
      while (!projectId || !idPattern.test(projectId)) {
        const inputId = await prompter.ask("Project identifier (kebab-case)", defaults.defaultId);
        if (idPattern.test(inputId)) {
          projectId = inputId;
        } else {
          console.log("Error: Project ID must be lowercase alphanumeric with hyphens (e.g. 'my-app', 'zentrix-lms').");
        }
      }

      projectName = await prompter.ask("Project display name", defaults.defaultName);
      description = await prompter.ask("Project description", `${projectName} - governed by AI Engineering Playbook`);

      ecosystem = await prompter.ask("Target ecosystem (node, python, go, rust, agnostic)", defaults.detectedEcosystem);
      language = await prompter.ask("Primary programming language (typescript, python, go, agnostic)", defaults.detectedLanguage);

      profile = await prompter.select(
        "Governance profile",
        VALID_GOVERNANCE_PROFILES,
        options.profile || "standard"
      );

      approvalMode = await prompter.select(
        "Gate approval mode",
        VALID_APPROVAL_MODES,
        options.approvalMode || "solo"
      );

      milestone = await prompter.ask("Active milestone identifier", options.milestone || "M-1.0.0");
    } else {
      // Non-interactive fallback
      projectId = projectId || defaults.defaultId;
      projectName = projectName || defaults.defaultName;
      description = description || `${projectName} - governed by AI Engineering Playbook`;
      ecosystem = ecosystem || defaults.detectedEcosystem;
      language = language || defaults.detectedLanguage;
      profile = profile || "standard";
      approvalMode = approvalMode || "solo";
      milestone = milestone || "M-1.0.0";
    }

    // 3. Generate Manifest & State
    const manifest = createInitialManifest({
      projectId,
      projectName,
      description,
      ecosystem,
      primaryLanguage: language,
      governanceProfile: profile,
      approvalMode,
      activeMilestoneId: milestone,
      capabilities: options.capabilities,
    });

    const state = createInitialState({
      projectId,
      milestoneId: milestone,
      milestoneName: `${milestone} Initial Release`,
      approvalMode,
      actor: "playbook-cli",
      actorType: "human",
    });

    // 4. Scaffold directories and files
    const result = scaffolder.scaffold({
      targetDir,
      manifest,
      state,
      force: allowForce,
      createGitkeeps: true,
    });

    prompter.close();

    // 5. Output summary
    const summary = [
      "",
      "==================================================",
      " AI Engineering Playbook Initialized Successfully",
      "==================================================",
      ` Project ID:      ${projectId}`,
      ` Project Name:    ${projectName}`,
      ` Target Directory: ${targetDir}`,
      ` Milestone:       ${milestone}`,
      ` Active Stage:    Stage 0 (Discovery & Problem Formulation)`,
      ` Governance:      ${profile} profile, ${approvalMode} approval mode`,
      ` Tech Stack:      ${ecosystem} / ${language}`,
      "",
      " Governed Artifacts Created:",
      `   ${path.relative(targetDir, result.manifestPath)} (Project Manifest)`,
      `   ${path.relative(targetDir, result.statePath)} (Machine-Readable State)`,
      `   ${DEFAULT_PATHS.docsRoot}/prd/ (Product Requirements)`,
      `   ${DEFAULT_PATHS.docsRoot}/adr/ (Architecture Decisions)`,
      `   ${DEFAULT_PATHS.docsRoot}/rfcs/ (Clarification Requests)`,
      `   ${DEFAULT_PATHS.docsRoot}/gates/ (Stage Gate Exit Packages)`,
      `   ${DEFAULT_PATHS.docsRoot}/exceptions/ (Gate Exception Records)`,
      `   ${DEFAULT_PATHS.logsDir}/ (Verification Logs & Proof Evidence)`,
      "",
      " Next Steps:",
      "   1. Author initial problem statement in docs/prd/PRD-CORE.md",
      "   2. AI Agents: review AGENTS.md and execute lifecycle sequentially.",
      "==================================================",
      "",
    ].join("\n");

    console.log(summary);

    return {
      success: true,
      message: `Project ${projectId} initialized successfully at Stage 0.`,
    };
  } catch (err: unknown) {
    prompter.close();
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      message,
    };
  }
}
