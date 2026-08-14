/**
 * The Web Audio routing graph.
 *
 *   clip.gain ─┐
 *   clip.gain ─┼─► track[id].gain ─► track[id].analyser ─► master ─► analyser ─► out
 *   clip.gain ─┘
 *
 * Each track's analyser sits **in series** rather than as a tap, so it observes
 * the post-fader signal exactly as it leaves the track. A meter fed from a tap
 * before the fader shows the file's level; this one shows what the listener
 * actually hears, which is what a meter is for.
 *
 * Two invariants this class exists to hold:
 *
 *  1. **One `AudioContext` per graph.** Browsers cap how many a tab may open,
 *     and `createMediaElementSource` throws if called twice for the same
 *     element — so accidental duplication is not a leak, it is a crash. React
 *     Strict Mode double-invoking effects in development makes that a routine
 *     hazard rather than a theoretical one, which is why the source nodes are
 *     cached in a `WeakMap` keyed by element.
 *
 *  2. **The context is created lazily.** Constructing this class touches
 *     nothing; the context appears on first use. That is what lets a host
 *     build its engine during a server render and only reach for Web Audio
 *     once playback is actually requested in a browser.
 */

/** Lets a host supply its own context — an existing one, or an OfflineAudioContext. */
export type AudioGraphOptions = {
  context?: BaseAudioContext | undefined;
};

type TrackBus = {
  gain: GainNode;
  analyser: AnalyserNode;
};

const ANALYSER_FFT = 1024;
const ANALYSER_SMOOTHING = 0.4;
/** Time constant for fader moves — short enough to feel instant, long enough not to click. */
const FADER_RAMP_S = 0.005;

export class AudioGraph {
  private _ctx: BaseAudioContext | null;
  /** Whether this graph created the context, and may therefore close it. */
  private _ownsContext: boolean;
  private _master: GainNode | null = null;
  private _analyser: AnalyserNode | null = null;
  private _resumed = false;
  private _trackBuses = new Map<string, TrackBus>();
  private _sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

  constructor(opts: AudioGraphOptions = {}) {
    this._ctx = opts.context ?? null;
    this._ownsContext = false;
  }

  /** The context, created on first use. Throws only where Web Audio is absent. */
  context(): BaseAudioContext {
    if (this._ctx) return this._ctx;

    const Ctor =
      typeof globalThis !== "undefined"
        ? ((globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
          (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;

    if (!Ctor) throw new Error("[playmix] Web Audio is unavailable in this environment.");
    this._ctx = new Ctor();
    this._ownsContext = true;
    return this._ctx;
  }

  /** Current context time. Convenience for schedulers. */
  now(): number {
    return this.context().currentTime;
  }

  /**
   * Resume the context. Browsers start it suspended and silently discard sound
   * until a user gesture resumes it, so this must be called from a real event
   * handler — a click, a keypress — and not from an effect on mount.
   */
  async ensureRunning(): Promise<void> {
    const ctx = this.context();
    if (ctx.state === "suspended" && "resume" in ctx) {
      try {
        await (ctx as AudioContext).resume();
        this._resumed = true;
      } catch {
        /* A gesture that didn't count. The next one will retry. */
      }
      return;
    }
    this._resumed = true;
  }

  isResumed(): boolean {
    return this._resumed && this.context().state === "running";
  }

  /**
   * The source node for an element, created once and reused forever.
   * `createMediaElementSource` may only be called once per element; a second
   * call throws, so this cache is a correctness requirement, not an optimisation.
   */
  sourceFor(el: HTMLMediaElement): MediaElementAudioSourceNode {
    const cached = this._sources.get(el);
    if (cached) return cached;
    const ctx = this.context() as AudioContext;
    const node = ctx.createMediaElementSource(el);
    this._sources.set(el, node);
    return node;
  }

  // ── Master ───────────────────────────────────────────────────────────────

  master(): GainNode {
    if (this._master) return this._master;
    const ctx = this.context();
    const master = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
    master.connect(analyser);
    analyser.connect(ctx.destination);
    this._master = master;
    this._analyser = analyser;
    return master;
  }

  /** The master analyser. Always live, so the first play meters without warm-up. */
  analyser(): AnalyserNode {
    this.master();
    if (!this._analyser) throw new Error("[playmix] master analyser missing");
    return this._analyser;
  }

  setMasterGain(value: number): void {
    this.master().gain.setTargetAtTime(Math.max(0, value), this.now(), FADER_RAMP_S);
  }

  // ── Track buses ──────────────────────────────────────────────────────────

  private _bus(trackId: string): TrackBus {
    let bus = this._trackBuses.get(trackId);
    if (bus) return bus;

    const ctx = this.context();
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = ANALYSER_FFT;
    analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
    gain.connect(analyser);
    analyser.connect(this.master());
    bus = { gain, analyser };
    this._trackBuses.set(trackId, bus);
    return bus;
  }

  /** A track's input node. Clips connect their own gain into this. */
  trackBus(trackId: string): GainNode {
    return this._bus(trackId).gain;
  }

  /** The analyser immediately after a track's fader. Read this for metering. */
  trackAnalyser(trackId: string): AnalyserNode {
    return this._bus(trackId).analyser;
  }

  setTrackGain(trackId: string, value: number): void {
    this._bus(trackId).gain.gain.setTargetAtTime(
      Math.max(0, value),
      this.now(),
      FADER_RAMP_S,
    );
  }

  /** Push every track's fader value into the live graph. */
  syncTrackBuses(tracks: ReadonlyArray<{ id: string; volume?: number }>): void {
    for (const tr of tracks) this.setTrackGain(tr.id, tr.volume ?? 1);
  }

  /** Drop a track's bus. Disconnects every clip currently routed into it. */
  releaseTrackBus(trackId: string): void {
    const bus = this._trackBuses.get(trackId);
    if (!bus) return;
    disconnectQuietly(bus.gain);
    disconnectQuietly(bus.analyser);
    this._trackBuses.delete(trackId);
  }

  /**
   * Tear the graph down.
   *
   * A context this graph created is closed; one handed in by the host is left
   * alone, since the host may still be using it. Closing matters more than it
   * sounds: browsers cap how many `AudioContext`s a tab may hold open — Chrome
   * historically at six — so a host that builds and disposes engines across
   * route changes, or under React Strict Mode, runs out and then cannot play
   * anything at all.
   *
   * `close()` is asynchronous and deliberately not awaited. Callers dispose
   * from teardown paths that cannot be async — `useEffect` cleanup,
   * `disconnectedCallback` — and nothing here depends on the close completing.
   */
  dispose(): void {
    for (const id of [...this._trackBuses.keys()]) this.releaseTrackBus(id);
    if (this._master) disconnectQuietly(this._master);
    if (this._analyser) disconnectQuietly(this._analyser);
    this._master = null;
    this._analyser = null;
    this._resumed = false;

    const ctx = this._ctx;
    if (ctx && this._ownsContext) {
      /* Nulled first: a later `context()` builds a fresh one rather than
         handing out a closing context whose nodes would never sound. */
      this._ctx = null;
      this._ownsContext = false;
      if ("close" in ctx && ctx.state !== "closed") {
        void (ctx as AudioContext).close().catch(() => {
          /* Already closing, or closed by the host. Nothing left to do. */
        });
      }
    }
  }
}

/**
 * Disconnecting a node that is already disconnected throws in some engines and
 * is a no-op in others. Since every call site here is teardown, where the only
 * sane response to a failure is to carry on, the difference is not worth
 * branching on.
 */
function disconnectQuietly(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    /* already detached */
  }
}

export function createAudioGraph(opts: AudioGraphOptions = {}): AudioGraph {
  return new AudioGraph(opts);
}
