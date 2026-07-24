/**
 * Framework bindings, without a framework.
 *
 * The engine's reactive surface is deliberately the smallest thing every UI
 * library already knows how to consume: `subscribe(cb) => unsubscribe`, plus a
 * getter that returns a primitive. Nothing here imports React, Svelte, Vue or
 * Solid, and nothing needs to — each of them binds to one of the two shapes
 * below:
 *
 *   • **React / Preact** — `useSyncExternalStore(clock.subscribe,
 *     clock.getTimeSnapshot, clock.getTimeSnapshot)`. The no-argument callback
 *     and the stable primitive getter are exactly what it expects. A ready-made
 *     hook ships at `playmix/react`.
 *
 *   • **Svelte** — `toReadable(clock)` below satisfies the store contract, so
 *     `$time` works in a template with no adapter and no subscription
 *     bookkeeping.
 *
 *   • **Vue** — `const t = shallowRef(clock.time());
 *     onScopeDispose(clock.subscribe(() => { t.value = clock.time(); }))`.
 *
 *   • **Solid / Angular / vanilla** — `clock.subscribe` returns its own
 *     unsubscribe, which is all a `createSignal` effect or an `ngOnDestroy`
 *     needs.
 *
 * The reason this is worth stating rather than leaving implicit: a playback
 * engine that reaches for a framework's reactivity ends up owning that
 * framework's version matrix forever. Staying on the callback contract means
 * the engine is indifferent to which one, or how many, are in the page.
 */

import type { Clock } from "./clock.ts";

/** The subset of a Svelte readable store that consumers actually use. */
export type Readable<T> = {
  subscribe(run: (value: T) => void): () => void;
};

/**
 * Adapt any subscribable to the Svelte store contract, which requires the
 * callback to fire immediately with the current value and on every change.
 */
export function toReadable<T>(source: {
  subscribe(cb: () => void): () => void;
  get(): T;
}): Readable<T> {
  return {
    subscribe(run) {
      run(source.get());
      return source.subscribe(() => run(source.get()));
    },
  };
}

/** Project time as a Svelte-compatible store. Updates every frame while playing. */
export function timeStore(clock: Clock): Readable<number> {
  return toReadable({ subscribe: clock.subscribe, get: clock.getTimeSnapshot });
}

/**
 * Play state as a Svelte-compatible store.
 *
 * Bound to the play/pause channel rather than the frame channel on purpose: a
 * play button that subscribed to time would re-render sixty times a second to
 * observe a boolean that changed twice.
 */
export function playingStore(clock: Clock): Readable<boolean> {
  return toReadable({
    subscribe: clock.subscribePlaying,
    get: clock.getPlayingSnapshot,
  });
}
