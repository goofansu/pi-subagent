import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backendId,
  cancelledEnding,
  EMPTY_USAGE_SNAPSHOT,
  failedEnding,
  interpretFinalOutput,
} from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import {
  type FixtureResultOptions,
  fixtureNotification,
  fixtureResult,
} from "../testing/presentation-fixtures.ts";
import { deliveredRunFactsOfNotification } from "./final-output-facts.ts";
import {
  compactFinalOutputSummaryPhrase,
  finalOutputSummary,
} from "./final-output-section.ts";
import { inspectionBlocks } from "./inspection.ts";
import { formatNotificationText } from "./notification-text.ts";
import { formatResult } from "./run-card.ts";
import { resultToolRowFacts } from "./tool-row-facts.ts";

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

test("compact final-output summaries own absence, removal, and character-count phrases", () => {
  const cases = [
    [fixtureResult(), "no output"],
    [
      fixtureResult({ truncation: { truncatedOutputBytes: 7 } }),
      "output removed",
    ],
    [fixtureResult({ finalOutput: "visible answer" }), "14 characters"],
  ] as const;

  for (const [result, expected] of cases) {
    const phrase = compactFinalOutputSummaryPhrase(
      finalOutputSummary(interpretFinalOutput(result)),
    );
    assert.equal(phrase, expected);
    assert.equal(
      resultToolRowFacts({ outcome: "result", result }).rowPhrase,
      phrase,
    );
  }
});

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

test("the final-output fact on both channels is the text the prose fences, for every retention kind", () => {
  const cases: readonly FixtureResultOptions[] = [
    { finalOutput: "# Findings\n\n- one\n- two" },
    { finalOutput: "prefix", truncation: { truncatedOutputBytes: 5 } },
    { truncation: { truncatedOutputBytes: 5 } },
    {},
    { ending: failedEnding("boom"), finalOutput: "before the crash" },
    { ending: cancelledEnding("timeout"), finalOutput: "before the stop" },
  ];
  for (const options of cases) {
    const result = fixtureResult(options);
    const notice = fixtureNotification(options);
    const fromResult = resultToolRowFacts({ outcome: "result", result });
    assert.equal(fromResult.outcome, "available");
    const resultFacts = "run" in fromResult ? fromResult.run : undefined;
    const noticeFacts = deliveredRunFactsOfNotification(notice);

    // One fact for one Run, whichever channel delivered it: these answers
    // fit the inline bound, so neither channel previews.
    assert.deepEqual(noticeFacts.finalOutput, resultFacts?.finalOutput);
    assert.equal(noticeFacts.failure, resultFacts?.failure);
    assert.equal(
      noticeFacts.cancellationReason,
      resultFacts?.cancellationReason,
    );

    const facts = noticeFacts.finalOutput;
    const rendered = surfaces(options);
    if (facts !== undefined && "text" in facts) {
      // The fact is the whole value the Result card prints and the notice
      // fences, byte for byte.
      assert.equal(rendered.result.includes(facts.text), true);
      assert.equal(rendered.notice.includes(`"""\n${facts.text}\n"""`), true);
    } else {
      assert.equal(facts?.kind === "absent" || facts?.kind === "removed", true);
      assert.doesNotMatch(rendered.notice, /"""/);
    }
  }
});

test("an empty failure reason is no reason: no bare Failure line and no failure fact", () => {
  const options: FixtureResultOptions = {
    ending: failedEnding(),
    diagnostics: [{ category: "backend-failure", message: "" }],
  };
  const rendered = surfaces(options);
  assert.doesNotMatch(rendered.result, /Failure:/);
  assert.match(rendered.notice, /Reason: none reported\./);

  const facts = resultToolRowFacts({
    outcome: "result",
    result: fixtureResult(options),
  });
  const run = "run" in facts ? facts.run : undefined;
  assert.equal(run !== undefined && "failure" in run, false);
  assert.equal(
    "failure" in deliveredRunFactsOfNotification(fixtureNotification(options)),
    false,
  );
});

test("whitespace-only final output follows the absent path on all three surfaces", () => {
  assertEverySurface({ finalOutput: " \n\t " }, [
    /The Run finished without output\./,
    /No output was produced\. The Run record is available\./,
    /No final output was produced\./,
  ]);
});
