---
name: codex-upgrade
description: Verify the Codex App Server protocol contract after the codex CLI is upgraded. Use when upgrading or bumping the codex CLI, or when the Codex harness misbehaves right after a CLI update.
---

# Codex CLI upgrade verification

The Codex adapter's protocol contract is pinned to a verified codex-cli
version. After the CLI moves, run this procedure end to end. The invariant
being defended lives in the protocol-fidelity item of
`docs/harness-definition-of-done.md`.

## Steps

1. **Record the version.** `codex --version`. This value replaces the pinned
   version in the docs after every later gate passes.

2. **Regenerate and diff the vendored schema.**

   ```sh
   codex app-server generate-json-schema --out /tmp/codex-schema
   cp /tmp/codex-schema/ServerNotification.json /tmp/codex-schema/ClientRequest.json docs/codex-protocol/
   git diff docs/codex-protocol/
   ```

   Review every diff hunk that touches a shape the adapter consumes — the
   notification methods named in `CodexAppServerEvent` and every request sent
   by `extensions/subagent/harnesses/codex/app-server.ts`. Inspect the generated
   `v2/ThreadStartResponse.json`, `v2/TurnStartResponse.json`,
   `v2/ThreadListResponse.json`, and `v2/ThreadReadResponse.json` too. Confirm
   that `thread/start` still accepts `ephemeral`, its response can report
   `path: null`, `turn/start` returns an ID, and stored-thread list/read remain
   available. New optional fields and notification/item variants are tolerated;
   newly required fields, renamed methods, and changed consumed enums are drift.
   Complete this step only when every consumed hunk is classified and all drift
   has deterministic coverage.

3. **Run the no-quota gate.** `npm run check`. It must pass typechecking, lint,
   conformance, the full deterministic suite, byte-for-byte pinned schema
   comparison, and structural checks for ephemeral pathlessness, repeated
   Turns, notification identities, and stored-thread inspection. Done means no
   failure and only documented existing skips.

4. **Run both authenticated Codex gates.**

   ```sh
   npm run codex:smoke
   npm run codex:resume-smoke
   ```

   These spend quota and require an authenticated CLI. The steering smoke must
   prove active-Turn steering and interruption. The resume smoke must print
   `CODEX_RESUME_LIVE_SMOKE_PASS` only after proving one retained App Server,
   one initialization, one ephemeral pathless root thread, two distinct Turns
   on that thread, no `thread/resume`, marker recall without replay, a second
   App Server's inability to list/read the root, immutable Results and
   notifications, provider-ID confinement, and complete stdio/process-tree
   shutdown. A usage-limit error means wait for reset. Done means both exact
   success markers appear and no cleanup assertion fails.

5. **Run the Desktop coexistence check.** Follow
   `docs/codex-desktop-coexistence-release.md` while Codex Desktop is open, then
   add its completed evidence record. Done means Desktop works before, during,
   and after the retained smoke; the smoke passes; and the record names the CLI
   and Desktop versions plus the operator and date.

6. **Update the pinned version.** Replace the codex-cli version in
   `docs/codex-protocol/README.md` and in the protocol-fidelity item of
   `docs/harness-definition-of-done.md`. Commit the schema diff, both stamps,
   and coexistence evidence together, so the snapshot always names the release
   that produced and passed it.
