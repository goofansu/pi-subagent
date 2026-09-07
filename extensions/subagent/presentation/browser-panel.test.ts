import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  browserFooter,
  browserPanel,
  browserViewport,
} from "./browser-panel.ts";
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
      const viewport = browserViewport(width, rows);
      const lines = browserPanel(
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
  const lines = browserPanel(
    browserViewport(40, 24),
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

test("borderless screen aligns title, body and bottom navigation with a quiet separator", () => {
  const viewport = browserViewport(40, 24);
  assert.equal(viewport.contentWidth, 38);
  assert.equal(viewport.bodyHeight, 20);
  const lines = browserPanel(
    viewport,
    "Subagent dashboard",
    ["No Subagents in this Session."],
    "Esc close",
    theme,
  ).map(stripVTControlCharacters);
  assert.equal(lines[0], " Subagent dashboard".padEnd(40));
  assert.equal(lines[1], " ".repeat(40));
  assert.equal(lines[2], " No Subagents in this Session.".padEnd(40));
  assert.equal(lines[3], " ".repeat(40));
  assert.doesNotMatch(lines.join("\n"), /[╭╮╰╯│├┤]/);
  assert.equal(lines[22], ` ${"─".repeat(38)} `);
  assert.equal(lines[23], " Esc close".padEnd(40));
});

test("selection backgrounds reset before the gutter", () => {
  const lines = browserPanel(
    browserViewport(40, 24),
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
    browserFooter(80, hints, "1-6/30"),
    "↑/↓ scroll · Enter Runs · Esc close · 1-6/30",
  );
  assert.equal(browserFooter(25, hints), "Enter open · Esc close");
  assert.equal(browserFooter(9, hints, "1-6/30"), "Esc close");
  assert.equal(browserFooter(80, ["Esc close"]), "Esc close");
});

test("a multi-line header takes its rows from the body and is painted by its author", () => {
  const header = ["first", "second", "third", "fourth"];
  const viewport = browserViewport(40, 24, header.length);
  assert.equal(viewport.headerHeight, 4);
  assert.equal(viewport.bodyHeight, 17);
  const lines = browserPanel(
    viewport,
    header,
    ["body"],
    "Esc close",
    theme,
  ).map(stripVTControlCharacters);
  assert.equal(lines.length, 24);
  assert.deepEqual(lines.slice(0, 5), [
    ...header.map((line) => ` ${line}`.padEnd(40)),
    " ".repeat(40),
  ]);
  assert.equal(lines[5], " body".padEnd(40));
  assert.equal(lines[22], ` ${"─".repeat(38)} `);
  assert.equal(lines[23], " Esc close".padEnd(40));
  assert.deepEqual(
    browserPanel(viewport, header, ["body"], "Esc close", {
      ...theme,
      fg: () => "painted",
    }).map(stripVTControlCharacters)[0],
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
    const viewport = browserViewport(40, rows, 4);
    assert.equal(
      viewport.headerHeight + viewport.bodyHeight,
      Math.max(0, height - (viewport.spacious ? 3 : 1)),
    );
    const lines = browserPanel(
      viewport,
      ["first", "second", "third", "fourth"],
      [],
      "Esc close",
      theme,
    );
    assert.equal(lines.length, height, `${height} rows`);
    for (const line of lines) assert.equal(visibleWidth(line), 40);
    if (height > 1)
      assert.match(stripVTControlCharacters(lines.at(-1) ?? ""), /^ Esc close/);
  }
});
