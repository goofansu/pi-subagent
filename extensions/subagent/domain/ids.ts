/**
 * The four v2 identifiers.
 *
 * Every one of them is a string at runtime and a distinct type at compile
 * time, so a Run id can never be passed where a Subagent id is expected. Each
 * is one branded schema: the shape rule, the brand, the constructor, and the
 * guard are four readings of the same declaration rather than four things to
 * keep in step.
 *
 * `BackendId` is deliberately not an enum. A fake backend in a test and a real
 * backend added in a later milestone both need an id, and neither should
 * require editing a central union to get one.
 *
 * See docs/adr/0029-v2-effect-schema.md.
 */

import { Schema } from "effect";

/**
 * The shape every identifier shares: printable, compact, and free of
 * whitespace, so an id can appear in a diagnostic, a log line, or a widget row
 * without quoting or escaping.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Long enough for a uuid with a prefix, short enough to print. */
export const IDENTIFIER_MAX_LENGTH = 128;

/** The unbranded rule. Every identifier is this plus one brand. */
const IdentifierText = Schema.String.check(
  Schema.isLengthBetween(1, IDENTIFIER_MAX_LENGTH),
  Schema.isPattern(IDENTIFIER_PATTERN),
);

export const BackendId = IdentifierText.pipe(Schema.brand("BackendId"));
export const SubagentId = IdentifierText.pipe(Schema.brand("SubagentId"));
export const RunId = IdentifierText.pipe(Schema.brand("RunId"));
export const ControlId = IdentifierText.pipe(Schema.brand("ControlId"));

export type BackendId = typeof BackendId.Type;
export type SubagentId = typeof SubagentId.Type;
export type RunId = typeof RunId.Type;
export type ControlId = typeof ControlId.Type;

/** Every identifier kind, for diagnostics and for enumerating in tests. */
export const IDENTIFIER_KINDS = [
  "BackendId",
  "SubagentId",
  "RunId",
  "ControlId",
] as const;

export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/**
 * Whether a value has the runtime shape every identifier constructor
 * enforces.
 *
 * There is one such predicate rather than four, and that is the honest number:
 * a brand is a compile-time fact with no runtime witness, so nothing at
 * runtime can tell a `RunId` from a `SubagentId`. M1 had four guards whose
 * bodies were identical and whose names promised a discrimination they could
 * not perform.
 */
export const hasIdentifierShape: (value: unknown) => value is string =
  Schema.is(IdentifierText);

/**
 * The four constructors.
 *
 * Each decodes an `unknown` and throws on anything that is not an identifier,
 * because a caller that has just built an id from a literal wants the mistake
 * at the call site rather than a `Result` to unwrap. Callers that hold
 * genuinely untrusted input decode the schema themselves.
 */
export const backendId: (value: unknown) => BackendId =
  Schema.decodeUnknownSync(BackendId);
export const subagentId: (value: unknown) => SubagentId =
  Schema.decodeUnknownSync(SubagentId);
export const runId: (value: unknown) => RunId = Schema.decodeUnknownSync(RunId);
export const controlId: (value: unknown) => ControlId =
  Schema.decodeUnknownSync(ControlId);

/** The backend a Profile names when it names none. */
export const DEFAULT_BACKEND_ID: BackendId = backendId("pi");
