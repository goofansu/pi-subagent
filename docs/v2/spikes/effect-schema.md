# Effect Schema spike (M2)

**Status:** Complete. **Verdict: adopt.**
**Date:** 2026-09-02
**Library under test:** `effect` 4.0.0-rc.112 — the version pinned by
`extensions/subagent-v2/effect-version.ts` — through the `Schema`,
`SchemaRepresentation`, and `JsonSchema` bindings that ship from the package
root.
**Spike code:** `.scratch/v2-m2-supervisor-runtime/spikes/`, entry point
`run-all.ts`. Disposable, imported by neither extension tree, excluded from
lint (`biome.json` ignores `.scratch`) and from every test glob (no name in it
matches a `node --test` pattern).

## What this spike asks

[ADR-0029](../../adr/0029-v2-effect-schema.md) accepts Effect Schema for v2 and
gates the adoption on three questions. Each is answered below with the exact
API used, what was observed, and a verdict. Question 2 is the gate: if a decode
failure's text carried the offending value, a malformed provider payload could
ride into a bounded diagnostic and cross the very boundary
[ADR-0024](../../adr/0024-v2-observation-ordering.md) exists to hold, and the
adoption would stop there.

## How to rerun

```bash
node --import tsx .scratch/v2-m2-supervisor-runtime/spikes/run-all.ts
```

No credentials, no provider quota, no network. Every section prints what it
observed.

---

## Question 1 — does the observation union express as a tagged union with excess properties rejected?

**API used.** `Schema.Union([...])` over `Schema.Struct` members discriminated
by `Schema.Literal("message")` and friends; `Schema.Literals([...])` for closed
string sets; `Schema.optionalKey` for optional fields;
`Schema.decodeUnknownResult(schema, { onExcessProperty: "error" })` for the
runtime-free decode path.

**Observed.** Excess-property rejection is a decode *option*, not a property of
the schema, and it applies at every depth. With `onExcessProperty: "error"`:

| Input | Result |
| --- | --- |
| `{ kind: "message", role: "user", parts: [{ kind: "text", text: "hi" }] }` | decoded |
| `{ kind: "message", role: "user", parts: [], threadId: "t-1" }` | `Expected no excess property at ["threadId"]` |
| `{ kind: "message", role: "user", parts: [{ kind: "text", text: "hi", spanId: "s-1" }] }` | `Expected no excess property at ["parts"][0]["spanId"]` |
| `{ kind: "usage", usage: { input: 1, requestId: "r-1" } }` | `Expected no excess property at ["usage"]["requestId"]` |
| `{ kind: "telemetry", value: 1 }` | `Expected { readonly "kind": "message", ... } \| ...` |
| `{ kind: "message", role: "system", parts: [] }` | `Expected "user" \| "assistant" at ["role"]` |

The third and fourth rows are the ones that matter. M1 needed a *separate*
runtime key walker (`testing/observation-vocabulary.ts`) precisely because a
`keyof` test cannot see a key nested inside `parts` or inside `usage`. The
decoder sees both.

**Verdict: yes.** The exact-key-set rule becomes a property of the declaration
plus one decode option. Both M1 mechanisms — the compile-time key-set table and
the runtime key walker — are covered, so both can go.

## Question 1b — follow-ups that decide how the declarations are written

Not part of ADR-0029's three questions, but answered here because the answers
change what the M2 declarations look like.

**Branded identifiers.** `Schema.String.check(...).pipe(Schema.brand("RunId"))`
produces a schema whose `Type` is mutually unassignable with a sibling brand
and with a bare `string`. Three `@ts-expect-error` directives in the spike
confirm it, and `tsc` reports no unused directive. `RunId.make(value)` validates
and brands in one call; `Schema.decodeUnknownResult(RunId)` does the same from
`unknown`. The checks compose: `Schema.isLengthBetween(1, 128)` and
`Schema.isPattern(/^[A-Za-z0-9._:-]+$/)` reproduce M1's identifier rules
exactly.

This is the row of ADR-0029's table that deletes the most code: the phantom
`unique symbol`, four constructors, and four guards whose identical bodies
answered "could this be an id" rather than "is this a `RunId`".

**A required key whose type includes `undefined`.** `Schema.UndefinedOr` on a
*required* key keeps the key present after decoding and rejects a missing one
with `Missing key at ["activity"]`. That is exactly what
`ActivityObservation.activity` means — `undefined` clears the activity, an
absent key is malformed — so the domain type needs no change to be expressible.

## Question 2 — is a decode failure's text free of the offending value?

**API used.** `Schema.decodeUnknownResult(schema, options)` returning a
`Result`, whose `failure.message` is the formatted issue. Both
`errors: "first"` (the default) and `errors: "all"` were exercised.

**Observed.** A 46-character stand-in secret
(`sk-live-51H8xQq2eZvKYlo8AbCdEfGhIjKlMnOpQrStUvWxYz`) was planted in seven
positions. It appeared in **no** message under either error mode. Every message
is built from two things and nothing else: what the *schema* expected, and the
key path at which the expectation failed.

The concrete example the ticket asks for — a nested malformed observation:

```text
input:   { kind: "message", role: "user",
           parts: [{ kind: "text", text: { token: "sk-live-51H8x…WxYz" } }] }
message: Expected string
           at ["parts"][0]["text"]
```

Messages stay short. The longest observed was 111 bytes, from
`errors: "all"` reporting two failed refinements on one number:

```text
Expected an integer
  at ["usage"]["input"]
Expected a value greater than or equal to 0
  at ["usage"]["input"]
```

A whole provider wire object, a `null`, and a 5000-character string in the tag
position all produce the same 80-byte union expectation, because the union
discriminant failed before any member was entered.

**One thing does cross, and it is a key name rather than a value.** An excess
property is reported by name: `Expected no excess property at
["parts"][0]["session_id"]`. The name is provider-authored, so a diagnostic
built from it carries a provider *field name* — never its content. That is
acceptable and is the same class of information ADR-0024 already lets across in
the observation vocabulary itself, but it is recorded rather than glossed: a
backend that named a field after a secret would leak the name of the secret.
The existing `DIAGNOSTIC_MESSAGE_MAX_BYTES` bound and `boundOneLine` collapse
apply to the formatted issue like any other text, so an adversarially long key
cannot grow the diagnostic.

**Verdict: yes, the gate clears.** A formatted schema issue is fit for a
bounded diagnostic of category `backend-failure`. No part of the input value
appears in it.

## Question 3 — can JSON Schema output be produced that the Pi host accepts?

**API used.** `Schema.toJsonSchemaDocument(schema)`, which returns
`{ schema, definitions }` in Draft 2020-12. The host side was exercised through
`validateToolArguments` from `@earendil-works/pi-ai` — the function Pi actually
runs over every model tool call — reached through its built file, and through
`typebox`'s own `Compile` and `Value.Check`.

**Observed.** The emitted document for `agent_start`'s parameters:

```json
{
  "type": "object",
  "properties": {
    "agent": { "type": "string", "description": "The agent to run the task" },
    "description": { "type": "string", "description": "Label for this run" },
    "prompt": { "type": "string", "description": "The full task brief" }
  },
  "required": ["agent", "description", "prompt"],
  "additionalProperties": false
}
```

Three findings, in the order they matter.

**The host has an explicit path for a schema that is not TypeBox.**
`ToolDefinition.parameters` is typed `TSchema`, which in `typebox` 1.x is the
empty interface `{}` — any object satisfies it. At runtime,
`validateToolArguments` branches on
`Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND)` and falls
back to `coerceWithJsonSchema` when the symbol is absent, which is exactly the
case for an Effect-emitted document. `typebox`'s `Compile()` and `Value.Check`
both accept the emitted document directly, and a wrong-typed argument is
rejected with a usable message. Running the real `validateToolArguments` over
both a TypeBox schema and an Effect-emitted one gave the same answers for a
valid and an invalid call.

**`Schema.Number` must be `Schema.Finite` for a tool parameter.** The encoded
form of `Schema.Number` admits the strings `"Infinity"`, `"-Infinity"`, and
`"NaN"`, so it emits an `anyOf` of a number and a three-member string enum —
noise in a model-facing schema, and it swallows any `description` and any
numeric refinement. `Schema.Finite` emits a plain `{ "type": "number" }`, and
`Schema.Finite.check(Schema.isGreaterThan(0)).annotate({ description })` emits
`{ "type": "number", "exclusiveMinimum": 0, "description": "…" }`. The same
holds under `Schema.optionalKey`.

**`additionalProperties: false` is emitted and is stricter than v1.**
`Type.Object` in v1 permits unlisted keys; the emitted document rejects them,
and `validateToolArguments` therefore rejects a call carrying an excess
argument that v1 accepted. The document is a plain object, so relaxing it is a
spread: `{ ...document.schema, additionalProperties: true }`. Annotating the
schema with `jsonSchema` did **not** override it. M3 decides which behaviour it
wants; the spike records that both are one line apart.

**Verdict: yes.** `typebox` can go from the tool-parameter call site at M3,
subject to the two shape notes above. Nothing about the host boundary blocks it.

---

## Adoption verdict

**Adopt.** All three questions clear, and the gating question — question 2 —
clears without qualification: no part of an input value reaches a decode
failure's text.

What M2 takes from this spike:

- Declare the observation union as `Schema.Union` over tagged `Schema.Struct`
  members and decode with `onExcessProperty: "error"`. Delete both the
  compile-time key-set table and the runtime key walker.
- Declare identifiers with `Schema.brand` over a checked `Schema.String`.
  Delete the phantom brand, its four constructors, and its four guards.
- Build the seam's `backend-failure` diagnostic from `failure.message`, which
  is already short and already value-free, through the existing bounding.
- Use `Schema.Finite`, never `Schema.Number`, wherever a number is a count, a
  cost, or a duration.

What M3 takes from it:

- `Schema.toJsonSchemaDocument` for tool parameters, with `Schema.Finite` and a
  deliberate decision about `additionalProperties`.
