import type { EnvelopePoint } from "../types.ts";

/**
 * Volume at a point in time, linearly interpolated between automation points.
 *
 * Points are assumed sorted by time; callers that mutate an envelope sort on
 * write rather than on every read, because this runs inside the gain-curve
 * loop at 30 Hz per clip and a sort there would dominate the cost.
 *
 * Outside the point range the curve holds flat at the nearest endpoint rather
 * than extrapolating — extrapolating a two-point ramp past its end reaches
 * silence, or clipping, for reasons no one editing the clip intended.
 */
export function interpolateEnvelope(points: EnvelopePoint[], time: number): number {
  if (points.length === 0) return 1;

  const first = points[0];
  if (first === undefined) return 1;
  if (points.length === 1) return first.value;
  if (time <= first.time) return first.value;

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    if (p1 === undefined || p2 === undefined) continue;

    if (time >= p1.time && time <= p2.time) {
      const span = p2.time - p1.time;
      if (span === 0) return p2.value;
      const factor = (time - p1.time) / span;
      return p1.value + (p2.value - p1.value) * factor;
    }
  }

  const last = points[points.length - 1];
  return last === undefined ? 1 : last.value;
}
