/**
 * Fixtures the presentation golden tests share.
 *
 * A golden test asserts on an exact string, so what goes into it has to be
 * boring and identical everywhere: the same agent, the same ids, the same
 * instants. Building those once means a new golden test states only what it is
 * about, and a change to the shared fixture shows up as a diff in every golden
 * at once rather than in one of them.
 *
 * It lives in the test tree rather than beside the module it is for. A file
 * under `presentation/` that is not a `.test.ts` is *production* presentation
 * code as far as the boundary test is concerned, and a fixture module is not
 * that — the boundary rule for presentation exists to keep a production
 * renderer from reaching the runtime, and a fixture sitting inside it would be
 * a hole in that rule rather than an exception to it.
 */

import {
  answeredEnding,
  backendId,
  type CancellationReason,
  type ContextGauge,
  createRunProjection,
  EMPTY_TRUNCATION_RECORD,
  type ResultLink,
  type RunDiagnostic,
  type RunEnding,
  type RunIdentity,
  type RunNotification,
  type RunPhase,
  type RunResult,
  runId,
  subagentId,
  type ToolEntry,
  type TranscriptItem,
  type TruncationRecord,
  toRunNotification,
  toRunResult,
  type UsageSnapshot,
} from "../domain/index.ts";
import type { RunRowView } from "../presentation/views.ts";

export const FIXTURE_IDENTITY: RunIdentity = {
  runId: runId("run-1"),
  subagentId: subagentId("subagent-1"),
  backendId: backendId("pi"),
  agent: "explore",
  description: "look around",
};

/** The instant every fixture Run started, and one 12.4 seconds later. */
export const FIXTURE_STARTED_AT = 1_000;
export const FIXTURE_NOW = FIXTURE_STARTED_AT + 12_400;

export const NO_USAGE: UsageSnapshot = {
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  context: { tokens: 0 },
  turns: 0,
};

/** Usage with something in every field the accounting line reads. */
export function fixtureUsage(
  overrides: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly cost?: number;
    readonly turns?: number;
    readonly context?: ContextGauge;
  } = {},
): UsageSnapshot {
  return {
    totals: {
      input: overrides.input ?? 0,
      output: overrides.output ?? 0,
      cacheRead: overrides.cacheRead ?? 0,
      cacheWrite: overrides.cacheWrite ?? 0,
      cost: overrides.cost ?? 0,
    },
    context: overrides.context ?? { tokens: 0 },
    turns: overrides.turns ?? 0,
  };
}

/** One row of the published Run index. */
export function fixtureRow(
  overrides: Omit<Partial<RunRowView>, "identity"> & {
    readonly identity?: Partial<RunIdentity>;
  } = {},
): RunRowView {
  const { identity, ...rest } = overrides;
  const phase: RunPhase = rest.phase ?? "running";
  return {
    identity: { ...FIXTURE_IDENTITY, ...identity },
    phase,
    usage: fixtureUsage({ turns: 3 }),
    tools: 0,
    startedAt: FIXTURE_STARTED_AT,
    ...(phase === "completed" || phase === "failed" || phase === "cancelled"
      ? { terminalStatus: phase }
      : {}),
    ...rest,
  };
}

export interface FixtureResultOptions {
  readonly ending?: RunEnding;
  readonly finalOutput?: string;
  readonly usage?: UsageSnapshot;
  readonly model?: string;
  readonly diagnostics?: readonly RunDiagnostic[];
  readonly identity?: Partial<RunIdentity>;
  readonly settledAt?: number;
  /** What the Run said, for the expanded card's transcript section. */
  readonly transcript?: readonly TranscriptItem[];
  readonly tools?: readonly ToolEntry[];
  readonly links?: readonly ResultLink[];
  /** What bounding dropped, so the card's truncation record has something. */
  readonly truncation?: Partial<TruncationRecord>;
}

/** One immutable stored Result, built the way settlement builds it. */
export function fixtureResult(options: FixtureResultOptions = {}): RunResult {
  return toRunResult({
    identity: { ...FIXTURE_IDENTITY, ...options.identity },
    projection: {
      ...createRunProjection(),
      finalOutput: options.finalOutput ?? "",
      usage: options.usage ?? NO_USAGE,
      diagnostics: options.diagnostics ?? [],
      transcript: options.transcript ?? [],
      tools: options.tools ?? [],
      links: options.links ?? [],
      truncation: {
        ...EMPTY_TRUNCATION_RECORD,
        ...(options.truncation ?? {}),
      },
      ...(options.model === undefined ? {} : { model: options.model }),
    },
    ending: options.ending ?? answeredEnding(),
    startedAt: FIXTURE_STARTED_AT,
    settledAt: options.settledAt ?? FIXTURE_NOW,
  });
}

/** The notice for one fixture Result, exactly as delivery would build it. */
export function fixtureNotification(
  options: FixtureResultOptions = {},
): RunNotification {
  return toRunNotification(fixtureResult(options));
}

/** A cancellation reason, spelled once so a golden test reads as a sentence. */
export const REQUESTED: CancellationReason = "requested";
