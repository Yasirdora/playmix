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
  private?: boolean;
  author?: string;
  repository?: { url?: string };
  bugs?: string;
  files?: string[];
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

describe("publishable", () => {
  it("is not marked private", () => {
    // `npm publish` refuses a private package outright — and `--dry-run` does
    // not, so the dry run is no evidence either way.
    assert.notEqual(pkg.private, true, "remove `private` before publishing");
  });

  it("says who wrote it and where it lives", () => {
    assert.ok(pkg.author, "author");
    assert.ok(pkg.repository?.url, "repository.url");
    assert.ok(pkg.bugs, "bugs");
  });

  it("ships every committed path it promises", () => {
    /* `dist` is a build output, and `npm test` has to pass on a clean checkout
       with none present — that is why built-package.check.ts sits outside the
       test glob. check-dist verifies dist after the build; everything else in
       `files` is committed and must be here. */
    const BUILD_OUTPUTS = new Set(["dist"]);
    for (const entry of pkg.files ?? []) {
      if (BUILD_OUTPUTS.has(entry)) continue;
      assert.ok(
        statSync(join(root, entry), { throwIfNoEntry: false }),
        `files lists missing ${entry}`,
      );
    }
  });

  it("ships the sources its declaration maps point at", () => {
    /* Every `.d.ts.map` names `../src/*.ts`. Publishing the maps without the
       sources sends consumers' go-to-definition to a file that isn't in the
       tarball, so the two travel together or neither does. */
    assert.ok(
      pkg.files?.includes("src"),
      "declaration maps reference src/, so src/ must be published alongside them",
    );
  });

  it("links only to files a reader can actually reach", () => {
    /* npm rewrites relative README links against `repository`, so they resolve
       on the package page only if the paths exist in the repo. A dead link in
       the README is the first thing a visitor clicks. */
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const broken: string[] = [];
    for (const m of readme.matchAll(/\]\((?!https?:|#|mailto:)([^)]+)\)/g)) {
      const target = (m[1] ?? "").split("#")[0];
      if (!target) continue;
      if (!statSync(join(root, target), { throwIfNoEntry: false })) broken.push(target);
    }
    assert.deepEqual(broken, [], `README links to nonexistent paths: ${broken.join(", ")}`);
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
