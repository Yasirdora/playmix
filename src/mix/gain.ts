/**
 * The mix model — the single definition of how loud a clip is at a moment.
 *
 * This module is the reason the package exists. Every consumer of gain reads
 * it from here:
 *
 *   • the live scheduler, via `scheduleLiveClipGain`, which programs Web Audio
 *     ramps on a playing clip's gain node;
 *   • the offline renderer, via `scheduleClipGain`, which programs the same
 *     ramps on an OfflineAudioContext node during mixdown;
 *   • any waveform or meter drawing, via `clipGainAt` / `mixGainAt`.
 *
 * The usual architecture gives preview and export their own gain math, written
 * months apart, and they drift: a fade sounds one way on the timeline and
 * renders another way to disk. Every serious editor has shipped that bug. It is
 * not a discipline problem — two implementations of one rule diverge because
 * nothing forces them not to. Here there is one implementation, so agreement is
 * a property of the wiring rather than something anyone has to remember.
 *
 * Scope note, stated plainly: crossfade resolution applies to **audio** clips
 * only. Video clips carry gain and fades, but two overlapping video clips do
 * not crossfade — compositing pixels is a different problem with a different
 * architecture, and this engine deliberately does not solve it.
 */

import type { Clip, EnvelopePoint, MediaClip, Track } from "../types.ts";
import {
  clipHasOverlap,
  crossfadeMultiplier,
  crossfadesEnabled,
  type OverlapContext,
  trackOverlapSignature,
} from "./crossfade.ts";
import { clampSpeed } from "./constants.ts";
import { interpolateEnvelope } from "./envelope.ts";

export type { OverlapContext } from "./crossfade.ts";

/**
 * What resolving audible clips actually needs: the arrangement, and an instant.
 *
 * Deliberately *not* `Timeline & { time }`. Gain is computed from clip and
 * track geometry alone — it never reads an asset — so requiring `assets` here
 * would oblige every caller to hand over data the function ignores, and make a
 * unit test construct a fake asset map to check a fade. A `Timeline` still
 * satisfies this structurally, so passing one costs nothing.
 */
export type MixContext = {
  tracks: Track[];
  clips: Record<string, Clip>;
  clipOrder: string[];
  time: number;
  stackOverlaps?: boolean | undefined;
};

export type AudibleClip = {
  clip: MediaClip;
  track: Track;
  localTime: number;
  gain: number;
};

// ── Track audibility ────────────────────────────────────────────────────────

export function hasSoloedTrack(tracks: Track[]): boolean {
  return tracks.some((t) => t.soloed);
}

/**
 * Solo is a property of the track set, not of one track: the moment any track
 * is soloed, every track that is not soloed goes silent. Muting a track always
 * wins, including over its own solo.
 */
export function isTrackAudible(track: Track, tracks: Track[]): boolean {
  if (track.muted) return false;
  if (hasSoloedTrack(tracks) && !track.soloed) return false;
  return true;
}

export function isClipInRange(clip: Clip, time: number): boolean {
  if (clip.disabled) return false;
  return time >= clip.start && time < clip.start + clip.duration;
}

// ── Gain ────────────────────────────────────────────────────────────────────

/**
 * Base gain from the clip's own volume, then either its automation envelope or
 * its fades — never both. An envelope is an explicit statement about the whole
 * clip, so honoring fades on top of it would silently contradict what the user
 * drew.
 */
export function gainAtLocalTime(clip: Clip, localTime: number): number {
  const base = Math.max(0, clip.volume ?? 1);

  if (clip.volumePoints && clip.volumePoints.length > 0) {
    return base * interpolateEnvelope(clip.volumePoints, localTime);
  }

  let fadeGain = 1;
  if (clip.fadeIn > 0.001 && localTime < clip.fadeIn) {
    fadeGain = Math.min(1, localTime / clip.fadeIn);
  }
  if (clip.fadeOut > 0.001 && localTime > clip.duration - clip.fadeOut) {
    fadeGain = Math.min(fadeGain, Math.max(0, (clip.duration - localTime) / clip.fadeOut));
  }
  return base * fadeGain;
}

/** Clip-level gain — volume, envelope or fades, and crossfade. Excludes the track fader. */
export function clipGainAt(clip: Clip, localTime: number, overlapCtx?: OverlapContext): number {
  const base = gainAtLocalTime(clip, localTime);
  if (!overlapCtx || clip.kind !== "audio") return base;
  if (!crossfadesEnabled(overlapCtx)) return base;
  return base * crossfadeMultiplier(clip as MediaClip, localTime, overlapCtx);
}

/** Full mix gain including the track fader. What export and metering use. */
export function mixGainAt(
  clip: Clip,
  track: Track,
  localTime: number,
  overlapCtx?: OverlapContext,
): number {
  return clipGainAt(clip, localTime, overlapCtx) * Math.max(0, track.volume ?? 1);
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** Every audio clip sounding at `ctx.time`, with its resolved gain. */
export function resolveAudibleClips(ctx: MixContext): AudibleClip[] {
  const out: AudibleClip[] = [];

  for (const id of ctx.clipOrder) {
    const clip = ctx.clips[id];
    if (clip?.kind !== "audio") continue;

    const track = ctx.tracks.find((t) => t.id === clip.trackId);
    if (!track || !isTrackAudible(track, ctx.tracks)) continue;
    if (!isClipInRange(clip, ctx.time)) continue;

    const localTime = ctx.time - clip.start;
    const overlapCtx: OverlapContext = {
      clips: ctx.clips,
      clipOrder: ctx.clipOrder,
      stackOverlaps: ctx.stackOverlaps,
    };
    out.push({
      clip: clip as MediaClip,
      track,
      localTime,
      gain: mixGainAt(clip, track, localTime, overlapCtx),
    });
  }

  return out;
}

/** Audio clips to render, in timeline order, optionally restricted to a range. */
export function resolveRenderClips(
  tracks: Track[],
  clips: Record<string, Clip>,
  clipOrder: string[],
  range?: { start: number; end: number },
): MediaClip[] {
  const result: MediaClip[] = [];

  for (const id of clipOrder) {
    const clip = clips[id];
    if (clip?.kind !== "audio" || clip.disabled) continue;

    const track = tracks.find((t) => t.id === clip.trackId);
    if (!track || !isTrackAudible(track, tracks)) continue;

    if (range) {
      const end = clip.start + clip.duration;
      if (end <= range.start || clip.start >= range.end) continue;
    }

    result.push(clip as MediaClip);
  }

  return result.sort((a, b) => a.start - b.start);
}

/**
 * Overlap context scoped to an export range.
 *
 * Rendering a selection has to resolve crossfades against the *sliced* clips,
 * not the originals: a clip trimmed by the range boundary has a different
 * overlap with its neighbour than the untrimmed one did, and using the
 * untrimmed geometry makes a partial export fade differently from the same
 * region inside a full export.
 */
export function buildExportOverlapContext(
  clips: Record<string, Clip>,
  clipOrder: string[],
  stackOverlaps: boolean | undefined,
  range?: { start: number; end: number } | null,
): OverlapContext {
  if (!range) return { clips, clipOrder, stackOverlaps };

  const scoped: Record<string, Clip> = {};
  const order: string[] = [];
  for (const id of clipOrder) {
    const raw = clips[id];
    if (raw?.kind !== "audio" || raw.disabled) continue;
    const sliced = sliceClipForExport(raw as MediaClip, range);
    if (!sliced) continue;
    scoped[id] = sliced;
    order.push(id);
  }

  return { clips: scoped, clipOrder: order, stackOverlaps };
}

/**
 * Trim a clip to its intersection with an export range, carrying position,
 * in-point, fades and envelope across the cut.
 *
 * The envelope needs the most care: the sliced curve gets explicit endpoints
 * interpolated at the cut boundaries, so a clip sliced mid-ramp starts and ends
 * at exactly the value the full curve had there rather than jumping to the
 * nearest surviving point.
 */
export function sliceClipForExport(
  clip: MediaClip,
  range: { start: number; end: number },
): MediaClip | null {
  const clipEnd = clip.start + clip.duration;
  if (clipEnd <= range.start || clip.start >= range.end) return null;

  const overlapStart = Math.max(clip.start, range.start);
  const overlapEnd = Math.min(clipEnd, range.end);
  const trimStart = overlapStart - clip.start;
  const trimEnd = clipEnd - overlapEnd;
  const newDuration = overlapEnd - overlapStart;
  if (newDuration <= 0) return null;

  const speed = clampSpeed(clip.speed ?? 1);
  const newInPoint = clip.inPoint + trimStart * speed;

  let fadeIn = clip.fadeIn;
  fadeIn = trimStart >= fadeIn ? 0 : fadeIn - trimStart;

  let fadeOut = clip.fadeOut;
  fadeOut = trimEnd >= fadeOut ? 0 : fadeOut - trimEnd;

  let volumePoints = clip.volumePoints;
  if (volumePoints && volumePoints.length > 0) {
    const sorted = [...volumePoints].sort((a, b) => a.time - b.time);
    const sliced: EnvelopePoint[] = [
      { time: 0, value: interpolateEnvelope(sorted, trimStart) },
    ];
    for (const p of sorted) {
      if (p.time > trimStart && p.time < trimStart + newDuration) {
        sliced.push({ time: p.time - trimStart, value: p.value });
      }
    }
    const endVal = interpolateEnvelope(sorted, trimStart + newDuration);
    const tail = sliced[sliced.length - 1];
    if (tail !== undefined && tail.time < newDuration - 1e-6) {
      sliced.push({ time: newDuration, value: endVal });
    } else if (sliced.length > 0) {
      sliced[sliced.length - 1] = { time: newDuration, value: endVal };
    }
    volumePoints = sliced;
  }

  return {
    ...clip,
    start: overlapStart,
    duration: newDuration,
    inPoint: newInPoint,
    fadeIn,
    fadeOut,
    ...(volumePoints !== undefined ? { volumePoints } : {}),
  };
}

// ── Scheduling ──────────────────────────────────────────────────────────────

/**
 * Stable key describing everything that affects a clip's gain curve.
 *
 * The scheduler reschedules automation only when this changes. Without it,
 * every animation frame would tear down and rebuild the ramp on every playing
 * clip, which both costs real time and audibly stutters the fade.
 */
export function clipGainSignature(clip: Clip, track: Track, overlapCtx?: OverlapContext): string {
  const points = clip.volumePoints ? [...clip.volumePoints].sort((a, b) => a.time - b.time) : null;
  return JSON.stringify({
    volume: clip.volume ?? 1,
    fadeIn: clip.fadeIn,
    fadeOut: clip.fadeOut,
    duration: clip.duration,
    points,
    trackVolume: track.volume ?? 1,
    overlaps: overlapCtx ? trackOverlapSignature(clip.trackId, overlapCtx) : "",
  });
}

/**
 * Schedule gain for a clip that is playing live.
 *
 * Aligns the audio context clock so the clip's `localTime` lands on `audioNow`,
 * then programs the same automation the offline renderer would.
 *
 * The `lt > 0.05` branch is load-bearing and was earned the hard way: scheduling
 * a full curve from a `ctxStart` in the past — which is what starting playback
 * mid-clip implies — can throw inside Web Audio. That exception propagated out
 * of the clock's tick subscriber and froze the playhead while the media
 * elements kept going. Starting mid-clip therefore sets a single value and
 * leaves automation alone.
 */
export function scheduleLiveClipGain(
  gain: GainNode,
  clip: Clip,
  track: Track,
  audioNow: number,
  localTime: number,
  overlapCtx?: OverlapContext,
): void {
  if (clip.duration <= 0) {
    gain.gain.cancelScheduledValues(audioNow);
    gain.gain.setValueAtTime(0, audioNow);
    return;
  }

  const lt = Math.max(0, Math.min(clip.duration, localTime));
  gain.gain.cancelScheduledValues(audioNow);

  if (lt > 0.05) {
    gain.gain.setValueAtTime(clipGainAt(clip, lt, overlapCtx), audioNow);
    return;
  }

  scheduleClipGainInternal(gain, clip, track, audioNow - lt, overlapCtx, false);
}

/** Schedule gain on an offline render node. Includes the track fader. */
export function scheduleClipGain(
  gain: GainNode,
  clip: Clip,
  track: Track,
  ctxStart: number,
  overlapCtx?: OverlapContext,
): void {
  scheduleClipGainInternal(gain, clip, track, ctxStart, overlapCtx, true);
}

/** Resolution of the sampled curve used when an overlap makes gain non-piecewise-linear. */
const GAIN_CURVE_HZ = 30;

/**
 * Crossfaded gain is an equal-power cosine, which no sequence of linear ramps
 * reproduces. When a clip overlaps a sibling we sample the true curve and hand
 * Web Audio the whole thing; everywhere else the piecewise-linear path below is
 * both exact and far cheaper.
 */
function scheduleClipGainCurve(
  gain: GainNode,
  clip: Clip,
  track: Track,
  ctxStart: number,
  overlapCtx: OverlapContext,
  includeTrackVolume: boolean,
): void {
  const samples = Math.max(2, Math.ceil(clip.duration * GAIN_CURVE_HZ) + 1);
  const values = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const lt = Math.min(clip.duration, (i / (samples - 1)) * clip.duration);
    values[i] = includeTrackVolume
      ? mixGainAt(clip, track, lt, overlapCtx)
      : clipGainAt(clip, lt, overlapCtx);
  }
  gain.gain.setValueCurveAtTime(values, ctxStart, Math.max(0.001, clip.duration));
}

function scheduleClipGainInternal(
  gain: GainNode,
  clip: Clip,
  track: Track,
  ctxStart: number,
  overlapCtx: OverlapContext | undefined,
  includeTrackVolume: boolean,
): void {
  /* The sampled-curve path exists only to reproduce a cosine. With crossfades
     off the curve is exactly piecewise-linear, so taking it there would swap an
     exact schedule for a 30 Hz approximation of itself. */
  if (
    overlapCtx &&
    clip.kind === "audio" &&
    crossfadesEnabled(overlapCtx) &&
    clipHasOverlap(clip as MediaClip, overlapCtx)
  ) {
    scheduleClipGainCurve(gain, clip, track, ctxStart, overlapCtx, includeTrackVolume);
    return;
  }

  const trackVol = includeTrackVolume ? Math.max(0, track.volume ?? 1) : 1;
  const points = clip.volumePoints;

  if (points && points.length > 0) {
    const sorted = [...points].sort((a, b) => a.time - b.time);
    const baseVol = Math.max(0, (clip.volume ?? 1) * trackVol);
    const head = sorted[0];
    if (head === undefined) return;

    if (head.time > 0) {
      gain.gain.setValueAtTime(baseVol * head.value, ctxStart);
    }

    for (let i = 0; i < sorted.length; i++) {
      const pt = sorted[i];
      if (pt === undefined) continue;
      gain.gain.setValueAtTime(baseVol * pt.value, ctxStart + pt.time);
      const next = sorted[i + 1];
      if (next !== undefined) {
        gain.gain.linearRampToValueAtTime(baseVol * next.value, ctxStart + next.time);
      }
    }

    // Hold the last written value to the end of the clip, so a curve that
    // stops early doesn't leave the node at an undefined level.
    const last = sorted[sorted.length - 1];
    if (last !== undefined && last.time < clip.duration - 1e-6) {
      const hold = baseVol * last.value;
      gain.gain.setValueAtTime(hold, ctxStart + last.time);
      gain.gain.setValueAtTime(hold, ctxStart + clip.duration);
    }
    return;
  }

  const vol = Math.max(0, (clip.volume ?? 1) * trackVol);

  if (clip.fadeIn > 0.005) {
    gain.gain.setValueAtTime(0, ctxStart);
    gain.gain.linearRampToValueAtTime(vol, ctxStart + clip.fadeIn);
  } else {
    gain.gain.setValueAtTime(vol, ctxStart);
  }

  if (clip.fadeOut > 0.005) {
    const fadeStart = ctxStart + clip.duration - clip.fadeOut;
    gain.gain.setValueAtTime(vol, fadeStart);
    gain.gain.linearRampToValueAtTime(0, ctxStart + clip.duration);
  }
}
