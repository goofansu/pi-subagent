import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunObservation } from "../../domain/index.ts";
import { createPiRunEvidence } from "./run-evidence.ts";
import { type PiTranslatedMessage, translatePiMessage } from "./translate.ts";

function message(
  role: "user" | "assistant" | "tool",
  text: string,
  options: {
    readonly identity?: string;
    readonly goalText?: string;
    readonly outcome?: "answered" | "incomplete" | "failed" | "aborted";
    readonly input?: number;
    readonly output?: number;
    readonly tokens?: number;
    readonly model?: string;
    readonly diagnostic?: boolean;
  } = {},
): PiTranslatedMessage {
  const parts = [{ kind: "text" as const, text }];
  const observations: RunObservation[] = [
    { kind: "message", role, parts },
    ...(role === "assistant" || options.input !== undefined
      ? [
          {
            kind: "usage" as const,
            usage: {
              ...(options.input === undefined ? {} : { input: options.input }),
              ...(options.output === undefined
                ? {}
                : { output: options.output }),
              ...(role === "assistant" ? { turns: 1 } : {}),
            },
          },
        ]
      : []),
    ...(options.tokens === undefined
      ? []
      : [{ kind: "context" as const, context: { tokens: options.tokens } }]),
    ...(options.diagnostic
      ? [
          {
            kind: "diagnostic" as const,
            diagnostic: {
              category: "backend-failure" as const,
              message: "Pi reported a failed message: [redacted]",
            },
          },
        ]
      : []),
  ];
  return {
    semanticIdentity: options.identity ?? `${role}:${text}`,
    ...(options.goalText === undefined ? {} : { goalText: options.goalText }),
    facts: {
      role,
      parts,
      ...(options.input === undefined && options.output === undefined
        ? {}
        : {
            usage: { input: options.input ?? 0, output: options.output ?? 0 },
          }),
      ...(options.tokens === undefined
        ? {}
        : { context: { tokens: options.tokens } }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.diagnostic
        ? {
            diagnostic: {
              category: "backend-failure",
              message: "Pi reported a failed message: [redacted]",
            },
          }
        : {}),
    },
    observations,
    ...(role === "assistant"
      ? { assistantOutcome: options.outcome ?? "answered" }
      : {}),
  };
}

test("Pi Run evidence omits only the first echoed goal", () => {
  const evidence = createPiRunEvidence({ goal: "inspect", baseline: [] });
  const echo = message("user", "inspect", { goalText: "inspect" });
  const equalControl = message("user", "inspect", { goalText: "inspect" });

  assert.deepEqual(evidence.read({ kind: "message", message: echo }), []);
  assert.deepEqual(
    evidence.read({ kind: "message", message: equalControl }),
    equalControl.observations,
  );
});

test("stream deduplication uses references rather than equal content", () => {
  const evidence = createPiRunEvidence({ goal: "goal", baseline: [] });
  const first = message("user", "same", { identity: "equal" });
  const second = message("user", "same", { identity: "equal" });

  assert.deepEqual(
    evidence.read({ kind: "message", message: first }),
    first.observations,
  );
  assert.deepEqual(evidence.read({ kind: "message", message: first }), []);
  assert.deepEqual(
    evidence.read({ kind: "message", message: second }),
    second.observations,
  );
});

test("translated activity and tool readings retain their order", () => {
  const evidence = createPiRunEvidence({ goal: "goal", baseline: [] });
  const activity = { kind: "activity" as const, activity: "reading…" };
  const tools: RunObservation[] = [
    { kind: "tool_progress", callId: "call-1", status: "running" },
    { kind: "activity", activity: "read" },
  ];

  assert.deepEqual(evidence.read({ kind: "activity", observation: activity }), [
    activity,
  ]);
  assert.deepEqual(evidence.read({ kind: "tool", observations: tools }), tools);
});

const outcomes = ["answered", "incomplete", "failed", "aborted"] as const;
const recoveries = ["none", "succeeded", "failed", "aborted"] as const;

for (const outcome of outcomes) {
  for (const recovery of recoveries) {
    test(`normal decision: ${outcome} terminal evidence with ${recovery} recovery`, () => {
      const evidence = createPiRunEvidence({ goal: "goal", baseline: [] });
      const answer = message("assistant", "work", { outcome });
      evidence.read({ kind: "message", message: answer });
      evidence.read({ kind: "terminal", messages: [answer] });
      if (recovery !== "none") {
        evidence.read({ kind: "recovery-start" });
        evidence.read({
          kind: "recovery-end",
          outcome: recovery,
          willRetry: recovery === "succeeded",
        });
      }

      const report = evidence.promptReturned("resolved");
      const requiredRecoveryFailed =
        recovery === "failed" &&
        (outcome === "incomplete" || outcome === "failed");
      assert.equal(
        report.bundle.ending.ending,
        outcome === "answered" ? "answered" : "failed",
      );
      if (report.bundle.ending.ending === "failed") {
        assert.equal(
          report.bundle.ending.message,
          requiredRecoveryFailed
            ? "Pi recovery failed: [redacted]"
            : outcome === "failed"
              ? "Pi reported a failed message: [redacted]"
              : "Pi did not complete its message: [redacted]",
        );
      }
      assert.deepEqual(report.bundle.reconciliation?.finalOutput, "work");
    });
  }
}

test("required recovery failure is diagnosed once and provider detail has no input slot", () => {
  const evidence = createPiRunEvidence({ goal: "goal", baseline: [] });
  const partial = message("assistant", "partial", { outcome: "incomplete" });
  evidence.read({ kind: "message", message: partial });
  evidence.read({ kind: "terminal", messages: [partial] });

  const first = evidence.read({
    kind: "recovery-end",
    outcome: "failed",
    willRetry: false,
  });
  const second = evidence.read({
    kind: "recovery-end",
    outcome: "failed",
    willRetry: false,
  });
  const finish = evidence.promptReturned("resolved");

  assert.deepEqual(first, [
    {
      kind: "diagnostic",
      diagnostic: {
        category: "backend-failure",
        message: "Pi recovery failed: [redacted]",
      },
    },
  ]);
  assert.deepEqual(second, []);
  assert.deepEqual(finish.observations, []);
});

for (const [outcome, messageText] of [
  ["failed", "Pi reported a failed message: [redacted]"],
  ["incomplete", "Pi did not complete its message: [redacted]"],
] as const) {
  test(`${outcome} terminal evidence synthesizes its confined diagnostic`, () => {
    const evidence = createPiRunEvidence({ goal: "goal", baseline: [] });
    const partial = message("assistant", "partial", { outcome });
    evidence.read({ kind: "message", message: partial });
    evidence.read({ kind: "terminal", messages: [partial] });

    assert.deepEqual(evidence.promptReturned("resolved").observations, [
      {
        kind: "diagnostic",
        diagnostic: {
          category: "backend-failure",
          message: messageText,
        },
      },
    ]);
  });
}

test("an observed response diagnostic suppresses its synthetic duplicate", () => {
  const evidence = createPiRunEvidence({ goal: "goal", baseline: [] });
  const failed = message("assistant", "partial", {
    outcome: "failed",
    diagnostic: true,
  });
  const streamed = evidence.read({ kind: "message", message: failed });
  evidence.read({ kind: "terminal", messages: [failed] });

  assert.equal(streamed.filter((one) => one.kind === "diagnostic").length, 1);
  assert.deepEqual(evidence.promptReturned("resolved").observations, []);
});

test("terminal outcome survives malformed assistant message content", () => {
  const evidence = createPiRunEvidence({ goal: "goal", baseline: [] });
  const malformed = translatePiMessage({
    role: "assistant",
    content: { malformed: true },
    stopReason: "error",
  });

  assert.equal(malformed.facts, undefined);
  assert.equal(malformed.assistantOutcome, "failed");
  evidence.read({ kind: "terminal", messages: [malformed] });
  assert.deepEqual(evidence.promptReturned("resolved").bundle.ending, {
    ending: "failed",
    message: "Pi reported a failed message: [redacted]",
  });
});

test("prompt rejection and absent terminal evidence have fixed normal decisions", () => {
  const rejected = createPiRunEvidence({
    goal: "goal",
    baseline: [],
  }).promptReturned("rejected");
  const missing = createPiRunEvidence({
    goal: "goal",
    baseline: [],
  }).promptReturned("resolved");

  assert.deepEqual(rejected, {
    observations: [
      {
        kind: "diagnostic",
        diagnostic: {
          category: "backend-failure",
          message: "Pi prompt failed: [redacted]",
        },
      },
    ],
    bundle: {
      ending: { ending: "failed", message: "Pi prompt failed: [redacted]" },
    },
  });
  assert.deepEqual(missing, {
    observations: [],
    bundle: {
      ending: {
        ending: "failed",
        message:
          "the Pi session finished without a terminal event carrying its messages",
      },
    },
  });
});

test("a later native generation invalidates earlier terminal and recovery state", () => {
  const evidence = createPiRunEvidence({ goal: "goal", baseline: [] });
  const first = message("assistant", "first", { outcome: "incomplete" });
  evidence.read({ kind: "message", message: first });
  evidence.read({ kind: "terminal", messages: [first] });
  evidence.read({ kind: "recovery-end", outcome: "failed", willRetry: false });
  evidence.read({ kind: "execution-start" });
  const second = message("assistant", "second", { outcome: "answered" });
  evidence.read({ kind: "message", message: second });
  evidence.read({ kind: "terminal", messages: [second] });

  const report = evidence.promptReturned("resolved");
  assert.deepEqual(report.observations, []);
  assert.deepEqual(report.bundle.ending, { ending: "answered" });
  assert.equal(report.bundle.reconciliation?.finalOutput, "second");
  assert.equal(report.bundle.reconciliation?.turns, 2);
});

test("terminal reconciliation keeps Run-wide accounting and terminal-frame authority", () => {
  const evidence = createPiRunEvidence({ goal: "goal", baseline: [] });
  const first = message("assistant", "first", {
    identity: "first",
    input: 10,
    output: 2,
    tokens: 100,
    model: "provider/first",
  });
  const streamedSecond = message("assistant", "second", {
    identity: "second",
    input: 20,
    output: 3,
    tokens: 200,
    model: "provider/second",
  });
  const restatedSecond = message("assistant", "second corrected", {
    identity: "second",
    input: 25,
    output: 4,
    tokens: 250,
    model: "provider/final",
  });
  evidence.read({ kind: "message", message: first });
  evidence.read({ kind: "message", message: streamedSecond });
  // Compaction omitted the first message and restated the second occurrence.
  evidence.read({ kind: "terminal", messages: [restatedSecond] });

  assert.deepEqual(evidence.promptReturned("resolved").bundle.reconciliation, {
    finalOutput: "second corrected",
    usage: {
      input: 35,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    },
    turns: 2,
    context: { tokens: 250 },
    model: "provider/final",
  });
});

test("baseline subtraction and restatement consume equal semantic occurrences by count", () => {
  const old = message("assistant", "old", { identity: "same" });
  const evidence = createPiRunEvidence({ goal: "goal", baseline: [old] });
  const streamedOne = message("assistant", "one", {
    identity: "same",
    input: 1,
  });
  const streamedTwo = message("assistant", "two", {
    identity: "same",
    input: 2,
  });
  const rebuiltOld = message("assistant", "old", {
    identity: "same",
    input: 50,
  });
  const restatedOne = message("assistant", "one", {
    identity: "same",
    input: 10,
  });
  const restatedTwo = message("assistant", "two", {
    identity: "same",
    input: 20,
  });
  evidence.read({ kind: "message", message: streamedOne });
  evidence.read({ kind: "message", message: streamedTwo });
  evidence.read({
    kind: "terminal",
    messages: [rebuiltOld, restatedOne, restatedTwo],
  });

  const reconciliation =
    evidence.promptReturned("resolved").bundle.reconciliation;
  assert.equal(reconciliation?.turns, 2);
  assert.equal(reconciliation?.usage?.input, 30);
  assert.equal(reconciliation?.finalOutput, "two");
});

test("native prompt return freezes the normal decision before later readings", () => {
  const evidence = createPiRunEvidence({ goal: "goal", baseline: [] });
  const answer = message("assistant", "answer", { outcome: "answered" });
  evidence.read({ kind: "message", message: answer });
  evidence.read({ kind: "terminal", messages: [answer] });
  const frozen = evidence.promptReturned("resolved");

  const lateFailure = message("assistant", "late", { outcome: "failed" });
  evidence.read({ kind: "execution-start" });
  evidence.read({ kind: "message", message: lateFailure });
  evidence.read({ kind: "terminal", messages: [lateFailure] });

  assert.strictEqual(evidence.promptReturned("rejected"), frozen);
  assert.deepEqual(frozen.bundle.ending, { ending: "answered" });
});
