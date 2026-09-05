# pi-subagent

Delegate tasks to specialised subagents with isolated context windows in Pi.

Each subagent is defined by a Profile that names a **backend** — `pi` or
`claude` — and each backend keeps its own model, tools, configuration, and
conversation semantics. A small Effect supervisor owns the lifetimes above
them: it starts and stops work, normalises what each backend reports into one
bounded read model, and delivers progress and immutable results through one
UI.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

Upgrading from 1.x? One line per Profile changes — see
[Upgrading from 1.x](#upgrading-from-1x).

## Commands and tools

`/subagent` is the one place to start. On its own it prints a short status:
how many Profiles are loaded, how many Runs are running and how they ended,
one line per Profile with the backend it names, and the way deeper.

`/subagent profiles` lists loaded Profiles, shows their prompts, and hands one
a task. With none configured, it prints the directory to add one to.

1.x's `/agents` is **removed in 2.0**. Its flow is `/subagent profiles`, key
for key — the filter, the prompt view and the work action are unchanged — so
what moved is the name. It is the one public surface 2.0 removes.

Delegation uses six tools. `agent_start` creates a stable, Session-scoped
Subagent and immediately starts its first **Run**. The Run is detached from the
turn that started it and settles exactly once, so starting work and retrieving
its answer are separate steps:

| Tool | What it does |
| --- | --- |
| `agent_start` | Creates a Subagent, starts its first Run, and returns distinct Subagent and Run ids immediately. Takes `agent`, `description`, and `prompt`; the Profile decides the model, effort, and tools. |
| `agent_resume` | Takes an idle Subagent id with a new `description` and `prompt`, starts a distinct Run, and returns its Run id rather than an answer. It never queues behind an active Run. |
| `agent_wait` | Waits for named Runs to become terminal and returns lifecycle state only — never output. Takes an optional `timeoutSeconds`. Waiting never suppresses a notification or consumes a Result. |
| `agent_cancel` | Stops named Runs. Partial output survives, and each Run still sends its own completion notice. |
| `agent_steer` | Offers bounded guidance to an active Run. Acceptance means local mailbox admission and nothing more. |
| `agent_result` | Reads a finished Run's authoritative full output by id. |

**The Subagent id is only for `agent_resume`.** `agent_wait`, `agent_result`,
`agent_cancel`, and `agent_steer` all take the Run id that `agent_start` or
`agent_resume` returned. They are deliberately different identifiers: one names
the specialist, the other names one unit of work.

Every terminal output is stored under its Run id and records its owning
Subagent for orientation. A small completion notice names both identities and
is pushed independently of the Result — delivery failure never affects
retrieval.

`agent_resume` continues the Subagent's retained conversation. Both backends
support it. If the conversation is irrecoverably lost, resume starts
no Run and no provider work, and says to start a new Subagent instead.

### Steering an active Run

Call `agent_steer` with a Run id and one guidance message. An `accepted`
response is deliberately narrow: **the complete message entered that Run's
bounded local mailbox, synchronously, and that is all it means.** It does not
mean the backend dequeued it, the provider accepted it, or the model consumed
it — so do not resend accepted guidance in a retry loop. Only a
provider-confirmed correlated user item becomes transcript truth in the Result.

Each steering-capable Run accepts at most 16 pending messages, 16 KiB of UTF-8
per message, and 64 KiB pending in total. Whitespace-only or oversize text is
`invalid`; saturation is `mailbox full`, answered immediately so your turn is
never blocked. A settling or cancelled Run, or a shutting-down Session, answers
`mailbox closed`. A terminal Run reports `already completed`, `already failed`,
or `already cancelled`. None of these reopens or mutates a terminal Result.

### Completion notices

A pushed notice appears as one collapsed line and expands with the same key
that expands tool output. A completed Run's notice carries a bounded preview, a
failed Run's carries the primary error, a cancelled Run's is terse and says
whether it was cancelled on request or at shutdown. Every notice points at
`agent_result` for the rest.

A notice never interrupts. While the model is working it follows on after the
current turn; while the Session is idle it starts a turn of its own. If an
interrupt discards it, it is pushed again once the agent settles — exactly
once.

## Profiles

A Profile is a Markdown file named after the agent, so `implementer.md` defines
`implementer`:

```markdown
---
description: Implements approved plans and verifies changes
backend: claude
model: sonnet
effort: high
tools: Read, Grep, Glob
appendSystemPrompt: true
---

You are an implementation agent. Follow the approved plan and verify your work.
```

`description`, `backend`, and the body are the generic vocabulary. `backend`
defaults to `pi`. Every other field keeps one name across backends but is
validated and interpreted by the named backend, and **a field the backend does
not recognise is a diagnostic rather than a silent pass-through** — reported at
Session start, naming the file and the rule.

Profiles are read from the user directory only: `~/.pi/agent/agents/`, or
`$PI_CODING_AGENT_DIR/agents/` when that is set. A project directory cannot
contribute a Profile, trusted or not.

### What each backend reads

| | Pi | Claude |
| --- | --- | --- |
| `model` | An exact id, or `provider/model-id`, checked against Pi's loaded catalogue | An SDK family alias — `fable`, `opus`, `sonnet`, `haiku` — passed through unresolved. An explicit id such as `claude-sonnet-5` is rejected |
| `effort` | Pi's thinking level, from the shared scale | Mapped to a thinking-token budget inside the adapter; `off` disables thinking |
| `tools` | A comma-separated Pi tool list | Claude built-in tools ([reference](https://code.claude.com/docs/en/tools-reference)) |
| `appendSystemPrompt` | Defaults to `true`; `false` replaces Pi's instructions | Defaults to `true`, appending to Claude Code's preset; `false` replaces it |
| Inherits the caller's model | Yes, when `model` is omitted | No |

For `tools`, empty segments are ignored, but a list containing only separators
(`tools: ", ,"`) disables all tools rather than restoring defaults. An empty or
whitespace-only value is unset and uses the backend's defaults.

### What each backend retains

| | What one Subagent holds |
| --- | --- |
| **Pi** | One lazy in-process Pi SDK session, retained while idle. Normal resource discovery, memory-only session storage, headless binding, the parent's project-trust decision, and a Bash tool that injects the child depth per spawn without changing your environment. |
| **Claude** | One conversation identity. Each Run is a fresh streaming Query that continues it natively; provider replay is ignored and only the new prompt and that Run's guidance are sent. |

**A retained conversation is Session-local and is not a stored, listable
rollout.** Losing it loses the conversation permanently: a later resume reports
that and directs you to a new Subagent. No adapter attaches to a durable thread
or replays prior output.

**Claude children inherit your Claude Code environment.** Filesystem settings
load as they would for the CLI, so MCP servers registered with `claude mcp add`
— and your account's connectors, when they attach — are available to every
Claude child, unprompted. This is deliberate: different backends exist to bring
different toolsets, and it means registering an MCP server in Claude Code also
grants it to Claude Subagents. `tools` narrows built-in tools only. See
[ADR 0008](docs/adr/0008-claude-children-inherit-operator-environment.md).

### Model and effort resolution

| Profile says | Pi | Claude |
| --- | --- | --- |
| neither | caller's model / caller's thinking level | SDK default / SDK default |
| `effort` only | caller's model / Profile effort | SDK default / Profile budget |
| `model` only | Profile model / Pi's default thinking | Profile alias / SDK default |
| both | Profile model / Profile effort | Profile alias / Profile budget |

## Watching Runs

Runs are listed in a widget above the editor, one line each:

```
─── subagents (2 running, 1 completed) ────────────────────────
 explore      pi      3 turns  running · grep: getFinalOutput
 reviewer     claude  1 turn   running · review the delivery module
 implementer  claude  4 turns  completed in 1m 2s
```

Each row names the backend immediately after the agent, and the agent, backend,
turn count, and status columns align across rows. A running line ends with what
the Run is doing right now — the backend's reported activity, or its most
recent tool call, or the Run's description before either — and that tail is
also what tells two Runs of one agent apart. It is the first thing dropped when
the terminal is narrow; then turn accounting; the agent, backend, and status
always remain.

**A row lasts from `agent_start` until its completion notice reaches the
conversation**, not until the Run settles. A Run shorter than the turn that
started it would otherwise appear and vanish before anyone read it. A fan-out
wider than eight Runs is summarised rather than filling the screen.

Run ids appear in tool results and notices, where the model that acts on them
reads them, so the widget does not repeat them: name a Run by its agent and
task when asking for one to be cancelled.

The widget is a display. Pi routes keyboard input to the editor, never to a
widget, so Runs are stopped with `agent_cancel`.

## Behaviour worth knowing

**Concurrency is capped.** A Session runs at most eight Runs at once and
**rejects immediately** past that rather than queueing — nothing is started
invisibly and nothing waits for room. A wide fan-out costs real local resources
even while its Subagents are idle. Explicit cancellation is the liveness
mechanism unless a default Run timeout is configured.

**A Run is detached from the turn, not from the Session.** `Esc` cancels the
turn and leaves Runs going; `agent_cancel` stops one Run by id. A terminal Run
leaves its Subagent idle and still resumable. Anything that ends the Session —
switching, forking, resuming, `/new`, `/reload`, quitting — cancels every
active Run, awaits its cleanup, closes every retained conversation, and clears
notices and Results. Neither identity nor output crosses into the next Session.

**Results are bounded.** A Session holds up to 4 MB of stored output. Past
that, the oldest output nobody is still reading is evicted; that Run still
answers by id, saying its output is gone. Delegation is one level deep: a
Subagent cannot start Subagents, whichever backend runs it.

**There is no persistence layer**, no cross-Session resume, no manual
Subagent-close tool, no provider-neutral continuation token, no hidden idle
expiry, and no automatic replacement conversation.

## Security

For Pi, project trust is [Pi's](https://pi.dev/docs/latest/security#project-trust):
the extension resolves none of its own and applies Pi's decision to the
retained SDK's resource loader and settings.

**Claude does not consult that trust flag.** Claude children bypass permissions
unconditionally. This is an intentional sharp edge, with the forwarded value
reserved for a future shared posture.

A subagent reads files, writes files, and runs commands as far as its `tools`
list allows, and cannot delegate further.

## Upgrading from 1.x

**Version 2.0.0 is a rewrite of the execution architecture, and it is what
`pi install` gives you.** The behaviour it presents is largely the same: the
same six tools, the same Profile files in the same directory, the same widget
rows.

**Two things a 1.x user will notice.** `/agents` is gone; the Profile list is
`/subagent profiles`, unchanged inside. And the completion notices say more:
each one opens with the task you delegated rather than two identifiers, and
every one of them points at `agent_result` with the exact argument shape.

**One thing breaks in your files, and it is a one-line edit per Profile.** A
Profile names its backend with `backend:` where 1.x used `harness:`. Rename
that one line and change nothing else — the values are unchanged and the
default is still `pi`, so a Profile that pins no backend needs no edit at all:

```diff
 ---
 description: Implements approved plans and verifies changes
-harness: claude
+backend: claude
 ---
```

A Profile still using `harness:` fails validation as an unrecognised field, is
reported at Session start, and does not appear in the Profile list — so the
failure is visible rather than silent. There is no alias and there will not be one:
[ADR 0022](docs/adr/0022-v2-terminology-and-backend-field.md) is the decision.

**What else changed.** Four behaviours differ deliberately: a global Run
capacity that rejects immediately, a distinct shutting-down outcome,
`queue full` and `not steerable` renamed to `mailbox full` and
`mailbox closed`, and an evicted Result answering with its own typed outcome.

**Rolling back** is an ordinary release rollback to the last 1.x version:

```bash
pi install https://github.com/goofansu/pi-subagent#v1.0.0
```

Nothing migrates between the two in either direction. No in-memory Subagent or
Run crosses over, and a Run id from one is unknown to the other.

## Release verification

`npm run check` is the gate every change must pass. No credentials, and no real
time passes in it:

```bash
npm run check   # typecheck, lint, the full suite, conformance
```

- **typecheck and lint** across the repository.
- **the deterministic suite** — the pure domain, the supervisor through the
  Session rig, races, backpressure, fault injection, the stress and bounds
  lanes, the host handlers through a stand-in Pi, golden presentation, the
  import-boundary rules, and the timing lint.
- **`npm run test:conformance`** — the shared backend conformance suite:
  thirty-seven scenarios against both fake backends and both real adapters,
  behind scriptable stand-in providers. No backend skips any of them.

`npm run release:check` is `check` plus four credentialed gates. They spend
provider quota and none is in `check`:

```bash
make smoke-pi        # npm run pi:smoke && npm run pi:host-smoke
make smoke-claude    # npm run claude:smoke && npm run claude:host-smoke
```

- **four live gates**, two per backend. A *runtime* gate drives the supervisor
  over one real adapter through start, resume, steer, cancel, timeout, and
  shutdown, then reads every probe after the Session Scope has closed. A *host*
  gate drives the same backend through the surface a user has. Each prints an
  exact success marker and nothing else counts as a pass.

## Working on this

| | |
| --- | --- |
| [Glossary](CONTEXT.md) | What each word means; the vocabulary is load-bearing |
| [ADRs](docs/adr/) | Why each decision was made, and what it cost |

```bash
make dev             # this extension alone, every other one disabled
make conformance     # the shared backend conformance suite
make check           # the full gate
```
