import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { ReportMessageDetails } from "./report-message.ts";
import { formatReportSummary, renderReportMessage } from "./report-message.ts";

initTheme(undefined, false);

const theme = {
  fg: (_color: unknown, text: string) => text,
  bg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
};

const keyHintStub = (_action: string, description: string) =>
  `ctrl+o ${description}`;

const summary = (
  details: ReportMessageDetails,
  characters: number,
  expanded = false,
) => formatReportSummary(details, characters, theme, expanded, keyHintStub);

function details(
  overrides: Partial<ReportMessageDetails> = {},
): ReportMessageDetails {
  return {
    id: "a3f81c2b",
    agent: "explore",
    status: "completed",
    truncated: false,
    ...overrides,
  };
}

function lines(component: { render(width: number): string[] }): string[] {
  return component
    .render(100)
    .map((line) => stripVTControlCharacters(line).trimEnd());
}

// ── The summary line ─────────────────────────────────────────────────────────

test("a summary names the agent, the run and the size", () => {
  const line = summary(details(), 2_400);

  assert.match(line, /explore/);
  assert.match(line, /a3f81c2b/);
  assert.match(line, /reported/);
  assert.match(line, /2\.4k characters/);
  assert.match(line, /to expand/);
});

test("the hint names the direction the key will actually go", () => {
  assert.match(summary(details(), 100, false), /to expand/);
  assert.match(summary(details(), 100, true), /to collapse/);
  assert.doesNotMatch(summary(details(), 100, true), /to expand/);
});

test("small reports are counted exactly rather than rounded to zero", () => {
  assert.match(summary(details(), 240), /240 characters/);
});

test("a trimmed report says where the rest is", () => {
  const line = summary(details({ truncated: true }), 30_000);

  assert.match(line, /trimmed/);
  assert.match(line, /agent_result a3f81c2b/);
});

test("a failed run reads as failed rather than reported", () => {
  const line = summary(details({ status: "failed" }), 100);

  assert.match(line, /failed/);
  assert.doesNotMatch(line, /reported/);
});

// ── The message ──────────────────────────────────────────────────────────────

test("a collapsed report shows its summary and not the report", () => {
  const component = renderReportMessage(
    { content: "a very long body\nacross lines", details: details() },
    { expanded: false },
    theme,
  );

  assert.ok(component);
  const rendered = lines(component).join("\n");
  assert.match(rendered, /explore/);
  assert.doesNotMatch(rendered, /a very long body/);
});

test("a report is framed like every other message, not loose text", () => {
  const component = renderReportMessage(
    { content: "body", details: details() },
    { expanded: false, outputPad: 2 },
    theme,
  );

  assert.ok(component);
  const rendered = component.render(60);
  // Pi skips its own framing whenever an extension renders a message, so the
  // padded block has to come from here or the report floats in the transcript.
  assert.ok(rendered.length >= 3, "a blank padded row above and below");
  assert.equal(rendered[0].trim(), "", "top padding");
  assert.equal(rendered.at(-1)?.trim(), "", "bottom padding");
  assert.match(rendered[1], /^ {2}/, "outputPad is honoured");
});

test("an expanded report shows the body under its summary", () => {
  const component = renderReportMessage(
    { content: "the whole finding", details: details() },
    { expanded: true },
    theme,
  );

  assert.ok(component);
  const rendered = lines(component).join("\n");
  assert.match(rendered, /explore/);
  assert.match(rendered, /the whole finding/);
});

test("a message this extension did not shape falls through to pi", () => {
  assert.equal(
    renderReportMessage(
      { content: "something else", details: { unrelated: true } },
      { expanded: false },
      theme,
    ),
    undefined,
  );
});
