/** Shared width and key-hint primitives plus Completion Notification rendering. */

import { keyHint } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TerminalRunPhase } from "../domain/index.ts";
import type { RenderableTheme } from "./rows.ts";
import { formatDuration, runPhaseTone, runPhaseVerb } from "./status.ts";
import { fitToWidth } from "./text-width.ts";

export type KeyHintRenderer = typeof keyHint;

/** Read persisted host content defensively at a renderer boundary. */
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
 * A completion notice gives its Run label at most 48 columns. This is distinct
 * from the widget/dashboard Run-label cap of 40 columns; the remaining notice
 * budget is calculated from its actual rendered fixed content below.
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
 * **No cost.** A backend reports the money it is told about, and money is the
 * figure a provider is likeliest not to report at all. `UsageTotals.cost`
 * starts at zero and is only ever added to, so a Run whose backend reported no
 * cost totals zero — indistinguishable from a Run that genuinely cost nothing.
 * A cost on this line would therefore read as a fact when it is sometimes an
 * absence. What the Run spent stays on the notice's accounting line, where the
 * four figures sit together and an unreported cost is one zero among four
 * rather than a line that quietly means two different things.
 *
 * **The label is fitted against the fixed content.** It takes whatever
 * `width` leaves after the agent, outcome, separators, and hint, and at most
 * {@link MAX_NOTICE_LABEL_WIDTH}. The fixed content is retained even when it
 * alone exceeds the width; preserving that narrow fallback avoids turning a
 * fitting refactor into a notice redesign.
 *
 * `width` is **required and has no default**, because a default is a guess and
 * a guessed width is visibly wrong in both directions: too small and a label
 * is cut with room to spare, too large and the line wraps. Every caller states
 * the width it is fitting to, and the host states the one the terminal
 * actually gave it.
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
  /** The columns the line will occupy. See the note above: no default. */
  width: number,
  expanded = false,
  renderKeyHint?: KeyHintRenderer,
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
    `${agent}${theme.fg("dim", " · ")}${theme.fg("dim", label)}${theme.fg("dim", " · ")}${outcome} ${hint}`;
  /** The label section gone entirely, rather than left as an empty gap. */
  const withoutLabel = `${agent}${theme.fg("dim", " · ")}${outcome} ${hint}`;

  // Measure the actual painted fixed content. ANSI bytes are not columns, and
  // keeping both separators here ensures a displayed label pays for both.
  const fixedWidth = visibleWidth(render(""));
  const labelWidth = Math.min(
    MAX_NOTICE_LABEL_WIDTH,
    Math.max(0, width - fixedWidth),
  );
  const label = fitToWidth(details.label, labelWidth);
  // No fitted label means its entire section goes, including one separator.
  return label === "" ? withoutLabel : render(label);
}
