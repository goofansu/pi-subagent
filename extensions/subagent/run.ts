/**
 * The run contract: the record, the facts an executor reports into it, and
 * the outcome that settles it.
 *
 * The dispatcher (`runner.ts`) is the run record's only writer. An executor
 * never holds the record: it witnesses what the child did and reports facts —
 * a transcript message, a terminal transcript snapshot, a stderr chunk —
 * through the {@link RunReporter} this module defines, and resolves to a
 * {@link SubagentOutcome}. The fold from facts to record lives here, beside
 * the record it writes, and the dispatcher is the only module that invokes
 * it. Everything derived — usage, activity, the per-message model — is
 * computed in the fold, so a terminal snapshot heals any drift the streamed
 * facts accumulated.
 *
 * See docs/adr/0005-executor-reports-facts.md.
 */

import { deriveActivity } from "./messages.ts";
import type {
  AgentConfig,
  CancellationReason,
  Lifecycle,
  SingleResult,
  UsageStats,
} from "./types.ts";

/**
 * Environment variable transporting the child depth. The dispatcher decides
 * the value and the executor copies it into its child environment, so the key
 * belongs to the contract between them.
 */
export const DEPTH_ENV_KEY = "PI_SUBAGENT_DEPTH";

/**
 * Cap on captured child stderr, in characters.
 *
 * A failing child can emit without bound — a retry loop, a stack trace per
 * line — and this is one string on the parent's heap with no backpressure
 * behind it, so an unbounded capture is a way for a noisy subagent to take the
 * whole pi process down. The tail is what diagnoses a crash anyway: the last
 * thing said before the exit is what explains it.
 */
const STDERR_CAPTURE_LIMIT = 64 * 1024;

const STDERR_TRUNCATION_MARKER = "[... earlier stderr dropped ...]\n";

/** Append a stderr chunk, keeping at most {@link STDERR_CAPTURE_LIMIT}. */
export function appendStderr(existing: string, chunk: string): string {
  const combined = existing + chunk;
  if (combined.length <= STDERR_CAPTURE_LIMIT) return combined;
  // Slicing the tail drops any marker already at the front, so re-prefixing
  // leaves exactly one however many times this runs.
  return (
    STDERR_TRUNCATION_MARKER +
    combined.slice(
      combined.length - STDERR_CAPTURE_LIMIT + STDERR_TRUNCATION_MARKER.length,
    )
  );
}

/** The message a cancelled run reports. */
const CANCELLED_MESSAGE = "Subagent was cancelled";

/**
 * Derive one terminal lifecycle state from the recorded outcome fields.
 *
 * This is where wire vocabulary becomes domain vocabulary: pi and the
 * executor say `aborted`, the domain says `cancelled`, and nothing above
 * this seam sees the wire word.
 */
function terminalLifecycle(
  result: SingleResult,
  outcome: SubagentOutcome,
  finishedAt: number,
  cancellationReason?: CancellationReason,
): Lifecycle {
  const exitCode = outcome.exitCode;
  if (outcome.stopReason === "aborted") {
    return {
      phase: "cancelled",
      finishedAt,
      ...(exitCode === undefined ? {} : { exitCode }),
      reason: cancellationReason ?? "requested",
    };
  }
  const phase =
    exitCode === 0 &&
    outcome.stopReason !== "error" &&
    !result.errorMessage &&
    result.stopReason !== "error"
      ? "completed"
      : "failed";
  return { phase, finishedAt, ...(exitCode === undefined ? {} : { exitCode }) };
}

/**
 * Settle lifecycle state after a run resolves. The executor reports its
 * outcome; the dispatcher calls this once so lifecycle semantics and finish
 * timestamps live in a single place.
 */
export function settleResultLifecycle(
  result: SingleResult,
  outcome: SubagentOutcome,
  finishedAt: number,
  cancellationReason?: CancellationReason,
): void {
  if (result.lifecycle.phase !== "running") {
    throw new Error(
      `Cannot settle a subagent result in '${result.lifecycle.phase}' state`,
    );
  }
  applyOutcome(result, outcome);
  result.lifecycle = terminalLifecycle(
    result,
    outcome,
    finishedAt,
    cancellationReason,
  );
}

/** The caller's model, used when an agent profile does not pin one. */
export interface ParentModel {
  provider: string;
  id: string;
  thinkingLevel?: string;
}

/** Everything needed to run one agent once. */
export interface SubagentTask {
  /** The resolved agent profile. The executor must not mutate it. */
  readonly config: AgentConfig;
  readonly description: string;
  readonly prompt: string;
  /** Working directory for the child. */
  readonly cwd: string;
  /** Nesting depth the executor must copy to its child. */
  readonly childDepth: number;
  /**
   * Pi's project-trust decision for `cwd`, as resolved by the session that is
   * delegating. Forwarded so the child reaches the same answer instead of
   * re-deriving one it cannot: a child runs non-interactively, so it can
   * neither prompt nor see a session-only decision.
   */
  readonly projectTrusted: boolean;
}

/**
 * The facts an executor may report while its child works. This is the whole
 * of the executor's write access to a run: it names what happened, and the
 * fold behind these callbacks decides what the record says.
 */
export type FactRole = "user" | "assistant" | "tool";

export type FactPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; arguments?: Record<string, unknown> };

/**
 * Usage attached to a fact is a delta, except contextTokens is a latest-value
 * gauge.
 */
export interface FactUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  contextTokens?: number;
  turns?: number;
}

/** The only message vocabulary allowed across a harness executor seam. */
export interface Fact {
  role: FactRole;
  parts: FactPart[];
  usage?: FactUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface RunReporter {
  /** One harness-neutral fact the child produced. */
  message(fact: Fact): void;
  /**
   * The child's terminal transcript snapshot, replacing everything streamed
   * so far. The authoritative copy: whatever drift the streamed facts
   * accumulated, this heals it.
   */
  transcript(facts: Fact[]): void;
  /** A chunk of the child's stderr. */
  stderr(chunk: string): void;
}

/**
 * How a run ended, as the executor witnessed it.
 *
 * `stopReason: "aborted"` is the abort marker: only the executor knows
 * whether a cancellation actually killed the child (a late abort after a
 * clean exit must not count), so it travels in the outcome rather than being
 * inferred from the signal. `stopReason` and `errorMessage` are written only
 * when present, so facts already folded from the transcript stand unless the
 * ending says otherwise.
 */
export interface SubagentOutcome {
  /** Absent when the child exited because of a signal. */
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * A run in progress, as the executor sees it: what to do, where to report,
 * and the signal that cancels it. The executor never sees the run record.
 */
export interface SubagentRun {
  readonly task: SubagentTask;
  readonly report: RunReporter;
  readonly signal?: AbortSignal;
}

/**
 * Run the task to completion, reporting facts as output arrives and
 * resolving to the outcome. Rejects only when the run could not be
 * represented as an outcome at all — an aborted or failed agent resolves,
 * with `stopReason: "aborted"` or a non-zero `exitCode`. Cancellation in
 * particular must resolve: the host turns a thrown tool error into a bare
 * error string, discarding the partial transcript the run already reported.
 */
export type SubagentExecutor = (run: SubagentRun) => Promise<SubagentOutcome>;

function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

export function createEmptyResult(
  agent: string,
  description: string,
  startedAt: number,
): SingleResult {
  return {
    agent,
    description,
    lifecycle: { phase: "running" },
    startedAt,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
  };
}

function recordFact(result: SingleResult, fact: Fact): void {
  const usage = fact.usage;
  result.usage.input += usage?.input ?? 0;
  result.usage.output += usage?.output ?? 0;
  result.usage.cacheRead += usage?.cacheRead ?? 0;
  result.usage.cacheWrite += usage?.cacheWrite ?? 0;
  result.usage.cost += usage?.cost ?? 0;
  if (usage?.contextTokens !== undefined) {
    result.usage.contextTokens = usage.contextTokens;
  }
  result.usage.turns += usage?.turns ?? (fact.role === "assistant" ? 1 : 0);
  if (fact.model && !result.model) result.model = fact.model;
  if (fact.stopReason && fact.stopReason !== "aborted") {
    result.stopReason = fact.stopReason;
  }
  if (fact.errorMessage) result.errorMessage = fact.errorMessage;
}

/**
 * The fold from reported facts to record writes, plus a change signal per
 * fact so whatever is on screen follows along. Usage, activity, and the
 * per-message model refinement are derived here rather than reported, so an
 * executor cannot get them wrong and the transcript snapshot heals them.
 */
export function createRunReporter(
  result: SingleResult,
  changed: () => void,
): RunReporter {
  // A model resolved before execution is harness-owned baseline metadata. Any
  // model first witnessed in streamed facts is provisional and must not survive
  // replacement of the transcript unless the authoritative facts repeat it.
  const baselineModel = result.model;
  const fold = (fact: Fact): void => {
    result.messages.push(fact);
    recordFact(result, fact);
  };
  const refreshActivity = (): void => {
    const activity = deriveActivity(result.messages);
    if (activity) result.activity = activity;
    else delete result.activity;
  };

  return {
    message(msg) {
      fold(msg);
      refreshActivity();
      changed();
    },
    transcript(facts) {
      result.messages = [];
      result.usage = emptyUsage();
      delete result.activity;
      // Clear fact-derived model metadata before folding the authoritative
      // snapshot. Restore only the harness-resolved baseline if the snapshot
      // contains no model at all; a terminal fact's model replaces it.
      delete result.model;
      delete result.stopReason;
      delete result.errorMessage;
      for (const fact of facts) fold(fact);
      if (!result.model && baselineModel) result.model = baselineModel;
      refreshActivity();
      changed();
    },
    stderr(chunk) {
      result.stderr = appendStderr(result.stderr, chunk);
      changed();
    },
  };
}

/**
 * Write an outcome onto the record. An aborted outcome is normalized rather
 * than copied: a killed child's exit code says nothing useful, and a frame
 * can report an error the child then recovered from, so the cancellation —
 * not whatever ending the stream happened to hold — is what the run says
 * ended it. The transcript already folded still stands either way.
 */
export function applyOutcome(
  result: SingleResult,
  outcome: SubagentOutcome,
): void {
  if (outcome.stopReason === "aborted") {
    // `aborted` is executor mechanism vocabulary. Cancellation lifecycle and
    // its recorded reason are the only domain representation; neither the
    // result nor presentation may retain the backend stop verb.
    delete result.stopReason;
    result.errorMessage = CANCELLED_MESSAGE;
    return;
  }
  if (outcome.stopReason) result.stopReason = outcome.stopReason;
  // A process-exit diagnostic is only a fallback. An authoritative terminal
  // fact may already contain the provider's more useful explanation.
  if (outcome.errorMessage && !result.errorMessage) {
    result.errorMessage = outcome.errorMessage;
  }
}
