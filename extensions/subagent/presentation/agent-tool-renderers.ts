/**
 * The common presentation entry point for the seven agent tools.
 *
 * Registrations choose an operation and receive a complete renderer pair. They
 * do not choose headings, preview limits, summaries, hints, or fallbacks. The
 * Result-bearing operations use semantic details for their compact outcomes;
 * legacy and malformed rows retain the safe common fallback.
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
  type RunResult,
  TERMINAL_RUN_PHASES,
  type TerminalRunPhase,
} from "../domain/index.ts";
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

/** Explicit semantic details carried by migrated agent-tool outcomes. */
export type AgentToolRenderDetails =
  | StartedRunRenderDetails
  | CollectedRunsRenderDetails
  | ResultRenderDetails;

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

export function collectedRunsRenderDetails(
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

export function resultRenderDetails(
  value: unknown,
): ResultRenderDetails | undefined {
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
  private readonly state: AgentToolRendererState;

  constructor(
    operation: "wait" | "waitAll" | "result",
    args: TargetArguments | undefined,
    theme: RenderableTheme,
    state: AgentToolRendererState,
  ) {
    this.operation = operation;
    this.args = args;
    this.theme = theme;
    this.state = state;
  }

  update(
    operation: "wait" | "waitAll" | "result",
    args: TargetArguments | undefined,
    theme: RenderableTheme,
  ): void {
    this.operation = operation;
    this.args = args;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const columns = Math.max(0, width);
    this.state.callHidden = false;
    const name = this.theme.fg(
      "toolTitle",
      this.theme.bold(toolName(this.operation)),
    );
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
  // A timed-out barrier must still read as incomplete when optional collection
  // outcomes do not fit beside it.
  const priority =
    details.stillRunning > 0
      ? `${plural(details.stillRunning, "Run")} still running`
      : details.unavailable > 0
        ? `${plural(details.unavailable, "Result")} unavailable`
        : details.unknown > 0
          ? `${plural(details.unknown, "Run")} unknown`
          : full;
  return theme.fg(
    "toolOutput",
    visibleWidth(full) <= width
      ? full
      : fitToWidth(priority, width, { plain: true }),
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

class OutcomeResultComponent implements Component {
  private operation: "wait" | "waitAll" | "result";
  private result: AgentToolRenderableResult;
  private options: AgentToolResultOptions;
  private theme: RenderableTheme;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private markdown?: Markdown;

  constructor(
    operation: "wait" | "waitAll" | "result",
    result: AgentToolRenderableResult,
    options: AgentToolResultOptions,
    theme: RenderableTheme,
  ) {
    this.operation = operation;
    this.result = result;
    this.options = options;
    this.theme = theme;
  }

  update(
    operation: "wait" | "waitAll" | "result",
    result: AgentToolRenderableResult,
    options: AgentToolResultOptions,
    theme: RenderableTheme,
  ): void {
    this.operation = operation;
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
    const semantic =
      this.operation === "result"
        ? resultRenderDetails(this.result.details)
        : collectedRunsRenderDetails(this.result.details);
    const partial = this.options.isPartial;
    const fallback =
      firstLine(text) ||
      (partial
        ? `${toolName(this.operation)} is still running.`
        : `${toolName(this.operation)} returned no readable response.`);
    const fallbackSummary = this.theme.fg(
      partial ? "muted" : "toolOutput",
      fallback,
    );
    const hidden =
      semantic !== undefined && !partial
        ? text.length > 0
        : text.includes("\n") || visibleWidth(fallbackSummary) > columns;
    const hint = hidden
      ? ` ${formatParentheticalKeyHint(
          this.theme,
          "app.tools.expand",
          "to expand",
        )}`
      : "";
    const summaryWidth = Math.max(0, columns - visibleWidth(hint));
    const summary =
      semantic !== undefined && !partial
        ? this.operation === "result"
          ? retrievalSummary(
              semantic as ResultRenderDetails,
              this.theme,
              summaryWidth,
            )
          : collectionSummary(
              semantic as CollectedRunsRenderDetails,
              this.theme,
              summaryWidth,
            )
        : fallbackSummary;

    if (!this.options.expanded) {
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

function resultBearingPair(
  operation: "wait" | "waitAll" | "result",
): AgentToolRendererPair {
  return {
    renderCall(args, theme, context) {
      const parsed = targetArguments(operation, args);
      const component =
        context.lastComponent instanceof TargetCallComponent
          ? context.lastComponent
          : new TargetCallComponent(operation, parsed, theme, context.state);
      component.update(operation, parsed, theme);
      return component;
    },
    renderResult(result, options, theme, context) {
      const component =
        context.lastComponent instanceof OutcomeResultComponent
          ? context.lastComponent
          : new OutcomeResultComponent(operation, result, options, theme);
      component.update(operation, result, options, theme);
      return component;
    },
  };
}

function fallbackPair(operation: AgentToolOperation): AgentToolRendererPair {
  return {
    renderCall(_args, theme, context) {
      const text =
        context.lastComponent instanceof Text
          ? context.lastComponent
          : new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(toolName(operation))));
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
  wait: resultBearingPair("wait"),
  waitAll: resultBearingPair("waitAll"),
  result: resultBearingPair("result"),
  cancel: fallbackPair("cancel"),
  steer: fallbackPair("steer"),
};

/** Select one complete renderer pair by operation. */
export function agentToolRenderers(
  operation: AgentToolOperation,
): AgentToolRendererPair {
  return rendererPairs[operation];
}
