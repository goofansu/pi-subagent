import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import type { RunId, SubagentId } from "../domain/index.ts";
import {
  abbreviateHome,
  clipPath,
  DASHBOARD_TITLE,
  dashboardBanner,
  dashboardBannerFits,
  PI_MARK,
  subagentCounts,
} from "./banner.ts";
import { browserViewport } from "./browser-panel.ts";
import type { RenderableTheme } from "./rows.ts";

const theme: RenderableTheme = {
  fg: (color, text) => `\x1b[${color === "accent" ? 36 : 90}m${text}\x1b[39m`,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  inverse: (text) => text,
};

const run = (phase: RunSummary["phase"], index: number): RunSummary => ({
  runId: `run-${index}` as RunId,
  subagentId: `subagent-${index}` as SubagentId,
  profile: "explore",
  backend: "pi" as RunSummary["backend"],
  label: "look around",
  phase,
  turns: 1,
  startedAt: 0,
});

const subagent = (
  phase: RunSummary["phase"],
  index: number,
): SubagentSummary => ({
  subagentId: `subagent-${index}` as SubagentId,
  phase: phase === "running" ? "running" : "idle",
  latest: run(phase, index),
  ...(phase === "running" ? { current: run(phase, index) } : {}),
});

const plain = (lines: readonly string[]) => lines.map(stripVTControlCharacters);

test("the mark is the logo's 4×4 grid, two columns to a pixel", () => {
  assert.deepEqual(PI_MARK, ["██████  ", "██  ██  ", "████  ██", "██    ██"]);
  for (const row of PI_MARK) assert.equal(visibleWidth(row), 8);
});

test("the header names the browser, the working directory, and the population", () => {
  const lines = plain(
    dashboardBanner(
      { cwd: "/Users/ada/code/pi-subagent", home: "/Users/ada" },
      [
        subagent("running", 0),
        subagent("failed", 1),
        subagent("completed", 2),
        subagent("completed", 3),
      ],
      78,
      theme,
    ),
  );
  assert.deepEqual(lines, [
    "██████    Subagent dashboard",
    "██  ██    ~/code/pi-subagent",
    "████  ██  1 active · 1 needs attention · 2 completed",
    "██    ██  ",
  ]);
});

test("a population still loading leaves the counts blank rather than claiming zero", () => {
  const lines = plain(dashboardBanner({ cwd: "/work" }, undefined, 78, theme));
  assert.equal(lines[2], "████  ██  ");
  assert.doesNotMatch(lines.join("\n"), /active/);
});

test("the mark and the title are accented; the rest of the header is quiet", () => {
  const painted: { color: string; text: string }[] = [];
  dashboardBanner({ cwd: "/work" }, [subagent("running", 0)], 78, {
    ...theme,
    fg: (color, text) => {
      painted.push({ color, text });
      return text;
    },
  });
  assert.deepEqual(painted, [
    { color: "accent", text: DASHBOARD_TITLE },
    { color: "muted", text: "/work" },
    { color: "muted", text: "1 active · 0 needs attention · 0 completed" },
    ...PI_MARK.map((row) => ({ color: "accent", text: row })),
  ]);
});

test("a narrow header drops the empty categories and keeps the path's leaf", () => {
  const lines = plain(
    dashboardBanner(
      {
        cwd: "/Users/ada/code/pi-subagent/extensions/subagent",
        home: "/Users/ada",
      },
      [subagent("running", 0), subagent("running", 1)],
      40,
      theme,
    ),
  );
  assert.deepEqual(lines, [
    "██████    Subagent dashboard",
    "██  ██    …/extensions/subagent",
    "████  ██  2 active",
    "██    ██  ",
  ]);
});

test("every header line fits the width it was given, at any width", () => {
  for (const width of [0, 1, 2, 6, 10, 11, 20, 34, 40, 80, 200]) {
    for (const lines of [
      dashboardBanner(
        { cwd: "/Users/ada/code/任务 👩‍💻", home: "/Users/ada" },
        [subagent("running", 0), subagent("failed", 1)],
        width,
        theme,
      ),
      dashboardBanner({ cwd: "/" }, undefined, width, theme),
    ]) {
      assert.equal(lines.length, PI_MARK.length);
      for (const line of plain(lines)) {
        assert.ok(
          visibleWidth(line) <= Math.max(width, 10),
          `${width}: ${JSON.stringify(line)}`,
        );
        assert.doesNotMatch(line, /�/);
      }
    }
  }
});

test("`~` replaces the operator's home, and only a whole leading segment of it", () => {
  assert.equal(abbreviateHome("/Users/ada/code", "/Users/ada"), "~/code");
  assert.equal(abbreviateHome("/Users/ada", "/Users/ada"), "~");
  assert.equal(abbreviateHome("/Users/ada/code", "/Users/ada/"), "~/code");
  assert.equal(
    abbreviateHome("/Users/adam/code", "/Users/ada"),
    "/Users/adam/code",
  );
  assert.equal(abbreviateHome("/work", undefined), "/work");
  assert.equal(abbreviateHome("/work", "/"), "/work");
});

test("a path too long for its columns keeps its leaf", () => {
  assert.equal(clipPath("~/code/pi-subagent", 40), "~/code/pi-subagent");
  assert.equal(clipPath("~/code/pi-subagent/extensions", 20), "…/extensions");
  assert.equal(clipPath("verylongsinglesegment", 8), "verylon…");
  assert.equal(clipPath("~/code", 0), "");
});

test("counts name every category, and only the occupied ones when narrow", () => {
  const population = [
    subagent("running", 0),
    subagent("failed", 1),
    subagent("completed", 2),
  ];
  assert.equal(
    subagentCounts(population, 80),
    "1 active · 1 needs attention · 1 completed",
  );
  assert.equal(
    subagentCounts(population, 30),
    "1 active · 1 needs attention …",
  );
  assert.equal(
    subagentCounts([subagent("running", 0), subagent("running", 1)], 30),
    "2 active",
  );
  assert.equal(
    subagentCounts([], 80),
    "0 active · 0 needs attention · 0 completed",
  );
  assert.equal(subagentCounts([], 12), "0 active · …");
});

test("the mark is drawn only where it leaves a list worth reading", () => {
  assert.equal(dashboardBannerFits(browserViewport(80, 24)), true);
  assert.equal(dashboardBannerFits(browserViewport(36, 12)), true);
  assert.equal(dashboardBannerFits(browserViewport(35, 12)), false);
  assert.equal(dashboardBannerFits(browserViewport(80, 11)), false);
  assert.equal(dashboardBannerFits(browserViewport(80, 9)), false);
  assert.equal(dashboardBannerFits(browserViewport(31, 24)), false);
  assert.equal(dashboardBannerFits(browserViewport(0, 0)), false);
});
