# Codex Desktop coexistence release check

This is the human-only companion to `npm run codex:smoke`. It records
whether one retained, ephemeral App Server can remain usable beside Codex
Desktop while idle and while its second Turn is active, without a shared
rollout-writer conflict.

The gate it accompanies is the **Codex runtime gate** — the adapter that
ships, driven through the supervisor that ships. That was the whole change from
the 1.x form of this document: the release being cleared has to be the release
that goes out.

Release status: **OPEN** for codex-cli 0.153.0. Deterministic checks and the
procedure are implemented, but no authenticated/Desktop evidence record exists
for any CLI version. `npm run codex:retained-release:check` is a no-quota gate
that first verifies the installed pinned protocol and then refuses to pass
until one complete matching record below has `PASS` at every required
checkpoint. It never fabricates or infers human evidence.

## Procedure

1. Record the date, operator, OS, `codex --version`, and Codex Desktop version
   in a new evidence block below.
2. Confirm the configured Codex home already contains at least one ordinary
   stored thread that App Server `thread/list` and `thread/read` can access.
   The gate uses that existing thread as a positive control before concluding
   that its ephemeral root is undiscoverable. It deliberately does not create
   model work for this control; without stored history the release result is
   explicitly inconclusive and the check fails, naming what is missing.
3. Open Codex Desktop, open an existing conversation, and complete one small
   prompt. Record the result as the before-smoke check.
4. From this repository run:

   ```sh
   CODEX_DESKTOP_COEXISTENCE_PROBE=1 npm run codex:smoke
   ```

5. At the `retained-idle` prompt, return to Desktop. Open or continue a
   conversation and complete one small prompt while the retained App Server is
   idle between Turns. Record the result, then return to the terminal and press
   Enter. This releases the gate to resume the Subagent.
6. At the `active-Turn-2` prompt, immediately return to Desktop and complete a
   second small prompt while the resumed Run is still in flight. Record both
   the Desktop outcome and whether overlap with the active Turn was actually
   observed, then return to the terminal and press Enter. If the Turn completed
   before the overlap could be observed, record this check as `UNPROVEN` and
   rerun the release procedure; an idle-only observation is not a substitute.
7. Require `CODEX_LIVE_SMOKE_PASS`. After the gate exits, complete one more
   Desktop prompt and record the result.
8. Record whether Desktop remained responsive, whether any rollout-writer or
   thread-storage conflict appeared, and a link or path to the gate's log. A
   release passes only when the before-smoke, retained-idle, overlapping
   active-Turn-2, and after-cleanup Desktop checks and the gate all pass.
9. Run `npm run codex:retained-release:check`. Only its
   `CODEX_RETAINED_RELEASE_CHECK_PASS` marker closes the recorded evidence
   gate.

The two coexistence prompts are interactive-only and appear only when
`CODEX_DESKTOP_COEXISTENCE_PROBE=1`; run it from a terminal with usable stdin.
Each waits at most 10 minutes, then fails and cleans up. Human wait time is not
charged against the gate's own bound: a pause pushes the deadline out by
exactly how long it lasted, so a careful operator is not punished by a timeout.

The gate supplies timing prompts but cannot assert Desktop usability or
guarantee how long the model Turn remains active; the operator's recorded
overlap evidence is the release authority.

The gate spends authenticated model quota. Run this procedure only as an
explicit release action; it is not part of `npm run check`.

## What the gate's log must carry

`npm run codex:retained-release:check` reads the log the record names and
requires the runtime gate's own evidence in it:

- `CODEX_LIVE_SMOKE_PASS`;
- `the retained root is neither listed nor readable by a second App Server` —
  the nondiscoverability proof, with its positive control;
- `no App Server child remains after closure` — the child this process
  spawned is gone once the Session Scope closed;
- either `all observed App Server descendants are gone after closure` or the
  note that no persistent descendant was observed, so an unexercised
  descendant check can never read as a passing one.

## Evidence record template

Copy this block for each Codex CLI release. Keep failed records as evidence and
add a later passing record rather than rewriting history.

```md
### YYYY-MM-DD — codex-cli X.Y.Z

- Operator:
- OS:
- Codex Desktop version:
- Smoke log:
- Desktop before smoke: PASS/FAIL — evidence
- Desktop during retained-idle prompt: PASS/FAIL — evidence
- Desktop during active Turn 2: PASS/FAIL/UNPROVEN — overlap evidence
- `CODEX_LIVE_SMOKE_PASS`: PASS/FAIL — evidence
- Descendant cleanup: observed process evidence / no persistent descendants observed
- Desktop after Session cleanup: PASS/FAIL — evidence
- Rollout-writer/storage conflict observed: YES/NO — evidence
- Release conclusion: PASS/FAIL
```

## Evidence records

No Desktop coexistence run has been recorded for codex-cli 0.153.0. The 1.x
form of this gate never accumulated one either, so nothing was lost by the
change of procedure: the outstanding work is the same run it always was, now
taken against the adapter that ships.
