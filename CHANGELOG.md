# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-01

Initial release. Extracted from a working browser audio workstation rather than
written speculatively, so every constant here was arrived at against real media.

### Added

- **Clock** — drift-free transport with graduated sync correction, loop points,
  and an injectable `TimeSource` for deterministic tests.
- **Scheduler** — look-ahead pre-buffering for glitch-free cuts, seek-rate
  limiting, per-clip command diffing.
- **Media pool** — per-clip elements routed through Web Audio so gain can exceed
  the `[0, 1]` the element allows.
- **Audio graph** — per-track buses with in-series analysers, master bus, lazily
  constructed `AudioContext`.
- **Mix model** — clip gain, volume envelopes, fades, equal-power crossfades,
  solo and mute. Shared by preview, render and metering.
- **Offline render** — `renderMix` to an `AudioBuffer` through that same model.
- **Framework bindings** — Svelte-contract stores in core, React hooks at
  `playmix/react`.
- **Test fixtures** at `playmix/testing`.

### Notes

- Zero runtime dependencies. React is an optional peer, used only by
  `playmix/react`.
- SSR-safe: nothing touches the platform at import or construction time.
- The mix model covers audio. Video is scheduled for playback but does not
  crossfade and is not part of the offline render.
- `stackOverlaps` defaults to `true`: overlapping audio clips on one track
  crossfade unless the timeline opts out. The default is resolved by a single
  function, `crossfadesEnabled`, so preview, export and metering cannot
  disagree about what an omitted flag means.
- `dispose()` closes an `AudioContext` the engine created, and leaves one the
  host supplied open.
