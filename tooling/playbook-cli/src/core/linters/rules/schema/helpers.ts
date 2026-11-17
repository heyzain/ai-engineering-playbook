import path from "node:path";
import fs from "node:fs";
import { SchemaValidator } from "../../../validator.js";

export interface ParsedJsonResult<T = unknown> {
  success: boolean;
  data?: T;
  syntaxError?: {
    message: string;
    line: number | null;
    column: number | null;
  };
}

/**
 * Safely parses a JSON string, extracting precise 1-based line and column coordinates
 * if a syntax error occurs.
 */
export function parseJsonSafely<T = unknown>(content: string): ParsedJsonResult<T> {
  try {
    const data = JSON.parse(content) as T;
    return { success: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    let line: number | null = null;
    let column: number | null = null;

    // Pattern 1: Node.js 18+ format "at line X column Y"
    const lineColMatch = /at line (\d+) column (\d+)/i.exec(message);
    if (lineColMatch) {
      line = parseInt(lineColMatch[1], 10);
      column = parseInt(lineColMatch[2], 10);
    } else {
      // Pattern 2: "in JSON at position X"
      const posMatch = /position\s+(\d+)/i.exec(message);
      if (posMatch) {
        const pos = parseInt(posMatch[1], 10);
        if (!isNaN(pos) && pos >= 0 && pos <= content.length) {
          const prefix = content.slice(0, pos);
          const lines = prefix.split("\n");
          line = lines.length;
          column = lines[lines.length - 1].length + 1;
        }
      }
    }

    return {
      success: false,
      syntaxError: {
        message,
        line,
        column,
      },
    };
  }
}

/**
 * Locates the 1-based line number for a specific JSON schema instancePath (e.g. "/tech_stack/primary_language").
 */
export function findPropertyLocation(
  content: string,
  instancePath: string
): { line: number | null; column: number | null } {
  if (!instancePath || instancePath === "/") {
    return { line: 1, column: 1 };
  }

  const parts = instancePath.split("/").filter(Boolean);
  if (parts.length === 0) {
    return { line: 1, column: 1 };
  }

  const targetProp = parts[parts.length - 1];
  const lines = content.split("\n");

  const escaped = targetProp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const propRegex = new RegExp(`"${escaped}"\\s*:`);

  for (let i = 0; i < lines.length; i++) {
    const match = propRegex.exec(lines[i]);
    if (match) {
      return { line: i + 1, column: match.index + 1 };
    }
  }

  return { line: 1, column: null };
}

/**
 * Instantiates or resolves the canonical SchemaValidator, checking local project schemas first.
 */
export function getOrCreateValidator(projectDir: string): SchemaValidator {
  const localSchemas = path.join(projectDir, "schemas");
  if (fs.existsSync(path.join(localSchemas, "project-manifest.schema.json"))) {
    try {
      return new SchemaValidator(localSchemas);
    } catch {
      // fallback to bundled
    }
  }
  return new SchemaValidator();
}
