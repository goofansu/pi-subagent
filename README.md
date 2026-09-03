# pi-subagent

Delegate tasks to specialised subagents with isolated context windows in Pi.

Each subagent is defined by a Profile that names a **backend** — `pi`,
`claude`, or `codex` — and each backend keeps its own model, tools,
configuration, and conversation semantics. A small Effect supervisor owns the
lifetimes above them: it starts and stops work, normalises what each backend
reports into one bounded read model, and delivers progress and immutable
results through one UI.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

Upgrading from 1.x? One line per Profile changes — see
[Upgrading from 1.x](#upgrading-from-1x).

## Commands and tools

`/agents` lists loaded Profiles, shows their prompts, and hands one a task.
With none configured, it prints the directory to add one to.

`/subagent` reports what the live Session's runtime is counting and holding —
see [Diagnostics](#diagnostics).

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

`agent_resume` continues the Subagent's retained conversation. All three
backends support it. If the conversation is irrecoverably lost, resume starts
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
backend: codex
model: gpt-5.6-sol
effort: high
tools: read, grep, find, ls
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

| | Pi | Claude | Codex |
| --- | --- | --- | --- |
| `model` | An exact id, or `provider/model-id`, checked against Pi's loaded catalogue | An SDK family alias — `fable`, `opus`, `sonnet`, `haiku` — passed through unresolved. An explicit id such as `claude-sonnet-5` is rejected | Passed through unvalidated; the App Server resolves a model name itself |
| `effort` | Pi's thinking level, from the shared scale | Mapped to a thinking-token budget inside the adapter; `off` disables thinking | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; `off` maps to `none` |
| `tools` | A comma-separated Pi tool list | Claude built-in tools ([reference](https://code.claude.com/docs/en/tools-reference)) | **Not recognised** — a diagnostic. A Codex thread carries its own tool set |
| `appendSystemPrompt` | Defaults to `true`; `false` replaces Pi's instructions | Defaults to `true`, appending to Claude Code's preset; `false` replaces it | **Not recognised** — a diagnostic. The Profile prompt is composed into the first Turn's input |
| Inherits the caller's model | Yes, when `model` is omitted | No | No |

For `tools`, empty segments are ignored, but a list containing only separators
(`tools: ", ,"`) disables all tools rather than restoring defaults. An empty or
whitespace-only value is unset and uses the backend's defaults.

### What each backend retains

| | What one Subagent holds |
| --- | --- |
| **Pi** | One lazy in-process Pi SDK session, retained while idle. Normal resource discovery, memory-only session storage, headless binding, the parent's project-trust decision, and a Bash tool that injects the child depth per spawn without changing your environment. |
| **Claude** | One conversation identity. Each Run is a fresh streaming Query that continues it natively; provider replay is ignored and only the new prompt and that Run's guidance are sent. |
| **Codex** | One `codex app-server` process and one ephemeral, pathless root thread. Each Run is one Turn on that thread. The process stays alive while the Subagent is idle and closes at Session shutdown. |

**Codex's root thread is process-local and is not a stored, listable rollout.**
Losing the process loses the conversation permanently: a later resume reports
it and directs you to a new Subagent. The adapter never respawns, attaches to a
durable thread, or replays prior output. "Ephemeral" does not mean zero shared
Codex-home I/O — authentication, configuration, logs, plugins, MCP startup, and
provider-native child threads may still use shared resources.

**Claude children inherit your Claude Code environment.** Filesystem settings
load as they would for the CLI, so MCP servers registered with `claude mcp add`
— and your account's connectors, when they attach — are available to every
Claude child, unprompted. This is deliberate: different backends exist to bring
different toolsets, and it means registering an MCP server in Claude Code also
grants it to Claude Subagents. `tools` narrows built-in tools only. See
[ADR 0008](docs/adr/0008-claude-children-inherit-operator-environment.md).

### Model and effort resolution

| Profile says | Pi | Claude | Codex |
| --- | --- | --- | --- |
| neither | caller's model / caller's thinking level | SDK default / SDK default | Codex default / Codex default |
| `effort` only | caller's model / Profile effort | SDK default / Profile budget | Codex default / Profile effort |
| `model` only | Profile model / Pi's default thinking | Profile alias / SDK default | Profile model / Codex default |
| both | Profile model / Profile effort | Profile alias / Profile budget | Profile model / Profile effort |

## Watching Runs

Runs are listed in a widget above the editor, one line each:

```
─── subagents (2 running, 1 completed) ────────────────────────
 explore      pi      3 turns  running · grep: getFinalOutput
 reviewer     claude  1 turn   running · review the delivery module
 implementer  codex   4 turns  completed in 1m 2s
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

## Diagnostics

`/subagent` reports two kinds of block for the live Session:

- **counters** — things that happened and nobody had to be told about at the
  time: duplicate settlement attempts, late events, queue overflows, cleanup
  escalations, reconciliation differences, delivery failures, evictions. One is
  usually normal; thousands is a bug.
- **probes** — what is still alive. The runtime's own says whether the core is
  holding a fiber, a queue, a mailbox, a waiter, a subscription, or a
  BackendAgent. One block per backend says whether that provider's handles are
  still held: for Pi, native sessions and event subscriptions; for Claude, live
  Queries, open input streams, and retained conversation identities; for Codex,
  live App Server processes, reader fibers, pending JSON-RPC requests, retained
  root threads, and in-flight steers.

Every field is printed, zeroes included, and every one reads zero for a Session
with nothing in flight. [The debugging guide](docs/debugging.md) is what each
number means and what to do about it.

## Behaviour worth knowing

**Concurrency is capped.** A Session runs at most eight Runs at once and
**rejects immediately** past that rather than queueing — nothing is started
invisibly and nothing waits for room. A wide fan-out costs real local resources
even while Codex Subagents are idle. Explicit cancellation is the liveness
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

**Claude and Codex do not consult that trust flag.** Claude bypasses
permissions unconditionally; Codex uses `approvalPolicy: "never"` and
`sandbox: "danger-full-access"`. This is deliberate parity between the two and
an intentional sharp edge, with the forwarded value reserved for a future
shared posture —
[ADR 0009](docs/adr/0009-codex-trust-posture-and-environment-inheritance.md).

A subagent reads files, writes files, and runs commands as far as its `tools`
list allows, and cannot delegate further.

## Upgrading from 1.x

**Version 2.0.0 is a rewrite of the execution architecture, and it is what
`pi install` gives you.** The behaviour it presents is the same: the same six
tools, the same `/agents` command, the same Profile files in the same
directory, the same widget rows, the same completion notices.

**One thing breaks, and it is a one-line edit per Profile.** A Profile names
its backend with `backend:` where 1.x used `harness:`. The values are unchanged
— `pi`, `claude`, `codex` — and the default is still `pi`, so a Profile that
pins nothing needs no edit at all:

```diff
 ---
 description: Implements approved plans and verifies changes
-harness: codex
+backend: codex
 ---
```

A Profile still using `harness:` fails validation as an unrecognised field, is
reported at Session start, and does not appear in `/agents` — so the failure is
visible rather than silent. There is no alias and there will not be one:
[docs/v2/profile-backend-field-migration.md](docs/v2/profile-backend-field-migration.md)
is the migration note and
[ADR 0022](docs/adr/0022-v2-terminology-and-backend-field.md) is the decision.

**What else changed, and where it is written down.** Five behaviours differ
deliberately, each marked in
[the compatibility matrix](docs/v2/compatibility-matrix.md) with the decision
behind it: a global Run capacity that rejects immediately, a distinct
shutting-down outcome, `queue full` and `not steerable` renamed to
`mailbox full` and `mailbox closed`, and an evicted Result answering with its
own typed outcome. Every other wording difference between the two was compared
once, while both existed, and classified in
[the presentation ledger](docs/v2/presentation-ledger.md).

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
npm run check   # typecheck, lint, the full suite, conformance, protocol pin
```

- **typecheck and lint** across the repository.
- **the deterministic suite** — the pure domain, the supervisor through the
  Session rig, races, backpressure, fault injection, the stress and bounds
  lanes, the host handlers through a stand-in Pi, golden presentation, the
  import-boundary rules, and the timing lint.
- **`npm run test:conformance`** — the shared backend conformance suite:
  thirty-seven scenarios against both fake backends and all three real
  adapters, behind scriptable stand-in providers. No backend skips any of them.
- **`npm run codex:protocol:check`** — regenerates the installed `codex` CLI's
  JSON schema and compares it **byte for byte** against the vendored snapshot
  in `docs/codex-protocol/`, then asserts every shape the adapter consumes.

> **Note:** the protocol check goes red the moment the `codex` CLI is upgraded
> past the pinned release. That is the check working. Bumping the pin is the
> procedure in `.agents/skills/codex-upgrade/SKILL.md`, which regenerates the
> schema, classifies every consumed hunk, and re-runs both authenticated Codex
> gates before the pin moves.

`npm run release:check` is `check` plus seven credentialed gates. They spend
provider quota and none is in `check`:

```bash
make smoke-pi        # npm run pi:smoke && npm run pi:host-smoke
make smoke-claude    # npm run claude:smoke && npm run claude:host-smoke
make smoke-codex     # npm run codex:smoke && npm run codex:host-smoke
npm run codex:retained-release:check
```

- **six live gates**, two per backend. A *runtime* gate drives the supervisor
  over one real adapter through start, resume, steer, cancel, timeout, and
  shutdown, then reads every probe after the Session Scope has closed. A *host*
  gate drives the same backend through the surface a user has. Each prints an
  exact success marker and nothing else counts as a pass. The Codex runtime
  gate additionally proves that a second App Server can neither list nor read
  its ephemeral root, and asks the operating system whether the whole process
  tree is gone.
- **the retained-release check**, a no-quota gate that verifies the pinned
  protocol and then requires one complete human evidence record for the
  installed CLI version, taken while Codex Desktop was open. It never
  fabricates or infers human evidence, and refuses to pass without one:
  [docs/codex-desktop-coexistence-release.md](docs/codex-desktop-coexistence-release.md).

## Working on this

| | |
| --- | --- |
| [Architecture](docs/architecture.md) | How it is built, in the terms the code uses |
| [Glossary](CONTEXT.md) | What each word means; the vocabulary is load-bearing |
| [Contributing](docs/contributing.md) | The rules a change has to satisfy, and why |
| [Debugging](docs/debugging.md) | Every counter, probe, and diagnostic, and what to do |
| [Compatibility matrix](docs/v2/compatibility-matrix.md) | What each command does on each backend, and what proves it |
| [Operation semantics](docs/v2/operation-semantics.md) | What a caller observes from each operation, in detail |
| [ADRs](docs/adr/) | Why each decision was made, and what it cost |
| [Deletion ledger](docs/v2/deletion-ledger.md) | What the rewrite removed, and what replaced it |

```bash
make dev             # this extension alone, every other one disabled
make conformance     # the shared backend conformance suite
make check           # the full gate
```
