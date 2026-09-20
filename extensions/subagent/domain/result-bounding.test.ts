import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureResult } from "../testing/presentation-fixtures.ts";
import { byteLength } from "./bounding.ts";
import { cancelledEnding, failedEnding, type RunEnding } from "./endings.ts";
import type { RunResult } from "./result.ts";
import { boundResultToBytes, encodedResultBytes } from "./result-bounding.ts";

const answer = "UNIQUE retained answer";
const textItem = (text: string) => ({
  role: "assistant" as const,
  parts: [{ kind: "text" as const, text }],
});

function evidenceResult(ending?: RunEnding): RunResult {
  return fixtureResult({
    ending,
    finalOutput: answer,
    transcript: [
      ...Array.from({ length: 16 }, (_, index) =>
        textItem(`support-${index}-${"t".repeat(300)}`),
      ),
      textItem(answer),
    ],
    tools: Array.from({ length: 4 }, (_, index) => ({
      name: `tool-${index}`,
      callId: `call-${index}`,
      status: "completed" as const,
      outputSummary: `summary-${index}-${"s".repeat(500)}`,
    })),
    links: [
      {
        kind: "url",
        label: "evidence",
        target: "https://example.com/evidence",
      },
    ],
    diagnostics: [{ category: "other", message: "supporting diagnostic" }],
  });
}

function toolOutputBytes(result: RunResult): number {
  return result.tools.reduce(
    (total, tool) => total + byteLength(tool.outputSummary ?? ""),
    0,
  );
}

function withoutToolSummaries(result: RunResult): RunResult {
  const removed = toolOutputBytes(result);
  return {
    ...result,
    tools: result.tools.map(
      ({ outputSummary: _outputSummary, ...tool }) => tool,
    ),
    truncation: {
      ...result.truncation,
      truncatedToolOutputBytes:
        result.truncation.truncatedToolOutputBytes + removed,
    },
  };
}

test("an already fitting Result is returned unchanged", () => {
  const candidate = evidenceResult();
  const bounded = boundResultToBytes(candidate, encodedResultBytes(candidate));

  assert.equal(bounded.result, candidate);
  assert.equal(bounded.bounded, false);
  assert.equal(bounded.bytes, encodedResultBytes(candidate));
});

test("supporting evidence is discarded in order before the final output", () => {
  const candidate = evidenceResult();
  const summariesRemoved = withoutToolSummaries(candidate);
  const afterSummaries = boundResultToBytes(
    candidate,
    encodedResultBytes(summariesRemoved),
  );

  assert.equal(afterSummaries.result.finalOutput, answer);
  assert.deepEqual(afterSummaries.result.transcript, candidate.transcript);
  assert.deepEqual(afterSummaries.result.tools, summariesRemoved.tools);
  assert.deepEqual(afterSummaries.result.links, candidate.links);
  assert.deepEqual(afterSummaries.result.diagnostics, candidate.diagnostics);

  const newestTranscript = {
    ...summariesRemoved,
    transcript: candidate.transcript.slice(9),
    truncation: {
      ...summariesRemoved.truncation,
      droppedTranscriptItems: 9,
    },
  } satisfies RunResult;
  const afterOldestTranscript = boundResultToBytes(
    candidate,
    encodedResultBytes(newestTranscript),
  );
  assert.deepEqual(
    afterOldestTranscript.result.transcript,
    candidate.transcript.slice(9),
  );
  assert.deepEqual(afterOldestTranscript.result.tools, summariesRemoved.tools);
  assert.deepEqual(afterOldestTranscript.result.links, candidate.links);
  assert.deepEqual(
    afterOldestTranscript.result.diagnostics,
    candidate.diagnostics,
  );
  assert.equal(afterOldestTranscript.result.finalOutput, answer);

  const answerAndMandatory = {
    ...summariesRemoved,
    transcript: [],
    tools: [],
    links: [],
    diagnostics: [],
    truncation: {
      ...summariesRemoved.truncation,
      droppedTranscriptItems:
        summariesRemoved.truncation.droppedTranscriptItems +
        candidate.transcript.length,
      droppedToolEntries:
        summariesRemoved.truncation.droppedToolEntries + candidate.tools.length,
      droppedLinks:
        summariesRemoved.truncation.droppedLinks + candidate.links.length,
      droppedDiagnostics:
        summariesRemoved.truncation.droppedDiagnostics +
        candidate.diagnostics.length,
    },
  } satisfies RunResult;
  const bounded = boundResultToBytes(
    candidate,
    encodedResultBytes(answerAndMandatory),
  );

  assert.ok(bounded.bytes <= encodedResultBytes(answerAndMandatory));
  assert.equal(bounded.result.finalOutput, answer);
  assert.deepEqual(bounded.result.transcript, []);
  assert.deepEqual(bounded.result.tools, []);
  assert.deepEqual(bounded.result.links, []);
  assert.deepEqual(bounded.result.diagnostics, []);
  assert.equal(bounded.result.truncation.truncatedOutputBytes, 0);
  assert.equal(
    bounded.result.truncation.truncatedToolOutputBytes,
    summariesRemoved.truncation.truncatedToolOutputBytes,
  );
  assert.equal(
    bounded.result.truncation.droppedTranscriptItems,
    candidate.transcript.length,
  );
  assert.equal(
    bounded.result.truncation.droppedToolEntries,
    candidate.tools.length,
  );
  assert.equal(bounded.result.truncation.droppedLinks, candidate.links.length);
  assert.equal(
    bounded.result.truncation.droppedDiagnostics,
    candidate.diagnostics.length,
  );
});

for (const [name, ending] of [
  ["completed", undefined],
  ["failed", failedEnding("failure stays visible")],
  ["cancelled", cancelledEnding("requested")],
] as const) {
  test(`${name} Results retain their answer ahead of a Transcript copy`, () => {
    const candidate = evidenceResult(ending);
    const mandatoryWithAnswer = fixtureResult({
      ending,
      finalOutput: answer,
      truncation: {
        truncatedToolOutputBytes: toolOutputBytes(candidate),
        droppedTranscriptItems: candidate.transcript.length,
        droppedToolEntries: candidate.tools.length,
        droppedLinks: candidate.links.length,
        droppedDiagnostics: candidate.diagnostics.length,
      },
    });
    const bounded = boundResultToBytes(
      candidate,
      encodedResultBytes(mandatoryWithAnswer),
    );

    assert.equal(bounded.result.status, name);
    assert.equal(bounded.result.finalOutput, answer);
    assert.equal(bounded.result.truncation.truncatedOutputBytes, 0);
    if (name === "failed")
      assert.equal(bounded.result.errorMessage, "failure stays visible");
    if (name === "cancelled")
      assert.equal(bounded.result.cancellationReason, "requested");
  });
}

test("an oversized multibyte answer keeps a valid prefix and cumulative accounting", () => {
  const output = "é🙂漢".repeat(80);
  const preexisting = 97;
  const candidate = fixtureResult({
    finalOutput: output,
    truncation: { truncatedOutputBytes: preexisting },
  });
  const allOutputRemoved = fixtureResult({
    finalOutput: "",
    truncation: {
      truncatedOutputBytes: preexisting + byteLength(output),
    },
  });
  const maxBytes = encodedResultBytes(allOutputRemoved) + 31;

  const first = boundResultToBytes(candidate, maxBytes);
  const second = boundResultToBytes(candidate, maxBytes);
  assert.deepEqual(second, first);
  assert.ok(first.bytes <= maxBytes);
  assert.ok(first.result.finalOutput.length > 0);
  assert.ok(output.startsWith(first.result.finalOutput));
  assert.equal(first.result.finalOutput.includes("�"), false);
  assert.equal(
    byteLength(first.result.finalOutput) +
      first.result.truncation.truncatedOutputBytes,
    byteLength(output) + preexisting,
  );

  const rebound = boundResultToBytes(first.result, maxBytes);
  assert.equal(rebound.result, first.result);
  assert.equal(rebound.bounded, false);
  assert.equal(
    rebound.result.truncation.truncatedOutputBytes,
    first.result.truncation.truncatedOutputBytes,
  );
});

test("mandatory fields remain honest when they alone exceed the byte target", () => {
  const output = "answer that must be removed";
  const candidate = fixtureResult({ finalOutput: output });
  const mandatory = fixtureResult({
    finalOutput: "",
    truncation: { truncatedOutputBytes: byteLength(output) },
  });
  const maxBytes = encodedResultBytes(mandatory) - 1;
  const bounded = boundResultToBytes(candidate, maxBytes);

  assert.equal(bounded.result.finalOutput, "");
  assert.equal(
    bounded.result.truncation.truncatedOutputBytes,
    byteLength(output),
  );
  assert.equal(bounded.result.runId, candidate.runId);
  assert.equal(bounded.result.status, "completed");
  assert.equal(bounded.bytes, encodedResultBytes(bounded.result));
  assert.ok(bounded.bytes > maxBytes);
});
