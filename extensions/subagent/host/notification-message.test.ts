import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { cancelledEnding, failedEnding } from "../domain/index.ts";
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
  for (const notice of [
    fixtureNotification({ finalOutput: "done" }),
    fixtureNotification({ ending: failedEnding("boom") }),
    fixtureNotification({ ending: cancelledEnding("requested") }),
  ]) {
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
    });
  }
});

test("the details carry the collapsed line and the ids, never the text", () => {
  const message = buildNotificationMessage(
    fixtureNotification({ finalOutput: "the whole answer" }),
  );

  assert.deepEqual(Object.keys(message.details).sort(), [
    "agent",
    "durationMillis",
    "label",
    "runId",
    "status",
    "subagentId",
  ]);
  assert.doesNotMatch(JSON.stringify(message.details), /the whole answer/);
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
  assert.match(
    rendered?.join("\n") ?? "",
    /The result is available\. Call agent_result with \{"id":"run-1"\}\./,
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

test("a failed notice renders the error and a cancelled one renders neither output nor error", () => {
  const failed = buildNotificationMessage(
    fixtureNotification({
      ending: failedEnding("the backend refused"),
      finalOutput: "half an answer",
    }),
  );
  const cancelled = buildNotificationMessage(
    fixtureNotification({
      ending: cancelledEnding("requested"),
      finalOutput: "half an answer",
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
