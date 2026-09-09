import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { RunSummary, SubagentSummary } from "../domain/history.ts";
import {
  backendId,
  createRunProjection,
  EMPTY_USAGE_SNAPSHOT,
  runId,
  subagentId,
} from "../domain/index.ts";
import type { RunInspection } from "../domain/inspection.ts";
import { PLAIN_THEME } from "../testing/stand-in-host.ts";
import {
  type DashboardKey,
  type DashboardPage,
  type DashboardPageChrome,
  type DashboardPageEvent,
  emptyDashboardPage,
  reduceDashboardPage,
} from "./dashboard-page.ts";

// The unconfigured hints — the arrows, `r` — are painted by Pi's helper from
// the active theme rather than from the theme below.
initTheme(undefined, false);

/**
 * How a configured action's hint is spelled, stated rather than resolved.
 *
 * The same stub shape the notice renderers' goldens use. What the ladder is
 * about is the order hints are given up in, and a test that read the real
 * binding would restate Pi's default keymap every time it changed.
 */
const keyHintStub = (action: string, description: string): string =>
  `<${action}> ${description}`;

const CHROME: DashboardPageChrome = {
  identity: { cwd: "/home/operator/work/project", home: "/home/operator" },
  theme: PLAIN_THEME,
  moveKeys: ["up", "down"],
  renderKeyHint: keyHintStub,
};

/** The instant every fixture Run is aged against. */
const NOW = 12_000;

const fixtureRun = (index: number): RunSummary => ({
  runId: runId(`run-${index}`),
  subagentId: subagentId(`subagent-${index}`),
  profile: "explore",
  backend: backendId("pi"),
  label: `任务${index} 👩‍💻 café`,
  phase: "running",
  turns: 1,
  startedAt: 0,
});

const fixtureSubagent = (index: number): SubagentSummary => {
  const run = fixtureRun(index);
  return {
    subagentId: run.subagentId,
    phase: "running",
    latest: run,
    current: run,
  };
};

const SUBAGENTS = Array.from({ length: 12 }, (_, index) =>
  fixtureSubagent(index),
);
const RUNS = Array.from({ length: 12 }, (_, index) => fixtureRun(index));

/** One active capture, long enough that an inspection has to scroll. */
const CAPTURE: RunInspection = {
  outcome: "active",
  runId: runId("run-0"),
  capturedAt: NOW,
  summary: fixtureRun(0),
  usage: EMPTY_USAGE_SNAPSHOT,
  content: {
    ...createRunProjection(),
    finalOutput: Array.from({ length: 60 }, (_, i) => `line-${i}`).join("\n\n"),
  },
};

/**
 * A dashboard being driven the way the host drives one.
 *
 * The reducer is pure, so this is only somewhere to keep the page between
 * events — which is exactly what the host closure does with its one variable.
 * Nothing here scripts a backend, opens a Session or pumps a key through a
 * terminal: every case below is arithmetic over one value.
 */
function browsing(page: DashboardPage = emptyDashboardPage(NOW)) {
  let current = page;
  const send = (...events: readonly DashboardPageEvent[]) => {
    for (const event of events)
      current = reduceDashboardPage(current, event, CHROME).page;
  };
  const press = (...keys: readonly DashboardKey[]) =>
    send(...keys.map((key) => ({ kind: "key", pressed: [key] }) as const));
  const draw = (width: number, terminalRows: number) => {
    const step = reduceDashboardPage(
      current,
      { kind: "screen", width, terminalRows },
      CHROME,
    );
    current = step.page;
    return step.lines;
  };
  const plain = (width: number, terminalRows: number) =>
    draw(width, terminalRows).map(stripVTControlCharacters);
  return { send, press, draw, plain, page: () => current };
}

/** An overview that has reported its population, as the host's first read does. */
const overview = (summaries: readonly SubagentSummary[] = SUBAGENTS) => {
  const dashboard = browsing();
  dashboard.send({ kind: "reading" }, { kind: "summaries", summaries });
  return dashboard;
};

/** One Subagent's history, entered from the overview and answered. */
const history = (runs: readonly RunSummary[] = RUNS) => {
  const dashboard = overview();
  dashboard.press("confirm");
  dashboard.send(
    { kind: "reading" },
    { kind: "history", capture: { runs, capturedAt: NOW } },
    { kind: "ready" },
  );
  return dashboard;
};

/** One Run's inspection, entered from its history and answered. */
const inspection = () => {
  const dashboard = history();
  dashboard.press("confirm");
  dashboard.send(
    { kind: "reading" },
    { kind: "inspection", capture: CAPTURE, handoff: "pending" },
    { kind: "ready" },
  );
  return dashboard;
};

test("inspection toggles every retained transcript block without rereading its frozen capture", () => {
  const dashboard = inspection();
  const output = (label: string) =>
    Array.from({ length: 100 }, (_, index) => `${label} ${index + 1}`).join(
      "\n",
    );
  const frozen = structuredClone(CAPTURE);
  dashboard.send({
    kind: "inspection",
    capture: {
      ...CAPTURE,
      content: {
        ...CAPTURE.content,
        transcript: [
          { role: "tool", parts: [{ kind: "text", text: output("first") }] },
          { role: "tool", parts: [{ kind: "text", text: output("second") }] },
        ],
      },
    },
    handoff: "pending",
  });

  const compact = dashboard.plain(120, 300).join("\n");
  assert.equal(compact.match(/68 wrapped lines hidden/g)?.length, 2);
  assert.match(compact, /t expand transcript/);
  assert.doesNotMatch(compact, /first 50|second 50/);
  const capturedBlocks = dashboard.page().blocks;

  const expandedStep = reduceDashboardPage(
    dashboard.page(),
    { kind: "key", pressed: ["toggleTranscript"] },
    CHROME,
  );
  assert.equal(expandedStep.ask, "draw");
  assert.equal(expandedStep.page.blocks, capturedBlocks);
  dashboard.press("toggleTranscript");
  const expanded = dashboard.plain(120, 300).join("\n");
  assert.match(expanded, /first 50/);
  assert.match(expanded, /second 50/);
  assert.match(expanded, /t compact transcript/);
  assert.doesNotMatch(expanded, /lines hidden/);

  const compactedStep = reduceDashboardPage(
    dashboard.page(),
    { kind: "key", pressed: ["toggleTranscript"] },
    CHROME,
  );
  assert.equal(compactedStep.ask, "draw");
  assert.equal(compactedStep.page.blocks, capturedBlocks);
  dashboard.press("toggleTranscript");
  const recompact = dashboard.plain(120, 300).join("\n");
  assert.equal(recompact.match(/68 wrapped lines hidden/g)?.length, 2);
  assert.doesNotMatch(recompact, /first 50|second 50/);
  assert.deepEqual(CAPTURE, frozen);
});

const footer = (lines: readonly string[]) =>
  stripVTControlCharacters(
    [...lines]
      .reverse()
      .find((line) => stripVTControlCharacters(line).trim()) ?? "",
  ).trim();

/**
 * The ladder a page climbs down as its screen narrows.
 *
 * Read by sweeping the width rather than by naming three widths, because the
 * property is the *order* the hints are given up in and not the column each
 * one happens to run out at. The screen is tall enough to hold the whole page,
 * so no range shares the footer and every rung is hints alone.
 */
const ladder = (
  dashboard: ReturnType<typeof browsing>,
  rows: number,
  narrowest: number,
): readonly string[] => {
  const rungs: string[] = [];
  for (let width = 120; width >= narrowest; width -= 1) {
    const rung = footer(dashboard.draw(width, rows));
    assert.doesNotMatch(rung, /\d+-\d+\/\d+/, "the whole page is on screen");
    if (rungs.at(-1) !== rung) rungs.push(rung);
  }
  return rungs;
};

test("the screen the host draws on arrives as an event and lands on the page", () => {
  const dashboard = overview();
  assert.equal(dashboard.page().viewport.width, 0);
  assert.equal(dashboard.page().viewport.bodyHeight, 0);
  dashboard.draw(80, 24);
  assert.equal(dashboard.page().viewport.width, 80);
  assert.equal(dashboard.page().viewport.height, 24);
  // Paired outer padding, footer, body gap and separator, then the banner.
  assert.equal(dashboard.page().viewport.bodyHeight, 15);
});

test("the header is one case: the banner's four rows and a title's one both come out of the body", () => {
  const list = overview();
  list.draw(80, 24);
  assert.equal(list.page().header.length, 4);
  assert.equal(list.page().viewport.headerHeight, 4);

  // A screen too short for the mark takes the plain title instead, and the
  // body grows by exactly the rows the banner would have taken.
  const short = overview();
  short.draw(80, 11);
  assert.equal(short.page().header.length, 1);
  assert.equal(short.page().viewport.bodyHeight, 5);

  const deeper = history();
  deeper.draw(80, 24);
  assert.equal(deeper.page().header.length, 1);
  assert.equal(deeper.page().viewport.headerHeight, 1);
  assert.equal(deeper.page().viewport.bodyHeight, 18);
  assert.match(
    stripVTControlCharacters(deeper.page().header[0]),
    /^Subagent dashboard · run history · explore · newest first$/,
  );
});

test("one page key moves a selection by exactly one body height, in both directions", () => {
  const dashboard = overview();
  dashboard.draw(80, 10);
  assert.equal(dashboard.page().viewport.bodyHeight, 4);
  assert.match(dashboard.plain(80, 10).join("\n"), /› 任务0/);

  for (const [forward, back] of [
    ["pageDown", "pageUp"],
    ["right", "left"],
  ] as const) {
    dashboard.press(forward);
    assert.match(dashboard.plain(80, 10).join("\n"), /› 任务4/);
    dashboard.press(back);
    assert.match(dashboard.plain(80, 10).join("\n"), /› 任务0/);
  }
});

test("a selection clamps at both ends of its list rather than running off them", () => {
  const dashboard = history();
  dashboard.draw(80, 10);
  dashboard.press("up", "up", "pageUp");
  assert.match(dashboard.plain(80, 10).join("\n"), /› 任务0/);
  for (let i = 0; i < 20; i += 1) dashboard.press("down");
  assert.match(dashboard.plain(80, 10).join("\n"), /› 任务11/);
  dashboard.press("pageDown", "right");
  assert.match(dashboard.plain(80, 10).join("\n"), /› 任务11/);
});

test("a selection survives a resize, on every width and height it survives to", () => {
  const dashboard = overview();
  dashboard.draw(80, 10);
  for (let i = 0; i < 11; i += 1) dashboard.press("down");
  for (const [width, rows] of [
    [80, 10],
    [20, 10],
    [200, 40],
    [40, 13],
    [80, 24],
  ] as const)
    assert.match(dashboard.plain(width, rows).join("\n"), /› 任务11/);
  assert.equal(dashboard.page().selectedSubagentId, subagentId("subagent-11"));
});

test("a keystroke that means two things is read by the page it lands on", () => {
  // An operator who binds the selection's page keys to the arrows has pressed
  // both at once. A list pages either way; an inspection has no selection to
  // page, and scrolls on the arrow it was given rather than losing the key.
  const bound = { kind: "key", pressed: ["pageDown", "right"] } as const;

  const list = overview();
  list.draw(80, 10);
  list.send(bound);
  assert.match(list.plain(80, 10).join("\n"), /› 任务4/);

  const deep = inspection();
  deep.draw(40, 10);
  deep.send(bound);
  assert.equal(deep.page().offset, 4);
});

test("all pages share paired spacious padding and exact screen bounds", () => {
  for (const dashboard of [overview(), history(), inspection()]) {
    for (const [width, rows] of [
      [0, 0],
      [1, 1],
      [40, 9],
      [40, 10],
      [80, 24],
    ] as const) {
      const lines = dashboard.draw(width, rows);
      assert.equal(lines.length, rows);
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      assert.ok(lines.every((line) => !line.includes("�")));
      const plain = lines.map(stripVTControlCharacters);
      if (rows >= 10) {
        assert.equal(plain[0], " ".repeat(width));
        assert.equal(plain.at(-1), " ".repeat(width));
        if (width >= 40)
          assert.ok(
            plain
              .at(-2)
              ?.trim()
              .includes(
                dashboard.page().kind === "overview" ? "close" : "back",
              ),
          );
      } else if (rows === 9) {
        assert.match(plain[0] ?? "", /^ Subagent dashboard/);
        assert.ok(
          plain
            .at(-1)
            ?.trim()
            .includes(dashboard.page().kind === "overview" ? "close" : "back"),
        );
      }
    }
  }
});

test("an inspection scrolls a line and a page, and clamps at both ends of its content", () => {
  const dashboard = inspection();
  const top = dashboard.draw(40, 10);
  assert.equal(dashboard.page().viewport.bodyHeight, 4);
  assert.equal(dashboard.page().offset, 0);

  dashboard.press("up", "left");
  assert.deepEqual(dashboard.draw(40, 10), top);
  dashboard.press("down");
  assert.equal(dashboard.page().offset, 1);
  dashboard.press("up");
  assert.deepEqual(dashboard.draw(40, 10), top);
  dashboard.press("right");
  assert.equal(dashboard.page().offset, 4);
  assert.match(footer(dashboard.draw(40, 10)), /5-8\//);
  dashboard.press("left");
  assert.deepEqual(dashboard.draw(40, 10), top);

  const total = dashboard.page().lines.length;
  for (let i = 0; i < total; i += 1) dashboard.press("right");
  const bottom = dashboard.draw(40, 10);
  assert.equal(dashboard.page().offset, total - 4);
  assert.match(footer(bottom), new RegExp(`${total}/${total}`));
  dashboard.press("right", "down");
  assert.deepEqual(dashboard.draw(40, 10), bottom);
});

test("inspection beginning, end, and normalized wheel deltas use current viewport bounds", () => {
  const dashboard = inspection();
  dashboard.draw(40, 10);
  const total = dashboard.page().lines.length;

  dashboard.press("end");
  assert.equal(dashboard.page().offset, total - 4);
  dashboard.send({ kind: "scroll", delta: -3 });
  assert.equal(dashboard.page().offset, total - 7);
  dashboard.send({ kind: "scroll", delta: 2 });
  assert.equal(dashboard.page().offset, total - 5);
  dashboard.send({ kind: "scroll", delta: 10_000 });
  assert.equal(dashboard.page().offset, total - 4);
  dashboard.press("home");
  assert.equal(dashboard.page().offset, 0);
  dashboard.send({ kind: "scroll", delta: -10_000 });
  assert.equal(dashboard.page().offset, 0);

  dashboard.draw(40, 0);
  dashboard.press("end");
  assert.equal(dashboard.page().offset, dashboard.page().lines.length);
  dashboard.press("home");
  assert.equal(dashboard.page().offset, 0);
});

test("inspection jumps and wheel scrolling clamp short content through resize", () => {
  const dashboard = inspection();
  dashboard.send({
    kind: "inspection",
    capture: {
      ...CAPTURE,
      content: { ...CAPTURE.content, finalOutput: "short output" },
    },
    handoff: "pending",
  });
  dashboard.draw(80, 60);
  dashboard.press("end");
  dashboard.send({ kind: "scroll", delta: 20 });
  assert.equal(dashboard.page().offset, 0);

  dashboard.draw(20, 10);
  dashboard.press("end");
  const narrowedEnd = Math.max(
    0,
    dashboard.page().lines.length - dashboard.page().viewport.bodyHeight,
  );
  assert.equal(dashboard.page().offset, narrowedEnd);
  dashboard.draw(80, 60);
  assert.equal(dashboard.page().offset, 0);
});

test("scroll-by-delta is confined to inspection and remains available during refresh", () => {
  const list = history();
  list.draw(40, 10);
  const before = list.page();
  const ignored = reduceDashboardPage(
    before,
    { kind: "scroll", delta: 4 },
    CHROME,
  );
  assert.equal(ignored.page, before);
  assert.equal(ignored.ask, "nothing");

  const loading = inspection();
  loading.draw(40, 10);
  loading.send({ kind: "reading" });
  loading.send({ kind: "scroll", delta: 4 });
  assert.equal(loading.page().offset, 4);
});

test("a scroll clamps back into a screen that has grown taller under it", () => {
  const dashboard = inspection();
  dashboard.draw(40, 10);
  for (let i = 0; i < 200; i += 1) dashboard.press("right");
  const total = dashboard.page().lines.length;
  assert.equal(dashboard.page().offset, total - 4);
  // A screen with room for all of it scrolls back to the top rather than
  // holding an offset the content no longer reaches.
  const widened = dashboard.plain(160, 200).join("\n");
  assert.equal(dashboard.page().offset, 0);
  assert.match(widened, /line-0/);
  assert.match(widened, /line-59/);
});

test("a scroll clamps back into content that has grown shorter under it", () => {
  const dashboard = inspection();
  dashboard.draw(40, 10);
  for (let i = 0; i < 200; i += 1) dashboard.press("right");
  const deep = dashboard.page().offset;
  assert.ok(deep > 0);
  dashboard.send({
    kind: "inspection",
    capture: {
      ...CAPTURE,
      content: { ...CAPTURE.content, finalOutput: "short output" },
    },
    handoff: "pending",
  });
  dashboard.draw(40, 10);
  assert.ok(dashboard.page().offset < deep);
  assert.equal(dashboard.page().offset, dashboard.page().lines.length - 4);
  assert.match(
    dashboard.page().lines.map(stripVTControlCharacters).join("\n"),
    /short output/,
  );
});

test("a list gives up its page keys, then its movement keys, then the way in", () => {
  assert.deepEqual(ladder(overview(), 24, 44), [
    "up/down move · ←/→ page · <tui.select.confirm> runs · <tui.select.cancel> close",
    "up/down move · <tui.select.confirm> runs · <tui.select.cancel> close",
    "<tui.select.confirm> runs · <tui.select.cancel> close",
    "<tui.select.cancel> close",
  ]);
  // One ladder, so the two list pages differ only in the words their own keys
  // are worth: a history inspects a Run where the overview opens its Runs.
  assert.deepEqual(ladder(history(), 24, 44), [
    "up/down move · ←/→ page · <tui.select.confirm> inspect · <tui.select.cancel> back",
    "up/down move · <tui.select.confirm> inspect · <tui.select.cancel> back",
    "<tui.select.confirm> inspect · <tui.select.cancel> back",
    "<tui.select.cancel> back",
  ]);
});

test("an inspection advertises jumps, then progressively keeps refresh and the way back", () => {
  assert.deepEqual(ladder(inspection(), 200, 30), [
    "up/down move · ←/→ page · Home/End jump · r refresh · <tui.select.cancel> back",
    "←/→ page · Home/End jump · r refresh · <tui.select.cancel> back",
    "Home/End jump · r refresh · <tui.select.cancel> back",
    "r refresh · <tui.select.cancel> back",
    "<tui.select.cancel> back",
  ]);
});

test("a page with nothing on it offers the way out and no range", () => {
  const empty = overview([]);
  const lines = empty.plain(80, 24);
  assert.equal(footer(lines), "<tui.select.cancel> close");
  assert.match(lines.join("\n"), /No subagents in this session/);
});

test("a step leaves the host one thing to do, and never more than one", () => {
  const step = (page: DashboardPage, key: DashboardKey) =>
    reduceDashboardPage(page, { kind: "key", pressed: [key] }, CHROME);

  // Escape closes the dashboard from the overview and walks back from anywhere
  // deeper, and a page one level down asks for the read its kind implies.
  assert.equal(step(overview().page(), "cancel").ask, "close");
  assert.equal(step(history().page(), "cancel").ask, "read");
  assert.equal(step(inspection().page(), "cancel").ask, "read");
  assert.equal(step(overview().page(), "confirm").ask, "read");
  assert.equal(step(history().page(), "confirm").ask, "read");
  // Moving is the host's to draw and nothing else; a key that means nothing
  // here leaves nothing behind at all.
  assert.equal(step(overview().page(), "down").ask, "draw");
  assert.equal(step(overview().page(), "refresh").ask, "nothing");
  assert.equal(step(inspection().page(), "refresh").ask, "read");

  // A read in flight answers nothing but the way out of it.
  const loading = reduceDashboardPage(
    overview().page(),
    { kind: "reading" },
    CHROME,
  ).page;
  assert.equal(step(loading, "down").ask, "nothing");
  assert.equal(step(loading, "confirm").ask, "nothing");
  assert.equal(step(loading, "cancel").ask, "close");
});

test("only the screen event paints, because every other one is followed by a render", () => {
  const dashboard = overview();
  dashboard.draw(80, 24);
  const page = dashboard.page();
  for (const event of [
    { kind: "key", pressed: ["down"] },
    { kind: "sampled", instant: NOW + 1 },
    { kind: "reading" },
    { kind: "themed" },
  ] as const)
    assert.deepEqual(reduceDashboardPage(page, event, CHROME).lines, []);
  assert.ok(
    reduceDashboardPage(
      page,
      { kind: "screen", width: 80, terminalRows: 24 },
      CHROME,
    ).lines.length > 0,
  );
});
