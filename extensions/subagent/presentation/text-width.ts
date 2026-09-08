import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** How terminal text fitting should treat a line. */
export interface FitOptions {
  /** Pad the result to the full width, so list columns line up. */
  readonly pad?: boolean;
  /**
   * The text is plain, so discard reset sequences introduced by clipping.
   *
   * A surface that paints the fitted text itself must not let such a reset end
   * that paint early. Already-painted text keeps its resets to close its ANSI
   * styling correctly.
   */
  readonly plain?: boolean;
}

/** Clip text to terminal cells, accounting for ANSI and wide graphemes. */
export function fitToWidth(
  text: string,
  width: number,
  options: FitOptions = {},
): string {
  const columns = Math.max(0, width);
  const clipped = truncateToWidth(text, columns, "…");
  const fitted = options.plain ? stripTerminalSequences(clipped) : clipped;
  return options.pad
    ? fitted + " ".repeat(Math.max(0, columns - visibleWidth(fitted)))
    : fitted;
}
