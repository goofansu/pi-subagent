/**
 * One observation of every kind, fully populated, for the tests that need a
 * representative sample of the whole vocabulary.
 *
 * This module used to hold two checks as well: a table pinning the exact key
 * set of every observation kind, and a walker that reported any key naming
 * provider bookkeeping however deeply it was nested. Both are gone, and what
 * replaced them is one line — decoding the observation union under
 * {@link EXACT_KEYS}, which rejects *any* unlisted key at *any* depth rather
 * than a list of the ones somebody thought of.
 *
 * Populating the optional fields is the point of what remains: a key-set check
 * against a minimal sample would not notice a field that only appears when it
 * is set, and neither would a round trip.
 */

import {
  answeredEnding,
  contextGauge,
  type RunObservation,
  resultLink,
  runDiagnostic,
  usageDelta,
} from "../domain/index.ts";

export function sampleObservations(): readonly RunObservation[] {
  return [
    {
      kind: "message",
      role: "assistant",
      parts: [
        { kind: "text", text: "on it" },
        { kind: "tool_call", name: "read_file", callId: "call-1" },
      ],
      model: "model-a",
    },
    {
      kind: "tool_progress",
      callId: "call-1",
      status: "completed",
      outputSummary: "42 lines",
    },
    { kind: "activity", activity: "reading files" },
    { kind: "usage", usage: usageDelta({ input: 10, output: 4, turns: 1 }) },
    { kind: "context", context: contextGauge(1_200, 200_000) },
    {
      kind: "diagnostic",
      diagnostic: runDiagnostic("backend-failure", "the backend gave up"),
    },
    { kind: "link", link: resultLink("native-session", "session", "/tmp/s") },
    { kind: "model", model: "model-a" },
    {
      kind: "reconciliation",
      reconciliation: {
        transcript: [
          { role: "assistant", parts: [{ kind: "text", text: "done" }] },
        ],
        finalOutput: "done",
        usage: { input: 11, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.5 },
        context: contextGauge(1_500),
        turns: 2,
        model: "model-a",
      },
    },
    { kind: "ending", ending: answeredEnding() },
  ];
}
