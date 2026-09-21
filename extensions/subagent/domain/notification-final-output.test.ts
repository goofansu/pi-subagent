import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureNotification } from "../testing/presentation-fixtures.ts";
import { notificationFinalOutputOf } from "./notification.ts";

test("notification output facts state evidence only when no output remains", () => {
  assert.deepEqual(notificationFinalOutputOf(fixtureNotification({})), {
    kind: "absent",
    hasTranscriptEvidence: false,
  });
  assert.deepEqual(
    notificationFinalOutputOf(
      fixtureNotification({
        transcript: [
          { role: "assistant", parts: [{ kind: "text", text: "evidence" }] },
        ],
      }),
    ),
    { kind: "absent", hasTranscriptEvidence: true },
  );
  assert.deepEqual(
    notificationFinalOutputOf(fixtureNotification({ finalOutput: "answer" })),
    { kind: "retained", output: "answer" },
  );
  assert.deepEqual(
    notificationFinalOutputOf(
      fixtureNotification({
        finalOutput: "prefix",
        truncation: { truncatedOutputBytes: 7 },
      }),
    ),
    { kind: "retained-prefix", output: "prefix", removedBytes: 7 },
  );
  assert.deepEqual(
    notificationFinalOutputOf(
      fixtureNotification({ truncation: { truncatedOutputBytes: 7 } }),
    ),
    { kind: "removed", removedBytes: 7, hasTranscriptEvidence: false },
  );
});
