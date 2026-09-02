/**
 * The body `agent_result` returns for a retained Result.
 *
 * A Result is a whole answer rather than a sentence, so it has its own module:
 * the three terminal statuses read differently, and a failed or cancelled Run
 * has to label whatever partial output it managed before it stopped. A reader
 * who cannot tell "here is the answer" from "here is what it managed before it
 * died" has been given the wrong thing either way.
 *
 * The primary error for a failed Run is `errorMessage` where the Run reported
 * one, and otherwise the first diagnostic whose category names a failure. That
 * is not diagnostics presentation — the full diagnostic list is M4 — it is
 * finding the one sentence that says what went wrong, so a failed Run with no
 * message still says something.
 */

import type { DiagnosticCategory, RunResult } from "../domain/index.ts";

const CANCELLED_WITHOUT_OUTPUT =
  "The Run was cancelled before producing output.";

const FAILED_WITHOUT_OUTPUT = "The Run failed before producing output.";

const COMPLETED_WITHOUT_OUTPUT = "The Run finished without output.";

/**
 * Diagnostic categories that describe why a Run failed, as opposed to
 * something that merely happened during it.
 *
 * A `late-event` or a `queue-overflow` is a runtime note; a
 * `backend-failure` or a `transport-loss` is the reason a Run has no answer.
 * Only the second kind stands in for a missing error message.
 */
const FAILURE_CATEGORIES: readonly DiagnosticCategory[] = [
  "backend-failure",
  "transport-loss",
  "cleanup-escalation",
];

/** The one sentence that says why a Run failed, if anything does. */
export function primaryFailure(result: RunResult): string | undefined {
  if (result.errorMessage !== undefined && result.errorMessage !== "") {
    return result.errorMessage;
  }
  return result.diagnostics.find((diagnostic) =>
    FAILURE_CATEGORIES.includes(diagnostic.category),
  )?.message;
}

function failedBody(result: RunResult): string {
  const partial = result.finalOutput.trim();
  const failure = primaryFailure(result);
  const sections = ["This Run failed before completing."];
  if (failure !== undefined) sections.push(`Failure: ${failure}`);
  sections.push(
    partial
      ? `Output produced before failure:\n\n${partial}`
      : FAILED_WITHOUT_OUTPUT,
  );
  return sections.join("\n\n");
}

function cancelledBody(result: RunResult): string {
  const partial = result.finalOutput.trim();
  const reason =
    result.cancellationReason === undefined
      ? ""
      : ` (${result.cancellationReason})`;
  if (!partial) return `${CANCELLED_WITHOUT_OUTPUT.slice(0, -1)}${reason}.`;
  return (
    `This Run was cancelled before finishing${reason}.\n\n` +
    `Output produced before cancellation:\n\n${partial}`
  );
}

/** Everything the Run said, labelled by how it stopped saying it. */
export function formatResultBody(result: RunResult): string {
  switch (result.status) {
    case "completed":
      return result.finalOutput || COMPLETED_WITHOUT_OUTPUT;
    case "failed":
      return failedBody(result);
    case "cancelled":
      return cancelledBody(result);
  }
}

/** The complete `agent_result` text, including the stable Run identity. */
export function formatResult(result: RunResult): string {
  return (
    `${result.agent} (subagent ${result.subagentId}), run ${result.runId}:\n\n` +
    formatResultBody(result)
  );
}
