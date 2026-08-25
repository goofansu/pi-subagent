import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveActivity,
  describeToolCall,
  getFinalOutput,
} from "./messages.ts";
import type { Fact, FactPart } from "./run.ts";

const assistantFact = (parts: FactPart[]): Fact => ({
  role: "assistant",
  parts,
});
const userFact = (parts: FactPart[]): Fact => ({ role: "user", parts });
const text = (value: string): FactPart => ({ type: "text", text: value });
const tool = (name: string, arguments_: Record<string, unknown>): FactPart => ({
  type: "tool_call",
  name,
  arguments: arguments_,
});
const toolCall = (name: string, arguments_: Record<string, unknown>) => ({
  type: "tool_call" as const,
  name,
  arguments: arguments_,
});

test("getFinalOutput joins all text parts from the last assistant fact", () => {
  assert.equal(
    getFinalOutput([
      assistantFact([
        text("Part one. "),
        tool("bash", { command: "ls" }),
        text("Part two."),
      ]),
    ]),
    "Part one. Part two.",
  );
});

test("getFinalOutput returns the last assistant text fact", () => {
  assert.equal(
    getFinalOutput([
      assistantFact([text("first")]),
      userFact([text("ignored")]),
      assistantFact([text("final")]),
    ]),
    "final",
  );
});

test("getFinalOutput returns an empty string when no assistant text exists", () => {
  assert.equal(getFinalOutput([userFact([text("hello")])]), "");
});

test("deriveActivity names the most recent tool call and its main argument", () => {
  assert.equal(
    deriveActivity([
      assistantFact([tool("read", { path: "src/old.ts" })]),
      assistantFact([
        text("Now checking."),
        tool("bash", { command: "npm  test\n--watch=false" }),
      ]),
    ]),
    "bash: npm test --watch=false",
  );
});

test("deriveActivity is undefined before the first tool call", () => {
  assert.equal(deriveActivity([]), undefined);
  assert.equal(deriveActivity([assistantFact([text("thinking")])]), undefined);
});

test("deriveActivity falls back to the bare tool name", () => {
  assert.equal(deriveActivity([assistantFact([tool("ls", {})])]), "ls");
});

test("describeToolCall keeps the line short whatever the argument holds", () => {
  assert.ok(
    describeToolCall(toolCall("bash", { command: "x".repeat(500) })).length <=
      120,
  );
});
