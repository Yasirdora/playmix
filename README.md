# playmix

[![CI](https://img.shields.io/github/actions/workflow/status/Yasirdora/playmix/main.yml?label=CI&logo=github)](https://github.com/Yasirdora/playmix/actions)
[![npm](https://img.shields.io/npm/v/playmix)](https://www.npmjs.com/package/playmix)
[![license](https://img.shields.io/npm/l/playmix)](https://github.com/Yasirdora/playmix/blob/main/LICENSE)
A headless multi-track playback engine for the browser.

It plays a timeline through the browser's own decoders, and renders that same
timeline offline through the same mix model — so what you hear and what you
export cannot drift apart.

- **No dependencies.** Not one. The core imports no framework and no Node builtin.
- **Headless.** It renders nothing and owns no state. You keep your timeline, your UI, your store.
- **Framework-agnostic.** React, Svelte, Vue, Solid, Angular, or none. SSR-safe under Next, Astro, SvelteKit and Nuxt.

---

## Why it exists

Every browser editor has to solve the same problem: given a timeline and a
playhead, drive a pile of `<video>` and `<audio>` elements so playback is smooth
and cuts don't glitch. It is the hardest part of the product and the least
visible one. The npm ecosystem has excellent tools for *files* — mediabunny for
reading and writing, WebAV for compositing — and nothing for the layer between a
timeline and the speakers.

The second problem is quieter and worse. Preview and export are usually two
pipelines, written months apart, that have to agree by discipline. They don't:
Audition loses automation on export, Premiere renders audio that differs from
the timeline, Shotcut previews don't match the file. These are mature, funded
products and they still ship this bug, because nothing forces two
implementations of one rule to stay equal.

Here there is one implementation. `clipGainAt` is read by the live scheduler,
by the offline renderer, and by anything drawing a meter. Agreement is a
property of the wiring rather than something anyone has to remember — and
there is [a test](test/equality.test.ts) that asserts it.

## Install

```bash
npm install playmix
```

## Quick start

```ts
import { createEngine } from "playmix";

const engine = createEngine();

// Hand it your timeline. Call again whenever it changes — the scheduler
// diffs against what it already commanded rather than rebuilding.
engine.setTimeline({
  assets: { a1: { id: "a1", url: objectUrl, duration: 128.4 } },
  tracks: [{ id: "t1", kind: "audio", muted: false, soloed: false, hidden: false, volume: 1 }],
  clips: {
    c1: {
      id: "c1", trackId: "t1", kind: "audio", assetId: "a1",
      start: 0, duration: 12, inPoint: 0,
      speed: 1, volume: 1, fadeIn: 0.5, fadeOut: 1, disabled: false,
    },
  },
  clipOrder: ["c1"],
});

// Browsers start audio suspended. Call this from a real click or keypress.
await engine.unlock();

engine.play();
engine.seek(4.2);

const unsubscribe = engine.subscribe(() => render(engine.time()));

// On teardown, both. `dispose` closes the `AudioContext` the engine created —
// browsers cap how many a tab may hold open, so a host that mounts and unmounts
// engines has to return them.
unsubscribe();
engine.dispose();
```

Rendering uses the same model that just played it:

```ts
import { renderMix } from "playmix/render";

const buffer = await renderMix(timeline, {
  channels: 2,
  onProgress: (p) => setProgress(p.pct),
});
```

`renderMix` returns an `AudioBuffer` — a plain Web Audio type, not a wrapper —
so nothing here dictates what you encode it with, or whether you encode it at
all. Play it, meter it, hand it to a worker.

If you do want a file: WAV is a 44-byte header and a sample loop, about thirty
lines, and worth writing yourself before taking a dependency. Past that,
[mediabunny](https://mediabunny.dev) is the one to pair with — WAV and AAC ride
on WebCodecs, while MP3 and FLAC need its `@mediabunny/mp3-encoder` and
`@mediabunny/flac-encoder` packages, because WebCodecs encodes neither.
ffmpeg.wasm covers every format at around thirty megabytes.

Whichever you pick, this package will not grow an encoder.

## Framework bindings

The reactive surface is the smallest contract every UI library already speaks:
`subscribe(cb) => unsubscribe`, plus a getter returning a primitive.

**React, Preact, Next**

```tsx
import { useClockTime, useIsPlaying } from "playmix/react";

function Playhead({ clock }) {
  const t = useClockTime(clock);   // re-renders at frame rate
  return <div style={{ left: t * pxPerSecond }} />;
}
```

`useIsPlaying` is bound to the transport channel, not the frame channel — a play
button shouldn't re-render sixty times a second to observe a boolean that
changed twice.

**Svelte, SvelteKit**

```svelte
<script>
  import { timeStore } from "playmix";
  const time = timeStore(engine.clock);
</script>

<div style="left: {$time * pxPerSecond}px" />
```

**Vue, Nuxt**

```ts
const t = shallowRef(engine.time());
onScopeDispose(engine.subscribe(() => { t.value = engine.time(); }));
```

**Solid, Angular, Astro islands, vanilla** — `subscribe` returns its own
unsubscribe, which is all a `createSignal` effect or an `ngOnDestroy` needs.

### Server rendering

Nothing is touched at import time and nothing in the constructor reaches for the
platform: the `AudioContext` is created on first use, media elements on first
`setTimeline`. Building an engine during a server render is harmless — only
playback needs a browser. There is [a suite](test/ssr.test.ts) that runs in plain
Node, where `document`, `window`, `AudioContext` and `requestAnimationFrame`
genuinely do not exist.

## How it stays smooth

These are the decisions that separate a smooth timeline from a stuttering one.

**The clock cannot drift.** Time is recomputed every frame as
`playStartTime + (now - wallStart) / 1000`, never accumulated as `time += dt`.
An accumulating clock turns each dropped frame into permanent error, so a
timeline that stutters once is offset from its own audio for the rest of the
take. Recomputing costs a dropped frame exactly one frame.

**Drift correction is graduated.** `syncTo()` lets a decoded video frame pull the
clock toward reality. Small corrections are absorbed into `playStartTime` so the
playhead converges invisibly; corrections past 250 ms — a stall, a seek — are
honoured immediately, because pretending a quarter-second gap isn't there is
worse than showing it.

**Cuts are pre-buffered, not discovered.** Every tick scans 1.5 s ahead and
seeks upcoming clips to their in-point so the first frame is already decoded.
They are deliberately *not* started: playing early advances the element past its
in-point and forces a backward seek at the cut, stalling the decoder — the exact
glitch the look-ahead exists to prevent.

**Seek storms are rate-limited.** A 150 ms nudge threshold and a 50 ms floor
between seeks. Tighter values make the scheduler chase its own decode latency.
The seek *at* a cut bypasses both, because a correct first frame matters more
there than decoder politeness.

**Overlapping clips crossfade unless you say otherwise.** Two audio clips that
overlap on one track are mixed with an equal-power crossfade; set
`stackOverlaps: false` on the timeline for a hard cut instead. The default lives
in exactly one function, `crossfadesEnabled`, because the scheduler, the
renderer and the meters all have to resolve an omitted flag the same way — when
they each spelled it themselves, they didn't.

**Pooling is per clip, not per asset.** Two clips can reference one file at
different points and may overlap; sharing an element would mean sharing a
playback head. Audio routes through Web Audio gain nodes because
`HTMLMediaElement.volume` is clamped to `[0, 1]`, so a 150% clip is
unrepresentable on the element.

## Scope

**In:** the clock, the scheduler, the element pool, the audio graph, the mix
model (gain, envelopes, fades, equal-power crossfades, solo/mute), and offline
audio render.

**Out, deliberately:**

| Not this | Use instead |
|---|---|
| Encoding, muxing, format conversion | your own WAV writer, or [mediabunny](https://mediabunny.dev) |
| Pixel compositing, transforms, effects, text | [WebAV](https://github.com/WebAV-Tech/WebAV) |
| Timeline UI, waveform canvas, drag and drop | yours |
| The timeline data model | yours |

Being honest about one limit: the mix model covers **audio**. Video clips carry
gain and are scheduled for playback, but two overlapping video clips do not
crossfade, and video is not part of the offline render. Compositing frames is a
different problem with a different architecture.

## API

| Export | What it is |
|---|---|
| `createEngine(opts)` | Clock, graph, pool and scheduler, wired with one teardown |
| `createClock(opts)` | The transport on its own. Injectable `TimeSource` |
| `createAudioGraph(opts)` | Track buses, master, analysers. Lazy `AudioContext` |
| `createMediaPool(graph)` | Per-clip elements and gain nodes |
| `createScheduler(opts)` | The look-ahead scheduler |
| `renderMix(timeline, opts)` | Offline mixdown → `AudioBuffer` |
| `timeStore` / `playingStore` | Svelte-contract stores |
| `playmix/react` | `useClockTime`, `useIsPlaying` |
| `playmix/mix` | The mix model directly, for meters and overlays |
| `playmix/testing` | `ManualTimeSource`, `RecordingGainNode`, `FakePool` |

Every piece is independently constructible. `createEngine` exists because the
wiring has a correct order and a required teardown, and copying that into each
consumer invites drift.

## Testing

`playmix/testing` ships the fixtures this package's own suite uses, because a
host extending the scheduler needs the same ones — and re-implementing them per
consumer is how two codebases end up disagreeing about correct behaviour.

```ts
import { ManualTimeSource } from "playmix/testing";

const time = new ManualTimeSource();
const clock = createClock({ timeSource: time, reviveOnVisible: false });

clock.play();
time.advance(1000);
expect(clock.time()).toBeCloseTo(1);   // exact, instant, no wall clock
```

## Development

```bash
npm install     # installs typescript, and react to type the adapter against
npm run verify  # typecheck, test, build
```

Sources import each other with `.ts` extensions so `node --test` runs them with
no build step; emit rewrites those to `.js`. Don't "fix" the specifiers.

## License

MIT
