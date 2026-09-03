---
name: codex-upgrade
description: Verify the Codex App Server protocol contract after the codex CLI is upgraded. Use when upgrading or bumping the codex CLI, or when the Codex backend misbehaves right after a CLI update.
---

# Codex CLI upgrade verification

The Codex adapter's protocol contract is pinned to a verified codex-cli
version. After the CLI moves, run this procedure end to end.

Every gate below is a gate on the adapter that ships: the Codex adapter under
`extensions/subagent/backend/codex/`. There is one, and the 1.x Codex smokes
this procedure used to name were deleted with the implementation they tested.

## Steps

1. **Record the version.** `codex --version`. This value replaces the pinned
   version in the docs after every later gate passes.

2. **Regenerate and diff the vendored schema.**

   ```sh
   codex app-server generate-json-schema --out /tmp/codex-schema
   cp /tmp/codex-schema/ServerNotification.json /tmp/codex-schema/ClientRequest.json docs/codex-protocol/
   git diff docs/codex-protocol/
   ```

   Review every diff hunk that touches a shape the adapter consumes: the
   notification methods listed in `CODEX_NOTIFICATION_METHODS`, and every
   request the transport sends — `initialize`, `thread/start`, `turn/start`,
   `turn/steer`, `turn/interrupt` — plus the `thread/list` and `thread/read`
   the nondiscoverability proof uses. Inspect the generated
   `v2/ThreadStartResponse.json`, `v2/TurnStartResponse.json`,
   `v2/ThreadListResponse.json`, and `v2/ThreadReadResponse.json` too.

   Confirm that `thread/start` still accepts `ephemeral`, its response can
   report `path: null`, `turn/start` returns an id, and stored-thread
   list/read remain available.

   **What is tolerated and what is drift.** New optional fields, new
   notification methods, and new item variants are tolerated by construction:
   an undeclared method is ignored, and a `ThreadItem` variant the adapter
   does not read produces no observation rather than a malformed frame — both
   proven by `backend/codex/protocol.test.ts`. Newly *required* fields on a
   consumed shape, a renamed method, and a changed enum the adapter reads are
   drift the adapter must absorb, with a deterministic test for each. Complete
   this step only when every consumed hunk is classified.

3. **Run the no-quota gate.** `npm run check`. It must pass typechecking,
   lint, the shared backend conformance suite, the full deterministic suite,
   the byte-for-byte pinned schema comparison, and the protocol check's
   structural assertions for ephemeral pathlessness, Turn identity,
   stored-thread inspection, and every consumed notification method. Done
   means no failure and only documented existing skips.

4. **Run both authenticated Codex gates.**

   ```sh
   npm run codex:smoke
   npm run codex:host-smoke
   ```

   These spend quota and require an authenticated CLI. `codex:smoke` is the
   runtime gate over the adapter: it must print `CODEX_LIVE_SMOKE_PASS` only
   after proving start, resume on the retained root, a steer confirmed by
   client id producing exactly one user observation, cancellation that leaves
   the process and root alive, a Run cancelled at its timeout, that a second
   App Server can neither list nor read the ephemeral root, that no provider
   identity reached a public record, that every probe reads zero after the
   Session Scope closed, and that no App Server child and no observed
   descendant survives it. `codex:host-smoke` is the same backend through
   the surface a user has. A usage-limit error means wait for reset. Done means
   both exact success markers appear and no cleanup assertion fails.

5. **Run the Desktop coexistence check.** Follow
   `docs/codex-desktop-coexistence-release.md` while Codex Desktop is open,
   then add its completed evidence record. Done means Desktop works before,
   during the retained-idle checkpoint, during active Turn 2, and after the
   Session Scope closed; the runtime gate passes; and the record names the CLI
   and Desktop versions plus the operator and date.

6. **Update the pinned version.** Replace the codex-cli version in
   `docs/codex-protocol/README.md` and in the protocol-fidelity paragraph of
   `docs/architecture.md` — the two files the protocol check requires the
   version to appear in, and it fails naming whichever one is stale. Commit the
   schema diff, both stamps, and the coexistence evidence together, so the
   snapshot always names the release that produced and passed it.

7. **Close the recorded-evidence gate.** `npm run codex:retained-release:check`
   must print `CODEX_RETAINED_RELEASE_CHECK_PASS`. It verifies the installed
   pinned protocol and then refuses to pass until one complete matching
   evidence record exists for this CLI version and the referenced smoke log
   carries the runtime gate's marker and its cleanup evidence. It never
   fabricates or infers human evidence.
