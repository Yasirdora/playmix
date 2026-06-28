import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createClock } from "../src/clock.ts";
import { ManualTimeSource } from "../src/testing/manual-time.ts";

function setup() {
  const time = new ManualTimeSource();
  const clock = createClock({ timeSource: time, reviveOnVisible: false });
  return { time, clock };
}

describe("clock", () => {
  it("advances in real project seconds", () => {
    const { time, clock } = setup();
    clock.play();
    time.advance(1000);
    assert.ok(Math.abs(clock.time() - 1) < 1e-6, `expected ~1s, got ${clock.time()}`);
    clock.dispose();
  });

  it("does not accumulate drift when frames are dropped", () => {
    // The whole reason time is recomputed rather than accumulated: a stalled
    // second must cost one second, not compound into a permanent offset.
    const { time, clock } = setup();
    clock.play();
    time.advance(500);
    time.skip(2000); // two seconds with no frames at all
    time.tick();
    assert.ok(
      Math.abs(clock.time() - 2.5166) < 0.02,
      `expected time to reflect wall clock, got ${clock.time()}`,
    );
    clock.dispose();
  });

  it("stops at max and fires onEnd exactly once", () => {
    const { time, clock } = setup();
    let ends = 0;
    clock.setOnEnd(() => ends++);
    clock.setMax(0.2);
    clock.play();
    time.advance(1000);
    assert.equal(clock.playing(), false);
    assert.equal(clock.time(), 0.2);
    assert.equal(ends, 1);
    clock.dispose();
  });

  it("wraps to loop start without stopping", () => {
    const { time, clock } = setup();
    clock.setMax(10);
    clock.setLoop(true, 1, 2);
    clock.seek(1);
    clock.play();
    time.advance(1500);
    assert.equal(clock.playing(), true);
    assert.ok(clock.time() >= 1 && clock.time() < 2, `expected inside loop, got ${clock.time()}`);
    clock.dispose();
  });

  it("keeps ticking when a subscriber throws", () => {
    const { time, clock } = setup();
    let good = 0;
    clock.subscribe(() => {
      throw new Error("subscriber boom");
    });
    clock.subscribe(() => good++);
    clock.play();
    time.advance(200);
    assert.ok(good > 5, `expected the healthy subscriber to keep running, got ${good} calls`);
    assert.equal(clock.playing(), true);
    clock.dispose();
  });

  it("absorbs small drift smoothly and snaps on large drift", () => {
    const { time, clock } = setup();
    clock.play();
    time.advance(1000);

    const before = clock.time();
    clock.syncTo(before + 0.05); // small: converge, do not jump
    assert.equal(clock.time(), before, "a small correction must not move the playhead this frame");

    clock.syncTo(before + 5); // large: honour it immediately
    assert.ok(Math.abs(clock.time() - (before + 5)) < 1e-6, "a large drift must snap");
    clock.dispose();
  });

  it("ignores sync while paused", () => {
    const { clock } = setup();
    clock.seek(3);
    clock.syncTo(9);
    assert.equal(clock.time(), 3);
    clock.dispose();
  });

  it("releases its frame on dispose", () => {
    const { time, clock } = setup();
    clock.play();
    time.tick();
    clock.dispose();
    assert.equal(time.pendingFrames, 0, "dispose must not leave a frame scheduled");
  });
});
