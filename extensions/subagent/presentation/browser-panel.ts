import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RenderableTheme } from "./rows.ts";

/**
 * Shared full-screen geometry for drawing and scrolling.
 *
 * A header may be more than one line — the overview's identity banner is four
 * — so its height is an input here rather than a constant, and the rows it
 * takes come out of the body. A header taller than the screen can hold is
 * shortened rather than allowed to push the footer off: chrome the caller
 * cannot see is chrome it cannot scroll.
 */
export function browserViewport(
  width: number,
  terminalRows: number,
  headerLines = 1,
) {
  const columns = Math.max(0, Math.floor(width));
  const height = Math.max(0, Math.floor(terminalRows));
  const spacious = height >= 10;
  const inset = columns >= 32 ? 1 : 0;
  // The footer always, plus the blank line and the separator a spacious
  // screen adds around the body.
  const chrome = spacious ? 3 : 1;
  const headerHeight = Math.max(
    0,
    Math.min(Math.max(0, Math.floor(headerLines)), height - chrome),
  );
  return {
    width: columns,
    height,
    spacious,
    inset,
    headerHeight,
    contentWidth: Math.max(0, columns - inset * 2),
    bodyHeight: Math.max(0, height - chrome - headerHeight),
  };
}

/** Clip by display cells before padding, including ANSI and wide graphemes. */
export function padBrowserLine(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Prefer complete compact hints to cutting off the final (back/close) action. */
export function browserFooter(
  width: number,
  hints: readonly string[],
  range = "",
): string {
  for (const hint of hints) {
    const full = range ? `${hint} · ${range}` : hint;
    if (visibleWidth(full) <= width) return full;
  }
  return (
    hints.find((hint) => visibleWidth(hint) <= width) ?? hints.at(-1) ?? ""
  );
}

/**
 * Every row, including empty space and chrome, covers the transcript beneath it.
 *
 * A plain title is painted here, as one accented line. Painted header lines
 * are taken as they are: a header with several tones of its own has already
 * decided them, and a second coat applied over the top would flatten them.
 */
export function browserPanel(
  viewport: ReturnType<typeof browserViewport>,
  header: string | readonly string[],
  body: readonly string[],
  footer: string,
  theme: RenderableTheme,
): string[] {
  const { width, height, spacious, inset, contentWidth, bodyHeight } = viewport;
  if (height === 0) return [];
  const heading =
    typeof header === "string" ? [theme.fg("accent", header)] : header;
  const row = (text: string) =>
    " ".repeat(inset) + padBrowserLine(text, contentWidth) + " ".repeat(inset);
  const lines =
    height === 1
      ? [row(heading[0] ?? "")]
      : [
          ...Array.from({ length: viewport.headerHeight }, (_, index) =>
            row(heading[index] ?? ""),
          ),
          ...(spacious ? [row("")] : []),
          ...Array.from({ length: bodyHeight }, (_, index) =>
            row(body[index] ?? ""),
          ),
          ...(spacious
            ? [row(theme.fg("borderMuted", "─".repeat(contentWidth)))]
            : []),
          row(footer),
        ];
  // Use the terminal's default surface, like Pi's dashboard overlays. Padding
  // covers the underlying transcript; resets isolate nested selection colors.
  return lines.map((line) => `\x1b[49m${padBrowserLine(line, width)}\x1b[49m`);
}
