import { parseJsonSafely, findPropertyLocation } from "../schema/helpers.js";

export { parseJsonSafely, findPropertyLocation };

const FORBIDDEN_AGENT_PATTERNS = [
  "agent",
  "bot",
  "controller",
  "playbook",
  "orchestrator",
  "copilot",
  "chatgpt",
  "gemini",
  "antigravity",
  "cursor",
  "deepseek",
  "llama",
  "mistral",
  "grok",
  "qwen",
  "assistant",
  "subagent",
  "synthetic",
  "openai",
  "anthropic",
  "automated",
  "ai",
];

/**
 * Checks whether an actor or approver string indicates a prohibited AI agent.
 */
export function containsProhibitedAgentPattern(name: string): boolean {
  if (!name || typeof name !== "string") return false;
  const lower = name.toLowerCase().trim();
  if (lower.length === 0) return false;

  for (const pattern of FORBIDDEN_AGENT_PATTERNS) {
    // Word boundary or substring check
    const regex = new RegExp(`(^|[^a-z0-9])${pattern}([^a-z0-9]|$)`, "i");
    if (regex.test(lower) || lower.includes(`/${pattern}`) || lower.includes(`${pattern}/`)) {
      return true;
    }
  }

  return false;
}

/**
 * Parses an expiration date string (YYYY-MM-DD or ISO 8601) into a timestamp.
 * Returns null if invalid.
 */
export function parseExpiryDate(rawDate: string): number | null {
  if (!rawDate || typeof rawDate !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(rawDate.trim());
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1;
    const day = parseInt(match[3], 10);
    const date = new Date(Date.UTC(year, month, day, 23, 59, 59, 999));
    return isNaN(date.getTime()) ? null : date.getTime();
  }

  const parsed = Date.parse(rawDate);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Checks whether a field value represents unverified or template placeholder text.
 */
export function isPlaceholder(val: string): boolean {
  if (!val || typeof val !== "string") return true;
  const trimmed = val.trim();
  if (trimmed.length === 0) return true;
  if (/^\[.+\]$/.test(trimmed)) return true;
  if (/^(?:todo|tbd|n\/a|unknown|anonymous|unverified|none|placeholder|undefined|null)$/i.test(trimmed)) {
    return true;
  }
  return false;
}
