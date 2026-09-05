import assert from "node:assert/strict";
import { test } from "node:test";
import { byteLength } from "./bounding.ts";
import {
  answeredEnding,
  cancelledEnding,
  failedEnding,
  RUN_ENDING_KINDS,
  RUN_ENDING_MESSAGE_MAX_BYTES,
  settlementEventForEnding,
  terminalPhaseForEnding,
} from "./endings.ts";
import { backendId, runId, subagentId } from "./ids.ts";
import { createRunProjection, EMPTY_TRUNCATION_RECORD } from "./projection.ts";
import { type RunIdentity, toRunResult } from "./result.ts";
import { EMPTY_USAGE_SNAPSHOT } from "./usage.ts";

const identity: RunIdentity = {
  runId: runId("run-1"),
  subagentId: subagentId("subagent-1"),
  backendId: backendId("fake-resumable"),
  agent: "reviewer",
  description: "review the diff",
};

test("the three endings map to the three terminal phases", () => {
  assert.deepEqual([...RUN_ENDING_KINDS], ["answered", "failed", "cancelled"]);
  assert.equal(terminalPhaseForEnding(answeredEnding()), "completed");
  assert.equal(terminalPhaseForEnding(failedEnding("boom")), "failed");
  assert.equal(
    terminalPhaseForEnding(cancelledEnding("shutdown")),
    "cancelled",
  );
});

test("each ending names the settlement event that reaches its phase", () => {
  assert.equal(settlementEventForEnding(answeredEnding()), "settled-answered");
  assert.equal(settlementEventForEnding(failedEnding()), "settled-failed");
  assert.equal(
    settlementEventForEnding(cancelledEnding("timeout")),
    "settled-cancelled",
  );
});

test("a failed ending's fallback message is one line and bounded", () => {
  assert.deepEqual(failedEnding(), { ending: "failed" });
  assert.deepEqual(failedEnding("  it\nbroke  "), {
    ending: "failed",
    message: "it broke",
  });

  const ending = failedEnding("x".repeat(RUN_ENDING_MESSAGE_MAX_BYTES + 100));

  assert.ok(ending.ending === "failed" && ending.message !== undefined);
  assert.equal(byteLength(ending.message), RUN_ENDING_MESSAGE_MAX_BYTES);
});

test("a result carries the identity, the terminal status, and the projection", () => {
  const projection = {
    ...createRunProjection(),
    transcript: [
      {
        role: "assistant" as const,
        parts: [{ kind: "text" as const, text: "done" }],
      },
    ],
    tools: [{ name: "read_file", status: "completed" as const, callId: "c1" }],
    finalOutput: "done",
    model: "model-a",
  };

  const result = toRunResult({
    identity,
    projection,
    ending: answeredEnding(),
    startedAt: 1_000,
    settledAt: 2_000,
  });

  assert.deepEqual(result, {
    runId: "run-1",
    subagentId: "subagent-1",
    backendId: "fake-resumable",
    agent: "reviewer",
    description: "review the diff",
    status: "completed",
    finalOutput: "done",
    transcript: projection.transcript,
    tools: projection.tools,
    usage: EMPTY_USAGE_SNAPSHOT,
    diagnostics: [],
    links: [],
    model: "model-a",
    startedAt: 1_000,
    settledAt: 2_000,
    truncation: EMPTY_TRUNCATION_RECORD,
  });
});

test("a cancelled result carries its reason and no error message", () => {
  const result = toRunResult({
    identity,
    projection: createRunProjection(),
    ending: cancelledEnding("shutdown"),
    startedAt: 1,
    settledAt: 2,
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.cancellationReason, "shutdown");
  assert.equal("errorMessage" in result, false);
});

test("a failed result carries its message and no cancellation reason", () => {
  const result = toRunResult({
    identity,
    projection: createRunProjection(),
    ending: failedEnding("the backend gave up"),
    startedAt: 1,
    settledAt: 2,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.errorMessage, "the backend gave up");
  assert.equal("cancellationReason" in result, false);
});

test("a Run that settled with no observations fabricates nothing", () => {
  const result = toRunResult({
    identity,
    projection: createRunProjection(),
    ending: cancelledEnding("requested"),
    startedAt: 1,
    settledAt: 2,
  });

  assert.equal(result.finalOutput, "");
  assert.deepEqual(result.transcript, []);
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.usage, EMPTY_USAGE_SNAPSHOT);
  assert.deepEqual(result.diagnostics, []);
  assert.equal("model" in result, false);
});

test("a result is frozen, so a caller that reached it untyped cannot edit it", () => {
  const result = toRunResult({
    identity,
    projection: createRunProjection(),
    ending: answeredEnding(),
    startedAt: 1,
    settledAt: 2,
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.transcript), true);
  assert.equal(Object.isFrozen(result.tools), true);
  assert.equal(Object.isFrozen(result.diagnostics), true);
  assert.equal(Object.isFrozen(result.links), true);
  assert.throws(() => {
    (result as { finalOutput: string }).finalOutput = "rewritten";
  }, TypeError);
});
