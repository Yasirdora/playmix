/**
 * Offline mixdown.
 *
 * Renders a timeline to an `AudioBuffer` through the *same* mix model the live
 * scheduler programs onto its gain nodes. That sharing is the point: gain,
 * fades, envelopes and crossfades have one definition, so a fade cannot sound
 * one way on the timeline and render another way to disk.
 *
 * What this deliberately does not do is encode. It hands back raw samples;
 * turning those into a WAV, MP3 or M4A is a file-format problem that
 * [mediabunny](https://mediabunny.dev) already solves better than this package
 * would, and pulling an encoder in here would trade the zero-dependency
 * guarantee for a worse version of an existing library.
 *
 * Scope, stated honestly: this renders **audio**. Video clips carry gain and
 * are scheduled for playback, but compositing video frames to an output file is
 * a different problem with a different architecture, and this engine does not
 * attempt it.
 */

import { SAMPLE_RATE } from "../mix/constants.ts";
import { clampSpeed } from "../mix/constants.ts";
import {
  buildExportOverlapContext,
  resolveRenderClips,
  scheduleClipGain,
  sliceClipForExport,
} from "../mix/gain.ts";
import type { MediaAsset, Timeline } from "../types.ts";

export type RenderProgress = {
  /** 0–100. */
  pct: number;
  phase: "loading" | "rendering";
  message: string;
};

export type RenderOptions = {
  /** Mono or stereo. Defaults to stereo. */
  channels?: 1 | 2;
  /** Output sample rate. Defaults to the engine's 48 kHz. */
  sampleRate?: number;
  /** Render only this slice of the timeline. Defaults to the whole thing. */
  range?: { start: number; end: number } | null;
  /**
   * Fetch an asset's bytes.
   *
   * Defaults to `fetch(asset.url)`, which is right when assets are object URLs
   * or ordinary addresses. Override it when the bytes live somewhere a URL
   * cannot reach them — an IndexedDB blob store, an OPFS handle, a File the
   * user picked and never uploaded.
   */
  resolveAudio?: (asset: MediaAsset) => Promise<ArrayBuffer>;
  onProgress?: (p: RenderProgress) => void;
  /** Abort a long render. Checked between decodes and before rendering starts. */
  signal?: AbortSignal;
};

export class RenderError extends Error {
  readonly code: "empty" | "unsupported" | "aborted" | "decode";

  constructor(code: RenderError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RenderError";
    this.code = code;
  }
}

/** Fraction of reported progress spent decoding before rendering begins. */
const DECODE_PROGRESS_SHARE = 40;

export async function renderMix(
  timeline: Timeline,
  opts: RenderOptions = {},
): Promise<AudioBuffer> {
  const channels = opts.channels ?? 2;
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const range = opts.range ?? null;
  const report = opts.onProgress ?? (() => {});

  const OfflineCtor = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext })
    .OfflineAudioContext;
  if (!OfflineCtor) {
    throw new RenderError("unsupported", "[playmix] OfflineAudioContext is unavailable here.");
  }

  const clips = resolveRenderClips(
    timeline.tracks,
    timeline.clips,
    timeline.clipOrder,
    range ?? undefined,
  );
  if (clips.length === 0) {
    throw new RenderError("empty", "[playmix] nothing audible to render in this range.");
  }

  // ── Decode every distinct asset once ──────────────────────────────────────

  report({ pct: 0, phase: "loading", message: "Loading sources" });

  const assetIds = [...new Set(clips.map((c) => c.assetId))];
  const decoded = new Map<string, AudioBuffer>();

  /* Decoding needs *a* context but not the output one, and constructing a live
     AudioContext just to decode would leave a suspended context and a device
     handle open on some browsers. A one-frame OfflineAudioContext is enough:
     decodeAudioData resamples to the target rate regardless of the context's
     own length. */
  const decodeCtx = new OfflineCtor(channels, 1, sampleRate);

  for (let i = 0; i < assetIds.length; i++) {
    throwIfAborted(opts.signal);

    const id = assetIds[i];
    if (id === undefined) continue;
    const asset = timeline.assets[id];
    if (!asset) continue;

    try {
      const bytes = opts.resolveAudio
        ? await opts.resolveAudio(asset)
        : await fetch(asset.url).then((r) => r.arrayBuffer());
      decoded.set(id, await decodeCtx.decodeAudioData(bytes));
    } catch (cause) {
      throw new RenderError("decode", `[playmix] could not decode asset "${id}".`, { cause });
    }

    report({
      pct: (DECODE_PROGRESS_SHARE * (i + 1)) / assetIds.length,
      phase: "loading",
      message: "Loading sources",
    });
  }

  throwIfAborted(opts.signal);

  // ── Lay the clips out on an offline graph ─────────────────────────────────

  const rangeStart = range?.start ?? 0;
  const rangeEnd = range?.end ?? clips.reduce((max, c) => Math.max(max, c.start + c.duration), 0);
  const duration = Math.max(0.01, rangeEnd - rangeStart);

  const ctx = new OfflineCtor(channels, Math.max(1, Math.ceil(duration * sampleRate)), sampleRate);

  const overlapCtx = buildExportOverlapContext(
    timeline.clips,
    timeline.clipOrder,
    timeline.stackOverlaps ?? true,
    range,
  );

  for (const raw of clips) {
    // Slicing recomputes in-point, fades and envelope against the range
    // boundary, so a partial export fades exactly as that region does inside a
    // full one.
    const clip = range ? sliceClipForExport(raw, range) : raw;
    if (!clip) continue;

    const buffer = decoded.get(clip.assetId);
    if (!buffer) continue;

    const track = timeline.tracks.find((t) => t.id === clip.trackId);
    if (!track) continue;

    const speed = clampSpeed(clip.speed ?? 1);
    // Clamp defensively: a negative start time throws inside Web Audio, and a
    // rounding error at a range boundary is enough to produce one.
    const startAt = Math.max(0, clip.start - rangeStart);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speed;

    const gain = ctx.createGain();
    scheduleClipGain(gain, clip, track, startAt, overlapCtx);

    source.connect(gain);
    gain.connect(ctx.destination);

    /* The third argument is source-seconds, not timeline-seconds: a clip
       playing at 2× consumes twice its timeline duration from the file. */
    source.start(startAt, clip.inPoint, clip.duration * speed);
    source.stop(startAt + clip.duration);
  }

  report({ pct: DECODE_PROGRESS_SHARE, phase: "rendering", message: "Rendering mix" });

  const rendered = await ctx.startRendering();
  report({ pct: 100, phase: "rendering", message: "Done" });
  return rendered;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new RenderError("aborted", "[playmix] render aborted.");
}
