// Live protocol smoke for the Codex adapter. Drives the SHIPPED transport and
// translator against a real `codex app-server` and asserts the contract:
// streamed command output, usage folding, the terminal-answer latch, semantic
// completion, and interrupt settlement. Run manually (spends real quota):
//
//   node --import tsx scripts/codex-live-smoke.mjs
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexAppServerSource } from "../extensions/subagent/harnesses/codex/app-server.ts";
import { createCodexTranslator } from "../extensions/subagent/harnesses/codex/harness.ts";

const cwd = mkdtempSync(path.join(tmpdir(), "codex-live-smoke-"));
const failures = [];
function check(name, condition) {
  console.log(`  ${condition ? "ok" : "FAIL"} — ${name}`);
  if (!condition) failures.push(name);
}

async function runTurn(name, prompt, hooks = {}) {
  console.log(`\n=== ${name} ===`);
  const source = createCodexAppServerSource({ cwd, childDepth: 1, prompt });
  const translate = createCodexTranslator(cwd);
  const observed = {
    methods: new Map(),
    activities: [],
    facts: [],
    terminal: false,
    turnStatus: undefined,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    console.log("timeout — aborting");
    controller.abort();
  }, 240_000);
  const conclusion = await source(
    {
      event: (event) => {
        observed.methods.set(
          event.method,
          (observed.methods.get(event.method) ?? 0) + 1,
        );
        if (event.method === "turn/completed")
          observed.turnStatus = event.params.turn.status;
        hooks.onEvent?.(event, controller);
        const translation = translate(event);
        if (translation && "activity" in translation)
          observed.activities.push(translation.activity);
        if (translation?.facts) observed.facts.push(...translation.facts);
        if (translation?.terminal === true) {
          observed.terminal = true;
          return true;
        }
        return undefined;
      },
      stderr: (chunk) => {
        const text = chunk.trim();
        if (text) console.log("  [stderr]", text.slice(0, 160));
      },
    },
    controller.signal,
  ).finally(() => clearTimeout(timeout));
  observed.conclusion = conclusion;
  console.log(
    "  methods:",
    [...observed.methods].map(([m, c]) => `${m} x${c}`).join(", "),
  );
  return observed;
}

const answer = await runTurn(
  "answer turn with streamed command output",
  "Run this exact shell command: `for i in 1 2 3; do echo line-$i; sleep 1; done`. Then reply with exactly one word: pong",
);
check("settles clean", answer.conclusion?.status === "clean");
check("turn/completed status is completed", answer.turnStatus === "completed");
check("terminal answer latched", answer.terminal);
check(
  "agent message deltas accepted",
  (answer.methods.get("item/agentMessage/delta") ?? 0) > 0,
);
check(
  "command output deltas accepted",
  (answer.methods.get("item/commandExecution/outputDelta") ?? 0) > 0,
);
check(
  "command output line surfaced as activity",
  answer.activities.some((a) => typeof a === "string" && a.includes("· line-")),
);
const usage = answer.facts.find((f) => f.usage && f.usage.turns === 1)?.usage;
check("usage delta folded with provider turn", usage !== undefined);
check("context gauge forwarded", (usage?.contextTokens ?? 0) > 0);
check(
  "final assistant text captured",
  answer.facts.some(
    (f) =>
      f.role === "assistant" &&
      f.parts.some((p) => p.type === "text" && /pong/i.test(p.text)),
  ),
);
check("activity cleared at settlement", answer.activities.at(-1) === null);

let interrupted = false;
const interrupt = await runTurn(
  "interrupt mid-command",
  "Run this exact shell command: `sleep 45 && echo finished`",
  {
    onEvent: (event, controller) => {
      if (
        !interrupted &&
        event.method === "item/started" &&
        event.params.item.type === "commandExecution"
      ) {
        interrupted = true;
        console.log("  command started — aborting in 2s");
        setTimeout(() => controller.abort(), 2000);
      }
    },
  },
);
check("interrupt settles clean", interrupt.conclusion?.status === "clean");
check(
  "turn/completed status is interrupted",
  interrupt.turnStatus === "interrupted",
);

console.log(
  failures.length === 0
    ? "\nPASS — live protocol contract holds"
    : `\nFAIL — ${failures.length} assertion(s): ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
