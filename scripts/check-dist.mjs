/**
 * Post-build checks.
 *
 * A build that emits without error can still be unusable: a stray `.ts`
 * specifier that no runtime resolves, a missing entry point named in
 * `exports`, or a Node builtin that crept into browser code. Each of those
 * fails at a consumer's import rather than here, which is the wrong place to
 * find out. These are cheap and run on every build.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const failures = [];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(dist);
} catch {
  console.error("check-dist: dist/ is missing — did the build run?");
  process.exit(1);
}

const js = files.filter((f) => f.endsWith(".js"));
const dts = files.filter((f) => f.endsWith(".d.ts"));

if (js.length === 0) failures.push("no .js emitted");
if (dts.length === 0) failures.push("no .d.ts emitted");

// 1. Every relative specifier must resolve to a real emitted file.
for (const file of [...js, ...dts]) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/from\s+["'](\.[^"']*)["']/g)) {
    const spec = m[1];
    if (spec.endsWith(".ts")) {
      failures.push(`${file}: unrewritten TypeScript specifier "${spec}"`);
      continue;
    }
    const target = join(dirname(file), spec);
    const exists = files.includes(target) || files.includes(`${target}.js`);
    if (!exists) failures.push(`${file}: "${spec}" resolves to nothing in dist/`);
  }
  // 2. Node builtins would break the browser, Workers and Deno at once.
  if (/from\s+["']node:/.test(text)) failures.push(`${file}: imports a Node builtin`);
}

// 3. Everything package.json promises must actually be there.
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const [name, entry] of Object.entries(pkg.exports ?? {})) {
  const targets = typeof entry === "string" ? [entry] : Object.values(entry);
  for (const target of targets) {
    if (typeof target !== "string" || target === "./package.json") continue;
    try {
      statSync(join(root, target));
    } catch {
      failures.push(`exports["${name}"] points at ${target}, which does not exist`);
    }
  }
}

// 4. Zero runtime dependencies is a promise the README makes.
if (Object.keys(pkg.dependencies ?? {}).length > 0) {
  failures.push("dependencies is not empty");
}

if (failures.length > 0) {
  console.error("check-dist failed:\n" + failures.map((f) => `  • ${f}`).join("\n"));
  process.exit(1);
}

console.log(`check-dist: ok — ${js.length} modules, ${dts.length} declaration files`);
