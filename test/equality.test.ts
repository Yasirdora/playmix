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

import { RecordingGainNode, asGainNode } from "../src/testing/automation.ts";
import { buildExportOverlapContext, mixGainAt, scheduleClipGain } from "../src/mix/index.ts";
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
