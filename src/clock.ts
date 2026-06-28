/**
 * The master clock.
 *
 * Time semantics
 * --------------
 * `time()` is project time in seconds. While playing it is *recomputed* every
 * frame as `playStartTime + (now - wallStart) / 1000` rather than accumulated
 * as `time += dt`. The difference matters: an accumulating clock turns every
 * dropped frame into permanent error, so a timeline that stutters once is
 * offset from its own audio for the rest of the take. Recomputing costs a
 * dropped frame exactly one frame.
 *
 * Drift correction
 * ----------------
 * A decoded video frame is the ground truth for where playback actually is, so
 * `syncTo()` lets a media element pull the clock toward itself (typically from
 * `requestVideoFrameCallback`). Corrections are graduated on purpose: a small
 * drift is absorbed into `playStartTime` so subsequent ticks converge and the
 * playhead never visibly jumps, while a large one — a buffer stall, a seek —
 * is honored immediately, because pretending a quarter-second gap doesn't
 * exist is worse than showing it.
 *
 * Injectable time
 * ---------------
 * `performance.now` and `requestAnimationFrame` arrive through a `TimeSource`
 * rather than being called directly. That is what makes playback testable
 * without a browser and without waiting in real time: a test drives frames
 * explicitly and asserts on exact values, instead of polling a wall-clock
 * deadline and hoping. It is also what lets the offline renderer and the live
 * scheduler be checked against each other deterministically.
 */

/** Where the clock gets time and frames from. Swap it in tests. */
export type TimeSource = {
  /** Monotonic milliseconds. */
  now(): number;
  /** Schedule a callback for the next frame. Returns a cancellation handle. */
  requestFrame(cb: () => void): number;
  cancelFrame(handle: number): void;
};

/** The real browser clock. */
export function browserTimeSource(): TimeSource {
  return {
    now: () => performance.now(),
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (h) => cancelAnimationFrame(h),
  };
}

export type ClockOptions = {
  /** Defaults to the browser's clock. */
  timeSource?: TimeSource | undefined;
  /**
   * Re-arm the frame loop when the document becomes visible again. Browsers
   * throttle `requestAnimationFrame` to zero in background tabs, and some stop
   * delivering it entirely; without this the playhead is frozen on return
   * while the media elements have carried on. Defaults to true in a document.
   */
  reviveOnVisible?: boolean | undefined;
};

type Listener = () => void;

/** Drift above this is a stall or a seek: snap rather than converge. */
const HARD_SYNC_S = 0.25;
/** Drift below this is decode jitter: ignore it entirely. */
const IGNORE_SYNC_S = 0.015;
/** Fraction of a small drift absorbed per correction. */
const CONVERGE_RATE = 0.2;

export class Clock {
  private _time = 0;
  private _playing = false;
  private _wallStart = 0;
  private _playStartTime = 0;
  private _max = Number.POSITIVE_INFINITY;
  private _frame = 0;
  private _listeners = new Set<Listener>();
  private _playingListeners = new Set<Listener>();
  private _onEnd: (() => void) | null = null;
  private _loopEnabled = false;
  private _loopIn = 0;
  private _loopOut = 0;
  private _src: TimeSource;
  private _detachVisibility: (() => void) | null = null;

  constructor(opts: ClockOptions = {}) {
    this._src = opts.timeSource ?? browserTimeSource();

    const wantRevive = opts.reviveOnVisible ?? true;
    if (wantRevive && typeof document !== "undefined") {
      const onVisible = (): void => {
        if (!document.hidden) this._kickFrame();
      };
      document.addEventListener("visibilitychange", onVisible);
      this._detachVisibility = () =>
        document.removeEventListener("visibilitychange", onVisible);
    }
  }

  // ── reads ────────────────────────────────────────────────────────────────

  time = (): number => this._time;
  playing = (): boolean => this._playing;
  max = (): number => this._max;

  // ── transport ────────────────────────────────────────────────────────────

  setMax(max: number): void {
    this._max = Math.max(0, max);
    if (this._time > this._max) this.seek(this._max);
  }

  setLoop(enabled: boolean, loopIn: number, loopOut: number): void {
    this._loopEnabled = enabled;
    this._loopIn = loopIn;
    this._loopOut = loopOut;
  }

  setOnEnd(cb: (() => void) | null): void {
    this._onEnd = cb;
  }

  play(): void {
    if (this._playing) return;
    // Playing from the very end is a replay request, not a no-op.
    if (this._time >= this._max) this._time = 0;
    this._playing = true;
    this._wallStart = this._src.now();
    this._playStartTime = this._time;
    try {
      this._frame = this._src.requestFrame(this._tick);
    } catch (err) {
      /* Rolling back matters more than it looks. The realistic way this throws
         is calling play() where there are no animation frames — a server
         render, or a Worker. Leaving `_playing` true there would strand the
         clock in a state where it believes it is running, and the next pause()
         or dispose() would throw again while trying to cancel a frame that was
         never scheduled. */
      this._playing = false;
      this._frame = 0;
      throw err;
    }
    this._notify();
    this._notifyPlaying();
  }

  pause(): void {
    if (!this._playing) return;
    this._playing = false;
    this._cancelFrame();
    this._notify();
    this._notifyPlaying();
  }

  toggle(): void {
    if (this._playing) this.pause();
    else this.play();
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(this._max, t));
    this._time = clamped;
    if (this._playing) {
      this._wallStart = this._src.now();
      this._playStartTime = clamped;
    }
    this._notify();
  }

  /**
   * Anchor the clock to a decoded frame's real position. No-op while paused,
   * because a paused element's `currentTime` reflects seeking rather than
   * playback and would fight the playhead the user is dragging.
   */
  syncTo(projectTime: number): void {
    if (!this._playing) return;
    const drift = projectTime - this._time;
    const abs = Math.abs(drift);

    if (abs > HARD_SYNC_S) {
      this._time = projectTime;
      this._wallStart = this._src.now();
      this._playStartTime = projectTime;
      this._notify();
    } else if (abs > IGNORE_SYNC_S) {
      this._playStartTime += drift * CONVERGE_RATE;
    }
  }

  // ── subscription ─────────────────────────────────────────────────────────

  /** Notified every frame while playing, and once per pause or seek. */
  subscribe = (cb: Listener): (() => void) => {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  };

  /**
   * Notified only on play/pause transitions. Anything that renders a play
   * button belongs here rather than on `subscribe`, so it doesn't re-render at
   * frame rate to learn something that changed twice.
   */
  subscribePlaying = (cb: Listener): (() => void) => {
    this._playingListeners.add(cb);
    return () => {
      this._playingListeners.delete(cb);
    };
  };

  /**
   * Stable getters returning primitives, so `useSyncExternalStore` can compare
   * with `Object.is` and re-render only on real change.
   */
  getTimeSnapshot = (): number => this._time;
  getPlayingSnapshot = (): boolean => this._playing;

  dispose(): void {
    this.pause();
    this._listeners.clear();
    this._playingListeners.clear();
    this._onEnd = null;
    this._detachVisibility?.();
    this._detachVisibility = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private _tick = (): void => {
    if (!this._playing) return;
    try {
      const now = this._src.now();
      let t = this._playStartTime + (now - this._wallStart) / 1000;

      if (this._loopEnabled && this._loopIn < this._loopOut && t >= this._loopOut) {
        this._time = this._loopIn;
        this._wallStart = now;
        this._playStartTime = this._loopIn;
        this._notify();
        return;
      }

      if (t >= this._max) {
        t = this._max;
        this._time = t;
        this._playing = false;
        this._notify();
        this._notifyPlaying();
        this._onEnd?.();
        return;
      }

      this._time = t;
      this._notify();
    } finally {
      /* Rescheduling from `finally` is deliberate. A subscriber that throws —
         Web Audio scheduling is the realistic case — must not be able to kill
         the frame loop, which would freeze the playhead while every media
         element kept playing: the most confusing failure this engine can
         produce. */
      this._frame = this._playing ? this._src.requestFrame(this._tick) : 0;
    }
  };

  /**
   * Cancel any scheduled frame. Skips the call entirely when nothing is
   * outstanding, so tearing down a clock that never ran does not require the
   * platform to provide `cancelAnimationFrame` at all.
   */
  private _cancelFrame(): void {
    if (this._frame === 0) return;
    const handle = this._frame;
    this._frame = 0;
    this._src.cancelFrame(handle);
  }

  private _kickFrame(): void {
    if (!this._playing) return;
    this._cancelFrame();
    this._frame = this._src.requestFrame(this._tick);
  }

  private _notify(): void {
    for (const l of this._listeners) {
      try {
        l();
      } catch (err) {
        console.error("[playmix] clock subscriber threw:", err);
      }
    }
  }

  private _notifyPlaying(): void {
    for (const l of this._playingListeners) {
      try {
        l();
      } catch (err) {
        console.error("[playmix] clock play-state subscriber threw:", err);
      }
    }
  }
}

export function createClock(opts: ClockOptions = {}): Clock {
  return new Clock(opts);
}

/**
 * Snap a project time to the nearest frame boundary.
 *
 * Editing operations quantize; playback does not. A cut placed between two
 * frames cannot be represented in the exported file, so the edit lands on a
 * boundary — but forcing the playhead onto boundaries would make playback
 * visibly step rather than glide.
 */
export function quantizeToFrame(t: number, fps: number): number {
  if (fps <= 0) return t;
  return Math.round(t * fps) / fps;
}
