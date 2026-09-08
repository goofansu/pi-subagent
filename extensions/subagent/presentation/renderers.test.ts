import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  contentText,
  formatNotificationSummary,
  formatParentheticalKeyHint,
  MAX_NOTICE_LABEL_WIDTH,
} from "./renderers.ts";
import type { RenderableTheme } from "./rows.ts";

initTheme(undefined, false);
const theme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  inverse: (text) => text,
};
const dimAware: RenderableTheme = {
  ...theme,
  fg: (color, text) => (color === "dim" ? `<dim>${text}</dim>` : text),
};
const dimAnsi = (text: string): string => `\u001b[2m${text}\u001b[0m`;
const ansiDimAware: RenderableTheme = {
  ...theme,
  fg: (color, text) => (color === "dim" ? dimAnsi(text) : text),
};
const ansiTheme: RenderableTheme = {
  ...theme,
  fg: (_color, text) => `\u001b[36m${text}\u001b[39m`,
  bold: (text) => `\u001b[1m${text}\u001b[22m`,
};
const keyHintStub = (_action: unknown, description: string): string =>
  `ctrl+o ${description}`;
const GOLDEN_WIDTH = 120;

test("the parenthetical hint's punctuation is painted apart from the hint", () => {
  assert.equal(
    formatParentheticalKeyHint(
      dimAware,
      "app.tools.expand",
      "to expand",
      keyHintStub,
    ),
    "<dim>(</dim>ctrl+o to expand<dim>)</dim>",
  );
});

// -- The notification summary line -------------------------------------------

test("S-1: a collapsed notice names the agent, the task, and the outcome", () => {
  assert.equal(
    formatNotificationSummary(
      {
        agent: "reviewer",
        label: "audit auth redirects",
        status: "completed",
        durationMillis: 41_200,
      },
      theme,
      GOLDEN_WIDTH,
      false,
      keyHintStub,
    ),
    "reviewer · audit auth redirects · completed in 41.2s (ctrl+o to expand)",
  );
});

test("S-1: the collapsed line reads the same whichever backend ran the Run", () => {
  // It carries no cost, and that is why. A cost total starts at zero and is
  // only added to, so a backend that reported no money is indistinguishable
  // from a Run that cost nothing — a figure here would read as a fact when it
  // is sometimes an absence. What a Run spent is on the notice's accounting
  // line.
  assert.doesNotMatch(
    formatNotificationSummary(
      {
        agent: "reviewer",
        label: "audit auth redirects",
        status: "completed",
        durationMillis: 41_200,
      },
      theme,
      GOLDEN_WIDTH,
      false,
      keyHintStub,
    ),
    /\$/,
  );
});

test("S-2: a failed and a cancelled summary read the same way, with the verb changed", () => {
  assert.equal(
    formatNotificationSummary(
      {
        agent: "implementer",
        label: "fix flaky cache test",
        status: "failed",
        durationMillis: 19_400,
      },
      theme,
      GOLDEN_WIDTH,
      false,
      keyHintStub,
    ),
    "implementer · fix flaky cache test · failed in 19.4s (ctrl+o to expand)",
  );
  assert.equal(
    formatNotificationSummary(
      {
        agent: "explore",
        label: "inspect the build graph",
        status: "cancelled",
        durationMillis: 60_000,
      },
      theme,
      GOLDEN_WIDTH,
      false,
      keyHintStub,
    ),
    "explore · inspect the build graph · cancelled in 1m 0s (ctrl+o to expand)",
  );
});

test("a collapsed notice carries no id and no character count", () => {
  const line = formatNotificationSummary(
    {
      agent: "explore",
      label: "look around",
      status: "completed",
      durationMillis: 1_000,
    },
    theme,
    GOLDEN_WIDTH,
    false,
    keyHintStub,
  );

  assert.doesNotMatch(line, /run-|subagent-/);
  assert.doesNotMatch(line, /character/);
});

test("the whole collapsed line is fitted to its width, and the label is what gives", () => {
  // The agent, the outcome and the hint are what the reader came for, so the
  // label takes whatever is left and never pushes the line wider.
  for (const width of [120, 100, 80, 70, 60]) {
    const line = stripVTControlCharacters(
      formatNotificationSummary(
        {
          agent: "explore",
          label: "a".repeat(200),
          status: "completed",
          durationMillis: 1_000,
        },
        theme,
        width,
        false,
        keyHintStub,
      ),
    );

    assert.ok(
      line.length <= width,
      `${line.length} columns against a width of ${width}: ${line}`,
    );
    assert.equal(line.includes("\n"), false);
    // Everything but the label survives at every width.
    assert.match(line, /^explore · /);
    assert.match(line, /completed in 1\.0s \(ctrl\+o to expand\)$/);
  }
});

test("notice label space measures the assembled fixed content rather than ANSI bytes", () => {
  const details = {
    agent: "explore",
    label: "a".repeat(200),
    status: "completed" as const,
    durationMillis: 1_000,
  };
  const width = 54;
  const plain = formatNotificationSummary(
    details,
    theme,
    width,
    false,
    keyHintStub,
  );
  const styled = formatNotificationSummary(
    details,
    ansiTheme,
    width,
    false,
    keyHintStub,
  );

  assert.equal(
    stripVTControlCharacters(styled),
    stripVTControlCharacters(plain),
  );
  assert.equal(visibleWidth(styled), width);
  assert.match(stripVTControlCharacters(plain), /^explore · a+… · completed/);
});

test("an empty or unfittable notice label removes its whole section", () => {
  for (const [label, width] of [
    ["", GOLDEN_WIDTH],
    ["audit auth redirects", 10],
  ] as const) {
    const line = stripVTControlCharacters(
      formatNotificationSummary(
        {
          agent: "explore",
          label,
          status: "failed",
          durationMillis: 1_000,
        },
        theme,
        width,
        false,
        keyHintStub,
      ),
    );
    assert.equal(line, "explore · failed in 1.0s (ctrl+o to expand)");
    assert.doesNotMatch(line, /· +·/);
  }
});

test("wide, combining, and emoji notice labels fit without damaged text", () => {
  for (const label of [
    "任务".repeat(100),
    "é".repeat(100),
    "👩‍💻".repeat(100),
  ]) {
    const line = formatNotificationSummary(
      {
        agent: "explore",
        label,
        status: "completed",
        durationMillis: 1_000,
      },
      ansiTheme,
      72,
      false,
      keyHintStub,
    );
    assert.equal(visibleWidth(line), 72);
    assert.doesNotMatch(line, /�/);
    assert.match(stripVTControlCharacters(line), / · completed in 1\.0s/);
  }
});

test("notice clipping retains complete grapheme prefixes", () => {
  const notice = (label: string, width: number) =>
    stripVTControlCharacters(
      formatNotificationSummary(
        {
          agent: "explore",
          label,
          status: "completed",
          durationMillis: 1_000,
        },
        theme,
        width,
        false,
        keyHintStub,
      ),
    );

  assert.equal(
    notice("e\u0301xy", 51),
    "explore · e\u0301… · completed in 1.0s (ctrl+o to expand)",
  );
  assert.equal(
    notice("👩‍💻xy", 51),
    "explore · … · completed in 1.0s (ctrl+o to expand)",
  );
  assert.equal(
    notice("👩‍💻xy", 52),
    "explore · 👩‍💻… · completed in 1.0s (ctrl+o to expand)",
  );
});

test("a line too narrow for any label drops the label whole, not into a gap", () => {
  // The label gives way the way a widget row's turn count does. The outcome
  // never gives: a reader who cannot see how a Run ended has no line worth
  // having, so a terminal narrower than the fixed parts overflows instead.
  const line = stripVTControlCharacters(
    formatNotificationSummary(
      {
        agent: "explore",
        label: "audit auth redirects",
        status: "failed",
        durationMillis: 1_000,
      },
      theme,
      10,
      false,
      keyHintStub,
    ),
  );

  assert.equal(line, "explore · failed in 1.0s (ctrl+o to expand)");
  assert.doesNotMatch(line, /· +·/);
});

test("a label is capped even when the line has room to spare", () => {
  // On a wide terminal a 200-byte label would push the outcome and the cost so
  // far right that a reader scanning a column of notices could not find them.
  const line = stripVTControlCharacters(
    formatNotificationSummary(
      {
        agent: "explore",
        label: "a".repeat(200),
        status: "completed",
        durationMillis: 1_000,
      },
      theme,
      400,
      false,
      keyHintStub,
    ),
  );

  assert.equal(
    line,
    `explore · ${"a".repeat(MAX_NOTICE_LABEL_WIDTH - 1)}… · completed in 1.0s (ctrl+o to expand)`,
  );
});

test("an ellipsis-shortened notice label keeps its trailing separator dim", () => {
  const line = formatNotificationSummary(
    {
      agent: "explore",
      label: "a".repeat(200),
      status: "completed",
      durationMillis: 1_000,
    },
    ansiDimAware,
    400,
    false,
    keyHintStub,
  );

  assert.match(stripVTControlCharacters(line), /… · completed/);
  assert.ok(line.includes(`${dimAnsi(" · ")}completed`));
});

test("an expanded notice's hint offers to collapse, because one key does both", () => {
  assert.match(
    formatNotificationSummary(
      {
        agent: "explore",
        label: "look around",
        status: "completed",
        durationMillis: 1_000,
      },
      theme,
      GOLDEN_WIDTH,
      true,
      keyHintStub,
    ),
    /\(ctrl\+o to collapse\)$/,
  );
});

// -- Content shapes ----------------------------------------------------------

test("result content is read whatever shape it arrived in", () => {
  assert.equal(contentText("plain"), "plain");
  assert.equal(
    contentText([
      { type: "text", text: "one " },
      { type: "image" },
      { type: "text", text: "two" },
    ]),
    "one two",
  );
});
