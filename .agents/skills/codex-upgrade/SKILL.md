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
   version in the docs at step 5.

2. **Regenerate and diff the vendored schema.**

   ```sh
   codex app-server generate-json-schema --out /tmp/codex-schema
   cp /tmp/codex-schema/ServerNotification.json /tmp/codex-schema/ClientRequest.json docs/codex-protocol/
   cp /tmp/codex-schema/v2/ThreadResumeResponse.json docs/codex-protocol/v2/
   git diff docs/codex-protocol/
   ```

   Review every diff hunk that touches a shape the adapter consumes — the
   notification methods named in `CodexAppServerEvent`, the requests sent by
   the transport, and the resumed-thread attachment response consumed by
   `thread/resume`, all in
   `extensions/subagent/harnesses/codex/app-server.ts`. Classify each hunk:
   a new optional field or a new notification/item variant is tolerated by
   design; a newly required field, a renamed method, or a changed enum value
   in a consumed shape is drift — fix the parser and its tests before
   continuing. Done when every consumed-shape hunk is classified and no
   drift remains unfixed.

3. **Run the unit suite.** `npm test` — all green. (This catches adapter
   regressions, not wire drift; that is what steps 2 and 4 are for.)

4. **Run the live smoke.**

   ```sh
   node --import tsx scripts/codex-live-smoke.mjs
   ```

   It drives the shipped transport and translator through a real answer
   turn and a real interrupt, and must print `PASS`. It spends real Codex
   quota and needs an authenticated codex CLI; a usage-limit error means
   wait for the reset, not a protocol failure.

5. **Update the pinned version.** Replace the codex-cli version in
   `docs/codex-protocol/README.md` and in the protocol-fidelity item of
   `docs/harness-definition-of-done.md`. Commit the schema diff and both
   stamps together, so the vendored snapshot always states the version that
   produced it.
