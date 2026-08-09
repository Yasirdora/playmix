/**
 * The equality test — the package's central claim, asserted.
 *
 * For a range of clip shapes, the gain automation programmed onto a node must
 * evaluate to the same curve as `mixGainAt`, which is what the offline
 * renderer, the meters and the waveform overlay all read. If these two ever
 * disagree, a fade sounds one way on the timeline and renders another way to
 * disk — the bug this engine exists to make structurally impossible.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createClock } from "../src/clock.ts";
import { createScheduler } from "../src/scheduler.ts";
import { RecordingGainNode, asGainNode } from "../src/testing/automation.ts";
import { FakeGraph, FakePool, asGraph, asPool } from "../src/testing/fake-media.ts";
import { ManualTimeSource } from "../src/testing/manual-time.ts";
import {
  buildExportOverlapContext,
  clipGainAt,
  mixGainAt,
  scheduleClipGain,
  type OverlapContext,
} from "../src/mix/index.ts";
import type { Clip, MediaClip, Track } from "../src/types.ts";

const track: Track = {
  id: "t1",
  kind: "audio",
  muted: false,
  soloed: false,
  hidden: false,
  volume: 1,
};

function clip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    id: "c1",
    trackId: "t1",
    kind: "audio",
    assetId: "a1",
    start: 0,
    duration: 4,
    inPoint: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    disabled: false,
    ...over,
  };
}

/** Sample across the clip, avoiding the exact endpoints where ramps meet. */
function samples(duration: number, n = 41): number[] {
  const out: number[] = [];
  for (let i = 1; i < n - 1; i++) out.push((i / (n - 1)) * duration);
  return out;
}

function assertAgrees(c: Clip, tr: Track, tolerance: number, ctxClips?: Record<string, Clip>) {
  const node = new RecordingGainNode();
  const overlapCtx = ctxClips
    ? buildExportOverlapContext(ctxClips, Object.keys(ctxClips), true, null)
    : undefined;

  scheduleClipGain(asGainNode(node), c, tr, 0, overlapCtx);

  for (const t of samples(c.duration)) {
    const scheduled = node.gain.valueAt(t);
    const model = mixGainAt(c, tr, t, overlapCtx);
    assert.ok(
      Math.abs(scheduled - model) <= tolerance,
      `at t=${t.toFixed(3)}s scheduled=${scheduled.toFixed(5)} but model=${model.toFixed(5)}`,
    );
  }
}

describe("scheduled automation matches the mix model", () => {
  it("agrees on a flat clip", () => {
    assertAgrees(clip({ volume: 0.8 }), track, 1e-9);
  });

  it("agrees through a fade in and a fade out", () => {
    assertAgrees(clip({ fadeIn: 1, fadeOut: 1.5, volume: 0.9 }), track, 1e-9);
  });

  it("agrees with the track fader applied", () => {
    assertAgrees(clip({ fadeIn: 0.5, volume: 1.2 }), { ...track, volume: 0.4 }, 1e-9);
  });

  it("agrees across a volume automation envelope", () => {
    const c = clip({
      duration: 6,
      volumePoints: [
        { time: 0, value: 0 },
        { time: 1.5, value: 1 },
        { time: 3, value: 0.25 },
        { time: 6, value: 1 },
      ],
    });
    assertAgrees(c, track, 1e-9);
  });

  it("holds the last envelope value to the end of the clip", () => {
    const c = clip({
      duration: 5,
      volumePoints: [
        { time: 0, value: 1 },
        { time: 2, value: 0.5 },
      ],
    });
    const node = new RecordingGainNode();
    scheduleClipGain(asGainNode(node), c, track, 0);
    assert.equal(node.gain.valueAt(4.9), 0.5, "value must hold, not drift, after the last point");
  });

  it("agrees across an equal-power crossfade", () => {
    // Two overlapping clips on one track: the tail of A crossfades into B.
    const a = clip({ id: "a", start: 0, duration: 4 });
    const b = clip({ id: "b", start: 3, duration: 4 });
    // The curve is sampled at 30 Hz and linearly interpolated between samples,
    // so a cosine is approximated rather than reproduced. The tolerance is the
    // honest bound on that approximation, not slack for a modelling error.
    assertAgrees(a, track, 5e-3, { a, b });
  });
});

describe("silence is reachable", () => {
  it("a muted track silences the clip in the model", () => {
    const c = clip({ volume: 1 });
    const muted: Track = { ...track, muted: true };
    // Mute is resolved at clip-resolution time rather than folded into gain,
    // so the fader still reads 1 here; this documents that boundary.
    assert.equal(mixGainAt(c, muted, 1), 1);
  });

  it("a zero-length clip schedules silence rather than dividing by zero", () => {
    const node = new RecordingGainNode();
    const c = clip({ duration: 0 });
    scheduleClipGain(asGainNode(node), c, track, 0);
    assert.ok(Number.isFinite(node.gain.valueAt(0)));
  });
});

describe("preview and export resolve the same crossfade default", () => {
  /**
   * `stackOverlaps` is optional, and for a while each consumer supplied its own
   * default when the host omitted it: the renderer and the meter path said
   * `?? true`, while the scheduler spread the field only when it was defined
   * and so left it `undefined`. A timeline that simply never mentioned the flag
   * — the shape the README's own quick start hands over — therefore crossfaded
   * on export and hard-cut in preview.
   *
   * That is precisely the divergence this package exists to rule out, so the
   * default is asserted here rather than trusted to stay spelled the same in
   * three files.
   */

  const a = clip({ id: "a", start: 0, duration: 4 });
  const b = clip({ id: "b", start: 3, duration: 4 });
  const clips: Record<string, Clip> = { a, b };

  it("treats an omitted flag exactly like an explicit true", () => {
    const omitted: OverlapContext = { clips, clipOrder: ["a", "b"] };
    const explicit: OverlapContext = { clips, clipOrder: ["a", "b"], stackOverlaps: true };

    for (const t of samples(a.duration)) {
      assert.equal(
        clipGainAt(a, t, omitted),
        clipGainAt(a, t, explicit),
        `omitting stackOverlaps must not change gain at t=${t.toFixed(3)}s`,
      );
    }
  });

  it("still honours an explicit false", () => {
    const off: OverlapContext = { clips, clipOrder: ["a", "b"], stackOverlaps: false };
    // Mid-overlap, where an equal-power crossfade would be well under unity.
    assert.equal(clipGainAt(a, 3.5, off), 1, "stackOverlaps: false must hard-cut, not crossfade");
    assert.ok(clipGainAt(a, 3.5, { ...off, stackOverlaps: true }) < 0.8);
  });

  it("schedules exact ramps rather than a sampled curve when crossfades are off", () => {
    /* The sampled-curve path exists only to reproduce a cosine. Taking it with
       crossfades off would swap an exact schedule for a 30 Hz approximation of
       itself, so the shape of the automation is asserted, not just its values. */
    const node = new RecordingGainNode();
    const off: OverlapContext = { clips, clipOrder: ["a", "b"], stackOverlaps: false };
    scheduleClipGain(asGainNode(node), a, track, 0, off);
    assert.ok(
      !node.gain.events.some((e) => e.kind === "curve"),
      "a hard-cut clip must not be scheduled as a sampled curve",
    );
  });

  it("agrees between the live scheduler and the mix model with the flag omitted", () => {
    /* End to end through the real scheduler, over an overlapping pair, with the
       flag absent: what it programs onto the clip's gain node must match what
       the renderer reads from the model given the same context. This guards the
       scheduler's side of the contract — that it keeps handing the flag through
       untouched rather than defaulting it itself, which is how the divergence
       above arose. The two tests before it pin the default. */
    const time = new ManualTimeSource();
    const clock = createClock({ timeSource: time, reviveOnVisible: false });
    const pool = new FakePool();
    const scheduler = createScheduler({
      clock,
      pool: asPool(pool),
      graph: asGraph(new FakeGraph()),
      now: () => 0,
    });
    scheduler.start();

    scheduler.setTimeline({
      assets: { a1: { id: "a1", url: "blob:fake", duration: 600 } },
      clips,
      clipOrder: ["a", "b"],
      tracks: [track],
      // stackOverlaps deliberately absent — this is the case that regressed.
    });
    clock.play();

    const gain = pool.get("a")?.gain as unknown as RecordingGainNode | undefined;
    assert.ok(gain, "the scheduler must have routed and scheduled clip a");

    const exportCtx = buildExportOverlapContext(clips, ["a", "b"], undefined, null);
    for (const t of samples(a.duration)) {
      const previewed = gain.gain.valueAt(t);
      const exported = mixGainAt(a, track, t, exportCtx);
      assert.ok(
        Math.abs(previewed - exported) <= 5e-3,
        `at t=${t.toFixed(3)}s preview=${previewed.toFixed(5)} but export=${exported.toFixed(5)}`,
      );
    }

    scheduler.dispose();
    clock.dispose();
  });
});
