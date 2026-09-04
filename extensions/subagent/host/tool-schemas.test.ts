import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { IDENTIFIER_MAX_LENGTH, RUN_LABEL_MAX_BYTES } from "../domain/index.ts";
import {
  CancelInputSchema,
  DECODE_FAILURE_MAX_CHARACTERS,
  decodeToolInput,
  ResultInputSchema,
  ResumeInputSchema,
  StartInputSchema,
  SteerInputSchema,
  toolParameters,
  WaitInputSchema,
} from "./tool-schemas.ts";

/**
 * The tool parameter documents, and what they reject.
 *
 * Two checks that look like one. The **emitted document** is what Pi shows the
 * model and validates a call against, so it is asserted against Pi's own
 * `validateToolArguments` rather than against a hand-written expectation of
 * what Pi accepts. The **decode** is what the handler actually trusts, because
 * Pi falls back to JSON-Schema coercion for a document it did not get from its
 * own schema library — so a wrong-typed argument may arrive coerced.
 */

const SCHEMAS = [
  ["agent_start", StartInputSchema],
  ["agent_resume", ResumeInputSchema],
  ["agent_wait", WaitInputSchema],
  ["agent_result", ResultInputSchema],
  ["agent_cancel", CancelInputSchema],
  ["agent_steer", SteerInputSchema],
] as const;

/** Run Pi's own tool-argument validation over an emitted document. */
function piAccepts(
  name: string,
  schema: (typeof SCHEMAS)[number][1],
  args: unknown,
): { readonly accepted: boolean; readonly message: string } {
  const tool = { name, parameters: toolParameters(schema) } as never;
  try {
    validateToolArguments(tool, { name, arguments: args } as never);
    return { accepted: true, message: "" };
  } catch (error) {
    return { accepted: false, message: (error as Error).message };
  }
}

test("every tool's parameters are a JSON Schema object document with no unlisted keys", () => {
  for (const [name, schema] of SCHEMAS) {
    const document = toolParameters(schema);
    assert.equal(document.type, "object", `${name} is not an object schema`);
    assert.ok(document.properties, `${name} declares no properties`);
    // Stricter than v1's, and deliberately: an argument a tool does not
    // understand is far more likely to be a mistake than a courtesy.
    assert.equal(
      document.additionalProperties,
      false,
      `${name} permits unlisted keys`,
    );
  }
});

test("the wait timeout is emitted as a plain positive number, not a union with strings", () => {
  const document = toolParameters(WaitInputSchema) as {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };

  // `Schema.Number` would emit an `anyOf` of a number and the three strings
  // its encoded form admits, swallowing the description with it.
  assert.deepEqual(Object.keys(document.properties.timeoutSeconds).sort(), [
    "description",
    "exclusiveMinimum",
    "type",
  ]);
  assert.equal(document.properties.timeoutSeconds.type, "number");
  assert.equal(document.properties.timeoutSeconds.exclusiveMinimum, 0);
  assert.deepEqual(document.required, ["ids"]);
});

test("an id field is emitted with the identifier pattern and its length bound", () => {
  const document = toolParameters(ResultInputSchema) as {
    properties: { id: { pattern?: string; allOf?: Record<string, number>[] } };
  };

  assert.equal(document.properties.id.pattern, "^[A-Za-z0-9._:-]+$");
  assert.deepEqual(document.properties.id.allOf, [
    { minLength: 1 },
    { maxLength: IDENTIFIER_MAX_LENGTH },
  ]);
});

test("every field a model fills in carries a description", () => {
  for (const [name, schema] of SCHEMAS) {
    const document = toolParameters(schema) as {
      properties: Record<string, { description?: string }>;
    };
    for (const [field, property] of Object.entries(document.properties)) {
      assert.ok(
        (property.description ?? "").length > 0,
        `${name}.${field} has no description`,
      );
    }
  }
});

test("T1: the label's bound is stated on both description fields", () => {
  // A model that reads the schema should not have to discover the bound by
  // exceeding it, and should not conclude a long label is a rejected call.
  for (const schema of [StartInputSchema, ResumeInputSchema]) {
    const document = toolParameters(schema) as {
      properties: { description: { description?: string } };
    };
    assert.match(
      document.properties.description.description ?? "",
      new RegExp(
        `^Label for this (specific|new) Run; one line, at most ${RUN_LABEL_MAX_BYTES} bytes, shortened if longer, and never empty — an empty description is refused$`,
      ),
    );
  }
});

test("T1: both description fields say the field is never empty", () => {
  // The other half of the bound. An empty description is refused rather than
  // shortened, so the schema says so instead of letting a model discover it by
  // being refused — which is the same reason the byte bound is stated.
  for (const schema of [StartInputSchema, ResumeInputSchema]) {
    const document = toolParameters(schema) as {
      properties: { description: { description?: string } };
    };
    assert.match(
      document.properties.description.description ?? "",
      /, and never empty — an empty description is refused$/,
    );
  }
});

test("Pi's own tool-argument validation accepts a well-formed call for each tool", () => {
  const calls: readonly [string, (typeof SCHEMAS)[number][1], unknown][] = [
    [
      "agent_start",
      StartInputSchema,
      { agent: "explore", description: "d", prompt: "p" },
    ],
    [
      "agent_resume",
      ResumeInputSchema,
      { id: "subagent-1", description: "d", prompt: "p" },
    ],
    ["agent_wait", WaitInputSchema, { ids: ["run-1"], timeoutSeconds: 30 }],
    ["agent_result", ResultInputSchema, { id: "run-1" }],
    ["agent_cancel", CancelInputSchema, { ids: ["run-1", "run-2"] }],
    ["agent_steer", SteerInputSchema, { id: "run-1", message: "go left" }],
  ];

  for (const [name, schema, args] of calls) {
    const outcome = piAccepts(name, schema, args);
    assert.ok(
      outcome.accepted,
      `${name} rejected a valid call: ${outcome.message}`,
    );
  }
});

test("Pi's own validation rejects an excess argument and a malformed id", () => {
  assert.equal(
    piAccepts("agent_result", ResultInputSchema, { id: "run-1", extra: 1 })
      .accepted,
    false,
  );
  assert.equal(
    piAccepts("agent_result", ResultInputSchema, { id: "run 1" }).accepted,
    false,
  );
});

// ── The decode, which is what the handler trusts ─────────────────────────────

test("a decode failure names the field, calls nothing, and carries no value", () => {
  const decode = decodeToolInput("agent_start", StartInputSchema);

  const wrongType = decode({
    agent: 7,
    description: "d",
    prompt: "the secret is hunter2",
  });
  assert.equal(wrongType.decoded, false);
  assert.ok(!wrongType.decoded);
  assert.match(wrongType.text, /Cannot run agent_start/);
  assert.match(wrongType.text, /agent/);
  assert.match(wrongType.text, /Nothing was started/);
  assert.doesNotMatch(wrongType.text, /hunter2/);
});

test("a missing field, a wrong type, and an excess field each read as a rejection", () => {
  const decode = decodeToolInput("agent_start", StartInputSchema);

  for (const input of [
    { description: "d", prompt: "p" },
    { agent: "explore", description: 7, prompt: "p" },
    { agent: "explore", description: "d", prompt: "p", extra: true },
    "not an object",
    null,
  ]) {
    const outcome = decode(input);
    assert.equal(outcome.decoded, false, `accepted ${JSON.stringify(input)}`);
  }
});

test("an excess key is rejected rather than stripped, at any depth", () => {
  const decode = decodeToolInput("agent_wait", WaitInputSchema);

  assert.equal(decode({ ids: ["run-1"], zzz: 1 }).decoded, false);
  assert.equal(decode({ ids: ["run-1"] }).decoded, true);
});

test("a coerced argument that Pi would have let through is rejected at the decode", () => {
  // Pi's fallback coercion turns a number into a string for a string field, so
  // the host cannot rely on it to reject malformed input. This is the check.
  const decode = decodeToolInput("agent_steer", SteerInputSchema);

  assert.equal(
    piAccepts("agent_steer", SteerInputSchema, { id: "run-1", message: 7 })
      .accepted,
    true,
  );
  assert.equal(decode({ id: "run-1", message: 7 }).decoded, false);
});

test("a decode failure's text is bounded", () => {
  const decode = decodeToolInput("agent_cancel", CancelInputSchema);
  const outcome = decode({
    ids: Array.from({ length: 500 }, () => "not a valid id at all"),
  });

  assert.ok(!outcome.decoded);
  assert.ok(
    outcome.text.length < DECODE_FAILURE_MAX_CHARACTERS + 200,
    `the rejection was ${outcome.text.length} characters`,
  );
});

test("a valid decode returns the value the façade takes", () => {
  const decode = decodeToolInput("agent_wait", WaitInputSchema);
  const outcome = decode({ ids: ["run-1", "run-2"], timeoutSeconds: 12.5 });

  assert.ok(outcome.decoded);
  assert.deepEqual(outcome.value, {
    ids: ["run-1", "run-2"],
    timeoutSeconds: 12.5,
  });
});
