/**
 * Smoke-test the built package rather than the sources.
 *
 * Everything else in this suite imports from `src/`, which means it verifies
 * the code and not the artifact. The failures that actually reach consumers
 * live in the gap between the two: an entry point missing from `exports`, a
 * specifier the emit didn't rewrite, a declaration file pointing at a path that
 * only exists in the repo. Those all typecheck and all pass the other tests.
 *
 * Requires `npm run build` first; run via `npm run test:dist`.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).href;
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url).pathname, "utf8"),
) as { exports: Record<string, { import?: string; types?: string } | string> };

describe("built package", () => {
  it("exposes the documented core API", async () => {
    const mod = await import(`${root}dist/index.js`);
    for (const name of [
      "createEngine",
      "createClock",
      "createAudioGraph",
      "createMediaPool",
      "createScheduler",
      "renderMix",
      "clipGainAt",
      "mixGainAt",
      "scheduleClipGain",
      "scheduleLiveClipGain",
      "timeStore",
      "playingStore",
      "quantizeToFrame",
    ]) {
      assert.equal(typeof mod[name], "function", `dist is missing ${name}`);
    }
  });

  it("runs the mix model from the build", async () => {
    const { clipGainAt } = await import(`${root}dist/index.js`);
    const clip = {
      id: "c",
      trackId: "t",
      kind: "audio",
      assetId: "a",
      start: 0,
      duration: 4,
      inPoint: 0,
      speed: 1,
      volume: 1,
      fadeIn: 2,
      fadeOut: 0,
      disabled: false,
    };
    // Halfway through a two-second fade-in from a base of 1.
    assert.ok(Math.abs(clipGainAt(clip, 1) - 0.5) < 1e-9);
  });

  it("constructs a clock from the build without a browser", async () => {
    const { createClock } = await import(`${root}dist/index.js`);
    const clock = createClock({ reviveOnVisible: false });
    assert.equal(clock.time(), 0);
    clock.dispose();
  });

  it("resolves every entry point named in exports", async () => {
    for (const [name, entry] of Object.entries(pkg.exports)) {
      if (name === "./package.json" || typeof entry === "string") continue;
      const target = entry.import;
      if (!target) continue;
      const mod = await import(`${root}${target.replace("./", "")}`);
      assert.ok(
        Object.keys(mod).length > 0,
        `${name} resolved but exported nothing — a barrel that lost its re-exports`,
      );
    }
  });

  it("keeps the mix subpath free of engine internals", async () => {
    // playmix/mix is the pure-math entry, meant to be importable by a meter or
    // an overlay without dragging the scheduler and its DOM assumptions along.
    const mix = await import(`${root}dist/mix/index.js`);
    assert.equal(mix.createScheduler, undefined);
    assert.equal(mix.createEngine, undefined);
    assert.equal(typeof mix.clipGainAt, "function");
  });
});
