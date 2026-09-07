# pi-subagent

Delegate tasks to specialised subagents in Pi, using Pi or Claude. Each subagent
works in its own conversation, reports progress, and sends its result back when
finished. You can continue its conversation, give it guidance, or cancel its work.

## Install

```bash
pi install https://github.com/goofansu/pi-subagent
```

Add a [profile](#profiles), then ask Pi to delegate work to it.

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

The widget above the editor adapts to the number of active Runs:

- **None:** hidden unless terminal completion hand-offs remain unresolved; those
  show only compact outcome and delivery-attention counts.
- **One:** a summary plus the active Run's Profile, state, and available
  activity. When known and space permits, the activity is followed by how long
  that displayed semantic summary has been unchanged. Turn count and backend
  follow; the Label uses only room left after those more useful fields.
- **Two or more:** aggregate counts only, with no individual activity or rows.
  Hidden activity and accounting updates do not request identical redraws.

One active Run, alongside an unresolved completion at a wide layout:

```text
 subagents   1 running   1 completed
 explore  running  grep: getFinalOutput  12.4s ago  3 turns  pi  look around
```

The age means “summary last changed,” not agent inactivity: repeated work can
produce the same semantic summary without resetting it. It is omitted when the
matching activity or timestamp is unavailable, when activity clears, and while
the Run is finalizing or cancelling, so retained history never implies that an
old tool is still executing. Time is sampled on widget events or actual renders,
never by a timer; an otherwise quiet displayed age may stay unchanged until the
next render.

At a 32-cell layout, the Profile, state, and useful activity remain while the
Label, backend, accounting, and then age give way:

```text
 subagents   1 running   1 comp…
 explore  running  grep: getFi…
```

Multiple active Runs:

```text
 subagents   2 running   1 completed
```

The ambient widget does not show elapsed Run duration. As before, an active Run
has no elapsed timer; its optional single-Run activity age describes the semantic
summary, not the Run. Terminal Runs are now summarized instead of appearing as
individual `completed in …` rows. Their elapsed durations remain available in
`/subagent dashboard` history and inspection.

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

Create Markdown files in `~/.pi/agent/agents/` (or
`$PI_CODING_AGENT_DIR/agents/` if configured). Profiles are loaded from this user
directory, not from individual projects. The filename is the agent name:
`reviewer.md` defines `reviewer`.

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
