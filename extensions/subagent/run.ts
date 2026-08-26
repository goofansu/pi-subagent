/**
 * The run contract: the record, the facts an executor reports into it, and
 * the ending that settles it.
 *
 * The dispatcher (`runner.ts`) is the run record's only writer. An executor
 * never holds the record: it witnesses what the child did and reports facts —
 * a transcript message, a terminal transcript snapshot, a stderr chunk —
 * through the {@link RunReporter} this module defines, and resolves to a
 * {@link RunEnding}. The fold from facts to record lives here, beside
 * the record it writes, and the dispatcher is the only module that invokes
 * it. Everything derived — usage, activity, the per-message model — is
 * computed in the fold, so a terminal snapshot heals any drift the streamed
 * facts accumulated.
 *
 * See docs/adr/0010-run-endings.md and docs/adr/0005-executor-reports-facts.md.
 */

import { deriveActivity } from "./messages.ts";
import type {
  AgentConfig,
  CancellationReason,
  Lifecycle,
  SingleResult,
  UsageStats,
} from "./types.ts";
import { DEFAULT_HARNESS_NAME } from "./types.ts";

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

// Backend stop vocabulary is understood only while folding facts. It is not a
// domain stop reason and must never be retained on the result.
const ABORTED_STOP_REASON = "aborted";

/**
 * Derive one terminal lifecycle state from the ending and recorded facts.
 * Backend cancellation vocabulary never reaches the domain result.
 */
function terminalLifecycle(
  result: SingleResult,
  ending: RunEnding,
  finishedAt: number,
  cancellationReason?: CancellationReason,
): Lifecycle {
  if (ending.ending === "cancelled") {
    return {
      phase: "cancelled",
      finishedAt,
      reason: cancellationReason ?? "requested",
    };
  }
  if (ending.ending === "failed") return { phase: "failed", finishedAt };
  // An answered ending is demoted only by error state carried by the healed
  // record. This is deliberately the sole completed/failed rule.
  return {
    phase:
      result.errorMessage || result.stopReason === "error"
        ? "failed"
        : "completed",
    finishedAt,
  };
}

/**
 * Settle lifecycle state after a run resolves. The executor reports its
 * ending; the dispatcher calls this once so lifecycle semantics and finish
 * timestamps live in a single place.
 */
export function settleResultLifecycle(
  result: SingleResult,
  ending: RunEnding,
  finishedAt: number,
  cancellationReason?: CancellationReason,
): void {
  if (result.lifecycle.phase !== "running") {
    throw new Error(
      `Cannot settle a subagent result in '${result.lifecycle.phase}' state`,
    );
  }
  applyEnding(result, ending);
  result.lifecycle = terminalLifecycle(
    result,
    ending,
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
export type FactRole = "user" | "assistant" | "tool" | "metadata";

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

/**
 * The only vocabulary allowed across a harness executor seam. Metadata facts
 * carry provider run metadata without pretending the provider emitted a
 * conversational message.
 */
export interface Fact {
  role: FactRole;
  parts: FactPart[];
  usage?: FactUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface RunReporter {
  /**
   * One harness-neutral fact the child produced. The historical message verb
   * also carries metadata facts so the executor seam stays stable.
   */
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

/** The honest terminal resolution of an executor. */
export type RunEnding =
  | { ending: "answered" }
  | { ending: "failed"; errorMessage?: string }
  | { ending: "cancelled" };

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
 * resolving to an ending. Cancellation and backend failures resolve as
 * explicit endings; the dispatcher classifies a thrown executor so partial
 * facts are retained.
 */
export type SubagentExecutor = (run: SubagentRun) => Promise<RunEnding>;

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
  harness = DEFAULT_HARNESS_NAME,
): SingleResult {
  return {
    agent,
    harness,
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
  // Only conversational assistant facts imply a turn. Metadata facts must
  // report a turn explicitly when the provider event represents one.
  result.usage.turns += usage?.turns ?? (fact.role === "assistant" ? 1 : 0);
  // A model reported by a harness fact is authoritative, including when it
  // refines the harness-resolved baseline.
  if (fact.model) result.model = fact.model;
  if (fact.stopReason && fact.stopReason !== ABORTED_STOP_REASON) {
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
  // A model resolved before execution is harness-owned baseline metadata.
  // Streamed model facts are authoritative for the live result, but transcript
  // replacement resets to the baseline and only its facts can refine it.
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
      // Reset to the captured baseline before folding the authoritative
      // snapshot. Terminal facts may replace it; absent or ambiguous evidence
      // leaves the baseline in place, or removes stale metadata when there was
      // no baseline.
      if (baselineModel) result.model = baselineModel;
      else delete result.model;
      delete result.stopReason;
      delete result.errorMessage;
      for (const fact of facts) fold(fact);
      refreshActivity();
      changed();
    },
    stderr(chunk) {
      result.stderr = appendStderr(result.stderr, chunk);
      changed();
    },
  };
}

/** Apply only ending data that belongs on the run record. */
export function applyEnding(result: SingleResult, ending: RunEnding): void {
  if (ending.ending === "cancelled") {
    delete result.stopReason;
    result.errorMessage = CANCELLED_MESSAGE;
    return;
  }
  // A process/source diagnostic is only a fallback. An authoritative fact may
  // already contain the provider's more useful explanation.
  if (
    ending.ending === "failed" &&
    ending.errorMessage &&
    !result.errorMessage
  ) {
    result.errorMessage = ending.errorMessage;
  }
}
