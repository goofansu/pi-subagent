import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  backendId,
  CANCELLATION_REASONS,
  createRunProjection,
  EMPTY_USAGE_SNAPSHOT,
  runId,
  subagentId,
} from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import { fixtureResult } from "../testing/presentation-fixtures.ts";
import { PLAIN_THEME } from "../testing/stand-in-host.ts";
import { inspectionBlocks, renderInspection } from "./inspection.ts";

const capture: RunInspection = {
  outcome: "active",
  runId: runId("run-test-1"),
  capturedAt: 1000,
  summary: {
    runId: runId("run-test-1"),
    subagentId: subagentId("subagent-test-1"),
    profile: "explore",
    backend: backendId("pi"),
    label: "Review **literal** label",
    phase: "running",
    turns: 1,
    startedAt: 0,
  },
  usage: EMPTY_USAGE_SNAPSHOT,
  content: {
    ...createRunProjection(),
    finalOutput:
      "## Summary\n\nA **bold answer** with `inline code`.\n\n- First point\n- Second point\n\n```ts\nconst value = 1;\n```",
    transcript: [
      {
        role: "assistant",
        parts: [
          { kind: "text", text: "### Assistant heading\n\n**Assistant text**" },
        ],
      },
      {
        role: "user",
        parts: [{ kind: "text", text: "## Literal user **text**" }],
      },
      {
        role: "tool",
        parts: [{ kind: "text", text: "## Literal tool **text**" }],
      },
    ],
    tools: [
      {
        name: "bash",
        status: "completed",
        callId: "call-test",
        outputSummary: "## Raw output\n**not bold**",
      },
    ],
  },
};
const blocks = inspectionBlocks(capture, "pending");
const plain = (width = 100) =>
  renderInspection(blocks, width, PLAIN_THEME)
    .map(stripVTControlCharacters)
    .join("\n");

test("inspection labels current and retained last activity without substitution", () => {
  const activityCapture: RunInspection = {
    ...capture,
    summary: {
      ...capture.summary,
      activity: "writing now",
      lastActivity: { summary: "read earlier", changedAt: 500 },
    },
  };
  const output = renderInspection(
    inspectionBlocks(activityCapture, "pending"),
    100,
    PLAIN_THEME,
  )
    .map(stripVTControlCharacters)
    .join("\n");
  assert.match(output, /Current activity: writing now/);
  assert.match(output, /Last activity: read earlier · changed 0\.5s ago/);

  const retainedOnly = inspectionBlocks(
    {
      ...activityCapture,
      summary: { ...activityCapture.summary, activity: undefined },
    },
    "pending",
  )
    .map((block) => block.text)
    .join("\n");
  assert.doesNotMatch(retainedOnly, /Current activity: read earlier/);
  assert.match(retainedOnly, /Last activity: read earlier/);
});

test("inspection shows completed and failed outcomes without retained cancellation causes", () => {
  for (const phase of ["completed", "failed"] as const)
    for (const cancellationReason of CANCELLATION_REASONS)
      for (const stored of [false, true]) {
        const summary = {
          ...capture.summary,
          phase,
          cancellationReason,
          activity: "old tool",
        };
        const inspected: RunInspection = stored
          ? {
              ...capture,
              summary,
              outcome: "result",
              result: {
                ...fixtureResult({ finalOutput: "preserved output" }),
                status: phase,
              },
            }
          : { ...capture, summary, outcome: "ResultExpired" };
        const output = renderInspection(
          inspectionBlocks(inspected, "pending"),
          100,
          PLAIN_THEME,
        )
          .map(stripVTControlCharacters)
          .join("\n");
        assert.match(output, new RegExp(`Run status: ${phase}\\n`));
        assert.doesNotMatch(
          output,
          /requested|shutdown|timeout|Current activity: old tool/,
        );
        if (stored) assert.match(output, /preserved output/);
      }
});

test("retained evidence precedes accounting in the specified semantic section order", () => {
  const orderedCapture: RunInspection = {
    ...capture,
    content: {
      ...capture.content,
      errorMessage: "backend failed",
      diagnostics: [
        { category: "other", message: "first diagnostic" },
        { category: "profile", message: "second diagnostic" },
      ],
      links: [
        { kind: "url", label: "native log", target: "https://example.com/log" },
      ],
      truncation: {
        droppedTranscriptItems: 1,
        droppedToolEntries: 2,
        droppedDiagnostics: 3,
        droppedLinks: 4,
        truncatedTranscriptBytes: 5,
        truncatedToolOutputBytes: 6,
        truncatedOutputBytes: 7,
      },
    },
  };
  const ordered = inspectionBlocks(orderedCapture, "pending");
  const headings = ordered
    .filter((block) => block.kind === "heading")
    .map((block) => block.text);
  assert.deepEqual(headings, [
    "Label: Review **literal** label",
    "Output so far:",
    "Error:",
    "Diagnostics:",
    "Truncation:",
    "Transcript:",
    "Tools:",
    "Usage:",
    "Metadata:",
    "Links:",
  ]);

  const warning = "7 bytes of the final output were cut.";
  const outputHeading = ordered.findIndex(
    (block) => block.text === "Output so far:",
  );
  assert.equal(ordered[outputHeading + 1]?.text, warning);
  assert.equal(
    ordered[outputHeading + 2]?.text,
    orderedCapture.content.finalOutput,
  );

  const truncation = ordered.find((block) =>
    block.text.startsWith("Dropped to stay within bounds:"),
  )?.text;
  for (const expected of [
    "1 transcript items",
    "2 tool entries",
    "3 diagnostics",
    "4 links",
    "5 bytes of transcript text",
    "6 bytes of tool output",
    "7 bytes of the final output",
  ])
    assert.ok(truncation?.includes(expected), expected);
  assert.ok(
    ordered.findIndex((block) => block.text.includes("first diagnostic")) <
      ordered.findIndex((block) => block.text.includes("second diagnostic")),
  );
});

test("final-output truncation warning immediately precedes an empty-output explanation", () => {
  const empty = inspectionBlocks(
    {
      ...capture,
      content: {
        ...capture.content,
        finalOutput: "",
        transcript: [],
        tools: [],
        truncation: {
          ...capture.content.truncation,
          truncatedOutputBytes: 1_234,
        },
      },
    },
    "pending",
  );
  const outputHeading = empty.findIndex(
    (block) => block.text === "Output so far:",
  );
  assert.equal(
    empty[outputHeading + 1]?.text,
    "1,234 bytes of the final output were cut.",
  );
  assert.equal(empty[outputHeading + 2]?.text, "No output produced yet.");
  assert.equal(
    empty[outputHeading + 3]?.text,
    "Active snapshot available but empty: no output or transcript retained yet.",
  );
});

test("empty optional evidence sections are omitted and missing-data explanations precede accounting", () => {
  const sparse = inspectionBlocks(
    {
      ...capture,
      content: {
        ...createRunProjection(),
        finalOutput: "answer",
      },
    },
    "pending",
  );
  const sparseHeadings = sparse
    .filter((block) => block.kind === "heading")
    .map((block) => block.text);
  assert.deepEqual(sparseHeadings, [
    "Label: Review **literal** label",
    "Output so far:",
    "Usage:",
    "Metadata:",
  ]);

  for (const outcome of ["ResultExpired", "unavailable"] as const) {
    const missing: RunInspection = { ...capture, outcome };
    const missingBlocks = inspectionBlocks(missing, "pending");
    const explanation = missingBlocks.findIndex((block) =>
      block.text.startsWith(
        outcome === "ResultExpired" ? "Result expired:" : "Run unavailable:",
      ),
    );
    assert.ok(explanation >= 0);
    assert.ok(
      explanation < missingBlocks.findIndex((block) => block.text === "Usage:"),
    );
    assert.ok(
      explanation <
        missingBlocks.findIndex((block) => block.text === "Metadata:"),
    );
  }
});

test("assistant Markdown renders headings, bold, inline code, lists and fenced code", () => {
  const output = plain();
  for (const expected of [
    "Summary",
    "bold answer",
    "inline code",
    "First point",
    "Second point",
    "const value = 1;",
    "Assistant heading",
    "Assistant text",
  ])
    assert.ok(output.includes(expected), expected);
  assert.doesNotMatch(
    output,
    /## Summary|\*\*bold answer\*\*|`inline code`|\*\*Assistant text\*\*/,
  );
  assert.ok(
    renderInspection(blocks, 100, PLAIN_THEME).some((line) =>
      line.includes("\x1b["),
    ),
  );
});

test("metadata, user messages and tool output stay literal; call IDs use quiet styling", () => {
  const output = plain();
  for (const expected of [
    "Review **literal** label",
    "## Literal user **text**",
    "## Literal tool **text**",
    "## Raw output",
    "**not bold**",
  ])
    assert.ok(output.includes(expected), expected);
  const tones: { color: string; text: string }[] = [];
  renderInspection(blocks, 100, {
    ...PLAIN_THEME,
    fg: (color, text) => {
      tones.push({ color, text });
      return text;
    },
  });
  assert.ok(
    tones.some(
      ({ color, text }) => color === "dim" && text === "Call ID: call-test",
    ),
  );
  assert.ok(
    tones.some(({ color, text }) => color === "accent" && text === "Tools:"),
  );
});

test("Markdown remains width-safe across resize and preserves the captured content", () => {
  const before = plain();
  for (const width of [0, 1, 2, 8, 20, 40, 80, 160]) {
    const lines = renderInspection(blocks, width, PLAIN_THEME);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !line.includes("\ufffd")));
  }
  assert.equal(plain(), before);
});
