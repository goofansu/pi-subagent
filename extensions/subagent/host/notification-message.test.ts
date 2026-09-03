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
      status: notice.status,
    });
  }
});

test("the details carry identity only, never the text", () => {
  const message = buildNotificationMessage(
    fixtureNotification({ finalOutput: "the whole answer" }),
  );

  assert.deepEqual(Object.keys(message.details).sort(), [
    "agent",
    "runId",
    "status",
    "subagentId",
  ]);
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
  assert.match(
    rendered[0],
    /explore \(subagent subagent-1, run run-1\) completed · \d+ characters/,
  );
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
    /Use agent_result with id run-1 to retrieve the full result\./,
  );
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
