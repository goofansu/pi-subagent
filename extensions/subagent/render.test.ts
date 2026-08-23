import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { CollectedRuns } from "./render.ts";
import {
  contentText,
  formatCollectedSummary,
  renderMarkdownResult,
  renderSubagentCall,
} from "./render.ts";

initTheme(undefined, false);

const theme = {
  fg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
} as unknown as Parameters<typeof renderMarkdownResult>[2];

const keyHintStub = (_action: string, description: string) =>
  `ctrl+o ${description}`;

function render(
  content: string,
  expanded: boolean,
  details?: CollectedRuns,
): string {
  return renderMarkdownResult(
    { content, details },
    { expanded, isPartial: false },
    theme,
  )
    .render(80)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join("\n");
}

const oneRun: CollectedRuns = {
  runs: [{ id: "a3f81c2b", agent: "explore", status: "completed" }],
};

function renderCall(prompt: string, expanded: boolean, width = 80): string {
  return renderSubagentCall(
    { agent: "librarian", description: "Say hello", prompt },
    theme as unknown as Parameters<typeof renderSubagentCall>[1],
    { expanded },
  )
    .render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join("\n");
}

// ── The call row ─────────────────────────────────────────────────────────────

test("the prompt is labelled and set apart from the result below", () => {
  const rendered = renderCall("Say hello.", false);

  // Blank lines on both sides are the air between the header, the brief, and
  // the tool result the host paints directly below this row.
  assert.equal(rendered, "librarian Say hello\n\nPrompt: Say hello.\n");
});

test("a cut prompt preview says it was cut", () => {
  const rendered = renderCall("one\ntwo\nthree\nfour\nfive", false);

  assert.equal(rendered, "librarian Say hello\n\nPrompt: one\ntwo\nthree\n…\n");
});

test("an expanded call shows the whole brief", () => {
  const rendered = renderCall("one\ntwo\nthree\nfour", true);

  assert.equal(
    rendered,
    "librarian Say hello\n\nPrompt: one\ntwo\nthree\nfour\n",
  );
});

// ── Extraction ───────────────────────────────────────────────────────────────

test("content arriving as parts reads the same as a plain string", () => {
  assert.equal(
    contentText([
      { type: "text", text: "one " },
      { type: "image" },
      { type: "text", text: "two" },
    ]),
    "one two",
  );
  assert.equal(contentText("plain"), "plain");
});

// ── Expanded ─────────────────────────────────────────────────────────────────

test("an expanded result is rendered as markdown, not as its source", () => {
  const rendered = render("A **bold** finding in `parser.ts`.", true, oneRun);

  assert.doesNotMatch(rendered, /\*\*bold\*\*/);
  assert.doesNotMatch(rendered, /`parser\.ts`/);
  assert.match(rendered, /bold/);
  assert.match(rendered, /parser\.ts/);
});

test("headings and lists become structure rather than punctuation", () => {
  const rendered = render("# Findings\n\n- first\n- second", true, oneRun);

  assert.doesNotMatch(rendered, /^# /m);
  assert.match(rendered, /Findings/);
  assert.match(rendered, /first/);
  assert.match(rendered, /second/);
});

// ── Collapsed ────────────────────────────────────────────────────────────────

test("a collapsed result is one line, not the report", () => {
  const body = `# Findings\n\n${"a long paragraph\n".repeat(40)}`;
  const rendered = render(body, false, oneRun);

  assert.equal(rendered.split("\n").length, 1);
  assert.doesNotMatch(rendered, /a long paragraph/);
  assert.match(rendered, /explore/);
  assert.match(rendered, /a3f81c2b/);
});

test("a collapsed summary names one run, or counts several", () => {
  assert.match(
    formatCollectedSummary(oneRun, 2_400, theme, keyHintStub),
    /explore \(a3f81c2b\) completed · 2\.4k characters/,
  );

  assert.match(
    formatCollectedSummary(
      {
        runs: [
          { id: "a1", agent: "explore", status: "completed" },
          { id: "b2", agent: "reviewer", status: "failed" },
        ],
      },
      5_100,
      theme,
      keyHintStub,
    ),
    /2 reports from explore, reviewer · 5\.1k characters/,
  );
});

test("a fan-out of one agent is counted, not named per run", () => {
  const librarian = (id: string) =>
    ({ id, agent: "librarian", status: "completed" }) as const;

  assert.match(
    formatCollectedSummary(
      { runs: [librarian("a1"), librarian("b2"), librarian("c3")] },
      193,
      theme,
      keyHintStub,
    ),
    /3 librarian reports · 193 characters/,
  );

  assert.match(
    formatCollectedSummary(
      {
        runs: [
          librarian("a1"),
          librarian("b2"),
          { id: "c3", agent: "reviewer", status: "failed" },
        ],
      },
      193,
      theme,
      keyHintStub,
    ),
    /3 reports from librarian ×2, reviewer/,
  );
});

test("a collapsed summary says when runs are still going", () => {
  assert.match(
    formatCollectedSummary(
      { ...oneRun, stillRunning: 2 },
      500,
      theme,
      keyHintStub,
    ),
    /2 still running/,
  );
  assert.doesNotMatch(
    formatCollectedSummary(
      { ...oneRun, stillRunning: 0 },
      500,
      theme,
      keyHintStub,
    ),
    /still running/,
  );
});

test("a result without details falls back to its opening line", () => {
  const rendered = render("first line\nsecond line", false);

  assert.equal(rendered, "first line");
});

test("a result naming no runs falls back rather than saying 0 reports", () => {
  const rendered = render("Nothing to wait for.\nmore", false, { runs: [] });

  assert.equal(rendered, "Nothing to wait for.");
});

test("an empty result renders nothing rather than a stray blank", () => {
  assert.equal(render("   ", false, oneRun), "");
  assert.equal(render("   ", true, oneRun), "");
});
