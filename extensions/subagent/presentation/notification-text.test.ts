import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backendId,
  byteLength,
  cancelledEnding,
  failedEnding,
  NOTIFICATION_ERROR_MAX_BYTES,
  NOTIFICATION_INLINE_MAX_BYTES,
  NOTIFICATION_MODEL_MAX_BYTES,
  NOTIFICATION_PREVIEW_MAX_BYTES,
  redactedDiagnostic,
  toNotificationAccounting,
} from "../domain/index.ts";
import {
  fixtureNotification,
  fixtureUsage,
} from "../testing/presentation-fixtures.ts";
import {
  formatNotificationAccounting,
  formatNotificationText,
  formatResultPointer,
} from "./notification-text.ts";

test("N-1: a completed notice carries a short output whole, and says nothing further need be fetched", () => {
  const notice = fixtureNotification({ finalOutput: "done" });

  assert.equal(notice.output, "done");
  assert.equal(
    formatNotificationText(notice),
    'Subagent "look around" completed in 12.4s.\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      'Output from the subagent:\n"""\ndone\n"""\n\n' +
      "This is the complete output; nothing further to fetch. agent_result " +
      'with {"id":"run-1"} re-reads it with the transcript.',
  );
});

test("N-1: a whole output keeps its line breaks and its Markdown", () => {
  const output = "# Findings\n\n- one\n- two\n\nDone.";
  const text = formatNotificationText(
    fixtureNotification({ finalOutput: output }),
  );

  assert.match(
    text,
    new RegExp(`"""\n${output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n"""`),
  );
  assert.doesNotMatch(text, /Preview from the subagent/);
});

test("N-1: an output at the inline bound travels whole, and one byte past it is previewed", () => {
  const atBound = fixtureNotification({
    finalOutput: "x".repeat(NOTIFICATION_INLINE_MAX_BYTES),
  });
  const pastBound = fixtureNotification({
    finalOutput: "x".repeat(NOTIFICATION_INLINE_MAX_BYTES + 1),
  });

  assert.equal(byteLength(atBound.output ?? ""), NOTIFICATION_INLINE_MAX_BYTES);
  assert.equal(pastBound.output, undefined);
  assert.match(formatNotificationText(atBound), /nothing further to fetch/);
  assert.match(
    formatNotificationText(pastBound),
    /Preview from the subagent:\n"x+"\n\nThe result is available\. Call agent_result with \{"id":"run-1"\}\.$/,
  );
});

test("N-8: the notice is identical whichever backend ran the Run", () => {
  // The completion Notification is derived from the neutral Result alone, so
  // only the model string — which the Profile chooses — differs between
  // backends.
  const notices = ["pi", "claude", "demo-one-shot"].map((backend) =>
    fixtureNotification({
      finalOutput: "done",
      identity: { backendId: backendId(backend) },
    }),
  );
  const texts = notices.map(formatNotificationText);

  // Structural as well as textual: the notice has no field a backend identity
  // could travel in, so three Results from three backends produce three
  // identical values and not merely three identical sentences.
  assert.deepEqual(new Set(notices.map((n) => JSON.stringify(n))).size, 1);
  assert.equal("backendId" in notices[0], false);
  assert.deepEqual(new Set(texts).size, 1);
  assert.equal(
    texts[0],
    'Subagent "look around" completed in 12.4s.\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      'Output from the subagent:\n"""\ndone\n"""\n\n' +
      "This is the complete output; nothing further to fetch. agent_result " +
      'with {"id":"run-1"} re-reads it with the transcript.',
  );
});

test("a whitespace-only answer is record-only and carries no output fence", () => {
  const notice = fixtureNotification({ finalOutput: "  \n " });
  const text = formatNotificationText(notice);

  assert.equal(notice.resultAvailability, "record-only");
  assert.equal(notice.output, undefined);
  assert.doesNotMatch(text, /"""/);
  assert.match(text, /No output was produced\./);
});

test("N-2: a completed Run with no output has no body, and its record is available", () => {
  // "No output was produced" is said once, by the pointer, and the body is
  // absent rather than repeating it and then promising a full result.
  const text = formatNotificationText(fixtureNotification({}));

  assert.equal(
    text,
    'Subagent "look around" completed in 12.4s.\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      'No output was produced. The Run record is available. Call agent_result with {"id":"run-1"}.',
  );
  assert.equal(text.split("No output was produced").length - 1, 1);
});

test("N-3: a long answer is previewed rather than delivered", () => {
  const notice = fixtureNotification({
    finalOutput: "x".repeat(NOTIFICATION_INLINE_MAX_BYTES + 500),
  });

  assert.equal(notice.output, undefined);
  assert.equal(byteLength(notice.preview), NOTIFICATION_PREVIEW_MAX_BYTES);
  const text = formatNotificationText(notice);
  // The ceiling is the preview's bound plus the fixed sections: a header, a
  // three-line identity block, a pointer, and the label's own 200 bytes.
  assert.ok(text.length < NOTIFICATION_PREVIEW_MAX_BYTES + 400);
  assert.match(text, /Call agent_result with \{"id":"run-1"\}\./);
});

test("N-4: a failed notice states its reason, then the short partial output whole", () => {
  const notice = fixtureNotification({
    ending: failedEnding("the backend refused"),
    finalOutput: "half an answer",
  });

  assert.equal(
    formatNotificationText(notice),
    'Subagent "look around" failed in 12.4s.\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      "Reason: the backend refused\n\n" +
      'Output produced before failure:\n"""\nhalf an answer\n"""\n\n' +
      "This is all the output the Run produced. agent_result with " +
      '{"id":"run-1"} re-reads it with the transcript.',
  );
});

test("N-4: a failed notice with a long partial output states its reason and points at the rest", () => {
  const notice = fixtureNotification({
    ending: failedEnding("the backend refused"),
    finalOutput: "h".repeat(NOTIFICATION_INLINE_MAX_BYTES + 1),
  });

  // The output itself is not in the notice; the pointer says it exists, which
  // is what a model needs to choose between retrying and reading.
  assert.equal(
    formatNotificationText(notice),
    'Subagent "look around" failed in 12.4s.\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      "Reason: the backend refused\n\n" +
      'Partial output is available. Call agent_result with {"id":"run-1"}.',
  );
});

test("N-6: a failed notice bounds a pathological error message", () => {
  const notice = fixtureNotification({
    ending: failedEnding("y".repeat(NOTIFICATION_ERROR_MAX_BYTES + 5_000)),
  });

  assert.equal(
    byteLength(notice.errorMessage ?? ""),
    NOTIFICATION_ERROR_MAX_BYTES,
  );
  assert.ok(
    formatNotificationText(notice).length < NOTIFICATION_ERROR_MAX_BYTES + 400,
  );
});

test("N-5: a failed Run with no reason and no output says both", () => {
  assert.equal(
    formatNotificationText(fixtureNotification({ ending: failedEnding() })),
    'Subagent "look around" failed in 12.4s.\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      "Reason: none reported.\n\n" +
      'No output was produced. The Run record is available. Call agent_result with {"id":"run-1"}.',
  );
});

test("N-7: a cancelled notice names its reason and carries a short partial output whole", () => {
  const notice = fixtureNotification({
    ending: cancelledEnding("requested"),
    finalOutput: "half an answer",
  });

  // A cancelled Run keeps what it produced, and a timeout or a shutdown
  // cancels Runs the parent never asked to cancel — so "the model already
  // knows the id it cancelled" was never true of every cancellation.
  assert.equal(
    formatNotificationText(notice),
    'Subagent "look around" was cancelled in 12.4s (requested).\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      'Output produced before cancellation:\n"""\nhalf an answer\n"""\n\n' +
      "This is all the output the Run produced. agent_result with " +
      '{"id":"run-1"} re-reads it with the transcript.',
  );
});

test("N-7: a cancelled notice with a long partial output points at it", () => {
  const notice = fixtureNotification({
    ending: cancelledEnding("requested"),
    finalOutput: "h".repeat(NOTIFICATION_INLINE_MAX_BYTES + 1),
  });

  assert.equal(
    formatNotificationText(notice),
    'Subagent "look around" was cancelled in 12.4s (requested).\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      'Partial output is available. Call agent_result with {"id":"run-1"}.',
  );
  assert.doesNotMatch(formatNotificationText(notice), /hhhh/);
});

test("a cancelled Run with nothing to show says so and still points at the record", () => {
  assert.equal(
    formatNotificationText(
      fixtureNotification({ ending: cancelledEnding("shutdown") }),
    ),
    'Subagent "look around" was cancelled in 12.4s (shutdown).\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      'No output was produced. The Run record is available. Call agent_result with {"id":"run-1"}.',
  );
});

test("every terminal status ends with the availability sentence and the exact call", () => {
  // The pointer is a section rather than something each status branch
  // appends, so no status can be the one that forgets it.
  for (const ending of [
    undefined,
    failedEnding("boom"),
    cancelledEnding("shutdown"),
  ]) {
    const notice = fixtureNotification(
      ending === undefined
        ? { finalOutput: "done" }
        : { ending, finalOutput: "some" },
    );
    assert.equal(notice.retrieveWith, "agent_result");
    assert.match(
      formatNotificationText(notice),
      /agent_result with \{"id":"run-1"\} re-reads it with the transcript\.$/,
    );
    const long = fixtureNotification(
      ending === undefined
        ? { finalOutput: "d".repeat(NOTIFICATION_INLINE_MAX_BYTES + 1) }
        : {
            ending,
            finalOutput: "s".repeat(NOTIFICATION_INLINE_MAX_BYTES + 1),
          },
    );
    assert.match(
      formatNotificationText(long),
      /(The result|Partial output) is available\. Call agent_result with \{"id":"run-1"\}\.$/,
    );
  }
});

test("N-10: the pointer says what a model will find, in each of the three availabilities", () => {
  const runId = fixtureNotification({}).runId;
  assert.equal(
    formatResultPointer(runId, "complete"),
    'The result is available. Call agent_result with {"id":"run-1"}.',
  );
  assert.equal(
    formatResultPointer(runId, "partial"),
    'Partial output is available. Call agent_result with {"id":"run-1"}.',
  );
  assert.equal(
    formatResultPointer(runId, "record-only"),
    'No output was produced. The Run record is available. Call agent_result with {"id":"run-1"}.',
  );
});

test("N-10: an inlined pointer is a note rather than an instruction, and never says Call", () => {
  const runId = fixtureNotification({}).runId;
  assert.equal(
    formatResultPointer(runId, "complete", true),
    "This is the complete output; nothing further to fetch. agent_result " +
      'with {"id":"run-1"} re-reads it with the transcript.',
  );
  assert.equal(
    formatResultPointer(runId, "partial", true),
    "This is all the output the Run produced. agent_result with " +
      '{"id":"run-1"} re-reads it with the transcript.',
  );
  // Record-only has nothing to inline, so the flag changes nothing.
  assert.equal(
    formatResultPointer(runId, "record-only", true),
    formatResultPointer(runId, "record-only"),
  );
  for (const availability of ["complete", "partial"] as const) {
    assert.doesNotMatch(
      formatResultPointer(runId, availability, true),
      /\bCall\b/,
    );
  }
});

test("N-10: availability is read off the output, not off the status alone", () => {
  // A completed Run with nothing to show is `record-only`, not `complete`:
  // "the result is available" would tell a model an answer is waiting when
  // there is none. A failed or cancelled one is `partial` on either kind of
  // evidence, because a Run stopped mid-answer often has a transcript and no
  // final output.
  assert.equal(
    fixtureNotification({ finalOutput: "done" }).resultAvailability,
    "complete",
  );
  assert.equal(fixtureNotification({}).resultAvailability, "record-only");
  // Availability describes the stored Result, not the Run's success: bounding
  // cut the preview and the Result is still the whole of what was stored.
  assert.equal(
    fixtureNotification({
      finalOutput: "x".repeat(NOTIFICATION_PREVIEW_MAX_BYTES + 500),
    }).resultAvailability,
    "complete",
  );
  assert.equal(
    fixtureNotification({ ending: failedEnding("boom") }).resultAvailability,
    "record-only",
  );
  // Readable work and no answer: a completed Run whose transcript survived its
  // empty final output is partial rather than hidden behind "no output".
  assert.equal(
    fixtureNotification({
      transcript: [
        { role: "assistant", parts: [{ kind: "text", text: "half" }] },
      ],
    }).resultAvailability,
    "partial",
  );
  assert.equal(
    fixtureNotification({ ending: failedEnding("boom"), finalOutput: "half" })
      .resultAvailability,
    "partial",
  );
  assert.equal(
    fixtureNotification({
      ending: cancelledEnding("timeout"),
      transcript: [
        { role: "assistant", parts: [{ kind: "text", text: "half" }] },
      ],
    }).resultAvailability,
    "partial",
  );
});

// ── Accounting ───────────────────────────────────────────────────────────────

test("accounting abbreviates usage and names the model last", () => {
  const notice = fixtureNotification({
    finalOutput: "done",
    usage: fixtureUsage({
      input: 12_300,
      output: 4_500,
      cost: 0.1242,
      turns: 3,
    }),
    model: "claude-sonnet-4-6",
  });

  assert.match(
    formatNotificationText(notice),
    /cost \$0\.1242 · 12\.3k in \/ 4\.5k out · 3 turns · claude-sonnet-4-6$/,
  );
});

test("a token count promotes rather than reading as a thousand of the unit below", () => {
  assert.match(
    formatNotificationText(
      fixtureNotification({
        finalOutput: "done",
        usage: fixtureUsage({ input: 999_950 }),
      }),
    ),
    /\n\n1\.0m in$/,
  );
});

test("accounting omits absent and undisplayed usage facts", () => {
  const cancelled = fixtureNotification({
    ending: cancelledEnding("requested"),
    usage: fixtureUsage({
      cacheRead: 40_000,
      cost: 0.00004,
      context: { tokens: 90_000 },
    }),
    model: "baseline-model",
  });

  // Cache figures, the context gauge, and a cost that rounds to zero are not
  // fields of this line, so a Run that reported only those produces no
  // accounting at all — and a model name alone is not accounting.
  assert.equal(
    formatNotificationText(cancelled),
    'Subagent "look around" was cancelled in 12.4s (requested).\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      'No output was produced. The Run record is available. Call agent_result with {"id":"run-1"}.',
  );
});

test("accounting uses singular turn grammar", () => {
  assert.match(
    formatNotificationText(
      fixtureNotification({
        finalOutput: "done",
        usage: fixtureUsage({ turns: 1 }),
      }),
    ),
    /\n\n1 turn$/,
  );
});

test("completed, failed, and cancelled notices all carry accounting", () => {
  const usage = fixtureUsage({
    input: 12_300,
    output: 4_500,
    cost: 0.1242,
    turns: 3,
  });
  for (const ending of [
    undefined,
    failedEnding("boom"),
    cancelledEnding("requested"),
  ]) {
    const notice = fixtureNotification({
      ...(ending === undefined ? {} : { ending }),
      usage,
      model: "claude-sonnet-4-6",
    });
    assert.match(
      formatNotificationText(notice),
      /cost \$0\.1242 · 12\.3k in \/ 4\.5k out · 3 turns · claude-sonnet-4-6$/,
    );
  }
});

test("N-9: a Run with nothing to account for carries no accounting at all", () => {
  // The absence is on the notice rather than in the formatter, so a surface
  // that forgot to check could not print a line of zeroes.
  assert.equal(fixtureNotification({}).accounting, undefined);
  assert.equal(
    toNotificationAccounting(fixtureUsage({ cacheRead: 40_000 }), "a-model"),
    undefined,
  );
});

test("N-9: the accounting a notice carries is only what the line prints", () => {
  const notice = fixtureNotification({
    finalOutput: "done",
    usage: fixtureUsage({
      input: 12_300,
      output: 4_500,
      cacheRead: 40_000,
      cost: 0.1242,
      turns: 3,
      context: { tokens: 90_000 },
    }),
    model: "claude-sonnet-4-6",
  });

  assert.deepEqual(notice.accounting, {
    inputTokens: 12_300,
    outputTokens: 4_500,
    cost: 0.1242,
    turns: 3,
    model: "claude-sonnet-4-6",
  });
});

test("N-9: an accounting line can never read as nothing but a model name", () => {
  // Structural rather than guarded: a notice only has an accounting value
  // when at least one figure is non-zero, so the formatter has no input that
  // produces a model on its own.
  assert.equal(
    formatNotificationAccounting({
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      turns: 1,
      model: "baseline-model",
    }),
    "1 turn · baseline-model",
  );
});

test("a pathological model name is bounded where the accounting is built", () => {
  const notice = fixtureNotification({
    finalOutput: "done",
    usage: fixtureUsage({ turns: 1 }),
    model: "m".repeat(NOTIFICATION_MODEL_MAX_BYTES + 500),
  });

  assert.equal(
    byteLength(notice.accounting?.model ?? ""),
    NOTIFICATION_MODEL_MAX_BYTES,
  );
});

test("a notice built from a Result never carries provider text", () => {
  const notice = fixtureNotification({
    ending: failedEnding(),
    diagnostics: [redactedDiagnostic("backend-failure")],
  });

  assert.equal(notice.errorMessage, undefined);
  assert.doesNotMatch(formatNotificationText(notice), /redacted/);
});
