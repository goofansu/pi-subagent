import assert from "node:assert/strict";
import { test } from "node:test";
import { backendId, EMPTY_USAGE_SNAPSHOT } from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import {
  type FixtureResultOptions,
  fixtureNotification,
  fixtureResult,
} from "../testing/presentation-fixtures.ts";
import { inspectionBlocks } from "./inspection.ts";
import { formatNotificationText } from "./notification-text.ts";
import { formatResult } from "./run-card.ts";

function surfaces(options: FixtureResultOptions) {
  const result = fixtureResult(options);
  const capture: RunInspection = {
    outcome: "result",
    runId: result.runId,
    capturedAt: result.settledAt,
    summary: {
      runId: result.runId,
      subagentId: result.subagentId,
      profile: result.agent,
      backend: backendId("pi"),
      label: result.description,
      phase: result.status,
      turns: result.usage.turns,
      startedAt: result.startedAt,
      settledAt: result.settledAt,
    },
    usage: EMPTY_USAGE_SNAPSHOT,
    prompt: "inspect final output",
    result,
  };
  return {
    result: formatResult(result),
    notice: formatNotificationText(fixtureNotification(options)),
    inspection: inspectionBlocks(capture, "resolved")
      .map((block) => block.text)
      .join("\n"),
  };
}

type Surface = ReturnType<typeof surfaces>;
type SurfaceName = keyof Surface;

function assertEverySurface(
  options: FixtureResultOptions,
  expected: readonly [RegExp, RegExp, RegExp],
) {
  const rendered = surfaces(options);
  assert.match(rendered.result, expected[0]);
  assert.match(rendered.notice, expected[1]);
  assert.match(rendered.inspection, expected[2]);
}

function assertExtractedLineEqual(
  rendered: Surface,
  expected: string,
  names: readonly SurfaceName[] = ["result", "notice", "inspection"],
) {
  const extracted = names.map((name) =>
    rendered[name]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line === expected),
  );
  assert.deepEqual(
    extracted,
    names.map(() => [expected]),
  );
}

test("absent final output reaches Result, notice, and inspection through their preserved framing", () => {
  assertEverySurface({}, [
    /The Run finished without output\./,
    /No output was produced\. The Run record is available\./,
    /No final output was produced\./,
  ]);
});

test("retained final output is identical across Result, notice, and inspection", () => {
  assertExtractedLineEqual(
    surfaces({ finalOutput: "visible answer" }),
    "visible answer",
  );
});

test("a retained prefix shares its body and preserves the notice pointer framing", () => {
  const rendered = surfaces({
    finalOutput: "visible prefix",
    truncation: { truncatedOutputBytes: 7 },
  });
  assertExtractedLineEqual(rendered, "visible prefix");
  assertExtractedLineEqual(rendered, "7 bytes of the final output were cut.", [
    "result",
    "inspection",
  ]);
  assert.match(rendered.notice, /7 bytes were removed by retention bounds/);
});

test("removed final output shares Result and inspection lines while preserving its notice pointer", () => {
  const rendered = surfaces({ truncation: { truncatedOutputBytes: 7 } });
  assertExtractedLineEqual(rendered, "7 bytes of the final output were cut.", [
    "result",
    "inspection",
  ]);
  assertExtractedLineEqual(rendered, "No final output remains in the Result.", [
    "result",
    "inspection",
  ]);
  assert.match(rendered.notice, /Final output was produced, but none remains/);
  for (const text of Object.values(rendered))
    assert.doesNotMatch(text, /No final output was produced/);
});

test("whitespace-only final output follows the absent path on all three surfaces", () => {
  assertEverySurface({ finalOutput: " \n\t " }, [
    /The Run finished without output\./,
    /No output was produced\. The Run record is available\./,
    /No final output was produced\./,
  ]);
});
