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
  contentText,
  formatParentheticalKeyHint,
  type KeyHintRenderer,
} from "./renderers.ts";
import type { RenderableTheme } from "./rows.ts";
import { fitToWidth } from "./text-width.ts";
import {
  type CancelToolRowFacts,
  cancelRowPresentation,
  decodeToolRowFacts,
  type ResumedRunToolRowFacts,
  type StartedRunToolRowFacts,
  type ToolRowFacts,
  type ToolRowPresentation,
  type ToolRowTone,
  toolRowPresentation,
} from "./tool-row-facts.ts";

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

interface AgentToolRenderContext {
  readonly args: unknown;
  readonly lastComponent?: Component;
  readonly state: AgentToolRendererState;
  readonly expanded: boolean;
  readonly isPartial: boolean;
  readonly argsComplete: boolean;
}

interface AgentToolResultOptions {
  readonly expanded: boolean;
  readonly isPartial: boolean;
}

interface AgentToolRenderableResult {
  readonly content: unknown;
  readonly details?: unknown;
}

/** A complete pair is the only unit a registration can obtain. */
interface AgentToolRendererPair {
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

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
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
  details: StartedRunToolRowFacts,
  presentation: ToolRowPresentation,
  theme: RenderableTheme,
  width: number,
): string {
  const candidates = [
    theme.fg(presentation.tone, `${presentation.rowPhrase} ${details.agent}`) +
      theme.fg(
        "dim",
        ` · Subagent ${details.subagentId} · Run ${details.runId}`,
      ),
    theme.fg(presentation.tone, presentation.rowPhrase) +
      theme.fg(
        "dim",
        ` · Subagent ${details.subagentId} · Run ${details.runId}`,
      ),
    theme.fg(presentation.tone, presentation.rowPhrase) +
      theme.fg("dim", ` · ${details.subagentId} · ${details.runId}`),
  ];
  return (
    candidates.find((candidate) => visibleWidth(candidate) <= width) ??
    fitToWidth(candidates.at(-1) ?? "", width)
  );
}

function phraseSummary(
  details: { readonly rowPhrase: string; readonly tone: ToolRowTone },
  theme: RenderableTheme,
): string {
  const separator = details.rowPhrase.indexOf(" · ");
  if (separator < 0) return theme.fg(details.tone, details.rowPhrase);
  return (
    theme.fg(details.tone, details.rowPhrase.slice(0, separator)) +
    theme.fg("dim", details.rowPhrase.slice(separator))
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
    const facts = decodeToolRowFacts(this.result.details);
    if (facts === undefined) return undefined;
    const sourceText =
      facts.kind === "cancel"
        ? cancelRowPresentation(facts).rowPhrase
        : undefined;
    return {
      line: (width) => toolRowSummary(facts, this.theme, width),
      sourceText,
    };
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

/** One-line cancellation admission summary with the configured toggle hint. */
export function formatCancellationSummary(
  details: CancelToolRowFacts,
  theme: RenderableTheme,
  width: number,
  renderKeyHint?: KeyHintRenderer,
): string {
  const presentation = cancelRowPresentation(details);
  return collapsedResultLine(
    theme.fg(presentation.tone, presentation.rowPhrase),
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

function collectionSummary(
  presentation: ToolRowPresentation,
  theme: RenderableTheme,
  width: number,
): string {
  const collection = presentation.collection;
  if (collection === undefined || collection.clauses.length === 0) {
    return theme.fg(presentation.tone, presentation.rowPhrase);
  }

  if (visibleWidth(presentation.rowPhrase) <= width) {
    return theme.fg(presentation.tone, presentation.rowPhrase);
  }

  // The facts owner supplies both orders. This loop owns only fitting: clauses
  // earn space by priority, then return to stable reading order.
  const selected = new Set<string>();
  for (const clause of collection.priority) {
    const candidate = collection.clauses.filter(
      (original) => selected.has(original) || original === clause,
    );
    if (visibleWidth(candidate.join(collection.separator)) > width) break;
    selected.add(clause);
  }
  const retained = collection.clauses
    .filter((clause) => selected.has(clause))
    .join(collection.separator);
  return theme.fg(
    presentation.tone,
    retained ||
      fitToWidth(collection.priority[0] ?? presentation.rowPhrase, width, {
        plain: true,
      }),
  );
}

/** Render any decoded Tool-row facts through one summary policy. */
function toolRowSummary(
  facts: ToolRowFacts,
  theme: RenderableTheme,
  width: number,
): string {
  const presentation = toolRowPresentation(facts);
  switch (facts.kind) {
    case "start":
      return "subagentId" in facts
        ? formatStartedIdentity(facts, presentation, theme, width)
        : phraseSummary(presentation, theme);
    case "resume":
      return "runId" in facts
        ? resumedIdentity(facts, presentation, theme, width)
        : phraseSummary(presentation, theme);
    case "steer":
      return phraseSummary(presentation, theme);
    case "cancel":
      return theme.fg(presentation.tone, presentation.rowPhrase);
    case "collection":
      return collectionSummary(presentation, theme, width);
    case "result": {
      const candidates =
        facts.outcome === "available"
          ? [
              `${facts.run.agent} · ${facts.run.runId} · ${facts.run.status} · ${presentation.rowPhrase}`,
              `${facts.run.agent} · ${facts.run.runId} · ${facts.run.status}`,
              `${facts.run.runId} · ${facts.run.status}`,
            ]
          : facts.outcome === "unavailable"
            ? [`${facts.runId} · ${presentation.rowPhrase} · ${facts.status}`]
            : [`${facts.runId} · ${presentation.rowPhrase}`];
      const text =
        candidates.find((candidate) => visibleWidth(candidate) <= width) ??
        fitToWidth(candidates.at(-1) ?? "", width, { plain: true });
      return theme.fg(presentation.tone, text);
    }
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

function resumedIdentity(
  details: ResumedRunToolRowFacts,
  presentation: ToolRowPresentation,
  theme: RenderableTheme,
  width: number,
): string {
  const candidates = [
    theme.fg(presentation.tone, presentation.rowPhrase) +
      theme.fg("dim", ` · Run ${details.runId}`),
    theme.fg(presentation.tone, presentation.rowPhrase) +
      theme.fg("dim", ` · ${details.runId}`),
  ];
  return (
    candidates.find((candidate) => visibleWidth(candidate) <= width) ??
    fitToWidth(candidates.at(-1) ?? "", width)
  );
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
