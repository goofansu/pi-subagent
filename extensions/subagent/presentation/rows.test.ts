import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { backendId } from "../domain/index.ts";
import {
  FIXTURE_NOW,
  fixtureRow,
  fixtureUsage,
} from "../testing/presentation-fixtures.ts";
import {
  formatRowSummary,
  formatRunRow,
  MAX_PROFILE_WIDTH,
  type RenderableTheme,
  ROW_DELIMITER,
  renderRunRows as renderRunRowsAtTime,
} from "./rows.ts";

/** A theme that paints nothing, so a golden test reads the text itself. */
const theme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  inverse: (text) => text,
};

/**
 * A theme that paints each colour as its own SGR code, for the tests about
 * paint. Real escape sequences rather than readable tags, because the
 * renderer measures what it draws and a tag would take up columns.
 */
const SGR: Record<string, number> = {
  dim: 2,
  muted: 90,
  text: 37,
  warning: 33,
  error: 31,
  success: 32,
  accent: 36,
  toolTitle: 35,
  borderMuted: 34,
};
const BG: Record<string, number> = {
  toolPendingBg: 44,
  toolSuccessBg: 42,
  toolErrorBg: 41,
};
const paint = (color: string, text: string): string =>
  `\u001b[${SGR[color] ?? 39}m${text}\u001b[0m`;
/** A background the way Pi's theme paints one: set, text, reset background only. */
const paintBg = (color: string, text: string): string =>
  `\u001b[${BG[color] ?? 49}m${text}\u001b[49m`;
const bold = (text: string): string => `\u001b[1m${text}\u001b[22m`;
const italic = (text: string): string => `\u001b[3m${text}\u001b[23m`;
const inverse = (text: string): string => `\u001b[7m${text}\u001b[27m`;
const named: RenderableTheme = {
  fg: paint,
  bg: paintBg,
  bold,
  italic,
  inverse,
};
function row(width: number, overrides = {}, now = FIXTURE_NOW): string {
  return stripVTControlCharacters(
    formatRunRow(fixtureRow(overrides), theme, width, now),
  ).trimEnd();
}

function renderRunRows(
  rows: Parameters<typeof renderRunRowsAtTime>[0],
  paintTheme: RenderableTheme,
  width: number,
): readonly string[] {
  return renderRunRowsAtTime(rows, paintTheme, width, FIXTURE_NOW);
}

// ── One active Run ──────────────────────────────────────────────────────────

test("wide detail prioritizes Profile, state, and activity before accounting, backend, and Label", () => {
  const line = row(120, { activity: "bash: npm test" });

  assert.equal(ROW_DELIMITER, "  ");
  assert.equal(
    line,
    "explore  running  bash: npm test  3 turns  pi  look around",
  );
  assert.doesNotMatch(line, /\d\.\ds|run-1|subagent-1/);
});

test("semantic activity age uses shared nonnegative second and minute duration vocabulary", () => {
  const active = {
    activity: "bash: npm test",
    lastActivity: { summary: "bash: npm test", changedAt: 1_000 },
  };

  assert.equal(
    row(120, active, 13_449),
    "explore  running  bash: npm test  12.4s ago  3 turns  pi  look around",
  );
  assert.equal(
    row(120, active, 63_000),
    "explore  running  bash: npm test  1m 2s ago  3 turns  pi  look around",
  );
  assert.equal(
    row(120, active, 500),
    "explore  running  bash: npm test  0.0s ago  3 turns  pi  look around",
  );
});

test("age follows activity in width priority and blocks lower-priority metadata when it cannot fit", () => {
  const active = {
    activity: "bash: npm test",
    lastActivity: { summary: "bash: npm test", changedAt: 1_000 },
  };

  assert.equal(
    row(52, active, 13_400),
    "explore  running  bash: npm test  12.4s ago  3 turns",
  );
  assert.equal(
    row(43, active, 13_400),
    "explore  running  bash: npm test  12.4s ago",
  );
  assert.equal(row(42, active, 13_400), "explore  running  bash: npm test");
});

test("age is omitted unless its matching current activity is visible", () => {
  const retained = {
    summary: "bash: npm test",
    changedAt: 1_000,
  };
  assert.equal(
    row(120, { lastActivity: retained }, 13_400),
    "explore  running  3 turns  pi  look around",
  );
  assert.equal(
    row(120, { activity: "bash: other", lastActivity: retained }, 13_400),
    "explore  running  bash: other  3 turns  pi  look around",
  );
  assert.equal(
    row(
      120,
      {
        phase: "finalizing",
        activity: "bash: npm test",
        lastActivity: retained,
      },
      13_400,
    ),
    "explore  finalizing  3 turns  pi  look around",
  );
});

test("optional fields drop without displacing useful activity", () => {
  const active = (width: number) =>
    row(width, {
      identity: {
        description: "a supplementary Label that is deliberately long",
      },
      activity: "bash: npm test",
    });

  assert.equal(
    active(80),
    "explore  running  bash: npm test  3 turns  pi  a supplementary Label that is de…",
  );
  assert.equal(active(47), "explore  running  bash: npm test  3 turns  pi");
  assert.equal(active(43), "explore  running  bash: npm test  3 turns");
  assert.equal(active(32), "explore  running  bash: npm test");
});

test("long Profile names are bounded and shrink before state or useful activity disappear", () => {
  const overrides = {
    identity: { agent: "a-very-long-agent-profile-name" },
    activity: "bash: npm test",
  };
  assert.equal(MAX_PROFILE_WIDTH, 16);
  assert.equal(
    row(80, overrides),
    "a-very-long-age…  running  bash: npm test  3 turns  pi  look around",
  );
  assert.equal(row(30, overrides), "a-very…  running  bash: npm t…");
  assert.equal(
    row(20, { identity: overrides.identity }),
    "a-very-lon…  running",
  );
});

test("suppressed activity does not let lower-priority optional fields reappear", () => {
  const active = { activity: "bash: npm test" };
  for (const width of Array.from({ length: 10 }, (_, index) => 20 + index)) {
    assert.equal(row(width, active), "explore  running", `width ${width}`);
  }
  assert.equal(row(30, active), "explore  running  bash: npm t…");
});

test("the useful activity boundary also reallocates a long Profile", () => {
  const active = {
    identity: { agent: "a-very-long-agent-profile-name" },
    activity: "bash: npm test",
  };
  assert.equal(row(29, active), "a-very-long-age…  running");
  assert.equal(row(30, active), "a-very…  running  bash: npm t…");
});

test("missing activity is omitted honestly while wide optional context remains", () => {
  assert.equal(row(120), "explore  running  3 turns  pi  look around");
  assert.equal(row(22), "explore  running");
});

test("finalizing and cancelling never imply that retained activity is executing", () => {
  assert.equal(
    row(120, { phase: "finalizing", activity: "bash: npm test" }),
    "explore  finalizing  3 turns  pi  look around",
  );
  assert.equal(
    row(120, {
      cancellation: { reason: "requested" },
      activity: "bash: npm test",
    }),
    "explore  cancelling  3 turns  pi  look around",
  );
});

test("zero turns retain existing accounting vocabulary and no tool count or context gauge is added", () => {
  const line = row(120, {
    tools: 4,
    usage: fixtureUsage({
      turns: 0,
      context: { tokens: 84_000, window: 200_000 },
    }),
  });
  assert.equal(line, "explore  running  —  pi  look around");
  assert.doesNotMatch(line, /tool|%|▰/);
});

test("arbitrary backend names remain presentation-only and drop at their width boundary", () => {
  const active = {
    identity: { backendId: backendId("custom-backend") },
    activity: "bash: npm test",
  };
  assert.equal(
    row(120, active),
    "explore  running  bash: npm test  3 turns  custom-backend  look around",
  );
  assert.equal(
    row(57, active),
    "explore  running  bash: npm test  3 turns  custom-backend",
  );
  assert.equal(row(56, active), "explore  running  bash: npm test  3 turns");
});

test("identical inputs produce the same exact styled presentation", () => {
  const first = formatRunRow(
    fixtureRow({ activity: "bash: npm test" }),
    named,
    120,
    FIXTURE_NOW,
  );
  const second = formatRunRow(
    fixtureRow({ activity: "bash: npm test" }),
    named,
    120,
    FIXTURE_NOW,
  );
  const expected = [
    paint("toolTitle", bold("explore")),
    paint("warning", "running"),
    paint("muted", italic("bash: npm test")),
    paint("dim", "3 turns"),
    paint("dim", "pi"),
    paint("dim", "look around"),
  ].join(ROW_DELIMITER);
  assert.equal(first, expected);
  assert.equal(second, expected);
});

// ── Fitting ──────────────────────────────────────────────────────────────────

test("very narrow rows keep a Profile prefix without an empty-part delimiter", () => {
  const expected = new Map([
    [1, "…"],
    [2, "e…"],
    [7, "explore"],
    [9, "explore"],
    [10, "…  running"],
  ]);
  for (const [width, plain] of expected) {
    assert.equal(row(width, { activity: "bash: npm test" }), plain);
    const styled = formatRunRow(
      fixtureRow({ activity: "bash: npm test" }),
      named,
      width,
      FIXTURE_NOW,
    );
    assert.equal(stripVTControlCharacters(styled), plain);
    assert.ok(!plain.startsWith(ROW_DELIMITER));
    assert.ok(visibleWidth(styled) <= width);
  }
  assert.equal(
    formatRunRow(
      fixtureRow({ activity: "bash: npm test" }),
      named,
      1,
      FIXTURE_NOW,
    ),
    paint("toolTitle", bold("…")),
  );
  assert.equal(
    formatRunRow(
      fixtureRow({ activity: "bash: npm test" }),
      named,
      10,
      FIXTURE_NOW,
    ),
    [paint("toolTitle", bold("…")), paint("warning", "running")].join(
      ROW_DELIMITER,
    ),
  );
});

test("plain and styled wide text stay within every terminal-cell boundary", () => {
  const wide = fixtureRow({
    identity: {
      agent: "探索探索探索探索探索探索",
      description: "界".repeat(80),
    },
    activity: "読む".repeat(40),
  });
  for (const width of [0, 1, 2, 8, 20, 30, 46, 80, 120]) {
    for (const paintTheme of [theme, named]) {
      const line = formatRunRow(wide, paintTheme, width, FIXTURE_NOW);
      assert.ok(
        visibleWidth(line) <= width,
        `width ${width} produced ${visibleWidth(line)} cells`,
      );
    }
  }
});

// ── Summary and the whole widget ─────────────────────────────────────────────

test("the widget summary counts each phase in the shared order", () => {
  assert.equal(
    formatRowSummary([
      fixtureRow({}),
      fixtureRow({ phase: "finalizing" }),
      fixtureRow({}),
    ]),
    "2 running, 1 finalizing",
  );
});

test("multiple active Runs show aggregate state without individual rows", () => {
  const rows = [
    fixtureRow({ identity: { agent: "explore" } }),
    fixtureRow({
      identity: { agent: "reviewer", description: "read the diff" },
      usage: fixtureUsage({ turns: 1 }),
    }),
  ];

  const lines = renderRunRows(rows, theme, 80).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );

  assert.deepEqual(lines, [" subagents   2 running"]);
});

test("narrow unresolved terminal attention stays compact beside essential active detail", () => {
  const rows = [
    fixtureRow({
      identity: { agent: "explore", description: "supplementary label" },
      activity: "bash: npm test",
    }),
    fixtureRow({ phase: "completed", handoff: "exhausted" }),
  ];
  const lines = renderRunRows(rows, named, 32);
  assert.equal(lines.length, 2);
  assert.match(stripVTControlCharacters(lines[0]), /^! 1 notification failed/);
  assert.match(
    stripVTControlCharacters(lines[1]),
    /^ explore {2}running {2}bash: npm/,
  );
  assert.doesNotMatch(stripVTControlCharacters(lines[1]), /pi|supplementary/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 32);
});

test("unresolved terminal Runs contribute only summary beside one active Run", () => {
  // Neither the terminal Run's identity nor its duration affects active detail.
  const rows = [
    fixtureRow({ identity: { agent: "explore" } }),
    fixtureRow({ identity: { agent: "reviewer" }, phase: "completed" }),
  ];
  const lines = renderRunRows(rows, theme, 80).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );
  assert.deepEqual(lines, [
    " subagents   1 running   1 completed",
    " explore  running  3 turns  pi  look around",
  ]);
  // Finalizing still counts as active, so a mixed pair has no detail rows.
  const mixedLive = renderRunRows(
    [fixtureRow(), fixtureRow({ phase: "finalizing" })],
    theme,
    80,
  ).map((line) => stripVTControlCharacters(line).trimEnd());
  assert.deepEqual(mixedLive, [" subagents   1 running   1 finalizing"]);
});

test("the header is the name and one inverted chip per phase, and says nothing about spend", () => {
  const rows = [
    fixtureRow({
      usage: fixtureUsage({
        turns: 3,
        input: 9_000,
        output: 1_200,
        cost: 0.041,
      }),
    }),
    fixtureRow({ phase: "failed" }),
  ];
  const [header = ""] = renderRunRows(rows, named, 100);
  assert.equal(
    header,
    ` ${paint("accent", bold("subagents"))}  ${inverse(paint("warning", " 1 running "))} ${inverse(paint("error", " 1 failed "))}`,
  );
  // No rule: the editor's own border sits directly beneath the widget.
  assert.doesNotMatch(header, /─/);

  // No token total and no cost: the first left out cache reads, and the
  // second summed backends that report at different moments. Each notice
  // carries its own Run's accounting instead.
  const plain = stripVTControlCharacters(
    renderRunRows(rows, theme, 100)[0] ?? "",
  );
  assert.equal(plain, " subagents   1 running   1 failed ");
  assert.doesNotMatch(plain, /tokens|\$/);
});

test("the header shortens rather than wraps on a narrow terminal", () => {
  const rows = [fixtureRow(), fixtureRow({ phase: "failed" })];
  const at = (width: number) =>
    stripVTControlCharacters(renderRunRows(rows, theme, width)[0] ?? "");
  assert.equal(at(40), " subagents   1 running   1 failed ");
  assert.ok(visibleWidth(at(20)) <= 20);
  assert.match(at(20), /^ subagents/);
});

test("a large fan-out has no overflow list", () => {
  const rows = Array.from({ length: 10 }, (_unused, index) =>
    fixtureRow({ identity: { agent: `agent-${index}` } }),
  );

  const lines = renderRunRows(rows, theme, 80).map((line) =>
    stripVTControlCharacters(line).trimEnd(),
  );

  assert.deepEqual(lines, [" subagents   10 running"]);
});

test("summary separates cancellation, Run outcomes, and exceptional hand-off attention", () => {
  const rows = [
    fixtureRow({ cancellation: { reason: "requested" } }),
    fixtureRow({ phase: "finalizing" }),
    fixtureRow({ phase: "completed", handoff: "exhausted" }),
    fixtureRow({ phase: "completed", handoff: "unannounceable" }),
    fixtureRow({ phase: "failed" }),
    fixtureRow({ phase: "cancelled" }),
  ];
  const lines = renderRunRows(rows, theme, 240);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /1 cancelling/);
  assert.match(lines[0], /1 finalizing/);
  assert.match(lines[0], /2 completed/);
  assert.match(lines[0], /1 failed/);
  assert.match(lines[0], /1 cancelled/);
  assert.match(lines[0], /1 notification failed/);
  assert.match(lines[0], /1 no notification · result unavailable/);
  assert.doesNotMatch(lines[0], /running|explore|look around|turns/);
});

test("exceptional attention survives narrow summaries within terminal display width", () => {
  for (const handoff of ["exhausted", "unannounceable"] as const) {
    const rows = [
      ...Array.from({ length: 20 }, () => fixtureRow({ phase: "completed" })),
      fixtureRow({ phase: "completed", handoff }),
    ];
    for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
      const lines = renderRunRows(rows, named, width);
      assert.equal(lines.length, 1);
      assert.ok(visibleWidth(lines[0]) <= width, `width ${width}`);
      if (width > 0 && width <= 40) {
        assert.match(stripVTControlCharacters(lines[0]), /^!/);
      }
    }
  }
  const wideText = fixtureRow({
    identity: {
      agent: "探索探索探索探索探索探索",
      description: "界".repeat(80),
    },
    activity: "読む".repeat(40),
  });
  for (const width of [0, 1, 2, 8, 20, 80]) {
    for (const line of renderRunRows([wideText], named, width)) {
      assert.ok(visibleWidth(line) <= width, `single width ${width}`);
    }
  }
});

test("exceptional summaries keep chips at exact fit and switch to plain attention on overflow", () => {
  const cases = [
    {
      handoff: "exhausted" as const,
      width: 49,
      full: " subagents   1 completed   1 notification failed ",
      compact: "! 1 notification failed, 1 completed",
    },
    {
      handoff: "unannounceable" as const,
      width: 66,
      full: " subagents   1 completed   1 no notification · result unavailable ",
      compact: "! 1 no notification · result unavailable, 1 completed",
    },
  ];
  for (const { handoff, width, full, compact } of cases) {
    const rows = [fixtureRow({ phase: "completed", handoff })];
    for (const paintTheme of [theme, named]) {
      for (const fittingWidth of [width, width + 1]) {
        const [line] = renderRunRows(rows, paintTheme, fittingWidth);
        assert.equal(stripVTControlCharacters(line), full);
        if (paintTheme === named)
          assert.ok(line.includes("\u001b[7m"), "full header retains chips");
      }
      const [overflow] = renderRunRows(rows, paintTheme, width - 1);
      assert.equal(stripVTControlCharacters(overflow), compact);
      assert.ok(!overflow.includes("\u001b[7m"), "overflow drops chip framing");
      assert.ok(visibleWidth(overflow) <= width - 1);
    }
  }
});

test("an empty list renders nothing at all", () => {
  assert.deepEqual(renderRunRows([], theme, 80), []);
});

// ── Bands ────────────────────────────────────────────────────────────────────

test("only the active detail is painted as a band", () => {
  const rows = [
    fixtureRow({ identity: { agent: "live" } }),
    fixtureRow({ identity: { agent: "done" }, phase: "completed" }),
    fixtureRow({ identity: { agent: "broke" }, phase: "failed" }),
    fixtureRow({ identity: { agent: "stopped" }, phase: "cancelled" }),
  ];
  const lines = renderRunRows(rows, named, 60);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith("\u001b[44m"), "a live row is pending");
  // Edge to edge: the band is padded to the width and closed at its end.
  for (const line of lines.slice(1)) {
    assert.equal(visibleWidth(line), 60);
    assert.ok(line.endsWith("\u001b[49m"));
  }
});

test("a band survives a full reset inside its text", () => {
  // Truncation leaves a full SGR reset behind, which would switch the
  // background off for the rest of the line. The band is painted around it.
  const rows = [
    fixtureRow({
      identity: {
        description:
          "a label long enough to be cut off by the width it is given",
      },
    }),
  ];
  const [, line = ""] = renderRunRows(rows, named, 60);
  assert.ok(line.includes("\u001b[0m\u001b[44m"));
  assert.equal(visibleWidth(line), 60);
  assert.ok(line.endsWith("\u001b[49m"));
});

test("a row leaves one clear column at its right edge, as at its left", () => {
  const rows = [
    fixtureRow({
      identity: {
        description:
          "a label long enough to be cut off by the width it is given",
      },
    }),
  ];
  const [, line = ""] = renderRunRows(rows, named, 60);
  const plain = stripVTControlCharacters(line);
  assert.equal(visibleWidth(plain), 60);
  assert.match(plain, /^ \S/);
  assert.match(plain, /\S $/);
});

test("the aggregate summary is not a band", () => {
  const rows = Array.from({ length: 4 }, (_unused, index) =>
    fixtureRow({ identity: { agent: `agent-${index}` } }),
  );
  const lines = renderRunRows(rows, named, 60);
  assert.equal(lines.length, 1, "there is no overflow line");
  const bands = ["\u001b[44m", "\u001b[42m", "\u001b[41m"];
  for (const band of bands) {
    assert.ok(!(lines[0] ?? "").includes(band), "the header is painted");
  }
});
