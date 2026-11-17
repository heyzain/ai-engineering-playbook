#!/usr/bin/env node

/**
 * RULE-RN-ACCESSIBILITY: Mobile Accessibility & Interactive Control Auditor
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
      if (entry.name === "node_modules" || entry.name === "android" || entry.name === "ios" || entry.name === "dist" || entry.name === ".metro") {
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

  // Regex to match opening tags of interactive elements: <Tag ... > or <Tag ... />
  // Supports multiline tags
  const tagPattern = new RegExp(`<(${INTERACTIVE_ELEMENTS.join("|")})\\b([^>]*?)(?:>|\\/>)`, "gs");

  let match;
  while ((match = tagPattern.exec(content)) !== null) {
    const tagName = match[1];
    const attributes = match[2];
    const startIndex = match.index;

    // Calculate line number
    const line = content.slice(0, startIndex).split(/\r?\n/).length;

    // 1. Check accessibilityRole or role
    const roleMatch = attributes.match(/(?:accessibilityRole|role)\s*=\s*(?:["']([^"']+)["']|\{([^}]+)\})/);
    if (!roleMatch) {
      reportViolation(
        relPath,
        line,
        tagName,
        `lacks mandatory 'accessibilityRole' (or 'role') prop. Screen readers require an explicit role (e.g. accessibilityRole="button").`
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

    // 2. Check accessibilityLabel or aria-label
    const labelMatch = attributes.match(/(?:accessibilityLabel|aria-label)\s*=\s*(?:["']([^"']+)["']|\{([^}]+)\})/);
    if (!labelMatch) {
      reportViolation(
        relPath,
        line,
        tagName,
        `lacks mandatory 'accessibilityLabel' (or 'aria-label') prop. Provide a descriptive label for assistive technologies.`
      );
    } else {
      const labelValue = (labelMatch[1] || "").trim();
      if (labelValue && GENERIC_PLACEHOLDERS.test(labelValue)) {
        reportViolation(
          relPath,
          line,
          tagName,
          `has generic placeholder accessibilityLabel '${labelValue}'. A meaningful, descriptive label describing action and context is required.`
        );
      }
    }
  }
}

function main() {
  const projectDir = process.cwd();
  console.log("Running Mobile Interactive Accessibility Audit (RULE-RN-ACCESSIBILITY)...");

  const srcDir = path.join(projectDir, "src");
  const allFiles = collectSourceFiles(srcDir, projectDir);
  if (fs.existsSync(path.join(projectDir, "App.tsx"))) {
    allFiles.push(path.join(projectDir, "App.tsx"));
  }

  for (const file of allFiles) {
    auditAccessibility(file, projectDir);
  }

  if (violationsCount > 0) {
    console.error(`\nAccessibility audit failed with ${violationsCount} violation(s).`);
    process.exit(1);
  } else {
    console.log("✔ Mobile accessibility audit passed. All interactive controls declare valid roles and descriptive labels.");
    process.exit(0);
  }
}

main();
