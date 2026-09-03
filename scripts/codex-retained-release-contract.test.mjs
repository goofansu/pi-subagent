import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRetainedReleaseEvidence } from "./codex-retained-release-contract.mjs";

const passingRecord = `
### 2026-09-03 — codex-cli 0.153.0

- Operator: Release Operator
- OS: macOS 15
- Codex Desktop version: 1.2.3
- Smoke log: artifacts/codex-retained-0.153.0.log
- Desktop before smoke: PASS — prompt completed
- Desktop during retained-idle prompt: PASS — prompt completed
- Desktop during active Turn 2: PASS — overlap observed
- \`CODEX_LIVE_SMOKE_PASS\`: PASS — marker in smoke log
- Descendant cleanup: process tree captured; all observed PIDs exited
- Desktop after Session cleanup: PASS — prompt completed
- Rollout-writer/storage conflict observed: NO — no conflict
- Release conclusion: PASS
`;

test("retained Codex release evidence closes only for the matching pinned CLI", () => {
  assert.deepEqual(
    assertRetainedReleaseEvidence(passingRecord, "codex-cli 0.153.0"),
    {
      heading: "2026-09-03 — codex-cli 0.153.0",
      smokeLog: "artifacts/codex-retained-0.153.0.log",
    },
  );
  assert.throws(
    () => assertRetainedReleaseEvidence(passingRecord, "codex-cli 0.154.0"),
    /no complete evidence record.*0\.154\.0/i,
  );
});

test("a record naming v1's smoke marker is not a record for this procedure", () => {
  // The v1 resume smoke's marker was `CODEX_RESUME_LIVE_SMOKE_PASS`, and a
  // record carrying it is evidence about a gate that no longer exists — a
  // different adapter, driven by a different lifecycle, deleted in M7. The
  // release conclusion is only as good as the run it names.
  const v1Record = passingRecord.replace(
    "CODEX_LIVE_SMOKE_PASS",
    "CODEX_RESUME_LIVE_SMOKE_PASS",
  );
  assert.throws(
    () => assertRetainedReleaseEvidence(v1Record, "codex-cli 0.153.0"),
    /no complete evidence record/i,
  );
});

test("failed, missing, and unproven operator evidence keep the gate open", () => {
  for (const [field, replacement] of [
    ["Desktop before smoke: PASS", "Desktop before smoke: FAIL"],
    [
      "Desktop during retained-idle prompt: PASS",
      "Desktop during retained-idle prompt: FAIL",
    ],
    [
      "Desktop during active Turn 2: PASS",
      "Desktop during active Turn 2: UNPROVEN",
    ],
    ["`CODEX_LIVE_SMOKE_PASS`: PASS", "`CODEX_LIVE_SMOKE_PASS`: FAIL"],
    [
      "Desktop after Session cleanup: PASS",
      "Desktop after Session cleanup: FAIL",
    ],
    [
      "Rollout-writer/storage conflict observed: NO",
      "Rollout-writer/storage conflict observed: YES",
    ],
    ["Release conclusion: PASS", "Release conclusion: FAIL"],
  ]) {
    assert.throws(
      () =>
        assertRetainedReleaseEvidence(
          passingRecord.replace(field, replacement),
          "codex-cli 0.153.0",
        ),
      /no complete evidence record/i,
      field,
    );
  }

  assert.throws(
    () =>
      assertRetainedReleaseEvidence(
        passingRecord.replace(
          "Smoke log: artifacts/codex-retained-0.153.0.log",
          "Smoke log:",
        ),
        "codex-cli 0.153.0",
      ),
    /no complete evidence record/i,
  );
});

test("a later passing record can close the gate without rewriting failed history", () => {
  const failed = passingRecord
    .replace("### 2026-08-31", "### 2026-08-30")
    .replace("Release conclusion: PASS", "Release conclusion: FAIL");
  assert.doesNotThrow(() =>
    assertRetainedReleaseEvidence(
      `${failed}\n${passingRecord}`,
      "codex-cli 0.153.0",
    ),
  );
});
