# Artifact writer

Follow this protocol when an opening assignment names `RUN_KEY`,
`SYNOPSIS_TOOL`, `SHARED_CONTEXT`, `HANDOFF_ARTIFACT`, and `EVIDENCE_DIR`.

The handoff has three surfaces:

- **Synopsis** — `HANDOFF_ARTIFACT`, the bounded canonical state.
- **Evidence** — reproducible detail under `EVIDENCE_DIR`.
- **Receipt** — the final assistant message pointing to the Synopsis.

## 1. Initialize the Synopsis

Before substantive work, read `SHARED_CONTEXT` and ensure `EVIDENCE_DIR` has
mode `700`. Write the complete initial Synopsis to
`<HANDOFF_ARTIFACT>.staged`, beginning with exactly these five lines:

```text
STATUS: running
RUN_KEY: <assigned key>
SUMMARY: work in progress
ATTENTION: yes
HEAD: <current Git SHA or n/a>
```

Add exactly one of each section:

```markdown
## Attention
- Work in progress.

## Criteria
- [ ] C1 <first assigned criterion>

## Decisions worth knowing
- None.

## Residue
- Work in progress.
```

Account for every assigned criterion with stable unique IDs `C1`, `C2`, and so
on; when none are explicit, derive one from the assignment. Publish the staged
file:

```bash
node "<SYNOPSIS_TOOL>" publish \
  --staged "<HANDOFF_ARTIFACT>.staged" \
  --artifact "<HANDOFF_ARTIFACT>" \
  --run-key "<RUN_KEY>"
```

The publisher validates the candidate, sets mode `600`, flushes it, and
atomically renames it over the canonical Synopsis. Never write, edit, or append
to `HANDOFF_ARTIFACT` directly. If publishing fails, the prior Synopsis remains
untouched; repair the staged file and retry.

Initialization is complete when publishing succeeds and the canonical file has
the assigned key, all criteria, and all sections.

## 2. Capture Evidence

Write reproducible detail under `EVIDENCE_DIR`. For every command result cited
by the Synopsis, retain a small command manifest containing:

```text
COMMAND: <exact command, with secret references rather than secret values>
CWD: <directory>
PRECONDITIONS: <setup affecting the result>
REVISION: <Git HEAD or state exercised>
EXIT: <exit code>
OUTPUT: <relative retained-output path or not retained>
```

Store verbose output beside its manifest. Cite Evidence with backtick-enclosed
paths relative to the Synopsis directory, such as
`` `evidence/<run-key>/check.out` ``. Keep every file you create within the
assigned Evidence directory. You may cite another owner's Evidence read-only
when the path makes that owner explicit.

Append working rationale to `journal.md` when it would otherwise be lost,
including rejected hypotheses that affect the conclusion. Preserve the minimum
needed for verification and redact credentials, tokens, environment dumps,
identities, and unrelated sensitive output.

Evidence capture is complete when every cited command is reproducible from its
manifest, every cited path resolves from the Synopsis directory, and every file
you created is inside the assigned Evidence directory.

## 3. Checkpoint the Synopsis

A **checkpoint** is a conclusion that changes a criterion, Attention item,
decision, or Residue—not merely a completed command. Write its Evidence first,
then write the entire next Synopsis to `<HANDOFF_ARTIFACT>.staged`. Run the
`publish` command from §1 before moving to unrelated work.

Keep each section current in the complete staged replacement:

- **Attention** has at most ten one-line bullets requiring orchestrator notice;
  use `- None.` for a straightforward pass.
- **Criteria** uses
  ``- [x] C1 <conclusion> — `evidence/<owner>/<file>` `` for a satisfied
  criterion, `- [ ] C1 <current state>` while unfinished, and
  `- [x] C1 WAIVED by <actor>: <reason>` for a waiver.
- **Decisions worth knowing** contains only rationale the environment cannot
  reconstruct; use `- None.` when empty.
- **Residue** contains only current unfinished work or follow-up risk; use
  `- None.` when empty.

Maintain exactly one copy of each section. Move operational chronology,
intermediate hypotheses, command blocks, and extended reports into Evidence.
Keep the entire Synopsis at or below 16 KiB.

A checkpoint is complete when publishing succeeds, the canonical Synopsis is
current and bounded, and its new claims have resolving Evidence pointers.

## 4. Seal and send the Receipt

Set the terminal status:

- `pass` — every criterion is satisfied or explicitly waived;
- `blocked` — caller input is required to proceed;
- `failed` — attempted work shows the assignment cannot be satisfied as given.

Set `ATTENTION: yes` for a waiver, blocker, failure, unresolved risk, or caller
decision; otherwise set it to `no` and leave `- None.` under Attention. Replace
the summary with one line of at most 200 characters and HEAD with the final
revision or state.

Write the complete terminal Synopsis to `<HANDOFF_ARTIFACT>.staged` and publish
it with the command from §1. Then substitute the assigned absolute values and
run the terminal gate:

```bash
node "<SYNOPSIS_TOOL>" validate \
  --artifact "<HANDOFF_ARTIFACT>" \
  --run-key "<RUN_KEY>"
```

`publish` accepts a valid `running` checkpoint, while `validate` requires a
terminal status and rejects any remaining staged file. Repair every diagnostic
by writing and publishing another complete staged replacement; use a
non-passing status for the work outcome, not for a malformed Synopsis. Only
after the terminal gate exits zero, send exactly this Receipt and no detailed
report:

```text
HANDOFF: <absolute HANDOFF_ARTIFACT path>
STATUS: <same terminal status>
```
