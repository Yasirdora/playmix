/**
 * Rewrite `.ts` import specifiers in emitted declaration files.
 *
 * `rewriteRelativeImportExtensions` rewrites specifiers in emitted JavaScript
 * but not in emitted `.d.ts` files, so a build that succeeds still ships
 * declarations importing `./clock.ts` — a path that exists in `src/` and
 * nowhere in the published package. TypeScript then fails to resolve types for
 * every consumer, while the runtime works fine, which makes it look like a
 * consumer configuration problem rather than a packaging bug.
 *
 * The `.ts` specifiers in `src/` are deliberate: they let `node --test` run the
 * sources with no build step. This pass is the cost of that, and it runs before
 * check-dist so the check can verify it worked.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* Only relative specifiers are rewritten. A bare specifier ending in `.ts`
   would be a dependency's problem, not ours, and rewriting it would corrupt a
   package name. */
const SPECIFIER = /(from\s*["'])(\.[^"']*)\.ts(["'])/g;

let touched = 0;
for (const file of walk(dist)) {
  if (!file.endsWith(".d.ts")) continue;
  const before = readFileSync(file, "utf8");
  const after = before.replace(SPECIFIER, "$1$2.js$3");
  if (after !== before) {
    writeFileSync(file, after);
    touched++;
  }
}

console.log(`postbuild: rewrote specifiers in ${touched} declaration file(s)`);
