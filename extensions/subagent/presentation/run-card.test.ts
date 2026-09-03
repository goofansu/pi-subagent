import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelledEnding,
  failedEnding,
  resultLink,
  runDiagnostic,
} from "../domain/index.ts";
import {
  FIXTURE_NOW,
  fixtureResult,
  fixtureRow,
  fixtureUsage,
} from "../testing/presentation-fixtures.ts";
import { RECENT_TRANSCRIPT_ITEMS, runCard, runCardLines } from "./run-card.ts";

test("a live card comes from a snapshot and carries no output", () => {
  const card = runCard({
    from: "live",
    row: fixtureRow({ usage: fixtureUsage({ turns: 3, input: 1_200 }) }),
    now: FIXTURE_NOW,
  });

  assert.deepEqual(card, {
    runId: "run-1",
    subagentId: "subagent-1",
    agent: "explore",
    description: "look around",
    backendId: "pi",
    status: "running",
    tone: "warning",
    accounting: "1.2k in · 3 turns",
  });
  // The published index does not carry output, so a live card cannot claim to.
  assert.equal(card.output, undefined);
});

test("a live card of a finalizing Run says finalizing, not completed", () => {
  const card = runCard({
    from: "live",
    row: fixtureRow({ phase: "finalizing" }),
    now: FIXTURE_NOW,
  });

  assert.equal(card.status, "finalizing");
  assert.equal(card.tone, "warning");
});

test("a terminal card comes from the stored Result and carries the answer", () => {
  const card = runCard({
    from: "result",
    result: fixtureResult({
      finalOutput: "done",
      usage: fixtureUsage({ input: 12_300, output: 4_500, turns: 3 }),
      model: "claude-sonnet-4-6",
    }),
  });

  assert.deepEqual(card, {
    runId: "run-1",
    subagentId: "subagent-1",
    agent: "explore",
    description: "look around",
    backendId: "pi",
    status: "completed in 12.4s",
    tone: "success",
    accounting: "12.3k in / 4.5k out · 3 turns · claude-sonnet-4-6",
    output: "done",
  });
});

test("a terminal card carries the failed and cancelled tones and bodies", () => {
  const failed = runCard({
    from: "result",
    result: fixtureResult({ ending: failedEnding("boom") }),
  });
  const cancelled = runCard({
    from: "result",
    result: fixtureResult({ ending: cancelledEnding("requested") }),
  });

  assert.equal(failed.tone, "error");
  assert.equal(failed.status, "failed after 12.4s");
  assert.match(failed.output ?? "", /^This Run failed before completing\./);
  assert.equal(cancelled.tone, "error");
  assert.equal(cancelled.status, "cancelled after 12.4s");
  assert.match(cancelled.output ?? "", /^The Run was cancelled/);
});

test("a card with nothing to account for omits the accounting line", () => {
  assert.equal(
    runCard({ from: "result", result: fixtureResult({}) }).accounting,
    undefined,
  );
});

test("card lines put identity first and the answer last, with air between", () => {
  assert.deepEqual(
    runCardLines(
      runCard({
        from: "result",
        result: fixtureResult({
          finalOutput: "done",
          usage: fixtureUsage({ turns: 2 }),
        }),
      }),
    ),
    [
      "explore (subagent subagent-1), run run-1",
      "look around · pi · completed in 12.4s",
      "2 turns",
      "",
      "done",
    ],
  );
});

test("a live card's lines stop at the header, because there is no body", () => {
  assert.deepEqual(
    runCardLines(
      runCard({ from: "live", row: fixtureRow({}), now: FIXTURE_NOW }),
    ),
    [
      "explore (subagent subagent-1), run run-1",
      "look around · pi · running",
      "3 turns",
    ],
  );
});

// ── The expanded card ────────────────────────────────────────────────────────

/** One Result with something in every section the expanded card can show. */
function fullResult() {
  return fixtureResult({
    finalOutput: "the answer",
    usage: fixtureUsage({
      input: 12_300,
      output: 4_500,
      turns: 3,
      cost: 0.0125,
      context: { tokens: 18_400, window: 200_000 },
    }),
    model: "openai-codex/gpt-5.4-mini",
    transcript: [
      { role: "assistant", parts: [{ kind: "tool_call", name: "read_file" }] },
      { role: "tool", parts: [{ kind: "text", text: "40 lines" }] },
      { role: "user", parts: [{ kind: "text", text: "keep going" }] },
      { role: "assistant", parts: [{ kind: "text", text: "the answer" }] },
    ],
    tools: [
      { name: "read_file", status: "completed", outputSummary: "40 lines" },
      { name: "bash", status: "failed" },
    ],
    diagnostics: [runDiagnostic("control", "Pi steering was not delivered")],
    links: [resultLink("native-session", "session file", "/tmp/session.json")],
    truncation: { droppedTranscriptItems: 4, droppedToolEntries: 1 },
  });
}

test("the expanded card carries every section a Run reported", () => {
  const card = runCard({ from: "result", result: fullResult() });

  assert.deepEqual(runCardLines(card), [
    "explore (subagent subagent-1), run run-1",
    "look around · pi · completed in 12.4s",
    "cost $0.0125 · 12.3k in / 4.5k out · 3 turns · openai-codex/gpt-5.4-mini",
    "context 18.4k / 200.0k (9%)",
    "",
    "Recent transcript:",
    "  assistant: calls read_file",
    "  tool: 40 lines",
    "  user: keep going",
    "  assistant: the answer",
    "",
    "Tools:",
    "  read_file — completed: 40 lines",
    "  bash — failed",
    "",
    "Diagnostics:",
    "  control: Pi steering was not delivered",
    "",
    "Links:",
    "  session file (native-session): /tmp/session.json",
    "",
    "Dropped to stay within bounds: 4 transcript items, 1 tool entries.",
    "",
    "the answer",
  ]);
});

test("a Run that reported nothing shows only what it has", () => {
  const card = runCard({ from: "result", result: fixtureResult({}) });

  // No accounting, no gauge, no transcript, no tools, no diagnostics, no
  // links, and no truncation record: every section is absent rather than
  // titled and empty.
  assert.equal(card.accounting, undefined);
  assert.equal(card.context, undefined);
  assert.equal(card.transcript, undefined);
  assert.equal(card.tools, undefined);
  assert.equal(card.diagnostics, undefined);
  assert.equal(card.links, undefined);
  assert.equal(card.truncation, undefined);
  assert.deepEqual(runCardLines(card), [
    "explore (subagent subagent-1), run run-1",
    "look around · pi · completed in 12.4s",
    "",
    "The Run finished without output.",
  ]);
});

test("the transcript section keeps only the most recent items", () => {
  const card = runCard({
    from: "result",
    result: fixtureResult({
      transcript: Array.from(
        { length: RECENT_TRANSCRIPT_ITEMS + 3 },
        (_unused, index) => ({
          role: "assistant" as const,
          parts: [{ kind: "text" as const, text: `message ${index}` }],
        }),
      ),
    }),
  });

  assert.equal(card.transcript?.length, RECENT_TRANSCRIPT_ITEMS);
  assert.equal(card.transcript?.[0], "assistant: message 3");
  assert.equal(
    card.transcript?.[RECENT_TRANSCRIPT_ITEMS - 1],
    `assistant: message ${RECENT_TRANSCRIPT_ITEMS + 2}`,
  );
});

test("a gauge with no window reported reads as an occupancy alone", () => {
  const card = runCard({
    from: "result",
    result: fixtureResult({
      usage: fixtureUsage({ context: { tokens: 1_800 } }),
    }),
  });

  assert.equal(card.context, "context 1.8k");
});
