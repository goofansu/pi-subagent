import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { sampleObservations } from "../testing/observation-vocabulary.ts";
import { EXACT_KEYS } from "./decoding.ts";
import { RunDiagnostic, runDiagnostic } from "./diagnostics.ts";
import {
  answeredEnding,
  cancelledEnding,
  failedEnding,
  RunEnding,
} from "./endings.ts";
import { BackendId, ControlId, RunId, SubagentId } from "./ids.ts";
import { ResultLink, resultLink } from "./links.ts";
import { decodeRunObservation, RunObservation } from "./observations.ts";
import { TruncationRecord } from "./projection.ts";
import { TerminalReconciliation } from "./reconciliation.ts";
import { RunIdentity, RunResult } from "./result.ts";
import { ToolEntry, TranscriptItem } from "./transcript.ts";
import {
  ContextGauge,
  contextGauge,
  UsageDelta,
  UsageSnapshot,
  UsageTotals,
  usageDelta,
} from "./usage.ts";

/**
 * Every domain schema, round-tripped.
 *
 * ADR-0029's whole point is that a type and its admissible shapes are one
 * piece of knowledge. The way that claim can be wrong is a declaration that
 * describes a *different* value from the one the type describes — a field
 * declared optional that the type requires, a number declared where a string
 * is stored, an encoder that loses a key. A round trip catches all three: a
 * representative value is encoded, decoded back, and compared.
 *
 * `RunResult` is the one that has to hold, because the Result store persists
 * through this encoder and reads back through this decoder. The rest hold
 * because they are what `RunResult` is made of.
 */

/** Encode and decode one value, and give back what came out. */
function roundTrip<S extends Schema.Codec<never, never, never, never>>(
  schema: S,
  value: unknown,
): unknown {
  const encoded = Schema.encodeUnknownSync(schema as never, EXACT_KEYS)(value);
  return Schema.decodeUnknownSync(schema as never, EXACT_KEYS)(encoded);
}

const identity: RunIdentity = {
  runId: RunId.make("run-1"),
  subagentId: SubagentId.make("subagent-1"),
  backendId: BackendId.make("fake-resumable"),
  agent: "explore",
  description: "look around",
};

const truncation: TruncationRecord = {
  droppedTranscriptItems: 2,
  droppedToolEntries: 1,
  droppedDiagnostics: 0,
  droppedLinks: 0,
  truncatedTranscriptBytes: 40,
  truncatedToolOutputBytes: 0,
  truncatedOutputBytes: 12,
};

const usage: UsageSnapshot = {
  totals: { input: 10, output: 4, cacheRead: 1, cacheWrite: 2, cost: 0.25 },
  context: contextGauge(1_200, 200_000),
  turns: 2,
};

const result: RunResult = {
  ...identity,
  status: "cancelled",
  cancellationReason: "timeout",
  finalOutput: "as far as it got",
  transcript: [
    { role: "user", parts: [{ kind: "text", text: "look around" }] },
    {
      role: "assistant",
      parts: [
        { kind: "text", text: "as far as it got" },
        { kind: "tool_call", name: "read_file", callId: "call-1" },
      ],
      model: "model-a",
    },
  ],
  tools: [{ name: "read_file", status: "cancelled", callId: "call-1" }],
  usage,
  diagnostics: [runDiagnostic("backend-failure", "[redacted]")],
  links: [resultLink("native-session", "session", "/tmp/session.json")],
  model: "model-a",
  startedAt: 1_000,
  settledAt: 2_000,
  truncation,
};

const cases: readonly [
  string,
  Schema.Codec<never, never, never, never>,
  unknown,
][] = [
  ["BackendId", BackendId as never, identity.backendId],
  ["SubagentId", SubagentId as never, identity.subagentId],
  ["RunId", RunId as never, identity.runId],
  ["ControlId", ControlId as never, ControlId.make("control-1")],
  ["RunEnding answered", RunEnding as never, answeredEnding()],
  ["RunEnding failed", RunEnding as never, failedEnding("it gave up")],
  ["RunEnding failed with no message", RunEnding as never, failedEnding()],
  ["RunEnding cancelled", RunEnding as never, cancelledEnding("shutdown")],
  ["UsageDelta", UsageDelta as never, usageDelta({ input: 3, cost: 0.5 })],
  ["ContextGauge", ContextGauge as never, contextGauge(1_200, 200_000)],
  ["UsageTotals", UsageTotals as never, usage.totals],
  ["UsageSnapshot", UsageSnapshot as never, usage],
  ["RunDiagnostic", RunDiagnostic as never, runDiagnostic("control", "sent")],
  ["ResultLink", ResultLink as never, resultLink("url", "docs", "https://x")],
  ["TranscriptItem", TranscriptItem as never, result.transcript[1]],
  ["ToolEntry", ToolEntry as never, result.tools[0]],
  ["TruncationRecord", TruncationRecord as never, truncation],
  ["RunIdentity", RunIdentity as never, identity],
  ["RunResult", RunResult as never, result],
  [
    "TerminalReconciliation",
    TerminalReconciliation as never,
    {
      transcript: result.transcript,
      finalOutput: "the real answer",
      usage: { input: 11 },
      context: contextGauge(1_500),
      turns: 3,
      model: "model-a",
    },
  ],
];

test("every domain schema round-trips a representative value unchanged", () => {
  for (const [name, schema, value] of cases) {
    assert.deepEqual(roundTrip(schema, value), value, name);
  }
});

test("every observation kind round-trips, optional fields and all", () => {
  for (const observation of sampleObservations()) {
    assert.deepEqual(
      roundTrip(RunObservation as never, observation),
      observation,
      observation.kind,
    );
  }
});

test("a stored result decodes back to a value that is deep-equal, not merely similar", () => {
  const decoded = roundTrip(RunResult as never, result) as RunResult;

  assert.deepEqual(decoded, result);
  // The two optional fields are the ones a sloppy encoder would invent or
  // drop: an absent `errorMessage` must stay absent rather than becoming
  // `undefined`, which a `deepEqual` on a whole object can miss.
  assert.equal("errorMessage" in decoded, false);
  assert.equal("cancellationReason" in decoded, true);
});

test("an observation carrying an unlisted key does not decode", () => {
  const decode = decodeRunObservation;

  assert.equal(
    decode({ kind: "message", role: "user", parts: [], threadId: "t-1" })._tag,
    "Failure",
  );
  assert.equal(
    decode({
      kind: "message",
      role: "user",
      parts: [{ kind: "text", text: "hi", spanId: "s-1" }],
    })._tag,
    "Failure",
  );
  assert.equal(
    decode({ kind: "usage", usage: { input: 1, requestId: "r-1" } })._tag,
    "Failure",
  );
  assert.equal(
    decode({ kind: "message", role: "user", parts: [] })._tag,
    "Success",
  );
});

test("a result that fails to decode is a visible failure, not an empty result", () => {
  const decode = Schema.decodeUnknownResult(RunResult, EXACT_KEYS);

  // A stored value whose status is not one of the three terminal phases.
  const wrong = decode({ ...result, status: "running" });
  assert.equal(wrong._tag, "Failure");
  if (wrong._tag === "Failure") {
    assert.match(wrong.failure.message, /\["status"\]/);
  }
});
