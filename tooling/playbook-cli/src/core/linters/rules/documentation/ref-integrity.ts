import path from "node:path";
import fs from "node:fs";
import { toPosixPath, normalizeRelativePath } from "../../../../utils/paths.js";
import type { GovernanceRule, RuleFinding, RuleExecutionContext } from "../../types.js";

const EXTERNAL_URL_PREFIXES = [
  "http://",
  "https://",
  "mailto:",
  "ftp://",
  "irc://",
  "conversation://",
];

export const ruleDocRefIntegrity: GovernanceRule = {
  id: "RULE-DOC-REF-INTEGRITY",
  category: "documentation",
  name: "Markdown Reference Integrity",
  description:
    "Verifies that internal relative links in Markdown documents resolve to existing files within the repository boundary and do not escape root.",
  severity: "error",
  defaultEnforcement: "blocking",
  targetGlobs: ["**/*.md"],
  excludeGlobs: [
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    ".playbook/.tmp/**",
    ".playbook/logs/**",
  ],
  evaluationMethod: "markdown_ast",
  version: "1.0.0",
  remediation: "Correct the broken link path to reference an existing file or directory within the repository.",

  evaluate(context: RuleExecutionContext): RuleFinding[] {
    const findings: RuleFinding[] = [];
    const files = context.listFiles(ruleDocRefIntegrity.targetGlobs, ruleDocRefIntegrity.excludeGlobs);

    // Markdown link pattern: [text](target) or ![alt](target)
    const linkRegex = /(?:!\[([^\]]*)\]|\[([^\]]*)\])\(([^)]+)\)/g;
    // HTML link pattern: <a href="target">
    const htmlRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi;

    for (const relFile of files) {
      let content: string;
      try {
        content = context.readFile(relFile);
      } catch {
        continue;
      }

      const lines = content.split("\n");
      let inCodeBlock = false;

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const lineText = lines[lineIndex];
        const trimmed = lineText.trim();

        if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
          inCodeBlock = !inCodeBlock;
          continue;
        }

        if (inCodeBlock) {
          continue;
        }

        // 1. Process Markdown links
        linkRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = linkRegex.exec(lineText)) !== null) {
          const rawTarget = match[3]?.trim();
          if (!rawTarget) continue;

          const colIndex = match.index + 1;
          checkTarget(rawTarget, relFile, lineIndex + 1, colIndex, context, findings);
        }

        // 2. Process HTML links
        htmlRegex.lastIndex = 0;
        while ((match = htmlRegex.exec(lineText)) !== null) {
          const rawTarget = match[1]?.trim();
          if (!rawTarget) continue;

          const colIndex = match.index + 1;
          checkTarget(rawTarget, relFile, lineIndex + 1, colIndex, context, findings);
        }
      }
    }

    return findings;
  },
};

function checkTarget(
  rawTarget: string,
  sourceFile: string,
  line: number,
  column: number,
  context: RuleExecutionContext,
  findings: RuleFinding[]
): void {
  // Ignore bare intra-document anchors
  if (rawTarget.startsWith("#")) {
    return;
  }

  // Ignore external URLs
  for (const prefix of EXTERNAL_URL_PREFIXES) {
    if (rawTarget.toLowerCase().startsWith(prefix)) {
      return;
    }
  }

  // Handle file:/// absolute URLs by stripping prefix if present
  let cleanTarget = rawTarget;
  if (cleanTarget.toLowerCase().startsWith("file:///")) {
    // If it's a file:// URL, strip scheme
    cleanTarget = cleanTarget.slice(8);
    // If it was file:///C:/path, strip drive if within project
    if (/^[A-Za-z]:\//.test(cleanTarget)) {
      const rel = path.relative(context.projectDir, cleanTarget);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        cleanTarget = toPosixPath(rel);
      } else {
        // Outside project
        return;
      }
    }
  }

  // Separate path from anchor: path#anchor
  const hashIdx = cleanTarget.indexOf("#");
  const pathPart = hashIdx >= 0 ? cleanTarget.slice(0, hashIdx) : cleanTarget;
  if (!pathPart) {
    return;
  }

  // Decode percent-encoded URI characters
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    decodedPath = pathPart;
  }

  // Resolve relative to source file directory or repository root (if starts with /)
  let normalizedTarget: string;
  if (decodedPath.startsWith("/")) {
    normalizedTarget = normalizeRelativePath(toPosixPath(decodedPath.slice(1)));
  } else {
    const sourceDir = path.dirname(sourceFile);
    normalizedTarget = normalizeRelativePath(toPosixPath(path.join(sourceDir, decodedPath)));
  }

  // Detect path traversal escaping repository root
  if (normalizedTarget.startsWith("..") || path.isAbsolute(normalizedTarget)) {
    findings.push({
      ruleId: "RULE-DOC-REF-INTEGRITY",
      diagnosticCode: "PATH_TRAVERSAL_LINK",
      severity: "error",
      enforcement: "blocking",
      filePath: sourceFile,
      line,
      column,
      message: `Markdown link '${rawTarget}' attempts to escape the repository root.`,
      expected: "Link target must remain within repository boundaries.",
      actual: normalizedTarget,
      remediation: "Update the link path to reference a location inside the repository.",
      blocksOperation: true,
    });
    return;
  }

  // Check file or directory existence
  let exists = false;
  try {
    exists = context.fileExists(normalizedTarget);
  } catch {
    exists = false;
  }

  if (!exists) {
    // Check if target is an existing directory
    const absPath = path.join(context.projectDir, normalizedTarget);
    if (fs.existsSync(absPath)) {
      try {
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) {
          exists = true;
        }
      } catch {
        exists = false;
      }
    }
  }

  if (!exists) {
    findings.push({
      ruleId: "RULE-DOC-REF-INTEGRITY",
      diagnosticCode: "BROKEN_DOCUMENT_LINK",
      severity: "error",
      enforcement: "blocking",
      filePath: sourceFile,
      line,
      column,
      message: `Broken internal markdown link '${rawTarget}': target file or directory does not exist.`,
      expected: `Existing target at '${normalizedTarget}'`,
      actual: `Target does not exist on disk`,
      remediation: `Verify that target file '${normalizedTarget}' exists, or correct the relative link in '${sourceFile}'.`,
      blocksOperation: true,
    });
  }
}
