import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { RenderableTheme } from "./rows.ts";

/** Shared geometry for drawing and scrolling; never exceed Pi's 80% height cap. */
export function browserViewport(width: number, terminalRows: number) {
  const columns = Math.max(0, Math.floor(width));
  const height = Math.max(0, Math.floor(terminalRows * 0.8));
  const spacious = height >= 10;
  const inset = columns >= 32 ? 1 : 0;
  return {
    width: columns,
    height,
    spacious,
    inset,
    contentWidth: Math.max(0, columns - 2 - inset * 2),
    bodyHeight: Math.max(0, height - (spacious ? 6 : 2)),
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
  const border = (text: string) => theme.fg("border", text);
  const heading = theme.fg("accent", theme.bold(title));
  const help = theme.fg("dim", footer);
  const innerWidth = Math.max(0, width - 2);
  const rule = (left: string, right: string, text = "") => {
    const label = truncateToWidth(text ? ` ${text} ` : "", innerWidth, "…");
    return (
      border(left) +
      label +
      border("─".repeat(Math.max(0, innerWidth - visibleWidth(label))) + right)
    );
  };
  const row = (text: string) =>
    border("│") +
    " ".repeat(inset) +
    padBrowserLine(text, contentWidth) +
    " ".repeat(inset) +
    border("│");
  const lines =
    height === 1
      ? [heading]
      : [
          rule("╭", "╮", spacious ? "" : heading),
          ...(spacious ? [row(heading), rule("├", "┤")] : []),
          ...Array.from({ length: bodyHeight }, (_, index) =>
            row(body[index] ?? ""),
          ),
          ...(spacious ? [rule("├", "┤"), row(help)] : []),
          rule("╰", "╯", spacious ? "" : help),
        ];
  // Theme.bg does not restore an outer background after a nested SGR reset.
  // Reapply the surface after those resets, including any from captured output.
  return lines.map((line) =>
    padBrowserLine(line, width)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR background resets are terminal formatting.
      .split(/(\x1b\[(?:0|49)?m)/)
      .map((part) => theme.bg("customMessageBg", part))
      .join(""),
  );
}
