/**
 * What the scheduler commands, and when.
 *
 * These are the behaviours that separate a smooth timeline from a stuttering
 * one, and none of them is visible in the types: warm the next clip but do not
 * start it, seek hard at a cut, rate-limit the nudge, stop the clip you left.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createClock } from "../src/clock.ts";
import { createScheduler } from "../src/scheduler.ts";
import { FakeGraph, FakePool, asGraph, asPool } from "../src/testing/fake-media.ts";
import { ManualTimeSource } from "../src/testing/manual-time.ts";
import type { MediaClip, Timeline, Track } from "../src/types.ts";

const track: Track = {
  id: "t1",
  kind: "audio",
  muted: false,
  soloed: false,
  hidden: false,
  volume: 1,
};

function clip(id: string, start: number, duration: number, over: Partial<MediaClip> = {}): MediaClip {
  return {
    id,
    trackId: "t1",
    kind: "audio",
    assetId: "a1",
    start,
    duration,
    inPoint: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    disabled: false,
    ...over,
  };
}

function timeline(...clips: MediaClip[]): Timeline {
  const map: Record<string, MediaClip> = {};
  for (const c of clips) map[c.id] = c;
  return {
    assets: { a1: { id: "a1", url: "blob:fake", duration: 600 } },
    clips: map,
    clipOrder: clips.map((c) => c.id),
    tracks: [track],
    stackOverlaps: false,
  };
}

function setup() {
  const time = new ManualTimeSource();
  const clock = createClock({ timeSource: time, reviveOnVisible: false });
  const pool = new FakePool();
  const graph = new FakeGraph();
  let wall = 0;
  const scheduler = createScheduler({
    clock,
    pool: asPool(pool),
    graph: asGraph(graph),
    now: () => wall,
  });
  scheduler.start();
  return {
    clock,
    pool,
    scheduler,
    time,
    advanceWall: (ms: number) => {
      wall += ms;
    },
  };
}

describe("scheduler", () => {
  it("plays the clip under the playhead and nothing else", () => {
    const { clock, pool, scheduler } = setup();
    scheduler.setTimeline(timeline(clip("a", 0, 5), clip("b", 100, 5)));
    clock.play();

    const played = pool.ops("play").map((c) => c.clipId);
    assert.deepEqual(played, ["a"], "only the clip in range should start");
    scheduler.dispose();
  });

  it("warms an upcoming clip without starting it", () => {
    // The whole reason cuts are smooth: the next clip is seeked to its
    // in-point and left paused, so play() at the cut is instant.
    const { clock, pool, scheduler } = setup();
    scheduler.setTimeline(timeline(clip("a", 0, 5), clip("b", 1, 5, { inPoint: 12 })));
    clock.play();

    const seeks = pool.ops("seek").filter((c) => c.clipId === "b");
    assert.ok(seeks.length > 0, "the upcoming clip must be pre-seeked");
    assert.equal(seeks[0]?.time, 12, "pre-seek must land on the clip's in-point");
    assert.equal(
      pool.ops("play").filter((c) => c.clipId === "b").length,
      0,
      "pre-buffering must not start playback — that would force a backward seek at the cut",
    );
    scheduler.dispose();
  });

  it("leaves a clip beyond the look-ahead window alone", () => {
    const { clock, pool, scheduler } = setup();
    scheduler.setTimeline(timeline(clip("a", 0, 5), clip("far", 60, 5)));
    clock.play();

    assert.equal(
      pool.commands.filter((c) => c.clipId === "far").length,
      0,
      "a clip a minute away should not be touched",
    );
    scheduler.dispose();
  });

  it("pauses a clip once the playhead leaves it", () => {
    const { clock, pool, scheduler } = setup();
    scheduler.setTimeline(timeline(clip("a", 0, 2)));
    clock.play();
    pool.clear();

    clock.seek(30);
    assert.deepEqual(
      pool.ops("pause").map((c) => c.clipId),
      ["a"],
      "leaving a clip must pause it, not leave it running under the timeline",
    );
    scheduler.dispose();
  });

  it("rate-limits nudges but never the seek at a cut", () => {
    const { clock, pool, scheduler, advanceWall } = setup();
    scheduler.setTimeline(timeline(clip("a", 0, 100)));
    clock.play();
    pool.clear();

    // Drift the element far from where the clock says it should be, twice in
    // quick succession. Only the first correction may go through.
    const entry = pool.get("a");
    assert.ok(entry);
    entry.el.currentTime = 50;
    pool.clear();

    clock.seek(1);
    const first = pool.ops("seek").length;
    clock.seek(1.001);
    const second = pool.ops("seek").length;
    assert.equal(second, first, "a second correction within the rate limit must be suppressed");

    advanceWall(100);
    clock.seek(2);
    assert.ok(pool.ops("seek").length > second, "once the window passes, corrections resume");
    scheduler.dispose();
  });

  it("skips disabled clips entirely", () => {
    const { clock, pool, scheduler } = setup();
    scheduler.setTimeline(timeline(clip("a", 0, 5, { disabled: true })));
    clock.play();
    assert.equal(pool.ops("play").length, 0, "a bypassed clip must never be commanded");
    scheduler.dispose();
  });

  it("detaches audio when its track is muted", () => {
    const { clock, pool, scheduler } = setup();
    const t = timeline(clip("a", 0, 5));
    scheduler.setTimeline(t);
    clock.play();
    pool.clear();

    scheduler.setTimeline({ ...t, tracks: [{ ...track, muted: true }] });
    assert.ok(
      pool.ops("pause").some((c) => c.clipId === "a"),
      "muting a track must stop the clip, not merely zero its gain",
    );
    scheduler.dispose();
  });

  it("releases pool entries for clips removed from the timeline", () => {
    const { pool, scheduler } = setup();
    scheduler.setTimeline(timeline(clip("a", 0, 5), clip("b", 10, 5)));
    assert.ok(pool.get("b"), "precondition: b is pooled");

    scheduler.setTimeline(timeline(clip("a", 0, 5)));
    assert.equal(pool.get("b"), undefined, "a deleted clip must not keep its element alive");
    scheduler.dispose();
  });

  it("stops commanding after dispose", () => {
    const { clock, pool, scheduler } = setup();
    scheduler.setTimeline(timeline(clip("a", 0, 100)));
    clock.play();
    scheduler.dispose();
    pool.clear();

    clock.seek(3);
    assert.equal(pool.commands.length, 0, "a disposed scheduler must be detached from the clock");
  });
});
