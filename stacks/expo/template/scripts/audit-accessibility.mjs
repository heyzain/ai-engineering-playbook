#!/usr/bin/env node

/**
 * RULE-RN-ACCESSIBILITY: Mobile Accessibility & Interactive Control Auditor (Expo Overlay)
 * 
 * Verifies that:
 * 1. All interactive controls (<Pressable>, <TouchableOpacity>, <TouchableHighlight>) declare an accessibilityRole (or role).
 * 2. All interactive controls declare a non-empty, meaningful accessibilityLabel (or aria-label).
 * 3. Generic placeholders ("button", "click", "press", "icon", "todo", "test") are rejected.
 */

import fs from "node:fs";
import path from "node:path";

const INTERACTIVE_ELEMENTS = ["Pressable", "TouchableOpacity", "TouchableHighlight"];
const GENERIC_PLACEHOLDERS = /^(button|click|press|press here|icon|todo|test|unlabeled|btn|action)$/i;

const VALID_ROLES = new Set([
  "button",
  "link",
  "header",
  "image",
  "checkbox",
  "alert",
  "switch",
  "combobox",
  "menu",
  "menubar",
  "menuitem",
  "progressbar",
  "radio",
  "radiogroup",
  "scrollbar",
  "spinbutton",
  "tab",
  "tablist",
  "timer",
  "toolbar",
  "search",
  "adjustable",
  "summary",
]);

let violationsCount = 0;

function reportViolation(file, line, tag, message) {
  violationsCount++;
  console.error(`✖ [RULE-RN-ACCESSIBILITY] ${file}:${line}: <${tag}> ${message}`);
}

function collectSourceFiles(dir, projectDir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "android" || entry.name === "ios" || entry.name === "dist" || entry.name === ".metro" || entry.name === ".expo") {
        continue;
      }
      collectSourceFiles(fullPath, projectDir, fileList);
    } else if (entry.isFile() && /\.(tsx|jsx)$/.test(entry.name)) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

function auditAccessibility(filePath, projectDir) {
  const relPath = path.relative(projectDir, filePath).replace(/\\/g, "/");
  const content = fs.readFileSync(filePath, "utf-8");

  const tagPattern = new RegExp(`<(${INTERACTIVE_ELEMENTS.join("|")})\\b([^>]*?)(?:>|\\/>)`, "gs");

  let match;
  while ((match = tagPattern.exec(content)) !== null) {
    const tagName = match[1];
    const attributes = match[2];
    const startIndex = match.index;
    const line = content.slice(0, startIndex).split(/\r?\n/).length;

    const roleMatch = attributes.match(/(?:accessibilityRole|role)\s*=\s*(?:["']([^"']+)["']|\{([^}]+)\})/);
    if (!roleMatch) {
      reportViolation(
        relPath,
        line,
        tagName,
        `Interactive control lacks mandatory 'accessibilityRole' (e.g. accessibilityRole="button").`
      );
    } else if (roleMatch[1]) {
      const roleVal = roleMatch[1].trim().toLowerCase();
      if (!VALID_ROLES.has(roleVal)) {
        reportViolation(
          relPath,
          line,
          tagName,
          `declares invalid or unrecognized accessibilityRole '${roleMatch[1]}'.`
        );
      }
    }

    const labelMatch = attributes.match(/(?:accessibilityLabel|aria-label)\s*=\s*(?:["']([^"']+)["']|\{([^}]+)\})/);
    if (!labelMatch) {
      reportViolation(
        relPath,
        line,
        tagName,
        `Interactive control lacks mandatory 'accessibilityLabel'. Provide a descriptive screen-reader label.`
      );
    } else {
      const labelText = (labelMatch[1] || labelMatch[2] || "").trim();
      if (!labelText) {
        reportViolation(
          relPath,
          line,
          tagName,
          `Interactive control has empty 'accessibilityLabel'. Provide a descriptive label.`
        );
      } else if (labelMatch[1] && GENERIC_PLACEHOLDERS.test(labelText)) {
        reportViolation(
          relPath,
          line,
          tagName,
          `Interactive control uses prohibited generic placeholder accessibilityLabel '${labelText}'. Provide a context-specific descriptive label.`
        );
      }
    }
  }
}

function main() {
  const projectDir = process.cwd();
  console.log("Running Mobile Interactive Control Accessibility Audit (RULE-RN-ACCESSIBILITY)...");

  const sourceFiles = [];
  collectSourceFiles(path.join(projectDir, "src"), projectDir, sourceFiles);
  collectSourceFiles(path.join(projectDir, "app"), projectDir, sourceFiles);
  if (fs.existsSync(path.join(projectDir, "App.tsx"))) {
    sourceFiles.push(path.join(projectDir, "App.tsx"));
  }

  for (const file of sourceFiles) {
    auditAccessibility(file, projectDir);
  }

  if (violationsCount > 0) {
    console.error(`\nAccessibility audit failed with ${violationsCount} defect(s).`);
    process.exit(1);
  } else {
    console.log("✔ Accessibility audit passed. All interactive controls declare valid roles and descriptive labels.");
    process.exit(0);
  }
}

main();
