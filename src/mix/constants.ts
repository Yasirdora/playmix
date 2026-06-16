/**
 * Constants shared by the live scheduler and the offline renderer.
 *
 * These live in one place for the same reason the gain math does: if preview
 * clamps speed to [0.25, 4] and export clamps it to something else, a clip
 * plays at one rate and renders at another, and the bug surfaces only in the
 * exported file — which is the worst place to find it.
 */

/** Render sample rate for offline mixdown. */
export const SAMPLE_RATE = 48_000;

/** Playback and export must agree on speed bounds. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;

/** Effective playback rate for a clip, clamped to the engine's bounds. */
export function clampSpeed(speed: number): number {
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, speed));
}
