/**
 * Stand-ins for the media pool and audio graph, so the scheduler's decisions
 * can be tested without a browser.
 *
 * The scheduler's value is in *what it commands and when* — pre-seek this clip
 * but do not start it, force-seek at the cut, rate-limit the nudge. That logic
 * is worth testing directly. Driving a real `<video>` to test it would measure
 * the browser's decoder instead, in an environment where there isn't one.
 *
 * These record commands rather than performing them, so a test asserts on the
 * command log.
 */

import type { AudioGraph } from "../audio-graph.ts";
import type { MediaPool, PoolEntry, PoolKind } from "../media-pool.ts";
import { RecordingGainNode, asGainNode } from "./automation.ts";

export type Command =
  | { op: "play"; clipId: string }
  | { op: "pause"; clipId: string }
  | { op: "seek"; clipId: string; time: number }
  | { op: "attach"; clipId: string; trackId: string | undefined }
  | { op: "detach"; clipId: string };

type FakeElement = {
  currentTime: number;
  duration: number;
  playbackRate: number;
  paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, cb: () => void, opts?: unknown): void;
  removeEventListener(type: string, cb: () => void): void;
};

export class FakePool {
  readonly commands: Command[] = [];
  private _entries = new Map<string, PoolEntry>();
  /** Clips whose element should report as not yet loaded. */
  readonly notReady = new Set<string>();

  acquire(clipId: string, kind: PoolKind, src: string): PoolEntry {
    const existing = this._entries.get(clipId);
    if (existing && existing.originalSrc === src && existing.kind === kind) {
      existing.ready = !this.notReady.has(clipId);
      return existing;
    }

    const commands = this.commands;
    const el: FakeElement = {
      currentTime: 0,
      duration: 3600,
      playbackRate: 1,
      paused: true,
      play() {
        this.paused = false;
        commands.push({ op: "play", clipId });
        return Promise.resolve();
      },
      pause() {
        this.paused = true;
        commands.push({ op: "pause", clipId });
      },
      addEventListener() {},
      removeEventListener() {},
    };

    // `currentTime` writes are seeks, so observe them rather than the field.
    let raw = 0;
    Object.defineProperty(el, "currentTime", {
      get: () => raw,
      set: (v: number) => {
        raw = v;
        commands.push({ op: "seek", clipId, time: v });
      },
    });

    const entry: PoolEntry = {
      kind,
      el: el as unknown as HTMLMediaElement,
      originalSrc: src,
      gain: asGainNode(new RecordingGainNode()),
      source: null,
      routedTrackId: null,
      ready: !this.notReady.has(clipId),
      lastSeekAt: 0,
    };
    this._entries.set(clipId, entry);
    return entry;
  }

  get(clipId: string): PoolEntry | undefined {
    return this._entries.get(clipId);
  }
  attachAudio(entry: PoolEntry, trackId?: string): void {
    entry.routedTrackId = trackId ?? null;
    this.commands.push({ op: "attach", clipId: this._idOf(entry), trackId });
  }
  detachAudio(entry: PoolEntry): void {
    entry.gain = null;
    this.commands.push({ op: "detach", clipId: this._idOf(entry) });
  }
  setGain(): void {}
  rampGain(): void {}
  release(clipId: string): void {
    this._entries.delete(clipId);
  }
  reconcile(keep: ReadonlySet<string>): void {
    for (const id of [...this._entries.keys()]) if (!keep.has(id)) this.release(id);
  }
  disposeAll(): void {
    this._entries.clear();
  }

  /**
   * Commands of one kind, in order, narrowed to that variant so a test can
   * read `.time` off a seek without re-checking which command it got.
   */
  ops<K extends Command["op"]>(op: K): Extract<Command, { op: K }>[] {
    return this.commands.filter((c): c is Extract<Command, { op: K }> => c.op === op);
  }
  clear(): void {
    this.commands.length = 0;
  }

  private _idOf(entry: PoolEntry): string {
    for (const [id, e] of this._entries) if (e === entry) return id;
    return "?";
  }
}

/** An audio graph that reports a context clock and otherwise does nothing. */
export class FakeGraph {
  private _t = 0;

  context(): BaseAudioContext {
    return { currentTime: this._t, state: "running" } as unknown as BaseAudioContext;
  }
  now(): number {
    return this._t;
  }
  advance(seconds: number): void {
    this._t += seconds;
  }
  trackBus(): GainNode {
    return asGainNode(new RecordingGainNode());
  }
  master(): GainNode {
    return asGainNode(new RecordingGainNode());
  }
  analyser(): AnalyserNode {
    return {} as AnalyserNode;
  }
  sourceFor(): MediaElementAudioSourceNode {
    return {} as MediaElementAudioSourceNode;
  }
  setTrackGain(): void {}
  setMasterGain(): void {}
  syncTrackBuses(): void {}
  releaseTrackBus(): void {}
  ensureRunning(): Promise<void> {
    return Promise.resolve();
  }
  isResumed(): boolean {
    return true;
  }
  dispose(): void {}
}

export function asPool(p: FakePool): MediaPool {
  return p as unknown as MediaPool;
}
export function asGraph(g: FakeGraph): AudioGraph {
  return g as unknown as AudioGraph;
}
