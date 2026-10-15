import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  cancelledEnding,
  failedEnding,
  NOTIFICATION_INLINE_MAX_BYTES,
} from "../domain/index.ts";
import {
  formatNotificationText,
  type RenderableTheme,
} from "../presentation/index.ts";
import {
  fixtureNotification,
  fixtureUsage,
} from "../testing/presentation-fixtures.ts";
import {
  buildNotificationMessage,
  NOTIFICATION_MESSAGE_TYPE,
  parseNotificationMessage,
  renderNotificationMessage,
} from "./notification-message.ts";

initTheme(undefined, false);

const theme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  inverse: (text) => text,
};

/** Render wide, so a summary line is one line rather than a wrapped one. */
const WIDE = 200;

function lines(
  component: { render(width: number): string[] } | undefined,
  width = WIDE,
) {
  if (!component) return undefined;
  return component
    .render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd());
}

/** A landed host message, shaped the way `message_start` hands one over. */
function landed(message: ReturnType<typeof buildNotificationMessage>) {
  return {
    role: "custom",
    customType: message.customType,
    content: message.content,
    details: message.details,
    // Host bookkeeping the extension never put there, which must not make the
    // message unrecognizable.
    id: "entry-1",
    timestamp: 1_700_000_000,
  };
}

// -- Build and parse ---------------------------------------------------------

test("build then parse round-trips every terminal status", () => {
  const cases = [
    {
      notice: fixtureNotification({ finalOutput: "done" }),
      facts: { finalOutput: { kind: "retained", text: "done" } },
    },
    {
      notice: fixtureNotification({ ending: failedEnding("boom") }),
      facts: {
        finalOutput: { kind: "absent", hasTranscriptEvidence: false },
        failure: "boom",
      },
    },
    {
      notice: fixtureNotification({ ending: cancelledEnding("requested") }),
      facts: {
        finalOutput: { kind: "absent", hasTranscriptEvidence: false },
        cancellationReason: "requested",
      },
    },
  ] as const;
  for (const { notice, facts } of cases) {
    const message = buildNotificationMessage(notice);
    assert.equal(message.customType, NOTIFICATION_MESSAGE_TYPE);
    assert.equal(message.display, true);
    assert.equal(message.content, formatNotificationText(notice));
    assert.deepEqual(parseNotificationMessage(landed(message)), {
      runId: notice.runId,
      subagentId: notice.subagentId,
      agent: notice.agent,
      label: notice.label,
      status: notice.status,
      durationMillis: notice.durationMillis,
      ...facts,
    });
  }
});

test("the details carry the collapsed line, the ids, and the answer as a fact; never the prose", () => {
  // A Run that spent nothing: usage and model are covered separately below.
  const message = buildNotificationMessage(
    fixtureNotification({ finalOutput: "the whole answer" }),
  );

  assert.deepEqual(Object.keys(message.details).sort(), [
    "agent",
    "durationMillis",
    "finalOutput",
    "label",
    "runId",
    "status",
    "subagentId",
  ]);
  // The answer is there as a value, not as the sentence around it: a reader
  // that wants only the answer never sees the fence or the pointer.
  const serialized = JSON.stringify(message.details);
  assert.match(serialized, /the whole answer/);
  assert.doesNotMatch(serialized, /Output from the subagent|agent_result/);
});

test("the details carry the Run's usage and model for external readers, cost unrounded", () => {
  const notice = fixtureNotification({
    finalOutput: "done",
    usage: fixtureUsage({
      input: 12_300,
      output: 4_500,
      cacheRead: 40_000,
      cacheWrite: 1_200,
      cost: 0.123456789,
      turns: 3,
      context: { tokens: 90_000 },
    }),
    model: "anthropic/claude-sonnet-4-6",
  });
  const message = buildNotificationMessage(notice);

  // Pi core's names and nothing else: no turns, no gauge, no total.
  assert.deepEqual(message.details.usage, {
    input: 12_300,
    output: 4_500,
    cacheRead: 40_000,
    cacheWrite: 1_200,
    cost: 0.123456789,
  });
  assert.equal(message.details.model, "anthropic/claude-sonnet-4-6");
  assert.deepEqual(parseNotificationMessage(landed(message)), message.details);
  // The text still rounds, and is the only place that does.
  assert.match(message.content, /cost \$0\.1235 · /);
});

test("the details carry the retained answer as a fact, the same text the content fences", () => {
  const message = buildNotificationMessage(
    fixtureNotification({ finalOutput: "# Findings\n\nTwo **bold** points." }),
  );

  assert.deepEqual(message.details.finalOutput, {
    kind: "retained",
    text: "# Findings\n\nTwo **bold** points.",
  });
  assert.match(
    message.content,
    /Output from the subagent:\n"""\n# Findings\n\nTwo \*\*bold\*\* points\.\n"""/,
  );
  assert.deepEqual(parseNotificationMessage(landed(message)), message.details);
});

test("a long answer's details carry the bounded preview and name it as one", () => {
  const long = `${"x".repeat(NOTIFICATION_INLINE_MAX_BYTES)}y`;
  const message = buildNotificationMessage(
    fixtureNotification({ finalOutput: long }),
  );

  const facts = message.details.finalOutput;
  assert.equal(facts?.kind, "retained");
  assert.equal(facts !== undefined && "text" in facts, false);
  const preview =
    facts !== undefined && "preview" in facts ? facts.preview : "";
  assert.notEqual(preview, "");
  assert.notEqual(preview, long);
  // The same preview the content quotes.
  assert.match(
    message.content,
    new RegExp(
      `Preview from the subagent:\\n"${preview.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
    ),
  );
  assert.deepEqual(parseNotificationMessage(landed(message)), message.details);
});

test("every retention kind and both reasons reach the details for a failed and a cancelled Run", () => {
  const prefix = buildNotificationMessage(
    fixtureNotification({
      ending: failedEnding("boom"),
      finalOutput: "visible prefix",
      truncation: { truncatedOutputBytes: 7 },
    }),
  );
  assert.deepEqual(prefix.details.finalOutput, {
    kind: "retained-prefix",
    removedBytes: 7,
    text: "visible prefix",
  });
  assert.equal(prefix.details.failure, "boom");
  assert.match(
    prefix.content,
    /Reason: boom\n\nOutput produced before failure:\n"""\nvisible prefix\n"""/,
  );

  const removed = buildNotificationMessage(
    fixtureNotification({
      ending: cancelledEnding("timeout"),
      truncation: { truncatedOutputBytes: 23 },
      transcript: [
        {
          role: "assistant",
          parts: [{ kind: "text", text: "evidence" }],
        },
      ],
    }),
  );
  assert.deepEqual(removed.details.finalOutput, {
    kind: "removed",
    removedBytes: 23,
    hasTranscriptEvidence: true,
  });
  assert.equal(removed.details.cancellationReason, "timeout");
  assert.equal("failure" in removed.details, false);
  for (const message of [prefix, removed]) {
    assert.deepEqual(
      parseNotificationMessage(landed(message)),
      message.details,
    );
  }
});

test("a failed Run that reported no reason has no failure fact", () => {
  const message = buildNotificationMessage(
    fixtureNotification({ ending: failedEnding("") }),
  );

  assert.equal("failure" in message.details, false);
  assert.match(message.content, /Reason: none reported\./);
});

test("a Run that spent nothing has no usage or model in its details", () => {
  const message = buildNotificationMessage(
    fixtureNotification({
      finalOutput: "done",
      usage: fixtureUsage({ cacheRead: 40_000 }),
      model: "a-model",
    }),
  );

  assert.equal("usage" in message.details, false);
  assert.equal("model" in message.details, false);
});

test("a message missing a field the collapsed line needs is rejected", () => {
  const message = buildNotificationMessage(fixtureNotification({}));

  for (const field of ["label", "durationMillis"] as const) {
    const { [field]: _dropped, ...rest } = message.details;
    assert.equal(
      parseNotificationMessage({ ...landed(message), details: rest }),
      undefined,
      `accepted details without ${field}`,
    );
  }
});

test("a message of another custom type parses to nothing", () => {
  const message = buildNotificationMessage(fixtureNotification({}));

  assert.equal(
    parseNotificationMessage({
      ...landed(message),
      customType: "someone-elses-message",
    }),
    undefined,
  );
});

test("a message claiming the type under another role parses to nothing", () => {
  const message = buildNotificationMessage(fixtureNotification({}));

  assert.equal(
    parseNotificationMessage({ ...landed(message), role: "assistant" }),
    undefined,
  );
});

test("malformed details parse to nothing rather than to a partial notice", () => {
  const message = buildNotificationMessage(fixtureNotification({}));

  for (const details of [
    undefined,
    {},
    { runId: "run-1" },
    { ...message.details, status: "running" },
    { ...message.details, runId: "not a run id" },
  ]) {
    assert.equal(
      parseNotificationMessage({ ...landed(message), details }),
      undefined,
      `accepted ${JSON.stringify(details)}`,
    );
  }
});

test("anything that is not a message parses to nothing", () => {
  for (const value of [undefined, null, 7, "text", []]) {
    assert.equal(parseNotificationMessage(value), undefined);
  }
});

// -- The renderer ------------------------------------------------------------

test("a collapsed notice is one summary line", () => {
  const notice = fixtureNotification({
    finalOutput: "done",
    usage: fixtureUsage({ turns: 1 }),
  });
  const message = buildNotificationMessage(notice);

  const rendered = (
    lines(renderNotificationMessage(message, { expanded: false }, theme)) ?? []
  ).filter((line) => line.trim() !== "");

  // One line of content inside Pi's own custom-message frame, which supplies
  // the padding around it.
  assert.deepEqual(rendered.length, 1);
  assert.match(rendered[0], /explore · look around · completed in 12\.4s /);
});

test("an expanded notice shows the bounded text below the summary", () => {
  const message = buildNotificationMessage(
    fixtureNotification({ finalOutput: "the answer" }),
  );

  const rendered = lines(
    renderNotificationMessage(message, { expanded: true }, theme),
  );

  assert.ok((rendered?.length ?? 0) > 1);
  assert.match(rendered?.join("\n") ?? "", /the answer/);
  // A short output travels whole, so the pointer is a note rather than a
  // fetch instruction.
  assert.match(
    rendered?.join("\n") ?? "",
    /nothing further to fetch\. agent_result with \{"id":"run-1"\} re-reads it/,
  );
});

test("the collapsed line is fitted to the width the terminal actually gave", () => {
  // The defect this guards was visible in a live Session: the line was
  // formatted before `render`, so it was fitted to a constant, and a label was
  // cut on a 94-column pane with fourteen columns to spare. `Component.render`
  // is handed the live width and `Box` passes on what its padding leaves, so
  // the same message renders differently at two widths — and a wide terminal
  // shows a label a narrow one has to cut.
  const message = buildNotificationMessage(
    fixtureNotification({
      finalOutput: "done",
      identity: { agent: "standards-reviewer" },
    }),
  );
  const component = renderNotificationMessage(
    message,
    { expanded: false, outputPad: 1 },
    theme,
  );
  const at = (width: number) =>
    stripVTControlCharacters(component?.render(width).join("\n") ?? "");

  assert.match(
    at(120),
    /standards-reviewer · look around · completed in 12\.4s/,
  );
  // Narrow enough that the label cannot survive whole, so the two readings
  // differ — which is the proof the width reached the formatter at all.
  assert.doesNotMatch(at(56), /look around/);
  assert.match(at(56), /completed in 12\.4s/);
});

test("S-1: the ids are in the expanded text, where a tool call needs them", () => {
  const message = buildNotificationMessage(
    fixtureNotification({ finalOutput: "done" }),
  );

  const collapsed = (
    lines(renderNotificationMessage(message, { expanded: false }, theme)) ?? []
  ).join("\n");
  const expanded = (
    lines(renderNotificationMessage(message, { expanded: true }, theme)) ?? []
  ).join("\n");

  assert.doesNotMatch(collapsed, /run-1|subagent-1/);
  assert.match(expanded, /Run: run-1/);
  assert.match(expanded, /Subagent: subagent-1/);
});

test("a message this extension did not shape is left to the host", () => {
  assert.equal(
    renderNotificationMessage(
      { content: "text", details: { whatever: true } },
      { expanded: false },
      theme,
    ),
    undefined,
  );
});

test("a failed notice renders the error and a cancelled one renders no error, and neither renders a long output", () => {
  // Past the inline bound the partial output stays behind `agent_result`,
  // which is the case in which the notice must not carry it.
  const long = `half an answer ${"h".repeat(NOTIFICATION_INLINE_MAX_BYTES)}`;
  const failed = buildNotificationMessage(
    fixtureNotification({
      ending: failedEnding("the backend refused"),
      finalOutput: long,
    }),
  );
  const cancelled = buildNotificationMessage(
    fixtureNotification({
      ending: cancelledEnding("requested"),
      finalOutput: long,
    }),
  );

  const failedText =
    lines(renderNotificationMessage(failed, { expanded: true }, theme))?.join(
      "\n",
    ) ?? "";
  const cancelledText =
    lines(
      renderNotificationMessage(cancelled, { expanded: true }, theme),
    )?.join("\n") ?? "";

  assert.match(failedText, /the backend refused/);
  assert.doesNotMatch(failedText, /half an answer/);
  assert.match(cancelledText, /was cancelled in 12\.4s \(requested\)/);
  assert.doesNotMatch(cancelledText, /half an answer/);
});
