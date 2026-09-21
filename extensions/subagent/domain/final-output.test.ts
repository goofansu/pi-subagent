import assert from "node:assert/strict";
import test from "node:test";
import { interpretFinalOutput } from "./final-output.ts";

const truncation = (truncatedOutputBytes: number) => ({
  truncatedOutputBytes,
});

test("final-output interpretation states retention and supporting evidence together", () => {
  assert.deepEqual(
    interpretFinalOutput({
      finalOutput: "",
      transcript: [],
      truncation: truncation(0),
    }),
    { kind: "absent", hasTranscriptEvidence: false },
  );

  assert.deepEqual(
    interpretFinalOutput({
      finalOutput: "the answer",
      transcript: [],
      truncation: truncation(0),
    }),
    {
      kind: "retained",
      output: "the answer",
      hasTranscriptEvidence: false,
    },
  );

  assert.deepEqual(
    interpretFinalOutput({
      finalOutput: "answer pre",
      transcript: [
        { role: "assistant", parts: [{ kind: "text", text: "work remains" }] },
      ],
      truncation: truncation(7),
    }),
    {
      kind: "retained-prefix",
      removedBytes: 7,
      output: "answer pre",
      hasTranscriptEvidence: true,
    },
  );

  assert.deepEqual(
    interpretFinalOutput({
      finalOutput: "",
      transcript: [
        {
          role: "assistant",
          parts: [{ kind: "tool_call", name: "search", callId: "call-1" }],
        },
      ],
      truncation: truncation(11),
    }),
    {
      kind: "removed",
      removedBytes: 11,
      hasTranscriptEvidence: true,
    },
  );
});

test("whitespace and empty text are not evidence, while a tool call is", () => {
  assert.deepEqual(
    interpretFinalOutput({
      finalOutput: " \n\t ",
      transcript: [
        { role: "assistant", parts: [{ kind: "text", text: "" }] },
        { role: "tool", parts: [{ kind: "text", text: " \n " }] },
      ],
      truncation: truncation(0),
    }),
    { kind: "absent", hasTranscriptEvidence: false },
  );

  assert.equal(
    interpretFinalOutput({
      finalOutput: "",
      transcript: [
        { role: "assistant", parts: [{ kind: "tool_call", name: "read" }] },
      ],
      truncation: truncation(0),
    }).hasTranscriptEvidence,
    true,
  );
});
