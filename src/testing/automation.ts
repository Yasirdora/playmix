/**
 * An `AudioParam` recorder that can be evaluated without a browser.
 *
 * The package's central claim is that the curve programmed onto a live gain
 * node and the curve the offline renderer reads are the same curve. Checking
 * that normally means standing up an `OfflineAudioContext`, rendering, and
 * inspecting samples — which needs a browser, makes the test slow, and buries
 * a modelling error under resampling noise.
 *
 * Instead, this records the automation calls and re-implements the three
 * primitives the scheduler actually uses, so a test can ask "what value did we
 * program at t?" and compare it against `mixGainAt(clip, track, t)` directly.
 * A discrepancy points at the mix model, not at an audio graph.
 *
 * It is exported rather than kept in `test/` because a host that extends the
 * scheduler wants the same check, for the same reason.
 */

type Event =
  | { kind: "set"; time: number; value: number }
  | { kind: "ramp"; time: number; value: number }
  | { kind: "curve"; time: number; duration: number; values: Float32Array };

export class RecordingParam {
  private _events: Event[] = [];

  /** Automation events in scheduled order. Useful for asserting shape, not just values. */
  get events(): ReadonlyArray<Readonly<Event>> {
    return this._events;
  }

  setValueAtTime(value: number, time: number): RecordingParam {
    this._events.push({ kind: "set", time, value });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): RecordingParam {
    this._events.push({ kind: "ramp", time, value });
    return this;
  }

  setValueCurveAtTime(values: Float32Array, time: number, duration: number): RecordingParam {
    this._events.push({ kind: "curve", time, duration, values });
    return this;
  }

  cancelScheduledValues(time: number): RecordingParam {
    this._events = this._events.filter((e) => e.time < time);
    return this;
  }

  /**
   * The value this automation holds at `t`, following Web Audio's rules: a
   * `set` holds until the next event, a `ramp` interpolates linearly from
   * whatever the previous event left behind, and a curve interpolates across
   * its own samples.
   */
  valueAt(t: number): number {
    const sorted = [...this._events].sort((a, b) => a.time - b.time);
    if (sorted.length === 0) return 1;

    const curve = sorted.find(
      (e): e is Extract<Event, { kind: "curve" }> =>
        e.kind === "curve" && t >= e.time && t <= e.time + e.duration,
    );
    if (curve) return sampleCurve(curve.values, (t - curve.time) / curve.duration);

    let prev: Event | undefined;
    let next: Event | undefined;
    for (const e of sorted) {
      if (e.time <= t) prev = e;
      else {
        next = e;
        break;
      }
    }

    const first = sorted[0];
    if (prev === undefined) return first === undefined ? 1 : valueOf(first);

    // A ramp interpolates from the previous event's value to its own.
    if (next?.kind === "ramp") {
      const span = next.time - prev.time;
      if (span <= 0) return next.value;
      const f = (t - prev.time) / span;
      return valueOf(prev) + (next.value - valueOf(prev)) * f;
    }

    return valueOf(prev);
  }
}

function valueOf(e: Event): number {
  return e.kind === "curve" ? (e.values[e.values.length - 1] ?? 0) : e.value;
}

function sampleCurve(values: Float32Array, progress: number): number {
  const n = values.length;
  if (n === 0) return 0;
  if (n === 1) return values[0] ?? 0;
  const p = Math.max(0, Math.min(1, progress));
  const pos = p * (n - 1);
  const i = Math.floor(pos);
  const lo = values[i] ?? 0;
  const hi = values[Math.min(n - 1, i + 1)] ?? lo;
  return lo + (hi - lo) * (pos - i);
}

/**
 * Stands in for a `GainNode` wherever the scheduler only touches `.gain`.
 * Structurally compatible at the call sites the scheduler uses; cast at the
 * boundary since the real type carries the whole `AudioNode` surface.
 */
export class RecordingGainNode {
  readonly gain = new RecordingParam();
}

/** Cast helper that keeps the `as unknown as GainNode` noise out of tests. */
export function asGainNode(node: RecordingGainNode): GainNode {
  return node as unknown as GainNode;
}
