# pi-subagent

Delegate tasks to specialised subagents in Pi, using Pi or Claude. Each subagent
works in its own conversation, reports progress, and sends its result back when
finished. You can continue its conversation, give it guidance, or cancel its work.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

Ask Pi to delegate to `explore`, `implementer`, `researcher`, `spec-reviewer`,
or `standards-reviewer`. These [profiles](#profiles) ship with the package;
no separate Profile installation is needed.

## Workflows

The package also installs two skills, available from any working directory:

- `/skill:implement-and-review <specification>` — runs an `implementer` and
  fresh `spec-reviewer` / `standards-reviewer` pairs, revises blocking findings,
  and commits each clean unit with hooks enabled. Requires an initially clean
  working tree; stops on contract gaps or review stalemates. Herdr is not needed.
- `/skill:herdr-implement-spec <specification>` — explicitly invoked, optional Herdr
  orchestration of a ticket dependency graph. Ticket agents are independent
  main Pi agents in separate worktrees, each running implement-and-review with
  its own one-level Subagents. Their branches merge into a dedicated integration
  worktree, left ready for review; the current workspace stays unchanged.

The Herdr workflow requires Herdr and the external `herdr` skill for its
commands, plus the external `code-review` skill for final integration review.
The preserved implementer Profile references the external `tdd` skill. These
skills and their dependencies are not installed by this package; install them
separately when using the corresponding workflow. Neither original skill source
repository is needed at runtime. `to-spec` and `to-tickets` are not bundled.
Reviewer roles, commit rules, and ticket scheduling remain Profile/skill policy,
not additional runtime execution machinery.

## Commands

| Command | What it does |
| --- | --- |
| `/subagent` | Shows a summary of available profiles and current work. |
| `/subagent dashboard` | Open the Subagent dashboard: live subagents and newest-first run history (read-only). Shortcut: `Alt+Shift+.` |
| `/subagent doctor` | Shows troubleshooting information when something goes wrong. |

## Tools

Pi uses these tools to manage delegated work. A **subagent** is a conversation
that can continue across tasks; a **Run** is one task started in that conversation.

| Tool | What it does |
| --- | --- |
| `agent_start` | Starts a new subagent with an `agent` profile name, a short `description`, and a `prompt`. Returns Subagent and Run IDs immediately. |
| `agent_resume` | Continues an idle subagent's conversation with a new task. Returns a new Run ID. |
| `agent_wait` | Waits for specified Runs and returns their results. Supports an optional timeout. |
| `agent_wait_all` | Waits for all currently active Runs and returns their results. Supports an optional timeout. |
| `agent_cancel` | Requests cancellation of specified Runs, keeping any partial output. |
| `agent_steer` | Sends guidance to an active Run. Acceptance does not guarantee the subagent has read it yet. |
| `agent_result` | Retrieves a finished Run's result, including output too long to fit in its completion notice. |

Use the **Subagent ID** for `agent_resume`; use **Run IDs** for the other tools
that take IDs.

Results arrive automatically, so Pi can keep working while subagents run.
Waiting returns results directly without a duplicate completion notice.

**Output limits:** completion notices include answers up to 16 KiB; longer
answers arrive as a preview with instructions to retrieve the rest.
`agent_result` returns the stored result, and `agent_wait` returns the same
content for each Run. Each stored result is limited to 256 KiB, with 4 MiB of
storage shared across the session. Oversized results are shortened and marked
as truncated. These are storage limits, not exact tool-response sizes; a wait
covering several Runs combines their results.

- Up to eight Runs can work at once. Additional starts or resumes are refused
  immediately rather than queued. Subagents cannot delegate further.
- `Esc` stops Pi's current turn, not its subagents. Ask Pi to cancel their work.
- Starting, switching, reloading, or leaving a session stops its active Runs.
  Subagent conversations and results do not carry over to another session.
- Older results may expire when the session's output storage fills up.

## Widget

The widget above the editor is borderless and drawn on the terminal's default
background, relying on the editor's own border immediately beneath it. Only the
`subagents` title is accented; ordinary counts and the active Run's state and
activity are muted foreground text. The error tone is reserved for failed Runs
and for completion hand-offs that need attention, so nothing else in the widget
competes with a real problem. Every colour comes from the current Pi theme.

It adapts to the number of active Runs:

- **None:** hidden unless terminal completion hand-offs remain unresolved; those
  show only compact outcome and delivery-attention counts.
- **One:** a summary plus the active Run's Label, state, available activity,
  and elapsed Run duration only—no turn count or backend. Elapsed is aligned
  to the right edge with the same one-cell inset as the left edge.
  The Label uses the dashboard's 40-column cap with an ellipsis, shrinking
  further when needed to preserve state and useful activity; no Profile or
  duplicate trailing Label is shown.
- **Two or more:** aggregate counts only, with no individual activity or rows.
  Hidden activity and accounting updates do not request identical redraws.

One active Run, alongside an unresolved completion at a wide layout:

```text
 subagents   1 running   1 completed
 look around  running · grep: getFinalOutput                 12.4s
```

Elapsed means time since the Run started, using the same duration formatting
as dashboard history. It remains independent of activity arriving, changing,
or clearing, and remains available during finalization and cancellation.
Retained activity is still hidden during finalization and cancellation.
Time is sampled only when the Run index publishes an update, never by a timer:
incidental renders, resizes, theme changes, and completion hand-off changes do
not advance it. A quiet Run's displayed duration stays at the last event sample.

Space is reserved for elapsed, with a flexible gap after the left-aligned
Label, state, and activity. A dim `·` separates status from muted, non-italic
activity. When no current activity is displayed, including during finalization
or cancellation, `· —` appears instead, matching the dashboard placeholder
without reviving retained activity. The separator and placeholder hide together
if too narrow. Activity truncates to preserve elapsed where feasible;
at very narrow widths elapsed hides rather than displacing useful activity.
At a 33-cell layout:

```text
 subagents   1 running   1 comp…
 look a…  running · grep: getFi…
```

Multiple active Runs:

```text
 subagents   2 running   1 completed
```

Terminal Runs are summarized instead of appearing as individual `completed in …`
rows. Their final elapsed durations remain available in `/subagent dashboard`
history and inspection.

Finalizing and requested cancellation still count as active work; cancellation
is shown as `cancelling`. Terminal counts disappear when a completion notice
lands or Pi receives the Result through retrieval or a wait. Notification failure
is separate from Run failure: `notification failed` means the Result remains
available; `no notification · result unavailable` means no answer can be delivered.
At narrow widths, `!` preserves delivery-attention visibility when its full
explanation cannot fit. Resolved failures do not remain as history.

Use `/subagent dashboard` for individual Runs and history. Ask Pi to retrieve a
Result or cancel active work by naming the agent and task—the widget itself is
not interactive.

`/subagent dashboard` opens a full-screen, borderless dashboard, including
completed work after its widget visibility ends. Aligned rows show the work label,
status, active work's latest activity, and elapsed time at the right edge.
Actions appear in the bottom navigation bar. Elapsed time refreshes on run events or navigation, never on
a timer; completed runs show their final duration. Narrow views hide the time column.
Active work appears first, then failed or timed-out latest runs, then completed
work. Updates follow actual changes, without a ticking activity-age clock.
Profiles appear in run history; IDs stay in inspection.

The overview is headed by the Pi mark, the working directory Runs are started
in, and how many subagents are in each category:

```text
 ██████    Subagent dashboard
 ██  ██    ~/code/pi-subagent
 ████  ██  1 active · 0 needs attention · 3 completed
 ██    ██
```

The counts follow the same categories the list is grouped by and update as work
settles. A narrow header keeps the working directory's leaf and names only the
categories holding something; a screen too small for the mark falls back to the
plain title, as run history and inspection always do.

Use Up/Down to move, Left/Right or Page Up/Page Down to page, Enter to open run
history, and Escape to go back and close. Enter on any run opens a frozen snapshot
with the Markdown-rendered answer first, followed by metadata, transcript, and
literal tool output. Up/Down scroll lines and Left/Right page through the snapshot.
For running or finalizing work, **r** captures newer content and preserves or clamps your scroll
position. Refresh after settlement shows the stored Result or explains its expiry.
Terminal snapshots need no refresh; reopening observes current availability.
Capture time, content, and activity ages stay fixed while reading. Escape rereads
history, then returns to the current live overview with the same selected identity.
Inspection does not consume Results, change completion delivery, or control work.

## Profiles

The package includes five specialists in [`agents/`](agents/):

| Profile | Role | Backend / pinned model |
| --- | --- | --- |
| `explore` | Read-only codebase exploration | Pi / `opencode/claude-haiku-4-5` |
| `implementer` | Implementation, leaving changes uncommitted for review | Pi / `openai-codex/gpt-5.6-sol` |
| `researcher` | Cited research saved to a Markdown note | Pi / `opencode/claude-haiku-4-5` |
| `spec-reviewer` | Findings against the caller's specification | Claude / `opus` |
| `standards-reviewer` | Findings against repository standards | Claude / `sonnet` |

Bundled resources resolve from the installed package, independently of the
working directory. Their original prompts, models, and tool selections are
preserved. Pinned Pi models must exist in the Session's model catalogue and
require provider authentication to run. The researcher also expects externally
provided `web_search` and `web_fetch` tools; these are not installed by this
package. Claude requires its normal local setup. Herdr is not required.

To add or replace a specialist, create Markdown files in `~/.pi/agent/agents/`
(or `$PI_CODING_AGENT_DIR/agents/` if configured). No project Profiles are read.
The filename is the agent name: `reviewer.md` defines `reviewer`.

User-only and bundled-only names are available when valid. A same-name user
file replaces the **whole Profile**, including its backend, prompt, and fields;
omitted fields use backend defaults, never bundled values. An invalid user
replacement **disables that name**, retaining its file diagnostic rather than
falling back to the bundled specialist. Fix or remove the replacement and
reload Pi to discover Profiles again. A missing user agents directory is fine.

Discovery and backend validation happen at Session start, not during delegation.
An existing Subagent keeps its fixed Profile across Runs; files are not live
reloaded. Invalid bundled files are diagnosed just like invalid user files.

```markdown
---
description: Reviews changes for bugs and missing tests
backend: claude
model: sonnet
effort: high
tools: Read, Grep, Glob
---

Review the changes. Report actionable bugs and missing tests with file references.
Do not modify files.
```

| Field | What to set |
| --- | --- |
| `description` | A short explanation of when to use this agent. |
| `backend` | `pi` (default) or `claude`. |
| `model` | For Pi, a model ID or `provider/model-id`; omitted, it uses the caller's model. For Claude, use `fable`, `opus`, `sonnet`, or `haiku`; omitted, it uses Claude's default. Full Claude model IDs are not accepted. |
| `effort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `tools` | A comma-separated list of tool names for that backend. Omit to use its defaults. Pi and Claude use different tool names. |
| `appendSystemPrompt` | Defaults to `true`, adding the profile's instructions to the backend's standard instructions. Set `false` to replace them. |

The text below the frontmatter contains the agent's instructions. Invalid
profiles are reported when the session starts.

**Claude runs without permission prompts** and inherits your Claude Code
settings, including configured MCP servers. Its `tools` field limits built-in
tools, not MCP access. Only delegate work you trust it to perform. Pi subagents
follow Pi's project-trust settings.
