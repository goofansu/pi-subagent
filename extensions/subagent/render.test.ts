import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { COLLAPSED_TOOL_CALL_LINE_WIDTH } from "./formatting.ts";
import { formatLifecycleStatus, renderSubagentResult } from "./render.ts";
import type {
  PersistedSubagentDetails,
  SingleResult,
  UsageStats,
} from "./types.ts";

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

function singleResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "worker",
    description: "",
    harness: "pi",
    status: "completed",
    queuedAt: 1_000,
    startedAt: 2_000,
    finishedAt: 3_000,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    ...overrides,
  };
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
        singleResult({
          description: "test command rendering",
          messages,
        }),
      ],
    },
  };
}

test("formatLifecycleStatus reports queue time, run time, and terminal duration", () => {
  const queued = singleResult({
    status: "queued",
    queuedAt: 1_000,
    startedAt: undefined,
    finishedAt: undefined,
    exitCode: -1,
  });
  const running = singleResult({
    status: "running",
    startedAt: 2_000,
    finishedAt: undefined,
    exitCode: -1,
  });

  assert.equal(formatLifecycleStatus(queued, 4_000), "queued for 3.0s");
  assert.equal(formatLifecycleStatus(running, 4_000), "running for 2.0s");
  assert.equal(
    formatLifecycleStatus(singleResult({ finishedAt: 7_000 }), 100_000),
    "completed in 5.0s",
  );
  assert.equal(
    formatLifecycleStatus(
      singleResult({ status: "failed", exitCode: 1, finishedAt: 7_000 }),
      100_000,
    ),
    "failed after 5.0s",
  );
  assert.equal(
    formatLifecycleStatus(
      singleResult({
        status: "aborted",
        queuedAt: 1_000,
        startedAt: undefined,
        finishedAt: 4_000,
        exitCode: 1,
      }),
      100_000,
    ),
    "aborted while queued after 3.0s",
  );
});

test("renderSubagentResult distinguishes queued and running placeholders", () => {
  const render = (single: SingleResult, expanded: boolean) =>
    renderSubagentResult(
      {
        content: [{ type: "text", text: "" }],
        details: { results: [single] },
      },
      { expanded, isPartial: true },
      plainTheme,
      {},
    )
      .render(120)
      .map((line) => line.trimEnd());

  const now = Date.now();
  const queued = render(
    singleResult({
      status: "queued",
      queuedAt: now,
      startedAt: undefined,
      finishedAt: undefined,
      exitCode: -1,
    }),
    false,
  );
  const running = render(
    singleResult({
      status: "running",
      queuedAt: now,
      startedAt: now,
      finishedAt: undefined,
      exitCode: -1,
    }),
    true,
  );

  assert.match(queued[0], /^○ worker \[queued for \d+\.\ds\]$/);
  assert.ok(queued.includes("(queued...)"));
  assert.match(running[0], /^⏳ worker \[running for \d+\.\ds\]$/);
  assert.ok(running.includes("(running...)"));
});

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
