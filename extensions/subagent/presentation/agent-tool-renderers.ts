/**
 * The common presentation entry point for the seven agent tools.
 *
 * Registrations choose an operation and receive a complete renderer pair. They
 * do not choose headings, preview limits, summaries, hints, or fallbacks.
 * Operations not yet migrated use the safe common fallback until their
 * operation-specific grammar joins this interface.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  Markdown,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  isTerminalRunPhase,
  type RunPhase,
  type TerminalRunPhase,
} from "../domain/index.ts";
import { CANCEL_OUTCOME_HEADINGS } from "./prose.ts";
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

/** Discriminated, presentation-only details for a successful start. */
export interface StartedRunRenderDetails {
  readonly kind: "start";
  readonly agent: string;
  readonly subagentId: string;
  readonly runId: string;
}

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

/** The union grows here as operation tracer bullets migrate. */
export type AgentToolRenderDetails =
  | StartedRunRenderDetails
  | CancelRenderDetails;

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

export function startedRunRenderDetails(
  value: unknown,
): StartedRunRenderDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
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

function isTerminalPhase(value: unknown): value is TerminalRunPhase {
  return typeof value === "string" && isTerminalRunPhase(value as RunPhase);
}

/** Validate cancellation details at the renderer boundary. */
export function cancelRenderDetails(
  value: unknown,
): CancelRenderDetails | undefined {
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
        if (!isTerminalPhase(outcome.phase)) {
          return undefined;
        }
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

class CancelCallComponent implements Component {
  private args: CancelArguments | undefined;
  private theme: RenderableTheme;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(args: CancelArguments | undefined, theme: RenderableTheme) {
    this.args = args;
    this.theme = theme;
  }

  update(args: CancelArguments | undefined, theme: RenderableTheme): void {
    this.args = args;
    this.theme = theme;
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
    const operation = this.theme.fg(
      "toolTitle",
      this.theme.bold("agent_cancel"),
    );
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
    this.cachedWidth = width;
    this.cachedLines = [fitToWidth(line, columns)];
    return this.cachedLines;
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
  const columns = Math.max(0, width);
  const hint = ` ${formatParentheticalKeyHint(
    theme,
    "app.tools.expand",
    "to expand",
    renderKeyHint,
  )}`;
  const summaryWidth = Math.max(0, columns - visibleWidth(hint));
  return (
    fitToWidth(
      theme.fg("toolOutput", cancellationSummaryText(details)),
      summaryWidth,
    ) + fitToWidth(hint, columns)
  );
}

class CancelResultComponent implements Component {
  private result: AgentToolRenderableResult;
  private options: AgentToolResultOptions;
  private theme: RenderableTheme;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private markdown?: Markdown;

  constructor(
    result: AgentToolRenderableResult,
    options: AgentToolResultOptions,
    theme: RenderableTheme,
  ) {
    this.result = result;
    this.options = options;
    this.theme = theme;
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
    const details = cancelRenderDetails(this.result.details);
    const fallback =
      firstLine(text) ||
      (this.options.isPartial
        ? "agent_cancel is still running."
        : "agent_cancel returned no readable response.");
    const semantic =
      details && !this.options.isPartial
        ? cancellationSummaryText(details)
        : fallback;
    const hidden =
      text.includes("\n") ||
      text !== semantic ||
      visibleWidth(semantic) > columns;

    if (!this.options.expanded) {
      if (details && !this.options.isPartial && hidden) {
        this.cachedLines = [
          formatCancellationSummary(details, this.theme, columns),
        ];
      } else {
        const hint = hidden
          ? ` ${formatParentheticalKeyHint(
              this.theme,
              "app.tools.expand",
              "to expand",
            )}`
          : "";
        const summaryWidth = Math.max(0, columns - visibleWidth(hint));
        this.cachedLines = [
          fitToWidth(this.theme.fg("toolOutput", semantic), summaryWidth) +
            fitToWidth(hint, columns),
        ];
      }
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

const cancelPair: AgentToolRendererPair = {
  renderCall(args, theme, context) {
    const parsed = cancelArguments(args);
    context.state.callHidden = false;
    const component =
      context.lastComponent instanceof CancelCallComponent
        ? context.lastComponent
        : new CancelCallComponent(parsed, theme);
    component.update(parsed, theme);
    return component;
  },
  renderResult(result, options, theme, context) {
    const component =
      context.lastComponent instanceof CancelResultComponent
        ? context.lastComponent
        : new CancelResultComponent(result, options, theme);
    component.update(result, options, theme);
    return component;
  },
};

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
  resume: fallbackPair("resume"),
  wait: fallbackPair("wait"),
  waitAll: fallbackPair("waitAll"),
  result: fallbackPair("result"),
  cancel: cancelPair,
  steer: fallbackPair("steer"),
};

/** Select one complete renderer pair by operation. */
export function agentToolRenderers(
  operation: AgentToolOperation,
): AgentToolRendererPair {
  return rendererPairs[operation];
}
