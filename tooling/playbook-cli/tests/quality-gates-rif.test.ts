import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  classifyFile,
  canonicalizeAndHashFileBuffer,
  computeRif,
  RifError,
} from "../src/core/quality-gates/rif.js";
import {
  loadQualityGatesConfig,
  validateCheckPatterns,
  QualityGateConfigError,
} from "../src/core/quality-gates/config.js";
import { resolveCheckDag } from "../src/core/quality-gates/dag.js";
import type { QualityGateCheck, QualityGatesConfig } from "../src/types/quality-gates.js";

describe("Quality Gates RIF & Canonicalization Engine", () => {
  describe("Cryptographic Test Vectors (Task 005A.6 Verified)", () => {
    test("VEC-01: Pure ASCII CRLF Text converts to LF and hashes correctly", () => {
      // 68 65 6c 6c 6f 0d 0a 77 6f 72 6c 64 0d 0a (14 bytes)
      const input = Buffer.from("68656c6c6f0d0a776f726c640d0a", "hex");
      const { hash, canonicalBytes } = canonicalizeAndHashFileBuffer(input, "text");

      assert.equal(canonicalBytes.toString("hex"), "68656c6c6f0a776f726c640a");
      assert.equal(hash, "sha256:4a1e67f2fe1d1cc7b31d0ca2ec441da4778203a036a77da10344c85e24ff0f92");
    });

    test("VEC-02: Pure ASCII LF Text preserves LF and produces identical hash to VEC-01", () => {
      // 68 65 6c 6c 6f 0a 77 6f 72 6c 64 0a (12 bytes)
      const input = Buffer.from("68656c6c6f0a776f726c640a", "hex");
      const { hash, canonicalBytes } = canonicalizeAndHashFileBuffer(input, "text");

      assert.equal(canonicalBytes.toString("hex"), "68656c6c6f0a776f726c640a");
      assert.equal(hash, "sha256:4a1e67f2fe1d1cc7b31d0ca2ec441da4778203a036a77da10344c85e24ff0f92");
    });

    test("VEC-03: UTF-8 BOM & Mixed Newlines strips BOM and normalizes CRLF/CR to LF", () => {
      // ef bb bf 6c 69 6e 65 31 0d 6c 69 6e 65 32 0d 0a 6c 69 6e 65 33 0a (21 bytes)
      const input = Buffer.from("efbbbf6c696e65310d6c696e65320d0a6c696e65330a", "hex");
      const { hash, canonicalBytes } = canonicalizeAndHashFileBuffer(input, "text");

      // Normalized: line1\nline2\nline3\n (18 bytes)
      assert.equal(canonicalBytes.toString("hex"), "6c696e65310a6c696e65320a6c696e65330a");
      assert.equal(hash, "sha256:66663af9c7aa341431a8ee2ff27b72abd06c9218f517bb6fef948e4803c19e03");
    });

    test("VEC-04: Binary File containing CRLF without null bytes is NOT normalized", () => {
      // 01 02 0d 0a 03 04 (6 bytes)
      const input = Buffer.from("01020d0a0304", "hex");
      const { hash, canonicalBytes } = canonicalizeAndHashFileBuffer(input, "binary");

      assert.equal(canonicalBytes.toString("hex"), "01020d0a0304");
      assert.equal(hash, "sha256:05222511c09b8166ff3d26f0cbef77da9ad216015c3e67695f7698da60698327");
    });

    test("VEC-05: Invalid UTF-8 sequence in text file halts closed with INVALID_UTF8_ENCODING", () => {
      // 68 65 6c 6c 6f 20 ff fe 77 6f 72 6c 64 (13 bytes)
      const input = Buffer.from("68656c6c6f20fffe776f726c64", "hex");

      assert.throws(
        () => canonicalizeAndHashFileBuffer(input, "text", "bad-utf8.txt"),
        (err: unknown) => {
          assert.ok(err instanceof RifError);
          assert.equal((err as RifError).code, "INVALID_UTF8_ENCODING");
          return true;
        }
      );
    });
  });

  describe("Classification Hierarchy & Precedence", () => {
    const dummyCheck: QualityGateCheck = {
      id: "test-check",
      name: "Test Check",
      type: "automated_test",
      deliverable_id: "DELIV-1",
      command: "npm",
      args: ["test"],
      text_patterns: ["custom-data/*.dat", "docs/*.custom"],
      binary_patterns: ["src/assets/*.ts", "blobs/*"],
    };

    test("Tier 1: Explicit text_patterns override built-in binary extension", () => {
      assert.equal(classifyFile("custom-data/record.dat", dummyCheck), "text");
    });

    test("Tier 1: Explicit binary_patterns override built-in text extension (.ts)", () => {
      assert.equal(classifyFile("src/assets/generated.ts", dummyCheck), "binary");
    });

    test("Tier 2: Well-known extensions classify as text", () => {
      assert.equal(classifyFile("src/index.ts", dummyCheck), "text");
      assert.equal(classifyFile("README.md", dummyCheck), "text");
      assert.equal(classifyFile("package.json", dummyCheck), "text");
      assert.equal(classifyFile("script.py", dummyCheck), "text");
    });

    test("Tier 3: Safe Default: unknown extensions classify strictly as binary (raw bytes)", () => {
      assert.equal(classifyFile("archive.bin", dummyCheck), "binary");
      assert.equal(classifyFile("firmware.rom", dummyCheck), "binary");
      assert.equal(classifyFile("unknown.xyz", dummyCheck), "binary");
    });
  });

  describe("Pattern Conflict Detection", () => {
    test("rejects check with identical pattern in text and binary patterns", () => {
      const badCheck: QualityGateCheck = {
        id: "conflict-check",
        name: "Conflict Check",
        type: "automated_test",
        deliverable_id: "DELIV-1",
        command: "npm",
        args: ["test"],
        text_patterns: ["src/**/*.dat", "docs/*"],
        binary_patterns: ["src/**/*.dat"],
      };

      assert.throws(
        () => validateCheckPatterns(badCheck),
        (err: unknown) => {
          assert.ok(err instanceof QualityGateConfigError);
          assert.equal((err as QualityGateConfigError).code, "CONFIG_PATTERN_CONFLICT");
          return true;
        }
      );
    });
  });

  describe("DAG Scheduling & Cycle Detection", () => {
    test("orders independent and dependent checks topologically", () => {
      const checks: QualityGateCheck[] = [
        {
          id: "unit-tests",
          name: "Unit Tests",
          type: "automated_test",
          deliverable_id: "D1",
          command: "npm",
          args: ["test"],
          depends_on: ["lint", "typecheck"],
        },
        {
          id: "lint",
          name: "Linter",
          type: "static_analysis",
          deliverable_id: "D1",
          command: "npm",
          args: ["run", "lint"],
        },
        {
          id: "typecheck",
          name: "Typecheck",
          type: "build_typecheck",
          deliverable_id: "D1",
          command: "npm",
          args: ["run", "typecheck"],
          depends_on: ["lint"],
        },
      ];

      const res = resolveCheckDag(checks);
      const order = res.orderedChecks.map((c) => c.id);
      assert.deepEqual(order, ["lint", "typecheck", "unit-tests"]);
      assert.equal(res.levels.length, 3);
    });

    test("detects circular dependency and throws CONFIG_CYCLIC_DEPENDENCY", () => {
      const cyclicChecks: QualityGateCheck[] = [
        {
          id: "check-a",
          name: "Check A",
          type: "automated_test",
          deliverable_id: "D1",
          command: "npm",
          args: ["test"],
          depends_on: ["check-b"],
        },
        {
          id: "check-b",
          name: "Check B",
          type: "automated_test",
          deliverable_id: "D1",
          command: "npm",
          args: ["test"],
          depends_on: ["check-a"],
        },
      ];

      assert.throws(
        () => resolveCheckDag(cyclicChecks),
        (err: unknown) => {
          assert.ok(err instanceof QualityGateConfigError);
          assert.equal((err as QualityGateConfigError).code, "CONFIG_CYCLIC_DEPENDENCY");
          return true;
        }
      );
    });
  });

  describe("Environment Fingerprinting with Safe Secret Handling", () => {
    let tempDir: string;

    test("changed non-secret environment value alters RIF deterministically", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-env-test-"));
      fs.writeFileSync(path.join(tempDir, "index.ts"), "export const x = 1;", "utf-8");

      const checkProd: QualityGateCheck = {
        id: "env-check",
        name: "Env Check",
        type: "automated_test",
        deliverable_id: "DELIV-1",
        command: "npm",
        args: ["test"],
        env: { NODE_ENV: "production" },
      };

      const checkDev: QualityGateCheck = {
        id: "env-check",
        name: "Env Check",
        type: "automated_test",
        deliverable_id: "DELIV-1",
        command: "npm",
        args: ["test"],
        env: { NODE_ENV: "development" },
      };

      const rifProd = computeRif({ projectDir: tempDir, check: checkProd });
      const rifDev = computeRif({ projectDir: tempDir, check: checkDev });

      assert.notEqual(rifProd.rif, rifDev.rif);
      assert.notEqual(rifProd.env_keys_hash, rifDev.env_keys_hash);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("identical non-secret environment values produce identical RIF", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-env-test-"));
      fs.writeFileSync(path.join(tempDir, "index.ts"), "export const x = 1;", "utf-8");

      const check1: QualityGateCheck = {
        id: "env-check",
        name: "Env Check",
        type: "automated_test",
        deliverable_id: "DELIV-1",
        command: "npm",
        args: ["test"],
        env: { NODE_ENV: "production", CI: "true" },
      };

      const check2: QualityGateCheck = {
        id: "env-check",
        name: "Env Check",
        type: "automated_test",
        deliverable_id: "DELIV-1",
        command: "npm",
        args: ["test"],
        env: { CI: "true", NODE_ENV: "production" }, // reversed order in object
      };

      const rif1 = computeRif({ projectDir: tempDir, check: check1 });
      const rif2 = computeRif({ projectDir: tempDir, check: check2 });

      assert.equal(rif1.rif, rif2.rif);
      assert.equal(rif1.env_keys_hash, rif2.env_keys_hash);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("secret environment variables do not hash raw secret and detect version changes", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-env-test-"));
      fs.writeFileSync(path.join(tempDir, "index.ts"), "export const x = 1;", "utf-8");

      const secretVal1 = "super_secret_password_abc_123";
      const secretVal2 = "completely_different_raw_secret_xyz_789";

      const checkVer1: QualityGateCheck = {
        id: "secret-check",
        name: "Secret Check",
        type: "automated_test",
        deliverable_id: "DELIV-1",
        command: "npm",
        args: ["test"],
        env: {
          API_KEY: secretVal1,
          API_KEY_VERSION: "v1.0",
        },
      };

      const checkVer1SameVerDiffSecret: QualityGateCheck = {
        id: "secret-check",
        name: "Secret Check",
        type: "automated_test",
        deliverable_id: "DELIV-1",
        command: "npm",
        args: ["test"],
        env: {
          API_KEY: secretVal2, // Different secret value, but SAME version
          API_KEY_VERSION: "v1.0",
        },
      };

      const checkVer2: QualityGateCheck = {
        id: "secret-check",
        name: "Secret Check",
        type: "automated_test",
        deliverable_id: "DELIV-1",
        command: "npm",
        args: ["test"],
        env: {
          API_KEY: secretVal2,
          API_KEY_VERSION: "v2.0", // BUMPED version
        },
      };

      const rifVer1 = computeRif({ projectDir: tempDir, check: checkVer1 });
      const rifVer1Same = computeRif({ projectDir: tempDir, check: checkVer1SameVerDiffSecret });
      const rifVer2 = computeRif({ projectDir: tempDir, check: checkVer2 });

      // Raw secret value is not hashed: same version produces same RIF!
      assert.equal(rifVer1.rif, rifVer1Same.rif);
      assert.equal(rifVer1.env_keys_hash, rifVer1Same.env_keys_hash);

      // Version bump alters RIF deterministically!
      assert.notEqual(rifVer1.rif, rifVer2.rif);
      assert.notEqual(rifVer1.env_keys_hash, rifVer2.env_keys_hash);

      // Verified no unbounded secrets
      assert.equal(rifVer1.secret_freshness_unbounded, false);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("unversioned secret flags secret_freshness_unbounded", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-env-test-"));
      fs.writeFileSync(path.join(tempDir, "index.ts"), "export const x = 1;", "utf-8");

      const checkUnversioned: QualityGateCheck = {
        id: "secret-check",
        name: "Secret Check",
        type: "automated_test",
        deliverable_id: "DELIV-1",
        command: "npm",
        args: ["test"],
        env: {
          DATABASE_PASSWORD: "secret_db_pass_123", // secret with no _VERSION
        },
      };

      const rif = computeRif({ projectDir: tempDir, check: checkUnversioned });
      assert.equal(rif.secret_freshness_unbounded, true);
      assert.deepEqual(rif.unbounded_secret_keys, ["DATABASE_PASSWORD"]);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("file deletion alters RIF deterministically", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-del-test-"));
      const file1 = path.join(tempDir, "a.ts");
      const file2 = path.join(tempDir, "b.ts");
      fs.writeFileSync(file1, "export const a = 1;", "utf-8");
      fs.writeFileSync(file2, "export const b = 2;", "utf-8");

      const check: QualityGateCheck = {
        id: "file-check",
        name: "File Check",
        type: "automated_test",
        deliverable_id: "DELIV-1",
        command: "npm",
        args: ["test"],
      };

      const rifBefore = computeRif({ projectDir: tempDir, check });

      // Delete file2
      fs.unlinkSync(file2);

      const rifAfter = computeRif({ projectDir: tempDir, check });

      assert.notEqual(rifBefore.rif, rifAfter.rif);
      assert.notEqual(rifBefore.inputs_hash, rifAfter.inputs_hash);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("file content modification alters RIF deterministically", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-mod-test-"));
      const file = path.join(tempDir, "index.ts");
      fs.writeFileSync(file, "export const v = 1;", "utf-8");

      const check: QualityGateCheck = {
        id: "mod-check",
        name: "Mod Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
      };

      const rif1 = computeRif({ projectDir: tempDir, check });
      fs.writeFileSync(file, "export const v = 2;", "utf-8");
      const rif2 = computeRif({ projectDir: tempDir, check });

      assert.notEqual(rif1.rif, rif2.rif);
      assert.notEqual(rif1.inputs_hash, rif2.inputs_hash);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("new untracked file alters RIF deterministically", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-new-test-"));
      fs.writeFileSync(path.join(tempDir, "first.ts"), "export const a = 1;", "utf-8");

      const check: QualityGateCheck = {
        id: "new-check",
        name: "New Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
      };

      const rif1 = computeRif({ projectDir: tempDir, check });
      fs.writeFileSync(path.join(tempDir, "second.ts"), "export const b = 2;", "utf-8");
      const rif2 = computeRif({ projectDir: tempDir, check });

      assert.notEqual(rif1.rif, rif2.rif);
      assert.notEqual(rif1.inputs_hash, rif2.inputs_hash);
      assert.equal(rif1.file_manifest.length, 1);
      assert.equal(rif2.file_manifest.length, 2);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("renamed file alters RIF deterministically even with identical content", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-rename-test-"));
      const oldPath = path.join(tempDir, "original.ts");
      const newPath = path.join(tempDir, "renamed.ts");
      fs.writeFileSync(oldPath, "export const code = 42;", "utf-8");

      const check: QualityGateCheck = {
        id: "rename-check",
        name: "Rename Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
      };

      const rif1 = computeRif({ projectDir: tempDir, check });
      fs.renameSync(oldPath, newPath);
      const rif2 = computeRif({ projectDir: tempDir, check });

      assert.notEqual(rif1.rif, rif2.rif);
      assert.notEqual(rif1.inputs_hash, rif2.inputs_hash);
      assert.equal(rif1.file_manifest[0].path, "original.ts");
      assert.equal(rif2.file_manifest[0].path, "renamed.ts");
      // File hash is identical, but manifest path entry differs
      assert.equal(rif1.file_manifest[0].hash, rif2.file_manifest[0].hash);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("internal symlink hashes target path string and detects target changes", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-symlink-test-"));
      const targetA = path.join(tempDir, "target-a.txt");
      const targetB = path.join(tempDir, "target-b.txt");
      const linkPath = path.join(tempDir, "link.txt");

      fs.writeFileSync(targetA, "content A", "utf-8");
      fs.writeFileSync(targetB, "content B", "utf-8");
      fs.symlinkSync("target-a.txt", linkPath, "file");

      const check: QualityGateCheck = {
        id: "symlink-check",
        name: "Symlink Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
      };

      const rif1 = computeRif({ projectDir: tempDir, check });
      const linkEntry1 = rif1.file_manifest.find((f) => f.path === "link.txt");
      assert.ok(linkEntry1);

      // Point symlink to target B
      fs.unlinkSync(linkPath);
      fs.symlinkSync("target-b.txt", linkPath, "file");

      const rif2 = computeRif({ projectDir: tempDir, check });
      const linkEntry2 = rif2.file_manifest.find((f) => f.path === "link.txt");
      assert.ok(linkEntry2);

      assert.notEqual(linkEntry1.hash, linkEntry2.hash);
      assert.notEqual(rif1.rif, rif2.rif);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("symlink escaping project boundary throws INVALID_SYMLINK_TRAVERSAL", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-escape-symlink-"));
      const outsideFile = path.join(os.tmpdir(), "outside-project.txt");
      fs.writeFileSync(outsideFile, "outside", "utf-8");

      const linkPath = path.join(tempDir, "escape-link.txt");
      fs.symlinkSync(outsideFile, linkPath, "file");

      const check: QualityGateCheck = {
        id: "escape-check",
        name: "Escape Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
      };

      assert.throws(
        () => computeRif({ projectDir: tempDir, check }),
        (err: unknown) => {
          assert.ok(err instanceof RifError);
          assert.equal((err as RifError).code, "INVALID_SYMLINK_TRAVERSAL");
          return true;
        }
      );

      fs.unlinkSync(outsideFile);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("dangling symlink throws INVALID_SYMLINK_TARGET", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-dangle-symlink-"));
      const linkPath = path.join(tempDir, "dangle.txt");
      fs.symlinkSync("non-existent-target.txt", linkPath, "file");

      const check: QualityGateCheck = {
        id: "dangle-check",
        name: "Dangle Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
      };

      assert.throws(
        () => computeRif({ projectDir: tempDir, check }),
        (err: unknown) => {
          assert.ok(err instanceof RifError);
          assert.equal((err as RifError).code, "INVALID_SYMLINK_TARGET");
          return true;
        }
      );

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("excluded generated directories and files do not alter RIF", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-exclude-test-"));
      fs.writeFileSync(path.join(tempDir, "source.ts"), "export const s = 1;", "utf-8");

      const check: QualityGateCheck = {
        id: "exclude-check",
        name: "Exclude Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
      };

      const rifBaseline = computeRif({ projectDir: tempDir, check });

      // Add files in standard excluded directories: dist, build, coverage, .git, .playbook/logs
      fs.mkdirSync(path.join(tempDir, "dist"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "dist/bundle.js"), "bundled code", "utf-8");

      fs.mkdirSync(path.join(tempDir, "build"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "build/out.js"), "build code", "utf-8");

      fs.mkdirSync(path.join(tempDir, "coverage"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, "coverage/lcov.info"), "coverage data", "utf-8");

      fs.mkdirSync(path.join(tempDir, ".playbook/logs"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".playbook/logs/run.log"), "log data", "utf-8");

      const rifAfterGenerated = computeRif({ projectDir: tempDir, check });

      // Excluded files must NOT alter RIF or input manifest
      assert.equal(rifBaseline.rif, rifAfterGenerated.rif);
      assert.equal(rifBaseline.inputs_hash, rifAfterGenerated.inputs_hash);
      assert.equal(rifAfterGenerated.file_manifest.length, 1);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("lockfile modification and absence alter RIF deterministically with sort invariance", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-lockfile-test-"));
      fs.writeFileSync(path.join(tempDir, "index.ts"), "export const x = 1;", "utf-8");
      const lockfile = path.join(tempDir, "package-lock.json");
      fs.writeFileSync(lockfile, JSON.stringify({ name: "app", version: "1.0.0" }), "utf-8");

      const checkAscending: QualityGateCheck = {
        id: "lock-check",
        name: "Lock Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
        lockfiles: ["package-lock.json", "yarn.lock"], // yarn.lock absent
      };

      const checkDescending: QualityGateCheck = {
        id: "lock-check",
        name: "Lock Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
        lockfiles: ["yarn.lock", "package-lock.json"], // reversed order
      };

      const rifAsc = computeRif({ projectDir: tempDir, check: checkAscending });
      const rifDesc = computeRif({ projectDir: tempDir, check: checkDescending });

      // Lockfile list ordering must produce identical RIF
      assert.equal(rifAsc.lockfiles_hash, rifDesc.lockfiles_hash);
      assert.equal(rifAsc.rif, rifDesc.rif);

      // Modifying lockfile alters RIF
      fs.writeFileSync(lockfile, JSON.stringify({ name: "app", version: "2.0.0" }), "utf-8");
      const rifModified = computeRif({ projectDir: tempDir, check: checkAscending });
      assert.notEqual(rifAsc.lockfiles_hash, rifModified.lockfiles_hash);
      assert.notEqual(rifAsc.rif, rifModified.rif);

      // Deleting lockfile alters RIF
      fs.unlinkSync(lockfile);
      const rifDeleted = computeRif({ projectDir: tempDir, check: checkAscending });
      assert.notEqual(rifModified.lockfiles_hash, rifDeleted.lockfiles_hash);
      assert.notEqual(rifModified.rif, rifDeleted.rif);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("file ordering determinism: files created in reverse order produce identical RIF", () => {
      const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "qg-order-1-"));
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "qg-order-2-"));

      // Dir 1: create file Z then file A
      fs.writeFileSync(path.join(dir1, "z-file.ts"), "const z = 26;", "utf-8");
      fs.writeFileSync(path.join(dir1, "a-file.ts"), "const a = 1;", "utf-8");

      // Dir 2: create file A then file Z
      fs.writeFileSync(path.join(dir2, "a-file.ts"), "const a = 1;", "utf-8");
      fs.writeFileSync(path.join(dir2, "z-file.ts"), "const z = 26;", "utf-8");

      const check: QualityGateCheck = {
        id: "order-check",
        name: "Order Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
      };

      const rif1 = computeRif({ projectDir: dir1, check });
      const rif2 = computeRif({ projectDir: dir2, check });

      assert.equal(rif1.rif, rif2.rif);
      assert.equal(rif1.inputs_hash, rif2.inputs_hash);
      assert.deepEqual(
        rif1.file_manifest.map((f) => f.path),
        ["a-file.ts", "z-file.ts"]
      );
      assert.deepEqual(
        rif2.file_manifest.map((f) => f.path),
        ["a-file.ts", "z-file.ts"]
      );

      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    test("custom sensitive patterns classify unusual secret variables and protect raw values", () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-custom-sensitive-"));
      fs.writeFileSync(path.join(tempDir, "index.ts"), "export const s = 1;", "utf-8");

      const rawSecretValue = "ultra_sensitive_magic_payload_998877";

      const check: QualityGateCheck = {
        id: "custom-pattern-check",
        name: "Custom Pattern Check",
        type: "automated_test",
        deliverable_id: "D1",
        command: "npm",
        args: ["test"],
        env: {
          INTERNAL_MAGIC_SIG: rawSecretValue, // Unusual secret variable name
          INTERNAL_MAGIC_SIG_VERSION: "v3.1",
        },
      };

      // Without sensitivePatterns, INTERNAL_MAGIC_SIG is hashed as non-secret
      const rifWithoutCustom = computeRif({ projectDir: tempDir, check });

      // With custom sensitivePatterns containing "MAGIC_SIG"
      const rifWithCustom = computeRif({
        projectDir: tempDir,
        check,
        sensitivePatterns: ["MAGIC_SIG"],
      });

      // The custom sensitive pattern classified the variable as a secret
      assert.notEqual(rifWithoutCustom.env_keys_hash, rifWithCustom.env_keys_hash);
      assert.notEqual(rifWithoutCustom.rif, rifWithCustom.rif);

      // Verify that raw secret value is NEVER present in the RIF result or manifest
      const serializedRif = JSON.stringify(rifWithCustom);
      assert.ok(!serializedRif.includes(rawSecretValue));

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
