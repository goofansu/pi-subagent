# Architecture

## Project trust flow

```text
Pi session (trust already resolved)
        │  ctx.isProjectTrusted()
        ▼
sessionFactsOf() → SessionFacts.projectTrusted
        ▼
supervisor.ts → SubagentContext.projectTrusted (fixed per Subagent)
        ▼
   ┌────────────┴────────────┐
   ▼                         ▼
Claude adapter           Pi adapter
settingSources:          SettingsManager.create({ projectTrusted })
  trusted → omitted      resolveProjectTrust: () => projectTrusted
  untrusted → ["user"]
```
