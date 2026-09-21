/**
 * Presentation meaning carried beside an agent tool's model-visible prose.
 *
 * Tool-row facts are not domain values: they are the bounded facts needed to
 * draw one collapsed tool row. Construction translates every domain outcome
 * explicitly, while decoding treats the host-owned `details` slot as unknown.
 * Neither operation can decide Run meaning or Result hand-off.
 */

import { Schema } from "effect";
import {
  type CancelOutcome,
  EXACT_KEYS,
  interpretFinalOutput,
  type ProfileDiagnostic,
  type ResultOutcome,
  type ResumeOutcome,
  type RunId,
  type RunResult,
  type StartOutcome,
  type SteerOutcome,
  type SubagentId,
  TerminalRunPhase,
  type WaitOutcome,
} from "../domain/index.ts";
import {
  type CompactFinalOutputSummary,
  finalOutputSummary,
} from "./final-output-section.ts";
import { formatDiagnosticLine } from "./result-details.ts";

/** Styling intent for one pass-through operation's collapsed row. */
export type ToolRowTone = "toolTitle" | "warning" | "error";

interface OutcomePresentation<Outcome, Context> {
  readonly sentence: (outcome: Outcome, context: Context) => string;
  readonly rowPhrase: (outcome: Outcome) => string;
  readonly tone: ToolRowTone;
}

type OutcomeMember<
  Outcome extends { readonly outcome: string },
  Name extends Outcome["outcome"],
> = Outcome extends unknown
  ? Name extends Outcome["outcome"]
    ? Omit<Outcome, "outcome"> & { readonly outcome: Name }
    : never
  : never;

type OutcomeTable<Outcome extends { readonly outcome: string }, Context> = {
  readonly [Name in Outcome["outcome"]]: OutcomePresentation<
    OutcomeMember<Outcome, Name>,
    Context
  >;
};

interface StartSentenceContext {
  readonly agent: string;
  readonly available: readonly string[];
}

interface ResumeSentenceContext {
  readonly subagentId: SubagentId;
}

interface SteerSentenceContext {
  readonly runId: RunId;
}

function runPointer(runId: RunId): string {
  return (
    `Use run id ${runId} for agent_wait, agent_result, agent_cancel, and ` +
    "agent_steer."
  );
}

const NOTIFICATION_PROMISE =
  "Its completion is delivered to you automatically when the Run finishes; " +
  "continue independent work until then, and wait only if nothing else " +
  "remains.";

const LOCAL_ADMISSION_ONLY =
  "The complete message was synchronously admitted to this Run's local " +
  "bounded mailbox, and that is all acceptance means: it does not mean the " +
  "backend dequeued it, a provider accepted it, or a model consumed it. Do " +
  "not resend this steering message in a retry loop.";

/** Profile diagnostics as the shared model-visible list lines. */
export function formatProfileDiagnosticLines(
  diagnostics: readonly ProfileDiagnostic[],
): readonly string[] {
  return diagnostics.map(
    (diagnostic) => `- ${diagnostic.filePath}: ${diagnostic.reason}`,
  );
}

/** The unknown-agent diagnostic, which needs to name what does exist. */
export function unknownAgentSentence(
  agent: string,
  available: readonly string[],
): string {
  return `Unknown agent: "${agent}". Available: ${available.join(", ") || "none"}`;
}

/**
 * Every start outcome's model sentence and collapsed-row presentation.
 * The mapped type makes an added or removed domain outcome a compile error.
 */
export const START_OUTCOME_PRESENTATION = {
  started: {
    sentence: (outcome, context) =>
      `Started ${context.agent}:\nsubagent id ${outcome.subagentId}\n` +
      `run id ${outcome.runId}\n\n` +
      `${runPointer(outcome.runId)} ${NOTIFICATION_PROMISE}`,
    rowPhrase: () => "Started",
    tone: "toolTitle",
  },
  "unknown agent": {
    sentence: (outcome, context) =>
      unknownAgentSentence(outcome.agent, context.available),
    rowPhrase: () => "Start refused · unknown Agent",
    tone: "error",
  },
  "invalid profile": {
    sentence: (outcome, context) =>
      [
        `Cannot start ${context.agent}: its Profile is not usable. Nothing was started.`,
        ...formatProfileDiagnosticLines(outcome.diagnostics),
      ].join("\n"),
    rowPhrase: () => "Start refused · invalid Profile",
    tone: "error",
  },
  "empty label": {
    sentence: (_outcome, context) =>
      `Cannot start ${context.agent}: its description is empty. No Run was started ` +
      "and no id was handed out. Send a one-line description of the task: " +
      "it is the label this Run is shown under everywhere.",
    rowPhrase: () => "Start refused · empty Label",
    tone: "error",
  },
  "at capacity": {
    sentence: (_outcome, context) =>
      `Cannot start ${context.agent}: this Session is already running as many ` +
      "Subagent Runs as it allows. Nothing was queued and no Run was " +
      "started. Wait for a Run to finish, or cancel one, then try again.",
    rowPhrase: () => "Start refused · at capacity",
    tone: "warning",
  },
  "shutting down": {
    sentence: (_outcome, context) =>
      `Cannot start ${context.agent}: this Session is shutting down. No Run was ` +
      "started and nothing was queued.",
    rowPhrase: () => "Start refused · Session shutting down",
    tone: "warning",
  },
  "delegation-depth exceeded": {
    sentence: (outcome, context) =>
      `Cannot start ${context.agent}: delegation is already ${outcome.depth} ` +
      "levels deep, which is as far as it goes. No Run was started. Do this " +
      "work directly instead of delegating it again.",
    rowPhrase: (outcome) => `Start refused · delegation depth ${outcome.depth}`,
    tone: "warning",
  },
  "backend unavailable": {
    sentence: (outcome, context) =>
      `Cannot start ${context.agent}: its backend could not be opened ` +
      `(${formatDiagnosticLine(outcome.diagnostic)}). No Run was started and ` +
      "no id was handed out. Retrying may work; a different agent will work " +
      "if this backend is down.",
    rowPhrase: () => "Start refused · backend unavailable",
    tone: "error",
  },
} satisfies OutcomeTable<StartOutcome, StartSentenceContext>;

/** Every resume outcome's model sentence and collapsed-row presentation. */
export const RESUME_OUTCOME_PRESENTATION = {
  started: {
    sentence: (outcome, context) =>
      `Resumed subagent ${context.subagentId}:\nrun id ${outcome.runId}\n\n` +
      "agent_resume returns immediately, not with the answer. " +
      `${runPointer(outcome.runId)} ${NOTIFICATION_PROMISE}`,
    rowPhrase: () => "Resumed",
    tone: "toolTitle",
  },
  "unknown Subagent": {
    sentence: (outcome) =>
      `Cannot resume subagent ${outcome.subagentId}: unknown Subagent. ` +
      "Use a Subagent id returned by agent_start in this Session, not a Run id.",
    rowPhrase: () => "Resume refused · unknown Subagent",
    tone: "error",
  },
  "Subagent already running": {
    sentence: (outcome) =>
      `Cannot resume subagent ${outcome.subagentId}: it already has an ` +
      "active Run. The request was not queued and no provider work was " +
      "started. Wait for that Run to finish, then resume.",
    rowPhrase: () => "Resume refused · already running",
    tone: "warning",
  },
  "empty label": {
    sentence: (_outcome, context) =>
      `Cannot resume subagent ${context.subagentId}: its description is empty. No ` +
      "Run was started and nothing was queued. Send a one-line description " +
      "of this Run: it is the label this Run is shown under everywhere.",
    rowPhrase: () => "Resume refused · empty Label",
    tone: "error",
  },
  "resume unsupported": {
    sentence: (_outcome, context) =>
      `Cannot resume subagent ${context.subagentId}: its backend does not support ` +
      "resume. No Run or provider work was started. Start a new Subagent to " +
      "continue this work.",
    rowPhrase: () => "Resume refused · unsupported",
    tone: "warning",
  },
  "conversation lost": {
    sentence: (_outcome, context) =>
      `Cannot resume subagent ${context.subagentId}: its Conversation was lost. ` +
      "No Run or provider work was started. Start a new Subagent to continue.",
    rowPhrase: () => "Resume refused · Conversation lost",
    tone: "error",
  },
  "at capacity": {
    sentence: (_outcome, context) =>
      `Cannot resume subagent ${context.subagentId}: this Session is already ` +
      "running as many Subagent Runs as it allows. Nothing was queued. Wait " +
      "for a Run to finish, or cancel one, then try again.",
    rowPhrase: () => "Resume refused · at capacity",
    tone: "warning",
  },
  "shutting down": {
    sentence: (_outcome, context) =>
      `Cannot resume subagent ${context.subagentId}: this Session is shutting down. ` +
      "No Run was started and nothing was queued.",
    rowPhrase: () => "Resume refused · Session shutting down",
    tone: "warning",
  },
} satisfies OutcomeTable<ResumeOutcome, ResumeSentenceContext>;

/** Every steer outcome's model sentence and collapsed-row presentation. */
export const STEER_OUTCOME_PRESENTATION = {
  accepted: {
    sentence: (outcome) =>
      `Steering accepted for run ${outcome.runId}. ${LOCAL_ADMISSION_ONLY}`,
    rowPhrase: () => "Accepted into local Control mailbox",
    tone: "toolTitle",
  },
  "mailbox full": {
    sentence: (outcome) =>
      `Cannot steer run ${outcome.runId}: its Control mailbox is full. ` +
      "Nothing was truncated and nothing was dropped silently. Do not retry " +
      "steering in a loop.",
    rowPhrase: () => "Control refused · mailbox full",
    tone: "warning",
  },
  invalid: {
    sentence: (outcome, context) =>
      `Cannot steer run ${context.runId}: invalid message — ${outcome.reason}.`,
    rowPhrase: () => "Control refused · invalid",
    tone: "error",
  },
  unsupported: {
    sentence: (outcome) =>
      `Cannot steer run ${outcome.runId}: its backend declared no steering ` +
      "Control. No message was admitted, and no later attempt on this Run " +
      "will be.",
    rowPhrase: () => "Control refused · unsupported",
    tone: "warning",
  },
  "mailbox closed": {
    sentence: (outcome) =>
      `Cannot steer run ${outcome.runId}: its Control mailbox is closed. ` +
      "The Run is settling, was cancelled, or the Session is shutting down.",
    rowPhrase: () => "Control refused · mailbox closed",
    tone: "warning",
  },
  "already completed": {
    sentence: (outcome) =>
      `Cannot steer run ${outcome.runId}: it is ${outcome.outcome}. ` +
      "Use agent_result with that Run id to read what it produced.",
    rowPhrase: () => "Control refused · Run completed",
    tone: "warning",
  },
  "already failed": {
    sentence: (outcome) =>
      `Cannot steer run ${outcome.runId}: it is ${outcome.outcome}. ` +
      "Use agent_result with that Run id to read what it produced.",
    rowPhrase: () => "Control refused · Run failed",
    tone: "error",
  },
  "already cancelled": {
    sentence: (outcome) =>
      `Cannot steer run ${outcome.runId}: it is ${outcome.outcome}. ` +
      "Use agent_result with that Run id to read what it produced.",
    rowPhrase: () => "Control refused · Run cancelled",
    tone: "warning",
  },
  "unknown Run": {
    sentence: (outcome) =>
      `Cannot steer run ${outcome.runId}: unknown Run. Check the id against ` +
      "what agent_start or agent_resume returned.",
    rowPhrase: () => "Control refused · unknown Run",
    tone: "error",
  },
  "shutting down": {
    sentence: (_outcome, context) =>
      `Cannot steer run ${context.runId}: this Session is shutting down. No message ` +
      "was admitted.",
    rowPhrase: () => "Control refused · Session shutting down",
    tone: "warning",
  },
} satisfies OutcomeTable<SteerOutcome, SteerSentenceContext>;

function entryFor<Outcome extends { readonly outcome: string }, Context>(
  table: OutcomeTable<Outcome, Context>,
  outcome: Outcome,
): OutcomePresentation<Outcome, Context> {
  return (
    table as unknown as Record<string, OutcomePresentation<Outcome, Context>>
  )[outcome.outcome];
}

function sentenceFor<Outcome extends { readonly outcome: string }, Context>(
  table: OutcomeTable<Outcome, Context>,
  outcome: Outcome,
  context: Context,
): string {
  return entryFor(table, outcome).sentence(outcome, context);
}

function rowFor<Outcome extends { readonly outcome: string }, Context>(
  table: OutcomeTable<Outcome, Context>,
  outcome: Outcome,
): { readonly rowPhrase: string; readonly tone: ToolRowTone } {
  const entry = entryFor(table, outcome);
  return { rowPhrase: entry.rowPhrase(outcome), tone: entry.tone };
}

/** Format one start outcome from the declaration shared with its row facts. */
export function startOutcomeSentence(
  agent: string,
  outcome: StartOutcome,
  available: readonly string[],
): string {
  return sentenceFor(START_OUTCOME_PRESENTATION, outcome, {
    agent,
    available,
  });
}

/** Format one resume outcome from the declaration shared with its row facts. */
export function resumeOutcomeSentence(
  subagentId: SubagentId,
  outcome: ResumeOutcome,
): string {
  return sentenceFor(RESUME_OUTCOME_PRESENTATION, outcome, { subagentId });
}

/** Format one steer outcome from the declaration shared with its row facts. */
export function steerOutcomeSentence(
  runId: RunId,
  outcome: SteerOutcome,
): string {
  return sentenceFor(STEER_OUTCOME_PRESENTATION, outcome, { runId });
}

const IdentifierText = Schema.String.check(
  Schema.isLengthBetween(1, 128),
  Schema.isPattern(/^[A-Za-z0-9._:-]+$/),
);
const Count = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const ToolRowToneSchema = Schema.Literals(["toolTitle", "warning", "error"]);
const PassThroughRowSchema = {
  rowPhrase: Schema.String.check(Schema.isMinLength(1)),
  tone: ToolRowToneSchema,
};

const StartedRunToolRowFactsSchema = Schema.Struct({
  kind: Schema.Literal("start"),
  ...PassThroughRowSchema,
  agent: Schema.String,
  subagentId: IdentifierText,
  runId: IdentifierText,
});
const StartRefusalToolRowFactsSchema = Schema.Struct({
  kind: Schema.Literal("start"),
  ...PassThroughRowSchema,
  agent: Schema.String,
});
const StartToolRowFactsSchema = Schema.Union([
  StartedRunToolRowFactsSchema,
  StartRefusalToolRowFactsSchema,
]);
export type StartToolRowFacts = typeof StartToolRowFactsSchema.Type;
export type StartedRunToolRowFacts = typeof StartedRunToolRowFactsSchema.Type;

const ResumedRunToolRowFactsSchema = Schema.Struct({
  kind: Schema.Literal("resume"),
  ...PassThroughRowSchema,
  subagentId: IdentifierText,
  runId: IdentifierText,
});
const ResumeRefusalToolRowFactsSchema = Schema.Struct({
  kind: Schema.Literal("resume"),
  ...PassThroughRowSchema,
});
const ResumeToolRowFactsSchema = Schema.Union([
  ResumedRunToolRowFactsSchema,
  ResumeRefusalToolRowFactsSchema,
]);
export type ResumeToolRowFacts = typeof ResumeToolRowFactsSchema.Type;
export type ResumedRunToolRowFacts = typeof ResumedRunToolRowFactsSchema.Type;

const SteerToolRowFactsSchema = Schema.Struct({
  kind: Schema.Literal("steer"),
  ...PassThroughRowSchema,
  runId: IdentifierText,
});
export type SteerToolRowFacts = typeof SteerToolRowFactsSchema.Type;

const CompactFinalOutputSummarySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("removed") }),
  Schema.Struct({ kind: Schema.Literal("visible"), characters: Count }),
]);

const ResultRunSummarySchema = Schema.Struct({
  runId: IdentifierText,
  agent: Schema.String,
  status: TerminalRunPhase,
  output: CompactFinalOutputSummarySchema,
});
export type ResultRunSummary = typeof ResultRunSummarySchema.Type;

const CollectionWithRunsSchema = Schema.Struct({
  kind: Schema.Literal("collection"),
  scope: Schema.Literals(["named", "all-active"]),
  runs: Schema.Array(ResultRunSummarySchema),
  stillRunning: Count,
  unknown: Count,
  unavailable: Count,
  noActiveRuns: Schema.Literal(false),
});
const EmptyCollectionSchema = Schema.Struct({
  kind: Schema.Literal("collection"),
  scope: Schema.Literal("all-active"),
  runs: Schema.Tuple([]),
  stillRunning: Schema.Literal(0),
  unknown: Schema.Literal(0),
  unavailable: Schema.Literal(0),
  noActiveRuns: Schema.Literal(true),
});
const CollectedRunsToolRowFactsSchema = Schema.Union([
  CollectionWithRunsSchema,
  EmptyCollectionSchema,
]);
export type CollectedRunsToolRowFacts =
  typeof CollectedRunsToolRowFactsSchema.Type;

/** The four clauses a collection row can report. */
export type CollectionClauseKind =
  | "delivered"
  | "unavailable"
  | "stillRunning"
  | "unknown";

interface CollectionClausePresentation {
  readonly rowPhrase: (count: number) => string;
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Every collection clause's wording and pluralisation, beside its facts.
 *
 * The mapped type makes adding a collection clause a table-completeness error.
 * Full order is the stable reading order. Priority order is the order in which
 * clauses earn space when the full summary does not fit.
 */
export const COLLECTION_PRESENTATION = {
  tone: "toolOutput",
  idleAnswer: "No active Runs",
  emptyAnswer: "No Run outcomes",
  separator: " · ",
  fullOrder: [
    "delivered",
    "unavailable",
    "stillRunning",
    "unknown",
  ] as const satisfies readonly CollectionClauseKind[],
  priorityOrder: [
    "stillRunning",
    "delivered",
    "unavailable",
    "unknown",
  ] as const satisfies readonly CollectionClauseKind[],
  clauses: {
    delivered: {
      rowPhrase: (count) => `Delivered ${counted(count, "Result", "Results")}`,
    },
    unavailable: {
      rowPhrase: (count) =>
        `${counted(count, "Result", "Results")} unavailable`,
    },
    stillRunning: {
      rowPhrase: (count) => `${counted(count, "Run", "Runs")} still running`,
    },
    unknown: {
      rowPhrase: (count) => `${counted(count, "Run", "Runs")} unknown`,
    },
  } satisfies Record<CollectionClauseKind, CollectionClausePresentation>,
} as const;

export interface CollectionRowPresentation {
  readonly tone: "toolOutput";
  readonly separator: string;
  readonly answer?: string;
  readonly clauses: readonly string[];
  readonly priority: readonly string[];
}

function collectionCount(
  facts: CollectedRunsToolRowFacts,
  kind: CollectionClauseKind,
): number {
  switch (kind) {
    case "delivered":
      return facts.runs.length;
    case "unavailable":
      return facts.unavailable;
    case "stillRunning":
      return facts.stillRunning;
    case "unknown":
      return facts.unknown;
  }
}

/** Phrase a collection row without making any width or layout decision. */
export function collectionRowPresentation(
  facts: CollectedRunsToolRowFacts,
): CollectionRowPresentation {
  if (facts.noActiveRuns) {
    return {
      tone: COLLECTION_PRESENTATION.tone,
      separator: COLLECTION_PRESENTATION.separator,
      answer: COLLECTION_PRESENTATION.idleAnswer,
      clauses: [],
      priority: [],
    };
  }

  const phrases = new Map<CollectionClauseKind, string>();
  for (const kind of COLLECTION_PRESENTATION.fullOrder) {
    const count = collectionCount(facts, kind);
    if (count > 0) {
      phrases.set(kind, COLLECTION_PRESENTATION.clauses[kind].rowPhrase(count));
    }
  }
  const clauses = COLLECTION_PRESENTATION.fullOrder.flatMap((kind) => {
    const phrase = phrases.get(kind);
    return phrase === undefined ? [] : [phrase];
  });
  return {
    tone: COLLECTION_PRESENTATION.tone,
    separator: COLLECTION_PRESENTATION.separator,
    ...(clauses.length === 0
      ? { answer: COLLECTION_PRESENTATION.emptyAnswer }
      : {}),
    clauses,
    priority: COLLECTION_PRESENTATION.priorityOrder.flatMap((kind) => {
      const phrase = phrases.get(kind);
      return phrase === undefined ? [] : [phrase];
    }),
  };
}

const ResultToolRowFactsSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("result"),
    outcome: Schema.Literal("available"),
    run: ResultRunSummarySchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    outcome: Schema.Literals(["still-running", "unknown"]),
    runId: IdentifierText,
  }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    outcome: Schema.Literal("unavailable"),
    runId: IdentifierText,
    status: TerminalRunPhase,
  }),
]);
export type ResultToolRowFacts = typeof ResultToolRowFactsSchema.Type;

const CancelRunToolRowOutcomeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["requested", "already requested", "unknown"]),
    runId: IdentifierText,
  }),
  Schema.Struct({
    kind: Schema.Literal("already terminal"),
    runId: IdentifierText,
    phase: TerminalRunPhase,
  }),
]);
export type CancelRunToolRowOutcome = typeof CancelRunToolRowOutcomeSchema.Type;

/**
 * The cancellation buckets' shared wording, declared beside their facts.
 *
 * `empty` is the answer when there are no buckets. The other keys are the
 * normalized facts kinds, so adding a bucket to the facts requires adding its
 * row phrase here too.
 */
export const CANCEL_BUCKET_PRESENTATION = {
  requested: { rowPhrase: "Cancellation requested" },
  "already requested": { rowPhrase: "Already cancelling" },
  "already terminal": { rowPhrase: "Already finished, result kept" },
  unknown: { rowPhrase: "Unknown run ids" },
  empty: { rowPhrase: "No run ids were given." },
} as const satisfies Record<
  CancelRunToolRowOutcome["kind"] | "empty",
  {
    readonly rowPhrase: string;
  }
>;

const CancelToolRowFactsSchema = Schema.Struct({
  kind: Schema.Literal("cancel"),
  outcomes: Schema.Array(CancelRunToolRowOutcomeSchema),
});
export type CancelToolRowFacts = typeof CancelToolRowFactsSchema.Type;

interface CancelIdBucket {
  readonly kind: "requested" | "already requested" | "unknown";
  readonly rowPhrase: string;
  readonly count: number;
  readonly runIds: readonly string[];
}

interface CancelTerminalBucket {
  readonly kind: "already terminal";
  readonly rowPhrase: string;
  readonly count: number;
  readonly runs: readonly {
    readonly runId: string;
    readonly phase: "completed" | "failed" | "cancelled";
  }[];
}

export type CancelBucket = CancelIdBucket | CancelTerminalBucket;

function unexpectedCancelBucket(outcome: never): never {
  throw new Error(
    `no cancellation bucket for ${String((outcome as { kind?: unknown }).kind)}`,
  );
}

/**
 * Group wire-compatible cancellation facts once for both prose and rows.
 *
 * Identifiers and terminal phases remain available to the model sentence,
 * while each bucket also supplies the count and row phrase the compact row
 * needs. The fixed order lives here alone. An unfamiliar runtime value fails
 * loudly rather than disappearing from both presentations.
 */
export function cancelBuckets(
  facts: CancelToolRowFacts,
): readonly CancelBucket[] {
  const requested: string[] = [];
  const alreadyRequested: string[] = [];
  const alreadyTerminal: {
    readonly runId: string;
    readonly phase: "completed" | "failed" | "cancelled";
  }[] = [];
  const unknown: string[] = [];

  for (const outcome of facts.outcomes) {
    switch (outcome.kind) {
      case "requested":
        requested.push(outcome.runId);
        break;
      case "already requested":
        alreadyRequested.push(outcome.runId);
        break;
      case "already terminal":
        alreadyTerminal.push({ runId: outcome.runId, phase: outcome.phase });
        break;
      case "unknown":
        unknown.push(outcome.runId);
        break;
      default:
        unexpectedCancelBucket(outcome);
    }
  }

  return [
    ...(requested.length === 0
      ? []
      : [
          {
            kind: "requested" as const,
            rowPhrase: CANCEL_BUCKET_PRESENTATION.requested.rowPhrase,
            count: requested.length,
            runIds: requested,
          },
        ]),
    ...(alreadyRequested.length === 0
      ? []
      : [
          {
            kind: "already requested" as const,
            rowPhrase:
              CANCEL_BUCKET_PRESENTATION["already requested"].rowPhrase,
            count: alreadyRequested.length,
            runIds: alreadyRequested,
          },
        ]),
    ...(alreadyTerminal.length === 0
      ? []
      : [
          {
            kind: "already terminal" as const,
            rowPhrase: CANCEL_BUCKET_PRESENTATION["already terminal"].rowPhrase,
            count: alreadyTerminal.length,
            runs: alreadyTerminal,
          },
        ]),
    ...(unknown.length === 0
      ? []
      : [
          {
            kind: "unknown" as const,
            rowPhrase: CANCEL_BUCKET_PRESENTATION.unknown.rowPhrase,
            count: unknown.length,
            runIds: unknown,
          },
        ]),
  ];
}

const ToolRowFactsSchema = Schema.Union([
  StartToolRowFactsSchema,
  ResumeToolRowFactsSchema,
  SteerToolRowFactsSchema,
  CollectedRunsToolRowFactsSchema,
  CancelToolRowFactsSchema,
  ResultToolRowFactsSchema,
]);
export type ToolRowFacts = typeof ToolRowFactsSchema.Type;

function resultRunSummaryOf(result: RunResult): ResultRunSummary {
  const output: CompactFinalOutputSummary = finalOutputSummary(
    interpretFinalOutput(result),
  );
  return {
    runId: result.runId,
    agent: result.agent,
    status: result.status,
    output,
  };
}

/** Make the presentation decision for every `agent_start` outcome. */
export function startToolRowFacts(
  agent: string,
  outcome: Extract<StartOutcome, { readonly outcome: "started" }>,
): StartedRunToolRowFacts;
export function startToolRowFacts(
  agent: string,
  outcome: StartOutcome,
): StartToolRowFacts;
export function startToolRowFacts(
  agent: string,
  outcome: StartOutcome,
): StartToolRowFacts {
  const row = rowFor<StartOutcome, StartSentenceContext>(
    START_OUTCOME_PRESENTATION,
    outcome,
  );
  return outcome.outcome === "started"
    ? {
        kind: "start",
        rowPhrase: row.rowPhrase,
        tone: row.tone,
        agent,
        subagentId: outcome.subagentId,
        runId: outcome.runId,
      }
    : { kind: "start", rowPhrase: row.rowPhrase, tone: row.tone, agent };
}

/** Make the presentation decision for every `agent_resume` outcome. */
export function resumeToolRowFacts(
  outcome: Extract<ResumeOutcome, { readonly outcome: "started" }>,
): ResumedRunToolRowFacts;
export function resumeToolRowFacts(outcome: ResumeOutcome): ResumeToolRowFacts;
export function resumeToolRowFacts(outcome: ResumeOutcome): ResumeToolRowFacts {
  const row = rowFor<ResumeOutcome, ResumeSentenceContext>(
    RESUME_OUTCOME_PRESENTATION,
    outcome,
  );
  return outcome.outcome === "started"
    ? {
        kind: "resume",
        rowPhrase: row.rowPhrase,
        tone: row.tone,
        subagentId: outcome.subagentId,
        runId: outcome.runId,
      }
    : { kind: "resume", rowPhrase: row.rowPhrase, tone: row.tone };
}

/** Make the presentation decision for every `agent_steer` outcome. */
export function steerToolRowFacts(
  requestedRunId: RunId,
  outcome: SteerOutcome,
): SteerToolRowFacts {
  const row = rowFor<SteerOutcome, SteerSentenceContext>(
    STEER_OUTCOME_PRESENTATION,
    outcome,
  );
  return {
    kind: "steer",
    rowPhrase: row.rowPhrase,
    tone: row.tone,
    runId: "runId" in outcome ? outcome.runId : requestedRunId,
  };
}

export function cancelToolRowFacts(
  outcomes: readonly CancelOutcome[],
): CancelToolRowFacts {
  return {
    kind: "cancel",
    outcomes: outcomes.map((outcome): CancelRunToolRowOutcome => {
      switch (outcome.outcome) {
        case "admitted":
          return { kind: "requested", runId: outcome.runId };
        case "idempotent":
          return { kind: "already requested", runId: outcome.runId };
        case "already completed":
          return {
            kind: "already terminal",
            runId: outcome.runId,
            phase: "completed",
          };
        case "already failed":
          return {
            kind: "already terminal",
            runId: outcome.runId,
            phase: "failed",
          };
        case "already cancelled":
          return {
            kind: "already terminal",
            runId: outcome.runId,
            phase: "cancelled",
          };
        case "unknown Run":
          return { kind: "unknown", runId: outcome.runId };
        default:
          return outcome satisfies never;
      }
    }),
  };
}

function collectedToolRowFacts(
  scope: "named" | "all-active",
  outcomes: readonly WaitOutcome[],
): CollectedRunsToolRowFacts {
  const runs: ResultRunSummary[] = [];
  let stillRunning = 0;
  let unknown = 0;
  let unavailable = 0;
  for (const outcome of outcomes) {
    switch (outcome.outcome) {
      case "terminal":
        if (outcome.result === undefined) unavailable += 1;
        else runs.push(resultRunSummaryOf(outcome.result));
        break;
      case "still running":
        stillRunning += 1;
        break;
      case "unknown Run":
        unknown += 1;
        break;
      default:
        outcome satisfies never;
    }
  }
  return {
    kind: "collection",
    scope,
    runs,
    stillRunning,
    unknown,
    unavailable,
    noActiveRuns: false,
  };
}

export function waitToolRowFacts(
  outcomes: readonly WaitOutcome[],
): CollectedRunsToolRowFacts {
  return collectedToolRowFacts("named", outcomes);
}

export function waitAllToolRowFacts(
  outcomes: readonly WaitOutcome[],
): CollectedRunsToolRowFacts {
  return collectedToolRowFacts("all-active", outcomes);
}

export function noActiveWaitAllToolRowFacts(): CollectedRunsToolRowFacts {
  return {
    kind: "collection",
    scope: "all-active",
    runs: [],
    stillRunning: 0,
    unknown: 0,
    unavailable: 0,
    noActiveRuns: true,
  };
}

export function resultToolRowFacts(outcome: ResultOutcome): ResultToolRowFacts {
  switch (outcome.outcome) {
    case "result":
      return {
        kind: "result",
        outcome: "available",
        run: resultRunSummaryOf(outcome.result),
      };
    case "ResultExpired":
      return {
        kind: "result",
        outcome: "unavailable",
        runId: outcome.runId,
        status: outcome.status,
      };
    case "RunNotTerminal":
      return { kind: "result", outcome: "still-running", runId: outcome.runId };
    case "unknown Run":
      return { kind: "result", outcome: "unknown", runId: outcome.runId };
    default:
      return outcome satisfies never;
  }
}

const decodeFacts = Schema.decodeUnknownResult(ToolRowFactsSchema, EXACT_KEYS);
const encodeFacts = Schema.encodeUnknownSync(ToolRowFactsSchema, EXACT_KEYS);

/** Encode Tool-row facts for the host-owned details slot. */
export function encodeToolRowFacts(value: ToolRowFacts | undefined): unknown {
  return value === undefined ? undefined : encodeFacts(value);
}

/** Decode host-owned unknown details into Tool-row facts without throwing. */
export function decodeToolRowFacts(value: unknown): ToolRowFacts | undefined {
  try {
    const decoded = decodeFacts(value);
    return decoded._tag === "Success" ? decoded.success : undefined;
  } catch {
    return undefined;
  }
}
