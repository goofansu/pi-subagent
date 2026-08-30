# Vendored Codex App Server protocol snapshot

Generated from codex-cli 0.150.1 with:

```sh
codex app-server generate-json-schema --out <dir>
```

Only the three files the Codex adapter's contract depends on are vendored:

- `ServerNotification.json` — every notification the transport may receive.
  The envelope requires only `method` + `params`; the parser in
  `extensions/subagent/harnesses/codex/app-server.ts` demands only
  schema-required fields from the notifications it consumes.
- `ClientRequest.json` — the requests the transport sends (`initialize`,
  `thread/start`, `thread/resume`, `turn/start`, `turn/steer`,
  `turn/interrupt`).
- `v2/ThreadResumeResponse.json` — the attachment response consumed when a
  fresh Attempt resumes the adapter-owned Conversation. Historical `turns`
  are attachment data; the adapter reads only the returned thread identity
  and never translates attached Turns into the current Run.

After upgrading the codex CLI, regenerate and overwrite these files, then
`git diff` them: a newly required field or a renamed method in a consumed
shape is drift the adapter must absorb; added optional fields and new
notification variants are already tolerated. The full upgrade procedure is
the `codex-upgrade` skill in `.agents/skills/codex-upgrade/SKILL.md`.

For a non-mutating check against the currently installed pinned CLI, run:

```sh
npm run codex:protocol:check
```

The generated request snapshot includes native `thread/resume` and
`turn/steer`; the response snapshot pins the resume attachment shape; and the
server snapshot includes the `userMessage` item and client correlation field
consumed by the adapter. Focused schema-minimum, continuation, and
steering-correlation tests verify that the wire shapes used by the transport
remain synchronized.
