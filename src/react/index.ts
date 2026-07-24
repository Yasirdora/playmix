/**
 * React bindings.
 *
 * This is the only file in the package that imports a framework, which is why
 * it sits behind its own entry point: `playmix/react`. React is declared as an
 * optional peer dependency, so a Svelte or vanilla consumer installs nothing
 * extra and bundles none of this.
 */

import { useSyncExternalStore } from "react";
import type { Clock } from "../clock.ts";

/**
 * Subscribe a component to project time.
 *
 * Re-renders at frame rate while playing, which is correct for a playhead or a
 * timecode readout and wasteful for anything else. If a component only needs to
 * know *whether* playback is happening, use {@link useIsPlaying} — it is bound
 * to the transport channel and re-renders twice per playback, not a hundred
 * times a second.
 */
export function useClockTime(clock: Clock): number {
  return useSyncExternalStore(clock.subscribe, clock.getTimeSnapshot, clock.getTimeSnapshot);
}

/** Subscribe a component to play/pause state only. */
export function useIsPlaying(clock: Clock): boolean {
  return useSyncExternalStore(
    clock.subscribePlaying,
    clock.getPlayingSnapshot,
    clock.getPlayingSnapshot,
  );
}
