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
    [1, 0],
    [2, 1],
    [3, 2],
    [4, 3],
    [10, 8],
    [12, 9],
    [13, 10],
    [24, 19],
    [60, 48],
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
        assert.ok(line.startsWith("\x1b[44m"));
      }
      if (width >= 2 && height >= 2) {
        assert.match(stripVTControlCharacters(lines[0]), /^╭.*╮$/);
        assert.match(stripVTControlCharacters(lines.at(-1) ?? ""), /^╰.*╯$/);
      }
    }
  }
});

test("panel uses the theme's neutral surface rather than its custom-message background", () => {
  const backgrounds: string[] = [];
  browserPanel(browserViewport(40, 24), "Title", ["Body"], "Close", {
    ...theme,
    bg: (color, text) => {
      backgrounds.push(color);
      return theme.bg(color, text);
    },
  });
  assert.ok(backgrounds.length > 0);
  assert.deepEqual([...new Set(backgrounds)], ["userMessageBg"]);
});

test("normal panel reserves distinct header/footer rows and fills blank body rows", () => {
  const viewport = browserViewport(40, 24);
  assert.equal(viewport.contentWidth, 36);
  assert.equal(viewport.bodyHeight, 13);
  const lines = browserPanel(
    viewport,
    "Session Subagents",
    ["No Subagents in this Session."],
    "Esc close",
    theme,
  ).map(stripVTControlCharacters);
  assert.equal(lines[1], `│ Session Subagents${" ".repeat(20)}│`);
  assert.equal(lines[3], `│ No Subagents in this Session.${" ".repeat(8)}│`);
  assert.equal(lines[4], `│${" ".repeat(38)}│`);
  assert.match(lines[16], /^├─+┤$/);
  assert.match(lines[17], /Esc close/);
});

test("nested selection backgrounds cannot leave the right gutter or border uncovered", () => {
  const lines = browserPanel(
    browserViewport(40, 24),
    "Title",
    [theme.bg("selectedBg", "chosen")],
    "Esc close",
    theme,
  );
  for (const line of lines) {
    let background = false;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Inspect SGR state at the terminal boundary.
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      if (part === "\x1b[44m") background = true;
      else if (part === "\x1b[49m" || part === "\x1b[0m") background = false;
      else if (part && !part.startsWith("\x1b["))
        assert.ok(background, JSON.stringify(part));
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
