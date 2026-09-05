import assert from "node:assert/strict";
import { test } from "node:test";
import { byteLength } from "./bounding.ts";
import {
  DIAGNOSTIC_CATEGORIES,
  DIAGNOSTIC_MESSAGE_MAX_BYTES,
  DIAGNOSTIC_REDACTED,
  isDiagnosticCategory,
  redactedDiagnostic,
  runDiagnostic,
} from "./diagnostics.ts";
import {
  isResultLinkKind,
  RESULT_LINK_KINDS,
  RESULT_LINK_LABEL_MAX_BYTES,
  RESULT_LINK_TARGET_MAX_BYTES,
  resultLink,
} from "./links.ts";

test("the diagnostic categories are the ten the domain admits", () => {
  assert.deepEqual(
    [...DIAGNOSTIC_CATEGORIES],
    [
      "backend-failure",
      "transport-loss",
      "cleanup-escalation",
      "queue-overflow",
      "reconciliation-difference",
      "late-event",
      "delivery-failure",
      "profile",
      "control",
      "other",
    ],
  );
});

test("a diagnostic outside the category set is rejected", () => {
  for (const category of DIAGNOSTIC_CATEGORIES) {
    assert.equal(isDiagnosticCategory(category), true);
  }
  assert.equal(isDiagnosticCategory("provider-said-no"), false);
  assert.throws(() =>
    runDiagnostic(
      "provider-said-no" as (typeof DIAGNOSTIC_CATEGORIES)[number],
      "no",
    ),
  );
});

test("a diagnostic message is bounded at construction, not by its reader", () => {
  const long = "x".repeat(DIAGNOSTIC_MESSAGE_MAX_BYTES + 500);

  const diagnostic = runDiagnostic("backend-failure", long);

  assert.equal(byteLength(diagnostic.message), DIAGNOSTIC_MESSAGE_MAX_BYTES);
});

test("a diagnostic message is one line, whatever it was given", () => {
  assert.equal(
    runDiagnostic("transport-loss", "  first\nsecond\r\nthird  ").message,
    "first second third",
  );
});

test("a redacted diagnostic keeps the category and drops the provider text", () => {
  assert.deepEqual(redactedDiagnostic("backend-failure"), {
    category: "backend-failure",
    message: DIAGNOSTIC_REDACTED,
  });
});

test("the result link kinds are the four the domain admits", () => {
  assert.deepEqual(
    [...RESULT_LINK_KINDS],
    ["native-session", "log", "url", "file"],
  );
  for (const kind of RESULT_LINK_KINDS) {
    assert.equal(isResultLinkKind(kind), true);
  }
  assert.equal(isResultLinkKind("provider-object"), false);
});

test("a link outside the kind set is rejected", () => {
  assert.throws(() =>
    resultLink(
      "provider-object" as (typeof RESULT_LINK_KINDS)[number],
      "label",
      "target",
    ),
  );
});

test("a link's label and target are each bounded and trimmed", () => {
  const link = resultLink(
    "url",
    `  ${"l".repeat(RESULT_LINK_LABEL_MAX_BYTES + 10)}\nmore  `,
    `  ${"t".repeat(RESULT_LINK_TARGET_MAX_BYTES + 10)}  `,
  );

  assert.equal(byteLength(link.label), RESULT_LINK_LABEL_MAX_BYTES);
  assert.equal(byteLength(link.target), RESULT_LINK_TARGET_MAX_BYTES);
  assert.equal(link.kind, "url");
});

test("a short link is left exactly as it was given", () => {
  assert.deepEqual(resultLink("file", "log file", "/tmp/run.log"), {
    kind: "file",
    label: "log file",
    target: "/tmp/run.log",
  });
});
