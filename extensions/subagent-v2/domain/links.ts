/**
 * Typed result links: a fixed kind set and a bounded target.
 *
 * A Run often has one genuinely useful pointer into provider territory — the
 * native session file, a log, a URL a backend produced. Surfacing it must not
 * become a hole through which a provider object crosses the boundary, so a
 * link is exactly a kind, a label, and a target string, each bounded, and
 * nothing else.
 */

import { boundOneLine, boundText } from "./text.ts";

export const RESULT_LINK_KINDS = [
  "native-session",
  "log",
  "url",
  "file",
] as const;

export type ResultLinkKind = (typeof RESULT_LINK_KINDS)[number];

/** One line of display text. */
export const RESULT_LINK_LABEL_MAX_BYTES = 200;

/** A path or URL, bounded well below what a terminal would show. */
export const RESULT_LINK_TARGET_MAX_BYTES = 2048;

export interface ResultLink {
  readonly kind: ResultLinkKind;
  readonly label: string;
  readonly target: string;
}

export class InvalidResultLinkError extends Error {
  constructor(kind: unknown) {
    super(`unknown result link kind: ${String(kind)}`);
    this.name = "InvalidResultLinkError";
  }
}

export function isResultLinkKind(value: unknown): value is ResultLinkKind {
  return (RESULT_LINK_KINDS as readonly unknown[]).includes(value);
}

export function resultLink(
  kind: ResultLinkKind,
  label: string,
  target: string,
): ResultLink {
  if (!isResultLinkKind(kind)) throw new InvalidResultLinkError(kind);
  return {
    kind,
    label: boundOneLine(label, RESULT_LINK_LABEL_MAX_BYTES),
    // A target is a path or a URL, so its whitespace is trimmed but its
    // interior is left alone: nothing in it is a line to collapse.
    target: boundText(target.trim(), RESULT_LINK_TARGET_MAX_BYTES).text,
  };
}
