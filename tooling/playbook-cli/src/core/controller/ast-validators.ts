import path from "node:path";
import {
  MarkdownParser,
  MarkdownDocument,
  AstNode,
  HeadingNode,
  TableNode,
  cleanMarkdownInline,
  PLACEHOLDER_PATTERNS,
  isForbiddenAgentName,
} from "./markdown-ast.js";
import { ControllerError } from "./types.js";

/**
 * Diagnostic finding produced by AST governance validation.
 */
export interface AstDiagnostic {
  code: string;
  message: string;
  line: number;
  severity: "error" | "warning";
  source?: string;
  token?: string;
}

/**
 * Parsed and validated metadata extracted from an exception document.
 */
export interface ValidatedExceptionMetadata {
  exception_id: string;
  title: string;
  status: string;
  waived_requirement: string;
  authorized_by: string;
  expiration_date: string;
}

/**
 * Result of validating an Exception document AST.
 */
export interface ExceptionValidationResult {
  valid: boolean;
  errors: string[];
  diagnostics: AstDiagnostic[];
  metadata?: ValidatedExceptionMetadata;
}

/**
 * Result of validating an Exit Package AST.
 */
export interface ExitPackageAstResult {
  valid: boolean;
  errors: string[];
  diagnostics: AstDiagnostic[];
  stage?: number;
}

export interface ValidateExitPackageOptions {
  stage?: number;
  strict?: boolean;
}

/**
 * AST-based Exception Document Validator
 */
export class ExceptionValidator {
  /**
   * Validates an exception markdown file AST against canonical governance requirements:
   * 1. Filename conforms to EXC-YYYYMMDD-###.md
   * 2. Exception ID matches filename pattern
   * 3. Top-level H1 heading present
   * 4. Metadata table with status Approved / Active
   * 5. Waived requirement references deliverable
   * 6. Strict UTC expiration boundary (YYYY-MM-DDT23:59:59.999Z)
   * 7. Documentary human attribution (non-empty, non-synthetic agent name)
   * 8. Mandatory template sections present
   * 9. Substantive content in justification and controls (no placeholders)
   */
  static validate(
    content: string,
    filePath: string,
    deliverableId?: string,
    now?: Date,
    mode: "legacy" | "proposal" = "legacy"
  ): ExceptionValidationResult {
    const errors: string[] = [];
    const diagnostics: AstDiagnostic[] = [];
    const evalTime = now || new Date();

    const baseName = path.basename(filePath);
    const idMatch = baseName.match(/^(EXC-[0-9]{8}-[0-9]{3})\.md$/i);
    if (!idMatch) {
      const msg = `Exception file name "${baseName}" does not conform to canonical pattern "EXC-YYYYMMDD-###.md".`;
      errors.push(msg);
      diagnostics.push({
        code: "EXCEPTION_METADATA_INVALID",
        message: msg,
        line: 1,
        severity: "error",
        source: filePath,
      });
      return { valid: false, errors, diagnostics };
    }

    const expectedId = idMatch[1].toUpperCase();

    if (!content || content.trim().length === 0) {
      const msg = `Exception document "${baseName}" is empty.`;
      errors.push(msg);
      diagnostics.push({
        code: "EXCEPTION_METADATA_INVALID",
        message: msg,
        line: 1,
        severity: "error",
        source: filePath,
      });
      return { valid: false, errors, diagnostics };
    }

    const doc = MarkdownParser.parse(content);

    // Fail closed immediately on Markdown syntax errors (e.g. unclosed code blocks/comments)
    if (doc.syntaxErrors.length > 0) {
      for (const err of doc.syntaxErrors) {
        errors.push(err.message);
        diagnostics.push({
          code: "SYNTAX_ERROR",
          message: err.message,
          line: err.line,
          severity: "error",
          source: filePath,
        });
      }
      return { valid: false, errors, diagnostics };
    }

    // 1. Title from Top Header H1
    const headings = doc.getHeadings();
    const h1 = headings.find((h) => h.level === 1);
    let title = "Authorized Gate Exception";
    if (h1) {
      const h1IdMatch = h1.text.match(/^(EXC-[0-9]{8}-[0-9]{3})/i);
      if (h1IdMatch && h1IdMatch[1].toUpperCase() !== expectedId) {
        const msg = `Exception ID in heading ("${h1IdMatch[1].toUpperCase()}") does not match file name identifier ("${expectedId}").`;
        errors.push(msg);
        diagnostics.push({
          code: "EXCEPTION_METADATA_INVALID",
          message: msg,
          line: h1.startLine,
          severity: "error",
          source: filePath,
        });
      }
      const titleClean = h1.text.replace(/^EXC-[0-9]{8}-[0-9]{3}[:\s-]*/i, "").trim();
      if (titleClean) {
        title = titleClean.replace(/^\[|\]$/g, "").trim();
      }
    } else {
      diagnostics.push({
        code: "EXCEPTION_METADATA_INVALID",
        message: `Exception document "${baseName}" is missing top-level '# EXC-...' heading.`,
        line: 1,
        severity: "warning",
        source: filePath,
      });
    }

    // 2. Extract Key-Values from Tables & Detect Contradictions
    const tables = doc.getTables();
    const declaredFields = new Map<string, { value: string; line: number }>();

    for (const table of tables) {
      const kvs = doc.extractTableKeyValues(table);
      for (const [key, entry] of kvs.entries()) {
        let canonicalKey: string | null = null;
        if (key === "exception id" || key.includes("exception id")) {
          canonicalKey = "exception_id";
        } else if (key === "exception status" || key === "status") {
          canonicalKey = "status";
        } else if (key.includes("waived") || key.includes("requirement") || key.includes("deliverable")) {
          canonicalKey = "waived_requirement";
        } else if (key.includes("authorized by") || key === "authorizer" || key.includes("authorizer name")) {
          canonicalKey = "authorized_by";
        } else if (key.includes("expiration") || key.includes("review date")) {
          canonicalKey = "expiration_date";
        }

        if (canonicalKey) {
          const existing = declaredFields.get(canonicalKey);
          if (existing && existing.value.toLowerCase() !== entry.value.toLowerCase()) {
            const msg = `Contradictory metadata declarations detected: duplicate "${canonicalKey}" ("${existing.value}" at line ${existing.line} vs "${entry.value}" at line ${entry.line}).`;
            errors.push(msg);
            diagnostics.push({
              code: "EXCEPTION_METADATA_INVALID",
              message: msg,
              line: entry.line,
              severity: "error",
              source: filePath,
            });
          } else if (!existing) {
            let val = entry.value;
            if (canonicalKey === "expiration_date") {
              const dMatch = val.match(/([0-9]{4}-[0-9]{2}-[0-9]{2})/);
              if (dMatch) val = dMatch[1];
            }
            declaredFields.set(canonicalKey, { value: val, line: entry.line });
          }
        }
      }
    }

    const foundId = declaredFields.get("exception_id")?.value || null;
    const statusStr = declaredFields.get("status")?.value || null;
    const waivedReq = declaredFields.get("waived_requirement")?.value || null;
    let authorizedBy = declaredFields.get("authorized_by")?.value || null;
    const expirationDate = declaredFields.get("expiration_date")?.value || null;

    // Fallback: If authorizer table in section 2 has different headers
    if (!authorizedBy) {
      for (const table of tables) {
        for (const row of table.rows) {
          if (row.cells.length >= 2) {
            const cell0 = cleanMarkdownInline(row.cells[0]).toLowerCase();
            if (cell0.includes("authorized by")) {
              authorizedBy = cleanMarkdownInline(row.cells[1]);
              break;
            }
          }
        }
        if (authorizedBy) break;
      }
    }

    // Check Section 7 Human Authorization & Sign-Off table if present
    const sec7 = doc.findSection(/^(?:7\.\s*)?(?:Human\s+Authorization|Sign-Off)/i, 2);
    if (sec7 && mode === "legacy") {
      const sec7Tables = sec7.contentNodes.filter((n): n is TableNode => n.type === "table");
      for (const t of sec7Tables) {
        const kvs = doc.extractTableKeyValues(t);
        const sec7Decision = kvs.get("authorization decision")?.value || kvs.get("decision")?.value;
        const sec7SignOff = kvs.get("sign-off reference")?.value || kvs.get("signature reference")?.value;
        const sec7AuthName = kvs.get("authorizer name")?.value;

        if (sec7AuthName && !authorizedBy) {
          authorizedBy = sec7AuthName;
        }

        if (sec7Decision && /reject/i.test(sec7Decision)) {
          const msg = `Exception document Section 7 records decision "${sec7Decision}". Rejected exceptions cannot authorize waivers.`;
          errors.push(msg);
          diagnostics.push({
            code: "EXCEPTION_NOT_APPROVED",
            message: msg,
            line: t.startLine,
            severity: "error",
            source: filePath,
          });
        }

        if (sec7SignOff && /^\[.*\]$/.test(sec7SignOff)) {
          const msg = `Exception document Section 7 has unpopulated placeholder in Sign-Off Reference: "${sec7SignOff}".`;
          errors.push(msg);
          diagnostics.push({
            code: "EXCEPTION_AGENT_ATTRIBUTION_FORBIDDEN",
            message: msg,
            line: t.startLine,
            severity: "error",
            source: filePath,
          });
        }
      }
    }

    // ID verification
    const docId = foundId ? foundId.toUpperCase() : expectedId;
    if (docId !== expectedId) {
      const msg = `Exception ID in content ("${docId}") does not match file name identifier ("${expectedId}").`;
      errors.push(msg);
      diagnostics.push({
        code: "EXCEPTION_METADATA_INVALID",
        message: msg,
        line: 1,
        severity: "error",
        source: filePath,
      });
    }

    // Status verification
    if (!statusStr) {
      const msg = `Exception document "${baseName}" is missing mandatory "Exception Status" field.`;
      errors.push(msg);
      diagnostics.push({
        code: "EXCEPTION_METADATA_INVALID",
        message: msg,
        line: 1,
        severity: "error",
        source: filePath,
      });
    } else {
      const isApproved = (mode === "proposal" && /^proposed$/i.test(statusStr.trim())) || /^(?:active|approved|active\s*\(authorized\))$/i.test(statusStr.trim());
      if (!isApproved) {
        const msg = `Exception "${docId}" is not approved (status: "${statusStr}"). Only approved/active exceptions can waive deliverables.`;
        errors.push(msg);
        diagnostics.push({
          code: "EXCEPTION_NOT_APPROVED",
          message: msg,
          line: 1,
          severity: "error",
          source: filePath,
        });
      }
    }

    // Waived Requirement verification
    if (!waivedReq) {
      const msg = `Exception document "${baseName}" is missing mandatory "Waived Rule / Requirement" field.`;
      errors.push(msg);
      diagnostics.push({
        code: "EXCEPTION_METADATA_INVALID",
        message: msg,
        line: 1,
        severity: "error",
        source: filePath,
      });
    } else if (deliverableId) {
      const lowerReq = waivedReq.toLowerCase();
      const lowerId = deliverableId.toLowerCase();
      if (!lowerReq.includes(lowerId) && !lowerReq.includes("stage")) {
        const msg = `Exception "${docId}" waived_requirement ("${waivedReq}") does not match deliverable "${deliverableId}".`;
        errors.push(msg);
        diagnostics.push({
          code: "EXCEPTION_SCOPE_MISMATCH",
          message: msg,
          line: 1,
          severity: "error",
          source: filePath,
        });
      }
    }

    // Authorized By (Human) verification
    if (mode === "proposal") {
      // Attribution in a proposal is never treated as human authorization.
      authorizedBy = "";
    } else if (!authorizedBy) {
      const msg = `Exception document "${baseName}" is missing mandatory "Authorized By (Human)" field.`;
      errors.push(msg);
      diagnostics.push({
        code: "EXCEPTION_METADATA_INVALID",
        message: msg,
        line: 1,
        severity: "error",
        source: filePath,
      });
    } else {
      // Documentary Attribution Check: reject empty, placeholders, synthetic agent names
      const isPlaceholderToken = /^\[.*\]$/.test(authorizedBy) || /^(TODO|TBD|INSERT)/i.test(authorizedBy);
      if (isPlaceholderToken || isForbiddenAgentName(authorizedBy)) {
        const msg = `Exception "${docId}" has invalid or synthetic human authorizer: "${authorizedBy}". AI agents cannot self-authorize waivers.`;
        errors.push(msg);
        diagnostics.push({
          code: "EXCEPTION_AGENT_ATTRIBUTION_FORBIDDEN",
          message: msg,
          line: 1,
          severity: "error",
          source: filePath,
        });
      }
    }

    // Expiration Date verification
    if (!expirationDate) {
      const msg = `Exception document "${baseName}" is missing mandatory "Expiration / Review Date" field (must be YYYY-MM-DD).`;
      errors.push(msg);
      diagnostics.push({
        code: "EXCEPTION_METADATA_INVALID",
        message: msg,
        line: 1,
        severity: "error",
        source: filePath,
      });
    } else {
      const dateMatch = expirationDate.match(/^([0-9]{4}-[0-9]{2}-[0-9]{2})$/);
      if (!dateMatch) {
        const msg = `Exception "${docId}" has invalid expiration date format: "${expirationDate}". Must be YYYY-MM-DD.`;
        errors.push(msg);
        diagnostics.push({
          code: "EXCEPTION_METADATA_INVALID",
          message: msg,
          line: 1,
          severity: "error",
          source: filePath,
        });
      } else {
        const boundaryIso = `${dateMatch[1]}T23:59:59.999Z`;
        const expiryBoundary = new Date(boundaryIso).getTime();
        if (isNaN(expiryBoundary) || new Date(`${dateMatch[1]}T00:00:00.000Z`).toISOString().slice(0,10) !== dateMatch[1]) {
          const msg = `Exception "${docId}" has invalid expiration date format: "${expirationDate}". Must be YYYY-MM-DD.`;
          errors.push(msg);
          diagnostics.push({
            code: "EXCEPTION_METADATA_INVALID",
            message: msg,
            line: 1,
            severity: "error",
            source: filePath,
          });
        } else if (evalTime.getTime() > expiryBoundary) {
          const msg = `Exception "${docId}" expired on ${dateMatch[1]}. Expired exceptions cannot authorize waivers.`;
          errors.push(msg);
          diagnostics.push({
            code: "EXCEPTION_EXPIRED",
            message: msg,
            line: 1,
            severity: "error",
            source: filePath,
          });
        }
      }
    }

    // 3. Mandatory Sections Check (Template Sections 1 through 8)
    const requiredSections = [
      { id: "metadata", name: "1. Exception Metadata", pattern: /^(?:1\.\s*)?(?:Exception\s+Metadata|Metadata)/i },
      { id: "authorizer", name: "2. Requester & Authorizer Identification", pattern: /^(?:2\.\s*)?(?:Requester\s+(&|and)\s+Authorizer|Authorizer|Identification)/i },
      { id: "justification", name: "3. Reason & Justification for Exception", pattern: /^(?:3\.\s*)?(?:Reason\s+(&|and)\s+Justification|Justification|Reason)/i },
      { id: "risk", name: "4. Risk Assessment & Blast Radius Analysis", pattern: /^(?:4\.\s*)?(?:Risk\s+Assessment|Risk)/i },
      { id: "controls", name: "5. Compensating Controls", pattern: /^(?:5\.\s*)?Compensating\s+Controls/i },
      { id: "remediation", name: "6. Remediation Plan & Expiration", pattern: /^(?:6\.\s*)?(?:Remediation|Expiration)/i },
      { id: "signoff", name: "7. Human Authorization & Sign-Off", pattern: /^(?:7\.\s*)?(?:Human\s+Authorization|Sign-Off)/i },
      { id: "outcome", name: "8. Final Outcome & Retirement Record", pattern: /^(?:8\.\s*)?(?:Final\s+Outcome|Retirement)/i },
    ];

    const h2Headings = headings.filter((h) => h.level === 2);
    for (const sec of requiredSections) {
      const found = h2Headings.some((h) => sec.pattern.test(h.text));
      if (!found) {
        diagnostics.push({
          code: "EXCEPTION_STRUCTURE_INCOMPLETE",
          message: `Exception document "${baseName}" is missing recommended section: "${sec.name}".`,
          line: 1,
          severity: "warning",
          source: filePath,
        });
      }
    }

    // 4. Content Substantive Check in Justification & Compensating Controls
    const justSec = doc.findSection(/^(?:3\.\s*)?(?:Reason|Justification)/i, 2);
    if (justSec) {
      const hasContent = justSec.contentNodes.some((n) => {
        if (n.type === "paragraph" || n.type === "blockquote") {
          return n.text.trim().length > 15 && !/^\[TODO/i.test(n.text.trim());
        }
        return false;
      });
      if (!hasContent) {
        diagnostics.push({
          code: "EXCEPTION_JUSTIFICATION_MISSING",
          message: `Exception document "${baseName}" Section 3 (Reason & Justification) contains insufficient detail.`,
          line: justSec.heading.startLine,
          severity: "warning",
          source: filePath,
        });
      }
    }

    const ctrlSec = doc.findSection(/^(?:5\.\s*)?Compensating\s+Controls/i, 2);
    if (ctrlSec) {
      const hasContent = ctrlSec.contentNodes.some((n) => {
        if (n.type === "paragraph" || n.type === "list" || n.type === "blockquote") {
          return true;
        }
        return false;
      });
      if (!hasContent) {
        diagnostics.push({
          code: "EXCEPTION_CONTROLS_MISSING",
          message: `Exception document "${baseName}" Section 5 (Compensating Controls) contains insufficient detail.`,
          line: ctrlSec.heading.startLine,
          severity: "warning",
          source: filePath,
        });
      }
    }

    // 5. Placeholder Inspection (excluding fenced code blocks)
    const placeholders = doc.findPlaceholders({ excludeCodeBlocks: true });
    for (const ph of placeholders) {
      // Ignore placeholder in retirement section 8 since it's filled upon closure
      const nodeLine = ph.line;
      diagnostics.push({
        code: "EXCEPTION_UNRESOLVED_PLACEHOLDER",
        message: `Exception document "${baseName}" contains unresolved placeholder token "${ph.token}" at line ${nodeLine}.`,
        line: nodeLine,
        severity: "warning",
        token: ph.token,
        source: filePath,
      });
    }

    if (mode === "proposal") {
      for (const diagnostic of diagnostics.filter(d => d.severity === "warning")) {
        diagnostic.severity = "error";
        errors.push(diagnostic.message);
      }
    }
    const isValid = errors.length === 0;
    const metadata: ValidatedExceptionMetadata | undefined =
      docId && statusStr && waivedReq && (authorizedBy || mode === "proposal") && expirationDate
        ? {
            exception_id: docId,
            title,
            status: statusStr,
            waived_requirement: waivedReq,
            authorized_by: authorizedBy || "",
            expiration_date: expirationDate,
          }
        : undefined;

    return {
      valid: isValid,
      errors,
      diagnostics,
      metadata,
    };
  }
}

/**
 * AST-based Exit Package Validator
 */
export class ExitPackageValidator {
  /**
   * Validates a Stage Gate Exit Package AST against canonical template requirements:
   * 1. Minimum byte size (> 200 bytes)
   * 2. Top-level H1 header matching Stage Gate Exit Package
   * 3. Presence of mandatory sections (Identification, Objectives, Deliverables, Evidence, Traceability)
   * 4. Absence of unresolved template placeholders ([TODO], [TBD], [INSERT]) in core content,
   *    properly ignoring fenced code blocks and code examples.
   */
  static validate(
    content: string,
    options: ValidateExitPackageOptions = {}
  ): ExitPackageAstResult {
    const errors: string[] = [];
    const diagnostics: AstDiagnostic[] = [];

    // Minimum size check (must be at least 200 bytes)
    const byteLength = Buffer.byteLength(content, "utf-8");
    if (byteLength < 200) {
      const msg = `Exit package is too short (${byteLength} bytes; minimum 200 bytes required).`;
      errors.push(msg);
      diagnostics.push({
        code: "EXIT_PACKAGE_INCOMPLETE",
        message: msg,
        line: 1,
        severity: "error",
      });
      return { valid: false, errors, diagnostics, stage: options.stage };
    }

    const doc = MarkdownParser.parse(content);

    // Fail closed on syntax errors (e.g. unclosed code blocks or comments)
    if (doc.syntaxErrors.length > 0) {
      for (const err of doc.syntaxErrors) {
        errors.push(err.message);
        diagnostics.push({
          code: "SYNTAX_ERROR",
          message: err.message,
          line: err.line,
          severity: "error",
        });
      }
      return { valid: false, errors, diagnostics, stage: options.stage };
    }

    const headings = doc.getHeadings();

    // 1. Top-level Title H1
    const h1 = headings.find((h) => h.level === 1);
    if (!h1 || !/(?:Stage\s+Gate.*Exit\s+Package|Exit\s+Package)/i.test(h1.text)) {
      const msg = "Missing top-level header: '# Stage Gate Exit Package' (or equivalent).";
      errors.push(msg);
      diagnostics.push({
        code: "EXIT_PACKAGE_INCOMPLETE",
        message: msg,
        line: h1 ? h1.startLine : 1,
        severity: "error",
      });
    }

    const h2Headings = headings.filter((h) => h.level === 2);

    // 2. Section: Identification or Summary
    const hasIdentification = h2Headings.some((h) =>
      /(?:Package\s+&\s+Stage\s+Identification|Stage\s+Objectives|Executive\s+Summary)/i.test(h.text)
    );
    if (!hasIdentification) {
      const msg = "Missing required section: '## 1. Package & Stage Identification' (or 'Executive Summary').";
      errors.push(msg);
      diagnostics.push({
        code: "EXIT_PACKAGE_INCOMPLETE",
        message: msg,
        line: 1,
        severity: "error",
      });
    }

    // 3. Section: Deliverables Manifest
    const hasDeliverables = h2Headings.some((h) =>
      /(?:Deliverables\s+Manifest|Stage\s+Deliverables|Deliverables(?:\s+and\s+Traceability|\s+Manifest\s+&\s+Status)?)/i.test(
        h.text
      )
    );
    if (!hasDeliverables) {
      const msg = "Missing required section: '## 2. Deliverables Manifest & Status' (or 'Deliverables').";
      errors.push(msg);
      diagnostics.push({
        code: "EXIT_PACKAGE_INCOMPLETE",
        message: msg,
        line: 1,
        severity: "error",
      });
    }

    // 4. Section: Validation Evidence
    const hasEvidence = h2Headings.some((h) =>
      /(?:Verifiable\s+Validation\s+Evidence|Validation\s+Evidence|Evidence)/i.test(h.text)
    );
    if (!hasEvidence) {
      const msg = "Missing required section: '## 3. Verifiable Validation Evidence' (or 'Evidence').";
      errors.push(msg);
      diagnostics.push({
        code: "EXIT_PACKAGE_INCOMPLETE",
        message: msg,
        line: 1,
        severity: "error",
      });
    }

    // 5. Section: Traceability Matrix or Sign-off
    const hasTraceability = h2Headings.some((h) =>
      /(?:Traceability(?:\s+Matrix)?|Human\s+Gate\s+Sign-Off|Sign-Off|Residual\s+Risk|Architectural\s+&\s+Requirement\s+Decisions)/i.test(
        h.text
      )
    );
    if (!hasTraceability) {
      const msg = "Missing required section: '## 4. Traceability & Sign-Off Record' (or 'Sign-Off').";
      errors.push(msg);
      diagnostics.push({
        code: "EXIT_PACKAGE_INCOMPLETE",
        message: msg,
        line: 1,
        severity: "error",
      });
    }

    // If strict mode requested, verify all 8 canonical template sections
    if (options.strict) {
      const strictSections = [
        { id: "identification", name: "1. Package & Stage Identification", pattern: /(?:Package\s+&\s+Stage\s+Identification|Executive\s+Summary)/i },
        { id: "objectives", name: "2. Stage Objectives & Scope Summary", pattern: /(?:Stage\s+Objectives|Scope\s+Summary|Objectives\s+&\s+Scope)/i },
        { id: "deliverables", name: "3. Deliverables Manifest & Status", pattern: /(?:Deliverables\s+Manifest|Deliverables)/i },
        { id: "evidence", name: "4. Verifiable Validation Evidence", pattern: /(?:Verifiable\s+Validation\s+Evidence|Evidence)/i },
        { id: "traceability", name: "5. Traceability Matrix", pattern: /(?:Traceability\s+Matrix|Traceability|Decisions|Security\s+&\s+Governance)/i },
        { id: "issues", name: "6. Outstanding Issues & Accepted Limitations", pattern: /(?:Outstanding\s+Issues|Residual\s+Risk)/i },
        { id: "artifacts", name: "7. Related Governance Artifacts", pattern: /(?:Related\s+Governance\s+Artifacts|Governance\s+Artifacts|Decisions|Sign-Off\s+&\s+Attestation)/i },
        { id: "assertion", name: "8. AI Agent Completion Assertion", pattern: /(?:AI\s+Agent\s+Completion\s+Assertion|Agent\s+Completion\s+Assertion|Completion\s+Assertion|Sign-Off\s+&\s+Attestation)/i },
      ];

      for (const sec of strictSections) {
        const found = h2Headings.some((h) => sec.pattern.test(h.text));
        if (!found) {
          const msg = `Exit package is missing canonical section: "${sec.name}".`;
          errors.push(msg);
          diagnostics.push({
            code: "EXIT_PACKAGE_INCOMPLETE",
            message: msg,
            line: 1,
            severity: "error",
          });
        }
      }
    }

    // 6. Check for unresolved template placeholders across AST text nodes (IGNORING code blocks!)
    const placeholders = doc.findPlaceholders({ excludeCodeBlocks: true });
    if (placeholders.length > 0) {
      const firstPh = placeholders[0];
      const msg = `Exit package contains unresolved template placeholders (e.g. '${firstPh.token}') at line ${firstPh.line}.`;
      errors.push(msg);
      for (const ph of placeholders) {
        diagnostics.push({
          code: "EXIT_PACKAGE_INCOMPLETE",
          message: `Exit package contains unresolved placeholder token "${ph.token}" at line ${ph.line}.`,
          line: ph.line,
          severity: "error",
          token: ph.token,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      diagnostics,
      stage: options.stage,
    };
  }
}

/**
 * Functional wrapper for Exception document AST validation.
 */
export function validateExceptionDocumentAst(
  content: string,
  filePath: string,
  deliverableId?: string,
  now?: Date,
  mode: "legacy" | "proposal" = "legacy"
): ExceptionValidationResult {
  return ExceptionValidator.validate(content, filePath, deliverableId, now, mode);
}

/**
 * Functional wrapper for Exit Package AST validation.
 */
export function validateExitPackageAst(
  content: string,
  options?: ValidateExitPackageOptions | number
): ExitPackageAstResult {
  const opts: ValidateExitPackageOptions =
    typeof options === "number" ? { stage: options } : options || {};
  return ExitPackageValidator.validate(content, opts);
}
