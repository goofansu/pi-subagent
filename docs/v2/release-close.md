# The 2.0 close: soak, evidence, and the stable release

**Status: planned 2026-09-04; starts when the Phase C gate closes.**
**Precondition:** [the Phase C gate](../v2-simplify/phase-c-exit-gate.md) is
closed. The soak must run on the build that ships, and Phase C changes the
widget's row lifetime and one model-facing sentence, so a soak day logged
before it closes is a day on a different build.
**What closing it unlocks:** `2.0.0`, without the release-candidate marker;
the simplification programme's close; and a recorded decision on each Phase D
item, made on numbers.

## Why this is the next phase, and Phase D is not

[The v2 roadmap](roadmap.md) delivered the rewrite and left three things
outstanding, none of them code: the six live gates on the cutover build, the
Codex Desktop coexistence record, and the release-candidate soak.
[The simplification roadmap](../v2-simplify/roadmap.md) has planned Phases A
through C and holds Phase D "on evidence only". The evidence Phase D waits for
comes from the soak, and [the soak record](soak.md) has been open since
2026-09-03 with an empty log — the M4 window accumulated nothing, and the
cutover window has accumulated nothing. A plan that skipped to Phase D would
be planning on evidence that does not exist; a plan that lists the three
outstanding items again without asking why the soak has not been written would
leave them outstanding.

So this phase does two things. It closes the release, which is mostly human
work with a cadence. And it fixes the reason the soak log is empty: the tally
is a manual log of things the maintainer did, written after the fact, and
nothing makes writing it cheaper than not writing it. Pi's session logs already
record every `agent_*` tool call with its arguments and its timestamp, so the
tally is computed from them and the maintainer writes only what the logs cannot
know — the probe readings at shutdown, and anything that went wrong.

## What this phase delivers

| # | Item | Owner | What closes it |
| --- | --- | --- | --- |
| E1 | The soak tally is computed from Pi's session logs, not remembered. | agent | `scripts/soak-tally.mjs`; `soak.md`'s tally section generated; a shutdown entry is three lines. |
| E2 | The soak is run on the Phase C build. | human | Five distinct days; every operation on every backend at least three times; a probe reading at every shutdown; the hand-off block read at every shutdown. |
| E3 | The Codex Desktop coexistence record exists for the pinned CLI. | human | One evidence block with PASS at every required checkpoint; `npm run codex:retained-release:check` green. |
| E4 | The end-state test is run, as written. | agent | A fresh agent's plans for the two requests in the simplification roadmap §7, recorded here, with any deviation a finding. |
| E5 | The Phase D decision is made on the soak's numbers. | agent, human sign-off | Each Phase D item marked *scheduled* (with the ADR as the next phase's first ticket) or *deferred* (with the re-read date), in the simplification roadmap, by its decision rule. |
| E6 | The simplification programme closes. | agent | The roadmap's §8 document split: banners on the historical documents, the change-surface method into the contributor rules, status lines. |
| E7 | `2.0.0` ships. | agent, human for the tag | Version bumped; the compatibility matrix marked frozen at 2.0; the README's install and rollback notes current; `npm run release:check` green on the tagged commit; the v2 roadmap's items 10 and 12 given their final wording. |

### E1. The soak tally, computed

Pi writes one JSONL file per Session under its sessions directory, with a
`session` header carrying the start time and the working directory, and a
`toolCall` entry per tool call carrying the tool's name and its arguments. An
`agent_start` call carries the Profile name; a Profile's file names its backend.
That is everything the tally's operation rows need: operation, backend, day.

`scripts/soak-tally.mjs <since-date>` reads every Session started on or after
the date, maps each `agent_start`, `agent_resume`, `agent_steer`, and
`agent_cancel` to a backend through the Profile files, counts occurrences and
distinct days per backend, counts Sessions as shutdowns and a second Session in
the same working directory on the same day as a switch, and prints the three
tables in the record's format. `agent_resume` names a Subagent id rather than a
Profile, so the script resolves it through the `agent_start` that produced it
in the same Session; a resume it cannot resolve is counted under *unknown* and
listed, so the tally never silently drops one.

What the script cannot know stays manual and gets small: a shutdown entry is
the date, the backend set that was live, and the pasted `/subagent diagnostics`
output, from which the probes, the health line's classes, and the hand-off
block — including `consumedBeforeLanding` — are read. The record's *Reading the
probes* section becomes *Writing a shutdown entry* and says exactly that.

The script is tooling for a process, not product: it lives in `scripts/`, is
not in `check`, and is not an operator command. It reads Pi's on-disk format,
which is Pi's to change; when it changes, the script fails loudly on a field it
cannot find rather than printing a smaller number.

### E2. The soak, run

Five distinct days on the Phase C build, with each of `agent_start`,
`agent_resume`, `agent_steer`, `agent_cancel` at least three times per backend
and at least three shutdowns and one switch per backend. The exit criteria in
[the soak record](soak.md) are unchanged. Two readings are added to every
shutdown entry because Phase D depends on them: the hand-off block and the
bare `/subagent` health line. A `ResultExpired` answer from `agent_result` for
a Run whose notice landed in the same Session is a severity-3 entry and is
Phase D's second decision rule firing.

### E3. The coexistence record

The procedure in [the coexistence document](../codex-desktop-coexistence-release.md)
is complete and has never been run. It needs Codex Desktop open beside a live
Session and one maintainer hour. It is human-only and has no substitute, and
`npm run release:check` cannot pass without it.

### E4. The end-state test

[The simplification roadmap §7](../v2-simplify/roadmap.md#7-the-end-state-test)
hands a new contributor two requests and reads their plan. Run it literally: a
fresh agent with no conversation context, the repository, and each request in
turn; record both plans here verbatim. The roadmap says what each plan should
and should not list. A plan that lists a module the roadmap says it should not
is a finding for E5 or for a 2.0.x fix, not a reason to soften the test.

### E5. The Phase D decision

Each Phase D item has a decision rule in
[the simplification roadmap](../v2-simplify/roadmap.md#phase-d--long-session-concerns-on-evidence-only).
When the soak's five days are logged, apply each rule to the log and mark the
item *scheduled* or *deferred* in the roadmap with the reading that decided it.
A scheduled item's ADR is the first ticket of the phase that implements it,
which is the Phase B and Phase C discipline. A deferred item names the date or
the release at which its rule is read again.

### E6. The programme close

[The simplification roadmap §8](../v2-simplify/roadmap.md#8-when-the-programme-closes)
names the split. Each historical document gains a one-line banner naming the
permanent document that supersedes it; the change-surface *method* moves into
the contributor rules and the measurements stay where they are as history;
the notification semantics document's §1 before/after tables and §8 are marked
historical while §2–§6 stay the text the matrix cites; the roadmap's status
line reads closed. Nothing is deleted.

### E7. The release

`package.json` to `2.0.0`. The compatibility matrix's status reads frozen at
2.0, with the rule that a cell changes only with a **[2.x change]** marker and
a ledger row. The README's install line is the tagged release and its rollback
paragraph names `#v1.0.0` as the previous major. `npm run release:check` — the
deterministic gate, all six live lanes, the retained-release check — is green
on the commit that is tagged `v2.0.0`. The v2 roadmap's item 10 reads met with
the soak's closing tally; item 12 stays *not met* by its own measure and
points at the change-surface table as what is true instead. The tag and the
push are the maintainer's.

## Sequencing

```text
Phase C gate closes
        │
        ├── E1 soak tally script            (agent, first: the soak needs it on day one)
        ├── E4 end-state test               (agent, any time after C)
        ├── E3 coexistence record           (human, any one hour)
        │
        ▼
E2 soak: five distinct days on the Phase C build    (human)
        │
        ▼
E5 Phase D decision, on the tally and the shutdown entries
        │
        ├── E6 programme close
        ▼
E7 release: release:check green → tag v2.0.0
```

E1 goes first because the first soak day should be counted by the script, not
reconstructed. E3 and E4 have no dependency and fill idle time. Nothing in E5
through E7 starts before the tally is full: a Phase D decision on three days is
the thing this phase exists to stop doing.

## The gate

Verified item by item; each reads PASS, OPEN, or NOT MET with its evidence.

### 1. The tally is generated and the entry is small

`scripts/soak-tally.mjs` prints the three tables from Pi's session logs; a
resume it cannot resolve is listed, not dropped; a format change fails loudly.
`soak.md`'s tally section says it is generated and by what; its shutdown entry
is date, live backends, and pasted diagnostics.

**Status:** OPEN.

### 2. The soak's exit criteria are met

Every operation on every backend at least three times across at least five
distinct days on the Phase C build; every shutdown entry reads zero on every
probe or a defect explains why; no open severity-1 or -2 defect; every
severity-3 fixed or marked intentional. The tally in the record equals the
script's output on the closing day.

**Status:** OPEN.

### 3. The coexistence record passes

One evidence block for the pinned Codex CLI with PASS at every required
checkpoint; `npm run codex:retained-release:check` exits 0.

**Status:** OPEN.

### 4. The end-state test is recorded

Both plans recorded verbatim below, with the roadmap's should and should-not
lists checked against each.

**Status:** OPEN.

### 5. Every Phase D item has a recorded decision

Three items, each *scheduled* or *deferred* in the roadmap, each with the
reading from the soak that decided it and, if deferred, the date of the next
reading.

**Status:** OPEN.

### 6. The programme's documents are split

Banners on every historical document; the change-surface method in the
contributor rules; the simplification roadmap's status reads closed.

**Status:** OPEN.

### 7. `release:check` is green on the tagged commit

`npm run release:check` exit 0 on the commit tagged `v2.0.0`, run after the
last code change, with the six lane markers and the retained-release marker
recorded here.

**Status:** OPEN.

### 8. The contracts are frozen and the roadmaps are final

The matrix's status reads frozen at 2.0 with the change rule; the README's
install and rollback paragraphs are current; the v2 roadmap's items 10 and 12
carry their final wording.

**Status:** OPEN.

## Risks

| Risk | Mitigation |
| --- | --- |
| The soak log stays empty a third time | E1 removes the writing; what remains is one pasted block per shutdown. If a day's usage happened and no entry exists, the script still counts the operations, and the gate says which shutdown readings are missing. |
| The soak finds a severity-2 defect after Phase C closed | The fix lands, has a test, and the soak restarts its day count on the fixed build. The record already says a fix that landed after the last day has not been soaked. |
| Phase D gets scheduled on a feeling | E5 applies written rules to written numbers, and the rules were written before the numbers existed. |
| The coexistence record never gets its hour | It is on the critical path of `release:check` and this document says so; it cannot be waived by an agent, only performed by a person. |
| Pi's session format changes under the script | The script fails on a missing field rather than undercounting, and it is tooling outside `check`, so the product is unaffected. |

## The end-state test, as recorded

_To be filled at E4._
