/**
 * Test helpers, shipped rather than kept private.
 *
 * A host that extends the scheduler or wraps the mix model needs the same
 * fixtures this package's own suite uses — a clock it can advance by hand, a
 * gain node it can read back, a pool that records commands. Re-implementing
 * them per consumer is how two codebases end up disagreeing about what correct
 * behaviour looks like.
 */

export { RecordingGainNode, RecordingParam, asGainNode } from "./automation.ts";
export { ManualTimeSource } from "./manual-time.ts";
export { FakeGraph, FakePool, asGraph, asPool, type Command } from "./fake-media.ts";
