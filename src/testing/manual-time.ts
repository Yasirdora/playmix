import type { TimeSource } from "../clock.ts";

/**
 * A clock you drive by hand.
 *
 * Waveform's original clock test played for real and polled
 * `requestAnimationFrame` against a wall-clock deadline. That is honest but it
 * is slow, it cannot assert an exact time, and it is flaky on a loaded CI box —
 * the failure mode being a test that passes on a laptop and fails in a
 * pipeline for reasons unrelated to the code.
 *
 * With this, a test advances time explicitly and asserts on exact values.
 * `advance(500)` means half a second has passed and every frame that would
 * have fired in it has fired.
 */
export class ManualTimeSource implements TimeSource {
  private _now = 0;
  private _next = 1;
  private _pending = new Map<number, () => void>();

  /** Milliseconds per frame when advancing. 60 fps by default. */
  readonly frameMs: number;

  constructor(frameMs = 1000 / 60) {
    this.frameMs = frameMs;
  }

  now = (): number => this._now;

  requestFrame = (cb: () => void): number => {
    const handle = this._next++;
    this._pending.set(handle, cb);
    return handle;
  };

  cancelFrame = (handle: number): void => {
    this._pending.delete(handle);
  };

  /** Fire exactly one frame, moving time forward by one frame interval. */
  tick(): void {
    this._now += this.frameMs;
    const due = [...this._pending.entries()];
    this._pending.clear();
    for (const [, cb] of due) cb();
  }

  /** Advance by `ms`, firing every frame that falls inside it. */
  advance(ms: number): void {
    const until = this._now + ms;
    // Guard against a callback that reschedules forever within one advance.
    let guard = Math.ceil(ms / this.frameMs) + 2;
    while (this._now + this.frameMs <= until && guard-- > 0) this.tick();
    if (this._now < until) this._now = until;
  }

  /** Jump time without firing frames — models a throttled background tab. */
  skip(ms: number): void {
    this._now += ms;
  }

  get pendingFrames(): number {
    return this._pending.size;
  }
}
