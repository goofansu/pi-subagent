import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backendId,
  byteLength,
  cancelledEnding,
  failedEnding,
  NOTIFICATION_ERROR_MAX_BYTES,
  NOTIFICATION_PREVIEW_MAX_BYTES,
  redactedDiagnostic,
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

test("N1/N2: a completed notice carries a bounded preview and the result pointer", () => {
  const notice = fixtureNotification({ finalOutput: "done" });

  assert.equal(
    formatNotificationText(notice),
    'Subagent "look around" completed in 12.4s.\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      "done\n\n" +
      "Use agent_result with id run-1 to retrieve the full result.",
  );
});

test("the notice is identical whichever backend ran the Run", () => {
  // Compatibility-matrix proof: the completion Notification is derived from
  // the neutral Result alone, so only the model string — which the Profile
  // chooses — differs between backends.
  // See docs/v2/compatibility-matrix.md.
  const texts = ["pi", "claude", "codex"].map((backend) =>
    formatNotificationText(
      fixtureNotification({
        finalOutput: "done",
        identity: { backendId: backendId(backend) },
      }),
    ),
  );

  assert.deepEqual(new Set(texts).size, 1);
  assert.equal(
    texts[0],
    'Subagent "look around" completed in 12.4s.\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      "done\n\n" +
      "Use agent_result with id run-1 to retrieve the full result.",
  );
});

test("a completed Run with no output says so rather than showing a blank", () => {
  assert.match(
    formatNotificationText(fixtureNotification({})),
    /Subagent: subagent-1\n\nNo output was produced\.\n\n/,
  );
});

test("a long answer is previewed rather than delivered", () => {
  const notice = fixtureNotification({
    finalOutput: "x".repeat(NOTIFICATION_PREVIEW_MAX_BYTES + 500),
  });

  assert.equal(byteLength(notice.preview), NOTIFICATION_PREVIEW_MAX_BYTES);
  const text = formatNotificationText(notice);
  // The ceiling is the preview's bound plus the fixed sections: a header, a
  // three-line identity block, a pointer, and the label's own 200 bytes.
  assert.ok(text.length < NOTIFICATION_PREVIEW_MAX_BYTES + 400);
  assert.match(text, /Use agent_result with id run-1/);
});

test("N3: a failed notice carries the primary error and the pointer, and no output", () => {
  const notice = fixtureNotification({
    ending: failedEnding("the backend refused"),
    finalOutput: "half an answer",
  });

  assert.equal(
    formatNotificationText(notice),
    'Subagent "look around" failed in 12.4s.\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1\n\n" +
      "Reason: the backend refused\n\n" +
      "Use agent_result with id run-1 to retrieve the full result.",
  );
});

test("N1: a failed notice bounds a pathological error message", () => {
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

test("a failed Run that reported no reason says that it reported none", () => {
  assert.match(
    formatNotificationText(fixtureNotification({ ending: failedEnding() })),
    /failed in 12\.4s\.\n\nAgent: explore\nRun: run-1\nSubagent: subagent-1\n\nReason: none reported\./,
  );
});

test("a cancelled notice is terse, names its reason, and carries no partial output", () => {
  const notice = fixtureNotification({
    ending: cancelledEnding("requested"),
    finalOutput: "half an answer",
  });

  assert.equal(
    formatNotificationText(notice),
    'Subagent "look around" was cancelled in 12.4s (requested).\n\n' +
      "Agent: explore\nRun: run-1\nSubagent: subagent-1",
  );
});

test("every terminal status points at agent_result by Run id", () => {
  for (const ending of [
    undefined,
    failedEnding("boom"),
    cancelledEnding("shutdown"),
  ]) {
    const notice = fixtureNotification(
      ending === undefined ? { finalOutput: "done" } : { ending },
    );
    assert.equal(notice.retrieveWith, "agent_result");
  }
  // The cancelled notice is the terse one, so the pointer lives in the tool
  // description rather than the notice: a cancelled Run has nothing to
  // preview and the model already knows the id it cancelled.
  assert.equal(
    formatResultPointer(fixtureNotification({}).runId),
    "Use agent_result with id run-1 to retrieve the full result.",
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
      "Agent: explore\nRun: run-1\nSubagent: subagent-1",
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

test("accounting is absent when the Run reported nothing to account for", () => {
  assert.equal(
    formatNotificationAccounting(fixtureNotification({}).usage, undefined),
    undefined,
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
