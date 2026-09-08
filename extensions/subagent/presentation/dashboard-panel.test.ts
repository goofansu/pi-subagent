import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  dashboardBody,
  dashboardFooter,
  dashboardPanel,
  dashboardScreen,
  dashboardViewport,
} from "./dashboard-panel.ts";
import type { RenderableTheme } from "./rows.ts";

const theme: RenderableTheme = {
  fg: (_color, text) => `\x1b[36m${text}\x1b[39m`,
  bg: (_color, text) => `\x1b[44m${text}\x1b[49m`,
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  italic: (text) => text,
  inverse: (text) => text,
};

test("panel fills exact viewport bounds, even at zero/tiny sizes and with styled Unicode", () => {
  for (const [rows, height] of [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [10, 10],
    [12, 12],
    [13, 13],
    [24, 24],
    [60, 60],
  ]) {
    for (const width of [0, 1, 2, 3, 4, 5, 6, 8, 20, 80]) {
      const viewport = dashboardViewport(width, rows);
      const lines = dashboardPanel(
        viewport,
        "任务 👩‍💻 café é",
        [theme.fg("text", "界".repeat(100)), "", "👩‍💻 é"],
        "Esc close",
        theme,
      );
      assert.equal(lines.length, height, `${width}x${rows}`);
      for (const line of lines) {
        assert.equal(
          visibleWidth(line),
          width,
          `${width}x${rows}: ${JSON.stringify(line)}`,
        );
        assert.doesNotMatch(line, /\ufffd/);
        assert.ok(line.startsWith("\x1b[49m"));
      }
      assert.doesNotMatch(
        lines.map(stripVTControlCharacters).join("\n"),
        /[╭╮╰╯│├┤]/,
      );
    }
  }
});

test("panel uses the terminal surface without borrowing a message background", () => {
  const backgrounds: string[] = [];
  const lines = dashboardPanel(
    dashboardViewport(40, 24),
    "Title",
    ["Body"],
    "Close",
    {
      ...theme,
      bg: (color, text) => {
        backgrounds.push(color);
        return theme.bg(color, text);
      },
    },
  );
  assert.deepEqual(backgrounds, []);
  assert.ok(
    lines.every(
      (line) => line.startsWith("\x1b[49m") && line.endsWith("\x1b[49m"),
    ),
  );
});

test("spacious panel owns paired outer padding around inset content and chrome", () => {
  const viewport = dashboardViewport(40, 24);
  assert.equal(viewport.contentWidth, 38);
  assert.equal(viewport.paddingTop, 1);
  assert.equal(viewport.paddingBottom, 1);
  assert.equal(viewport.bodyHeight, 18);
  assert.equal(
    dashboardBody({ ...viewport, paddingTop: 0, paddingBottom: 0 }, 1)
      .bodyHeight - viewport.bodyHeight,
    2,
    "paired padding is deducted exactly once",
  );
  const lines = dashboardPanel(
    viewport,
    "Subagent dashboard",
    ["No Subagents in this Session."],
    "Esc close",
    theme,
  ).map(stripVTControlCharacters);
  assert.equal(lines[0], " ".repeat(40));
  assert.equal(lines[1], " Subagent dashboard".padEnd(40));
  assert.equal(lines[2], " ".repeat(40));
  assert.equal(lines[3], " No Subagents in this Session.".padEnd(40));
  assert.doesNotMatch(lines.join("\n"), /[╭╮╰╯│├┤]/);
  assert.equal(lines[21], ` ${"─".repeat(38)} `);
  assert.equal(lines[22], " Esc close".padEnd(40));
  assert.equal(lines[23], " ".repeat(40));
});

test("selection backgrounds reset before the gutter", () => {
  const lines = dashboardPanel(
    dashboardViewport(40, 24),
    "Title",
    [theme.bg("selectedBg", "chosen")],
    "Esc close",
    theme,
  );
  for (const line of lines) {
    let background = "default";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Inspect SGR state at the terminal boundary.
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      if (part === "\x1b[44m") background = "selected";
      else if (part === "\x1b[49m" || part === "\x1b[0m")
        background = "default";
      else if (part && !part.startsWith("\x1b["))
        assert.equal(
          background,
          part === "chosen" ? "selected" : "default",
          JSON.stringify(part),
        );
    }
  }
});

test("adaptive footer keeps complete back hints and includes ranges only when supplied", () => {
  const hints = [
    "↑/↓ scroll · Enter Runs · Esc close",
    "Enter open · Esc close",
    "Esc close",
  ];
  assert.equal(
    dashboardFooter(80, hints, "1-6/30"),
    "↑/↓ scroll · Enter Runs · Esc close · 1-6/30",
  );
  assert.equal(dashboardFooter(25, hints), "Enter open · Esc close");
  assert.equal(dashboardFooter(9, hints, "1-6/30"), "Esc close");
  assert.equal(dashboardFooter(80, ["Esc close"]), "Esc close");
});

test("a screen is measured once and split for whichever header it settles on", () => {
  for (const rows of [0, 1, 3, 10, 13, 24, 60]) {
    for (const width of [0, 2, 20, 31, 32, 40, 80]) {
      const screen = dashboardScreen(width, rows);
      // The facts a header height cannot change, so a caller whose header
      // depends on them never has to measure the screen a second time.
      for (const headerLines of [0, 1, 4, 100]) {
        const viewport = dashboardViewport(width, rows, headerLines);
        assert.deepEqual(dashboardBody(screen, headerLines), viewport);
        for (const [field, value] of Object.entries(screen))
          assert.equal(
            viewport[field as keyof typeof screen],
            value,
            `${field} at ${width}x${rows} header ${headerLines}`,
          );
      }
    }
  }
});

test("a multi-line header takes its rows from the body and is painted by its author", () => {
  const header = ["first", "second", "third", "fourth"];
  const viewport = dashboardViewport(40, 24, header.length);
  assert.equal(viewport.headerHeight, 4);
  assert.equal(viewport.bodyHeight, 15);
  const lines = dashboardPanel(
    viewport,
    header,
    ["body"],
    "Esc close",
    theme,
  ).map(stripVTControlCharacters);
  assert.equal(lines.length, 24);
  assert.deepEqual(lines.slice(0, 6), [
    " ".repeat(40),
    ...header.map((line) => ` ${line}`.padEnd(40)),
    " ".repeat(40),
  ]);
  assert.equal(lines[6], " body".padEnd(40));
  assert.equal(lines[21], ` ${"─".repeat(38)} `);
  assert.equal(lines[22], " Esc close".padEnd(40));
  assert.equal(lines[23], " ".repeat(40));
  assert.deepEqual(
    dashboardPanel(viewport, header, ["body"], "Esc close", {
      ...theme,
      fg: () => "painted",
    }).map(stripVTControlCharacters)[1],
    " first".padEnd(40),
  );
});

test("a header too tall for the screen is shortened before the footer is", () => {
  for (const [rows, height] of [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [5, 5],
    [10, 10],
    [13, 13],
    [24, 24],
  ]) {
    const viewport = dashboardViewport(40, rows, 4);
    assert.equal(
      viewport.headerHeight + viewport.bodyHeight,
      Math.max(0, height - (viewport.spacious ? 5 : 1)),
    );
    const lines = dashboardPanel(
      viewport,
      ["first", "second", "third", "fourth"],
      [],
      "Esc close",
      theme,
    );
    assert.equal(lines.length, height, `${height} rows`);
    for (const line of lines) assert.equal(visibleWidth(line), 40);
    if (height > 1) {
      const footerIndex = height - 1 - viewport.paddingBottom;
      assert.match(
        stripVTControlCharacters(lines[footerIndex] ?? ""),
        /^ Esc close/,
      );
    }
  }
});

test("vertical padding appears as a pair exactly at the spacious threshold", () => {
  for (const [rows, padding, bodyHeight] of [
    [9, 0, 7],
    [10, 1, 4],
  ] as const) {
    const viewport = dashboardViewport(40, rows, 1);
    assert.equal(viewport.paddingTop, padding);
    assert.equal(viewport.paddingBottom, padding);
    assert.equal(viewport.bodyHeight, bodyHeight);
    const lines = dashboardPanel(
      viewport,
      "Title",
      ["body"],
      "Esc close",
      theme,
    );
    const plain = lines.map(stripVTControlCharacters);
    if (padding) {
      assert.equal(plain[0], " ".repeat(40));
      assert.equal(plain.at(-1), " ".repeat(40));
      assert.ok(lines[0]?.startsWith("\x1b[49m"));
      assert.ok(!lines[0]?.includes("\x1b[44m"));
      assert.ok(!lines.at(-1)?.includes("\x1b[44m"));
    } else {
      assert.match(plain[0] ?? "", /^ Title/);
      assert.match(plain.at(-1) ?? "", /^ Esc close/);
    }
  }
});
