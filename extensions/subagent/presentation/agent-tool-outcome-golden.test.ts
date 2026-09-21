import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
  CancelOutcome,
  ResultOutcome,
  ResumeOutcome,
  StartOutcome,
  SteerOutcome,
  WaitOutcome,
} from "../domain/index.ts";
import { runId, subagentId } from "../domain/index.ts";
import { fixtureResult } from "../testing/presentation-fixtures.ts";
import {
  type AgentToolOperation,
  type AgentToolRendererState,
  agentToolRenderers,
} from "./agent-tool-renderers.ts";
import {
  presentCancelOutcomes,
  presentResultOutcome,
  presentResumeOutcome,
  presentStartOutcome,
  presentSteerOutcome,
  presentWait,
} from "./prose.ts";
import type { RenderableTheme } from "./rows.ts";
import type { ToolRowFacts } from "./tool-row-facts.ts";

initTheme(undefined, false);

const GOLDEN_PATH = new URL(
  "./fixtures/agent-tool-outcomes.golden.json",
  import.meta.url,
);
const WIDTHS = [48, 120] as const;
const RUN = runId("run-1");
const OTHER_RUN = runId("run-2");
const SUBAGENT = subagentId("subagent-1");
const RESULT = fixtureResult({ finalOutput: "answer" });

const plainTheme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  inverse: (text) => text,
};

interface GoldenCase {
  readonly name: string;
  readonly operation: AgentToolOperation;
  readonly text: string;
  readonly facts: ToolRowFacts;
}

function startCases(): readonly GoldenCase[] {
  const outcomes: readonly StartOutcome[] = [
    { outcome: "started", subagentId: SUBAGENT, runId: RUN },
    { outcome: "unknown agent", agent: "ghost" },
    { outcome: "invalid profile", diagnostics: [] },
    { outcome: "empty label" },
    { outcome: "at capacity" },
    { outcome: "shutting down" },
    { outcome: "delegation-depth exceeded", depth: 2 },
    {
      outcome: "backend unavailable",
      diagnostic: { category: "backend-failure", message: "unavailable" },
    },
  ];
  return outcomes.map((outcome) => {
    const presentation = presentStartOutcome("explore", outcome, [
      "explore",
      "review",
    ]);
    return {
      name: `start/${outcome.outcome}`,
      operation: "start",
      text: presentation.text,
      facts: presentation.facts,
    };
  });
}

function resumeCases(): readonly GoldenCase[] {
  const outcomes: readonly ResumeOutcome[] = [
    { outcome: "started", subagentId: SUBAGENT, runId: RUN },
    { outcome: "unknown Subagent", subagentId: SUBAGENT },
    { outcome: "Subagent already running", subagentId: SUBAGENT },
    { outcome: "empty label" },
    { outcome: "resume unsupported" },
    { outcome: "conversation lost" },
    { outcome: "at capacity" },
    { outcome: "shutting down" },
  ];
  return outcomes.map((outcome) => {
    const presentation = presentResumeOutcome(SUBAGENT, outcome);
    return {
      name: `resume/${outcome.outcome}`,
      operation: "resume",
      text: presentation.text,
      facts: presentation.facts,
    };
  });
}

function steerCases(): readonly GoldenCase[] {
  const outcomes: readonly SteerOutcome[] = [
    { outcome: "accepted", runId: RUN },
    { outcome: "mailbox full", runId: RUN },
    { outcome: "invalid", reason: "empty" },
    { outcome: "unsupported", runId: RUN },
    { outcome: "mailbox closed", runId: RUN },
    { outcome: "already completed", runId: RUN },
    { outcome: "already failed", runId: RUN },
    { outcome: "already cancelled", runId: RUN },
    { outcome: "unknown Run", runId: RUN },
    { outcome: "shutting down" },
  ];
  return outcomes.map((outcome) => {
    const presentation = presentSteerOutcome(RUN, outcome);
    return {
      name: `steer/${outcome.outcome}`,
      operation: "steer",
      text: presentation.text,
      facts: presentation.facts,
    };
  });
}

function cancelCases(): readonly GoldenCase[] {
  const outcomes: readonly CancelOutcome[] = [
    { outcome: "admitted", runId: RUN },
    { outcome: "idempotent", runId: RUN },
    { outcome: "already completed", runId: RUN },
    { outcome: "already failed", runId: RUN },
    { outcome: "already cancelled", runId: RUN },
    { outcome: "unknown Run", runId: RUN },
  ];
  return [
    ...outcomes.map((outcome) => {
      const presentation = presentCancelOutcomes([outcome]);
      return {
        name: `cancel/${outcome.outcome}`,
        operation: "cancel" as const,
        text: presentation.text,
        facts: presentation.facts,
      };
    }),
    (() => {
      const presentation = presentCancelOutcomes([
        { outcome: "admitted", runId: RUN },
        { outcome: "idempotent", runId: OTHER_RUN },
        { outcome: "already failed", runId: runId("run-3") },
        { outcome: "unknown Run", runId: runId("run-4") },
      ]);
      return {
        name: "cancel/mixed buckets",
        operation: "cancel" as const,
        text: presentation.text,
        facts: presentation.facts,
      };
    })(),
    (() => {
      const presentation = presentCancelOutcomes([]);
      return {
        name: "cancel/empty",
        operation: "cancel" as const,
        text: presentation.text,
        facts: presentation.facts,
      };
    })(),
  ];
}

function waitCases(operation: "wait" | "waitAll"): readonly GoldenCase[] {
  const cases: readonly [string, readonly WaitOutcome[]][] = [
    [
      "delivered",
      [
        {
          outcome: "terminal",
          runId: RESULT.runId,
          status: "completed",
          result: RESULT,
        },
      ],
    ],
    ["unavailable", [{ outcome: "terminal", runId: RUN, status: "failed" }]],
    [
      "cancelled/requested",
      [
        {
          outcome: "terminal",
          runId: RUN,
          status: "cancelled",
          cancellationReason: "requested",
        },
      ],
    ],
    [
      "cancelled/shutdown",
      [
        {
          outcome: "terminal",
          runId: RUN,
          status: "cancelled",
          cancellationReason: "shutdown",
        },
      ],
    ],
    [
      "cancelled/timeout",
      [
        {
          outcome: "terminal",
          runId: RUN,
          status: "cancelled",
          cancellationReason: "timeout",
        },
      ],
    ],
    [
      "cancelled/no reason",
      [{ outcome: "terminal", runId: RUN, status: "cancelled" }],
    ],
    ["still running", [{ outcome: "still running", runId: RUN }]],
    ["unknown Run", [{ outcome: "unknown Run", runId: RUN }]],
    [
      "mixed",
      [
        {
          outcome: "terminal",
          runId: RESULT.runId,
          status: "completed",
          result: RESULT,
        },
        { outcome: "terminal", runId: OTHER_RUN, status: "failed" },
        { outcome: "still running", runId: OTHER_RUN },
        { outcome: "unknown Run", runId: runId("run-3") },
      ],
    ],
    ["empty", []],
  ];
  return cases.map(([name, outcomes]) => {
    const presentation = presentWait({
      scope: operation === "wait" ? "named" : "all-active",
      outcomes,
      agents: new Map([
        [RUN, "explore"],
        [OTHER_RUN, "review"],
      ]),
    });
    return {
      name: `${operation}/${name}`,
      operation,
      text: presentation.text,
      facts: presentation.facts,
    };
  });
}

function resultCases(): readonly GoldenCase[] {
  const outcomes: readonly ResultOutcome[] = [
    { outcome: "result", result: RESULT },
    {
      outcome: "result",
      result: fixtureResult({ finalOutput: "" }),
    },
    {
      outcome: "result",
      result: fixtureResult({
        finalOutput: "",
        truncation: { truncatedOutputBytes: 7 },
      }),
    },
    {
      outcome: "ResultExpired",
      runId: RUN,
      subagentId: SUBAGENT,
      status: "failed",
    },
    { outcome: "RunNotTerminal", runId: RUN },
    { outcome: "unknown Run", runId: RUN },
  ];
  return outcomes.map((outcome, index) => {
    const presentation = presentResultOutcome(outcome);
    return {
      name:
        outcome.outcome === "result"
          ? `result/available-${["visible", "none", "removed"][index]}`
          : `result/${outcome.outcome}`,
      operation: "result",
      text: presentation.text,
      facts: presentation.facts,
    };
  });
}

function allCases(): readonly GoldenCase[] {
  return [
    ...startCases(),
    ...resumeCases(),
    ...steerCases(),
    ...cancelCases(),
    ...waitCases("wait"),
    ...waitCases("waitAll"),
    (() => {
      const presentation = presentWait({
        scope: "all-active",
        noActiveRuns: true,
      });
      return {
        name: "waitAll/no active Runs",
        operation: "waitAll" as const,
        text: presentation.text,
        facts: presentation.facts,
      };
    })(),
    ...resultCases(),
  ];
}

function collapsedRow(entry: GoldenCase, width: number): string {
  const state: AgentToolRendererState = {};
  const context = {
    args: {},
    lastComponent: undefined,
    state,
    expanded: false,
    isPartial: false,
    argsComplete: true,
  };
  const component: Component = agentToolRenderers(entry.operation).renderResult(
    {
      content: [{ type: "text", text: entry.text }],
      details: entry.facts,
    },
    { expanded: false, isPartial: false },
    plainTheme,
    context,
  );
  return component
    .render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join("\n");
}

function currentGolden(): unknown {
  return Object.fromEntries(
    allCases().map((entry) => [
      entry.name,
      {
        modelText: entry.text,
        collapsedRows: Object.fromEntries(
          WIDTHS.map((width) => [String(width), collapsedRow(entry, width)]),
        ),
      },
    ]),
  );
}

test("golden: every agent-tool operation outcome keeps model text and collapsed rows at two widths", () => {
  const current = currentGolden();
  if (process.env.UPDATE_AGENT_TOOL_OUTCOME_GOLDEN === "1") {
    writeFileSync(GOLDEN_PATH, `${JSON.stringify(current, null, 2)}\n`);
  }
  const expected = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as unknown;
  assert.deepEqual(current, expected);
});
