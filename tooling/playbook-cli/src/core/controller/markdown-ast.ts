/**
 * Lightweight, robust Markdown AST tokenizer and document model.
 * Provides deterministic structural parsing for governance documents (Exceptions, Exit Packages, PRDs, ADRs).
 */

export type AstNodeType =
  | "root"
  | "heading"
  | "paragraph"
  | "table"
  | "code_block"
  | "blockquote"
  | "list"
  | "list_item"
  | "html_comment";

export interface BaseAstNode {
  type: AstNodeType;
  startLine: number;
  endLine: number;
  raw: string;
}

export interface HeadingNode extends BaseAstNode {
  type: "heading";
  level: number; // 1 to 6
  text: string;  // Cleaned heading text
}

export interface TableRow {
  cells: string[];
  lineNumber: number;
  raw: string;
}

export interface TableNode extends BaseAstNode {
  type: "table";
  headers: string[];
  rows: TableRow[];
}

export interface CodeBlockNode extends BaseAstNode {
  type: "code_block";
  language: string;
  content: string;
  fence: string;
}

export interface BlockquoteNode extends BaseAstNode {
  type: "blockquote";
  text: string;
}

export interface ListItemNode extends BaseAstNode {
  type: "list_item";
  text: string;
  isOrdered: boolean;
  orderNumber?: number;
}

export interface ListNode extends BaseAstNode {
  type: "list";
  items: ListItemNode[];
  isOrdered: boolean;
}

export interface ParagraphNode extends BaseAstNode {
  type: "paragraph";
  text: string;
}

export interface HtmlCommentNode extends BaseAstNode {
  type: "html_comment";
  content: string;
}

export type AstNode =
  | HeadingNode
  | TableNode
  | CodeBlockNode
  | BlockquoteNode
  | ListNode
  | ListItemNode
  | ParagraphNode
  | HtmlCommentNode;

export interface SectionMatch {
  heading: HeadingNode;
  contentNodes: AstNode[];
}

export interface PlaceholderOccurrence {
  token: string;
  line: number;
  rawText: string;
}

/**
 * Common unresolved template placeholder tokens.
 */
export const PLACEHOLDER_PATTERNS = [
  /\[TODO\b[^\]]*\]/i,
  /\[TBD\b[^\]]*\]/i,
  /\[INSERT\b[^\]]*\]/i,
  /\[PLACEHOLDER\b[^\]]*\]/i,
  /\[REQUIRED\b[^\]]*\]/i,
  /\[FIXME\b[^\]]*\]/i,
  /<!--\s*TODO\b[^>]*-->/i,
  /<!--\s*REPLACE\b[^>]*-->/i,
  /<!--\s*INSERT\b[^>]*-->/i,
  /<!--\s*TODO\b/i,
  /<!--\s*REPLACE\b/i,
];

export const FORBIDDEN_SUBSTRINGS = [
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
];

/**
 * Checks whether an actor name contains forbidden agent keywords or patterns.
 */
export function isForbiddenAgentName(name: string): boolean {
  if (!name || typeof name !== "string" || name.trim().length === 0) return true;
  const lower = name.toLowerCase();
  for (const sub of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(sub)) return true;
  }
  if (/\b(ai|llm|gpt|claude)\b/i.test(lower)) {
    return true;
  }
  return false;
}

/**
 * Strips markdown inline markup (bold, italics, code backticks) from a string.
 */
export function cleanMarkdownInline(str: string): string {
  if (!str) return "";
  let s = str.trim();
  // Strip enclosing backticks
  s = s.replace(/^`+|`+$/g, "").trim();
  // Strip bold/italics
  s = s.replace(/^\*\*+|\*\*+$/g, "").trim();
  s = s.replace(/^\*+|\*+$/g, "").trim();
  s = s.replace(/^__+|__+$/g, "").trim();
  s = s.replace(/^_|_$/g, "").trim();
  // Strip trailing notes in parentheses with italics like *(Mandatory review deadline)*
  s = s.replace(/\s*\*\([^)]*\)\*/g, "").trim();
  return s;
}

/**
 * Clean table cell text
 */
function cleanTableCell(cell: string): string {
  // Unescape escaped pipe characters and strip inline markdown
  return cleanMarkdownInline(cell.replace(/\\\|/g, "|").trim());
}

/**
 * Splits a table line into individual cell strings, respecting
 * escaped pipe characters (\|) and inline code spans (`...|...`).
 */
export function splitTableLine(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let inBacktick = false;
  let escape = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      current += ch;
      continue;
    }
    if (ch === "`") {
      inBacktick = !inBacktick;
      current += ch;
      continue;
    }
    if (ch === "|" && !inBacktick) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Tests whether a line is a markdown table delimiter row (e.g. `| :--- | :--- |` or `|---|---|`).
 */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("-")) return false;
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const parts = stripped.split("|").map((p) => p.trim());
  if (parts.length === 0) return false;
  return parts.every((p) => /^:?-+:?$/.test(p));
}

export interface MarkdownSyntaxError {
  message: string;
  line: number;
}

/**
 * Markdown Document parsed into structured AST nodes.
 */
export class MarkdownDocument {
  readonly nodes: AstNode[];
  readonly rawContent: string;
  readonly syntaxErrors: MarkdownSyntaxError[];

  constructor(
    nodes: AstNode[],
    rawContent: string,
    syntaxErrors: MarkdownSyntaxError[] = []
  ) {
    this.nodes = nodes;
    this.rawContent = rawContent;
    this.syntaxErrors = syntaxErrors;
  }

  getHeadings(level?: number): HeadingNode[] {
    const headings = this.nodes.filter(
      (n): n is HeadingNode => n.type === "heading"
    );
    if (level !== undefined) {
      return headings.filter((h) => h.level === level);
    }
    return headings;
  }

  getTables(): TableNode[] {
    return this.nodes.filter((n): n is TableNode => n.type === "table");
  }

  getCodeBlocks(): CodeBlockNode[] {
    return this.nodes.filter((n): n is CodeBlockNode => n.type === "code_block");
  }

  getComments(): HtmlCommentNode[] {
    return this.nodes.filter((n): n is HtmlCommentNode => n.type === "html_comment");
  }

  getParagraphs(): ParagraphNode[] {
    return this.nodes.filter((n): n is ParagraphNode => n.type === "paragraph");
  }

  /**
   * Finds a section by heading text pattern and returns the heading node
   * along with all child AST nodes until the next heading of equal or higher level.
   */
  findSection(
    pattern: RegExp | string,
    level?: number
  ): SectionMatch | null {
    const reg = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
    let targetIndex = -1;
    let targetHeading: HeadingNode | null = null;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (node.type === "heading") {
        if (level !== undefined && node.level !== level) {
          continue;
        }
        if (reg.test(node.text) || reg.test(node.raw)) {
          targetIndex = i;
          targetHeading = node;
          break;
        }
      }
    }

    if (!targetHeading || targetIndex < 0) {
      return null;
    }

    const contentNodes: AstNode[] = [];
    for (let i = targetIndex + 1; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      if (node.type === "heading" && node.level <= targetHeading.level) {
        break;
      }
      contentNodes.push(node);
    }

    return {
      heading: targetHeading,
      contentNodes,
    };
  }

  /**
   * Extracts key-value mappings from a 2-column or 3-column table.
   * Maps normalized key to { value, line, rawKey }.
   */
  extractTableKeyValues(
    table: TableNode
  ): Map<string, { value: string; line: number; rawKey: string }> {
    const map = new Map<string, { value: string; line: number; rawKey: string }>();

    for (const row of table.rows) {
      if (row.cells.length >= 2) {
        const rawKey = row.cells[0];
        const cleanKey = cleanMarkdownInline(rawKey).toLowerCase();
        const cleanVal = cleanMarkdownInline(row.cells[1]);
        map.set(cleanKey, {
          value: cleanVal,
          line: row.lineNumber,
          rawKey,
        });
      }
    }

    return map;
  }

  /**
   * Scans nodes for unresolved template placeholder tokens.
   * By default, ignores code blocks and examples.
   */
  findPlaceholders(options: {
    excludeCodeBlocks?: boolean;
    excludeComments?: boolean;
    targetNodes?: AstNode[];
  } = {}): PlaceholderOccurrence[] {
    const excludeCodeBlocks = options.excludeCodeBlocks !== false;
    const excludeComments = options.excludeComments === true;
    const targetNodes = options.targetNodes || this.nodes;
    const results: PlaceholderOccurrence[] = [];

    for (const node of targetNodes) {
      if (excludeCodeBlocks && node.type === "code_block") {
        continue;
      }
      if (excludeComments && node.type === "html_comment") {
        continue;
      }

      // Check text in node
      let textToCheck = "";
      if (node.type === "paragraph" || node.type === "blockquote") {
        textToCheck = node.text;
      } else if (node.type === "heading") {
        textToCheck = node.text;
      } else if (node.type === "list_item") {
        textToCheck = node.text;
      } else if (node.type === "html_comment") {
        textToCheck = node.content;
      } else if (node.type === "table") {
        // Check rows
        for (const row of node.rows) {
          for (const cell of row.cells) {
            for (const pat of PLACEHOLDER_PATTERNS) {
              const m = pat.exec(cell);
              if (m) {
                results.push({
                  token: m[0],
                  line: row.lineNumber,
                  rawText: cell,
                });
                break;
              }
            }
          }
        }
        continue;
      } else if (node.type === "list") {
        for (const item of node.items) {
          for (const pat of PLACEHOLDER_PATTERNS) {
            const m = pat.exec(item.text);
            if (m) {
              results.push({
                token: m[0],
                line: item.startLine,
                rawText: item.text,
              });
              break;
            }
          }
        }
        continue;
      }

      if (textToCheck) {
        for (const pat of PLACEHOLDER_PATTERNS) {
          const m = pat.exec(textToCheck);
          if (m) {
            results.push({
              token: m[0],
              line: node.startLine,
              rawText: textToCheck,
            });
            break;
          }
        }
      }
    }

    return results;
  }
}

/**
 * Markdown AST Parser
 */
export class MarkdownParser {
  /**
   * Parses markdown raw string into a structured MarkdownDocument AST.
   */
  static parse(content: string): MarkdownDocument {
    const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const nodes: AstNode[] = [];
    const syntaxErrors: MarkdownSyntaxError[] = [];
    const totalLines = lines.length;

    let i = 0;
    while (i < totalLines) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // 1. Empty lines
      if (trimmed.length === 0) {
        i++;
        continue;
      }

      // 2. Fenced Code Block (``` or ~~~)
      const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
      if (fenceMatch) {
        const fenceStr = fenceMatch[1];
        const fenceChar = fenceStr[0];
        const minFenceLen = fenceStr.length;
        const lang = fenceMatch[2].trim();
        const startLine = lineNum;
        const codeLines: string[] = [];

        i++;
        let closed = false;
        while (i < totalLines) {
          const curLine = lines[i];
          const curTrimmed = curLine.trim();
          const closeMatch = curTrimmed.match(/^(`{3,}|~{3,})$/);
          if (
            closeMatch &&
            closeMatch[1][0] === fenceChar &&
            closeMatch[1].length >= minFenceLen
          ) {
            closed = true;
            i++;
            break;
          }
          codeLines.push(curLine);
          i++;
        }

        if (!closed) {
          syntaxErrors.push({
            message: `Unclosed fenced code block starting at line ${startLine}.`,
            line: startLine,
          });
        }

        nodes.push({
          type: "code_block",
          language: lang,
          content: codeLines.join("\n"),
          fence: fenceStr,
          startLine,
          endLine: closed ? i : totalLines,
          raw: lines.slice(startLine - 1, closed ? i : totalLines).join("\n"),
        });
        continue;
      }

      // 3. HTML Comments (<!-- ... -->)
      if (trimmed.startsWith("<!--")) {
        const startLine = lineNum;
        const commentLines: string[] = [];

        if (trimmed.includes("-->")) {
          // Single line comment
          nodes.push({
            type: "html_comment",
            content: trimmed,
            startLine,
            endLine: lineNum,
            raw: line,
          });
          i++;
          continue;
        }

        // Multi-line comment
        commentLines.push(line);
        i++;
        let closed = false;
        while (i < totalLines) {
          const curLine = lines[i];
          commentLines.push(curLine);
          if (curLine.includes("-->")) {
            closed = true;
            i++;
            break;
          }
          i++;
        }

        if (!closed) {
          syntaxErrors.push({
            message: `Unclosed HTML comment starting at line ${startLine}.`,
            line: startLine,
          });
        }

        nodes.push({
          type: "html_comment",
          content: commentLines.join("\n"),
          startLine,
          endLine: closed ? i : totalLines,
          raw: commentLines.join("\n"),
        });
        continue;
      }

      // 4. Headings (# Heading)
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        let text = headingMatch[2].trim();
        // Remove trailing hashes if any (e.g. `## Section 1 ##`)
        text = text.replace(/\s+#+$/, "").trim();
        nodes.push({
          type: "heading",
          level,
          text,
          startLine: lineNum,
          endLine: lineNum,
          raw: line,
        });
        i++;
        continue;
      }

      // 5. Tables (Pipe tables)
      // Check if line contains pipes and next line is a table delimiter
      if (line.includes("|") && i + 1 < totalLines && isTableDelimiter(lines[i + 1])) {
        const startLine = lineNum;
        const headers = splitTableLine(line).map(cleanTableCell);
        const rows: TableRow[] = [];

        // Skip delimiter row (i + 1)
        i += 2;

        while (i < totalLines) {
          const curLine = lines[i];
          const curTrimmed = curLine.trim();
          if (curTrimmed.length === 0 || !curLine.includes("|")) {
            break;
          }
          rows.push({
            cells: splitTableLine(curLine).map(cleanTableCell),
            lineNumber: i + 1,
            raw: curLine,
          });
          i++;
        }

        nodes.push({
          type: "table",
          headers,
          rows,
          startLine,
          endLine: i,
          raw: lines.slice(startLine - 1, i).join("\n"),
        });
        continue;
      }

      // 6. Blockquotes (> ...)
      if (trimmed.startsWith(">")) {
        const startLine = lineNum;
        const bqLines: string[] = [];

        while (i < totalLines) {
          const curLine = lines[i];
          const curTrimmed = curLine.trim();
          if (!curTrimmed.startsWith(">") && curTrimmed.length === 0) {
            break;
          }
          if (curTrimmed.startsWith(">")) {
            bqLines.push(curTrimmed.replace(/^>\s?/, ""));
          } else {
            // Lazy continuation line
            bqLines.push(curTrimmed);
          }
          i++;
        }

        nodes.push({
          type: "blockquote",
          text: bqLines.join("\n"),
          startLine,
          endLine: i,
          raw: lines.slice(startLine - 1, i).join("\n"),
        });
        continue;
      }

      // 7. Lists (- item, * item, 1. item)
      const listMatch = trimmed.match(/^(\d+\.|[*+-])\s+(.*)$/);
      if (listMatch) {
        const startLine = lineNum;
        const items: ListItemNode[] = [];
        const isOrdered = /^\d+\./.test(listMatch[1]);

        while (i < totalLines) {
          const curLine = lines[i];
          const curTrimmed = curLine.trim();
          const itemMatch = curTrimmed.match(/^(\d+\.|[*+-])\s+(.*)$/);
          if (!itemMatch) {
            break;
          }
          const itemOrdered = /^\d+\./.test(itemMatch[1]);
          const orderNum = itemOrdered ? parseInt(itemMatch[1], 10) : undefined;
          items.push({
            type: "list_item",
            text: itemMatch[2].trim(),
            isOrdered: itemOrdered,
            orderNumber: orderNum,
            startLine: i + 1,
            endLine: i + 1,
            raw: curLine,
          });
          i++;
        }

        nodes.push({
          type: "list",
          items,
          isOrdered,
          startLine,
          endLine: i,
          raw: lines.slice(startLine - 1, i).join("\n"),
        });
        continue;
      }

      // 8. Paragraphs (Contiguous non-empty lines)
      const startLine = lineNum;
      const pLines: string[] = [];
      while (i < totalLines) {
        const curLine = lines[i];
        const curTrimmed = curLine.trim();
        if (
          curTrimmed.length === 0 ||
          curTrimmed.startsWith("#") ||
          curTrimmed.startsWith("```") ||
          curTrimmed.startsWith("~~~") ||
          curTrimmed.startsWith("<!--") ||
          curTrimmed.startsWith(">") ||
          /^(\d+\.|[*+-])\s+/.test(curTrimmed) ||
          (curLine.includes("|") && i + 1 < totalLines && isTableDelimiter(lines[i + 1]))
        ) {
          break;
        }
        pLines.push(curLine);
        i++;
      }

      nodes.push({
        type: "paragraph",
        text: pLines.join("\n"),
        startLine,
        endLine: i,
        raw: pLines.join("\n"),
      });
    }

    return new MarkdownDocument(nodes, content, syntaxErrors);
  }
}
