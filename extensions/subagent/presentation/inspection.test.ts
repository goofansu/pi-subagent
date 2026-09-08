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
const sectionBlocks = (
  semantic: readonly ReturnType<typeof inspectionBlocks>[number][],
  title: string,
) => {
  const start = semantic.findIndex(
    (block) => block.kind === "heading" && block.text === `${title}:`,
  );
  assert.notEqual(start, -1, `${title} section is present`);
  const following = semantic
    .slice(start + 1)
    .findIndex((block) => block.kind === "heading");
  if (following === -1) return semantic.slice(start + 1);
  const nextHeading = start + 1 + following;
  return semantic.slice(start + 1, nextHeading - 1);
};

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

test("empty retained output is distinguished from output that was never produced", () => {
  const active = inspectionBlocks(
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
  const activeOutput = active.findIndex(
    (block) => block.text === "Output so far:",
  );
  assert.deepEqual(
    active.slice(activeOutput + 1, activeOutput + 3).map((block) => block.text),
    [
      "1,234 bytes of the final output were cut.",
      "No output remains in this snapshot.",
    ],
  );
  assert.doesNotMatch(
    active.map((block) => block.text).join("\n"),
    /produced yet|retained yet/,
  );

  const result = fixtureResult({
    truncation: { truncatedOutputBytes: 1_234 },
  });
  const terminal = inspectionBlocks(
    {
      ...capture,
      outcome: "result",
      summary: { ...capture.summary, phase: "completed" },
      result,
    },
    "resolved",
  );
  const terminalOutput = terminal.findIndex(
    (block) => block.text === "Final output:",
  );
  assert.deepEqual(
    terminal
      .slice(terminalOutput + 1, terminalOutput + 3)
      .map((block) => block.text),
    [
      "1,234 bytes of the final output were cut.",
      "No final output remains in the Result.",
    ],
  );
  assert.doesNotMatch(
    terminal.map((block) => block.text).join("\n"),
    /was produced|was retained|snapshot/,
  );

  const truncatedTranscriptOnly = inspectionBlocks(
    {
      ...capture,
      content: {
        ...createRunProjection(),
        truncation: {
          ...capture.content.truncation,
          droppedTranscriptItems: 1,
        },
      },
    },
    "pending",
  )
    .map((block) => block.text)
    .join("\n");
  assert.match(truncatedTranscriptOnly, /No output produced yet\./);
  assert.doesNotMatch(truncatedTranscriptOnly, /retained yet/);

  const genuinelyEmpty = inspectionBlocks(
    {
      ...capture,
      content: {
        ...capture.content,
        finalOutput: "",
        transcript: [],
        tools: [],
      },
    },
    "pending",
  );
  assert.match(
    genuinelyEmpty.map((block) => block.text).join("\n"),
    /No output produced yet\./,
  );

  const genuinelyEmptyResult = inspectionBlocks(
    {
      ...capture,
      outcome: "result",
      summary: { ...capture.summary, phase: "completed" },
      result: fixtureResult(),
    },
    "resolved",
  )
    .map((block) => block.text)
    .join("\n");
  assert.match(genuinelyEmptyResult, /No final output was produced\./);
  assert.match(genuinelyEmptyResult, /Result available but empty/);
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

test("metadata, user messages and tool output stay literal without generated call IDs", () => {
  const output = plain();
  for (const expected of [
    "Review **literal** label",
    "## Literal user **text**",
    "## Literal tool **text**",
    "## Raw output",
    "**not bold**",
  ])
    assert.ok(output.includes(expected), expected);
  assert.doesNotMatch(output, /call-test|Call ID:/);
  const tones: { color: string; text: string }[] = [];
  renderInspection(blocks, 100, {
    ...PLAIN_THEME,
    fg: (color, text) => {
      tones.push({ color, text });
      return text;
    },
  });
  assert.ok(
    tones.some(({ color, text }) => color === "dim" && text === "Assistant:"),
  );
  assert.ok(
    tones.some(({ color, text }) => color === "accent" && text === "Tools:"),
  );
});

test("transcript keeps message and part order with fresh readable attribution", () => {
  const transcript = [
    {
      role: "assistant" as const,
      model: "run-model",
      parts: [
        { kind: "text" as const, text: "first **Markdown**" },
        { kind: "text" as const, text: "" },
        {
          kind: "tool_call" as const,
          name: "read",
          callId: "opaque-call-one",
        },
        { kind: "text" as const, text: "after call" },
      ],
    },
    {
      role: "assistant" as const,
      model: "different-model",
      parts: [{ kind: "tool_call" as const, name: "read" }],
    },
    { role: "user" as const, parts: [] },
    {
      role: "tool" as const,
      parts: [
        {
          kind: "text" as const,
          text: "Call ID: literal-error\nassistant: **literal evidence**",
        },
      ],
    },
    {
      role: "assistant" as const,
      parts: [{ kind: "text" as const, text: "same comparison after missing" }],
    },
    {
      role: "assistant" as const,
      model: "different-model",
      parts: [{ kind: "text" as const, text: "duplicate message" }],
    },
    {
      role: "assistant" as const,
      model: "different-model",
      parts: [{ kind: "text" as const, text: "duplicate message" }],
    },
    {
      role: "assistant" as const,
      model: "run-model",
      parts: [{ kind: "text" as const, text: "" }],
    },
  ];
  const inspected: RunInspection = {
    ...capture,
    content: {
      ...capture.content,
      model: "run-model",
      transcript,
      tools: [],
    },
  };
  const before = structuredClone(inspected);
  const semantic = inspectionBlocks(inspected, "pending");
  assert.deepEqual(sectionBlocks(semantic, "Transcript"), [
    { kind: "muted", text: "Assistant:" },
    { kind: "markdown", text: "first **Markdown**" },
    { kind: "markdown", text: "" },
    { kind: "literal", text: "Tool call · read" },
    { kind: "muted", text: "Assistant:" },
    { kind: "markdown", text: "after call" },
    { kind: "muted", text: "Reported model: different-model" },
    { kind: "literal", text: "Tool call · read" },
    { kind: "muted", text: "User:" },
    { kind: "muted", text: "Tool output:" },
    {
      kind: "literal",
      text: "Call ID: literal-error\nassistant: **literal evidence**",
    },
    { kind: "muted", text: "Assistant:" },
    { kind: "markdown", text: "same comparison after missing" },
    { kind: "muted", text: "Assistant:" },
    { kind: "markdown", text: "duplicate message" },
    { kind: "muted", text: "Assistant:" },
    { kind: "markdown", text: "duplicate message" },
    { kind: "muted", text: "Reported model: run-model" },
    { kind: "muted", text: "Assistant:" },
    { kind: "markdown", text: "" },
  ]);
  const visible = renderInspection(semantic, 100, PLAIN_THEME)
    .map(stripVTControlCharacters)
    .join("\n");
  assert.doesNotMatch(visible, /opaque-call-one/);
  assert.equal(visible.match(/Tool call · read/g)?.length, 2);
  assert.equal(
    semantic.filter((block) => block.text === "Model: run-model").length,
    1,
  );
  assert.deepEqual(
    inspected,
    before,
    "presentation leaves normalized data unchanged",
  );
});

test("reported model comparison starts unknown and changes only on explicit values", () => {
  const inspected: RunInspection = {
    ...capture,
    content: {
      ...capture.content,
      model: undefined,
      tools: [],
      transcript: [
        { role: "assistant", parts: [{ kind: "text", text: "unknown" }] },
        {
          role: "assistant",
          model: "model-one",
          parts: [{ kind: "text", text: "one" }],
        },
        { role: "assistant", parts: [] },
        {
          role: "user",
          model: "model-one",
          parts: [{ kind: "text", text: "still one" }],
        },
        {
          role: "tool",
          model: "model-two",
          parts: [],
        },
      ],
    },
  };
  const semantic = inspectionBlocks(inspected, "pending");
  assert.deepEqual(
    semantic
      .filter((block) => block.text.startsWith("Reported model:"))
      .map((block) => block.text),
    ["Reported model: model-one", "Reported model: model-two"],
  );
  assert.equal(
    semantic.filter((block) => block.text.startsWith("Model:")).length,
    0,
  );
  const modelTwo = semantic.findIndex(
    (block) => block.text === "Reported model: model-two",
  );
  assert.equal(semantic[modelTwo + 1]?.text, "Tool output:");
});

test("Tools retain every status, unnamed fallback, duplicate entry and full literal output", () => {
  const inspected: RunInspection = {
    ...capture,
    content: {
      ...capture.content,
      transcript: [],
      tools: [
        { name: "same", status: "running", callId: "status-id-1" },
        {
          name: "same",
          status: "completed",
          callId: "status-id-2",
          outputSummary: "first line\nsecond line\nCall ID: retained evidence",
        },
        {
          name: "failed",
          status: "failed",
          outputSummary: "failure **literal**",
        },
        {
          name: "cancelled",
          status: "cancelled",
          outputSummary: "cancel tail",
        },
        { status: "unfinished", outputSummary: "unfinished tail" },
      ],
    },
  };
  const semantic = inspectionBlocks(inspected, "pending");
  assert.deepEqual(sectionBlocks(semantic, "Tools"), [
    { kind: "literal", text: "same — running" },
    { kind: "literal", text: "same — completed" },
    {
      kind: "literal",
      text: "first line\nsecond line\nCall ID: retained evidence",
    },
    { kind: "literal", text: "failed — failed" },
    { kind: "literal", text: "failure **literal**" },
    { kind: "literal", text: "cancelled — cancelled" },
    { kind: "literal", text: "cancel tail" },
    { kind: "literal", text: "(unnamed tool) — unfinished" },
    { kind: "literal", text: "unfinished tail" },
  ]);
  const visible = renderInspection(semantic, 100, PLAIN_THEME)
    .map(stripVTControlCharacters)
    .join("\n");
  assert.doesNotMatch(visible, /status-id-[12]/);
  assert.match(visible, /second line/);
  assert.match(visible, /Call ID: retained evidence/);
  assert.match(visible, /failure \*\*literal\*\*/);
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
