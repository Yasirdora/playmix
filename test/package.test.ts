/**
 * Guardrails on the package boundary.
 *
 * These assert the two properties that are easy to state, easy to believe, and
 * easy to lose in a single careless import: the engine has no runtime
 * dependencies, and its core is framework-free. Both are the kind of claim a
 * README makes and a codebase quietly stops honouring, so they are checked
 * rather than asserted in prose.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  exports?: Record<string, unknown>;
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("dependencies", () => {
  it("has no runtime dependencies", () => {
    assert.deepEqual(
      pkg.dependencies ?? {},
      {},
      "the engine must install nothing; a browser media library that drags in a tree is a library people vendor instead of install",
    );
  });

  it("declares every peer dependency optional", () => {
    const peers = Object.keys(pkg.peerDependencies ?? {});
    for (const name of peers) {
      assert.equal(
        pkg.peerDependenciesMeta?.[name]?.optional,
        true,
        `${name} must be an optional peer, or a Svelte consumer is asked to install it`,
      );
    }
  });
});

describe("framework independence", () => {
  const FRAMEWORKS = [
    "react",
    "react-dom",
    "preact",
    "svelte",
    "vue",
    "solid-js",
    "@angular/core",
    "zustand",
  ];

  it("keeps every framework out of the core", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(join(root, "src"))) {
      // The React adapter is the one file allowed to import React; it is
      // behind its own entry point and an optional peer.
      if (file.includes(`${"/"}react${"/"}`)) continue;

      const text = readFileSync(file, "utf8");
      for (const fw of FRAMEWORKS) {
        const pattern = new RegExp(`from\\s+["']${fw.replace("/", "\\/")}["']`);
        if (pattern.test(text)) offenders.push(`${file} imports ${fw}`);
      }
    }

    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("keeps Node builtins out of src entirely", () => {
    // Importing a Node builtin anywhere in src would break the browser, the
    // Worker and the Deno stories at once.
    const offenders: string[] = [];
    for (const file of sourceFiles(join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      if (/from\s+["']node:/.test(text)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  it("exposes the framework adapter behind its own entry point", () => {
    assert.ok(pkg.exports?.["./react"], "React bindings must not sit on the main entry");
    assert.ok(pkg.exports?.["."], "the core entry must exist");
  });
});
