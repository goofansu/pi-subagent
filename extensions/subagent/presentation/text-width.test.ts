import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fitToWidth } from "./text-width.ts";

test("terminal text fitting handles zero and negative widths and optional padding", () => {
  assert.equal(fitToWidth("look around", 40), "look around");
  assert.equal(fitToWidth("look around", 7, { plain: true }), "look a…");
  assert.equal(fitToWidth("look around", 0), "");
  assert.equal(fitToWidth("look around", -5), "");
  assert.equal(fitToWidth("ab", 5, { pad: true }), "ab   ");
  assert.equal(fitToWidth("abcdef", 3, { pad: true, plain: true }), "ab…");
});

test("terminal text fitting measures ANSI, wide characters, combining marks, and emoji by cells", () => {
  const painted = `\u001b[2m${"a".repeat(50)}\u001b[0m`;
  assert.equal(visibleWidth(fitToWidth(painted, 10)), 10);
  assert.equal(visibleWidth(fitToWidth("界".repeat(9), 5, { pad: true })), 5);

  for (const text of ["café".repeat(20), "👩‍💻".repeat(20)]) {
    const fitted = fitToWidth(text, 7, { pad: true });
    assert.equal(visibleWidth(fitted), 7);
    assert.doesNotMatch(fitted, /�/);
  }
});

test("terminal text fitting clips only at complete grapheme boundaries", () => {
  assert.equal(fitToWidth("e\u0301xy", 2, { plain: true }), "e\u0301…");
  assert.equal(fitToWidth("👩‍💻xy", 2, { plain: true }), "…");
  assert.equal(fitToWidth("👩‍💻xy", 3, { plain: true }), "👩‍💻…");
});

test("plain fitting discards clipping resets while painted fitting retains ANSI", () => {
  const painted = `\u001b[2m${"a".repeat(50)}\u001b[0m`;
  assert.ok(!fitToWidth(painted, 10, { plain: true }).includes("\u001b"));
  assert.ok(fitToWidth(painted, 10).includes("\u001b"));
});
