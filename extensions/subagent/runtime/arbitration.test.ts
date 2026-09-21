import assert from "node:assert/strict";
import { test } from "node:test";
import { answeredEnding, failedEnding } from "../domain/index.ts";
import { arbitrate, DEFECT_FALLBACK_MESSAGE } from "./arbitration.ts";

/**
 * The three rules, one test each.
 *
 * These are the races the roadmap names, decided as arithmetic rather than as
 * timing. Every one of them is also a race test later, driven through the
 * supervisor with controlled deferreds — but a race test that fails tells you
 * the interleaving went wrong, and a test here tells you the *rule* is wrong.
 * Both are worth having, and this is the cheaper one to read.
 */

test("a normal return is arbitrated as a decision recorded at return time", () => {
  const decided = arbitrate({
    candidate: { source: "execution-return" },
    decision: {
      source: "recorded-decision",
      bundle: { ending: answeredEnding() },
      beforeStop: true,
    },
    cancellation: { reason: "requested" },
  });

  assert.deepEqual(decided, {
    ending: { ending: "answered" },
    from: "recorded-decision",
  });
});

test("a recorded decision before the first stop wins with its bundle", () => {
  const decided = arbitrate({
    candidate: { source: "interruption", reason: "requested" },
    decision: {
      source: "recorded-decision",
      bundle: { ending: answeredEnding() },
      beforeStop: true,
    },
    cancellation: { reason: "shutdown" },
  });

  assert.deepEqual(decided, {
    ending: { ending: "answered" },
    from: "recorded-decision",
  });
});

test("a first stop before a recorded decision wins with its first reason", () => {
  const decided = arbitrate({
    candidate: { source: "execution-return" },
    decision: {
      source: "recorded-decision",
      bundle: { ending: answeredEnding() },
      beforeStop: false,
    },
    cancellation: { reason: "shutdown" },
  });

  assert.deepEqual(decided, {
    ending: { ending: "cancelled", reason: "shutdown" },
    from: "interruption",
  });
});

test("an execution defect overrides a recorded decision", () => {
  const decided = arbitrate({
    candidate: { source: "defect" },
    decision: {
      source: "recorded-decision",
      bundle: { ending: answeredEnding() },
      beforeStop: true,
    },
  });

  assert.deepEqual(decided, {
    ending: { ending: "failed", message: DEFECT_FALLBACK_MESSAGE },
    from: "defect",
    diagnostic: { category: "backend-failure", message: "[redacted]" },
  });
});

test("a failed decision recorded before stop keeps its failed ending", () => {
  const decided = arbitrate({
    candidate: { source: "execution-return" },
    decision: {
      source: "recorded-decision",
      bundle: { ending: failedEnding("the model refused") },
      beforeStop: true,
    },
    cancellation: { reason: "shutdown" },
  });

  assert.equal(decided.from, "recorded-decision");
  assert.deepEqual(decided.ending, {
    ending: "failed",
    message: "the model refused",
  });
});

test("an interruption without a decision yields cancelled with the first reason", () => {
  const decided = arbitrate({
    candidate: { source: "interruption", reason: "shutdown" },
    // A user cancelled first; shutdown then interrupted the fiber. The reason
    // the Run stopped is the one that was recorded, not the one that got
    // there last.
    cancellation: { reason: "requested" },
  });

  assert.deepEqual(decided, {
    ending: { ending: "cancelled", reason: "requested" },
    from: "interruption",
  });
});

test("an interruption with nothing recorded uses the reason it carried", () => {
  // A Subagent closed during shutdown: the fiber is interrupted without any
  // cancel having been admitted against the Run.
  const decided = arbitrate({
    candidate: { source: "interruption", reason: "shutdown" },
  });

  assert.deepEqual(decided.ending, { ending: "cancelled", reason: "shutdown" });
});

test("a defect yields failed with a redacted diagnostic", () => {
  const decided = arbitrate({ candidate: { source: "defect" } });

  assert.deepEqual(decided, {
    ending: { ending: "failed", message: DEFECT_FALLBACK_MESSAGE },
    from: "defect",
    diagnostic: { category: "backend-failure", message: "[redacted]" },
  });
  // Whatever the adapter threw stays with the adapter: nothing here has a
  // place to put it.
  assert.equal(decided.diagnostic?.message, "[redacted]");
});

test("arbitration is a function of its arguments and nothing else", () => {
  const input = {
    candidate: { source: "execution-return" },
    decision: {
      source: "recorded-decision",
      bundle: { ending: answeredEnding() },
      beforeStop: true,
    },
    cancellation: { reason: "timeout" },
  } as const;

  assert.deepEqual(arbitrate(input), arbitrate(input));
});
