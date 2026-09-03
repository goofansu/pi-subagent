import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answeredEnding,
  cancelledEnding,
  failedEnding,
} from "../domain/index.ts";
import { arbitrate, DEFECT_FALLBACK_MESSAGE } from "./arbitration.ts";

/**
 * The four rules, one test each.
 *
 * These are the races the roadmap names, decided as arithmetic rather than as
 * timing. Every one of them is also a race test later, driven through the
 * supervisor with controlled deferreds — but a race test that fails tells you
 * the interleaving went wrong, and a test here tells you the *rule* is wrong.
 * Both are worth having, and this is the cheaper one to read.
 */

test("an answered bundle wins over a cancellation that arrived afterwards", () => {
  const decided = arbitrate({
    candidate: { source: "bundle", bundle: { ending: answeredEnding() } },
    cancellation: { reason: "requested" },
  });

  assert.deepEqual(decided, {
    ending: { ending: "answered" },
    from: "bundle",
    late: false,
  });
});

test("a bundle that failed still wins over a cancellation request", () => {
  const decided = arbitrate({
    candidate: {
      source: "bundle",
      bundle: { ending: failedEnding("the model refused") },
    },
    cancellation: { reason: "shutdown" },
  });

  assert.equal(decided.from, "bundle");
  assert.deepEqual(decided.ending, {
    ending: "failed",
    message: "the model refused",
  });
});

test("an interruption before a bundle yields cancelled with the first reason", () => {
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
    late: false,
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
    late: false,
    diagnostic: { category: "backend-failure", message: "[redacted]" },
  });
  // Whatever the adapter threw stays with the adapter: nothing here has a
  // place to put it.
  assert.equal(decided.diagnostic?.message, "[redacted]");
});

test("a bundle ending after an in-stream ending is reported late", () => {
  const decided = arbitrate({
    announced: answeredEnding(),
    candidate: {
      source: "bundle",
      bundle: { ending: failedEnding("said one thing, returned another") },
    },
  });

  assert.deepEqual(decided, {
    ending: { ending: "answered" },
    from: "in-stream",
    late: true,
  });
});

test("an in-stream ending survives a later interruption and a later defect", () => {
  const announced = cancelledEnding("requested");

  const interrupted = arbitrate({
    announced,
    candidate: { source: "interruption", reason: "shutdown" },
  });
  assert.deepEqual(interrupted.ending, announced);
  assert.equal(interrupted.late, true);
  assert.equal(interrupted.diagnostic, undefined);

  const died = arbitrate({ announced, candidate: { source: "defect" } });
  assert.deepEqual(died.ending, announced);
  assert.equal(died.late, true);
  // The ending stands, and the adapter dying afterwards is still recorded.
  assert.equal(died.diagnostic?.category, "backend-failure");
});

test("an in-stream ending captured as the candidate decides the same way", () => {
  // The coordinator captured it before the reducer wrote it back, so it
  // arrives as the candidate rather than as `announced`. Same answer.
  const decided = arbitrate({
    candidate: {
      source: "in-stream-ending",
      ending: cancelledEnding("timeout"),
    },
  });

  assert.deepEqual(decided, {
    ending: { ending: "cancelled", reason: "timeout" },
    from: "in-stream",
    late: false,
  });
});

test("arbitration is a function of its arguments and nothing else", () => {
  const input = {
    candidate: { source: "bundle", bundle: { ending: answeredEnding() } },
    cancellation: { reason: "timeout" },
  } as const;

  assert.deepEqual(arbitrate(input), arbitrate(input));
});
