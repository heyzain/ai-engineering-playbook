import fs from "node:fs";
import path from "node:path";
import { normalizeRelativePath, toPosixPath } from "../../utils/paths.js";
import { classifyMobileWorkflow } from "./workflow-classifier.js";
import type {
  MobileRuleId,
  MobileRuleFinding,
  MobileRuleEvaluationResult,
  MobileRifSuiteResult,
  EvaluateMobileRifOptions,
} from "./types.js";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB static analysis bound

export const PLATFORM_EXT_REGEX = /\.(ios|android|native)\.(tsx|ts|jsx|js)$/;
export const BASE_EXT_REGEX = /\.(tsx|ts|jsx|js)$/;
export const EXCLUSIVE_DIRECTIVE_REGEX = /^\s*(?:\/\/|\/\*)\s*@playbook-platform-exclusive\s+(ios|android)/m;

export const VALID_ACCESSIBILITY_ROLES = new Set([
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

export const GENERIC_LABEL_PLACEHOLDERS =
  /^(button|click|press|press here|icon|todo|test|unlabeled|btn|action)$/i;

export const SENSITIVE_STORAGE_KEY_REGEX =
  /(?:AsyncStorage|storage)\.setItem\s*\(\s*['"`]([^'"`]*?(?:token|auth|jwt|secret|password|passwd|credential|bearer|session|private|refresh_token|access_token|api_key)[^'"`]*?)['"`]/i;

export const SENSITIVE_KEYWORD_REGEX =
  /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH)/i;

export const PRIVATE_KEY_BLOCK_REGEX =
  /-----BEGIN\s+(?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED)?\s*PRIVATE\s+KEY-----/;

export const DEFAULT_ROUTE_EXPORT_REGEX =
  /(?:export\s+default\s+(?:function|class|const|let|var|\(?\w+\)?\s*=>)|export\s+default\s+[\w$]+;?)/;

export const HTTP_ROUTE_EXPORT_REGEX =
  /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/;

/**
 * Safely inspects and reads a text file within project directory bounds,
 * checking symlinks and enforcing file size bounds.
 */
export function safeReadProjectFile(
  fullPath: string,
  projectDir: string,
  maxBytes: number = DEFAULT_MAX_FILE_SIZE_BYTES
): { content?: string; finding?: MobileRuleFinding } {
  const relPath = toPosixPath(path.relative(projectDir, fullPath));

  // Check symlink traversal
  try {
    const lstat = fs.lstatSync(fullPath);
    if (lstat.isSymbolicLink()) {
      let realTarget: string;
      try {
        realTarget = fs.realpathSync(fullPath);
      } catch (err: unknown) {
        return {
          finding: {
            ruleId: "RULE-RN-COMPANION",
            code: "INVALID_SYMLINK_TARGET",
            filePath: relPath,
            severity: "blocking",
            message: `Symlink target cannot be resolved: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      const relToTarget = path.relative(projectDir, realTarget);
      if (relToTarget.startsWith("..") || path.isAbsolute(relToTarget)) {
        return {
          finding: {
            ruleId: "RULE-RN-COMPANION",
            code: "INVALID_SYMLINK_TRAVERSAL",
            filePath: relPath,
            severity: "blocking",
            message: `Symlink '${relPath}' escapes project boundary pointing to: ${realTarget}`,
            details: { target: realTarget },
          },
        };
      }
    }
  } catch (err: unknown) {
    return {
      finding: {
        ruleId: "RULE-RN-COMPANION",
        code: "FILE_ACCESS_ERROR",
        filePath: relPath,
        severity: "blocking",
        message: `Failed to inspect file '${relPath}': ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // Check file size bound
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch (err: unknown) {
    return {
      finding: {
        ruleId: "RULE-RN-COMPANION",
        code: "FILE_ACCESS_ERROR",
        filePath: relPath,
        severity: "blocking",
        message: `Failed to stat file '${relPath}': ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (stat.size > maxBytes) {
    return {
      finding: {
        ruleId: "RULE-RN-COMPANION",
        code: "OVERSIZED_SOURCE_FILE",
        filePath: relPath,
        severity: "blocking",
        message: `File size (${stat.size} bytes) exceeds static analysis bound (${maxBytes} bytes). Large files fail closed to prevent parser resource exhaustion.`,
        details: { size: stat.size, maxBytes },
      },
    };
  }

  // Read UTF-8 buffer and strictly validate
  const buffer = fs.readFileSync(fullPath);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    let text = decoder.decode(buffer);
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1); // strip BOM
    }
    return { content: text };
  } catch (err: unknown) {
    return {
      finding: {
        ruleId: "RULE-RN-COMPANION",
        code: "PARSER_FAILURE",
        filePath: relPath,
        severity: "blocking",
        message: `File contains invalid UTF-8 byte sequence and cannot be parsed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/**
 * Collects source files recursively under target directories,
 * respecting standard exclusions.
 */
export function collectSourceFiles(
  rootDir: string,
  projectDir: string,
  options: {
    extensions?: RegExp;
    excludeDirs?: string[];
    maxFiles?: number;
  } = {}
): string[] {
  const results: string[] = [];
  const extRegex = options.extensions || BASE_EXT_REGEX;
  const excludeDirs = new Set(
    options.excludeDirs || [
      "node_modules",
      ".metro",
      "metro-cache",
      "android",
      "ios",
      "dist",
      "build",
      "coverage",
      ".playbook",
      ".expo",
      ".expo-shared",
      "web-build",
    ]
  );
  const maxFiles = options.maxFiles || 5000;

  function walk(currentDir: string): void {
    if (results.length >= maxFiles) return;
    if (!fs.existsSync(currentDir)) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!excludeDirs.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (extRegex.test(entry.name) && !entry.name.endsWith(".d.ts")) {
          results.push(fullPath);
          if (results.length >= maxFiles) break;
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. RULE-RN-COMPANION: Platform File Companion Parity
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateRuleRnCompanion(
  projectDir: string,
  options: Partial<EvaluateMobileRifOptions> = {}
): MobileRuleEvaluationResult {
  const startTime = Date.now();
  const ruleId: MobileRuleId = "RULE-RN-COMPANION";
  const findings: MobileRuleFinding[] = [];
  const maxBytes = options.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_BYTES;

  const srcDir = path.join(projectDir, "src");
  const allSourceFiles = collectSourceFiles(srcDir, projectDir, {
    extensions: BASE_EXT_REGEX,
  });

  const rootApp = path.join(projectDir, "App.tsx");
  if (fs.existsSync(rootApp)) allSourceFiles.push(rootApp);
  const rootIndex = path.join(projectDir, "index.js");
  if (fs.existsSync(rootIndex)) allSourceFiles.push(rootIndex);

  // Group files by module base stem
  interface VariantRecord {
    fullPath: string;
    relPath: string;
    platform: "ios" | "android" | "native" | "universal";
  }
  const moduleMap = new Map<string, VariantRecord[]>();

  let scannedCount = 0;
  let skippedCount = 0;

  for (const file of allSourceFiles) {
    const relPath = toPosixPath(path.relative(projectDir, file));
    const readRes = safeReadProjectFile(file, projectDir, maxBytes);
    if (readRes.finding) {
      findings.push(readRes.finding);
      continue;
    }

    const platMatch = relPath.match(PLATFORM_EXT_REGEX);
    let stem: string;
    let platform: "ios" | "android" | "native" | "universal";

    if (platMatch) {
      platform = platMatch[1] as "ios" | "android" | "native";
      stem = relPath.replace(PLATFORM_EXT_REGEX, "");
    } else {
      platform = "universal";
      stem = relPath.replace(BASE_EXT_REGEX, "");
    }

    if (!moduleMap.has(stem)) {
      moduleMap.set(stem, []);
    }
    moduleMap.get(stem)!.push({ fullPath: file, relPath, platform });
    scannedCount++;
  }

  // Pre-load platform exclusive modules from options or rif-patterns
  const registeredExclusives = new Map<string, "ios" | "android">();
  if (options.platformExclusiveModules) {
    if (Array.isArray(options.platformExclusiveModules)) {
      for (const item of options.platformExclusiveModules) {
        registeredExclusives.set(toPosixPath(item), "ios");
      }
    } else {
      for (const [stemPath, target] of Object.entries(options.platformExclusiveModules)) {
        registeredExclusives.set(toPosixPath(stemPath), target);
      }
    }
  }

  // Also check .playbook/rif-patterns.json if present
  const playbookRifPath = path.join(projectDir, ".playbook", "rif-patterns.json");
  if (fs.existsSync(playbookRifPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(playbookRifPath, "utf-8"));
      if (data.platform_exclusive_modules && typeof data.platform_exclusive_modules === "object") {
        if (Array.isArray(data.platform_exclusive_modules)) {
          for (const item of data.platform_exclusive_modules) {
            registeredExclusives.set(toPosixPath(item), "ios");
          }
        } else {
          for (const [k, v] of Object.entries(data.platform_exclusive_modules)) {
            if (v === "ios" || v === "android") {
              registeredExclusives.set(toPosixPath(k), v);
            }
          }
        }
      }
    } catch {
      // ignore read error
    }
  }

  const activeExclusiveModules = new Map<string, { target: "ios" | "android"; file: string }>();

  // 1. Validate bilateral resolution for each module stem
  for (const [stem, variants] of moduleMap.entries()) {
    const hasIos = variants.some((v) => v.platform === "ios");
    const hasAndroid = variants.some((v) => v.platform === "android");
    const hasNative = variants.some((v) => v.platform === "native");
    const hasUniversal = variants.some((v) => v.platform === "universal");

    const iosResolves = hasIos || hasNative || hasUniversal;
    const androidResolves = hasAndroid || hasNative || hasUniversal;

    if (iosResolves && !androidResolves) {
      // Has iOS candidate but lacks Android candidate
      const iosVariant = variants.find((v) => v.platform === "ios")!;
      const readRes = safeReadProjectFile(iosVariant.fullPath, projectDir, maxBytes);
      if (readRes.finding) {
        findings.push(readRes.finding);
        continue;
      }

      const content = readRes.content || "";
      const head = content.slice(0, 1000);
      const directiveMatch = head.match(EXCLUSIVE_DIRECTIVE_REGEX);
      const isRegistered = registeredExclusives.get(stem) === "ios" || registeredExclusives.get(iosVariant.relPath) === "ios";

      if ((directiveMatch && directiveMatch[1].toLowerCase() === "ios") || isRegistered) {
        activeExclusiveModules.set(stem, { target: "ios", file: iosVariant.relPath });
      } else {
        findings.push({
          ruleId,
          code: "UNPAIRED_PLATFORM_FILE",
          filePath: iosVariant.relPath,
          severity: "blocking",
          message: `Module has iOS candidate but resolves to 0 candidates on Android. Provide an Android companion (.android.tsx), universal fallback (.tsx/.native.tsx), explicit no-op stub, or mark as platform-exclusive with '// @playbook-platform-exclusive ios'.`,
          remediation: `Create a companion file '${stem}.android.tsx' or add '// @playbook-platform-exclusive ios' to '${iosVariant.relPath}'.`,
          details: { stem, availablePlatforms: variants.map((v) => v.platform) },
        });
      }
    } else if (androidResolves && !iosResolves) {
      // Has Android candidate but lacks iOS candidate
      const androidVariant = variants.find((v) => v.platform === "android")!;
      const readRes = safeReadProjectFile(androidVariant.fullPath, projectDir, maxBytes);
      if (readRes.finding) {
        findings.push(readRes.finding);
        continue;
      }

      const content = readRes.content || "";
      const head = content.slice(0, 1000);
      const directiveMatch = head.match(EXCLUSIVE_DIRECTIVE_REGEX);
      const isRegistered = registeredExclusives.get(stem) === "android" || registeredExclusives.get(androidVariant.relPath) === "android";

      if ((directiveMatch && directiveMatch[1].toLowerCase() === "android") || isRegistered) {
        activeExclusiveModules.set(stem, { target: "android", file: androidVariant.relPath });
      } else {
        findings.push({
          ruleId,
          code: "UNPAIRED_PLATFORM_FILE",
          filePath: androidVariant.relPath,
          severity: "blocking",
          message: `Module has Android candidate but resolves to 0 candidates on iOS. Provide an iOS companion (.ios.tsx), universal fallback (.tsx/.native.tsx), explicit no-op stub, or mark as platform-exclusive with '// @playbook-platform-exclusive android'.`,
          remediation: `Create a companion file '${stem}.ios.tsx' or add '// @playbook-platform-exclusive android' to '${androidVariant.relPath}'.`,
          details: { stem, availablePlatforms: variants.map((v) => v.platform) },
        });
      }
    }
  }

  // 2. Verify guarded imports for platform-exclusive modules
  if (activeExclusiveModules.size > 0) {
    for (const file of allSourceFiles) {
      const relPath = toPosixPath(path.relative(projectDir, file));
      const platMatch = relPath.match(PLATFORM_EXT_REGEX);
      const filePlatform = platMatch ? platMatch[1] : null;

      const readRes = safeReadProjectFile(file, projectDir, maxBytes);
      if (readRes.finding) {
        findings.push(readRes.finding);
        continue;
      }
      const content = readRes.content || "";
      const lines = content.split(/\r?\n/);

      for (const [stem, { target, file: exclusiveFile }] of activeExclusiveModules.entries()) {
        const baseName = path.basename(stem);
        // If file is already dedicated to the same target platform, importing is safe
        if (filePlatform === target) {
          continue;
        }

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          // 1. Static ESM import
          const staticMatch = line.match(/^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/);
          if (staticMatch) {
            const specifier = staticMatch[1];
            const specifierBase = path.basename(specifier).replace(PLATFORM_EXT_REGEX, "").replace(BASE_EXT_REGEX, "");

            if (specifierBase === baseName || specifier.endsWith(baseName)) {
              findings.push({
                ruleId,
                code: "UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT",
                filePath: relPath,
                lineNumber: i + 1,
                severity: "blocking",
                message: `Unguarded static import of platform-exclusive module '${exclusiveFile}'. Static imports execute unconditionally on all platforms. Use dynamic require() with Platform.OS / Platform.select guard, or isolate in a platform-specific companion file.`,
                remediation: `Replace static import with a platform guard using Platform.OS === '${target}' or Platform.select().`,
                details: { exclusiveModule: exclusiveFile, specifier },
              });
            }
          }

          // 2. Dynamic require / import
          const dynamicMatch = line.match(/(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
          if (dynamicMatch) {
            const specifier = dynamicMatch[1];
            const specifierBase = path.basename(specifier).replace(PLATFORM_EXT_REGEX, "").replace(BASE_EXT_REGEX, "");

            if (specifierBase === baseName || specifier.endsWith(baseName)) {
              const hasPlatformGuard = content.includes("Platform.OS") || content.includes("Platform.select");
              if (!hasPlatformGuard) {
                findings.push({
                  ruleId,
                  code: "UNGUARDED_PLATFORM_EXCLUSIVE_IMPORT",
                  filePath: relPath,
                  lineNumber: i + 1,
                  severity: "blocking",
                  message: `Dynamic import of platform-exclusive module '${exclusiveFile}' lacks platform guard in file '${relPath}'. Guard with Platform.OS === '${target}' or Platform.select().`,
                  remediation: `Wrap dynamic import in 'if (Platform.OS === "${target}")' or Platform.select().`,
                  details: { exclusiveModule: exclusiveFile, specifier },
                });
              }
            }
          }
        }
      }
    }
  }

  const passed = findings.every((f) => f.severity !== "blocking");
  return {
    ruleId,
    passed,
    findings,
    scannedFilesCount: scannedCount,
    skippedFilesCount: skippedCount,
    executionTimeMs: Date.now() - startTime,
    limitations: [
      "Static analysis traces standard imports and Platform.OS / Platform.select guards, but cannot trace dynamic computed require() specifiers (e.g. require('./' + Platform.OS)).",
      "Semantic export type equivalence between companion files is verified in tandem by 'rn-typecheck' (tsc --noEmit).",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RULE-RN-ACCESSIBILITY: Mobile Interactive Accessibility Audit
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateRuleRnAccessibility(
  projectDir: string,
  options: Partial<EvaluateMobileRifOptions> = {}
): MobileRuleEvaluationResult {
  const startTime = Date.now();
  const ruleId: MobileRuleId = "RULE-RN-ACCESSIBILITY";
  const findings: MobileRuleFinding[] = [];
  const maxBytes = options.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_BYTES;

  const targetFiles: string[] = [];
  const srcDir = path.join(projectDir, "src");
  if (fs.existsSync(srcDir)) {
    targetFiles.push(...collectSourceFiles(srcDir, projectDir, { extensions: /\.(tsx|jsx)$/ }));
  }
  const appDir = path.join(projectDir, "app");
  if (fs.existsSync(appDir)) {
    targetFiles.push(...collectSourceFiles(appDir, projectDir, { extensions: /\.(tsx|jsx)$/ }));
  }

  const rootApp = path.join(projectDir, "App.tsx");
  if (fs.existsSync(rootApp)) targetFiles.push(rootApp);

  let scannedCount = 0;
  let skippedCount = 0;

  const INTERACTIVE_ELEMENTS = ["Pressable", "TouchableOpacity", "TouchableHighlight"];
  const tagPattern = new RegExp(`<(${INTERACTIVE_ELEMENTS.join("|")})\\b([^>]*?)(?:>|\\/>)`, "gs");

  for (const file of targetFiles) {
    const relPath = toPosixPath(path.relative(projectDir, file));
    const readRes = safeReadProjectFile(file, projectDir, maxBytes);
    if (readRes.finding) {
      findings.push(readRes.finding);
      continue;
    }

    const content = readRes.content || "";
    scannedCount++;

    let match: RegExpExecArray | null;
    while ((match = tagPattern.exec(content)) !== null) {
      const tagName = match[1];
      const attributes = match[2];
      const startIndex = match.index;
      const lineNumber = content.slice(0, startIndex).split(/\r?\n/).length;

      // 1. Accessibility Role Check
      const roleMatch = attributes.match(/(?:accessibilityRole|role)\s*=\s*(?:["']([^"']*)["']|\{([^}]+)\})/);
      if (!roleMatch) {
        findings.push({
          ruleId,
          code: "MISSING_ACCESSIBILITY_ROLE",
          filePath: relPath,
          lineNumber,
          severity: "blocking",
          message: `<${tagName}> lacks mandatory 'accessibilityRole' (or 'role') prop. Screen readers require an explicit role (e.g. accessibilityRole="button").`,
          remediation: `Add accessibilityRole="button" (or appropriate role) to <${tagName}>.`,
        });
      } else {
        const roleLiteral = roleMatch[1];
        if (roleLiteral !== undefined) {
          const trimmedRole = roleLiteral.trim().toLowerCase();
          if (!trimmedRole || !VALID_ACCESSIBILITY_ROLES.has(trimmedRole)) {
            findings.push({
              ruleId,
              code: "INVALID_ACCESSIBILITY_ROLE",
              filePath: relPath,
              lineNumber,
              severity: "blocking",
              message: `<${tagName}> declares invalid accessibilityRole '${roleLiteral}'. Role must be one of: ${Array.from(VALID_ACCESSIBILITY_ROLES).slice(0, 8).join(", ")}, etc.`,
              remediation: `Use an approved role such as accessibilityRole="button" or accessibilityRole="link".`,
              details: { declaredRole: roleLiteral },
            });
          }
        }
      }

      // 2. Accessibility Label Check
      const labelMatch = attributes.match(/(?:accessibilityLabel|aria-label)\s*=\s*(?:["']([^"']*)["']|\{([^}]+)\})/);
      if (!labelMatch) {
        findings.push({
          ruleId,
          code: "MISSING_ACCESSIBILITY_LABEL",
          filePath: relPath,
          lineNumber,
          severity: "blocking",
          message: `<${tagName}> lacks mandatory 'accessibilityLabel' (or 'aria-label') prop. Provide a descriptive label for assistive technologies.`,
          remediation: `Add accessibilityLabel="Descriptive Action" to <${tagName}>.`,
        });
      } else {
        const labelLiteral = labelMatch[1];
        const labelExpr = labelMatch[2];

        if (labelLiteral !== undefined) {
          const trimmedLabel = labelLiteral.trim();
          if (!trimmedLabel) {
            findings.push({
              ruleId,
              code: "MISSING_ACCESSIBILITY_LABEL",
              filePath: relPath,
              lineNumber,
              severity: "blocking",
              message: `<${tagName}> accessibilityLabel is an empty string. Provide a descriptive label for assistive technologies.`,
              remediation: `Provide a meaningful, localized label describing the component action.`,
            });
          } else if (GENERIC_LABEL_PLACEHOLDERS.test(trimmedLabel)) {
            findings.push({
              ruleId,
              code: "GENERIC_ACCESSIBILITY_LABEL",
              filePath: relPath,
              lineNumber,
              severity: "blocking",
              message: `<${tagName}> has generic placeholder accessibilityLabel '${trimmedLabel}'. A meaningful, descriptive label describing action and context is required.`,
              remediation: `Replace generic placeholder with specific action description, e.g. accessibilityLabel="Submit payment".`,
              details: { genericLabel: trimmedLabel },
            });
          }
        } else if (labelExpr !== undefined) {
          const trimmedExpr = labelExpr.trim();
          if (!trimmedExpr || trimmedExpr === `""` || trimmedExpr === `''`) {
            findings.push({
              ruleId,
              code: "MISSING_ACCESSIBILITY_LABEL",
              filePath: relPath,
              lineNumber,
              severity: "blocking",
              message: `<${tagName}> accessibilityLabel expression is empty or whitespace.`,
              remediation: `Provide a valid expression evaluating to a non-empty string.`,
            });
          }
        }
      }
    }
  }

  const passed = findings.every((f) => f.severity !== "blocking");
  return {
    ruleId,
    passed,
    findings,
    scannedFilesCount: scannedCount,
    skippedFilesCount: skippedCount,
    executionTimeMs: Date.now() - startTime,
    limitations: [
      "Static analysis inspects JSX attribute declarations for interactive components. It cannot verify runtime internationalization values or screen reader acoustic output.",
      "Touch target dimensions (48x48dp Android, 44x44pt iOS) and visual contrast require device/simulator rendering or automated E2E inspection.",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. RULE-MOB-SEC-STORAGE: Mobile Secret & Secure Storage Auditor
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateRuleMobSecStorage(
  projectDir: string,
  options: Partial<EvaluateMobileRifOptions> = {}
): MobileRuleEvaluationResult {
  const startTime = Date.now();
  const ruleId: MobileRuleId = "RULE-MOB-SEC-STORAGE";
  const findings: MobileRuleFinding[] = [];
  const maxBytes = options.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_BYTES;

  let scannedCount = 0;
  let skippedCount = 0;

  // 1. Audit .env* files
  if (fs.existsSync(projectDir)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(projectDir);
    } catch {
      entries = [];
    }

    const envFiles = entries.filter(
      (e) => e.startsWith(".env") && e !== ".env.example" && fs.statSync(path.join(projectDir, e)).isFile()
    );

    for (const envFile of envFiles) {
      const fullPath = path.join(projectDir, envFile);
      const readRes = safeReadProjectFile(fullPath, projectDir, maxBytes);
      if (readRes.finding) {
        findings.push(readRes.finding);
        continue;
      }

      scannedCount++;
      const content = readRes.content || "";
      const lines = content.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith("#")) continue;

        const eqIdx = line.indexOf("=");
        if (eqIdx <= 0) continue;

        const key = line.slice(0, eqIdx).trim();

        if (key.startsWith("EXPO_PUBLIC_")) {
          // Expo public key leaking sensitive secret
          if (SENSITIVE_KEYWORD_REGEX.test(key)) {
            findings.push({
              ruleId,
              code: "EXPO_PUBLIC_SECRET_LEAK",
              filePath: envFile,
              lineNumber: i + 1,
              severity: "blocking",
              message: `Sensitive secret key '${key}' declared with 'EXPO_PUBLIC_' prefix. Variables with EXPO_PUBLIC_ are compiled directly into the public client application bundle. Private secrets must reside exclusively in backend services.`,
              remediation: `Remove '${key}' from mobile environment. Access sensitive services through a backend API gateway.`,
              details: { key },
            });
          }
        } else if (SENSITIVE_KEYWORD_REGEX.test(key)) {
          findings.push({
            ruleId,
            code: "MOBILE_ENV_SECRET_LEAK",
            filePath: envFile,
            lineNumber: i + 1,
            severity: "blocking",
            message: `Sensitive secret key '${key}' declared in mobile environment file. Mobile client bundles are public and decompilable. Never embed private secrets in client environment configurations.`,
            remediation: `Remove '${key}' from mobile environment. Access sensitive services through a backend API gateway.`,
            details: { key },
          });
        }
      }
    }
  }

  // 2. Audit source files under src/, app/, and root
  const candidateFiles: string[] = [];
  const srcDir = path.join(projectDir, "src");
  if (fs.existsSync(srcDir)) {
    candidateFiles.push(...collectSourceFiles(srcDir, projectDir, { extensions: BASE_EXT_REGEX }));
  }
  const appDir = path.join(projectDir, "app");
  if (fs.existsSync(appDir)) {
    candidateFiles.push(...collectSourceFiles(appDir, projectDir, { extensions: BASE_EXT_REGEX }));
  }
  const rootApp = path.join(projectDir, "App.tsx");
  if (fs.existsSync(rootApp)) candidateFiles.push(rootApp);
  const rootIndex = path.join(projectDir, "index.js");
  if (fs.existsSync(rootIndex)) candidateFiles.push(rootIndex);

  for (const file of candidateFiles) {
    const relPath = toPosixPath(path.relative(projectDir, file));
    const readRes = safeReadProjectFile(file, projectDir, maxBytes);
    if (readRes.finding) {
      findings.push(readRes.finding);
      continue;
    }

    scannedCount++;
    const content = readRes.content || "";

    // Check for private key blocks
    if (PRIVATE_KEY_BLOCK_REGEX.test(content)) {
      findings.push({
        ruleId,
        code: "EMBEDDED_PRIVATE_KEY",
        filePath: relPath,
        severity: "blocking",
        message: `Embedded private cryptographic key block detected. Private keys must never be shipped in mobile application bundles.`,
        remediation: `Remove embedded private key from source file. Keys must be stored in hardware keystores or backend vaults.`,
      });
    }

    // Check line by line for unencrypted AsyncStorage calls
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const storageMatch = line.match(SENSITIVE_STORAGE_KEY_REGEX);
      if (storageMatch) {
        const keyName = storageMatch[1];
        findings.push({
          ruleId,
          code: "UNENCRYPTED_SENSITIVE_STORAGE",
          filePath: relPath,
          lineNumber: i + 1,
          severity: "blocking",
          message: `Prohibited sensitive key '${keyName}' passed to unencrypted AsyncStorage.setItem(). Sensitive auth tokens, passwords, and private credentials must use OS-protected secure storage (iOS Keychain / Android Keystore).`,
          remediation: `Use an approved OS-protected secure storage abstraction such as 'expo-secure-store' (SecureStore.setItemAsync) or 'react-native-keychain'. Non-sensitive preferences (e.g. theme, locale, cache) may remain in AsyncStorage.`,
          details: { sensitiveKey: keyName },
        });
      }
    }
  }

  const passed = findings.every((f) => f.severity !== "blocking");
  return {
    ruleId,
    passed,
    findings,
    scannedFilesCount: scannedCount,
    skippedFilesCount: skippedCount,
    executionTimeMs: Date.now() - startTime,
    limitations: [
      "Static checks detect unencrypted AsyncStorage invocations and plaintext env secrets. Hardware-backed protection (TEE/StrongBox) cannot be verified purely statically on unverified client hardware.",
      "Stage Gate 6 mandates human review of token lifecycles and logout purge routines.",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. RULE-EXPO-PLUGINS: Expo Config Plugins & CNG Integrity
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateRuleExpoPlugins(
  projectDir: string,
  options: Partial<EvaluateMobileRifOptions> = {}
): MobileRuleEvaluationResult {
  const startTime = Date.now();
  const ruleId: MobileRuleId = "RULE-EXPO-PLUGINS";
  const findings: MobileRuleFinding[] = [];
  const maxBytes = options.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_BYTES;

  let scannedCount = 0;
  let skippedCount = 0;

  // Use authoritative workflow classifier
  const classification = classifyMobileWorkflow(projectDir);

  if (classification.status === "INCOMPLETE") {
    const isNativeDrift = classification.message?.includes("native ios/android directories");
    findings.push({
      ruleId,
      code: isNativeDrift ? "UNMANAGED_NATIVE_DRIFT" : (classification.errorCode || "AMBIGUOUS_WORKFLOW_CONFIGURATION"),
      filePath: isNativeDrift ? "android" : ".playbook/manifest.json",
      severity: "blocking",
      message: classification.message || "Ambiguous mobile workflow configuration.",
      details: classification.details,
    });
    return {
      ruleId,
      passed: false,
      findings,
      scannedFilesCount: 0,
      skippedFilesCount: 0,
      executionTimeMs: Date.now() - startTime,
      limitations: [],
    };
  }

  // If Bare React Native: manual native edits to android/ and ios/ are legitimate
  if (classification.workflow === "bare-react-native") {
    return {
      ruleId,
      passed: true,
      findings: [],
      scannedFilesCount: 0,
      skippedFilesCount: 0,
      executionTimeMs: Date.now() - startTime,
      limitations: [
        "Bare React Native workflow detected. Native code is maintained directly under android/ and ios/; Config Plugin requirements do not apply.",
      ],
    };
  }

  // If Expo Managed workflow: native folders must be absent or gitignored
  if (classification.workflow === "expo-managed") {
    const iosExists = fs.existsSync(path.join(projectDir, "ios"));
    const androidExists = fs.existsSync(path.join(projectDir, "android"));

    if (iosExists || androidExists) {
      const gitignorePath = path.join(projectDir, ".gitignore");
      let gitignore = "";
      if (fs.existsSync(gitignorePath)) {
        try {
          gitignore = fs.readFileSync(gitignorePath, "utf-8");
        } catch {
          // ignore
        }
      }

      const isIosIgnored = /^\/?ios(\/|\*|$)/m.test(gitignore);
      const isAndroidIgnored = /^\/?android(\/|\*|$)/m.test(gitignore);

      if ((iosExists && !isIosIgnored) || (androidExists && !isAndroidIgnored)) {
        findings.push({
          ruleId,
          code: "UNMANAGED_NATIVE_DRIFT",
          filePath: iosExists && !isIosIgnored ? "ios" : "android",
          severity: "blocking",
          message: `Native directories exist and are not gitignored in an Expo Managed workflow. In Managed workflows, native projects are ephemeral. For permanent native changes, configure Config Plugins or switch to Committed CNG workflow.`,
          remediation: `Add 'ios/' and 'android/' to .gitignore, or update manifest metadata to 'expo-committed-cng' if committing native code.`,
        });
      }
    }
  }

  // Inspect app.json
  const appJsonPath = path.join(projectDir, "app.json");
  if (!fs.existsSync(appJsonPath)) {
    findings.push({
      ruleId,
      code: "MISSING_APP_JSON",
      filePath: "app.json",
      severity: "blocking",
      message: `Missing 'app.json' application manifest file required for Expo projects.`,
      remediation: `Create a valid app.json manifest file at project root.`,
    });
    return {
      ruleId,
      passed: false,
      findings,
      scannedFilesCount: 0,
      skippedFilesCount: 0,
      executionTimeMs: Date.now() - startTime,
      limitations: [],
    };
  }

  scannedCount++;
  let appJson: any;
  try {
    appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
  } catch (err: unknown) {
    findings.push({
      ruleId,
      code: "PARSER_FAILURE",
      filePath: "app.json",
      severity: "blocking",
      message: `Failed to parse app.json: ${err instanceof Error ? err.message : String(err)}`,
      remediation: `Fix syntax errors in app.json.`,
    });
    return {
      ruleId,
      passed: false,
      findings,
      scannedFilesCount: 1,
      skippedFilesCount: 0,
      executionTimeMs: Date.now() - startTime,
      limitations: [],
    };
  }

  // Load package.json dependencies for package plugin validation
  let packageDeps = new Set<string>();
  const pkgPath = path.join(projectDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      packageDeps = new Set(Object.keys(all));
    } catch {
      // ignore
    }
  }

  const plugins = appJson.expo?.plugins;
  if (plugins && Array.isArray(plugins)) {
    for (const pluginEntry of plugins) {
      const pluginName = Array.isArray(pluginEntry) ? pluginEntry[0] : pluginEntry;
      if (typeof pluginName !== "string") {
        findings.push({
          ruleId,
          code: "INVALID_PLUGIN_DECLARATION",
          filePath: "app.json",
          severity: "blocking",
          message: `Invalid plugin entry in app.json: expected string or [string, config], got '${JSON.stringify(pluginEntry)}'.`,
        });
        continue;
      }

      // Check local file plugin
      if (pluginName.startsWith("./") || pluginName.startsWith("../")) {
        const resolvedPluginPath = path.resolve(projectDir, pluginName);
        const relPluginPath = toPosixPath(path.relative(projectDir, resolvedPluginPath));

        if (!fs.existsSync(resolvedPluginPath)) {
          findings.push({
            ruleId,
            code: "PLUGIN_FILE_NOT_FOUND",
            filePath: "app.json",
            severity: "blocking",
            message: `Declared local Config Plugin '${pluginName}' not found at '${relPluginPath}'.`,
            remediation: `Create the plugin file or correct the path in app.json.`,
            details: { pluginPath: relPluginPath },
          });
        } else {
          scannedCount++;
          const readRes = safeReadProjectFile(resolvedPluginPath, projectDir, maxBytes);
          if (readRes.finding) {
            findings.push(readRes.finding);
            continue;
          }

          const pluginContent = readRes.content || "";
          const exportsFunction =
            pluginContent.includes("module.exports") ||
            /export\s+default\s+(?:function|const|let|var|\(?\w+\)?\s*=>)/.test(pluginContent);

          if (!exportsFunction) {
            findings.push({
              ruleId,
              code: "INVALID_PLUGIN_EXPORT",
              filePath: relPluginPath,
              severity: "blocking",
              message: `Config Plugin at '${relPluginPath}' does not export a function (missing 'module.exports' or 'export default'). Config Plugins must export a function receiving config and returning modified config.`,
              remediation: `Ensure '${relPluginPath}' exports a valid plugin function.`,
            });
          }
        }
      } else {
        // Npm package plugin (e.g. "expo-secure-store", "expo-camera")
        if (packageDeps.size > 0 && !packageDeps.has(pluginName) && pluginName !== "expo-router") {
          findings.push({
            ruleId,
            code: "UNDECLARED_PLUGIN_PACKAGE",
            filePath: "app.json",
            severity: "blocking",
            message: `Declared Config Plugin '${pluginName}' is not installed in package.json dependencies.`,
            remediation: `Install '${pluginName}' via 'npx expo install ${pluginName}'.`,
            details: { pluginName },
          });
        }
      }
    }
  }

  const passed = findings.every((f) => f.severity !== "blocking");
  return {
    ruleId,
    passed,
    findings,
    scannedFilesCount: scannedCount,
    skippedFilesCount: skippedCount,
    executionTimeMs: Date.now() - startTime,
    limitations: [
      "Static plugin audit verifies presence and exports of declared config plugins. Dynamic native modifications executed during 'expo prebuild' are evaluated separately in Gate 5.",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. RULE-EXPO-ROUTER: Expo Router Directory & Route Contract
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateRuleExpoRouter(
  projectDir: string,
  options: Partial<EvaluateMobileRifOptions> = {}
): MobileRuleEvaluationResult {
  const startTime = Date.now();
  const ruleId: MobileRuleId = "RULE-EXPO-ROUTER";
  const findings: MobileRuleFinding[] = [];
  const maxBytes = options.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_BYTES;

  let scannedCount = 0;
  let skippedCount = 0;

  const appDir = path.join(projectDir, "app");
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    findings.push({
      ruleId,
      code: "MISSING_APP_DIR",
      filePath: "app",
      severity: "blocking",
      message: `Missing 'app/' root directory required by Expo Router. Expo Router uses file-based routing within the 'app/' directory.`,
      remediation: `Create 'app/' directory containing '_layout.tsx' and '+not-found.tsx'.`,
    });
    return {
      ruleId,
      passed: false,
      findings,
      scannedFilesCount: 0,
      skippedFilesCount: 0,
      executionTimeMs: Date.now() - startTime,
      limitations: [],
    };
  }

  // 1. Mandatory Root Layout
  const rootLayoutTsx = path.join(appDir, "_layout.tsx");
  const rootLayoutJs = path.join(appDir, "_layout.js");
  const rootLayoutJsx = path.join(appDir, "_layout.jsx");
  if (!fs.existsSync(rootLayoutTsx) && !fs.existsSync(rootLayoutJs) && !fs.existsSync(rootLayoutJsx)) {
    findings.push({
      ruleId,
      code: "MISSING_ROOT_LAYOUT",
      filePath: "app/_layout.tsx",
      severity: "blocking",
      message: `Missing mandatory root layout 'app/_layout.tsx'. Expo Router requires a root layout to wrap routes and configure navigators.`,
      remediation: `Create 'app/_layout.tsx' exporting a default React component (e.g. <Stack />).`,
    });
  }

  // 2. Mandatory 404 Fallback Route
  const notFoundTsx = path.join(appDir, "+not-found.tsx");
  const notFoundJs = path.join(appDir, "+not-found.js");
  const notFoundJsx = path.join(appDir, "+not-found.jsx");
  if (!fs.existsSync(notFoundTsx) && !fs.existsSync(notFoundJs) && !fs.existsSync(notFoundJsx)) {
    findings.push({
      ruleId,
      code: "MISSING_NOT_FOUND_ROUTE",
      filePath: "app/+not-found.tsx",
      severity: "blocking",
      message: `Missing mandatory 404 fallback route 'app/+not-found.tsx'. Unmatched routes crash without a dedicated fallback screen.`,
      remediation: `Create 'app/+not-found.tsx' exporting a default React component for 404 states.`,
    });
  }

  // 3. Scan all route files in app/
  const routeFiles = collectSourceFiles(appDir, projectDir, {
    extensions: /\.(tsx|ts|jsx|js)$/,
  });

  for (const file of routeFiles) {
    const relPath = toPosixPath(path.relative(projectDir, file));
    const fileName = path.basename(file);

    // Skip declaration files
    if (fileName.endsWith(".d.ts")) continue;

    // Skip private helper files/folders (any path segment under app/ starting with "_" other than "_layout.*")
    const relFromApp = toPosixPath(path.relative(appDir, file));
    const pathSegments = relFromApp.split("/");
    const isPrivate = pathSegments.some(
      (segment) => segment.startsWith("_") && !segment.startsWith("_layout.")
    );
    if (isPrivate) {
      skippedCount++;
      continue;
    }

    // Special configuration files: +native-intent.ts, etc.
    if (fileName.startsWith("+native-intent")) {
      skippedCount++;
      continue;
    }

    const readRes = safeReadProjectFile(file, projectDir, maxBytes);
    if (readRes.finding) {
      findings.push(readRes.finding);
      continue;
    }

    scannedCount++;
    const content = readRes.content || "";

    // Check if it's an API route: under app/api/ or exports HTTP handlers
    const isApiRoute = relPath.startsWith("app/api/") || HTTP_ROUTE_EXPORT_REGEX.test(content);
    if (isApiRoute) {
      if (!HTTP_ROUTE_EXPORT_REGEX.test(content) && !DEFAULT_ROUTE_EXPORT_REGEX.test(content)) {
        findings.push({
          ruleId,
          code: "MISSING_API_ROUTE_HANDLER",
          filePath: relPath,
          severity: "blocking",
          message: `API route file '${relPath}' does not export any HTTP route handlers (GET, POST, PUT, DELETE, PATCH).`,
          remediation: `Export at least one HTTP method handler, e.g. 'export async function GET(request) { ... }'.`,
        });
      }
      continue;
    }

    // Standard screen or layout route: must default-export a React component
    if (!DEFAULT_ROUTE_EXPORT_REGEX.test(content)) {
      findings.push({
        ruleId,
        code: "MISSING_DEFAULT_EXPORT",
        filePath: relPath,
        severity: "blocking",
        message: `Route file '${relPath}' lacks mandatory default component export ('export default function...'). In Expo Router, every screen and layout file must default-export a React component. Missing default exports produce runtime navigation crashes.`,
        remediation: `Add 'export default function Screen() { ... }' to '${relPath}'.`,
      });
    }
  }

  const passed = findings.every((f) => f.severity !== "blocking");
  return {
    ruleId,
    passed,
    findings,
    scannedFilesCount: scannedCount,
    skippedFilesCount: skippedCount,
    executionTimeMs: Date.now() - startTime,
    limitations: [
      "Static route audit verifies file-based routing conventions and default React component exports. Runtime route parameter matching is verified during Stage 5 testing.",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Composed Mobile RIF Evaluator
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateMobileRifRules(
  options: EvaluateMobileRifOptions
): MobileRifSuiteResult {
  const projectDir = path.resolve(options.projectDir);
  let activeRules: MobileRuleId[] = options.rules || [];

  if (activeRules.length === 0) {
    // Deduce active rules from project manifest
    const manifestPath = path.join(projectDir, ".playbook", "manifest.json");
    const declaredStacks: string[] = [];
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        if (Array.isArray(manifest.technology_stacks)) {
          declaredStacks.push(...manifest.technology_stacks);
        }
      } catch {
        // ignore
      }
    }

    const rulesSet = new Set<MobileRuleId>();
    if (declaredStacks.includes("react-native") || declaredStacks.length === 0) {
      rulesSet.add("RULE-RN-COMPANION");
      rulesSet.add("RULE-RN-ACCESSIBILITY");
      rulesSet.add("RULE-MOB-SEC-STORAGE");
    }
    if (declaredStacks.includes("expo")) {
      rulesSet.add("RULE-RN-COMPANION");
      rulesSet.add("RULE-RN-ACCESSIBILITY");
      rulesSet.add("RULE-MOB-SEC-STORAGE");
      rulesSet.add("RULE-EXPO-PLUGINS");
      rulesSet.add("RULE-EXPO-ROUTER");
    }

    activeRules = Array.from(rulesSet);
  }

  const results: Record<MobileRuleId, MobileRuleEvaluationResult> = {} as any;
  let totalFindings = 0;
  let blockingFindings = 0;
  let warningFindings = 0;

  for (const ruleId of activeRules) {
    let evalRes: MobileRuleEvaluationResult;
    switch (ruleId) {
      case "RULE-RN-COMPANION":
        evalRes = evaluateRuleRnCompanion(projectDir, options);
        break;
      case "RULE-RN-ACCESSIBILITY":
        evalRes = evaluateRuleRnAccessibility(projectDir, options);
        break;
      case "RULE-MOB-SEC-STORAGE":
        evalRes = evaluateRuleMobSecStorage(projectDir, options);
        break;
      case "RULE-EXPO-PLUGINS":
        evalRes = evaluateRuleExpoPlugins(projectDir, options);
        break;
      case "RULE-EXPO-ROUTER":
        evalRes = evaluateRuleExpoRouter(projectDir, options);
        break;
      default:
        throw new Error(`Unknown mobile rule ID: ${ruleId}`);
    }

    results[ruleId] = evalRes;
    for (const f of evalRes.findings) {
      totalFindings++;
      if (f.severity === "blocking") blockingFindings++;
      else warningFindings++;
    }
  }

  return {
    passed: blockingFindings === 0,
    totalFindings,
    blockingFindings,
    warningFindings,
    results,
  };
}
