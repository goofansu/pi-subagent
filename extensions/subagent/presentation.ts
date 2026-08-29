/**
 * Presentation: how run state, notifications, and retained results read.
 *
 * This is the one module that produces model-facing prose about runs,
 * including lifecycle tones and phrases, notifications, and tool outcomes.
 * Surfaces compose their own lines from what this module hands them; none of
 * them decides what a status means. Adding or renaming a status is a change
 * here, and the exhaustive table below turns the old cross-module hunt into a
 * compile error.
 */

import type { SteerOutcome } from "./delivery.ts";
import { getFinalOutput } from "./messages.ts";
import type {
  LifecycleStatus,
  SingleResult,
  TerminalLifecycleStatus,
  Tone,
  UsageStats,
} from "./types.ts";

/** Maximum characters of completed output included in a notification. */
export const NOTIFICATION_PREVIEW_CHARACTER_LIMIT = 1_000;

const CANCELLED_WITHOUT_OUTPUT =
  "The run was cancelled before producing output.";

/**
 * What each status looks and sounds like, in one place.
 *
 * `verb` is the collapsed notification line's status word. `phrase` narrates
 * the same status next to its duration.
 */
const STATUS_PRESENTATION: Record<
  LifecycleStatus,
  {
    tone: Tone;
    verb: string;
    phrase: (duration: string) => string;
  }
> = {
  running: {
    tone: "warning",
    verb: "running",
    // No duration: a live clock would need a once-a-second redraw of the
    // whole widget, and the settled phrases already say what a run cost in
    // time once that number stops moving.
    phrase: () => "running",
  },
  completed: {
    tone: "success",
    verb: "completed",
    phrase: (duration) => `completed in ${duration}`,
  },
  failed: {
    tone: "error",
    verb: "failed",
    phrase: (duration) => `failed after ${duration}`,
  },
  cancelled: {
    tone: "error",
    verb: "cancelled",
    phrase: (duration) => `cancelled after ${duration}`,
  },
};

/** Lifecycle order used by display summaries and the widget rows. */
export const LIFECYCLE_STATUS_ORDER = Object.freeze(
  Object.keys(STATUS_PRESENTATION) as LifecycleStatus[],
);

/** The theme colour a status should be painted in. */
export function runStatusTone(status: LifecycleStatus): Tone {
  return STATUS_PRESENTATION[status].tone;
}

/** The word a collapsed notification says about a run. */
export function notificationVerb(status: LifecycleStatus): string {
  return STATUS_PRESENTATION[status].verb;
}

/** A run's lifecycle in words, with the time it took. */
export function formatRunStatus(run: {
  status: LifecycleStatus;
  elapsedMs: number;
}): string {
  return STATUS_PRESENTATION[run.status].phrase(formatDuration(run.elapsedMs));
}

/** A duration for humans: tenths under a minute, then m/s, then h/m. */
export function formatDuration(milliseconds: number): string {
  const clampedMilliseconds = Math.max(0, milliseconds);
  const tenths = Math.round(clampedMilliseconds / 100);
  if (tenths < 60 * 10) return `${(tenths / 10).toFixed(1)}s`;

  const wholeSeconds = Math.round(clampedMilliseconds / 1000);
  if (wholeSeconds < 60 * 60) {
    return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
  }

  const hours = Math.floor(wholeSeconds / (60 * 60));
  const minutes = Math.floor((wholeSeconds % (60 * 60)) / 60);
  return `${hours}h ${minutes}m`;
}

/** A character count for a summary line, abbreviated once it gets long. */
export function formatCharacterCount(characters: number): string {
  if (characters < 1_000) return `${characters} characters`;
  return `${(characters / 1_000).toFixed(1)}k characters`;
}

/** Deterministic head preview, preferring a nearby newline before the limit. */
function notificationPreview(text: string): string {
  if (text.length <= NOTIFICATION_PREVIEW_CHARACTER_LIMIT) return text;
  const candidate = text.slice(0, NOTIFICATION_PREVIEW_CHARACTER_LIMIT);
  const newline = candidate.lastIndexOf("\n");
  const cut =
    newline >= NOTIFICATION_PREVIEW_CHARACTER_LIMIT * 0.7
      ? newline
      : NOTIFICATION_PREVIEW_CHARACTER_LIMIT;
  return `${text.slice(0, cut)}\n…`;
}

/**
 * Everything a run said, before any cap is applied.
 *
 * The field priority for a failure — `errorMessage`, then `stderr`, then the
 * transcript — is the executor's population order read back, and this module
 * is the only reader that knows it.
 */
export function fullOutput(result: SingleResult): string {
  const output = getFinalOutput(result.messages);
  switch (result.lifecycle.phase) {
    case "running":
      return "";
    case "completed":
      return output;
    case "failed":
      return formatFailedOutput(result.errorMessage, result.stderr, output);
    case "cancelled": {
      const partialOutput = output.trim();
      return partialOutput
        ? `This run was cancelled before finishing.\n\nOutput produced before cancellation:\n\n${partialOutput}`
        : CANCELLED_WITHOUT_OUTPUT;
    }
  }
}

function formatFailedOutput(
  errorMessage: string | undefined,
  stderr: string,
  output: string,
): string {
  const partialOutput = output.trim();
  const sections = ["This run failed before completing."];
  if (errorMessage) sections.push(`Failure: ${errorMessage}`);
  if (stderr) sections.push(`Diagnostics:\n\n${stderr}`);
  sections.push(
    partialOutput
      ? `Output produced before failure:\n\n${partialOutput}`
      : "The run failed before producing output.",
  );
  return sections.join("\n\n");
}

export interface WaitPresentationOutcome {
  terminal: readonly {
    id: string;
    agent: string;
    phase: TerminalLifecycleStatus;
    reason?: "requested" | "shutdown";
  }[];
  stillRunning: readonly string[];
  unknown: readonly string[];
}

/** The unknown-agent diagnostic shown at the agent_start boundary. */
export function formatUnknownAgent(
  name: string,
  available: readonly string[],
): string {
  return `Unknown agent: "${name}". Available: ${available.join(", ") || "none"}`;
}

/** The lifecycle-only body returned by agent_wait. */
export function formatWaitOutcome(outcome: WaitPresentationOutcome): string {
  const sections = outcome.terminal.map(
    (run) =>
      `${run.agent} (${run.id}): ${run.phase}${
        run.reason ? ` (${run.reason})` : ""
      }`,
  );
  if (outcome.stillRunning.length > 0)
    sections.push(`Still running: ${outcome.stillRunning.join(", ")}.`);
  if (outcome.unknown.length > 0)
    sections.push(`Unknown run ids: ${outcome.unknown.join(", ")}.`);
  if (sections.length === 0) sections.push("No run ids were given.");
  return sections.join("\n\n");
}

export interface RetainedResultPresentation {
  id: string;
  agent: string;
  status: TerminalLifecycleStatus;
  output: string;
  evicted?: boolean;
}

/** The body agent_result presents for a retained result. */
export function formatResultBody(result: RetainedResultPresentation): string {
  if (result.output) return result.output;
  if (result.evicted)
    return "This run's full output was evicted to bound result-store memory.";
  return "The run finished without output.";
}

/** The complete agent_result text, including the stable run identity. */
export function formatResult(result: RetainedResultPresentation): string {
  return `${result.agent} (${result.id}):\n\n${formatResultBody(result)}`;
}

/** The result and notification text for a rejected executor promise. */
export function formatExecutorRejection(
  id: string,
  agent: string,
  message: string,
): { output: string; notification: string } {
  return {
    output: formatFailedOutput(message, "", ""),
    notification: formatFailedNotification(id, agent, message),
  };
}

function resultPointer(id: string): string {
  return `Use agent_result with id ${id} to retrieve the full result.`;
}

function formatFailedNotification(
  id: string,
  agent: string,
  message: string | undefined,
): string {
  const reason = notificationPreview(message || "no reason reported");
  return `Subagent ${agent} (${id}) failed: ${reason}\n\n${resultPointer(id)}`;
}

/** The error used when a notification is accidentally built for a live run. */
export function formatRunningNotificationError(id: string): string {
  return `Cannot notify for running subagent ${id}`;
}

/** The immediate response from agent_start. */
export function formatStartResult(agent: string, id: string): string {
  return (
    `Started ${agent} as run ${id}. ` +
    "Its notification will arrive when it finishes; carry on until then."
  );
}

export interface CancelPresentationOutcome {
  cancelled: readonly string[];
  alreadySettling: readonly string[];
  finished: readonly string[];
  unknown: readonly string[];
}

/** The immediate response from agent_cancel. */
export function formatCancelOutcome(
  outcome: CancelPresentationOutcome,
): string {
  const parts: string[] = [];
  if (outcome.cancelled.length > 0)
    parts.push(`Cancelled: ${outcome.cancelled.join(", ")}.`);
  if (outcome.alreadySettling.length > 0)
    parts.push(`Already settling: ${outcome.alreadySettling.join(", ")}.`);
  if (outcome.finished.length > 0)
    parts.push(
      `Already finished, result kept: ${outcome.finished.join(", ")}.`,
    );
  if (outcome.unknown.length > 0)
    parts.push(`Unknown run ids: ${outcome.unknown.join(", ")}.`);
  if (parts.length === 0) parts.push("Nothing to cancel.");
  return parts.join(" ");
}

/** The immediate response from agent_steer. */
export function formatSteerOutcome(id: string, outcome: SteerOutcome): string {
  switch (outcome) {
    case "accepted":
      return (
        `Steering accepted for run ${id}. The complete message was ` +
        "synchronously admitted to its local bounded mailbox. This does not " +
        "mean the Harness dequeued it, a provider accepted it, or a model " +
        "consumed it. Do not resend this steering message in a retry loop."
      );
    case "invalid":
      return `Cannot steer run ${id}: invalid message. Use non-whitespace text no longer than 16 KiB of UTF-8.`;
    case "unknown run":
      return `Cannot steer run ${id}: unknown run. Check it against what agent_start returned.`;
    case "already completed":
      return `Cannot steer run ${id}: already completed.`;
    case "already failed":
      return `Cannot steer run ${id}: already failed.`;
    case "already cancelled":
      return `Cannot steer run ${id}: already cancelled.`;
    case "not steerable":
      return `Cannot steer run ${id}: it is cancelling or its Control gate is closed.`;
    case "unsupported":
      return `Cannot steer run ${id}: this prepared Run does not support steering.`;
    case "queue full":
      return `Cannot steer run ${id}: its Control mailbox is full. Do not retry steering in a loop.`;
  }
}

/** A missing or still-running result diagnostic. */
export function formatAgentResultUnavailable(
  id: string,
  known: boolean,
): string {
  return known
    ? `Run ${id} has not finished yet. Its notification will arrive on its own; agent_wait blocks until it does.`
    : `No run with id ${id}. Check it against what agent_start returned.`;
}

function formatTokenCount(value: number): string {
  if (Math.abs(value) < 1_000) return String(value);

  const units = ["k", "m", "b", "t"];
  let scaled = value / 1_000;
  let unit = 0;
  while (Math.abs(scaled) >= 1_000 && unit < units.length - 1) {
    scaled /= 1_000;
    unit++;
  }
  // Promote values whose one-decimal rendering crosses the next boundary.
  if (Math.abs(Number(scaled.toFixed(1))) >= 1_000 && unit < units.length - 1) {
    scaled /= 1_000;
    unit++;
  }
  return `${scaled.toFixed(1)}${units[unit]}`;
}

/** The trailing accounting line for a notification, when usage was reported. */
function formatNotificationAccounting(
  usage: UsageStats,
  model: string | undefined,
): string | undefined {
  const parts: string[] = [];
  const roundedCost = Math.round(usage.cost * 10_000) / 10_000;
  if (roundedCost !== 0) parts.push(`cost $${roundedCost.toFixed(4)}`);
  if (usage.input !== 0 || usage.output !== 0) {
    const tokens = [];
    if (usage.input !== 0) tokens.push(`${formatTokenCount(usage.input)} in`);
    if (usage.output !== 0)
      tokens.push(`${formatTokenCount(usage.output)} out`);
    parts.push(tokens.join(" / "));
  }
  if (usage.turns !== 0) {
    parts.push(`${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`);
  }
  // A model identifies reported accounting; it is not accounting by itself.
  if (parts.length > 0 && model) parts.push(model);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Add the accounting line without changing the notification's existing body. */
function appendNotificationAccounting(
  notification: string,
  result: SingleResult,
): string {
  const accounting = formatNotificationAccounting(result.usage, result.model);
  return accounting ? `${notification}\n\n${accounting}` : notification;
}

/** Small status-specific orientation message for one terminal run. */
export function formatNotification(id: string, result: SingleResult): string {
  const name = `${result.agent} (${id})`;
  const pointer = resultPointer(id);

  switch (result.lifecycle.phase) {
    case "running":
      throw new Error(formatRunningNotificationError(id));
    case "completed": {
      const output = getFinalOutput(result.messages).trim();
      const preview = output
        ? notificationPreview(output)
        : "No output was produced.";
      return appendNotificationAccounting(
        `Subagent ${name} completed.\n\n${preview}\n\n${pointer}`,
        result,
      );
    }
    case "failed":
      // Bounded like the completed preview (N1): the primary error is
      // normally short, but nothing upstream guarantees it, and the whole
      // message stays behind agent_result either way.
      return appendNotificationAccounting(
        formatFailedNotification(id, result.agent, result.errorMessage),
        result,
      );
    case "cancelled":
      return appendNotificationAccounting(
        `Subagent ${name} was cancelled (${result.lifecycle.reason}).`,
        result,
      );
  }
}
