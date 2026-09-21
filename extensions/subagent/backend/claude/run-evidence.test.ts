import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_ATTACHMENT_FAILED_MESSAGE,
  CLAUDE_FRESH_IDENTITY_FAILED_MESSAGE,
  CONTROL_NOT_DELIVERED_CATEGORY,
  createClaudeRunEvidence,
  MISSING_CLAUDE_RESULT_MESSAGE,
  QUERY_FAILED_CATEGORY,
  QUERY_START_CATEGORY,
  RESULT_ERROR_CATEGORY,
  SDK_STDERR_CATEGORY,
} from "./run-evidence.ts";
import { createClaudeTranslator, readClaudeFrame } from "./translate.ts";

const PROMPT_UUID = "prompt-uuid";
const IDENTITY = "11111111-1111-4111-8111-111111111111";
const OTHER_IDENTITY = "22222222-2222-4222-8222-222222222222";

interface ConversationRecorder {
  readonly retained: string[];
  lost: number;
}

function conversation(recorder?: ConversationRecorder) {
  return {
    retain: (identity: string) => recorder?.retained.push(identity),
    lose: () => {
      if (recorder !== undefined) recorder.lost += 1;
    },
  };
}

function evidence(retainedIdentity?: string, recorder?: ConversationRecorder) {
  return createClaudeRunEvidence({
    promptUuid: PROMPT_UUID,
    ...(retainedIdentity === undefined ? {} : { retainedIdentity }),
    conversation: conversation(recorder),
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
    session_id: IDENTITY,
    ...(options.correlation === undefined
      ? {}
      : { user_message_uuid: options.correlation }),
  });
}

function init(identity: unknown = IDENTITY, carriesIdentity = true) {
  return readClaudeFrame({
    type: "system",
    subtype: "init",
    ...(carriesIdentity ? { session_id: identity } : {}),
    model: "claude-sonnet-4-6",
  });
}

function echo(uuid: string, text = "guidance") {
  return readClaudeFrame({
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function toolResult(uuid: string) {
  return readClaudeFrame({
    type: "user",
    uuid,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "done" },
      ],
    },
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

test("a fresh init frame attaches and retains its identity", () => {
  const recorder: ConversationRecorder = { retained: [], lost: 0 };
  const report = evidence(undefined, recorder).read({
    kind: "frame",
    frame: init(),
  });

  assert.equal(report.next.step, "continue");
  assert.deepEqual(recorder.retained, [IDENTITY]);
  assert.equal(recorder.lost, 0);
});

test("a resumed Query drops unflagged history until its Identity boundary", () => {
  const recorder: ConversationRecorder = { retained: [], lost: 0 };
  const fold = evidence(IDENTITY, recorder);

  const history = fold.read({
    kind: "frame",
    frame: assistant("old-turn", "old-model", "old answer"),
  });
  const boundary = fold.read({ kind: "frame", frame: init() });
  const current = fold.read({
    kind: "frame",
    frame: assistant("new-turn", "new-model", "new answer"),
  });

  assert.deepEqual(history.observations, []);
  assert.deepEqual(boundary.observations, [
    { kind: "model", model: "claude-sonnet-4-6" },
  ]);
  assert.equal(messages(current).length, 1);
  assert.deepEqual(recorder.retained, [IDENTITY]);
});

test("a missing, malformed, or different resumed identity fails attachment and loses the Conversation", () => {
  for (const boundary of [
    init(undefined, false),
    init("malformed"),
    init(OTHER_IDENTITY),
  ]) {
    const recorder: ConversationRecorder = { retained: [], lost: 0 };
    const report = evidence(IDENTITY, recorder).read({
      kind: "frame",
      frame: boundary,
    });

    assert.equal(report.next.step, "fatal");
    if (report.next.step === "fatal") {
      assert.deepEqual(report.next.bundle.ending, {
        ending: "failed",
        message: CLAUDE_ATTACHMENT_FAILED_MESSAGE,
      });
    }
    assert.equal(recorder.lost, 1);
    assert.deepEqual(recorder.retained, []);
  }
});

test("a malformed fresh init names the identity failure", () => {
  const recorder: ConversationRecorder = { retained: [], lost: 0 };
  const report = evidence(undefined, recorder).read({
    kind: "frame",
    frame: init("malformed"),
  });

  assert.equal(report.next.step, "fatal");
  if (report.next.step === "fatal") {
    assert.deepEqual(report.next.bundle.ending, {
      ending: "failed",
      message: CLAUDE_FRESH_IDENTITY_FAILED_MESSAGE,
    });
  }
  assert.equal(recorder.lost, 1);
});

test("a replay-flagged frame is dropped", () => {
  const replay = readClaudeFrame({
    ...assistant("replayed", "old-model", "old answer").frame,
    isReplay: true,
  });
  const report = evidence().read({ kind: "frame", frame: replay });

  assert.deepEqual(report.observations, []);
  assert.equal(report.next.step, "continue");
});

test("a user echo confirms guidance while a tool-result user frame does not", () => {
  const confirmed = evidence();
  confirmed.read({
    kind: "control-visible",
    uuid: "control-1",
    text: "mention tests",
  });
  const echoReport = confirmed.read({
    kind: "frame",
    frame: echo("control-1"),
  });

  assert.deepEqual(messages(echoReport), [
    {
      kind: "message",
      role: "user",
      parts: [{ kind: "text", text: "mention tests" }],
    },
  ]);

  const unconfirmed = evidence();
  unconfirmed.read({
    kind: "control-visible",
    uuid: "control-2",
    text: "do not fabricate",
  });
  const toolReport = unconfirmed.read({
    kind: "frame",
    frame: toolResult("control-2"),
  });

  assert.deepEqual(messages(toolReport), [
    {
      kind: "message",
      role: "tool",
      parts: [{ kind: "text", text: "done" }],
    },
  ]);
  assert.equal(unconfirmed.controlSlotFree(), false);
});

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
  assert.equal(timedOut.inputClosed, true);
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
  const resumed = evidence(IDENTITY).read({ kind: "query-threw" });

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

test("a Query start failure is fresh or attachment-sensitive and loses only a resumed Conversation", () => {
  const freshRecorder: ConversationRecorder = { retained: [], lost: 0 };
  const fresh = evidence(undefined, freshRecorder).read({
    kind: "query-start-failed",
  });
  const resumedRecorder: ConversationRecorder = { retained: [], lost: 0 };
  const resumed = evidence(IDENTITY, resumedRecorder).read({
    kind: "query-start-failed",
  });

  assert.equal(fresh.next.step, "fatal");
  if (fresh.next.step === "fatal") {
    assert.deepEqual(fresh.next.bundle.ending, {
      ending: "failed",
      message: `${QUERY_START_CATEGORY}: [redacted]`,
    });
  }
  assert.deepEqual(fresh.observations, [
    {
      kind: "diagnostic",
      diagnostic: {
        category: "backend-failure",
        message: `${QUERY_START_CATEGORY}: [redacted]`,
      },
    },
  ]);
  assert.equal(freshRecorder.lost, 0);

  assert.equal(resumed.next.step, "fatal");
  if (resumed.next.step === "fatal") {
    assert.deepEqual(resumed.next.bundle.ending, {
      ending: "failed",
      message: CLAUDE_ATTACHMENT_FAILED_MESSAGE,
    });
  }
  assert.deepEqual(resumed.observations, fresh.observations);
  assert.equal(resumedRecorder.lost, 1);
});

test("a Query throw on resume loses the Conversation", () => {
  const recorder: ConversationRecorder = { retained: [], lost: 0 };
  const report = evidence(IDENTITY, recorder).read({ kind: "query-threw" });

  assert.equal(report.next.step, "fatal");
  if (
    report.next.step === "fatal" &&
    report.next.bundle.ending.ending === "failed"
  ) {
    assert.equal(
      report.next.bundle.ending.message,
      CLAUDE_ATTACHMENT_FAILED_MESSAGE,
    );
  }
  assert.equal(recorder.lost, 1);
});

test("SDK stderr is diagnosed once with the ending step", () => {
  const fold = evidence();
  const noted = fold.read({ kind: "sdk-stderr" });
  const ended = fold.read({ kind: "frame", frame: result() });
  const interrupted = fold.read({ kind: "interrupted" });

  assert.deepEqual(noted.observations, []);
  assert.equal(ended.next.step, "decided");
  assert.deepEqual(ended.observations.at(-1), {
    kind: "diagnostic",
    diagnostic: {
      category: "backend-failure",
      message: `${SDK_STDERR_CATEGORY}: [redacted]`,
    },
  });
  assert.deepEqual(interrupted.observations, []);
  assert.equal(interrupted.next.step, "decided");
});

test("SDK stderr after terminal evidence is returned with the terminal step", () => {
  const fold = evidence();
  fold.read({ kind: "frame", frame: result() });

  const late = fold.read({ kind: "sdk-stderr" });
  const interrupted = fold.read({ kind: "interrupted" });

  assert.equal(late.next.step, "decided");
  assert.deepEqual(late.observations, [
    {
      kind: "diagnostic",
      diagnostic: {
        category: "backend-failure",
        message: `${SDK_STDERR_CATEGORY}: [redacted]`,
      },
    },
  ]);
  assert.deepEqual(interrupted.observations, []);
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
