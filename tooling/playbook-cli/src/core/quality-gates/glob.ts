import { toPosixPath, normalizeRelativePath } from "../../utils/paths.js";

/**
 * Converts a glob pattern (e.g. `src/**\/*.ts`, `*.json`, `docs/*`) into a standard RegExp.
 * Normalizes backslashes to forward slashes.
 */
export function globToRegex(glob: string): RegExp {
  const normalized = normalizeRelativePath(glob.trim());
  let regexStr = "^";
  let i = 0;
  const len = normalized.length;

  while (i < len) {
    const c = normalized[i];
    if (c === "*") {
      if (i + 1 < len && normalized[i + 1] === "*") {
        // Double star `**`
        if (i + 2 < len && normalized[i + 2] === "/") {
          regexStr += "(?:.*\\/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        // Single star `*` - matches within path segment
        regexStr += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if (
      c === "." ||
      c === "+" ||
      c === "^" ||
      c === "$" ||
      c === "{" ||
      c === "}" ||
      c === "(" ||
      c === ")" ||
      c === "|" ||
      c === "[" ||
      c === "]" ||
      c === "\\"
    ) {
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }

  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Tests whether a relative file path matches a glob pattern.
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const normPath = normalizeRelativePath(filePath);
  const regex = globToRegex(pattern);
  return regex.test(normPath);
}

/**
 * Tests whether a relative file path matches any pattern in the list.
 */
export function matchesAnyGlob(filePath: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  const normPath = normalizeRelativePath(filePath);
  for (const pattern of patterns) {
    if (matchesGlob(normPath, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates that text_patterns and binary_patterns do not directly conflict.
 * Returns array of conflicting patterns.
 */
export function findConflictingPatterns(
  textPatterns?: string[],
  binaryPatterns?: string[]
): string[] {
  if (!textPatterns || !binaryPatterns) {
    return [];
  }
  const conflicts: string[] = [];
  const textSet = new Set(textPatterns.map((p) => normalizeRelativePath(p.trim())));
  for (const bp of binaryPatterns) {
    const norm = normalizeRelativePath(bp.trim());
    if (textSet.has(norm)) {
      conflicts.push(norm);
    }
  }
  return conflicts;
}
