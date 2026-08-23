import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { contentText, renderMarkdownResult } from "./render.ts";

initTheme(undefined, false);

const theme = {
  fg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
} as unknown as Parameters<typeof renderMarkdownResult>[2];

const options = { expanded: false, isPartial: false };

function render(content: Parameters<typeof contentText>[0]): string {
  return renderMarkdownResult({ content }, options, theme)
    .render(80)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join("\n");
}

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

test("a result is rendered as markdown, not as its source", () => {
  const rendered = render("A **bold** finding in `parser.ts`.");

  // The markers are interpreted rather than printed.
  assert.doesNotMatch(rendered, /\*\*bold\*\*/);
  assert.doesNotMatch(rendered, /`parser\.ts`/);
  assert.match(rendered, /bold/);
  assert.match(rendered, /parser\.ts/);
});

test("headings and lists become structure rather than punctuation", () => {
  const rendered = render("# Findings\n\n- first\n- second");

  assert.doesNotMatch(rendered, /^# /m);
  assert.match(rendered, /Findings/);
  assert.match(rendered, /first/);
  assert.match(rendered, /second/);
});

test("an empty result renders nothing rather than a stray blank", () => {
  assert.equal(render("   "), "");
  assert.equal(render([]), "");
});
