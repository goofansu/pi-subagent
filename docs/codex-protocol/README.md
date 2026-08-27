# Vendored Codex App Server protocol snapshot

Generated from codex-cli 0.147.0 with:

```sh
codex app-server generate-json-schema --out <dir>
```

Only the two files the Codex adapter's contract depends on are vendored:

- `ServerNotification.json` — every notification the transport may receive.
  The envelope requires only `method` + `params`; the parser in
  `extensions/subagent/harnesses/codex/app-server.ts` demands only
  schema-required fields from the notifications it consumes.
- `ClientRequest.json` — the requests the transport sends (`initialize`,
  `thread/start`, `turn/start`, `turn/interrupt`).

After upgrading the codex CLI, regenerate and overwrite these files, then
`git diff` them: a newly required field or a renamed method in a consumed
shape is drift the adapter must absorb; added optional fields and new
notification variants are already tolerated. The full upgrade procedure is
the `codex-upgrade` skill in `.agents/skills/codex-upgrade/SKILL.md`.
