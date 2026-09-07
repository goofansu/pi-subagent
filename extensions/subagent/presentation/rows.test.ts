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
  type RenderableTheme,
  ROW_DELIMITER,
  renderRunRows,
} from "./rows.ts";

const theme: RenderableTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  inverse: (text) => text,
};
const SGR: Record<string, number> = {
  dim: 2,
  muted: 90,
  text: 37,
  warning: 33,
  error: 31,
  success: 32,
  accent: 36,
  toolTitle: 35,
};
const BG: Record<string, number> = {
  toolPendingBg: 44,
  toolSuccessBg: 42,
  toolErrorBg: 41,
};
const paint = (color: string, text: string) =>
  `\u001b[${SGR[color] ?? 39}m${text}\u001b[0m`;
const bold = (text: string) => `\u001b[1m${text}\u001b[22m`;
const italic = (text: string) => `\u001b[3m${text}\u001b[23m`;
const inverse = (text: string) => `\u001b[7m${text}\u001b[27m`;
const named: RenderableTheme = {
  fg: paint,
  bg: (color, text) => `\u001b[${BG[color] ?? 49}m${text}\u001b[49m`,
  bold,
  italic,
  inverse,
};
function row(
  width: number,
  overrides: Parameters<typeof fixtureRow>[0] = {},
  now = FIXTURE_NOW,
) {
  return stripVTControlCharacters(
    formatRunRow(fixtureRow(overrides), theme, width, now),
  )
    .trimEnd()
    .replace(/ {2,}/g, "  ");
}
function widget(
  rows: Parameters<typeof renderRunRows>[0],
  width = 120,
  paintTheme = theme,
) {
  return renderRunRows(rows, paintTheme, width, FIXTURE_NOW);
}

test("wide detail shows only Label, state, activity and elapsed", () => {
  const line = row(120, { activity: "bash: npm test" });
  assert.equal(ROW_DELIMITER, "  ");
  assert.equal(line, "look around  running · bash: npm test  12.4s");
  assert.doesNotMatch(line, /ago|explore|run-1|subagent-1|turns|pi/);
});

test("elapsed uses Run start, not activity timestamps, and shared duration vocabulary", () => {
  const active = {
    activity: "bash: npm test",
    lastActivity: { summary: "bash: npm test", changedAt: 12_000 },
  };
  for (const [now, duration] of [
    [13_449, "12.4s"],
    [63_000, "1m 2s"],
    [3_661_000, "1h 1m"],
    [500, "0.0s"],
  ] as const) {
    assert.equal(
      row(120, active, now),
      `look around  running · bash: npm test  ${duration}`,
    );
  }
});

test("elapsed remains through absent, cleared, mismatched, finalizing and cancelling activity", () => {
  const retained = { summary: "old work", changedAt: 12_000 };
  for (const overrides of [
    {},
    { lastActivity: retained },
    { activity: undefined, lastActivity: retained },
  ]) {
    assert.equal(row(120, overrides), "look around  running · —  12.4s");
  }
  assert.equal(
    row(120, { activity: "new work", lastActivity: retained }),
    "look around  running · new work  12.4s",
  );
  assert.equal(
    row(120, {
      phase: "finalizing",
      activity: "old work",
      lastActivity: retained,
    }),
    "look around  finalizing · —  12.4s",
  );
  assert.equal(
    row(120, { cancellation: { reason: "requested" }, activity: "old work" }),
    "look around  cancelling · —  12.4s",
  );
  for (const phase of ["completed", "failed", "cancelled"] as const) {
    assert.equal(
      row(120, { phase }, 99_000),
      `look around  ${phase} · —  12.4s`,
    );
    assert.equal(
      row(120, { phase, settledAt: undefined }, 99_000),
      `look around  ${phase} · —  —`,
    );
  }
});

test("labels share history's 40-column ellipsis cap including wide Unicode", () => {
  for (const [label, expected] of [
    ["L".repeat(40), "L".repeat(40)],
    ["L".repeat(41), `${"L".repeat(39)}…`],
    ["界".repeat(21), `${"界".repeat(19)}…`],
  ])
    assert.equal(
      row(120, { identity: { description: label } }),
      `${expected}  running · —  12.4s`,
    );
});

test("activity truncates for elapsed, which hides only below the useful activity boundary", () => {
  const active = { activity: "bash: npm test" };
  assert.equal(row(44, active), "look around  running · bash: npm test  12.4s");
  assert.equal(row(43, active), "look around  running · bash: npm te…  12.4s");
  assert.equal(row(38, active), "look a…  running · bash: npm t…  12.4s");
  assert.equal(row(37, active), "look around  running · bash: npm test");
  assert.equal(row(33, active), "look aro…  running · bash: npm t…");
  assert.equal(row(31, active), "look a…  running · bash: npm t…");
  for (let width = 20; width < 31; width++)
    assert.equal(row(width, active), "look around  running");
});

test("long Labels shrink to preserve status and useful activity", () => {
  const active = {
    identity: { description: "a-very-long-work-label" },
    activity: "bash: npm test",
  };
  assert.equal(row(29, active), "a-very-long-work-la…  running");
  assert.equal(row(31, active), "a-very…  running · bash: npm t…");
  assert.equal(row(20, { identity: active.identity }), "a-very…  running · —");
});

test("turn counts and arbitrary backends never appear even with abundant space", () => {
  for (const turns of [0, 1, 3, 100]) {
    const active = {
      identity: { backendId: backendId("custom-backend") },
      tools: 4,
      usage: fixtureUsage({
        turns,
        context: { tokens: 84_000, window: 200_000 },
      }),
    };
    assert.equal(row(240, active), "look around  running · —  12.4s");
    assert.equal(
      row(240, { ...active, activity: "bash: npm test" }),
      "look around  running · bash: npm test  12.4s",
    );
  }
});

test("elapsed ends at the matching one-cell right inset for plain, styled and wide Unicode rows", () => {
  for (const paintTheme of [theme, named]) {
    for (const [fixture, left, gap] of [
      [
        fixtureRow({ activity: "bash: npm test" }),
        " look around  running · bash: npm test",
        36,
      ],
      [
        fixtureRow({ identity: { description: "探索" }, activity: "読む資料" }),
        " 探索  running · 読む資料",
        49,
      ],
    ] as const) {
      const line = widget([fixture], 80, paintTheme)[1];
      const plain = stripVTControlCharacters(line);
      assert.equal(plain, `${left}${" ".repeat(gap)}12.4s `);
      assert.equal(visibleWidth(line), 80);
      assert.equal(visibleWidth(plain.slice(0, plain.indexOf("12.4s"))), 74);
      assert.match(plain, /^ \S/);
      assert.match(plain, /12\.4s $/);
    }
  }
});

test("identical inputs produce the same styled presentation", () => {
  const expected =
    [paint("toolTitle", bold("look around")), paint("warning", "running")].join(
      ROW_DELIMITER,
    ) +
    ` ${paint("dim", "·")} ` +
    paint("muted", "bash: npm test") +
    " ".repeat(78) +
    paint("dim", "12.4s");
  for (let i = 0; i < 2; i++)
    assert.equal(
      formatRunRow(
        fixtureRow({ activity: "bash: npm test" }),
        named,
        120,
        FIXTURE_NOW,
      ),
      expected,
    );
});

test("activity separator is absent when its placeholder or activity is too narrow", () => {
  for (const paintTheme of [theme, named]) {
    for (const [fixture, width] of [
      [fixtureRow(), 19],
      [fixtureRow({ activity: "old work", phase: "finalizing" }), 22],
      [
        fixtureRow({
          activity: "old work",
          cancellation: { reason: "requested" },
        }),
        22,
      ],
      [fixtureRow({ activity: "bash: npm test" }), 30],
    ] as const) {
      const text = stripVTControlCharacters(
        formatRunRow(fixture, paintTheme, width, FIXTURE_NOW),
      );
      assert.doesNotMatch(text, /·/);
    }
  }
});

test("missing or cleared running activity shows a muted nonitalic em dash placeholder with a dim dot", () => {
  for (const overrides of [
    {},
    { activity: "" },
    {
      activity: undefined,
      lastActivity: { summary: "old work", changedAt: 1_000 },
    },
  ]) {
    const rendered = formatRunRow(
      fixtureRow(overrides),
      named,
      80,
      FIXTURE_NOW,
    );
    assert.equal(
      rendered,
      paint("toolTitle", bold("look around")) +
        ROW_DELIMITER +
        paint("warning", "running") +
        ` ${paint("dim", "·")} ` +
        paint("muted", "—") +
        " ".repeat(51) +
        paint("dim", "12.4s"),
    );
    assert.doesNotMatch(rendered, /old work/);
    assert.ok(!rendered.includes("\u001b[3m"));
  }
});

test("row status text and tone follow the shared cancellation presentation", () => {
  for (const [overrides, state, tone] of [
    [
      { cancellation: { reason: "requested" as const } },
      "cancelling",
      "warning",
    ],
    [
      {
        phase: "finalizing" as const,
        cancellation: { reason: "shutdown" as const },
      },
      "cancelling",
      "warning",
    ],
    [
      {
        phase: "cancelled" as const,
        cancellation: { reason: "requested" as const },
      },
      "cancelled",
      "muted",
    ],
    [
      {
        phase: "cancelled" as const,
        cancellation: { reason: "shutdown" as const },
      },
      "cancelled",
      "muted",
    ],
    [
      {
        phase: "cancelled" as const,
        cancellation: { reason: "timeout" as const },
      },
      "cancelled",
      "error",
    ],
  ] as const) {
    const calls: { color: string; text: string }[] = [];
    formatRunRow(
      fixtureRow(overrides),
      {
        ...theme,
        fg: (color, text) => {
          calls.push({ color, text });
          return text;
        },
      },
      80,
      FIXTURE_NOW,
    );
    assert.ok(calls.some((call) => call.color === tone && call.text === state));
  }
});

test("finalizing and cancelling show a styled placeholder rather than retained activity", () => {
  for (const [fixture, state] of [
    [fixtureRow({ phase: "finalizing", activity: "old work" }), "finalizing"],
    [
      fixtureRow({
        cancellation: { reason: "requested" },
        activity: "old work",
      }),
      "cancelling",
    ],
  ] as const) {
    assert.equal(
      formatRunRow(fixture, named, 80, FIXTURE_NOW),
      paint("toolTitle", bold("look around")) +
        ROW_DELIMITER +
        paint("warning", state) +
        ` ${paint("dim", "·")} ` +
        paint("muted", "—") +
        " ".repeat(48) +
        paint("dim", "12.4s"),
    );
  }
});

test("placeholder rows keep symmetric padding and fit plain, styled and wide Unicode widths", () => {
  for (const paintTheme of [theme, named]) {
    for (const description of ["look around", "探索".repeat(30)]) {
      for (let width = 0; width <= 120; width++) {
        const line = widget(
          [fixtureRow({ identity: { description } })],
          width,
          paintTheme,
        )[1];
        const plain = stripVTControlCharacters(line);
        assert.ok(visibleWidth(line) <= width);
        if (plain.includes("·")) assert.match(plain, / · —/);
        if (plain.includes("12.4s")) {
          assert.match(plain, /^ \S/);
          assert.match(plain, /12\.4s $/);
          assert.equal(visibleWidth(line), width);
        }
      }
    }
  }
});

test("very narrow rows keep a Label prefix without an empty delimiter", () => {
  for (const [width, expected] of [
    [0, ""],
    [1, "…"],
    [2, "l…"],
    [7, "look a…"],
    [9, "look aro…"],
    [10, "…  running"],
  ] as const) {
    const styled = formatRunRow(
      fixtureRow({ activity: "bash: npm test" }),
      named,
      width,
      FIXTURE_NOW,
    );
    assert.equal(stripVTControlCharacters(styled), expected);
    assert.ok(visibleWidth(styled) <= width);
  }
});

test("ASCII and wide Unicode widgets fit every plain and styled terminal width", () => {
  for (const fixture of [
    fixtureRow({ activity: "reading source" }),
    fixtureRow({
      identity: { description: "界".repeat(80) },
      activity: "読む資料",
    }),
  ]) {
    for (let width = 0; width <= 120; width++)
      for (const paintTheme of [theme, named]) {
        const lines = widget([fixture], width, paintTheme);
        assert.equal(lines.length, 2);
        for (const line of lines)
          assert.ok(visibleWidth(line) <= width, `width ${width}`);
        if (width === 120)
          assert.match(
            stripVTControlCharacters(lines[1]),
            /(?:reading source|読む資料) +12\.4s/,
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
  assert.deepEqual(
    widget(rows, 80).map((line) => stripVTControlCharacters(line).trimEnd()),
    [" subagents   2 running"],
  );
});

test("narrow unresolved terminal attention stays compact beside essential active detail", () => {
  const rows = [
    fixtureRow({
      identity: { agent: "explore", description: "supplementary label" },
      activity: "bash: npm test",
    }),
    fixtureRow({ phase: "completed", handoff: "exhausted" }),
  ];
  const lines = widget(rows, 33, named);
  assert.equal(lines.length, 2);
  assert.match(stripVTControlCharacters(lines[0]), /^! 1 notification failed/);
  assert.match(
    stripVTControlCharacters(lines[1]),
    /^ supple… {2}running · bash: npm/,
  );
  assert.doesNotMatch(
    stripVTControlCharacters(lines[1]),
    /pi|supplementary|explore/,
  );
  for (const line of lines) assert.ok(visibleWidth(line) <= 33);
});

test("unresolved terminal Runs contribute only summary beside one active Run", () => {
  const rows = [
    fixtureRow({ identity: { agent: "explore" } }),
    fixtureRow({ identity: { agent: "reviewer" }, phase: "completed" }),
  ];
  assert.deepEqual(
    widget(rows, 80).map((line) => stripVTControlCharacters(line).trimEnd()),
    [
      " subagents   1 running   1 completed",
      ` look around  running · —${" ".repeat(49)}12.4s`,
    ],
  );
  assert.deepEqual(
    widget([fixtureRow(), fixtureRow({ phase: "finalizing" })], 80).map(
      (line) => stripVTControlCharacters(line).trimEnd(),
    ),
    [" subagents   1 running   1 finalizing"],
  );
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
  const [header = ""] = widget(rows, 100, named);
  assert.equal(
    header,
    ` ${paint("accent", bold("subagents"))}  ${inverse(paint("warning", " 1 running "))} ${inverse(paint("error", " 1 failed "))}`,
  );
  assert.doesNotMatch(header, /─/);
  const plain = stripVTControlCharacters(widget(rows, 100)[0] ?? "");
  assert.equal(plain, " subagents   1 running   1 failed ");
  assert.doesNotMatch(plain, /tokens|\$/);
});

test("the header shortens rather than wraps on a narrow terminal", () => {
  const rows = [fixtureRow(), fixtureRow({ phase: "failed" })];
  const at = (width: number) =>
    stripVTControlCharacters(widget(rows, width)[0] ?? "");
  assert.equal(at(40), " subagents   1 running   1 failed ");
  assert.ok(visibleWidth(at(20)) <= 20);
  assert.match(at(20), /^ subagents/);
});

test("a large fan-out has no overflow list", () => {
  const rows = Array.from({ length: 10 }, (_unused, index) =>
    fixtureRow({ identity: { agent: `agent-${index}` } }),
  );
  assert.deepEqual(
    widget(rows, 80).map((line) => stripVTControlCharacters(line).trimEnd()),
    [" subagents   10 running"],
  );
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
  const lines = widget(rows, 240);
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
      const lines = widget(rows, width, named);
      assert.equal(lines.length, 1);
      assert.ok(visibleWidth(lines[0]) <= width, `width ${width}`);
      if (width > 0 && width <= 40)
        assert.match(stripVTControlCharacters(lines[0]), /^!/);
    }
  }
  const wideText = fixtureRow({
    identity: {
      agent: "探索探索探索探索探索探索",
      description: "界".repeat(80),
    },
    activity: "読む".repeat(40),
  });
  for (const width of [0, 1, 2, 8, 20, 80])
    for (const line of widget([wideText], width, named))
      assert.ok(visibleWidth(line) <= width, `single width ${width}`);
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
        const [line] = widget(rows, fittingWidth, paintTheme);
        assert.equal(stripVTControlCharacters(line), full);
        if (paintTheme === named)
          assert.ok(line.includes("\u001b[7m"), "full header retains chips");
      }
      const [overflow] = widget(rows, width - 1, paintTheme);
      assert.equal(stripVTControlCharacters(overflow), compact);
      assert.ok(!overflow.includes("\u001b[7m"), "overflow drops chip framing");
      assert.ok(visibleWidth(overflow) <= width - 1);
    }
  }
});

test("an empty list renders nothing at all", () => {
  assert.deepEqual(widget([], 80), []);
});

// ── Bands ────────────────────────────────────────────────────────────────────

test("only the active detail is painted as a band", () => {
  const rows = [
    fixtureRow({ identity: { agent: "live" } }),
    fixtureRow({ identity: { agent: "done" }, phase: "completed" }),
    fixtureRow({ identity: { agent: "broke" }, phase: "failed" }),
    fixtureRow({ identity: { agent: "stopped" }, phase: "cancelled" }),
  ];
  const lines = widget(rows, 60, named);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith("\u001b[44m"), "a live row is pending");
  for (const line of lines.slice(1)) {
    assert.equal(visibleWidth(line), 60);
    assert.ok(line.endsWith("\u001b[49m"));
  }
});

test("a band survives a full reset inside its text", () => {
  const rows = [
    fixtureRow({
      identity: {
        description:
          "a label long enough to be cut off by the width it is given",
      },
    }),
  ];
  const [, line = ""] = widget(rows, 60, named);
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
  const [, line = ""] = widget(rows, 60, named);
  const plain = stripVTControlCharacters(line);
  assert.equal(visibleWidth(plain), 60);
  assert.match(plain, /^ \S/);
  // Whole optional fields can leave more padding than the minimum inset.
  assert.match(plain, /\S +$/);
});

test("the aggregate summary is not a band", () => {
  const rows = Array.from({ length: 4 }, (_unused, index) =>
    fixtureRow({ identity: { agent: `agent-${index}` } }),
  );
  const lines = widget(rows, 60, named);
  assert.equal(lines.length, 1, "there is no overflow line");
  for (const band of ["\u001b[44m", "\u001b[42m", "\u001b[41m"])
    assert.ok(!(lines[0] ?? "").includes(band), "the header is painted");
});
