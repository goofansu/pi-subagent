import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import {
  deriveActivity,
  describeToolCall,
  getFinalOutput,
} from "./messages.ts";

const assistantMessage = (content: Message["content"]): Message =>
  ({ role: "assistant", content }) as Message;

const userMessage = (content: Message["content"]): Message =>
  ({ role: "user", content }) as Message;

test("getFinalOutput joins all text parts from the last assistant message", () => {
  const messages = [
    assistantMessage([
      { type: "text", text: "Part one. " },
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "ls" },
      },
      { type: "text", text: "Part two." },
    ]),
  ];

  assert.equal(getFinalOutput(messages), "Part one. Part two.");
});

test("getFinalOutput returns the last assistant text part", () => {
  const messages = [
    assistantMessage([{ type: "text", text: "first" }]),
    userMessage([{ type: "text", text: "ignored" }]),
    assistantMessage([{ type: "text", text: "final" }]),
  ];

  assert.equal(getFinalOutput(messages), "final");
});

test("getFinalOutput returns an empty string when no assistant text exists", () => {
  assert.equal(
    getFinalOutput([userMessage([{ type: "text", text: "hello" }])]),
    "",
  );
});

// ── Activity ─────────────────────────────────────────────────────────────────

test("deriveActivity names the most recent tool call and its main argument", () => {
  const messages = [
    assistantMessage([
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "src/old.ts" },
      },
    ]),
    assistantMessage([
      { type: "text", text: "Now checking." },
      {
        type: "toolCall",
        id: "call-2",
        name: "bash",
        arguments: { command: "npm  test\n--watch=false" },
      },
    ]),
  ];

  assert.equal(deriveActivity(messages), "bash: npm test --watch=false");
});

test("deriveActivity is undefined before the first tool call", () => {
  assert.equal(deriveActivity([]), undefined);
  assert.equal(
    deriveActivity([assistantMessage([{ type: "text", text: "thinking" }])]),
    undefined,
  );
});

test("deriveActivity falls back to the bare tool name", () => {
  const messages = [
    assistantMessage([
      { type: "toolCall", id: "call-1", name: "ls", arguments: {} },
    ]),
  ];

  assert.equal(deriveActivity(messages), "ls");
});

test("describeToolCall keeps the line short whatever the argument holds", () => {
  const described = describeToolCall({
    type: "toolCall",
    name: "bash",
    arguments: { command: "x".repeat(500) },
  });

  assert.ok(described.length <= 120);
});
