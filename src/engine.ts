/**
 * The assembled engine — a clock, an audio graph, an element pool and a
 * scheduler, wired together.
 *
 * Every part is independently constructible, and hosts with unusual needs
 * should reach for them directly. This exists because the common case is not
 * unusual: one timeline, one clock, one graph, and a scheduler joining them.
 * Making that case a single call keeps the wiring — which has a correct order
 * and a required teardown — from being copied slightly differently into every
 * consumer.
 *
 * Nothing here touches the platform at construction time. The `AudioContext`
 * is created on first use and media elements on first `setTimeline`, so
 * building an engine during a server render is harmless; only playback needs a
 * browser.
 */

import { AudioGraph, createAudioGraph } from "./audio-graph.ts";
import { Clock, createClock, type TimeSource } from "./clock.ts";
import { MediaPool, createMediaPool } from "./media-pool.ts";
import { Scheduler, createScheduler } from "./scheduler.ts";
import type { Timeline } from "./types.ts";

export type EngineOptions = {
  /** Supply an existing context, or leave it to be created on first use. */
  context?: BaseAudioContext | undefined;
  /** Swap the clock's time and frame source. Tests use this. */
  timeSource?: TimeSource | undefined;
  /**
   * Re-arm the frame loop when a background tab becomes visible again.
   * Defaults to true wherever there is a document.
   */
  reviveOnVisible?: boolean | undefined;
};

export class Engine {
  readonly clock: Clock;
  readonly graph: AudioGraph;
  readonly pool: MediaPool;
  readonly scheduler: Scheduler;

  private _started = false;

  constructor(opts: EngineOptions = {}) {
    this.clock = createClock({
      ...(opts.timeSource !== undefined ? { timeSource: opts.timeSource } : {}),
      ...(opts.reviveOnVisible !== undefined ? { reviveOnVisible: opts.reviveOnVisible } : {}),
    });
    this.graph = createAudioGraph(
      opts.context !== undefined ? { context: opts.context } : {},
    );
    this.pool = createMediaPool(this.graph);
    this.scheduler = createScheduler({
      clock: this.clock,
      pool: this.pool,
      graph: this.graph,
    });
  }

  /**
   * Hand the engine the current timeline. Call on every change; the scheduler
   * diffs against what it already commanded rather than rebuilding.
   *
   * The scheduler subscribes to the clock on the first call rather than in the
   * constructor, so an engine that is built but never given a timeline holds
   * no subscription.
   */
  setTimeline(timeline: Timeline): void {
    if (!this._started) {
      this.scheduler.start();
      this._started = true;
    }
    this.graph.syncTrackBuses(timeline.tracks);
    this.scheduler.setTimeline(timeline);
  }

  /**
   * Resume audio. Must be called from a real user gesture — browsers start the
   * context suspended and silently drop sound until one resumes it.
   */
  async unlock(): Promise<void> {
    await this.graph.ensureRunning();
  }

  play(): void {
    this.clock.play();
  }
  pause(): void {
    this.clock.pause();
  }
  seek(t: number): void {
    this.clock.seek(t);
  }

  /** Current project time in seconds. */
  time(): number {
    return this.clock.time();
  }
  playing(): boolean {
    return this.clock.playing();
  }

  /** Subscribe to project time. Fires every frame while playing. */
  subscribe(cb: () => void): () => void {
    return this.clock.subscribe(cb);
  }

  /** Tear everything down. Safe to call more than once. */
  dispose(): void {
    this.scheduler.dispose();
    this.graph.dispose();
    this.clock.dispose();
    this._started = false;
  }
}

export function createEngine(opts: EngineOptions = {}): Engine {
  return new Engine(opts);
}
