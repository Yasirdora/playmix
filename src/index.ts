/**
 * playmix — a headless multi-track playback engine for the browser.
 *
 * Plays a timeline through the browser's own decoders, and renders it offline
 * through the same mix model, so what you hear and what you export cannot
 * drift apart.
 *
 * Nothing in this entry point imports a UI framework, touches a browser global
 * at module scope, or constructs an `AudioContext`. That is what makes it safe
 * to import from a Next.js server component, an Astro island, a SvelteKit load
 * function, or a Worker — the engine only reaches for the platform once you
 * actually start it.
 */

// ── The timeline you hand in ────────────────────────────────────────────────
export type {
  AudioVideoClip,
  BaseClip,
  Clip,
  ClipKind,
  EnvelopePoint,
  MediaAsset,
  MediaClip,
  NonMediaClip,
  Timeline,
  Track,
} from "./types.ts";

// ── Transport ───────────────────────────────────────────────────────────────
export {
  Clock,
  browserTimeSource,
  createClock,
  quantizeToFrame,
  type ClockOptions,
  type TimeSource,
} from "./clock.ts";

// ── The assembled engine ────────────────────────────────────────────────────
export { Engine, createEngine, type EngineOptions } from "./engine.ts";

export { AudioGraph, createAudioGraph, type AudioGraphOptions } from "./audio-graph.ts";
export { MediaPool, createMediaPool, type PoolEntry, type PoolKind } from "./media-pool.ts";
export {
  Scheduler,
  createScheduler,
  leadingVideoClipId,
  type SchedulerOptions,
} from "./scheduler.ts";

// ── Offline render ──────────────────────────────────────────────────────────
export {
  RenderError,
  renderMix,
  type RenderOptions,
  type RenderProgress,
} from "./render/offline.ts";

// ── Framework-neutral bindings ──────────────────────────────────────────────
export { playingStore, timeStore, toReadable, type Readable } from "./store.ts";

// ── The mix model ───────────────────────────────────────────────────────────
export {
  SAMPLE_RATE,
  SPEED_MAX,
  SPEED_MIN,
  buildExportOverlapContext,
  clampSpeed,
  clipGainAt,
  clipGainSignature,
  clipHasOverlap,
  crossfadeMultiplier,
  equalPowerCrossfade,
  gainAtLocalTime,
  hasSoloedTrack,
  interpolateEnvelope,
  isClipInRange,
  isTrackAudible,
  mixGainAt,
  resolveAudibleClips,
  resolveRenderClips,
  scheduleClipGain,
  scheduleLiveClipGain,
  sliceClipForExport,
  type AudibleClip,
  type MixContext,
  type OverlapContext,
} from "./mix/index.ts";
