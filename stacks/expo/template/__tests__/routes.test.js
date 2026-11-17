import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("Expo Template Headless Route & Architecture Tests", () => {
  const rootDir = process.cwd();

  test("app manifest exists and declares mandatory properties", () => {
    const appJsonPath = path.join(rootDir, "app.json");
    assert.ok(fs.existsSync(appJsonPath), "app.json must exist");

    const content = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
    assert.ok(content.expo);
    assert.ok(content.expo.name);
    assert.ok(content.expo.slug);
    assert.ok(content.expo.scheme);
    assert.ok(content.expo.ios?.bundleIdentifier);
    assert.ok(content.expo.android?.package);
  });

  test("route tree contains mandatory root layout, entry route, and 404 handler", () => {
    assert.ok(
      fs.existsSync(path.join(rootDir, "app", "_layout.tsx")) ||
      fs.existsSync(path.join(rootDir, "app", "_layout.js")),
      "Root layout must exist"
    );
    assert.ok(
      fs.existsSync(path.join(rootDir, "app", "index.tsx")) ||
      fs.existsSync(path.join(rootDir, "app", "index.js")),
      "Home route must exist"
    );
    assert.ok(
      fs.existsSync(path.join(rootDir, "app", "+not-found.tsx")) ||
      fs.existsSync(path.join(rootDir, "app", "+not-found.js")),
      "404 route must exist"
    );
  });

  test("route files define default component exports", () => {
    const routeFiles = [
      path.join(rootDir, "app", "_layout.tsx"),
      path.join(rootDir, "app", "index.tsx"),
      path.join(rootDir, "app", "+not-found.tsx"),
      path.join(rootDir, "app", "(tabs)", "_layout.tsx"),
      path.join(rootDir, "app", "(tabs)", "explore.tsx"),
    ];

    const defaultExportPattern = /(?:export\s+default\s+(?:function|class|const|let|var|\(?\w+\)?\s*=>)|export\s+default\s+[\w$]+;?)/;

    for (const f of routeFiles) {
      if (fs.existsSync(f)) {
        const content = fs.readFileSync(f, "utf-8");
        assert.match(
          content,
          defaultExportPattern,
          `Route file ${path.relative(rootDir, f)} must define an export default`
        );
      }
    }
  });

  test("declarative config plugin with-security-headers is valid", () => {
    const pluginPath = path.join(rootDir, "plugins", "with-security-headers.js");
    assert.ok(fs.existsSync(pluginPath), "Plugin file must exist");

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pluginFn = require(pluginPath);
    assert.equal(typeof pluginFn, "function", "Plugin must export a function");

    const mockConfig = { ios: {}, android: {} };
    const modified = pluginFn(mockConfig);
    assert.equal(modified.ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads, false);
  });
});
