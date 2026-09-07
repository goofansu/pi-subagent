import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  backendId,
  createRunProjection,
  EMPTY_USAGE_SNAPSHOT,
  runId,
  subagentId,
} from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
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

test("answer precedes accounting, transcript and tool history", () => {
  const output = plain();
  assert.ok(output.indexOf("Output so far:") < output.indexOf("Metadata:"));
  assert.ok(output.indexOf("Summary") < output.indexOf("Usage:"));
  assert.ok(output.indexOf("Summary") < output.indexOf("Transcript:"));
  assert.ok(output.indexOf("Summary") < output.indexOf("Tools:"));
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
