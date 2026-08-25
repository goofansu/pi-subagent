import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { NotificationMessageDetails } from "./notification-message.ts";
import {
  formatNotificationSummary,
  renderNotificationMessage,
} from "./notification-message.ts";

initTheme(undefined, false);

const theme = {
  fg: (_color: unknown, text: string) => text,
  bg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
};

const keyHintStub = (_action: string, description: string) =>
  `ctrl+o ${description}`;

const summary = (
  details: NotificationMessageDetails,
  characters: number,
  expanded = false,
) =>
  formatNotificationSummary(details, characters, theme, expanded, keyHintStub);

function details(
  overrides: Partial<NotificationMessageDetails> = {},
): NotificationMessageDetails {
  return {
    id: "a3f81c2b",
    agent: "explore",
    status: "completed",
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
  assert.match(line, /completed/);
  assert.match(line, /2\.4k characters/);
  assert.match(line, /to expand/);
});

test("the hint names the direction the key will actually go", () => {
  assert.match(summary(details(), 100, false), /to expand/);
  assert.match(summary(details(), 100, true), /to collapse/);
  assert.doesNotMatch(summary(details(), 100, true), /to expand/);
});

test("small notifications are counted exactly", () => {
  assert.match(summary(details(), 240), /240 characters/);
});

test("a failed notification reads as failed", () => {
  const line = summary(details({ status: "failed" }), 100);

  assert.match(line, /failed/);
});

// ── The message ──────────────────────────────────────────────────────────────

test("a collapsed notification hides its body", () => {
  const component = renderNotificationMessage(
    { content: "a very long body\nacross lines", details: details() },
    { expanded: false },
    theme,
  );

  assert.ok(component);
  const rendered = lines(component).join("\n");
  assert.match(rendered, /explore/);
  assert.doesNotMatch(rendered, /a very long body/);
});

test("a notification is framed like every other message", () => {
  const component = renderNotificationMessage(
    { content: "body", details: details() },
    { expanded: false, outputPad: 2 },
    theme,
  );

  assert.ok(component);
  const rendered = component.render(60);
  // Pi skips its own framing whenever an extension renders a message, so the
  // padded block has to come from here or the notice floats in the transcript.
  assert.ok(rendered.length >= 3, "a blank padded row above and below");
  assert.equal(rendered[0].trim(), "", "top padding");
  assert.equal(rendered.at(-1)?.trim(), "", "bottom padding");
  assert.match(rendered[1], /^ {2}/, "outputPad is honoured");
});

test("an expanded notification shows its body", () => {
  const component = renderNotificationMessage(
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
    renderNotificationMessage(
      { content: "something else", details: { unrelated: true } },
      { expanded: false },
      theme,
    ),
    undefined,
  );
});
