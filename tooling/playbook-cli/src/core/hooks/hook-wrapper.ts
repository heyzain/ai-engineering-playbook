import { HOOK_MARKERS, type HookType } from "../../types/hooks.js";

export interface MarkerParseResult {
  hasMarkers: boolean;
  markerState:
    | "valid"
    | "missing"
    | "unbalanced_start"
    | "unbalanced_end"
    | "duplicate_start"
    | "duplicate_end"
    | "reversed";
  managedBlock: string | null;
  contentBefore: string | null;
  contentAfter: string | null;
  startMarkerUsed: string | null;
  endMarkerUsed: string | null;
  hasCompanion?: boolean;
}

/**
 * Parses script content looking for Playbook managed markers.
 * Handles current and legacy marker formats.
 */
export function parseHookMarkers(content: string): MarkerParseResult {
  // Normalize line endings to LF for consistent parsing
  const normalized = content.replace(/\r\n/g, "\n");

  const startMarker = HOOK_MARKERS.start;
  const endMarker = HOOK_MARKERS.end;
  const legacyStart = HOOK_MARKERS.legacyStart;
  const legacyEnd = HOOK_MARKERS.legacyEnd;

  let activeStart: string | null = null;
  let activeEnd: string | null = null;

  const countStart = (normalized.match(new RegExp(escapeRegex(startMarker), "g")) || []).length;
  const countEnd = (normalized.match(new RegExp(escapeRegex(endMarker), "g")) || []).length;

  const countLegacyStart = (normalized.match(new RegExp(escapeRegex(legacyStart), "g")) || []).length;
  const countLegacyEnd = (normalized.match(new RegExp(escapeRegex(legacyEnd), "g")) || []).length;

  const totalStarts = countStart + countLegacyStart;
  const totalEnds = countEnd + countLegacyEnd;

  if (totalStarts === 0 && totalEnds === 0) {
    return {
      hasMarkers: false,
      markerState: "missing",
      managedBlock: null,
      contentBefore: null,
      contentAfter: null,
      startMarkerUsed: null,
      endMarkerUsed: null,
    };
  }

  if (totalStarts > 1) {
    return {
      hasMarkers: true,
      markerState: "duplicate_start",
      managedBlock: null,
      contentBefore: null,
      contentAfter: null,
      startMarkerUsed: null,
      endMarkerUsed: null,
    };
  }

  if (totalEnds > 1) {
    return {
      hasMarkers: true,
      markerState: "duplicate_end",
      managedBlock: null,
      contentBefore: null,
      contentAfter: null,
      startMarkerUsed: null,
      endMarkerUsed: null,
    };
  }

  if (totalStarts === 1 && totalEnds === 0) {
    return {
      hasMarkers: true,
      markerState: "unbalanced_start",
      managedBlock: null,
      contentBefore: null,
      contentAfter: null,
      startMarkerUsed: countStart === 1 ? startMarker : legacyStart,
      endMarkerUsed: null,
    };
  }

  if (totalStarts === 0 && totalEnds === 1) {
    return {
      hasMarkers: true,
      markerState: "unbalanced_end",
      managedBlock: null,
      contentBefore: null,
      contentAfter: null,
      startMarkerUsed: null,
      endMarkerUsed: countEnd === 1 ? endMarker : legacyEnd,
    };
  }

  activeStart = countStart === 1 ? startMarker : legacyStart;
  activeEnd = countEnd === 1 ? endMarker : legacyEnd;

  const startIndex = normalized.indexOf(activeStart);
  const endIndex = normalized.indexOf(activeEnd);

  if (endIndex < startIndex) {
    return {
      hasMarkers: true,
      markerState: "reversed",
      managedBlock: null,
      contentBefore: null,
      contentAfter: null,
      startMarkerUsed: activeStart,
      endMarkerUsed: activeEnd,
    };
  }

  const contentBefore = normalized.slice(0, startIndex);
  const managedBlock = normalized.slice(startIndex, endIndex + activeEnd.length);
  const contentAfter = normalized.slice(endIndex + activeEnd.length);
  const hasCompanion = /# Has Companion Hook:\s*true/i.test(managedBlock);

  return {
    hasMarkers: true,
    markerState: "valid",
    managedBlock,
    contentBefore,
    contentAfter,
    startMarkerUsed: activeStart,
    endMarkerUsed: activeEnd,
    hasCompanion,
  };
}

/**
 * Checks if a hook file consists purely of a Playbook managed wrapper
 * (optional shebang, blank lines, and the managed block).
 */
export function isPurePlaybookWrapper(content: string): boolean {
  const parsed = parseHookMarkers(content);
  if (parsed.markerState !== "valid" || !parsed.managedBlock) {
    return false;
  }

  const beforeTrimmed = (parsed.contentBefore || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#!"))
    .join("");

  const afterTrimmed = (parsed.contentAfter || "").trim();

  return beforeTrimmed.length === 0 && afterTrimmed.length === 0;
}

/**
 * Generates the managed wrapper block for a given hook type.
 * Always formatted with POSIX LF line endings.
 */
export function generateManagedBlock(
  hookType: HookType,
  timestamp = new Date().toISOString(),
  allowInert = false,
  hasCompanion = false
): string {
  const runArgs = allowInert ? `${hookType} --allow-inert` : hookType;
  const lines = [
    HOOK_MARKERS.start,
    `# Playbook CLI Version: 1.0.0`,
    `# Hook Type: ${hookType}`,
    `# Installed At: ${timestamp}`,
    `# Has Companion Hook: ${hasCompanion ? "true" : "false"}`,
    ``,
    `# Barrier 1: Prevent recursive loop of original companion hook`,
    `# If the companion hook internally executes a Git command, prevent infinite recursion and fail explicitly`,
    `if [ "$PLAYBOOK_ORIG_HOOK_ACTIVE" = "1" ]; then`,
    `  echo "[playbook hook] Error: Recursive hook invocation detected: original companion hook is already active." >&2`,
    `  exit 1`,
    `fi`,
    ``,
    `# Resolve hook directory and original script companion`,
    `HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"`,
    `ORIGINAL_HOOK="$HOOK_DIR/${hookType}.playbook-orig"`,
    ``,
    `# Standard input handling for hooks that consume stdin (pre-push)`,
    `# Secure temporary file creation with restricted mode (0600) to prevent secret leakage`,
    `TMP_STDIN=""`,
    `if [ ! -t 0 ]; then`,
    `  TMP_STDIN="$(mktemp -t playbook-hook-stdin.XXXXXX 2>/dev/null || mktemp "\${TMPDIR:-/tmp}/playbook-hook-stdin.XXXXXX" 2>/dev/null || mktemp)"`,
    `  if [ -n "$TMP_STDIN" ] && [ -f "$TMP_STDIN" ]; then`,
    `    chmod 0600 "$TMP_STDIN" 2>/dev/null || true`,
    `    cat > "$TMP_STDIN"`,
    `  fi`,
    `fi`,
    ``,
    `# Cleanup trap for ephemeral standard input buffer`,
    `cleanup() {`,
    `  if [ -n "$TMP_STDIN" ] && [ -f "$TMP_STDIN" ]; then`,
    `    rm -f "$TMP_STDIN"`,
    `  fi`,
    `}`,
    `trap cleanup EXIT INT TERM HUP`,
    ``,
    `# Step 1: Execute Playbook quality check first (Fail-Fast Gatekeeper)`,
    `# Guarded against recursion: if Playbook validation is already active in parent process, skip re-validation`,
    `if [ "$PLAYBOOK_HOOK_ACTIVE" != "1" ]; then`,
    `  export PLAYBOOK_HOOK_ACTIVE=1`,
    `  PLAYBOOK_BIN=""`,
    `  if command -v playbook >/dev/null 2>&1; then`,
    `    PLAYBOOK_BIN="playbook"`,
    `  elif [ -f "./node_modules/.bin/playbook" ]; then`,
    `    PLAYBOOK_BIN="./node_modules/.bin/playbook"`,
    `  fi`,
    ``,
    `  if [ -n "$PLAYBOOK_BIN" ]; then`,
    `    if [ -n "$TMP_STDIN" ]; then`,
    `      "$PLAYBOOK_BIN" hook run ${runArgs} "$@" < "$TMP_STDIN"`,
    `    else`,
    `      "$PLAYBOOK_BIN" hook run ${runArgs} "$@"`,
    `    fi`,
    `    STATUS=$?`,
    `    if [ $STATUS -ne 0 ]; then`,
    `      # Playbook validation failed: block lifecycle operation immediately.`,
    `      # The original hook is strictly NOT executed to prevent unverified code propagation.`,
    `      exit $STATUS`,
    `    fi`,
    `  else`,
    `    echo "[playbook hook] Warning: 'playbook' CLI not found on PATH. Skipping check." >&2`,
    `  fi`,
    `fi`,
    ``,
    `# Step 2: Execute original companion hook if configured or present`,
    `# Delivers exact original arguments ("$@") and exact buffered stdin`,
    `HAS_COMPANION="${hasCompanion ? "1" : "0"}"`,
    `if [ "$HAS_COMPANION" = "1" ] || [ -f "$ORIGINAL_HOOK" ]; then`,
    `  if [ ! -f "$ORIGINAL_HOOK" ]; then`,
    `    echo "[playbook hook] Error: Expected original companion hook '$ORIGINAL_HOOK' is missing." >&2`,
    `    exit 1`,
    `  fi`,
    `  if [ ! -x "$ORIGINAL_HOOK" ]; then`,
    `    echo "[playbook hook] Warning: Original companion hook '$ORIGINAL_HOOK' is not executable." >&2`,
    `    exit 1`,
    `  fi`,
    `  export PLAYBOOK_ORIG_HOOK_ACTIVE=1`,
    `  if [ -n "$TMP_STDIN" ]; then`,
    `    "$ORIGINAL_HOOK" "$@" < "$TMP_STDIN"`,
    `  else`,
    `    "$ORIGINAL_HOOK" "$@"`,
    `  fi`,
    `  exit $?`,
    `fi`,
    ``,
    `exit 0`,
    HOOK_MARKERS.end,
  ];

  return lines.join("\n");
}

/**
 * Generates a full standalone POSIX shell wrapper script.
 * Uses LF line endings.
 */
export function generateWrapperScript(
  hookType: HookType,
  timestamp = new Date().toISOString(),
  allowInert = false,
  hasCompanion = false
): string {
  const block = generateManagedBlock(hookType, timestamp, allowInert, hasCompanion);
  return `#!/bin/sh\n${block}\n`;
}

/**
 * Builds updated hook script content preserving any surrounding user code.
 */
export function buildWrapperWithPreservedUserContent(
  userContentBefore: string,
  userContentAfter: string,
  hookType: HookType,
  timestamp = new Date().toISOString(),
  allowInert = false,
  hasCompanion = false
): string {
  const newBlock = generateManagedBlock(hookType, timestamp, allowInert, hasCompanion);
  const before = userContentBefore.endsWith("\n") ? userContentBefore : userContentBefore + "\n";
  const after = userContentAfter.startsWith("\n") ? userContentAfter : "\n" + userContentAfter;
  return `${before}${newBlock}${after}`;
}

/**
 * Excises only the managed block from a hook script, preserving surrounding user commands.
 */
export function exciseManagedBlock(content: string): string {
  const parsed = parseHookMarkers(content);
  if (parsed.markerState !== "valid" || !parsed.managedBlock) {
    return content;
  }

  const before = parsed.contentBefore || "";
  const after = parsed.contentAfter || "";
  return `${before.trimEnd()}\n\n${after.trimStart()}`.trim() + "\n";
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
