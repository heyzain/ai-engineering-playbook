import type { RuleFinding } from "./types.js";

/**
 * Creates a unique deterministic identity signature for finding deduplication.
 */
export function getFindingDeduplicationKey(f: RuleFinding): string {
  const file = f.filePath ?? "";
  const line = f.line ?? 0;
  const col = f.column ?? 0;
  return `${f.ruleId}::${f.diagnosticCode}::${file}:${line}:${col}::${f.severity}::${f.enforcement}::${f.message}`;
}

/**
 * Sorts findings canonically and deterministically.
 * Ordering:
 * 1. File path ascending (null / repository-wide findings first)
 * 2. Line number ascending (null lines first)
 * 3. Column number ascending (null columns first)
 * 4. Rule ID ascending
 * 5. Diagnostic code ascending
 * 6. Message text ascending
 */
export function sortFindings(findings: readonly RuleFinding[]): RuleFinding[] {
  return [...findings].sort((a, b) => {
    // 1. File path (nulls first, then localeCompare)
    const fileA = a.filePath ?? null;
    const fileB = b.filePath ?? null;
    if (fileA === null && fileB !== null) return -1;
    if (fileA !== null && fileB === null) return 1;
    if (fileA !== null && fileB !== null) {
      const cmp = fileA.localeCompare(fileB);
      if (cmp !== 0) return cmp;
    }

    // 2. Line number (nulls first, then numeric ascending)
    const lineA = a.line ?? null;
    const lineB = b.line ?? null;
    if (lineA === null && lineB !== null) return -1;
    if (lineA !== null && lineB === null) return 1;
    if (lineA !== null && lineB !== null && lineA !== lineB) {
      return lineA - lineB;
    }

    // 3. Column number (nulls first, then numeric ascending)
    const colA = a.column ?? null;
    const colB = b.column ?? null;
    if (colA === null && colB !== null) return -1;
    if (colA !== null && colB === null) return 1;
    if (colA !== null && colB !== null && colA !== colB) {
      return colA - colB;
    }

    // 4. Rule ID ascending
    const ruleCmp = a.ruleId.localeCompare(b.ruleId);
    if (ruleCmp !== 0) return ruleCmp;

    // 5. Diagnostic code ascending
    const diagCmp = a.diagnosticCode.localeCompare(b.diagnosticCode);
    if (diagCmp !== 0) return diagCmp;

    // 6. Message ascending
    return a.message.localeCompare(b.message);
  });
}

/**
 * Deduplicates findings deterministically, preserving canonical sort order.
 */
export function deduplicateFindings(findings: readonly RuleFinding[]): RuleFinding[] {
  const seen = new Set<string>();
  const unique: RuleFinding[] = [];

  for (const f of findings) {
    const key = getFindingDeduplicationKey(f);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(f);
    }
  }

  return sortFindings(unique);
}
