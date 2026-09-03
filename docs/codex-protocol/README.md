# Vendored Codex App Server protocol snapshot

Generated from codex-cli 0.153.0 with:

```sh
codex app-server generate-json-schema --out <dir>
```

The two complete protocol unions the Codex adapter consumes are vendored:

- `ServerNotification.json` — every notification the transport may receive.
  The envelope requires only `method` + `params`; the reader in
  `extensions/subagent/backend/codex/protocol.ts` demands only
  schema-required fields from the notifications it consumes, and the methods
  it consumes are exported as `CODEX_NOTIFICATION_METHODS` so the drift check
  and the reader cannot disagree about the list.
- `ClientRequest.json` — the requests the transport sends (`initialize`, one
  ephemeral `thread/start`, repeated `turn/start`, `turn/steer`, and
  `turn/interrupt`) plus the `thread/list` and `thread/read` operations used by
  the authenticated nondiscoverability proof. Production sends no
  `thread/resume`.

After upgrading the codex CLI, regenerate and overwrite these files, then
`git diff` them. Also inspect generated `v2/ThreadStartResponse.json`,
`v2/TurnStartResponse.json`, `v2/ThreadListResponse.json`, and
`v2/ThreadReadResponse.json`: a newly required field or renamed method in a
consumed shape is drift the adapter must absorb; added optional fields and new
notification variants are already tolerated. The full upgrade procedure is
the `codex-upgrade` skill in `.agents/skills/codex-upgrade/SKILL.md`.
The upgrade must also re-run the retained two-Turn proof, verify there is still
no live-session continuation attachment, and exercise bounded idle and active
stdio shutdown through the adapter's own cleanup escalation.

For a non-mutating check against the currently installed pinned CLI, run:

```sh
npm run codex:protocol:check
```

The no-quota check also requires generated ephemeral support, a nullable root
thread path, Turn identities, stored-thread inspection methods, and every
notification method consumed by the retained transport. The adapter's own
deterministic tests — schema-minimum frames, repeated Turns, interruption,
stdio shutdown, and steer correlation — verify the behavioural contract
against the stand-in App Server. The authenticated `npm run codex:smoke`
then proves one pathless root thread across two Turns, its nondiscoverability
from a second App Server, and that the whole process tree is gone after the
Session Scope closes.

Pathlessness means the client-created root has no stored/listable rollout. It
does not promise zero shared-home I/O and does not prohibit provider-native
child threads or tool processes. The retained lifecycle remains unreleased for
a pinned CLI until `npm run codex:retained-release:check` finds both the live
smoke marker/cleanup proof and complete human Desktop coexistence evidence.
