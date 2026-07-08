/**
 * Per-clip cache of a media element and its gain node.
 *
 * **Per clip, not per asset.** Two clips can reference the same file at
 * different points on the timeline, and may overlap. Sharing one element
 * between them would mean sharing one playback head, so the second clip would
 * drag the first off its own position. One element per clip is the only
 * arrangement where overlapping uses of a file can both be correct.
 *
 * **Routed through Web Audio, not element volume.** `HTMLMediaElement.volume`
 * is clamped to [0, 1] by spec, so a 150% clip is unrepresentable on the
 * element. Everything audible therefore goes through a `GainNode`, which also
 * gives the scheduler ramps to program instead of stepped volume writes.
 *
 * **Routing is lazy.** Creating a `MediaElementAudioSourceNode` permanently
 * captures an element's output — after that, the element's own audio no longer
 * reaches the speakers except through the graph. Elements that will never make
 * sound (a video on a muted track, a detached-audio clip) are left alone
 * instead.
 */

import type { AudioGraph } from "./audio-graph.ts";

export type PoolKind = "video" | "audio";

export type PoolEntry = {
  kind: PoolKind;
  el: HTMLMediaElement;
  /** The src as handed in, so comparisons don't fight the browser's URL resolution. */
  originalSrc: string;
  gain: GainNode | null;
  source: MediaElementAudioSourceNode | null;
  /** Track this entry's audio currently feeds, or null when unrouted. */
  routedTrackId: string | null;
  ready: boolean;
  /** Timestamp of the last hard `currentTime` write, used to rate-limit seeks. */
  lastSeekAt: number;
};

/** Time constant for instantaneous gain writes — smooths the step into a glide. */
const GAIN_RAMP_S = 0.005;

export class MediaPool {
  private _entries = new Map<string, PoolEntry>();
  private _graph: AudioGraph;

  constructor(graph: AudioGraph) {
    this._graph = graph;
  }

  /**
   * The entry for a clip, created on first request. Returns the same instance
   * for the life of the clip unless its kind or source changed, in which case
   * the old element is torn down first — reusing it would leave the previous
   * file's decoded data attached to the new clip.
   */
  acquire(clipId: string, kind: PoolKind, src: string): PoolEntry {
    const existing = this._entries.get(clipId);
    if (existing && existing.kind === kind && existing.originalSrc === src) return existing;
    if (existing) this.release(clipId);

    const entry = makeEntry(kind, src);
    this._entries.set(clipId, entry);
    return entry;
  }

  /**
   * Route an entry's audio into a track bus, or to master when no track is
   * given. Re-routing an already-connected entry moves its existing gain node
   * rather than building a new source, because a source node cannot be created
   * twice for one element.
   */
  attachAudio(entry: PoolEntry, trackId?: string): void {
    const target = trackId ?? null;
    if (entry.gain && entry.source && entry.routedTrackId === target) return;

    if (entry.gain && entry.source) {
      disconnectQuietly(entry.gain);
      entry.gain.connect(this._destinationFor(target));
      entry.routedTrackId = target;
      return;
    }

    // Video elements are muted until routed, so that an unrouted one stays
    // silent rather than playing through the element's own output.
    if (entry.kind === "video") entry.el.muted = false;

    const ctx = this._graph.context();
    entry.source = this._graph.sourceFor(entry.el);
    entry.gain = ctx.createGain();
    entry.source.connect(entry.gain).connect(this._destinationFor(target));
    entry.routedTrackId = target;
  }

  /** Silence an entry by detaching its gain. The source node is deliberately kept. */
  detachAudio(entry: PoolEntry): void {
    if (!entry.gain) return;
    disconnectQuietly(entry.gain);
    entry.gain = null;
    entry.routedTrackId = null;

    /* The source node is not discarded. The spec allows only one per element
       for its entire lifetime, so throwing this away would make the clip
       permanently unroutable; disconnecting it is enough to stop the sound. */
    if (entry.source) disconnectQuietly(entry.source);

    if (entry.kind === "video") entry.el.muted = true;
  }

  /** Set gain immediately. Honours values above 1. */
  setGain(entry: PoolEntry, value: number): void {
    if (!entry.gain) return;
    entry.gain.gain.setTargetAtTime(Math.max(0, value), this._graph.now(), GAIN_RAMP_S);
  }

  /** Ramp gain linearly from `from` to `to`, starting now. */
  rampGain(entry: PoolEntry, from: number, to: number, seconds: number): void {
    if (!entry.gain) return;
    const now = this._graph.now();
    const g = entry.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0, from), now);
    g.linearRampToValueAtTime(Math.max(0, to), now + Math.max(0.001, seconds));
  }

  get(clipId: string): PoolEntry | undefined {
    return this._entries.get(clipId);
  }

  /** Free a clip's element and audio nodes. */
  release(clipId: string): void {
    const entry = this._entries.get(clipId);
    if (!entry) return;

    try {
      entry.el.pause();
    } catch {
      /* the element may never have loaded */
    }
    this.detachAudio(entry);

    /* Clearing `src` and calling load() is what actually releases the decoded
       buffers. Dropping the reference alone leaves them held until GC, which on
       a long timeline is enough memory to matter. */
    entry.el.removeAttribute("src");
    try {
      entry.el.load();
    } catch {
      /* nothing to unload */
    }
    this._entries.delete(clipId);
  }

  /** Release every entry whose clip is no longer on the timeline. */
  reconcile(keep: ReadonlySet<string>): void {
    for (const id of [...this._entries.keys()]) {
      if (!keep.has(id)) this.release(id);
    }
  }

  disposeAll(): void {
    for (const id of [...this._entries.keys()]) this.release(id);
  }

  private _destinationFor(trackId: string | null): AudioNode {
    return trackId ? this._graph.trackBus(trackId) : this._graph.master();
  }
}

function makeEntry(kind: PoolKind, src: string): PoolEntry {
  if (typeof document === "undefined") {
    throw new Error("[playmix] media elements require a document; playback needs a browser.");
  }

  const el =
    kind === "video"
      ? Object.assign(document.createElement("video"), {
          crossOrigin: "anonymous",
          playsInline: true,
          preload: "auto",
          // Muted until routed; the gain node owns volume from then on.
          muted: true,
          volume: 1,
        })
      : Object.assign(document.createElement("audio"), {
          crossOrigin: "anonymous",
          preload: "auto",
          volume: 1,
        });

  el.src = src;

  const entry: PoolEntry = {
    kind,
    el,
    originalSrc: src,
    gain: null,
    source: null,
    routedTrackId: null,
    ready: false,
    lastSeekAt: 0,
  };

  el.addEventListener(
    "loadeddata",
    () => {
      entry.ready = true;
    },
    { once: true },
  );

  /* A failed load surfaces as `ready` staying false. Swallowing the event
     keeps a broken file from filling the console with errors the scheduler
     already handles by simply never commanding the clip. */
  el.addEventListener("error", () => {});

  return entry;
}

function disconnectQuietly(node: AudioNode): void {
  try {
    node.disconnect();
  } catch {
    /* already detached */
  }
}

export function createMediaPool(graph: AudioGraph): MediaPool {
  return new MediaPool(graph);
}
