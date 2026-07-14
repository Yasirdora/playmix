/**
 * The scheduler — everything between the clock and the media elements.
 *
 * Its job is to turn (timeline, current time, playing) into the *smallest set
 * of element commands* that realises it. The naive version — writing
 * `currentTime` and calling `play()` on every clip every frame — produces
 * exactly the stutter that browser editors are known for, because each write
 * restarts the decoder.
 *
 * Cut-point smoothness
 * --------------------
 * The insight the whole design rests on: when the playhead is about to leave
 * clip A for clip B, B's element must *already* be loaded, seeked to its
 * in-point, and paused. Then `play()` starts instantly. Discovering B at the
 * moment it becomes active is too late — the seek and the decode both happen
 * while the viewer is watching.
 *
 * So every tick scans a look-ahead window and pre-seeks clips about to start.
 * Deliberately it does *not* start them: playing early advances the element
 * past its in-point, forcing a backward seek at the cut, which stalls the
 * decoder and produces the very glitch this avoids.
 *
 * State machine
 * -------------
 * Each clip carries one `commanded` flag — whether we last told it to play.
 * Per tick:
 *
 *   • clips that just became active → seek, then play
 *   • clips that just became inactive → pause
 *   • clips still active → nudge only when drift exceeds NUDGE_THRESHOLD_S
 *
 * Gain is scheduled as Web Audio automation rather than written per frame, and
 * only when the clip's gain signature changes, so a fade is programmed once and
 * then left alone.
 */

import type { AudioGraph } from "./audio-graph.ts";
import type { Clock } from "./clock.ts";
import type { MediaPool, PoolEntry } from "./media-pool.ts";
import { clampSpeed } from "./mix/constants.ts";
import {
  clipGainAt,
  clipGainSignature,
  isTrackAudible,
  scheduleLiveClipGain,
} from "./mix/gain.ts";
import type { OverlapContext } from "./mix/crossfade.ts";
import type { Timeline, Track } from "./types.ts";

/**
 * Forgiving on purpose. Video decode latency runs 50–80 ms, so a tighter
 * threshold makes the scheduler chase its own decode delay and seek constantly.
 */
const NUDGE_THRESHOLD_S = 0.15;
/** Minimum gap between seeks. Below this the decoder stalls under seek storms. */
const SEEK_RATE_LIMIT_MS = 50;
/** How far ahead to warm up clips that are about to start. */
const PREBUFFER_S = 1.5;
/** Drift above this at a cut is corrected without rate limiting. */
const CUT_SEEK_EPSILON_S = 0.02;
/** Drift above this while paused is corrected, so scrubbing tracks the playhead. */
const PAUSED_SEEK_EPSILON_S = 0.05;

type CommandedState = { clipId: string; playing: boolean };

export type SchedulerOptions = {
  clock: Clock;
  pool: MediaPool;
  graph: AudioGraph;
  /** Monotonic milliseconds, for seek rate limiting. Injectable for tests. */
  now?: (() => number) | undefined;
};

export class Scheduler {
  private _clock: Clock;
  private _pool: MediaPool;
  private _graph: AudioGraph;
  private _now: () => number;

  private _commanded = new Map<string, CommandedState>();
  /**
   * Clips with a pending one-shot `loadeddata` listener.
   *
   * Without this, a clip that becomes wanted before its element has data is
   * stuck at frame zero forever: the clock only ticks on play, seek and pause,
   * so nothing would ever re-issue the seek.
   */
  private _pendingReady = new Map<string, () => void>();
  private _preBuffered = new Set<string>();
  /** Last scheduled gain signature per clip, so ramps aren't rebuilt each frame. */
  private _gainSignatures = new Map<string, string>();
  private _unsub: (() => void) | null = null;
  private _timeline: Timeline | null = null;

  constructor(opts: SchedulerOptions) {
    this._clock = opts.clock;
    this._pool = opts.pool;
    this._graph = opts.graph;
    this._now =
      opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  /** Begin reacting to clock ticks. */
  start(): void {
    if (this._unsub) return;
    this._unsub = this._clock.subscribe(this._onTick);
  }

  stop(): void {
    this._unsub?.();
    this._unsub = null;
  }

  /**
   * Hand the scheduler a new view of the project. Call whenever the timeline
   * changes — a clip added, moved, trimmed, or edited in an inspector.
   */
  setTimeline(timeline: Timeline): void {
    this._timeline = timeline;
    this._reconcilePool();
    this._preloadAll();
    // Command immediately rather than waiting for the next tick, so a newly
    // added clip under the playhead is audible without pressing play.
    this._onTick();
  }

  dispose(): void {
    this.stop();
    this._pool.disposeAll();
    this._commanded.clear();
    for (const disarm of this._pendingReady.values()) disarm();
    this._pendingReady.clear();
    this._preBuffered.clear();
    this._gainSignatures.clear();
    this._timeline = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private _reconcilePool(): void {
    const snap = this._timeline;
    if (!snap) return;

    const keep = new Set<string>();
    for (const id of snap.clipOrder) {
      const c = snap.clips[id];
      if (c && (c.kind === "video" || c.kind === "audio")) keep.add(c.id);
    }
    this._pool.reconcile(keep);

    for (const id of [...this._commanded.keys()]) if (!keep.has(id)) this._commanded.delete(id);
    for (const id of [...this._pendingReady.keys()]) if (!keep.has(id)) this._disarmReady(id);
    for (const id of [...this._preBuffered]) if (!keep.has(id)) this._preBuffered.delete(id);
    for (const id of [...this._gainSignatures.keys()])
      if (!keep.has(id)) this._gainSignatures.delete(id);
  }

  /**
   * Create elements for every media clip up front, so files begin loading when
   * they are added rather than when the playhead first arrives at them.
   */
  private _preloadAll(): void {
    const snap = this._timeline;
    if (!snap) return;

    for (const id of snap.clipOrder) {
      const c = snap.clips[id];
      if (!c || (c.kind !== "video" && c.kind !== "audio")) continue;
      // Disabled clips never play. This also guards in-progress recordings,
      // whose asset url is still empty.
      if (c.disabled) continue;
      const asset = snap.assets[c.assetId];
      if (!asset?.url) continue;
      this._pool.acquire(c.id, c.kind, asset.url);
    }
  }

  private _overlapContext(snap: Timeline): OverlapContext {
    return {
      clips: snap.clips,
      clipOrder: snap.clipOrder,
      ...(snap.stackOverlaps !== undefined ? { stackOverlaps: snap.stackOverlaps } : {}),
    };
  }

  private _onTick = (): void => {
    const snap = this._timeline;
    if (!snap) return;

    const time = this._clock.time();
    const playing = this._clock.playing();
    const trackById = new Map<string, Track>(snap.tracks.map((t) => [t.id, t]));

    const wantedAudible = new Set<string>();
    const wantedVisible = new Set<string>();

    for (const id of snap.clipOrder) {
      const c = snap.clips[id];
      if (!c || (c.kind !== "video" && c.kind !== "audio")) continue;
      if (c.disabled) continue;
      const tr = trackById.get(c.trackId);
      if (!tr) continue;
      if (!(time >= c.start && time < c.start + c.duration)) continue;

      if (c.kind === "video" && !tr.hidden) wantedVisible.add(c.id);
      if (isTrackAudible(tr, snap.tracks)) wantedAudible.add(c.id);
    }

    // 1. Pause anything that fell out of the active set.
    for (const [id, state] of this._commanded) {
      if (wantedAudible.has(id) || wantedVisible.has(id)) continue;
      const entry = this._pool.get(id);
      if (entry && state.playing) pauseQuietly(entry);
      this._commanded.delete(id);
      this._gainSignatures.delete(id);
    }

    // 2. Drive everything active.
    for (const id of new Set([...wantedAudible, ...wantedVisible])) {
      const c = snap.clips[id];
      if (!c || (c.kind !== "video" && c.kind !== "audio")) continue;
      const asset = snap.assets[c.assetId];
      if (!asset) continue;

      const entry = this._pool.acquire(c.id, c.kind, asset.url);
      if (!entry.ready) {
        this._armReady(c.id, entry);
        continue;
      }

      // Now active: clear the pre-buffer flag so it can warm up again if the
      // clip becomes upcoming later, which happens on every loop.
      this._preBuffered.delete(c.id);

      const speed = clampSpeed(c.speed || 1);
      const localT = c.inPoint + (time - c.start) * speed;
      const elT = entry.el.currentTime;
      const tr = trackById.get(c.trackId);

      if (wantedAudible.has(id) && tr) {
        this._pool.attachAudio(entry, c.trackId);
        if (entry.gain) {
          this._scheduleGain(entry.gain, id, c, tr, snap, time - c.start, playing);
        }
      } else if (entry.gain) {
        this._pool.detachAudio(entry);
        this._gainSignatures.delete(id);
      }

      if (Math.abs(entry.el.playbackRate - speed) > 0.001) entry.el.playbackRate = speed;

      const commanded = this._commanded.get(id);

      if (playing) {
        if (!commanded?.playing) {
          /* Just became active. Seek without rate limiting — this is the cut
             point, and a correct first frame matters more here than decoder
             politeness. */
          if (Math.abs(elT - localT) > CUT_SEEK_EPSILON_S) this._forceSeek(entry, localT);
          playQuietly(entry);
          this._commanded.set(id, { clipId: id, playing: true });
        } else if (Math.abs(elT - localT) > NUDGE_THRESHOLD_S) {
          this._rateLimitedSeek(entry, localT);
        }
      } else {
        if (commanded?.playing) pauseQuietly(entry);
        if (Math.abs(elT - localT) > PAUSED_SEEK_EPSILON_S) this._rateLimitedSeek(entry, localT);
        this._commanded.set(id, { clipId: id, playing: false });
      }
    }

    // 3. Warm up what's coming.
    this._preBufferUpcoming(time, playing);
  };

  private _scheduleGain(
    gain: GainNode,
    id: string,
    clip: NonNullable<Timeline["clips"][string]>,
    track: Track,
    snap: Timeline,
    posInClip: number,
    playing: boolean,
  ): void {
    const overlapCtx = this._overlapContext(snap);
    const signature = clipGainSignature(clip, track, overlapCtx);
    const startingPlayback = playing && !this._commanded.get(id)?.playing;

    if (!startingPlayback && this._gainSignatures.get(id) === signature) return;

    try {
      scheduleLiveClipGain(gain, clip, track, this._graph.now(), posInClip, overlapCtx);
    } catch (err) {
      /* Web Audio rejects some schedules outright — a start time already in the
         past is the usual cause. Falling back to a flat value keeps the clip
         audible at roughly the right level instead of silent, which is the
         better failure. */
      console.error("[playmix] gain schedule failed for clip", id, err);
      const entry = this._pool.get(id);
      if (entry) this._pool.setGain(entry, clipGainAt(clip, posInClip, overlapCtx));
    }
    this._gainSignatures.set(id, signature);
  }

  /**
   * Pre-seek clips starting within the look-ahead window so their first frame
   * is decoded before the playhead arrives.
   */
  private _preBufferUpcoming(time: number, playing: boolean): void {
    const snap = this._timeline;
    if (!snap || !playing) return;

    const horizon = time + PREBUFFER_S;

    for (const id of snap.clipOrder) {
      const c = snap.clips[id];
      if (!c || (c.kind !== "video" && c.kind !== "audio")) continue;
      if (!(c.start > time && c.start <= horizon)) continue;
      if (this._preBuffered.has(c.id)) continue;

      const asset = snap.assets[c.assetId];
      if (!asset) continue;

      const entry = this._pool.acquire(c.id, c.kind, asset.url);
      if (!entry.ready) {
        this._armReady(c.id, entry);
        continue;
      }

      this._forceSeek(entry, c.inPoint);
      entry.el.playbackRate = clampSpeed(c.speed || 1);
      this._preBuffered.add(c.id);
    }
  }

  /**
   * Re-run the tick once an element has data. Only one listener is armed per
   * clip; further ticks while loading are no-ops.
   */
  private _armReady(clipId: string, entry: PoolEntry): void {
    if (this._pendingReady.has(clipId)) return;

    const onReady = (): void => {
      this._disarmReady(clipId);
      this._onTick();
    };
    const disarm = (): void => {
      entry.el.removeEventListener("loadeddata", onReady);
      this._pendingReady.delete(clipId);
    };

    this._pendingReady.set(clipId, disarm);
    entry.el.addEventListener("loadeddata", onReady);

    // The data may have landed between the readiness check and this line.
    if (entry.ready) onReady();
  }

  private _disarmReady(clipId: string): void {
    this._pendingReady.get(clipId)?.();
  }

  private _rateLimitedSeek(entry: PoolEntry, t: number): void {
    if (this._now() - entry.lastSeekAt < SEEK_RATE_LIMIT_MS) return;
    this._forceSeek(entry, t);
  }

  private _forceSeek(entry: PoolEntry, t: number): void {
    const dur = entry.el.duration;
    const clamped = Math.max(0, Number.isFinite(dur) ? Math.min(dur, t) : t);
    try {
      entry.el.currentTime = clamped;
      entry.lastSeekAt = this._now();
    } catch {
      /* not seekable yet; the readiness retry will come back to it */
    }
  }
}

function playQuietly(entry: PoolEntry): void {
  const p = entry.el.play();
  // Pausing mid-flight rejects the promise with AbortError, which is expected
  // at cut points and not worth surfacing.
  if (p && typeof p.then === "function") p.catch(() => {});
}

function pauseQuietly(entry: PoolEntry): void {
  try {
    entry.el.pause();
  } catch {
    /* never loaded */
  }
}

/**
 * The clip that should drive frame-accurate clock anchoring: topmost track
 * first, earliest start as the tiebreak. A host feeds this element's
 * `requestVideoFrameCallback` into `clock.syncTo`.
 */
export function leadingVideoClipId(snap: Timeline, t: number): string | null {
  const trackOrder = new Map<string, number>();
  snap.tracks.forEach((tr, i) => trackOrder.set(tr.id, i));

  let best: { id: string; trackIdx: number; start: number } | null = null;
  for (const id of snap.clipOrder) {
    const c = snap.clips[id];
    if (c?.kind !== "video") continue;
    if (!(t >= c.start && t < c.start + c.duration)) continue;

    const idx = trackOrder.get(c.trackId) ?? 0;
    if (!best || idx > best.trackIdx || (idx === best.trackIdx && c.start < best.start)) {
      best = { id: c.id, trackIdx: idx, start: c.start };
    }
  }
  return best?.id ?? null;
}

export function createScheduler(opts: SchedulerOptions): Scheduler {
  return new Scheduler(opts);
}
