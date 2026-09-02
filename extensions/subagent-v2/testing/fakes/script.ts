/**
 * The script vocabulary the fake backends execute.
 *
 * A fake backend with a hard-coded behaviour proves one scenario. A fake
 * backend that reads a script proves as many as there are scripts, and — more
 * importantly — the scenarios stay readable: `awaitControl`, `awaitGate`,
 * `hang`, `defect` say what the scenario is about, where a hand-rolled fake per
 * scenario would bury it.
 *
 * Every wait is on a `Deferred` the test owns. Nothing here sleeps, so no test
 * built on these can be slow or flaky for timing reasons.
 */

import type {
  RunEnding,
  RunObservation,
  TerminalReconciliation,
} from "../../domain/index.ts";

/** Cumulative token counters, as a provider that reports totals would. */
export interface CumulativeUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export type FakeStep =
  /** Report one observation. */
  | { readonly step: "emit"; readonly observation: RunObservation }
  /**
   * Report the ending as an in-stream observation without finishing the
   * script. What comes after it is a *late* observation, which is the point:
   * this is how the late-event rule is exercised at the reducer.
   */
  | { readonly step: "announce-ending"; readonly ending: RunEnding }
  /** Block until the test completes the named gate. */
  | { readonly step: "await-gate"; readonly gate: string }
  /**
   * Take the next Control, and report a user observation only if the script
   * says the provider confirmed the guidance. `confirm: false` is the reject
   * path: the Control was delivered and nothing is fabricated about it.
   */
  | { readonly step: "await-control"; readonly confirm: boolean }
  /**
   * The provider now reports these cumulative totals. The backend differences
   * them against this Run's baseline and reports the difference, which is what
   * a real adapter over a cumulative provider does.
   */
  | { readonly step: "cumulative-usage"; readonly total: CumulativeUsage }
  /** Report the retained conversation again, carrying no usage. */
  | { readonly step: "replay-history" }
  /** Finish with an ending, and a terminal snapshot if this backend has one. */
  | {
      readonly step: "complete";
      readonly ending?: RunEnding;
      readonly reconciliation?: TerminalReconciliation;
    }
  /** Finish with a `failed` ending, the way a well-behaved backend fails. */
  | { readonly step: "fail"; readonly message?: string }
  /** Throw, the way a misbehaving backend fails. The caller classifies it. */
  | { readonly step: "defect"; readonly message: string }
  /** Never finish. Only interruption ends this execution. */
  | { readonly step: "hang" }
  /**
   * Emit one observation from the execution scope's finalizer.
   *
   * A real adapter does this when a provider callback lands during teardown.
   * By then the Run has sealed its intake, so the observation is late and the
   * contract's "emit never fails" has to hold for it anyway.
   */
  | { readonly step: "emit-in-finalizer"; readonly observation: RunObservation }
  /**
   * Hold the execution scope's finalizer open until the test releases it.
   *
   * This is how a test gets a Run that is genuinely in `finalizing`: the
   * execution has ended, the Run has not settled, and the window between them
   * is as wide as the test wants it.
   */
  | { readonly step: "gate-the-finalizer"; readonly gate: string }
  /**
   * Make the execution scope's finalizer never finish.
   *
   * A real adapter can do this by waiting on a provider teardown that never
   * comes. It is what the cleanup budget and its escalation exist for, so the
   * fakes need a way to produce it.
   */
  | { readonly step: "hang-in-finalizer" }
  /** From now on, this conversation cannot be resumed. */
  | { readonly step: "lose-conversation" };

export interface FakeRunScript {
  readonly steps: readonly FakeStep[];
}

/**
 * How the fake behaves when it is opened.
 *
 * `open` is the one part of the contract with a typed failure channel, so it
 * needs its own script rather than a step: nothing about a Run has happened
 * yet, and the two failure modes — refusing and hanging — are both things a
 * real provider does before there is anything to run.
 */
export type FakeOpenScript =
  /** Open normally. The default. */
  | { readonly open: "succeeds" }
  /** Refuse to open, with a reason the adapter would have redacted. */
  | { readonly open: "fails"; readonly reason: string }
  /** Block until the named gate completes, or until interruption. */
  | { readonly open: "hangs"; readonly gate?: string };

/** One script per Run, in order. */
export function scripts(
  ...steps: readonly (readonly FakeStep[])[]
): readonly FakeRunScript[] {
  return steps.map((forRun) => ({ steps: forRun }));
}

/* Small builders, so a scenario reads as a sentence. */

export function emitText(
  text: string,
  role: "assistant" | "user" = "assistant",
): FakeStep {
  return {
    step: "emit",
    observation: { kind: "message", role, parts: [{ kind: "text", text }] },
  };
}

export function emitToolCall(name: string, callId: string): FakeStep {
  return {
    step: "emit",
    observation: {
      kind: "message",
      role: "assistant",
      parts: [{ kind: "tool_call", name, callId }],
    },
  };
}

export function emitToolProgress(
  callId: string,
  status: "running" | "completed" | "failed",
  outputSummary?: string,
): FakeStep {
  return {
    step: "emit",
    observation: {
      kind: "tool_progress",
      callId,
      status,
      ...(outputSummary === undefined ? {} : { outputSummary }),
    },
  };
}

export function emitActivity(activity: string | undefined): FakeStep {
  return { step: "emit", observation: { kind: "activity", activity } };
}
