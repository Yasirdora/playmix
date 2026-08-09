export {
  SAMPLE_RATE,
  SPEED_MIN,
  SPEED_MAX,
  clampSpeed,
} from "./constants.ts";

export { interpolateEnvelope } from "./envelope.ts";

export {
  classifyOverlapPair,
  clipHasOverlap,
  clipOverlapRegions,
  clipsOverlap,
  collectCrossfadeBands,
  crossfadeMultiplier,
  crossfadesEnabled,
  equalPowerCrossfade,
  isNestedInside,
  trackOverlapSignature,
  type CrossfadeBand,
  type OverlapContext,
  type OverlapKind,
  type OverlapRegion,
} from "./crossfade.ts";

export {
  buildExportOverlapContext,
  clipGainAt,
  clipGainSignature,
  gainAtLocalTime,
  hasSoloedTrack,
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
} from "./gain.ts";
