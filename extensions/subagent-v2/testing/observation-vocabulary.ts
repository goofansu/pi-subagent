/**
 * What an observation is allowed to say, as data.
 *
 * ADR-0024's boundary rule — no provider thread, turn, item, request,
 * correlation, or session identifier, no exit code, no backend stop word —
 * is only as good as something that checks it. Two things check it here, and
 * both are shared between the domain's own type tests and the backend
 * conformance suite, so a real adapter is held to exactly the rule the domain
 * types are held to.
 *
 * 1. {@link OBSERVATION_KEYS} pins the exact key set of every observation
 *    kind, so a new field is a failing test rather than a quiet widening.
 * 2. {@link findForbiddenKeys} walks a value and reports any key that names
 *    provider bookkeeping, however deeply it is nested.
 */

import {
  answeredEnding,
  contextGauge,
  type RunObservation,
  type RunObservationKind,
  resultLink,
  runDiagnostic,
  usageDelta,
} from "../domain/index.ts";

/** The exact key set of each observation kind. */
export const OBSERVATION_KEYS: {
  readonly [K in RunObservationKind]: readonly string[];
} = {
  message: ["kind", "role", "parts", "model"],
  tool_progress: ["kind", "callId", "status", "outputSummary"],
  activity: ["kind", "activity"],
  usage: ["kind", "usage"],
  context: ["kind", "context"],
  diagnostic: ["kind", "diagnostic"],
  link: ["kind", "link"],
  model: ["kind", "model"],
  reconciliation: ["kind", "reconciliation"],
  ending: ["kind", "ending"],
};

/**
 * Key names that would mean provider bookkeeping had crossed the boundary.
 *
 * Compared after normalizing away case, underscores, and dashes, so
 * `thread_id` and `threadID` are caught alongside `threadId`. `turns` is
 * deliberately not caught: a turn *count* is a usage figure the core owns,
 * while a turn *id* is provider ordering.
 */
export const FORBIDDEN_OBSERVATION_KEYS: readonly string[] = [
  "threadid",
  "turnid",
  "itemid",
  "requestid",
  "correlationid",
  "sessionid",
  "sessionuuid",
  "uuid",
  "exitcode",
  "stopreason",
  "stopword",
  "signal",
  "pid",
  "rawevent",
  "providerevent",
];

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

/** Every forbidden key found anywhere in a value, as `path` strings. */
export function findForbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      findForbiddenKeys(entry, `${path}[${index}]`),
    );
  }
  if (typeof value !== "object" || value === null) return [];
  const found: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (FORBIDDEN_OBSERVATION_KEYS.includes(normalizeKey(key)))
      found.push(here);
    found.push(...findForbiddenKeys(entry, here));
  }
  return found;
}

/**
 * One observation of every kind with every optional field populated.
 *
 * Populating the optional fields is the point: a key-set check against a
 * minimal sample would not notice a field that only appears when it is set.
 */
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
