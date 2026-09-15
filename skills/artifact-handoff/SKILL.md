---
name: artifact-handoff
description: Coordinates artifact-backed handoffs for multi-agent fan-out and work that must survive worktree or Session teardown. Use before delegating several Runs whose detailed outputs would otherwise fan into the parent, or when delegated work must checkpoint durable findings outside its working tree.
---

# Artifact handoff

Make the **handoff artifact** the detailed reporting interface. A worker writes
confirmed facts there during the work; the orchestrator reads only compact
headers, exceptions, and evidence needed for verification.

A handoff artifact is not a **Result**. A Result remains the immutable terminal
output of one Run. The artifact is a durable, incrementally written report that
can outlive its Run, Session, process, and worktree.

Use this protocol for a fan-out or when losing in-progress findings would be
costly. Keep ordinary one-off delegations on their normal Result path.

## 1. Prepare the handoff root

Before starting any worker, create one collision-resistant root under
`$HOME/.agent-runs/`. It must be outside every repository, worktree, and
harness temporary directory. Give it owner-only permissions.

A suitable allocation is:

```bash
base="$HOME/.agent-runs"
mkdir -p "$base"
chmod 700 "$base"
root="$(mktemp -d "$base/<project>-$(date +%Y%m%dT%H%M%S)-XXXXXX")"
mkdir -m 700 "$root/evidence"
```

Replace `<project>` with a short filesystem-safe project name before running
it. The random suffix makes one orchestrator the sole owner of one root; do not
share a root between orchestrators.

Write `$root/README.md` with the shared context and pointers every worker needs:
project and base revision, specification paths, common constraints, and where
authoritative external references live. Point to existing material rather than
copying it.

Preparation is complete when the root and README exist outside the repository,
the root is owner-only, and every planned worker has a unique short `RUN_KEY`.
A resumed Subagent doing new work gets a new key and artifact.

## 2. Assign the artifact in the opening prompt

For each worker, reserve these paths before starting it:

```text
HANDOFF_ARTIFACT: <root>/handoff-<run-key>.md
EVIDENCE_DIR: <root>/evidence/<run-key>/
```

Create the evidence directory with owner-only permissions. Substitute every
placeholder in the writer contract below, then put the complete contract in the
worker's **opening prompt** without omitting or paraphrasing it. For
`agent_start` or `agent_resume`, the key is allocated before the Run id is
known; keep the key as the artifact identity rather than trying to rename the
artifact afterward.

Do not depend on the worker loading this skill. Pi, Claude, and external
harnesses do not expand nested skill invocations identically. The opening
prompt carries the contract itself.

### Writer contract to include verbatim

```text
## Durable handoff contract

Your detailed report belongs in the handoff artifact, not in your final
message. This contract is part of the task's completion criteria and is the
destination for any report required by your Profile or invoked workflow.

RUN_KEY: <run-key>
SHARED_CONTEXT: <absolute-root>/README.md
HANDOFF_ARTIFACT: <absolute-root>/handoff-<run-key>.md
EVIDENCE_DIR: <absolute-root>/evidence/<run-key>/

Before substantive work, read SHARED_CONTEXT, create EVIDENCE_DIR if needed,
and initialize HANDOFF_ARTIFACT with exactly these first five lines:

STATUS: running
RUN_KEY: <run-key>
SUMMARY: work in progress
ATTENTION: yes
HEAD: <current-git-sha-or-n/a>

Then add these sections as applicable:

## Criteria
## Checks
## Decisions worth knowing
## Residue

Checkpoint as you go. Immediately after confirming a criterion, check,
finding, waiver, or load-bearing decision, append its concise record before
moving to unrelated work. Preserve prior checkpoints; only replace the five
header lines when their values change. Prefer facts the orchestrator can
re-derive—revision identifiers, paths, commands, and exit codes. Reserve prose
for rationale, rejected approaches, and other context that cannot be recovered
from the environment.

Use checklist entries under Criteria. A waiver names who waived it and why.
For every claimed command result, record:

- COMMAND: the exact command
- CWD: the directory it ran in
- PRECONDITIONS: setup that affected the result
- REVISION: the Git HEAD or state it exercised
- EXIT: the exit code
- EVIDENCE: a relative path under EVIDENCE_DIR, when retained

Store verbose logs under EVIDENCE_DIR and point to them from the artifact.
Retain the minimum evidence needed for verification and redact credentials,
tokens, environment dumps, and unrelated sensitive output.

Use STATUS: pass only when every assigned criterion is satisfied or explicitly
waived. Use blocked when caller input is required, and failed when attempted
work cannot satisfy the assignment without such a choice. ATTENTION is yes for
any waiver, unresolved risk, failure, blocker, or decision the orchestrator
must read; it is no only for a straightforward pass.

Before finishing, replace the header with the terminal status, one-line
summary, correct attention value, and final HEAD. Your final message must be
exactly:

HANDOFF: <absolute artifact path>
STATUS: <same terminal status>
```

Assignment is complete when every opening prompt already contains its unique
absolute artifact and evidence paths plus that writer contract. A later Control
may clarify work, but must not introduce the artifact for the first time.

## 3. Let workers checkpoint independently

Fan out normally. Continue useful orchestrator work while Runs are active, and
wait only at a real dependency barrier. Treat a settled Run or stopped external
agent as a signal to inspect its artifact, not as proof that its assignment
passed.

One worker owns one handoff file and one evidence subtree. The orchestrator owns
README.md. This one-writer layout needs no file lock.

## 4. Fan in by attention

At the barrier, read only the five-line headers first:

```bash
for artifact in "$root"/handoff-*.md; do
  printf '\n== %s ==\n' "$artifact"
  head -n 5 "$artifact"
done
```

Account for every expected key, including a missing file. Open the body when:

- `STATUS` is not `pass`;
- `ATTENTION` is `yes`;
- the file is missing, malformed, or still `running` after the worker stopped;
- the Run failed or was cancelled; or
- a claim selected for verification needs its preconditions or evidence.

The orchestrator verifies rather than trusts. Re-run cheap decisive commands
from the recorded CWD, revision, and preconditions. Read referenced evidence
only where re-derivation is expensive or an exception needs diagnosis. A Run's
terminal phase and its artifact status are separate facts; report disagreement
between them rather than choosing one silently.

Fan-in is complete when every expected key has a terminal artifact or an
explicitly reported protocol failure, and every claim required for the final
handoff is verified or marked unverified.

## 5. Recover residue

When an artifact is missing or incomplete, use the smallest available fallback:

1. While the worker is still reachable, ask it once to finish the artifact.
2. Within a live pi-subagent Session, use the Run's delivered Result or
   `agent_result`.
3. When an external harness exposes a native session transcript, extract only
   the last assistant text or relevant message records.
4. At worker end-of-life, accept a final narrative dump as unverified residue.

Recovered prose cannot turn an artifact into a verified pass. Preserve it as
evidence, mark the protocol failure, and continue any independent delivery
lines. Tear down a temporary worktree only after its terminal artifact or
recovered residue is safely outside that worktree.

## 6. Complete the orchestration

Report the handoff root, each key and status, what was verified, and every
blocker, failure, waiver, risk, or protocol failure. Keep the root until the
human accepts the handoff; deletion is an explicit later action rather than
part of Session or worktree cleanup.
