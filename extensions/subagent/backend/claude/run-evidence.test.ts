import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_ATTACHMENT_FAILED_MESSAGE,
  CONTROL_NOT_DELIVERED_CATEGORY,
  createClaudeRunEvidence,
  MISSING_CLAUDE_RESULT_MESSAGE,
  QUERY_FAILED_CATEGORY,
  RESULT_ERROR_CATEGORY,
} from "./run-evidence.ts";
import { createClaudeTranslator, readClaudeFrame } from "./translate.ts";

const PROMPT_UUID = "prompt-uuid";

function evidence(resumed = false) {
  return createClaudeRunEvidence({
    promptUuid: PROMPT_UUID,
    resumed,
    translator: createClaudeTranslator(),
  });
}

function result(
  options: {
    readonly correlation?: string;
    readonly error?: boolean;
    readonly text?: string;
  } = {},
) {
  return readClaudeFrame({
    type: "result",
    is_error: options.error === true,
    result: options.text ?? "answer",
    num_turns: 1,
    modelUsage: {},
    ...(options.correlation === undefined
      ? {}
      : { user_message_uuid: options.correlation }),
  });
}

function echo(uuid: string, text = "guidance") {
  return readClaudeFrame({
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function assistant(id: string, model: string, text: string) {
  return readClaudeFrame({
    type: "assistant",
    message: {
      id,
      role: "assistant",
      model,
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
  });
}

function messages(report: ReturnType<ReturnType<typeof evidence>["read"]>) {
  return report.observations.filter(
    (observation) => observation.kind === "message",
  );
}

test("a correlated result confirms provider-visible guidance", () => {
  const fold = evidence();
  fold.read({
    kind: "control-visible",
    uuid: "control-1",
    text: "mention tests",
  });

  const report = fold.read({
    kind: "frame",
    frame: result({ correlation: "control-1" }),
  });

  assert.equal(report.next.step, "decided");
  assert.deepEqual(messages(report)[0], {
    kind: "message",
    role: "user",
    parts: [{ kind: "text", text: "mention tests" }],
  });
});

test("an uncorrelated result discards outstanding guidance and is decided", () => {
  const fold = evidence();
  fold.read({ kind: "control-visible", uuid: "control-1", text: "unseen" });

  const report = fold.read({
    kind: "frame",
    frame: result({ correlation: "foreign" }),
  });

  assert.equal(report.next.step, "decided");
  assert.equal(
    messages(report).some(
      (observation) =>
        observation.kind === "message" && observation.role === "user",
    ),
    false,
  );
  assert.equal(fold.controlSlotFree(), true);
});

test("confirmed guidance can correlate a Turn boundary while later guidance remains outstanding", () => {
  const fold = evidence();
  fold.read({ kind: "control-visible", uuid: "control-1", text: "first" });
  const confirmation = fold.read({ kind: "frame", frame: echo("control-1") });
  assert.equal(messages(confirmation).length, 1);
  fold.read({ kind: "control-visible", uuid: "control-2", text: "second" });

  const boundary = fold.read({
    kind: "frame",
    frame: result({ correlation: "control-1", text: "first answer" }),
  });
  assert.equal(boundary.next.step, "await-turn-boundary");
  assert.equal(boundary.inputClosed, false);

  const final = fold.read({
    kind: "frame",
    frame: result({ correlation: "foreign", text: "second answer" }),
  });
  assert.equal(final.next.step, "decided");
  assert.equal(final.inputClosed, true);
});

test("query end snapshots translated evidence that arrived after a Turn boundary", () => {
  const fold = evidence();
  fold.read({ kind: "control-visible", uuid: "control-1", text: "guidance" });
  const boundary = fold.read({
    kind: "frame",
    frame: result({ correlation: PROMPT_UUID, text: "first answer" }),
  });
  assert.equal(boundary.next.step, "await-turn-boundary");

  const later = fold.read({
    kind: "frame",
    frame: assistant("later-turn", "later-model", "later work"),
  });
  assert.equal(later.next.step, "continue");

  const ended = fold.read({ kind: "query-ended" });
  assert.equal(ended.next.step, "decided");
  if (ended.next.step !== "decided") return;
  assert.deepEqual(ended.next.bundle.reconciliation, {
    turns: 2,
    model: "later-model",
    finalOutput: "first answer",
  });
});

test("a timed-out Turn-boundary wait discards guidance and diagnoses non-delivery", () => {
  const fold = evidence();
  fold.read({ kind: "control-visible", uuid: "control-1", text: "guidance" });
  const boundary = fold.read({
    kind: "frame",
    frame: result({ correlation: PROMPT_UUID }),
  });
  assert.equal(boundary.next.step, "await-turn-boundary");

  const timedOut = fold.read({ kind: "turn-boundary-timeout" });
  assert.equal(timedOut.next.step, "decided");
  if (timedOut.next.step === "decided") {
    assert.deepEqual(timedOut.next.bundle.reconciliation, {
      turns: 1,
      finalOutput: "answer",
    });
  }
  assert.deepEqual(timedOut.observations, [
    {
      kind: "diagnostic",
      diagnostic: {
        category: "control",
        message: `${CONTROL_NOT_DELIVERED_CATEGORY}: [redacted]`,
      },
    },
  ]);
  assert.equal(fold.controlSlotFree(), true);
});

test("an error result is fatal with a confined diagnostic", () => {
  const report = evidence().read({
    kind: "frame",
    frame: result({ error: true, text: "provider detail" }),
  });

  assert.equal(report.next.step, "fatal");
  if (report.next.step !== "fatal") return;
  assert.deepEqual(report.next.bundle.ending, {
    ending: "failed",
    message: `${RESULT_ERROR_CATEGORY}: [redacted]`,
  });
  assert.deepEqual(report.observations.at(-1), {
    kind: "diagnostic",
    diagnostic: {
      category: "backend-failure",
      message: `${RESULT_ERROR_CATEGORY}: [redacted]`,
    },
  });
});

test("a Query ending without a result is fatal with the fixed message", () => {
  const report = evidence().read({ kind: "query-ended" });

  assert.deepEqual(report.next, {
    step: "fatal",
    bundle: {
      ending: { ending: "failed", message: MISSING_CLAUDE_RESULT_MESSAGE },
    },
  });
});

test("a Query throw is fatal and resumed failure keeps the attachment message", () => {
  const fresh = evidence().read({ kind: "query-threw" });
  const resumed = evidence(true).read({ kind: "query-threw" });

  assert.equal(fresh.next.step, "fatal");
  if (fresh.next.step === "fatal") {
    assert.deepEqual(fresh.next.bundle.ending, {
      ending: "failed",
      message: `${QUERY_FAILED_CATEGORY}: [redacted]`,
    });
  }
  assert.equal(resumed.next.step, "fatal");
  if (resumed.next.step === "fatal") {
    assert.deepEqual(resumed.next.bundle.ending, {
      ending: "failed",
      message: CLAUDE_ATTACHMENT_FAILED_MESSAGE,
    });
  }
  assert.equal(fresh.observations.length, 1);
  assert.equal(resumed.observations.length, 1);
});

test("a Control taken after a decision produces nothing", () => {
  const fold = evidence();
  fold.read({ kind: "frame", frame: result() });

  assert.equal(fold.takenControlProducesAnything(), false);
  const ignored = fold.read({
    kind: "control-visible",
    uuid: "too-late",
    text: "too late",
  });
  assert.deepEqual(ignored.observations, []);
});

test("the input is reported closed exactly once", () => {
  const fold = evidence();
  const decided = fold.read({ kind: "frame", frame: result() });
  const ended = fold.read({ kind: "query-ended" });
  const threw = fold.read({ kind: "query-threw" });

  assert.equal(decided.inputClosed, true);
  assert.equal(ended.inputClosed, false);
  assert.equal(threw.inputClosed, false);
});
