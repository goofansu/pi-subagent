import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelledEnding,
  failedEnding,
  redactedDiagnostic,
  runDiagnostic,
} from "../domain/index.ts";
import { fixtureResult } from "../testing/presentation-fixtures.ts";
import { formatResult } from "./run-card.ts";

function assertResultEndsWith(
  result: Parameters<typeof formatResult>[0],
  text: string,
) {
  assert.ok(formatResult(result).endsWith(text));
}

test("a completed result preserves its output exactly", () => {
  const output = "Line one\n\n  indented\ttabbed\n";

  assertResultEndsWith(fixtureResult({ finalOutput: output }), output);
});

test("a completed result with no output plainly says so", () => {
  assertResultEndsWith(fixtureResult({}), "The Run finished without output.");
});

test("a completed Result says when all final output was removed", () => {
  const result = fixtureResult({
    diagnostics: [
      runDiagnostic("backend-failure", "an earlier attempt failed"),
    ],
    truncation: { truncatedOutputBytes: 1_234 },
  });

  assertResultEndsWith(result, "No final output remains in the Result.");
  assert.doesNotMatch(formatResult(result), /without output/i);
});

test("the full result text names the agent, the Subagent, and the Run", () => {
  assert.equal(
    formatResult(fixtureResult({ finalOutput: "done" })),
    [
      "explore (subagent subagent-1), run run-1:",
      "look around · pi · completed in 12.4s",
      "",
      "done",
    ].join("\n"),
  );
});

test("a failed result labels its partial output", () => {
  assertResultEndsWith(
    fixtureResult({
      ending: failedEnding("the backend refused"),
      finalOutput: "  half an answer  ",
    }),
    "This Run failed before completing.\n\n" +
      "Failure: the backend refused\n\n" +
      "Output produced before failure:\n\n  half an answer  ",
  );
});

test("whitespace-only output is visibly absent for every terminal status", () => {
  const cases = [
    {
      result: fixtureResult({ finalOutput: "  \n\t " }),
      absent: /finished without output/,
    },
    {
      result: fixtureResult({
        ending: failedEnding("boom"),
        finalOutput: "  \n\t ",
      }),
      absent: /failed before producing output/,
    },
    {
      result: fixtureResult({
        ending: cancelledEnding("shutdown"),
        finalOutput: "  \n\t ",
      }),
      absent: /cancelled before producing output \(shutdown\)/,
    },
  ];

  for (const { result, absent } of cases) {
    const text = formatResult(result);
    assert.match(text, absent);
    assert.doesNotMatch(text, /Output produced before/);
  }
});

test("a failed result with nothing to show plainly says so", () => {
  assertResultEndsWith(
    fixtureResult({ ending: failedEnding("boom") }),
    "This Run failed before completing.\n\n" +
      "Failure: boom\n\n" +
      "The Run failed before producing output.",
  );
});

test("a failed Result keeps its failure when all final output was removed", () => {
  const text = formatResult(
    fixtureResult({
      ending: failedEnding("boom"),
      truncation: { truncatedOutputBytes: 17 },
    }),
  );

  assert.ok(
    text.endsWith(
      "This Run failed before completing.\n\n" +
        "Failure: boom\n\n" +
        "No final output remains in the Result.",
    ),
  );
  assert.doesNotMatch(text, /before producing output/);
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
  assert.match(formatResult(result), /Failure: \[redacted\]/);
});

test("a failed result with neither a message nor a failure diagnostic omits the failure line", () => {
  const result = fixtureResult({
    ending: failedEnding(),
    diagnostics: [runDiagnostic("late-event", "late")],
  });

  assertResultEndsWith(
    result,
    "This Run failed before completing.\n\n" +
      "The Run failed before producing output.",
  );
});

test("a cancelled result labels its partial output and names its reason", () => {
  assertResultEndsWith(
    fixtureResult({
      ending: cancelledEnding("requested"),
      finalOutput: "half an answer",
    }),
    "This Run was cancelled before finishing (requested).\n\n" +
      "Output produced before cancellation:\n\nhalf an answer",
  );
});

test("a cancelled result with nothing to show plainly says so", () => {
  assertResultEndsWith(
    fixtureResult({ ending: cancelledEnding("shutdown") }),
    "The Run was cancelled before producing output (shutdown).",
  );
});

test("a cancelled Result keeps its reason when all final output was removed", () => {
  const text = formatResult(
    fixtureResult({
      ending: cancelledEnding("requested"),
      truncation: { truncatedOutputBytes: 17 },
    }),
  );

  assert.ok(
    text.endsWith(
      "This Run was cancelled before finishing (requested).\n\n" +
        "No final output remains in the Result.",
    ),
  );
  assert.doesNotMatch(text, /before producing output/);
});

test("a retained output prefix keeps status-specific framing and its warning", () => {
  for (const result of [
    fixtureResult({
      finalOutput: "answer pre",
      truncation: { truncatedOutputBytes: 4 },
    }),
    fixtureResult({
      ending: failedEnding("boom"),
      finalOutput: "answer pre",
      truncation: { truncatedOutputBytes: 4 },
    }),
    fixtureResult({
      ending: cancelledEnding("timeout"),
      finalOutput: "answer pre",
      truncation: { truncatedOutputBytes: 4 },
    }),
  ]) {
    const text = formatResult(result);
    assert.match(text, /4 bytes of the final output were cut\./);
    assert.match(text, /answer pre/);
    assert.doesNotMatch(text, /No final output remains/);
  }
});

test("Transcript evidence is never promoted into truncated-away final output", () => {
  for (const transcript of [
    [],
    [
      {
        role: "assistant" as const,
        parts: [
          { kind: "text" as const, text: "supporting transcript answer" },
        ],
      },
    ],
  ]) {
    const cases = [
      {
        status: "completed",
        result: fixtureResult({
          transcript,
          truncation: { truncatedOutputBytes: 23 },
        }),
        context: /look around · pi · completed/,
      },
      {
        status: "failed",
        result: fixtureResult({
          ending: failedEnding("boom"),
          transcript,
          truncation: { truncatedOutputBytes: 23 },
        }),
        context: /Failure: boom/,
      },
      {
        status: "cancelled",
        result: fixtureResult({
          ending: cancelledEnding("requested"),
          transcript,
          truncation: { truncatedOutputBytes: 23 },
        }),
        context: /cancelled before finishing \(requested\)/,
      },
    ];

    for (const { status, result, context } of cases) {
      const text = formatResult(result);
      assert.match(text, new RegExp(`look around · pi · ${status}`));
      assert.match(text, context);
      assert.match(text, /No final output remains in the Result\./);
      assert.doesNotMatch(
        text,
        /finished without output|before producing output/,
      );
      if (transcript.length === 0)
        assert.doesNotMatch(text, /supporting transcript answer/);
      else assert.match(text, /assistant: supporting transcript answer/);
    }
  }
});
