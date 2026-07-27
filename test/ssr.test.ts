/**
 * Server-render safety.
 *
 * Next.js, Astro, SvelteKit, Nuxt and Remix all evaluate component modules on
 * a server where `document`, `window`, `AudioContext` and
 * `requestAnimationFrame` do not exist. A package that touches any of them at
 * import time — or in a constructor — is unusable in all of them, and the
 * failure is a hard crash during render rather than a degraded experience.
 *
 * This suite runs in plain Node, which genuinely has none of those globals, so
 * it is not a simulation: if these pass, the engine imports and constructs on
 * a server.
 *
 * The original code failed this. Its clock was a module-level singleton
 * (`export const clock = new EditorClock()`) whose constructor attached a
 * `visibilitychange` listener, so merely importing it crashed outside a
 * browser. Converting to a factory is what fixed it, and this test is what
 * stops it coming back.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import * as playmix from "../src/index.ts";
import { createClock } from "../src/clock.ts";
import { ManualTimeSource } from "../src/testing/manual-time.ts";

describe("server rendering", () => {
  it("runs in an environment with no browser globals", () => {
    assert.equal(typeof document, "undefined", "precondition: no document here");
    assert.equal(typeof window, "undefined", "precondition: no window here");
    assert.equal(typeof AudioContext, "undefined", "precondition: no Web Audio here");
    assert.equal(
      typeof requestAnimationFrame,
      "undefined",
      "precondition: no animation frames here",
    );
  });

  it("imports without touching the platform", () => {
    // Reaching this line at all means module evaluation completed.
    assert.equal(typeof playmix.createClock, "function");
    assert.equal(typeof playmix.clipGainAt, "function");
  });

  it("constructs a clock on the server", () => {
    const clock = createClock();
    assert.equal(clock.time(), 0);
    assert.equal(clock.playing(), false);
    clock.dispose();
  });

  it("serves a stable snapshot for hydration", () => {
    // useSyncExternalStore calls getServerSnapshot during SSR; it must return
    // a value rather than throw, and the same value every time, or React
    // reports a hydration mismatch.
    const clock = createClock();
    assert.equal(clock.getTimeSnapshot(), clock.getTimeSnapshot());
    assert.equal(clock.getPlayingSnapshot(), false);
    clock.dispose();
  });

  it("supports the framework-neutral store contract off-browser", () => {
    const clock = createClock({ timeSource: new ManualTimeSource() });
    const seen: number[] = [];
    const unsub = playmix.timeStore(clock).subscribe((v) => seen.push(v));

    // Svelte's contract requires an immediate call with the current value.
    assert.deepEqual(seen, [0]);

    clock.seek(2);
    assert.deepEqual(seen, [0, 2]);

    unsub();
    clock.seek(3);
    assert.deepEqual(seen, [0, 2], "unsubscribe must actually detach");
    clock.dispose();
  });

  it("only reaches for the platform when playback starts", () => {
    // The default time source closes over requestAnimationFrame rather than
    // calling it, so construction is safe and only play() needs a browser.
    const clock = createClock();
    assert.throws(() => clock.play(), /requestAnimationFrame|is not defined/);
    clock.dispose();
  });
});
