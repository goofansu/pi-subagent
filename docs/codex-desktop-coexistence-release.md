# Codex Desktop coexistence release check

This is the human-only companion to `npm run codex:resume-smoke`. It records
whether one retained, ephemeral App Server can remain usable beside Codex
Desktop while idle and while its second Turn is active, without a shared
rollout-writer conflict.

Release status: **OPEN** for codex-cli 0.150.1. Deterministic checks and the
procedure are implemented, but no authenticated/Desktop evidence record exists.
`npm run codex:retained-release:check` is a no-quota gate that first verifies
the installed pinned protocol and then refuses to pass until one complete
matching record below has `PASS` at every required checkpoint. It never
fabricates or infers human evidence.

## Procedure

1. Record the date, operator, OS, `codex --version`, and Codex Desktop version
   in a new evidence block below.
2. Confirm the configured Codex home already contains at least one ordinary
   stored thread that App Server `thread/list` and `thread/read` can access.
   The smoke uses that existing thread as a positive control before concluding
   that its ephemeral root is undiscoverable. It deliberately does not create
   model work for this control; without stored history, the release result is
   explicitly inconclusive and fails.
3. Open Codex Desktop, open an existing conversation, and complete one small
   prompt. Record the result as the before-smoke check.
4. From this repository run:

   ```sh
   CODEX_DESKTOP_COEXISTENCE_PROBE=1 npm run codex:resume-smoke
   ```

5. At the `retained-idle` prompt, return to Desktop. Open or continue a
   conversation and complete one small prompt while the App Server remains
   idle. Record the result, then return to the terminal and press Enter. This
   releases the smoke to admit Turn 2.
6. At the `active-Turn-2` prompt, immediately return to Desktop and complete a
   second small prompt while the retained Run is still in flight. Record both
   the Desktop outcome and whether overlap with active Turn 2 was actually
   observed, then return to the terminal and press Enter. If Turn 2 completed
   before the overlap could be observed, record this check as unproven and
   rerun the release procedure; an idle-only observation is not a substitute.
7. Require `CODEX_RESUME_LIVE_SMOKE_PASS`. After the smoke exits, complete one
   more Desktop prompt and record the result.
8. Record whether Desktop remained responsive, whether any rollout-writer or
   thread-storage conflict appeared, and a link or path to the retained smoke
   log. A release passes only when the before-smoke, retained-idle, overlapping
   active-Turn-2, and after-cleanup Desktop checks and the smoke all pass.
9. Run `npm run codex:retained-release:check`. Only its
   `CODEX_RETAINED_RELEASE_CHECK_PASS` marker closes the recorded evidence gate.

The two coexistence prompts are interactive-only and appear only when
`CODEX_DESKTOP_COEXISTENCE_PROBE=1`; run it from a terminal with usable stdin.
Each waits at most 10 minutes, then fails and cleans up. Human wait time is not
charged against the smoke's separate 240-second automated lifecycle budget.
The script supplies timing prompts but cannot assert Desktop usability or
guarantee how long the model Turn remains active; the operator's recorded
overlap evidence is the release authority.

The smoke spends authenticated model quota. Run this procedure only as an
explicit release action; it is not part of `npm run check`.

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
- `CODEX_RESUME_LIVE_SMOKE_PASS`: PASS/FAIL — evidence
- Descendant cleanup: observed process evidence / no persistent descendants observed
- Desktop after Session cleanup: PASS/FAIL — evidence
- Rollout-writer/storage conflict observed: YES/NO — evidence
- Release conclusion: PASS/FAIL
```

## Evidence records

No Desktop coexistence run has been recorded for codex-cli 0.150.1 yet.
