/**
 * Minimal declarations for the Node builtins the test suite uses.
 *
 * `@types/node` is deliberately not a dependency. `src/` imports no Node
 * builtin at all — that is what lets the engine run in a browser, a Worker, or
 * Deno without a shim — and pulling the full Node typings in just to type two
 * test imports would make it easy to add a Node import to `src/` by accident
 * and not notice until someone's bundle broke.
 *
 * If a test needs another builtin, declare exactly what it uses here.
 */

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export function test(name: string, fn: TestFn): void;
  export function before(fn: TestFn): void;
  export function after(fn: TestFn): void;
  export function beforeEach(fn: TestFn): void;
  export function afterEach(fn: TestFn): void;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean };
  export function statSync(
    path: string,
    opts: { throwIfNoEntry: false },
  ): { isDirectory(): boolean } | undefined;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:assert" {
  type Assert = {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): void;
    throws(fn: () => unknown, expected?: unknown, message?: string): void;
    rejects(fn: () => Promise<unknown>, expected?: unknown, message?: string): Promise<void>;
    fail(message?: string): never;
  };
  export const strict: Assert;
  const assert: Assert;
  export default assert;
}
