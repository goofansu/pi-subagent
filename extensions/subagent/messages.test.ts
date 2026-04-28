import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@mariozechner/pi-ai";
import { getDisplayItems, getFinalOutput } from "./messages.js";

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

test("getDisplayItems extracts assistant text and tool calls in order", () => {
  const messages = [
    userMessage([{ type: "text", text: "ignored" }]),
    assistantMessage([
      { type: "text", text: "thinking" },
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "npm test" },
      },
    ]),
  ];

  assert.deepEqual(getDisplayItems(messages), [
    { type: "text", text: "thinking" },
    { type: "toolCall", name: "bash", args: { command: "npm test" } },
  ]);
});
