/**
 * The four v2 identifiers.
 *
 * Every one of them is a string at runtime and a distinct type at compile
 * time, so a Run id can never be passed where a Subagent id is expected. The
 * brand is a phantom property that no value actually carries: it exists only
 * to make the four types mutually unassignable.
 *
 * `BackendId` is deliberately not an enum. A fake backend in a test and a real
 * backend added in a later milestone both need an id, and neither should
 * require editing a central union to get one.
 */

declare const brand: unique symbol;

/** A string carrying a compile-time-only tag. */
export type Branded<Tag extends string> = string & {
  readonly [brand]: Tag;
};

export type BackendId = Branded<"BackendId">;
export type SubagentId = Branded<"SubagentId">;
export type RunId = Branded<"RunId">;
export type ControlId = Branded<"ControlId">;

/** Every identifier kind, for diagnostics and for enumerating in tests. */
export const IDENTIFIER_KINDS = [
  "BackendId",
  "SubagentId",
  "RunId",
  "ControlId",
] as const;

export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/**
 * The shape every identifier shares: printable, compact, and free of
 * whitespace, so an id can appear in a diagnostic, a log line, or a widget row
 * without quoting or escaping.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Long enough for a uuid with a prefix, short enough to print. */
export const IDENTIFIER_MAX_LENGTH = 128;

export class InvalidIdentifierError extends Error {
  readonly kind: IdentifierKind;
  readonly rejected: unknown;

  constructor(kind: IdentifierKind, rejected: unknown, reason: string) {
    super(`invalid ${kind}: ${reason}`);
    this.name = "InvalidIdentifierError";
    this.kind = kind;
    this.rejected = rejected;
  }
}

/**
 * Whether a value has the runtime shape every identifier constructor
 * enforces. The brand itself is a compile-time fact with no runtime witness,
 * so this is the strongest check a guard can make.
 */
export function hasIdentifierShape(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= IDENTIFIER_MAX_LENGTH &&
    IDENTIFIER_PATTERN.test(value)
  );
}

function makeIdentifier<Tag extends IdentifierKind>(
  kind: Tag,
  value: unknown,
): Branded<Tag> {
  if (typeof value !== "string") {
    throw new InvalidIdentifierError(kind, value, "not a string");
  }
  if (value.length === 0) {
    throw new InvalidIdentifierError(kind, value, "empty");
  }
  if (value.length > IDENTIFIER_MAX_LENGTH) {
    throw new InvalidIdentifierError(
      kind,
      value,
      `longer than ${IDENTIFIER_MAX_LENGTH} characters`,
    );
  }
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidIdentifierError(
      kind,
      value,
      "contains characters outside letters, digits, '.', '_', ':' and '-'",
    );
  }
  return value as Branded<Tag>;
}

export function backendId(value: unknown): BackendId {
  return makeIdentifier("BackendId", value);
}

export function subagentId(value: unknown): SubagentId {
  return makeIdentifier("SubagentId", value);
}

export function runId(value: unknown): RunId {
  return makeIdentifier("RunId", value);
}

export function controlId(value: unknown): ControlId {
  return makeIdentifier("ControlId", value);
}

export function isBackendId(value: unknown): value is BackendId {
  return hasIdentifierShape(value);
}

export function isSubagentId(value: unknown): value is SubagentId {
  return hasIdentifierShape(value);
}

export function isRunId(value: unknown): value is RunId {
  return hasIdentifierShape(value);
}

export function isControlId(value: unknown): value is ControlId {
  return hasIdentifierShape(value);
}

/** The backend a Profile names when it names none. */
export const DEFAULT_BACKEND_ID: BackendId = backendId("pi");
