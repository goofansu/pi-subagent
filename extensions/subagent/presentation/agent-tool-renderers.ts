/**
 * The common presentation entry point for the seven agent tools.
 *
 * Registrations choose an operation and receive a complete renderer pair. They
 * do not choose headings, preview limits, summaries, hints, or fallbacks. The
 * start, resume, and steer pairs are migrated; the remaining operation keys
 * use the safe common fallback until their operation-specific grammar moves.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  Markdown,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ResumeOutcome, RunId, SteerOutcome } from "../domain/index.ts";
import {
  contentText,
  formatParentheticalKeyHint,
  type KeyHintRenderer,
} from "./renderers.ts";
import type { RenderableTheme } from "./rows.ts";
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

/** Discriminated, presentation-only details for a successful start. */
export interface StartedRunRenderDetails {
  readonly kind: "start";
  readonly agent: string;
  readonly subagentId: string;
  readonly runId: string;
}

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

/** The discriminated, presentation-only details of migrated operations. */
export type AgentToolRenderDetails =
  | StartedRunRenderDetails
  | ResumeRenderDetails
  | SteerRenderDetails;

const COLLAPSED_BODY_LINES = 5;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function startArguments(value: unknown): StartArguments | undefined {
  const candidate = recordOf(value);
  return candidate &&
    typeof candidate.agent === "string" &&
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

export function startedRunRenderDetails(
  value: unknown,
): StartedRunRenderDetails | undefined {
  const candidate = recordOf(value);
  if (!candidate) return undefined;
  return candidate.kind === "start" &&
    typeof candidate.agent === "string" &&
    typeof candidate.subagentId === "string" &&
    typeof candidate.runId === "string"
    ? {
        kind: "start",
        agent: candidate.agent,
        subagentId: candidate.subagentId,
        runId: candidate.runId,
      }
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

export function parseResumeRenderDetails(
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

export function parseSteerRenderDetails(
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

function hiddenMarker(hidden: number, theme: RenderableTheme): string {
  return theme.fg(
    "muted",
    `... (${hidden} more ${hidden === 1 ? "line" : "lines"})`,
  );
}

class StartCallComponent implements Component {
  private args: StartArguments | undefined;
  private theme: RenderableTheme;
  private expanded: boolean;
  private readonly state: AgentToolRendererState;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    args: StartArguments | undefined,
    theme: RenderableTheme,
    expanded: boolean,
    state: AgentToolRendererState,
  ) {
    this.args = args;
    this.theme = theme;
    this.expanded = expanded;
    this.state = state;
  }

  update(
    args: StartArguments | undefined,
    theme: RenderableTheme,
    expanded: boolean,
  ): void {
    this.args = args;
    this.theme = theme;
    this.expanded = expanded;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const columns = Math.max(0, width);
    if (!this.args) {
      this.state.callHidden = false;
      this.cachedLines = [
        fitToWidth(
          this.theme.fg("toolTitle", this.theme.bold("agent_start")) +
            this.theme.fg("error", " [invalid arguments]"),
          columns,
        ),
      ];
      this.cachedWidth = width;
      return this.cachedLines;
    }

    const operation = this.theme.fg(
      "toolTitle",
      this.theme.bold("agent_start"),
    );
    const agent = this.theme.fg("accent", this.args.agent);
    const fixedHeader = `${operation} ${agent}`;
    const labelBudget = Math.max(
      0,
      columns - visibleWidth(fixedHeader) - visibleWidth(" · "),
    );
    const fittedLabel = fitToWidth(this.args.description, labelBudget, {
      plain: true,
    });
    const header = fitToWidth(
      fittedLabel
        ? `${fixedHeader}${this.theme.fg("dim", " · ")}${this.theme.fg("muted", fittedLabel)}`
        : fixedHeader,
      columns,
    );
    const prompt =
      this.theme.fg("muted", "Prompt:") +
      " " +
      this.theme.fg("dim", this.args.prompt);
    const visualPrompt = wrapTextWithAnsi(prompt, Math.max(1, columns));
    const hidden = Math.max(0, visualPrompt.length - COLLAPSED_BODY_LINES);
    this.state.callHidden = hidden > 0;
    const shown = this.expanded
      ? visualPrompt
      : visualPrompt.slice(0, COLLAPSED_BODY_LINES);
    const lines = [
      header,
      "",
      ...shown.map((line) => fitToWidth(line, columns)),
    ];
    if (!this.expanded && hidden > 0) {
      lines.push(fitToWidth(hiddenMarker(hidden, this.theme), columns));
    }
    // Air between the submitted prompt and the result slot.
    lines.push("");
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
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

/** A compact successful start with its row's one configured expansion hint. */
export function formatStartedRunSummary(
  details: StartedRunRenderDetails,
  theme: RenderableTheme,
  width: number,
  renderKeyHint?: KeyHintRenderer,
): string {
  const columns = Math.max(0, width);
  const hint = ` ${formatParentheticalKeyHint(
    theme,
    "app.tools.expand",
    "to expand",
    renderKeyHint,
  )}`;
  const summaryWidth = Math.max(0, columns - visibleWidth(hint));
  return (
    formatStartedIdentity(details, theme, summaryWidth) +
    fitToWidth(hint, columns)
  );
}

class StartResultComponent implements Component {
  private result: AgentToolRenderableResult;
  private options: AgentToolResultOptions;
  private theme: RenderableTheme;
  private readonly state: AgentToolRendererState;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private markdown?: Markdown;

  constructor(
    result: AgentToolRenderableResult,
    options: AgentToolResultOptions,
    theme: RenderableTheme,
    state: AgentToolRendererState,
  ) {
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

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const columns = Math.max(0, width);
    const text = contentText(this.result.content).trim();
    const details = startedRunRenderDetails(this.result.details);
    const partial = this.options.isPartial;
    const fallback =
      firstLine(text) ||
      (partial
        ? "agent_start is still running."
        : "agent_start returned no readable response.");
    const summary =
      details && !partial
        ? formatStartedIdentity(details, this.theme, columns)
        : this.theme.fg(partial ? "muted" : "toolOutput", fallback);
    const resultHidden =
      details !== undefined && !partial
        ? text.length > 0
        : text.includes("\n") || visibleWidth(summary) > columns;
    const hidden = this.state.callHidden === true || resultHidden;

    if (!this.options.expanded) {
      if (details && !partial && hidden) {
        this.cachedLines = [
          formatStartedRunSummary(details, this.theme, columns),
        ];
        this.cachedWidth = width;
        return this.cachedLines;
      }
      const hint = hidden
        ? ` ${formatParentheticalKeyHint(
            this.theme,
            "app.tools.expand",
            "to expand",
          )}`
        : "";
      const summaryWidth = Math.max(0, columns - visibleWidth(hint));
      this.cachedLines = [
        fitToWidth(summary, summaryWidth) + fitToWidth(hint, columns),
      ];
      this.cachedWidth = width;
      return this.cachedLines;
    }

    this.markdown ??= new Markdown(text || fallback, 0, 0, getMarkdownTheme());
    const rendered = this.markdown.render(columns);
    this.cachedLines = hidden
      ? [
          ...rendered,
          fitToWidth(
            formatParentheticalKeyHint(
              this.theme,
              "app.tools.expand",
              "to collapse",
            ),
            columns,
          ),
        ]
      : rendered;
    this.cachedWidth = width;
    return this.cachedLines;
  }
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
            context.state,
          );
    component.update(parsed, theme, context.expanded);
    return component;
  },
  renderResult(result, options, theme, context) {
    const component =
      context.lastComponent instanceof StartResultComponent
        ? context.lastComponent
        : new StartResultComponent(result, options, theme, context.state);
    component.update(result, options, theme);
    return component;
  },
};

type ContinuationArguments =
  | { readonly operation: "resume"; readonly value: ResumeArguments }
  | { readonly operation: "steer"; readonly value: SteerArguments };

class ContinuationCallComponent implements Component {
  private readonly operation: "resume" | "steer";
  private args: ContinuationArguments | undefined;
  private theme: RenderableTheme;
  private expanded: boolean;
  private readonly state: AgentToolRendererState;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    operation: "resume" | "steer",
    args: ContinuationArguments | undefined,
    theme: RenderableTheme,
    expanded: boolean,
    state: AgentToolRendererState,
  ) {
    this.operation = operation;
    this.args = args;
    this.theme = theme;
    this.expanded = expanded;
    this.state = state;
  }

  update(
    args: ContinuationArguments | undefined,
    theme: RenderableTheme,
    expanded: boolean,
  ): void {
    this.args = args;
    this.theme = theme;
    this.expanded = expanded;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const columns = Math.max(0, width);
    const toolName = `agent_${this.operation}`;
    if (!this.args) {
      this.state.callHidden = false;
      this.cachedLines = [
        fitToWidth(
          this.theme.fg("toolTitle", this.theme.bold(toolName)) +
            this.theme.fg("error", " [invalid arguments]"),
          columns,
        ),
      ];
      this.cachedWidth = width;
      return this.cachedLines;
    }

    const target = this.args.value.id;
    const fixedHeader =
      this.theme.fg("toolTitle", this.theme.bold(toolName)) +
      ` ${this.theme.fg("accent", target)}`;
    const description =
      this.args.operation === "resume" ? this.args.value.description : "";
    const labelBudget = Math.max(
      0,
      columns - visibleWidth(fixedHeader) - visibleWidth(" · "),
    );
    const label = fitToWidth(description, labelBudget, { plain: true });
    const header = fitToWidth(
      label
        ? `${fixedHeader}${this.theme.fg("dim", " · ")}${this.theme.fg("muted", label)}`
        : fixedHeader,
      columns,
    );
    const prefix = this.args.operation === "resume" ? "Prompt:" : "Message:";
    const body =
      this.args.operation === "resume"
        ? this.args.value.prompt
        : this.args.value.message;
    const paintedBody = `${this.theme.fg("muted", prefix)} ${this.theme.fg("dim", body)}`;
    const visualBody = wrapTextWithAnsi(paintedBody, Math.max(1, columns));
    const hidden = Math.max(0, visualBody.length - COLLAPSED_BODY_LINES);
    this.state.callHidden = hidden > 0;
    const shown = this.expanded
      ? visualBody
      : visualBody.slice(0, COLLAPSED_BODY_LINES);
    this.cachedLines = [
      header,
      "",
      ...shown.map((line) => fitToWidth(line, columns)),
      ...(!this.expanded && hidden > 0
        ? [fitToWidth(hiddenMarker(hidden, this.theme), columns)]
        : []),
      "",
    ];
    this.cachedWidth = width;
    return this.cachedLines;
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
  const columns = Math.max(0, width);
  const hint = ` ${formatParentheticalKeyHint(
    theme,
    "app.tools.expand",
    "to expand",
    renderKeyHint,
  )}`;
  const summaryWidth = Math.max(0, columns - visibleWidth(hint));
  return (
    resumedIdentity(details, theme, summaryWidth) + fitToWidth(hint, columns)
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

class SemanticResultComponent implements Component {
  private result: AgentToolRenderableResult;
  private options: AgentToolResultOptions;
  private theme: RenderableTheme;
  private readonly operation: "resume" | "steer";
  private readonly state: AgentToolRendererState;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private markdown?: Markdown;

  constructor(
    operation: "resume" | "steer",
    result: AgentToolRenderableResult,
    options: AgentToolResultOptions,
    theme: RenderableTheme,
    state: AgentToolRendererState,
  ) {
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

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.markdown = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) {
      return this.cachedLines;
    }
    const columns = Math.max(0, width);
    const text = contentText(this.result.content).trim();
    const details =
      this.operation === "resume"
        ? parseResumeRenderDetails(this.result.details)
        : parseSteerRenderDetails(this.result.details);
    const semantic =
      details === undefined
        ? undefined
        : details.kind === "resume"
          ? resumeSummary(details, this.theme, columns)
          : steerSummary(details, this.theme);
    const fallback =
      firstLine(text) ||
      (this.options.isPartial
        ? `agent_${this.operation} is still running.`
        : `agent_${this.operation} returned no readable response.`);
    const summary =
      semantic !== undefined && !this.options.isPartial
        ? semantic
        : this.theme.fg(
            this.options.isPartial ? "muted" : "toolOutput",
            fallback,
          );
    const resultHidden =
      semantic !== undefined && !this.options.isPartial
        ? text.length > 0
        : text.includes("\n") || visibleWidth(summary) > columns;
    const hidden = this.state.callHidden === true || resultHidden;

    if (!this.options.expanded) {
      if (
        details?.kind === "resume" &&
        details.outcome === "started" &&
        !this.options.isPartial &&
        hidden
      ) {
        this.cachedLines = [
          formatResumedRunSummary(details, this.theme, columns),
        ];
        this.cachedWidth = width;
        return this.cachedLines;
      }
      const hint = hidden
        ? ` ${formatParentheticalKeyHint(
            this.theme,
            "app.tools.expand",
            "to expand",
          )}`
        : "";
      const summaryWidth = Math.max(0, columns - visibleWidth(hint));
      this.cachedLines = [
        fitToWidth(summary, summaryWidth) + fitToWidth(hint, columns),
      ];
      this.cachedWidth = width;
      return this.cachedLines;
    }

    this.markdown ??= new Markdown(text || fallback, 0, 0, getMarkdownTheme());
    const rendered = this.markdown.render(columns);
    this.cachedLines = hidden
      ? [
          ...rendered,
          fitToWidth(
            formatParentheticalKeyHint(
              this.theme,
              "app.tools.expand",
              "to collapse",
            ),
            columns,
          ),
        ]
      : rendered;
    this.cachedWidth = width;
    return this.cachedLines;
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
              context.state,
            );
      component.update(value, theme, context.expanded);
      return component;
    },
    renderResult(result, options, theme, context) {
      const component =
        context.lastComponent instanceof SemanticResultComponent
          ? context.lastComponent
          : new SemanticResultComponent(
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

function fallbackPair(operation: AgentToolOperation): AgentToolRendererPair {
  const toolName =
    operation === "waitAll" ? "agent_wait_all" : `agent_${operation}`;
  return {
    renderCall(_args, theme, context) {
      const text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(toolName)));
      context.state.callHidden = false;
      return text;
    },
    renderResult(result, options, theme, context) {
      const component =
        context.lastComponent instanceof StartResultComponent
          ? context.lastComponent
          : new StartResultComponent(result, options, theme, context.state);
      component.update(result, options, theme);
      return component;
    },
  };
}

const rendererPairs: Record<AgentToolOperation, AgentToolRendererPair> = {
  start: startPair,
  resume: continuationPair("resume"),
  wait: fallbackPair("wait"),
  waitAll: fallbackPair("waitAll"),
  result: fallbackPair("result"),
  cancel: fallbackPair("cancel"),
  steer: continuationPair("steer"),
};

/** Select one complete renderer pair by operation. */
export function agentToolRenderers(
  operation: AgentToolOperation,
): AgentToolRendererPair {
  return rendererPairs[operation];
}
