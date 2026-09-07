import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RenderableTheme } from "./rows.ts";

/** Shared full-screen geometry for drawing and scrolling. */
export function browserViewport(width: number, terminalRows: number) {
  const columns = Math.max(0, Math.floor(width));
  const height = Math.max(0, Math.floor(terminalRows));
  const spacious = height >= 10;
  const inset = columns >= 32 ? 1 : 0;
  return {
    width: columns,
    height,
    spacious,
    inset,
    contentWidth: Math.max(0, columns - inset * 2),
    bodyHeight: Math.max(0, height - (spacious ? 4 : 2)),
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

/** Every row, including empty space and chrome, covers the transcript beneath it. */
export function browserPanel(
  viewport: ReturnType<typeof browserViewport>,
  title: string,
  body: readonly string[],
  footer: string,
  theme: RenderableTheme,
): string[] {
  const { width, height, spacious, inset, contentWidth, bodyHeight } = viewport;
  if (height === 0) return [];
  const heading = theme.fg("accent", title);
  const row = (text: string) =>
    " ".repeat(inset) + padBrowserLine(text, contentWidth) + " ".repeat(inset);
  const lines =
    height === 1
      ? [row(heading)]
      : [
          row(heading),
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
