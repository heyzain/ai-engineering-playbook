import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toPosixPath, normalizeRelativePath } from "../src/utils/paths.js";

describe("Path Utilities", () => {
  test("converts Windows backslashes to POSIX slashes", () => {
    const winPath = "docs\\prd\\PRD-CORE.md";
    assert.equal(toPosixPath(winPath), "docs/prd/PRD-CORE.md");
  });

  test("leaves POSIX slashes untouched", () => {
    const posixPath = "docs/gates/GATE-0-EXIT-PACKAGE.md";
    assert.equal(toPosixPath(posixPath), "docs/gates/GATE-0-EXIT-PACKAGE.md");
  });

  test("strips redundant leading ./", () => {
    assert.equal(normalizeRelativePath("./docs/adr/ADR-001.md"), "docs/adr/ADR-001.md");
    assert.equal(normalizeRelativePath(".\\docs\\adr\\ADR-001.md"), "docs/adr/ADR-001.md");
    assert.equal(normalizeRelativePath(".playbook/manifest.json"), ".playbook/manifest.json");
  });
});
