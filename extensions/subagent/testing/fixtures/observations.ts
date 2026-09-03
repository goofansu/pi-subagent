/**
 * Adversarial observation sequences, generated the same way every time.
 *
 * Four things go wrong at a real adapter boundary, and all four are things the
 * reducer must survive rather than things an adapter can be told not to do:
 * a provider replays an occurrence, a usage report arrives after the message
 * it belongs to, a progress update overtakes the call it is about, and a frame
 * turns up after the Run has ended.
 *
 * Generating them here rather than writing them out in each test means the
 * reducer tests and the backend conformance suite feed the *same* adversarial
 * input, so a real adapter is held to what the reducer was proven against.
 *
 * Every generator is pure and seed-driven: the same seed always produces the
 * same sequence, and a failing property loop prints the seed that reproduces
 * it.
 */

import {
  answeredEnding,
  cancelledEnding,
  contextGauge,
  failedEnding,
  type RunObservation,
  resultLink,
  runDiagnostic,
  usageDelta,
} from "../../domain/index.ts";
import { type Seeded, seeded } from "./seeded.ts";

export interface FixtureSequence {
  /** Which adversarial shape this is. */
  readonly name: string;
  readonly seed: number;
  readonly observations: readonly RunObservation[];
}

const TOOL_NAMES = ["read_file", "write_file", "grep", "bash"] as const;

function assistantText(text: string): RunObservation {
  return {
    kind: "message",
    role: "assistant",
    parts: [{ kind: "text", text }],
  };
}

function toolCall(name: string, callId: string): RunObservation {
  return {
    kind: "message",
    role: "assistant",
    parts: [{ kind: "tool_call", name, callId }],
  };
}

/**
 * A provider that replays: one tool call and several progress observations for
 * the same call id, one of them a byte-identical repeat.
 *
 * The tool list must end with exactly one entry for that id.
 */
export function duplicateToolProgress(seed: number): FixtureSequence {
  const random = seeded(seed);
  const callId = `call-${random.int(1_000)}`;
  const name = random.pick(TOOL_NAMES);
  const running: RunObservation = {
    kind: "tool_progress",
    callId,
    status: "running",
  };
  return {
    name: "duplicate-tool-progress",
    seed,
    observations: [
      toolCall(name, callId),
      running,
      running,
      {
        kind: "tool_progress",
        callId,
        status: "completed",
        outputSummary: "ok",
      },
      {
        kind: "tool_progress",
        callId,
        status: "completed",
        outputSummary: "ok",
      },
      assistantText("done"),
      { kind: "ending", ending: answeredEnding() },
    ],
  };
}

/**
 * A backend whose usage reports lag its messages: several messages, then the
 * deltas for them, then a context gauge that supersedes an earlier one.
 *
 * Totals must be the sum of the deltas whenever they arrived, and the gauge
 * must be the last one seen rather than a sum.
 */
export function delayedUsage(seed: number): FixtureSequence {
  const random = seeded(seed);
  const first = random.int(50) + 1;
  const second = random.int(50) + 1;
  return {
    name: "delayed-usage",
    seed,
    observations: [
      assistantText("thinking"),
      { kind: "context", context: contextGauge(1_000) },
      assistantText("still thinking"),
      { kind: "usage", usage: usageDelta({ input: first, turns: 1 }) },
      { kind: "usage", usage: usageDelta({ output: second, turns: 1 }) },
      { kind: "context", context: contextGauge(2_000, 200_000) },
      assistantText("done"),
      { kind: "ending", ending: answeredEnding() },
    ],
  };
}

/**
 * A progress observation that overtakes the tool call it is about.
 *
 * The later call must fill in the placeholder the progress created rather than
 * adding a second entry for the same id.
 */
export function reorderedAtBoundary(seed: number): FixtureSequence {
  const random = seeded(seed);
  const callId = `call-${random.int(1_000)}`;
  const name = random.pick(TOOL_NAMES);
  return {
    name: "reordered-at-boundary",
    seed,
    observations: [
      { kind: "tool_progress", callId, status: "running" },
      {
        kind: "tool_progress",
        callId,
        status: "completed",
        outputSummary: "12 hits",
      },
      toolCall(name, callId),
      assistantText("found them"),
      { kind: "ending", ending: answeredEnding() },
    ],
  };
}

/**
 * Frames that arrive after the Run has ended.
 *
 * Every one of them must be reported as late and change nothing, including the
 * second ending and the reconciliation.
 */
export function lateAfterEnding(seed: number): FixtureSequence {
  const random = seeded(seed);
  const ending = random.chance(0.5)
    ? answeredEnding()
    : cancelledEnding("requested");
  return {
    name: "late-after-ending",
    seed,
    observations: [
      assistantText("the answer"),
      { kind: "usage", usage: usageDelta({ input: 10 }) },
      { kind: "ending", ending },
      assistantText("a frame nobody asked for"),
      { kind: "usage", usage: usageDelta({ input: 1_000 }) },
      { kind: "tool_progress", callId: "call-late", status: "completed" },
      { kind: "activity", activity: "still busy" },
      { kind: "reconciliation", reconciliation: { finalOutput: "rewritten" } },
      { kind: "ending", ending: failedEnding("a second ending") },
    ],
  };
}

/** Every adversarial generator, so a test can cover all of them by name. */
export const FIXTURE_GENERATORS: readonly {
  readonly name: string;
  readonly generate: (seed: number) => FixtureSequence;
}[] = [
  { name: "duplicate-tool-progress", generate: duplicateToolProgress },
  { name: "delayed-usage", generate: delayedUsage },
  { name: "reordered-at-boundary", generate: reorderedAtBoundary },
  { name: "late-after-ending", generate: lateAfterEnding },
];

function randomObservation(random: Seeded, index: number): RunObservation {
  const callId = `call-${random.int(4)}`;
  switch (random.int(9)) {
    case 0:
      return assistantText(`text ${index}`);
    case 1:
      return {
        kind: "message",
        role: "user",
        parts: [{ kind: "text", text: `guidance ${index}` }],
      };
    case 2:
      return toolCall(random.pick(TOOL_NAMES), callId);
    case 3:
      return {
        kind: "tool_progress",
        callId,
        status: random.pick(["running", "completed", "failed"] as const),
        ...(random.chance(0.5) ? { outputSummary: `summary ${index}` } : {}),
      };
    case 4:
      return {
        kind: "usage",
        usage: usageDelta({
          input: random.int(100),
          output: random.int(100),
          turns: random.int(2),
          cost: random.int(10) / 100,
        }),
      };
    case 5:
      return { kind: "context", context: contextGauge(random.int(10_000)) };
    case 6:
      return {
        kind: "diagnostic",
        diagnostic: runDiagnostic("other", `something ${index}`),
      };
    case 7:
      return {
        kind: "activity",
        activity: random.chance(0.2) ? undefined : `doing ${index}`,
      };
    default:
      return {
        kind: "link",
        link: resultLink("log", `log ${index}`, `/tmp/${index}.log`),
      };
  }
}

/**
 * A sequence of arbitrary observations, optionally ending the Run partway
 * through so the absorbing rule is exercised too.
 */
export function randomSequence(seed: number, length = 24): FixtureSequence {
  const random = seeded(seed);
  const observations: RunObservation[] = [];
  const endAt = random.chance(0.5) ? random.int(length) : -1;
  for (let index = 0; index < length; index += 1) {
    if (index === endAt) {
      observations.push({
        kind: "ending",
        ending: random.pick([
          answeredEnding(),
          failedEnding("generated failure"),
          cancelledEnding("requested"),
        ]),
      });
      continue;
    }
    observations.push(randomObservation(random, index));
  }
  return { name: "random", seed, observations };
}
