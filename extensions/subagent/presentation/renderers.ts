/**
 * How a subagent tool call and its result are drawn in the transcript.
 *
 * Ported from v1's renderers. What they draw comes from two different places,
 * and the split is worth naming: an **expanded** result is the text the façade
 * already produced — for `agent_result` that text comes from the `RunCard`, so
 * M4's expanded presentation is a change to the card rather than to a
 * renderer — while a **collapsed** result is a summary of the `details` the
 * façade attached, because a collapsed line may stand for several Runs and a
 * card is about one.
 *
 * The rules the port preserves:
 *
 * - **A started Run's row shows the brief and nothing else.** Its progress
 *   lives in the widget and its answer is retrieved separately, so a row that
 *   showed either would be a stale copy of both.
 * - **A collapsed result is one line.** Agent output is Markdown and can be
 *   thousands of characters; the flat default is both hard to read and hard to
 *   scroll past.
 * - **Lifecycle state is written as a word, not a glyph,** painted in the
 *   phase's tone so a failure still stands out in a column of rows.
 *
 * These functions are pure: given the same result, options, and theme they
 * produce the same component. They read no service and no clock.
 */

import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  Markdown,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { TerminalRunPhase } from "../domain/index.ts";
import {
  type CollectedRuns,
  isCollectedRuns,
  isResumedRun,
  type ResumedRun,
} from "./details.ts";
import type { RenderableTheme } from "./rows.ts";
import {
  formatCharacterCount,
  formatDuration,
  runPhaseTone,
  runPhaseVerb,
} from "./status.ts";

/** What `agent_start` was asked, as the renderer receives it. */
export interface StartCallArguments {
  readonly agent: string;
  readonly description: string;
  readonly prompt: string;
}

/** The slice of Pi's render context these renderers use. */
export interface RenderCallContext {
  readonly lastComponent?: Component;
  readonly expanded: boolean;
}

export interface RenderResultOptions {
  readonly expanded: boolean;
}

/** A tool result as the host hands it back for rendering. */
export interface RenderableToolResult {
  readonly content: string | ReadonlyArray<{ type: string; text?: string }>;
  readonly details?: unknown;
}

export type KeyHintRenderer = typeof keyHint;

/** How many lines of the brief a collapsed `agent_start` row shows. */
const COLLAPSED_PROMPT_LINES = 3;

/**
 * The text of a tool result or message body, whatever shape it arrived in.
 *
 * Takes `unknown` and checks, rather than taking the declared shape and
 * trusting it. This is a renderer boundary: a result or message reaches it
 * through the host as `unknown`, may have been round-tripped through a session
 * file, and may have come from another extension entirely. As
 * `presentation/details.ts` puts it, the type that says otherwise is only as
 * good as the boundary it was written at — and this is that boundary.
 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : "";
    })
    .join("");
}

/** Keep parenthetical punctuation dim even when the hint resets ANSI. */
export function formatParentheticalKeyHint(
  theme: RenderableTheme,
  action: Parameters<KeyHintRenderer>[0],
  description: string,
  renderKeyHint: KeyHintRenderer = keyHint,
): string {
  return `${theme.fg("dim", "(")}${renderKeyHint(action, description)}${theme.fg("dim", ")")}`;
}

/**
 * The transcript row for `agent_start`: who was asked, and what for.
 *
 * The host paints the tool result below this row in the same grey as the
 * prompt, and two adjacent grey paragraphs read as one voice. A `Prompt:`
 * label and a blank line on each side are what keep the brief and the answer
 * apart — plain text, no Markdown, so the row reads the same however the brief
 * is written and however narrow the terminal wraps it.
 */
export function renderStartCall(
  args: StartCallArguments,
  theme: RenderableTheme,
  context: RenderCallContext,
): Component {
  const text =
    context.lastComponent instanceof Text
      ? context.lastComponent
      : new Text("", 0, 0);
  const header =
    `${theme.fg("toolTitle", theme.bold(args.agent))} ` +
    theme.fg("muted", args.description);
  const lines = args.prompt.split("\n");
  // A cut preview must say it is one: three lines that just stop read as the
  // whole brief.
  const preview = context.expanded
    ? args.prompt
    : lines.slice(0, COLLAPSED_PROMPT_LINES).join("\n") +
      (lines.length > COLLAPSED_PROMPT_LINES ? "\n…" : "");
  // The trailing newline is air between the brief and whatever the host paints
  // below it — the tool result otherwise reads as the prompt's last line.
  text.setText(
    `${header}\n\n${theme.fg("muted", "Prompt:")} ${theme.fg("dim", preview)}\n`,
  );
  return text;
}

/** The actionable one-line handoff for a resumed Run. */
export function formatResumeSummary(
  resumed: ResumedRun,
  theme: RenderableTheme,
  renderKeyHint?: KeyHintRenderer,
): string {
  return (
    theme.fg("toolTitle", "Resumed subagent") +
    theme.fg("dim", ` ${resumed.subagentId} · run ${resumed.runId} `) +
    formatParentheticalKeyHint(
      theme,
      "app.tools.expand",
      "to expand",
      renderKeyHint,
    )
  );
}

/**
 * The single line a collapsed result shows in place of the whole body.
 *
 * A lone Run states its status as a word. A fan-out is usually N of the same
 * agent, and naming it N times says nothing the count does not, so names
 * appear only where they differ.
 */
export function formatCollectedSummary(
  collected: CollectedRuns,
  characters: number,
  theme: RenderableTheme,
  renderKeyHint?: KeyHintRenderer,
): string {
  const { runs } = collected;
  let line: string;

  if (runs.length === 1) {
    const run = runs[0];
    line =
      theme.fg("toolTitle", run.agent) +
      theme.fg("dim", ` (${run.runId}) `) +
      theme.fg(runPhaseTone(run.status), run.status);
  } else {
    const counts = new Map<string, number>();
    for (const run of runs) {
      counts.set(run.agent, (counts.get(run.agent) ?? 0) + 1);
    }
    line =
      counts.size === 1
        ? theme.fg("toolTitle", `${runs.length} ${runs[0].agent} results`)
        : theme.fg("toolTitle", `${runs.length} results`) +
          theme.fg(
            "dim",
            ` from ${[...counts]
              .map(([agent, n]) => (n > 1 ? `${agent} ×${n}` : agent))
              .join(", ")}`,
          );
  }

  line += theme.fg("dim", ` · ${formatCharacterCount(characters)}`);
  if (collected.stillRunning) {
    line += theme.fg("warning", ` · ${collected.stillRunning} still running`);
  }
  return `${line} ${formatParentheticalKeyHint(
    theme,
    "app.tools.expand",
    "to expand",
    renderKeyHint,
  )}`;
}

/**
 * Render a collected result: a summary line collapsed, Markdown expanded.
 *
 * Without Runs to name there is nothing to summarise, so a result whose
 * details this renderer does not recognize falls back to its opening line
 * rather than announcing "0 results".
 */
export function renderCollectedResult(
  result: RenderableToolResult,
  options: RenderResultOptions,
  theme: RenderableTheme,
): Component {
  const text = contentText(result.content).trim();
  if (!text) return new Text("", 0, 0);

  if (options.expanded) return new Markdown(text, 0, 0, getMarkdownTheme());

  if (!isCollectedRuns(result.details) || result.details.runs.length === 0) {
    const firstLine = text.split("\n", 1)[0] ?? "";
    return new Text(theme.fg("toolOutput", firstLine), 0, 0);
  }

  return new Text(
    formatCollectedSummary(result.details, text.length, theme),
    0,
    0,
  );
}

/** Render the immediate `agent_resume` result at its registered tool seam. */
export function renderResumeResult(
  result: RenderableToolResult,
  options: RenderResultOptions,
  theme: RenderableTheme,
): Component {
  const text = contentText(result.content).trim();
  if (!text || options.expanded || !isResumedRun(result.details)) {
    return renderCollectedResult(result, options, theme);
  }
  return new Text(formatResumeSummary(result.details, theme), 0, 0);
}

/**
 * The width a collapsed notice line is fitted to when nobody says otherwise.
 *
 * Pi's message-render options carry the expansion state and the output
 * padding and **no width**, so a message renderer cannot ask how wide the
 * terminal is. Eighty columns is the conventional floor rather than a
 * measurement, and it is the one honest default available: fitting to a
 * guess means a narrow terminal can still wrap, and fitting to nothing means
 * every terminal can.
 *
 * It is a parameter on {@link formatNotificationSummary} rather than a
 * constant read inside it, so that the day Pi hands a renderer a width there
 * is one call site to change — and so that "never wraps" can be asserted at a
 * width small enough to read in a golden.
 */
export const NOTICE_SUMMARY_WIDTH = 80;

/**
 * The most room the label may take, however wide the line is.
 *
 * A cap as well as a share, for the same reason the widget caps its agent
 * column: on a wide terminal a two-hundred-byte label would push the outcome
 * and the cost so far right that a reader scanning a column of notices could
 * not find them.
 */
export const MAX_NOTICE_LABEL_WIDTH = 48;

/**
 * The one line a collapsed completion notice shows.
 *
 * `<agent> · <label> · <verb> in <duration>`. It answers the three questions
 * a human following a fan-out actually has — which specialist, which task,
 * how it ended and how long it took — and carries no id and no character
 * count. The ids are in the expanded text, where a model reading them is
 * about to make a tool call; the character count told the reader nothing they
 * could act on.
 *
 * **No cost.** Cost is not backend-independent: the Codex App Server reports
 * token counts and no money, so a cost on this line would appear for every Pi
 * and Claude Run and never for a Codex one — a reader would learn the backend
 * rather than the spend, and would have no way to tell a free Run from an
 * unreported one. What the Run spent stays on the notice's accounting line,
 * where the four figures sit together and an absent cost is one absent figure
 * among four rather than the difference between two shapes of line.
 *
 * **The whole line is fitted, not just the label.** The label takes whatever
 * `width` leaves after the agent, the outcome, the cost, and the hint — those
 * are what the reader came for, so they are never the part that gives — and
 * at most {@link MAX_NOTICE_LABEL_WIDTH} beyond that. It never wraps: a
 * collapsed line that became two lines would defeat the collapsing. See
 * {@link NOTICE_SUMMARY_WIDTH} for why the width is a default rather than the
 * terminal's own.
 *
 * No status glyph: lifecycle state is written as a word, painted in the
 * phase's tone so a failure still stands out. The hint names the direction the
 * toggle will actually go, because one key does both and a hint that always
 * offered to expand would be wrong half the time.
 */
export function formatNotificationSummary(
  details: {
    readonly agent: string;
    readonly label: string;
    readonly status: TerminalRunPhase;
    readonly durationMillis: number;
  },
  theme: RenderableTheme,
  expanded = false,
  renderKeyHint?: KeyHintRenderer,
  width: number = NOTICE_SUMMARY_WIDTH,
): string {
  const agent = theme.fg("toolTitle", theme.bold(details.agent));
  const outcome = theme.fg(
    runPhaseTone(details.status),
    `${runPhaseVerb(details.status)} in ${formatDuration(details.durationMillis)}`,
  );
  const hint = formatParentheticalKeyHint(
    theme,
    "app.tools.expand",
    expanded ? "to collapse" : "to expand",
    renderKeyHint,
  );

  const render = (label: string): string =>
    `${agent}${theme.fg("dim", ` · ${label} · `)}${outcome} ${hint}`;
  /** The label section gone entirely, rather than left as an empty gap. */
  const withoutLabel = `${agent}${theme.fg("dim", " · ")}${outcome} ${hint}`;

  // What the line costs with an empty label, which is what the label's budget
  // is subtracted from. Rendered and measured rather than counted: every part
  // is themed, a colour is not a column, and a delimiter left out of the
  // arithmetic is a line three columns too wide.
  const room = Math.min(
    MAX_NOTICE_LABEL_WIDTH,
    width - visibleWidth(render("")),
  );
  // Too narrow for even one column of label: the label gives way whole, the
  // way a widget row's turn count does, rather than leaving `· ·` behind. The
  // outcome never gives — a reader who cannot see how a Run ended has no line
  // worth having — so a terminal narrower than the fixed parts overflows, and
  // that is the honest end of what fitting can do here.
  return room < 1
    ? withoutLabel
    : render(truncateToWidth(details.label, room, "…"));
}
