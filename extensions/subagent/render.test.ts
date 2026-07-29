import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { COLLAPSED_TOOL_CALL_LINE_WIDTH } from "./formatting.ts";
import { renderSubagentResult } from "./render.ts";
import type { PersistedSubagentDetails, UsageStats } from "./types.ts";

initTheme(undefined, false);

const plainTheme = {
  fg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
} as Parameters<typeof renderSubagentResult>[2];

function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function assistantMessage(content: Message["content"]): Message {
  return { role: "assistant", content } as Message;
}

function resultWithCommand(
  command: string,
): AgentToolResult<PersistedSubagentDetails> {
  const messages = [
    assistantMessage([
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command },
      },
    ]),
  ];

  return {
    content: [{ type: "text", text: "" }],
    details: {
      results: [
        {
          agent: "worker",
          description: "test command rendering",
          harness: "pi",
          exitCode: 0,
          messages,
          stderr: "",
          usage: emptyUsage(),
        },
      ],
    },
  };
}

test("renderSubagentResult uses single-line collapsed and readable expanded command views", () => {
  const result = resultWithCommand("printf 'one'\n\n  npm    test");

  const collapsed = renderSubagentResult(
    result,
    { expanded: false, isPartial: false },
    plainTheme,
    {},
  )
    .render(120)
    .map((line) => line.trimEnd());
  assert.ok(
    collapsed.includes("→ $ printf 'one' npm test"),
    `expected normalized collapsed command in:\n${collapsed.join("\n")}`,
  );

  const expanded = renderSubagentResult(
    result,
    { expanded: true, isPartial: false },
    plainTheme,
    {},
  )
    .render(120)
    .map((line) => line.trimEnd());
  const commandStart = expanded.indexOf("→ $ printf 'one'");
  assert.notEqual(commandStart, -1);
  assert.equal(expanded[commandStart + 1], "");
  assert.equal(expanded[commandStart + 2], "  npm    test");
});

test("renderSubagentResult keeps expanded commands beyond the collapsed limit", () => {
  const command = `echo ${"x".repeat(100)}`;
  const result = resultWithCommand(command);

  const collapsed = renderSubagentResult(
    result,
    { expanded: false, isPartial: false },
    plainTheme,
    {},
  )
    .render(200)
    .map((line) => line.trimEnd())
    .find((line) => line.startsWith("→ $"));
  const expanded = renderSubagentResult(
    result,
    { expanded: true, isPartial: false },
    plainTheme,
    {},
  )
    .render(200)
    .map((line) => line.trimEnd())
    .find((line) => line.startsWith("→ $"));

  assert.equal(collapsed, `→ $ echo ${"x".repeat(62)}…`);
  assert.equal(visibleWidth(collapsed), COLLAPSED_TOOL_CALL_LINE_WIDTH);
  assert.equal(expanded, `→ $ ${command}`);
});
