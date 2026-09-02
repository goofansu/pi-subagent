import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelledEnding,
  failedEnding,
  redactedDiagnostic,
  runDiagnostic,
} from "../domain/index.ts";
import { fixtureResult } from "./fixtures.ts";
import {
  formatResult,
  formatResultBody,
  primaryFailure,
} from "./result-body.ts";

test("a completed result preserves its output exactly", () => {
  const output = "Line one\n\n  indented\ttabbed\n";

  assert.equal(
    formatResultBody(fixtureResult({ finalOutput: output })),
    output,
  );
});

test("a completed result with no output plainly says so", () => {
  assert.equal(
    formatResultBody(fixtureResult({})),
    "The Run finished without output.",
  );
});

test("the full result text names the agent, the Subagent, and the Run", () => {
  assert.equal(
    formatResult(fixtureResult({ finalOutput: "done" })),
    "explore (subagent subagent-1), run run-1:\n\ndone",
  );
});

test("a failed result labels its partial output", () => {
  assert.equal(
    formatResultBody(
      fixtureResult({
        ending: failedEnding("the backend refused"),
        finalOutput: "  half an answer  ",
      }),
    ),
    "This Run failed before completing.\n\n" +
      "Failure: the backend refused\n\n" +
      "Output produced before failure:\n\nhalf an answer",
  );
});

test("a failed result with nothing to show plainly says so", () => {
  assert.equal(
    formatResultBody(fixtureResult({ ending: failedEnding("boom") })),
    "This Run failed before completing.\n\n" +
      "Failure: boom\n\n" +
      "The Run failed before producing output.",
  );
});

test("a failed result with no message falls back to a failure diagnostic", () => {
  const result = fixtureResult({
    ending: failedEnding(),
    diagnostics: [
      runDiagnostic("late-event", "an observation arrived after intake closed"),
      redactedDiagnostic("transport-loss"),
    ],
  });

  // The runtime note is not the reason the Run has no answer; the transport
  // loss is, so that is the one that stands in for the missing message.
  assert.equal(primaryFailure(result), "[redacted]");
  assert.match(formatResultBody(result), /Failure: \[redacted\]/);
});

test("a failed result with neither a message nor a failure diagnostic omits the failure line", () => {
  const result = fixtureResult({
    ending: failedEnding(),
    diagnostics: [runDiagnostic("late-event", "late")],
  });

  assert.equal(primaryFailure(result), undefined);
  assert.equal(
    formatResultBody(result),
    "This Run failed before completing.\n\n" +
      "The Run failed before producing output.",
  );
});

test("a cancelled result labels its partial output and names its reason", () => {
  assert.equal(
    formatResultBody(
      fixtureResult({
        ending: cancelledEnding("requested"),
        finalOutput: "half an answer",
      }),
    ),
    "This Run was cancelled before finishing (requested).\n\n" +
      "Output produced before cancellation:\n\nhalf an answer",
  );
});

test("a cancelled result with nothing to show plainly says so", () => {
  assert.equal(
    formatResultBody(fixtureResult({ ending: cancelledEnding("shutdown") })),
    "The Run was cancelled before producing output (shutdown).",
  );
});
