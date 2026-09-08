/**
 * The common presentation entry point for the seven agent tools.
 *
 * Registrations choose an operation and receive a complete renderer pair. They
 * do not choose headings, preview limits, summaries, hints, or fallbacks. The
 * Migrated operations use semantic details for their compact outcomes; legacy
 * and malformed rows retain the safe common fallback.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  Markdown,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  isTerminalRunPhase,
  type ResumeOutcome,
  type RunId,
  type RunPhase,
  type RunResult,
  type StartOutcome,
  type SteerOutcome,
  TERMINAL_RUN_PHASES,
  type TerminalRunPhase,
} from "../domain/index.ts";
import { CANCEL_OUTCOME_HEADINGS } from "./prose.ts";
import {
  contentText,
  formatParentheticalKeyHint,
  type KeyHintRenderer,
} from "./renderers.ts";
import type { RenderableTheme } from "./rows.ts";
import { formatCharacterCount } from "./status.ts";
import { fitToWidth } from "./text-width.ts";

/** The operation keys of the one agent-tool family. */
export type AgentToolOperation =
  | "start"
  | "resume"
  | "wait"
  | "waitAll"
  | "result"
  | "cancel"
  | "steer";

/** Presentation state Pi keeps for one tool row and shares between its slots. */
export interface AgentToolRendererState {
  callHidden?: boolean;
}

export interface AgentToolRenderContext {
  readonly args: unknown;
  readonly lastComponent?: Component;
  readonly state: AgentToolRendererState;
  readonly expanded: boolean;
  readonly isPartial: boolean;
  readonly argsComplete: boolean;
}

export interface AgentToolResultOptions {
  readonly expanded: boolean;
  readonly isPartial: boolean;
}

export interface AgentToolRenderableResult {
  readonly content: unknown;
  readonly details?: unknown;
}

/** A complete pair is the only unit a registration can obtain. */
export interface AgentToolRendererPair {
  readonly renderCall: (
    args: unknown,
    theme: RenderableTheme,
    context: AgentToolRenderContext,
  ) => Component;
  readonly renderResult: (
    result: AgentToolRenderableResult,
    options: AgentToolResultOptions,
    theme: RenderableTheme,
    context: AgentToolRenderContext,
  ) => Component;
}

interface StartArguments {
  readonly agent: string;
  readonly description: string;
  readonly prompt: string;
}

interface ResumeArguments {
  readonly id: string;
  readonly description: string;
  readonly prompt: string;
}

interface SteerArguments {
  readonly id: string;
  readonly message: string;
}

/** Discriminated, presentation-only details for every decoded start outcome. */
export type StartRenderDetails =
  | {
      readonly kind: "start";
      readonly outcome: "started";
      readonly agent: string;
      readonly subagentId: string;
      readonly runId: string;
    }
  | {
      readonly kind: "start";
      readonly outcome: Exclude<
        StartOutcome["outcome"],
        "started" | "delegation-depth exceeded"
      >;
      readonly agent: string;
    }
  | {
      readonly kind: "start";
      readonly outcome: "delegation-depth exceeded";
      readonly agent: string;
      readonly depth: number;
    };

export type StartedRunRenderDetails = Extract<
  StartRenderDetails,
  { readonly outcome: "started" }
>;

/** One delivered Result in a compact collection or retrieval summary. */
export interface ResultRunSummary {
  readonly runId: string;
  readonly agent: string;
  readonly status: TerminalRunPhase;
  /** Characters retained in the Result's final output. */
  readonly outputCharacters: number;
}

/** Presentation-only facts for either Wait operation. */
export interface CollectedRunsRenderDetails {
  readonly kind: "collection";
  readonly scope: "named" | "all-active";
  readonly runs: readonly ResultRunSummary[];
  readonly stillRunning: number;
  readonly unknown: number;
  readonly unavailable: number;
  readonly noActiveRuns: boolean;
}

/** Presentation-only facts for one `agent_result` outcome. */
export type ResultRenderDetails =
  | {
      readonly kind: "result";
      readonly outcome: "available";
      readonly run: ResultRunSummary;
    }
  | {
      readonly kind: "result";
      readonly outcome: "still-running" | "unknown";
      readonly runId: string;
    }
  | {
      readonly kind: "result";
      readonly outcome: "unavailable";
      readonly runId: string;
      readonly status: TerminalRunPhase;
    };

export type ResumeRenderDetails =
  | {
      readonly kind: "resume";
      readonly outcome: "started";
      readonly subagentId: string;
      readonly runId: string;
    }
  | {
      readonly kind: "resume";
      readonly outcome: Exclude<ResumeOutcome["outcome"], "started">;
    };

export type SteerRenderDetails =
  | {
      readonly kind: "steer";
      readonly outcome: Exclude<SteerOutcome["outcome"], "invalid">;
      readonly runId: string;
    }
  | {
      readonly kind: "steer";
      readonly outcome: "invalid";
      readonly runId: string;
    };

/** One cancellation-request admission outcome, separate from settlement. */
export type CancelRunRenderOutcome =
  | { readonly kind: "requested"; readonly runId: string }
  | { readonly kind: "already requested"; readonly runId: string }
  | {
      readonly kind: "already terminal";
      readonly runId: string;
      readonly phase: TerminalRunPhase;
    }
  | { readonly kind: "unknown"; readonly runId: string };

/** Discriminated, presentation-only details for one cancellation operation. */
export interface CancelRenderDetails {
  readonly kind: "cancel";
  readonly outcomes: readonly CancelRunRenderOutcome[];
}

/** Explicit semantic details carried by migrated agent-tool outcomes. */
export type AgentToolRenderDetails =
  | StartRenderDetails
  | ResumeRenderDetails
  | SteerRenderDetails
  | CollectedRunsRenderDetails
  | ResultRenderDetails
  | CancelRenderDetails;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Build the shared compact vocabulary from one immutable Result. */
export function resultRunSummaryOf(result: RunResult): ResultRunSummary {
  return {
    runId: result.runId,
    agent: result.agent,
    status: result.status,
    outputCharacters: result.finalOutput.length,
  };
}

const COLLAPSED_BODY_LINES = 5;

function startArguments(value: unknown): StartArguments | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.agent === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.prompt === "string"
    ? {
        agent: candidate.agent,
        description: candidate.description,
        prompt: candidate.prompt,
      }
    : undefined;
}

function resumeArguments(value: unknown): ResumeArguments | undefined {
  const candidate = recordOf(value);
  return candidate &&
    typeof candidate.id === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.prompt === "string"
    ? {
        id: candidate.id,
        description: candidate.description,
        prompt: candidate.prompt,
      }
    : undefined;
}

function steerArguments(value: unknown): SteerArguments | undefined {
  const candidate = recordOf(value);
  return candidate &&
    typeof candidate.id === "string" &&
    typeof candidate.message === "string"
    ? { id: candidate.id, message: candidate.message }
    : undefined;
}

type StartRefusal = Exclude<
  StartOutcome["outcome"],
  "started" | "delegation-depth exceeded"
>;

const START_REFUSALS: Readonly<Record<StartRefusal, true>> = {
  "unknown agent": true,
  "invalid profile": true,
  "empty label": true,
  "at capacity": true,
  "shutting down": true,
  "backend unavailable": true,
};

/** Convert every start outcome into explicit semantic details. */
export function startRenderDetails(
  agent: string,
  outcome: StartOutcome,
): StartRenderDetails {
  if (outcome.outcome === "started") {
    return {
      kind: "start",
      outcome: "started",
      agent,
      subagentId: outcome.subagentId,
      runId: outcome.runId,
    };
  }
  return outcome.outcome === "delegation-depth exceeded"
    ? { kind: "start", outcome: outcome.outcome, agent, depth: outcome.depth }
    : { kind: "start", outcome: outcome.outcome, agent };
}

function parseStartRenderDetails(
  value: unknown,
): StartRenderDetails | undefined {
  const candidate = recordOf(value);
  if (candidate?.kind !== "start" || typeof candidate.agent !== "string") {
    return undefined;
  }
  if (
    candidate.outcome === "started" &&
    typeof candidate.subagentId === "string" &&
    typeof candidate.runId === "string"
  ) {
    return {
      kind: "start",
      outcome: "started",
      agent: candidate.agent,
      subagentId: candidate.subagentId,
      runId: candidate.runId,
    };
  }
  if (
    candidate.outcome === "delegation-depth exceeded" &&
    typeof candidate.depth === "number"
  ) {
    return {
      kind: "start",
      outcome: candidate.outcome,
      agent: candidate.agent,
      depth: candidate.depth,
    };
  }
  return hasOwnOutcome(START_REFUSALS, candidate.outcome)
    ? { kind: "start", outcome: candidate.outcome, agent: candidate.agent }
    : undefined;
}

type ResumeRefusal = Exclude<ResumeOutcome["outcome"], "started">;

/** Exhaustive runtime keys, linked to the domain unions they validate. */
const RESUME_REFUSALS: Readonly<Record<ResumeRefusal, true>> = {
  "unknown Subagent": true,
  "Subagent already running": true,
  "empty label": true,
  "resume unsupported": true,
  "conversation lost": true,
  "at capacity": true,
  "shutting down": true,
};

const STEER_OUTCOMES: Readonly<Record<SteerOutcome["outcome"], true>> = {
  accepted: true,
  "mailbox full": true,
  invalid: true,
  unsupported: true,
  "mailbox closed": true,
  "already completed": true,
  "already failed": true,
  "already cancelled": true,
  "unknown Run": true,
  "shutting down": true,
};

function hasOwnOutcome<K extends string>(
  outcomes: Readonly<Record<K, true>>,
  value: unknown,
): value is K {
  return typeof value === "string" && Object.hasOwn(outcomes, value);
}

/** Convert every resume operation outcome into explicit semantic details. */
export function resumeRenderDetails(
  outcome: ResumeOutcome,
): ResumeRenderDetails {
  return outcome.outcome === "started"
    ? {
        kind: "resume",
        outcome: "started",
        subagentId: outcome.subagentId,
        runId: outcome.runId,
      }
    : { kind: "resume", outcome: outcome.outcome };
}

/** Convert every Control admission outcome into explicit semantic details. */
export function steerRenderDetails(
  runId: RunId,
  outcome: SteerOutcome,
): SteerRenderDetails {
  if (outcome.outcome === "invalid") {
    return {
      kind: "steer",
      outcome: "invalid",
      runId,
    };
  }
  return {
    kind: "steer",
    outcome: outcome.outcome,
    runId: outcome.outcome === "shutting down" ? runId : outcome.runId,
  };
}

function parseResumeRenderDetails(
  value: unknown,
): ResumeRenderDetails | undefined {
  const candidate = recordOf(value);
  if (candidate?.kind !== "resume") return undefined;
  if (
    candidate.outcome === "started" &&
    typeof candidate.subagentId === "string" &&
    typeof candidate.runId === "string"
  ) {
    return {
      kind: "resume",
      outcome: "started",
      subagentId: candidate.subagentId,
      runId: candidate.runId,
    };
  }
  return hasOwnOutcome(RESUME_REFUSALS, candidate.outcome)
    ? { kind: "resume", outcome: candidate.outcome }
    : undefined;
}

function parseSteerRenderDetails(
  value: unknown,
): SteerRenderDetails | undefined {
  const candidate = recordOf(value);
  if (
    candidate?.kind !== "steer" ||
    typeof candidate.runId !== "string" ||
    !hasOwnOutcome(STEER_OUTCOMES, candidate.outcome)
  )
    return undefined;
  if (candidate.outcome === "invalid") {
    return {
      kind: "steer",
      outcome: "invalid",
      runId: candidate.runId,
    };
  }
  return {
    kind: "steer",
    outcome: candidate.outcome as Exclude<
      SteerRenderDetails["outcome"],
      "invalid"
    >,
    runId: candidate.runId,
  };
}

function isTerminalPhase(value: unknown): value is TerminalRunPhase {
  return typeof value === "string" && isTerminalRunPhase(value as RunPhase);
}

/** Validate cancellation details at the renderer boundary. */
function cancelRenderDetails(value: unknown): CancelRenderDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "cancel" || !Array.isArray(candidate.outcomes)) {
    return undefined;
  }
  const outcomes: CancelRunRenderOutcome[] = [];
  for (const value of candidate.outcomes) {
    if (typeof value !== "object" || value === null) return undefined;
    const outcome = value as Record<string, unknown>;
    if (typeof outcome.runId !== "string") return undefined;
    switch (outcome.kind) {
      case "requested":
      case "already requested":
      case "unknown":
        outcomes.push({ kind: outcome.kind, runId: outcome.runId });
        break;
      case "already terminal":
        if (!isTerminalPhase(outcome.phase)) return undefined;
        outcomes.push({
          kind: "already terminal",
          runId: outcome.runId,
          phase: outcome.phase,
        });
        break;
      default:
        return undefined;
    }
  }
  return { kind: "cancel", outcomes };
}

function hiddenMarker(hidden: number, theme: RenderableTheme): string {
  return theme.fg(
    "muted",
    `... (${hidden} more ${hidden === 1 ? "line" : "lines"})`,
  );
}

/** The one width-aware five-line implementation used by every submitted body. */
function submittedBody(
  prefix: "Prompt:" | "Message:",
  body: string,
  theme: RenderableTheme,
  width: number,
  expanded: boolean,
): { readonly lines: readonly string[]; readonly hidden: number } {
  const columns = Math.max(0, width);
  const painted = `${theme.fg("muted", prefix)} ${theme.fg("dim", body)}`;
  const visual = wrapTextWithAnsi(painted, Math.max(1, columns));
  const hidden = Math.max(0, visual.length - COLLAPSED_BODY_LINES);
  return {
    hidden,
    lines: [
      ...(expanded ? visual : visual.slice(0, COLLAPSED_BODY_LINES)).map(
        (line) => fitToWidth(line, columns),
      ),
      ...(!expanded && hidden > 0
        ? [fitToWidth(hiddenMarker(hidden, theme), columns)]
        : []),
    ],
  };
}

interface SubmittedCall {
  readonly toolName: string;
  readonly target: string;
  readonly label?: string;
  readonly prefix: "Prompt:" | "Message:";
  readonly body: string;
}

/** Build the shared heading, fitted Label, and submitted-body block. */
function submittedCallLines(
  call: SubmittedCall,
  theme: RenderableTheme,
  width: number,
  expanded: boolean,
): { readonly lines: readonly string[]; readonly hidden: boolean } {
  const columns = Math.max(0, width);
  const operation = theme.fg("toolTitle", theme.bold(call.toolName));
  const fixedHeader = `${operation} ${theme.fg("accent", call.target)}`;
  const labelBudget = Math.max(
    0,
    columns - visibleWidth(fixedHeader) - visibleWidth(" · "),
  );
  const fittedLabel = fitToWidth(call.label ?? "", labelBudget, {
    plain: true,
  });
  const header = fitToWidth(
    fittedLabel
      ? `${fixedHeader}${theme.fg("dim", " · ")}${theme.fg("muted", fittedLabel)}`
      : fixedHeader,
    columns,
  );
  const body = submittedBody(call.prefix, call.body, theme, columns, expanded);
  return { lines: [header, "", ...body.lines, ""], hidden: body.hidden > 0 };
}

function unfinishedArgumentsLine(
  operation: AgentToolOperation,
  theme: RenderableTheme,
  width: number,
): string {
  return fitToWidth(
    theme.fg("toolTitle", theme.bold(toolName(operation))) +
      theme.fg("muted", " [arguments incomplete]"),
    Math.max(0, width),
  );
}

/** Width-derived rendering cache shared by reusable Pi row components. */
abstract class CachedComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.onInvalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }
    this.cachedLines = [...this.renderUncached(width)];
    this.cachedWidth = width;
    return this.cachedLines;
  }

  protected onInvalidate(): void {}
  protected abstract renderUncached(width: number): readonly string[];
}

class StartCallComponent extends CachedComponent {
  private args: StartArguments | undefined;
  private theme: RenderableTheme;
  private expanded: boolean;
  private argsComplete: boolean;
  private readonly state: AgentToolRendererState;

  constructor(
    args: StartArguments | undefined,
    theme: RenderableTheme,
    expanded: boolean,
    argsComplete: boolean,
    state: AgentToolRendererState,
  ) {
    super();
    this.args = args;
    this.theme = theme;
    this.expanded = expanded;
    this.argsComplete = argsComplete;
    this.state = state;
  }

  update(
    args: StartArguments | undefined,
    theme: RenderableTheme,
    expanded: boolean,
    argsComplete: boolean,
  ): void {
    this.args = args;
    this.theme = theme;
    this.expanded = expanded;
    this.argsComplete = argsComplete;
    this.invalidate();
  }

  protected renderUncached(width: number): readonly string[] {
    const columns = Math.max(0, width);
    if (!this.argsComplete && !this.args) {
      this.state.callHidden = false;
      return [unfinishedArgumentsLine("start", this.theme, columns)];
    }
    if (!this.args) {
      this.state.callHidden = false;
      return [
        fitToWidth(
          this.theme.fg("toolTitle", this.theme.bold("agent_start")) +
            this.theme.fg("error", " [invalid arguments]"),
          columns,
        ),
      ];
    }

    const built = submittedCallLines(
      {
        toolName: "agent_start",
        target: this.args.agent,
        label: this.args.description,
        prefix: "Prompt:",
        body: this.args.prompt,
      },
      this.theme,
      columns,
      this.expanded,
    );
    this.state.callHidden = built.hidden;
    return built.lines;
  }
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

/** Build and measure the family's exact configured expansion affordance. */
function expansionHint(
  theme: RenderableTheme,
  renderKeyHint?: KeyHintRenderer,
): { readonly text: string; readonly width: number } {
  const text = ` ${formatParentheticalKeyHint(
    theme,
    "app.tools.expand",
    "to expand",
    renderKeyHint,
  )}`;
  return { text, width: visibleWidth(text) };
}

/** Fit every collapsed result through the family's one toggle-hint policy. */
function collapsedResultLine(
  summary: string,
  theme: RenderableTheme,
  width: number,
  hidden: boolean,
  renderKeyHint?: KeyHintRenderer,
): string {
  const columns = Math.max(0, width);
  const hint = hidden
    ? expansionHint(theme, renderKeyHint)
    : { text: "", width: 0 };
  return (
    fitToWidth(summary, Math.max(0, columns - hint.width)) +
    fitToWidth(hint.text, columns)
  );
}

function collapsedSummaryWidth(
  theme: RenderableTheme,
  width: number,
  hidden: boolean,
  renderKeyHint?: KeyHintRenderer,
): number {
  return Math.max(
    0,
    width - (hidden ? expansionHint(theme, renderKeyHint).width : 0),
  );
}

function collapseHint(theme: RenderableTheme, width: number): string {
  return fitToWidth(
    formatParentheticalKeyHint(theme, "app.tools.expand", "to collapse"),
    Math.max(0, width),
  );
}

/**
 * Fit a successful start by semantic priority rather than tail clipping.
 *
 * Agent is useful orientation, but the Subagent and Run ids are what the
 * operator can act on. When the full sentence does not fit, Agent gives way
 * first, then field labels give way while both self-describing ids stay whole.
 */
function formatStartedIdentity(
  details: StartedRunRenderDetails,
  theme: RenderableTheme,
  width: number,
): string {
  const candidates = [
    theme.fg("toolTitle", `Started ${details.agent}`) +
      theme.fg(
        "dim",
        ` · Subagent ${details.subagentId} · Run ${details.runId}`,
      ),
    theme.fg("toolTitle", "Started") +
      theme.fg(
        "dim",
        ` · Subagent ${details.subagentId} · Run ${details.runId}`,
      ),
    theme.fg("toolTitle", "Started") +
      theme.fg("dim", ` · ${details.subagentId} · ${details.runId}`),
  ];
  return (
    candidates.find((candidate) => visibleWidth(candidate) <= width) ??
    fitToWidth(candidates.at(-1) ?? "", width)
  );
}

function startSummary(
  details: StartRenderDetails,
  theme: RenderableTheme,
  width: number,
): string {
  if (details.outcome === "started") {
    return formatStartedIdentity(details, theme, width);
  }
  const [tone, reason] = (() => {
    switch (details.outcome) {
      case "unknown agent":
        return ["error", "unknown Agent"] as const;
      case "invalid profile":
        return ["error", "invalid Profile"] as const;
      case "empty label":
        return ["error", "empty Label"] as const;
      case "at capacity":
        return ["warning", "at capacity"] as const;
      case "shutting down":
        return ["warning", "Session shutting down"] as const;
      case "delegation-depth exceeded":
        return ["warning", `delegation depth ${details.depth}`] as const;
      case "backend unavailable":
        return ["error", "backend unavailable"] as const;
    }
  })();
  return theme.fg(tone, "Start refused") + theme.fg("dim", ` · ${reason}`);
}

/** A compact successful start with its row's one configured expansion hint. */
export function formatStartedRunSummary(
  details: StartedRunRenderDetails,
  theme: RenderableTheme,
  width: number,
  renderKeyHint?: KeyHintRenderer,
): string {
  return collapsedResultLine(
    formatStartedIdentity(
      details,
      theme,
      collapsedSummaryWidth(theme, width, true, renderKeyHint),
    ),
    theme,
    width,
    true,
    renderKeyHint,
  );
}

class UnifiedResultComponent extends CachedComponent {
  private result: AgentToolRenderableResult;
  private options: AgentToolResultOptions;
  private theme: RenderableTheme;
  private readonly operation: AgentToolOperation;
  private readonly state: AgentToolRendererState;
  private markdown?: Markdown;

  constructor(
    operation: AgentToolOperation,
    result: AgentToolRenderableResult,
    options: AgentToolResultOptions,
    theme: RenderableTheme,
    state: AgentToolRendererState,
  ) {
    super();
    this.operation = operation;
    this.result = result;
    this.options = options;
    this.theme = theme;
    this.state = state;
  }

  update(
    result: AgentToolRenderableResult,
    options: AgentToolResultOptions,
    theme: RenderableTheme,
  ): void {
    this.result = result;
    this.options = options;
    this.theme = theme;
    this.invalidate();
  }

  protected override onInvalidate(): void {
    this.markdown = undefined;
  }

  private semanticPresentation():
    | {
        readonly line: (width: number) => string;
        readonly sourceText?: string;
      }
    | undefined {
    switch (this.operation) {
      case "start": {
        const details = parseStartRenderDetails(this.result.details);
        return details === undefined
          ? undefined
          : { line: (width) => startSummary(details, this.theme, width) };
      }
      case "resume": {
        const details = parseResumeRenderDetails(this.result.details);
        return details === undefined
          ? undefined
          : { line: (width) => resumeSummary(details, this.theme, width) };
      }
      case "steer": {
        const details = parseSteerRenderDetails(this.result.details);
        return details === undefined
          ? undefined
          : { line: () => steerSummary(details, this.theme) };
      }
      case "cancel": {
        const details = cancelRenderDetails(this.result.details);
        if (details === undefined) return undefined;
        const sourceText = cancellationSummaryText(details);
        return {
          line: () => this.theme.fg("toolOutput", sourceText),
          sourceText,
        };
      }
      case "result": {
        const details = resultRenderDetails(this.result.details);
        return details === undefined
          ? undefined
          : { line: (width) => retrievalSummary(details, this.theme, width) };
      }
      case "wait":
      case "waitAll": {
        const details = collectedRunsRenderDetails(this.result.details);
        return details === undefined
          ? undefined
          : { line: (width) => collectionSummary(details, this.theme, width) };
      }
    }
  }

  protected renderUncached(width: number): readonly string[] {
    const columns = Math.max(0, width);
    const text = contentText(this.result.content).trim();
    const partial = this.options.isPartial;
    const unfinished = `${toolName(this.operation)} is still running.`;
    const empty = `${toolName(this.operation)} returned no readable response.`;
    const fallback = firstLine(text) || (partial ? unfinished : empty);
    const fallbackSummary = this.theme.fg(
      partial ? "muted" : "toolOutput",
      partial ? unfinished : fallback,
    );
    const semantic = partial ? undefined : this.semanticPresentation();
    const provisionalSummary = semantic?.line(columns);
    const resultHidden =
      semantic !== undefined
        ? semantic.sourceText === undefined
          ? text.length > 0
          : text.length > 0 &&
            (text.includes("\n") ||
              text !== semantic.sourceText ||
              visibleWidth(provisionalSummary ?? "") > columns)
        : text.includes("\n") || visibleWidth(fallbackSummary) > columns;
    const hidden = this.state.callHidden === true || resultHidden;
    const summaryWidth = collapsedSummaryWidth(this.theme, columns, hidden);
    const summary = semantic?.line(summaryWidth) ?? fallbackSummary;

    if (!this.options.expanded || !hidden) {
      return [collapsedResultLine(summary, this.theme, columns, hidden)];
    }

    this.markdown ??= new Markdown(text || fallback, 0, 0, getMarkdownTheme());
    return [
      ...this.markdown.render(columns),
      collapseHint(this.theme, columns),
    ];
  }
}

interface CancelArguments {
  readonly ids: readonly string[];
}

function cancelArguments(value: unknown): CancelArguments | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const ids = (value as Record<string, unknown>).ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    return undefined;
  }
  return { ids: [...new Set(ids)] };
}

class CancelCallComponent extends CachedComponent {
  private args: CancelArguments | undefined;
  private theme: RenderableTheme;
  private argsComplete: boolean;

  constructor(
    args: CancelArguments | undefined,
    theme: RenderableTheme,
    argsComplete: boolean,
  ) {
    super();
    this.args = args;
    this.theme = theme;
    this.argsComplete = argsComplete;
  }

  update(
    args: CancelArguments | undefined,
    theme: RenderableTheme,
    argsComplete: boolean,
  ): void {
    this.args = args;
    this.theme = theme;
    this.argsComplete = argsComplete;
    this.invalidate();
  }

  protected renderUncached(width: number): readonly string[] {
    const columns = Math.max(0, width);
    const operation = this.theme.fg(
      "toolTitle",
      this.theme.bold("agent_cancel"),
    );
    if (!this.argsComplete && !this.args) {
      return [unfinishedArgumentsLine("cancel", this.theme, columns)];
    }
    let line: string;
    if (!this.args) {
      line = `${operation}${this.theme.fg("error", " [invalid arguments]")}`;
    } else {
      const ids = this.args.ids.join(", ");
      const named = ids.length > 0 ? `${operation} ${ids}` : operation;
      const count = `${operation} ${this.args.ids.length} ${
        this.args.ids.length === 1 ? "Run" : "Runs"
      }`;
      line = visibleWidth(named) <= columns ? named : count;
    }
    return [fitToWidth(line, columns)];
  }
}

function cancellationSummaryText(details: CancelRenderDetails): string {
  const counts = {
    requested: 0,
    alreadyRequested: 0,
    alreadyTerminal: 0,
    unknown: 0,
  };
  for (const outcome of details.outcomes) {
    switch (outcome.kind) {
      case "requested":
        counts.requested += 1;
        break;
      case "already requested":
        counts.alreadyRequested += 1;
        break;
      case "already terminal":
        counts.alreadyTerminal += 1;
        break;
      case "unknown":
        counts.unknown += 1;
        break;
    }
  }
  const parts: string[] = [];
  if (counts.requested > 0) {
    parts.push(`${CANCEL_OUTCOME_HEADINGS.requested}: ${counts.requested}`);
  }
  if (counts.alreadyRequested > 0) {
    parts.push(
      `${CANCEL_OUTCOME_HEADINGS.alreadyCancelling}: ${counts.alreadyRequested}`,
    );
  }
  if (counts.alreadyTerminal > 0) {
    parts.push(
      `${CANCEL_OUTCOME_HEADINGS.alreadyFinished}: ${counts.alreadyTerminal}`,
    );
  }
  if (counts.unknown > 0) {
    parts.push(`${CANCEL_OUTCOME_HEADINGS.unknownRunIds}: ${counts.unknown}`);
  }
  return parts.join(" · ") || CANCEL_OUTCOME_HEADINGS.empty;
}

/** One-line cancellation admission summary with the configured toggle hint. */
export function formatCancellationSummary(
  details: CancelRenderDetails,
  theme: RenderableTheme,
  width: number,
  renderKeyHint?: KeyHintRenderer,
): string {
  return collapsedResultLine(
    theme.fg("toolOutput", cancellationSummaryText(details)),
    theme,
    width,
    true,
    renderKeyHint,
  );
}

const startPair: AgentToolRendererPair = {
  renderCall(args, theme, context) {
    const parsed = startArguments(args);
    const component =
      context.lastComponent instanceof StartCallComponent
        ? context.lastComponent
        : new StartCallComponent(
            parsed,
            theme,
            context.expanded,
            context.argsComplete,
            context.state,
          );
    component.update(parsed, theme, context.expanded, context.argsComplete);
    return component;
  },
  renderResult(result, options, theme, context) {
    const component =
      context.lastComponent instanceof UnifiedResultComponent
        ? context.lastComponent
        : new UnifiedResultComponent(
            "start",
            result,
            options,
            theme,
            context.state,
          );
    component.update(result, options, theme);
    return component;
  },
};

function toolName(operation: AgentToolOperation): string {
  return operation === "waitAll" ? "agent_wait_all" : `agent_${operation}`;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTerminalStatus(value: unknown): value is TerminalRunPhase {
  return (TERMINAL_RUN_PHASES as readonly unknown[]).includes(value);
}

function resultRunSummary(value: unknown): ResultRunSummary | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const run = value as Record<string, unknown>;
  return typeof run.runId === "string" &&
    typeof run.agent === "string" &&
    isTerminalStatus(run.status) &&
    isCount(run.outputCharacters)
    ? {
        runId: run.runId,
        agent: run.agent,
        status: run.status,
        outputCharacters: run.outputCharacters,
      }
    : undefined;
}

function collectedRunsRenderDetails(
  value: unknown,
): CollectedRunsRenderDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const details = value as Record<string, unknown>;
  if (
    details.kind !== "collection" ||
    (details.scope !== "named" && details.scope !== "all-active") ||
    !Array.isArray(details.runs) ||
    !isCount(details.stillRunning) ||
    !isCount(details.unknown) ||
    !isCount(details.unavailable) ||
    typeof details.noActiveRuns !== "boolean"
  ) {
    return undefined;
  }
  const runs = details.runs.map(resultRunSummary);
  return runs.every((run) => run !== undefined)
    ? {
        kind: "collection",
        scope: details.scope,
        runs: runs as ResultRunSummary[],
        stillRunning: details.stillRunning,
        unknown: details.unknown,
        unavailable: details.unavailable,
        noActiveRuns: details.noActiveRuns,
      }
    : undefined;
}

function resultRenderDetails(value: unknown): ResultRenderDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const details = value as Record<string, unknown>;
  if (details.kind !== "result") return undefined;
  if (details.outcome === "available") {
    const run = resultRunSummary(details.run);
    return run === undefined
      ? undefined
      : { kind: "result", outcome: "available", run };
  }
  if (
    (details.outcome === "still-running" || details.outcome === "unknown") &&
    typeof details.runId === "string"
  ) {
    return {
      kind: "result",
      outcome: details.outcome,
      runId: details.runId,
    };
  }
  return details.outcome === "unavailable" &&
    typeof details.runId === "string" &&
    isTerminalStatus(details.status)
    ? {
        kind: "result",
        outcome: "unavailable",
        runId: details.runId,
        status: details.status,
      }
    : undefined;
}

interface TargetArguments {
  readonly ids?: readonly string[];
  readonly id?: string;
}

function targetArguments(
  operation: "wait" | "waitAll" | "result",
  value: unknown,
): TargetArguments | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const args = value as Record<string, unknown>;
  if (operation === "waitAll") return { ids: [] };
  if (operation === "result") {
    return typeof args.id === "string" ? { id: args.id } : undefined;
  }
  return Array.isArray(args.ids) &&
    args.ids.every((id) => typeof id === "string")
    ? { ids: args.ids }
    : undefined;
}

class TargetCallComponent implements Component {
  private operation: "wait" | "waitAll" | "result";
  private args: TargetArguments | undefined;
  private theme: RenderableTheme;
  private argsComplete: boolean;
  private readonly state: AgentToolRendererState;

  constructor(
    operation: "wait" | "waitAll" | "result",
    args: TargetArguments | undefined,
    theme: RenderableTheme,
    argsComplete: boolean,
    state: AgentToolRendererState,
  ) {
    this.operation = operation;
    this.args = args;
    this.theme = theme;
    this.argsComplete = argsComplete;
    this.state = state;
  }

  update(
    operation: "wait" | "waitAll" | "result",
    args: TargetArguments | undefined,
    theme: RenderableTheme,
    argsComplete: boolean,
  ): void {
    this.operation = operation;
    this.args = args;
    this.theme = theme;
    this.argsComplete = argsComplete;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const columns = Math.max(0, width);
    this.state.callHidden = false;
    const name = this.theme.fg(
      "toolTitle",
      this.theme.bold(toolName(this.operation)),
    );
    if (!this.argsComplete && !this.args) {
      return [unfinishedArgumentsLine(this.operation, this.theme, columns)];
    }
    if (!this.args) {
      return [
        fitToWidth(
          `${name}${this.theme.fg("error", " [invalid arguments]")}`,
          columns,
        ),
      ];
    }
    let target: string;
    if (this.operation === "waitAll") {
      target = "all active Runs";
    } else if (this.operation === "result") {
      target = this.args.id ?? "";
    } else {
      const ids = this.args.ids ?? [];
      const named = ids.join(", ");
      const full = `${name}${this.theme.fg("dim", " · ")}${named}`;
      target =
        visibleWidth(full) <= columns
          ? named
          : `${ids.length} ${ids.length === 1 ? "Run" : "Runs"}`;
    }
    return [
      fitToWidth(
        `${name}${this.theme.fg("dim", " · ")}${this.theme.fg("muted", target)}`,
        columns,
      ),
    ];
  }
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function collectionSummary(
  details: CollectedRunsRenderDetails,
  theme: RenderableTheme,
  width: number,
): string {
  if (details.noActiveRuns) return theme.fg("toolOutput", "No active Runs");
  const parts: string[] = [];
  if (details.runs.length > 0) {
    parts.push(`Delivered ${plural(details.runs.length, "Result")}`);
  }
  if (details.unavailable > 0) {
    parts.push(`${plural(details.unavailable, "Result")} unavailable`);
  }
  if (details.stillRunning > 0) {
    parts.push(`${plural(details.stillRunning, "Run")} still running`);
  }
  if (details.unknown > 0) {
    parts.push(`${plural(details.unknown, "Run")} unknown`);
  }
  const full = parts.join(" · ") || "No Run outcomes";
  if (visibleWidth(full) <= width) return theme.fg("toolOutput", full);

  // Retain as many compatible clauses as fit, considering incompleteness
  // first, then delivered outcome, then progressively less actionable counts.
  // Selected clauses return to the stable full-summary order for readability.
  const priorities = [
    details.stillRunning > 0
      ? `${plural(details.stillRunning, "Run")} still running`
      : undefined,
    details.runs.length > 0
      ? `Delivered ${plural(details.runs.length, "Result")}`
      : undefined,
    details.unavailable > 0
      ? `${plural(details.unavailable, "Result")} unavailable`
      : undefined,
    details.unknown > 0
      ? `${plural(details.unknown, "Run")} unknown`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  const selected = new Set<string>();
  for (const part of priorities) {
    const candidate = parts.filter(
      (original) => selected.has(original) || original === part,
    );
    if (visibleWidth(candidate.join(" · ")) > width) break;
    selected.add(part);
  }
  const retained = parts.filter((part) => selected.has(part)).join(" · ");
  return theme.fg(
    "toolOutput",
    retained || fitToWidth(priorities[0] ?? full, width, { plain: true }),
  );
}

function retrievalSummary(
  details: ResultRenderDetails,
  theme: RenderableTheme,
  width: number,
): string {
  switch (details.outcome) {
    case "available": {
      const candidates = [
        `${details.run.agent} · ${details.run.runId} · ${details.run.status} · ${formatCharacterCount(details.run.outputCharacters)}`,
        `${details.run.agent} · ${details.run.runId} · ${details.run.status}`,
        `${details.run.runId} · ${details.run.status}`,
      ];
      const text =
        candidates.find((candidate) => visibleWidth(candidate) <= width) ??
        fitToWidth(candidates.at(-1) ?? "", width, { plain: true });
      return theme.fg("toolOutput", text);
    }
    case "still-running":
      return theme.fg("warning", `${details.runId} · still running`);
    case "unknown":
      return theme.fg("error", `${details.runId} · unknown Run`);
    case "unavailable":
      return theme.fg(
        "error",
        `${details.runId} · Result unavailable · ${details.status}`,
      );
  }
}

function resultBearingPair(
  operation: "wait" | "waitAll" | "result",
): AgentToolRendererPair {
  return {
    renderCall(args, theme, context) {
      const parsed = targetArguments(operation, args);
      const component =
        context.lastComponent instanceof TargetCallComponent
          ? context.lastComponent
          : new TargetCallComponent(
              operation,
              parsed,
              theme,
              context.argsComplete,
              context.state,
            );
      component.update(operation, parsed, theme, context.argsComplete);
      return component;
    },
    renderResult(result, options, theme, context) {
      const component =
        context.lastComponent instanceof UnifiedResultComponent
          ? context.lastComponent
          : new UnifiedResultComponent(
              operation,
              result,
              options,
              theme,
              context.state,
            );
      component.update(result, options, theme);
      return component;
    },
  };
}

type ContinuationArguments =
  | { readonly operation: "resume"; readonly value: ResumeArguments }
  | { readonly operation: "steer"; readonly value: SteerArguments };

class ContinuationCallComponent extends CachedComponent {
  private readonly operation: "resume" | "steer";
  private args: ContinuationArguments | undefined;
  private theme: RenderableTheme;
  private expanded: boolean;
  private argsComplete: boolean;
  private readonly state: AgentToolRendererState;

  constructor(
    operation: "resume" | "steer",
    args: ContinuationArguments | undefined,
    theme: RenderableTheme,
    expanded: boolean,
    argsComplete: boolean,
    state: AgentToolRendererState,
  ) {
    super();
    this.operation = operation;
    this.args = args;
    this.theme = theme;
    this.expanded = expanded;
    this.argsComplete = argsComplete;
    this.state = state;
  }

  update(
    args: ContinuationArguments | undefined,
    theme: RenderableTheme,
    expanded: boolean,
    argsComplete: boolean,
  ): void {
    this.args = args;
    this.theme = theme;
    this.expanded = expanded;
    this.argsComplete = argsComplete;
    this.invalidate();
  }

  protected renderUncached(width: number): readonly string[] {
    const columns = Math.max(0, width);
    const toolName = `agent_${this.operation}`;
    if (!this.argsComplete && !this.args) {
      this.state.callHidden = false;
      return [unfinishedArgumentsLine(this.operation, this.theme, columns)];
    }
    if (!this.args) {
      this.state.callHidden = false;
      return [
        fitToWidth(
          this.theme.fg("toolTitle", this.theme.bold(toolName)) +
            this.theme.fg("error", " [invalid arguments]"),
          columns,
        ),
      ];
    }

    const call: SubmittedCall =
      this.args.operation === "resume"
        ? {
            toolName,
            target: this.args.value.id,
            label: this.args.value.description,
            prefix: "Prompt:",
            body: this.args.value.prompt,
          }
        : {
            toolName,
            target: this.args.value.id,
            prefix: "Message:",
            body: this.args.value.message,
          };
    const built = submittedCallLines(call, this.theme, columns, this.expanded);
    this.state.callHidden = built.hidden;
    return built.lines;
  }
}

type ResumedRunRenderDetails = Extract<
  ResumeRenderDetails,
  { readonly outcome: "started" }
>;

function resumedIdentity(
  details: ResumedRunRenderDetails,
  theme: RenderableTheme,
  width: number,
): string {
  const candidates = [
    theme.fg("toolTitle", "Resumed") +
      theme.fg("dim", ` · Run ${details.runId}`),
    theme.fg("toolTitle", "Resumed") + theme.fg("dim", ` · ${details.runId}`),
  ];
  return (
    candidates.find((candidate) => visibleWidth(candidate) <= width) ??
    fitToWidth(candidates.at(-1) ?? "", width)
  );
}

/** A compact resumed identity with the row's one configured expansion hint. */
export function formatResumedRunSummary(
  details: ResumedRunRenderDetails,
  theme: RenderableTheme,
  width: number,
  renderKeyHint?: KeyHintRenderer,
): string {
  return collapsedResultLine(
    resumedIdentity(
      details,
      theme,
      collapsedSummaryWidth(theme, width, true, renderKeyHint),
    ),
    theme,
    width,
    true,
    renderKeyHint,
  );
}

function resumeSummary(
  details: ResumeRenderDetails,
  theme: RenderableTheme,
  width: number,
): string {
  switch (details.outcome) {
    case "started":
      return resumedIdentity(details, theme, width);
    case "unknown Subagent":
      return (
        theme.fg("error", "Resume refused") +
        theme.fg("dim", " · unknown Subagent")
      );
    case "Subagent already running":
      return (
        theme.fg("warning", "Resume refused") +
        theme.fg("dim", " · already running")
      );
    case "empty label":
      return (
        theme.fg("error", "Resume refused") + theme.fg("dim", " · empty Label")
      );
    case "resume unsupported":
      return (
        theme.fg("warning", "Resume refused") +
        theme.fg("dim", " · unsupported")
      );
    case "conversation lost":
      return (
        theme.fg("error", "Resume refused") +
        theme.fg("dim", " · Conversation lost")
      );
    case "at capacity":
      return (
        theme.fg("warning", "Resume refused") +
        theme.fg("dim", " · at capacity")
      );
    case "shutting down":
      return (
        theme.fg("warning", "Resume refused") +
        theme.fg("dim", " · Session shutting down")
      );
  }
}

function steerSummary(
  details: SteerRenderDetails,
  theme: RenderableTheme,
): string {
  switch (details.outcome) {
    case "accepted":
      return theme.fg("toolTitle", "Accepted into local Control mailbox");
    case "mailbox full":
      return (
        theme.fg("warning", "Control refused") +
        theme.fg("dim", " · mailbox full")
      );
    case "mailbox closed":
      return (
        theme.fg("warning", "Control refused") +
        theme.fg("dim", " · mailbox closed")
      );
    case "unsupported":
      return (
        theme.fg("warning", "Control refused") +
        theme.fg("dim", " · unsupported")
      );
    case "invalid":
      return (
        theme.fg("error", "Control refused") + theme.fg("dim", " · invalid")
      );
    case "already completed":
      return (
        theme.fg("warning", "Control refused") +
        theme.fg("dim", " · Run completed")
      );
    case "already failed":
      return (
        theme.fg("error", "Control refused") + theme.fg("dim", " · Run failed")
      );
    case "already cancelled":
      return (
        theme.fg("warning", "Control refused") +
        theme.fg("dim", " · Run cancelled")
      );
    case "unknown Run":
      return (
        theme.fg("error", "Control refused") + theme.fg("dim", " · unknown Run")
      );
    case "shutting down":
      return (
        theme.fg("warning", "Control refused") +
        theme.fg("dim", " · Session shutting down")
      );
  }
}

function continuationPair(
  operation: "resume" | "steer",
): AgentToolRendererPair {
  return {
    renderCall(args, theme, context) {
      const parsed =
        operation === "resume" ? resumeArguments(args) : steerArguments(args);
      const value =
        parsed === undefined
          ? undefined
          : ({ operation, value: parsed } as ContinuationArguments);
      const component =
        context.lastComponent instanceof ContinuationCallComponent
          ? context.lastComponent
          : new ContinuationCallComponent(
              operation,
              value,
              theme,
              context.expanded,
              context.argsComplete,
              context.state,
            );
      component.update(value, theme, context.expanded, context.argsComplete);
      return component;
    },
    renderResult(result, options, theme, context) {
      const component =
        context.lastComponent instanceof UnifiedResultComponent
          ? context.lastComponent
          : new UnifiedResultComponent(
              operation,
              result,
              options,
              theme,
              context.state,
            );
      component.update(result, options, theme);
      return component;
    },
  };
}

const cancelPair: AgentToolRendererPair = {
  renderCall(args, theme, context) {
    const parsed = cancelArguments(args);
    context.state.callHidden = false;
    const component =
      context.lastComponent instanceof CancelCallComponent
        ? context.lastComponent
        : new CancelCallComponent(parsed, theme, context.argsComplete);
    component.update(parsed, theme, context.argsComplete);
    return component;
  },
  renderResult(result, options, theme, context) {
    const component =
      context.lastComponent instanceof UnifiedResultComponent
        ? context.lastComponent
        : new UnifiedResultComponent(
            "cancel",
            result,
            options,
            theme,
            context.state,
          );
    component.update(result, options, theme);
    return component;
  },
};

const rendererPairs: Record<AgentToolOperation, AgentToolRendererPair> = {
  start: startPair,
  resume: continuationPair("resume"),
  wait: resultBearingPair("wait"),
  waitAll: resultBearingPair("waitAll"),
  result: resultBearingPair("result"),
  cancel: cancelPair,
  steer: continuationPair("steer"),
};

/** Select one complete renderer pair by operation. */
export function agentToolRenderers(
  operation: AgentToolOperation,
): AgentToolRendererPair {
  return rendererPairs[operation];
}
