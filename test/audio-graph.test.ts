/**
 * Context ownership.
 *
 * Browsers cap how many `AudioContext`s a tab may hold open — Chrome
 * historically at six — so a graph that never closes the one it created takes a
 * host that builds and disposes engines across route changes, or under React
 * Strict Mode, from working to silent after a handful of mounts. The failure
 * arrives late, far from its cause, and looks like a browser bug.
 *
 * The other half matters just as much: a context the *host* supplied must be
 * left alone, because the host may still be playing through it.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createAudioGraph } from "../src/audio-graph.ts";

/** Enough of a context for the graph to build a master bus on. */
function fakeContext() {
  const node = () => ({
    connect(target: unknown) {
      return target;
    },
    disconnect() {},
    gain: { setTargetAtTime() {} },
    fftSize: 0,
    smoothingTimeConstant: 0,
  });

  return {
    closed: 0,
    state: "running" as string,
    currentTime: 0,
    destination: {},
    createGain: node,
    createAnalyser: node,
    close(this: { closed: number; state: string }) {
      this.closed++;
      this.state = "closed";
      return Promise.resolve();
    },
  };
}

/** Run `fn` with a global `AudioContext` the graph will construct for itself. */
function withGlobalAudioContext<T>(fn: (created: ReturnType<typeof fakeContext>[]) => T): T {
  const created: ReturnType<typeof fakeContext>[] = [];
  const g = globalThis as { AudioContext?: unknown };
  const had = "AudioContext" in g;
  const previous = g.AudioContext;

  g.AudioContext = function AudioContextStub() {
    const ctx = fakeContext();
    created.push(ctx);
    return ctx;
  } as unknown as typeof AudioContext;

  try {
    return fn(created);
  } finally {
    if (had) g.AudioContext = previous;
    else delete g.AudioContext;
  }
}

describe("audio graph context ownership", () => {
  it("closes a context it created", () => {
    withGlobalAudioContext((created) => {
      const graph = createAudioGraph();
      graph.master();
      assert.equal(created.length, 1, "the graph should have built exactly one context");

      graph.dispose();
      assert.equal(created[0]?.closed, 1, "a graph-owned context must be closed on dispose");
    });
  });

  it("leaves a host-supplied context open", () => {
    const host = fakeContext();
    const graph = createAudioGraph({ context: host as unknown as BaseAudioContext });
    graph.master();
    graph.dispose();
    assert.equal(host.closed, 0, "the host may still be using its own context");
  });

  it("does not close a context it never built", () => {
    withGlobalAudioContext((created) => {
      // Constructing the graph must not reach for the platform at all — that is
      // what makes it safe to build during a server render.
      createAudioGraph().dispose();
      assert.equal(created.length, 0, "dispose must not construct a context in order to close one");
    });
  });

  it("builds a fresh context after dispose rather than reusing a closed one", () => {
    withGlobalAudioContext((created) => {
      const graph = createAudioGraph();
      graph.master();
      graph.dispose();
      graph.master();
      assert.equal(created.length, 2, "a disposed graph must not hand out its closed context");
      assert.equal(created[1]?.state, "running");
    });
  });
});
