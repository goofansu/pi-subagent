---
name: artifact-handoff
description: Artifact-backed fan-in for report-heavy delegations and findings that must survive Session or worktree teardown. Use before starting those workers.
---

# Artifact handoff

Use an artifact handoff when detailed worker reports would flood the parent or
when confirmed findings must outlive a Run, Session, process, or worktree. Keep
ordinary one-off delegations on their normal Result path.

A handoff has three surfaces:

- **Synopsis** — one bounded `handoff-<key>.md` containing current conclusions.
- **Evidence** — detailed commands, logs, and incremental working records.
- **Receipt** — the worker's two-line final message pointing to its Synopsis.

The Synopsis is not a **Result**. A Result remains one Run's immutable terminal
output.

## 1. Prepare

Before starting workers, create one owner-only root outside every repository,
worktree, and harness temporary directory:

```bash
umask 077
base="$HOME/.agent-runs"
mkdir -p "$base"
chmod 700 "$base"
root="$(mktemp -d "$base/handoff-$(date +%Y%m%dT%H%M%S)-XXXXXX")"
mkdir -m 700 "$root/evidence" "$root/evidence/orchestrator"
```

Resolve [WRITER.md](WRITER.md) and [synopsis.mjs](synopsis.mjs) relative to
this skill. Copy both to the root and keep the run-scoped copies unchanged.
Write `$root/README.md` with shared context pointers, the project and base
revision, and common constraints. Set all three files to mode `600`:

```bash
chmod 600 "$root/README.md" "$root/WRITER.md" "$root/synopsis.mjs"
```

The orchestrator alone writes README and `evidence/orchestrator/`.

Give every planned worker a unique short `RUN_KEY`. A resumed Subagent doing new
work gets a new key.

Preparation is complete when the private external root contains README,
WRITER.md, synopsis.mjs, `evidence/orchestrator/`, and one allocated key per
planned worker.

## 2. Assign

For each worker, create `$root/evidence/<run-key>/` with mode `700`. Put this
block, with absolute paths and substituted values, in its opening prompt:

```text
Artifact handoff. Before substantive work, read WRITER_PROTOCOL completely and
follow it. The assignment is incomplete until its completion criteria pass.

RUN_KEY: <run-key>
WRITER_PROTOCOL: <absolute-root>/WRITER.md
SYNOPSIS_TOOL: <absolute-root>/synopsis.mjs
SHARED_CONTEXT: <absolute-root>/README.md
HANDOFF_ARTIFACT: <absolute-root>/handoff-<run-key>.md
EVIDENCE_DIR: <absolute-root>/evidence/<run-key>/
```

Include the worker's exact task brief and context pointers in the same opening
prompt; another invoked workflow may determine their ordering. For
`agent_start` or `agent_resume`, allocate the key before the Run id is returned;
the artifact keeps the key rather than being renamed afterward. The worker
reads the run-scoped protocol file, so Pi, Claude, and external harnesses need
not expand another skill invocation.

Assignment is complete when every opening prompt already names its unique
Synopsis, Evidence directory, shared context, Writer protocol, and Synopsis
tool. Later Control may clarify the work but never introduces the handoff for
the first time.

## 3. Run

Fan out normally. One worker writes one Synopsis and one Evidence subtree.
Continue independent orchestrator work while Runs are active and wait only at a
real dependency barrier. A worker stopping is a signal to inspect, not proof of
success.

At a dependency barrier, continue only after every worker required beyond it
has stopped; unrelated workers may continue.

## 4. Fan in

Build `expected_keys` from the allocations, then read only the five-line
headers first and account for missing files:

```bash
for key in "${expected_keys[@]}"; do
  artifact="$root/handoff-$key.md"
  printf '\n== %s ==\n' "$artifact"
  if [[ -f "$artifact" ]]; then head -n 5 "$artifact"; else printf 'MISSING\n'; fi
done
```

As workers stop, build `stopped_keys` and run the same terminal gate they ran
before their Receipts. At the final barrier, it contains every expected key:

```bash
validation_failed=0
for key in "${stopped_keys[@]}"; do
  artifact="$root/handoff-$key.md"
  node "$root/synopsis.mjs" validate \
    --artifact "$artifact" --run-key "$key" || validation_failed=1
done
(( validation_failed == 0 ))
```

A nonzero exit is a protocol failure, including when the canonical header says
`STATUS: pass`. The Synopsis tool also rejects a `.staged` file left beside the
canonical Synopsis. It enforces the size, canonical header and sections,
terminal criteria, Attention semantics, private mode, and resolving Evidence
pointers. Atomic publishing means header readers see either the previous
complete Synopsis or the next one, never an in-progress rewrite.

For a valid `ATTENTION: yes`, read at most the bounded Attention section first:

```bash
awk '/^## Attention$/{p=1;next} /^## /&&p{exit} p{print;if(++n==12)exit}' "$artifact"
```

For non-passing or malformed Synopses, read only the relevant Criteria or
Residue lines next. For passing Synopses, select decisive claims for
verification and follow their Evidence pointers. Re-run cheap checks from the
recorded CWD, revision, and preconditions; read verbose evidence only when
re-derivation is expensive or an exception needs diagnosis. A Run phase and an
artifact status are separate facts, so report disagreement between them.

Fan-in is complete when every expected key has a valid terminal Synopsis or an
explicit protocol failure, and every claim needed for handoff is verified or
marked unverified.

## 5. Recover

For a missing or incomplete Synopsis, use the smallest available fallback:

1. While the worker is reachable, ask it once to seal the Synopsis.
2. In a live pi-subagent Session, use the delivered Result or `agent_result`.
3. From an external harness transcript, extract only relevant message records.
4. At worker end-of-life, accept a final narrative dump as unverified residue.

A stopped worker's `.staged` file may contain a newer interrupted checkpoint.
Never publish it on the worker's behalf; inspect it as untrusted recovery input
and preserve any useful material under `evidence/orchestrator/`.

Store recovered material under `evidence/orchestrator/`, mark the protocol
failure, and preserve the independent delivery lines. Recovery is complete when
the residue is durable and explicitly classified as unverified. Tear down a
temporary worktree only after its terminal Synopsis or recovered residue is
outside that worktree.

## 6. Complete

Remove group and other permissions recursively from the root. Report the root,
every key and status, verification performed, every attention item or protocol
failure, and any remaining `.staged` file. Keep the root until the human accepts
the handoff; deletion is a separate explicit action.

Completion is done when the permissions are swept and that report is delivered.
