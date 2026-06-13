import type { Clip, MediaClip } from "../types.ts";

export type OverlapContext = {
  clips: Record<string, Clip>;
  clipOrder: string[];
  /** Editor stack-overlaps mode (placement only; mix always crossfades transitions). */
  stackOverlaps?: boolean;
};

export type OverlapRegion = {
  /** Seconds from the start of `clip`. */
  localStart: number;
  localEnd: number;
  /** Fade out when a later clip overlaps our tail; fade in when we overlap a earlier clip. */
  kind: "out" | "in";
};

export type OverlapKind = "transition" | "nested";

const MIN_OVERLAP_S = 0.001;

export type CrossfadeBand = {
  key: string;
  trackId: string;
  /** Timeline seconds — overlap interval [start, end]. */
  start: number;
  end: number;
};

function clipEnd(c: { start: number; duration: number }): number {
  return c.start + c.duration;
}

/** True when two clips share any same-track time range. */
export function clipsOverlap(a: MediaClip, b: MediaClip): boolean {
  return Math.max(a.start, b.start) < Math.min(clipEnd(a), clipEnd(b)) - MIN_OVERLAP_S;
}

/**
 * Classify how two overlapping clips should mix.
 *
 * • **transition** — tail-into-head (or partial) overlap → equal-power crossfade.
 * • **nested** — the shorter clip sits fully inside the longer one → hard cut;
 *   the inner clip replaces the bed for its duration with no fade.
 */
export function classifyOverlapPair(a: MediaClip, b: MediaClip): OverlapKind | null {
  if (!clipsOverlap(a, b)) return null;

  const aEnd = clipEnd(a);
  const bEnd = clipEnd(b);
  const eps = MIN_OVERLAP_S;

  const bInsideA = b.duration < a.duration - eps && b.start >= a.start - eps && bEnd <= aEnd + eps;
  const aInsideB = a.duration < b.duration - eps && a.start >= b.start - eps && aEnd <= bEnd + eps;

  if (bInsideA || aInsideB) return "nested";
  return "transition";
}

/** True when `inner` is fully contained in `outer` on the timeline. */
export function isNestedInside(inner: MediaClip, outer: MediaClip): boolean {
  const eps = MIN_OVERLAP_S;
  return (
    inner.duration < outer.duration - eps &&
    inner.start >= outer.start - eps &&
    clipEnd(inner) <= clipEnd(outer) + eps
  );
}

/** Unique same-track transition overlaps for timeline crossfade chrome. */
export function collectCrossfadeBands(trackId: string, ctx: OverlapContext): CrossfadeBand[] {
  if (!ctx.stackOverlaps) return [];

  const onTrack: MediaClip[] = [];
  for (const id of ctx.clipOrder) {
    const c = ctx.clips[id];
    if (c?.kind !== "audio" || c.disabled || c.trackId !== trackId) continue;
    onTrack.push(c as MediaClip);
  }

  const bands: CrossfadeBand[] = [];
  for (let i = 0; i < onTrack.length; i++) {
    for (let j = i + 1; j < onTrack.length; j++) {
      const a = onTrack[i];
      const b = onTrack[j];
      if (!a || !b) continue;
      if (classifyOverlapPair(a, b) !== "transition") continue;

      const earlier = a.start <= b.start ? a : b;
      const later = a.start <= b.start ? b : a;

      const overlapStart = later.start;
      const overlapEnd = Math.min(clipEnd(earlier), clipEnd(later));
      const len = overlapEnd - overlapStart;
      if (len < MIN_OVERLAP_S) continue;
      if (later.start >= clipEnd(earlier) - MIN_OVERLAP_S) continue;

      bands.push({
        key: `${earlier.id}:${later.id}:${overlapStart.toFixed(4)}`,
        trackId,
        start: overlapStart,
        end: overlapEnd,
      });
    }
  }

  return bands.sort((a, b) => a.start - b.start);
}

/** Equal-power crossfade multiplier at normalized position p ∈ [0, 1]. */
export function equalPowerCrossfade(kind: "out" | "in", progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  const angle = p * (Math.PI / 2);
  return kind === "out" ? Math.cos(angle) : Math.sin(angle);
}

/** Overlap crossfade regions between `clip` and same-track siblings. */
export function clipOverlapRegions(clip: MediaClip, ctx: OverlapContext): OverlapRegion[] {
  const regions: OverlapRegion[] = [];
  const end = clipEnd(clip);

  for (const id of ctx.clipOrder) {
    if (id === clip.id) continue;
    const sib = ctx.clips[id];
    if (sib?.kind !== "audio" || sib.disabled) continue;
    if (sib.trackId !== clip.trackId) continue;

    const sibEnd = clipEnd(sib);
    const overlapStart = Math.max(clip.start, sib.start);
    const overlapEnd = Math.min(end, sibEnd);
    const overlapLen = overlapEnd - overlapStart;
    if (overlapLen < MIN_OVERLAP_S) continue;

    const localStart = overlapStart - clip.start;
    const localEnd = overlapEnd - clip.start;

    if (sib.start >= clip.start - 1e-6) {
      regions.push({ localStart, localEnd, kind: "out" });
    } else {
      regions.push({ localStart, localEnd, kind: "in" });
    }
  }

  return regions.sort((a, b) => a.localStart - b.localStart);
}

export function crossfadeMultiplier(
  clip: MediaClip,
  localTime: number,
  ctx: OverlapContext,
): number {
  let multiplier = 1;
  const end = clipEnd(clip);

  for (const id of ctx.clipOrder) {
    if (id === clip.id) continue;
    const sib = ctx.clips[id];
    if (sib?.kind !== "audio" || sib.disabled) continue;
    if (sib.trackId !== clip.trackId) continue;

    const sibMedia = sib as MediaClip;
    const overlapStart = Math.max(clip.start, sib.start);
    const overlapEnd = Math.min(end, clipEnd(sibMedia));
    const overlapLen = overlapEnd - overlapStart;
    if (overlapLen < MIN_OVERLAP_S) continue;

    const localStart = overlapStart - clip.start;
    const localEnd = overlapEnd - clip.start;
    const overlapKind = classifyOverlapPair(clip, sibMedia);

    // Nested: half-open [start, end) — bed resumes when the inner clip ends.
    // Transition: closed [start, end] — outgoing tail stays ducked through overlap end.
    const inOverlap =
      overlapKind === "nested"
        ? localTime >= localStart && localTime < localEnd
        : localTime >= localStart && localTime <= localEnd;
    if (!inOverlap) continue;

    if (overlapKind === "nested") {
      multiplier = Math.min(multiplier, isNestedInside(clip, sibMedia) ? 1 : 0);
      continue;
    }

    const kind: OverlapRegion["kind"] = sib.start >= clip.start - 1e-6 ? "out" : "in";
    const progress = (localTime - localStart) / (localEnd - localStart);
    multiplier = Math.min(multiplier, equalPowerCrossfade(kind, progress));
  }
  return multiplier;
}

export function clipHasOverlap(clip: MediaClip, ctx: OverlapContext): boolean {
  return clipOverlapRegions(clip, ctx).length > 0;
}

/** Signature of same-track clip layout — invalidates gain schedule when overlaps change. */
export function trackOverlapSignature(trackId: string, ctx: OverlapContext): string {
  const parts: string[] = [];
  for (const id of ctx.clipOrder) {
    const c = ctx.clips[id];
    if (c?.kind !== "audio" || c.trackId !== trackId) continue;
    parts.push(`${id}:${c.start.toFixed(4)}:${c.duration.toFixed(4)}`);
  }
  return parts.join("|");
}
