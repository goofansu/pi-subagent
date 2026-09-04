/**
 * The six tool inputs, declared once as Schema.
 *
 * ADR-0029 adopted Effect Schema for v2, and the M2 spike cleared the last
 * thing keeping a second schema library alive here: `Schema.toJsonSchemaDocument`
 * emits a Draft 2020-12 document that Pi's own `validateToolArguments`
 * accepts. So each tool's input is one declaration, read three ways — the JSON
 * Schema the model is shown, the runtime check at `execute`, and the
 * TypeScript type the façade takes.
 *
 * Two shape notes from the spike are load-bearing:
 *
 * - **`Schema.Finite`, never `Schema.Number`.** The encoded form of
 *   `Schema.Number` admits `"Infinity"`, `"-Infinity"`, and `"NaN"`, so it
 *   emits an `anyOf` of a number and a three-member string enum — which is
 *   noise in a model-facing schema and swallows both the description and any
 *   numeric refinement. `Schema.Finite` emits a plain `{"type":"number"}`.
 * - **`additionalProperties: false` is emitted, and is stricter than v1.**
 *   v1's `Type.Object` permitted unlisted keys. Keeping the emitted document
 *   as it stands means a call carrying an excess argument is rejected, by Pi
 *   and by the decode below. That is a deliberate v2 difference, recorded in
 *   the M3 exit gate: an argument the tool does not understand is far more
 *   likely to be a mistake than a courtesy.
 *
 * **Decoding at `execute` is the real check.** Pi falls back to JSON-Schema
 * *coercion* for a document it did not get from its own schema library, so a
 * string where a number belongs may arrive coerced rather than rejected. The
 * host therefore never relies on Pi to reject malformed input; it
 * decodes, and a decode failure is a tool outcome rather than a throw.
 */

import { Result, Schema } from "effect";
import {
  EXACT_KEYS,
  RUN_LABEL_MAX_BYTES,
  RunId,
  SubagentId,
} from "../domain/index.ts";
import { formatToolInputRejected } from "../presentation/index.ts";

/**
 * What Pi's `ToolDefinition.parameters` is given.
 *
 * Typed as an opaque record rather than the host's own schema type, because
 * that type is the second schema library's and v2 does not name it. The host
 * branches on a TypeBox marker symbol at runtime and falls back to JSON Schema
 * when it is absent, which is exactly this case.
 */
export type ToolParameters = Readonly<Record<string, unknown>>;

/** Emit the JSON Schema document Pi validates a call against. */
export function toolParameters(schema: Schema.Top): ToolParameters {
  return Schema.toJsonSchemaDocument(schema).schema;
}

/**
 * A description on every field.
 *
 * The field descriptions are what a model reads when it decides what to put
 * in a call, so they are product copy and not documentation. Ported from v1.
 */
const RUN_ID = RunId.annotate({
  description: "A Run id returned by agent_start or agent_resume",
});

/**
 * What the label's bound says to a model that reads the schema.
 *
 * Spelled once and appended to both description fields, because a model that
 * learned the rule on `agent_start` and found it unstated on `agent_resume`
 * would reasonably conclude the two differ. It states both ends of the bound
 * *and* what happens at each: past the byte bound the label is shortened and
 * the call goes through, so nothing there invites a retry; empty is refused,
 * so the model sends a description instead of discovering the rule by being
 * refused.
 */
const LABEL_BOUND_CLAUSE = `; one line, at most ${RUN_LABEL_MAX_BYTES} bytes, shortened if longer, and never empty — an empty description is refused`;

export const StartInputSchema = Schema.Struct({
  agent: Schema.String.annotate({
    description: "The agent to run the task",
  }),
  description: Schema.String.annotate({
    description: `Label for this specific Run${LABEL_BOUND_CLAUSE}`,
  }),
  prompt: Schema.String.annotate({ description: "The full task brief" }),
});

export const ResumeInputSchema = Schema.Struct({
  id: SubagentId.annotate({
    description: "A stable Subagent id returned by agent_start",
  }),
  description: Schema.String.annotate({
    description: `Label for this new Run${LABEL_BOUND_CLAUSE}`,
  }),
  prompt: Schema.String.annotate({
    description: "The full next task brief",
  }),
});

export const SteerInputSchema = Schema.Struct({
  id: RUN_ID,
  message: Schema.String.annotate({
    description:
      "Guidance for the active Run; admitted text is preserved exactly",
  }),
});

export const CancelInputSchema = Schema.Struct({
  ids: Schema.Array(RunId).annotate({
    description: "Run ids returned by agent_start or agent_resume",
  }),
});

export const WaitInputSchema = Schema.Struct({
  ids: Schema.Array(RunId).annotate({
    description: "Run ids returned by agent_start or agent_resume",
  }),
  /**
   * `Schema.Finite`, and positive.
   *
   * A zero or negative timeout would mean "give up before starting", which is
   * not a wait, and an infinite one would mean "never give up", which the
   * absent field already says.
   */
  timeoutSeconds: Schema.optionalKey(
    Schema.Finite.check(Schema.isGreaterThan(0)).annotate({
      description:
        "Give up waiting after this long. Prefer a value that comfortably " +
        "exceeds the delegated work; the Runs keep going after a timeout and " +
        "notify on their own.",
    }),
  ),
});

export const ResultInputSchema = Schema.Struct({
  id: RUN_ID,
});

/**
 * How long a decode failure's text may be.
 *
 * A decode failure names the field and the rule it broke and carries no part
 * of the value — the M2 spike's gating question was exactly that, and the
 * answer was that Effect Schema's messages are value-free. The bound is
 * belt-and-braces: a deeply nested input could still produce a long path, and
 * a tool outcome the model reads is not the place for one.
 */
export const DECODE_FAILURE_MAX_CHARACTERS = 500;

/**
 * The one decode every `execute` runs, and what it says when it fails.
 *
 * `EXACT_KEYS` is the domain's own decode option: an unlisted key at any depth
 * is a rejection rather than a silent strip. It is the same rule the backend
 * seam decodes observations under, and for the same reason — a value that
 * happens to contain the right fields is not the right value.
 */
export function decodeToolInput<A>(
  tool: string,
  schema: Schema.ConstraintDecoder<A>,
): (input: unknown) => DecodedToolInput<A> {
  const decode = Schema.decodeUnknownResult(schema, EXACT_KEYS);
  return (input: unknown) => {
    const decoded = decode(input);
    if (Result.isSuccess(decoded)) {
      return { decoded: true, value: decoded.success };
    }
    const detail = (decoded.failure.message ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, DECODE_FAILURE_MAX_CHARACTERS);
    return { decoded: false, text: formatToolInputRejected(tool, detail) };
  };
}

export type DecodedToolInput<A> =
  | { readonly decoded: true; readonly value: A }
  | { readonly decoded: false; readonly text: string };
