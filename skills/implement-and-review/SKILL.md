---
name: implement-and-review
description: Implement a spec or tickets through an implementer and fresh spec and standards reviews. Use when user asks to implement-and-review a spec or tickets explicitly.
---

# Implement and review

```text
unit → implementer ⇄ fresh spec-reviewer + standards-reviewer → commit → next unit
```

The spec is the contract. Execute it as written. Where it is silent, contradictory,
or wrong in a way that requires an implementation choice, stop and report the
gap rather than choosing for the user.

Use the implementer's report and the two reviewer verdicts to decide the loop;
do not form a third code-review opinion. Once a subagent Run is active, wait for
it rather than reading the tree in parallel.

Run unattended until every unit is clean and committed or the session reaches a
stop condition.

## Prepare

Read the full spec or ticket set. Preparation is complete when the units are in
dependency order, every acceptance criterion is accounted for by the relevant
unit or units, and the required repository checks are identified.

Treat a single unsliced spec as one unit. Process multiple tickets one at a time
in dependency order.

Require `git status --short` to be empty before the first unit. Existing tracked
or untracked work would contaminate the reviewers' `git diff HEAD` scope, so a
dirty initial tree stops the session.

## Run each unit

### 1. Implement

Keep the same implementer throughout a unit and all of its review revisions.
Between committed units, resume that implementer by default. Start fresh only
when the next unit is self-contained and prior implementation context does not
contribute to it. The committed tree and the new unit brief are the handoff
source of truth.

Brief a new or resumed implementer with the exact unit contract, required shared
spec context, completed prerequisite commits, and prior reported decisions that
constrain the unit. Save the stable Subagent ID selected for the unit and resume
that ID for revisions.

Keep only one implementation Run active because all Runs share the same working
tree. The implementation step is complete when its report accounts for:

- changes made and acceptance criteria met or unmet;
- required checks and their results; and
- spec gaps, deviations, and remaining risks.

Return an incomplete report or failing check to the same implementer with the
missing item or exact failure. A spec gap that requires a choice stops the
session with the unit uncommitted.

### 2. Review

For every review round, start new `spec-reviewer` and `standards-reviewer`
Subagents in parallel. Fresh reviewers always use `agent_start`, including on
re-review.

Give both reviewers the scope (`git diff HEAD` plus untracked files) and the
latest implementer report. Give `spec-reviewer` the exact unit contract and
required shared spec context. Let `standards-reviewer` discover the applicable
repository standards and keep requested behavior outside its axis.

On re-review, give each reviewer only that axis's prior findings and the
implementer's responses. Keep the reports separate, wait for both, and decide
the round only after both verdicts arrive.

### 3. Decide, revise, or commit

The unit is clean only when both verdicts are `clean` and all required checks
pass. Non-blocking findings remain risks for the final report but do not prevent
a clean verdict.

If either axis has blocking findings, resume the unit's implementer with every
finding, its axis and resolution condition, and your rationale for any dispute
based on the contract and reports. After the revision reports passing checks,
start a fresh review round on both axes.

If the same underlying finding remains blocking on the same axis in two
consecutive rounds, declare a stalemate and stop. A changed wording or line
anchor does not make it a new finding.

Commit each clean unit before starting the next. Follow repository commit
conventions, identify the unit, and keep hooks enabled. Correct commit-metadata
failures yourself; return code or check failures to the implementer, then run
both review axes again after any implementation revision. Do not bypass a
failing hook.

A unit is complete only when the commit succeeds, its hash is recorded, and
`git status --short` is empty. Each completed unit has exactly one commit.

## Complete the session

A stop condition ends the session; do not start later units. The session is
clean only when every unit has passed both review axes and required checks,
every unit has one recorded commit, and the final working tree is clean.

Report:

- each completed unit, its changes, satisfied criteria, and commit hash;
- checks run and their results;
- what each review round resolved; and
- unmet criteria, gaps, risks, and stalemates.
