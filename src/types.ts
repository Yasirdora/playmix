/**
 * The timeline shape playmix reads.
 *
 * These types are deliberately a **subset** of what a host editor's own state
 * looks like. The engine never constructs a clip, never mutates one, and never
 * persists one — it only reads the fields it needs to decide what should be
 * audible at a given instant and at what gain.
 *
 * The practical consequence is that a host with a much richer store (selection
 * state, undo history, UI flags, per-clip colors) satisfies these types
 * structurally, with no adapter layer and no duplicated model. Pass the store
 * straight in.
 *
 * The one rule that matters: everything here is read-only from the engine's
 * point of view. If a field changes, the host tells the engine by handing it a
 * new snapshot; the engine does not watch, subscribe to, or write back into
 * host state.
 */

/** A point on a clip's volume automation curve. */
export type EnvelopePoint = {
  /** Seconds from the start of the clip. */
  time: number;
  /** Volume multiplier. 1 = native, 0 = silent, 2 = +6 dB. */
  value: number;
};

/** What kind of source a clip draws from. */
export type ClipKind = "video" | "audio" | "image" | "text";

/**
 * A decoded source the engine can point a media element at.
 *
 * `url` is whatever the host wants the element's `src` to be — an object URL,
 * a blob URL, a remote address. The engine does not care where it came from,
 * which is what keeps storage concerns (IndexedDB, the File System Access API,
 * a CDN) entirely on the host's side of the boundary.
 */
export type MediaAsset = {
  id: string;
  url: string;
  /** Native duration in seconds. 0 for stills. */
  duration: number;
};

/** Fields every clip carries, whatever its kind. */
export type BaseClip = {
  id: string;
  trackId: string;
  /** Position on the timeline, in project seconds. */
  start: number;
  /** Length on the timeline, in project seconds. */
  duration: number;
  /** Where in the source this clip begins, in source seconds. */
  inPoint: number;
  /** Playback rate. 1 = native. Clamped to [SPEED_MIN, SPEED_MAX] on use. */
  speed: number;
  /** Base gain, 0..2. Multiplied by envelope, fades and crossfade. */
  volume: number;
  /** Optional automation curve. When present it replaces the fade envelope. */
  volumePoints?: EnvelopePoint[] | undefined;
  /** Fade-in length in seconds. */
  fadeIn: number;
  /** Fade-out length in seconds. */
  fadeOut: number;
  /** Bypassed clips are skipped entirely — not scheduled, not mixed, not rendered. */
  disabled: boolean;
};

/** A clip backed by a media asset. */
export type MediaClip = BaseClip & {
  kind: "video" | "audio" | "image";
  assetId: string;
};

/** A clip with no media source. The engine ignores these; they exist so a host union assigns. */
export type NonMediaClip = BaseClip & {
  kind: "text";
};

export type Clip = MediaClip | NonMediaClip;

/** A clip that actually carries a decodable stream. */
export type AudioVideoClip = MediaClip & { kind: "audio" | "video" };

/**
 * A lane clips sit on. Mute, solo and the fader are resolved here rather than
 * per clip, because soloing is a property of the whole track set: one soloed
 * track silences every track that is not soloed.
 */
export type Track = {
  id: string;
  kind: "video" | "audio" | "text";
  muted: boolean;
  soloed: boolean;
  /** Hidden tracks still play audio; they are only visually suppressed. */
  hidden: boolean;
  /** Track fader, 0..2. Applied on top of clip gain. */
  volume: number;
};

/**
 * Everything the engine needs to know about the project at one instant.
 *
 * Note what is absent: no playhead, no playing flag, no zoom, no selection.
 * Time lives in the clock, not the snapshot, so that moving the playhead does
 * not require the host to rebuild this object sixty times a second.
 */
export type Timeline = {
  assets: Record<string, MediaAsset>;
  clips: Record<string, Clip>;
  /** Stable iteration order. The engine never sorts `clips` itself. */
  clipOrder: string[];
  tracks: Track[];
  /**
   * When true, clips overlapping on one track crossfade into each other.
   * When false, an overlap is treated as a hard cut.
   */
  stackOverlaps?: boolean | undefined;
};
