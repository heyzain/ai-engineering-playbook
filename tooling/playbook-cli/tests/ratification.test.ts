import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalInventory, assertRatifier, assertRatificationTerminal, ratificationRecord, assertNoLegacyWaivers } from "../src/core/ratification.js";

test("empty inventory has the canonical JSON SHA-256", () => {
  assert.deepEqual(canonicalInventory([]), {
    json: "[]", sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  });
});

test("inventory rejects ambiguous or unsafe identifiers and ordering", () => {
  for (const bad of [null, {}, [3], ["EXC-20261117-002", "EXC-20261117-001"],
    ["EXC-20261117-001", "EXC-20261117-001"], ["../escape"], ["EXC-20261117-001\n"]]) {
    assert.throws(() => canonicalInventory(bad), /INVENTORY_INVALID/);
  }
  assert.equal(canonicalInventory(["EXC-20261117-001"]).json, '["EXC-20261117-001"]');
});

test("operator must supply exact amendment phrase, role and a substantive non-agent name", () => {
  const phrase = "CONFIRM RATIFICATION AMEND-20261110-001";
  assert.doesNotThrow(() => assertRatifier("Example Engineer", "Lead Architect", phrase));
  for (const name of ["", "AI Agent", "Codex", "ChatGPT", "Example\nEngineer"]) {
    assert.throws(() => assertRatifier(name, "Lead Architect", phrase));
  }
  assert.throws(() => assertRatifier("Example Engineer", "Developer", phrase), /ROLE_REQUIRED/);
  assert.throws(() => assertRatifier("Example Engineer", "Lead Architect", "yes"), /CONFIRMATION_MISMATCH/);
});

test("terminal guard uses real process streams without a caller-supplied TTY override", () => {
  if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
    assert.doesNotThrow(() => assertRatificationTerminal());
  } else {
    assert.throws(() => assertRatificationTerminal(), /TTY_REQUIRED/);
  }
});

test("bootstrap refuses to grandfather existing authority without the future migration verifier", () => {
  assert.doesNotThrow(() => assertNoLegacyWaivers({ current_stage_detail: { exceptions: [], deliverables: [] } }));
  assert.throws(() => assertNoLegacyWaivers({ current_stage_detail: { exceptions: [{status: "active"}], deliverables: [] } }), /LEGACY_WAIVERS_PRESENT/);
  assert.throws(() => assertNoLegacyWaivers({ current_stage_detail: { exceptions: [], deliverables: [{status: "waived"}] } }), /LEGACY_WAIVERS_PRESENT/);
  assert.throws(() => assertNoLegacyWaivers({}), /STATE_INVALID/);
});

test("record binds inventory, commit, tree and specifications without claiming identity or Level B", () => {
  const content = ratificationRecord({ commit: "a".repeat(40), tree: "b".repeat(40),
    inventorySha256: canonicalInventory([]).sha256, blobs: { "docs/adr/example.md": "c".repeat(40) },
    ratifier: "Example Engineer", role: "Lead Architect", ratifiedAt: "2026-11-17T00:00:00.000Z" });
  assert.match(content, /AMEND-20261110-001/);
  assert.match(content, /"ratified_commit_sha": "a{40}"/);
  assert.match(content, /"ratified_tree_sha": "b{40}"/);
  assert.match(content, /"assurance": "Level A"/);
  assert.match(content, /not authenticated identity/);
  assert.match(content, /Level B.*not established/);
});
