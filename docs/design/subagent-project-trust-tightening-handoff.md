# Subagent Project-Trust Tightening Handoff

## Status

Implemented in `extensions/subagent/project-config-policy.ts` and the neutral
subagent stack.

This change tightens how the extension translates Pi's project-trust state into
permission for delegated harnesses to load project-controlled configuration. It
does not introduce a sandbox or change tool permissions.

## Problem

The extension currently captures `ctx.isProjectTrusted()` at `session_start`
and forwards that boolean throughout the subagent stack:

- `extensions/subagent/index.ts` captures the value and uses it for project
  agent discovery.
- `extensions/subagent/runner.ts` copies it onto the backend task.
- `extensions/subagent/backends/pi.ts` maps it to `--approve` or
  `--no-approve`.
- The Claude and Codex backends use it to decide whether project settings,
  integrations, and MCP configuration may load.

That preserves the parent session's decision and correctly fails closed when a
host cannot report trust. The boolean is nevertheless broader than the policy
the extension needs.

Pi returns `true` without consulting `trust.json`, `defaultProjectTrust`, or the
interactive trust flow when the current directory has no resources that require
trust. In that case, `true` means "there was nothing to gate," not "the person
approved project-controlled configuration."

Forwarding that vacuous result as explicit approval creates a time-of-check /
time-of-use problem:

1. A parent session starts in a checkout with no trust-gated Pi resources.
2. Pi reports the session as trusted without prompting.
3. A checkout, command, generator, or other process adds project configuration.
4. A later subagent starts as a new process with explicit trusted-project flags.
5. The child may load the newly introduced configuration without a trust
   decision ever having been made for it.

There is a related discovery issue: `.pi/agents` is owned by this extension and
is not one of Pi's built-in trust-requiring paths. A checkout containing only
`.pi/agents` can therefore receive Pi's vacuous `true`, causing project agent
profiles to load without a prompt.

## Goals

- Preserve trusted-project integrations after a meaningful Pi trust decision.
- Do not turn the absence of trust-gated resources into explicit child approval.
- Keep unknown state fail-closed.
- Apply one policy consistently to Pi, Claude, Codex, and project agent
  discovery.
- Keep the decision stable for the lifetime of the parent session.
- Describe the feature as configuration gating rather than a security sandbox.

## Non-goals

- Restricting filesystem, shell, credential, or network access.
- Preventing prompt injection from repository content or command output.
- Changing the tools available to any harness.
- Reimplementing Pi's full trust resolver.
- Prompting separately for every delegation.
- Dynamically upgrading trust when files appear during a session.

## Terminology

Use two distinct concepts:

- **Pi project trust**: the value reported by `ctx.isProjectTrusted()`.
- **Project configuration permission**: whether a delegated harness may load
  project-controlled settings, resources, integrations, or project agent
  profiles.

Name the second value `allowProjectConfig`. Do not call it `projectTrusted` in
the dispatcher or backend layer; that name encourages callers and UI text to
claim more than the value guarantees.

## Decision

Compute `allowProjectConfig` once during `session_start` from three inputs:

1. Pi's captured trust value.
2. Whether Pi trust-requiring resources existed at session start.
3. Whether the current directory or an ancestor has an explicitly saved
   positive decision in Pi's trust store.

Conceptually:

```ts
allowProjectConfig =
  piProjectTrusted &&
  (hadTrustRequiringResources || savedTrustDecision === true);
```

Pi exports both APIs required for this check:

```ts
import {
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
```

Use the configured Pi agent directory when constructing `ProjectTrustStore`, so
custom agent-directory configurations continue to work.

### Decision table

| Pi reports trusted | Trust-gated resources at startup | Saved decision | Project config |
| --- | --- | --- | --- |
| no | any | any | deny |
| yes | yes | any | allow |
| yes | no | true on cwd/ancestor | allow |
| yes | no | false or absent | deny |
| unavailable | any | any | deny |

A current-session override remains authoritative when trust-gated resources
exist. For example, `--no-approve` must deny even if `trust.json` says true, and
`--approve` must allow even if it says false.

When no trust-gated resources exist, the extension deliberately requires a
saved positive decision before converting Pi's otherwise ambiguous `true` into
child approval. This is conservative: a one-run `--approve` or
`defaultProjectTrust: "always"` cannot currently be distinguished from vacuous
trust through the extension context. A richer Pi trust-result API would allow
that distinction in the future.

### Snapshot semantics

Capture the inputs and resulting permission once at `session_start`. Every
subagent spawned by that parent session uses the same result.

Do not re-run the resource check during `execute()`. Rechecking and upgrading
would recreate the bug: newly added resources could grant themselves child
configuration permission. A user who adds configuration intentionally can
restart Pi and complete the normal trust flow.

A permission that was meaningfully granted at startup may remain granted if
files later change. Project trust applies to the folder, not only to the exact
files present at the instant of approval.

## `.pi/agents` behavior

Use `allowProjectConfig`, not raw Pi trust, in `buildAgentConfigLayers()`.

If `.pi/agents` exists but project configuration is denied:

- exclude all project profiles;
- continue loading user profiles;
- expose a concise warning through `/agents` explaining that project agent
  profiles were skipped;
- direct the user to `/trust` and a Pi restart if they intend to approve the
  folder.

A saved positive decision makes `.pi/agents` usable even when it is the only
project-controlled Pi resource. This avoids requiring users to add an empty
`.pi/settings.json` merely to trigger core trust discovery.

Do not create an extension-owned trust file or a second interactive prompt.
Pi's canonical trust store remains the source of persisted decisions.

## Error handling

`ProjectTrustStore.getEntry()` can fail if the trust store is unreadable or
invalid. Treat that as denied rather than aborting extension startup.

Return a small diagnostic object from the policy resolver rather than only a
boolean:

```ts
interface ProjectConfigPolicy {
  piProjectTrusted: boolean;
  allowProjectConfig: boolean;
  reason:
    | "pi-untrusted"
    | "trust-required-and-approved"
    | "saved-approval"
    | "vacuous-trust"
    | "trust-store-error";
  warning?: string;
}
```

The reason supports tests and accurate `/agents` messaging. Do not expose trust
store paths or raw parser errors to the model; a short UI warning is sufficient.

## Implementation outline

### 1. Add a policy resolver

Create a small module such as:

```text
extensions/subagent/project-config-policy.ts
```

It should accept `cwd`, `agentDir`, and the captured Pi trust boolean. Keep
filesystem and trust-store access inside this module so policy tests can use
temporary directories and agent stores.

### 2. Resolve at session start

In `extensions/subagent/index.ts`:

1. Capture `ctx.cwd`.
2. Read `ctx.isProjectTrusted?.() ?? false`.
3. Resolve and snapshot `ProjectConfigPolicy`.
4. Use `allowProjectConfig` for layered agent discovery.
5. Pass the permission into registered commands and the runner closure.
6. Notify once if the resolver produced a trust-store warning.

The `execute()` handler must continue using the captured value rather than
calling `ctx.isProjectTrusted()` again.

### 3. Rename propagation fields

Rename the neutral stack's `projectTrusted` field to `allowProjectConfig` in:

- `extensions/subagent/index.ts`
- `extensions/subagent/runner.ts`
- `extensions/subagent/backend.ts`
- `extensions/subagent/agents.ts`
- `extensions/subagent/agents-command.ts`
- backend option builders and task reads
- affected tests

Backend-native arguments may still use their native names, such as Codex's
`trust_level`; the neutral value feeding them must be named for its actual
purpose.

### 4. Map the permission in each backend

- **Pi:** `true` becomes `--approve`; `false` becomes `--no-approve`.
- **Claude:** `true` permits normal project settings; `false` retains the
  guarded setting sources and strict MCP behavior.
- **Codex:** `true` permits the trusted-project path; `false` retains untrusted
  project level, integration disabling, and inherited MCP/app cleanup.

Do not change approval bypass, sandbox mode, tool allowlists, or nesting guards.

### 5. Update UI and documentation

Avoid displaying `✓ Project trusted` when the extension means only that project
configuration is enabled. Prefer wording such as:

```text
✓ Project configuration enabled
⚠ Project configuration disabled — [p] project agents excluded
```

Update the README trust section to explain:

- the extension derives a conservative configuration permission from Pi trust;
- vacuous Pi trust is not forwarded as child approval;
- saved positive decisions permit `.pi/agents`;
- context files may still load according to each harness;
- configuration gating does not restrict tools or system access.

## Tests

Add focused policy tests plus update existing propagation tests.

Required cases:

1. Missing `isProjectTrusted` fails closed.
2. Pi untrusted plus saved approval remains denied.
3. Pi trusted plus a trust-requiring resource is allowed.
4. Pi trusted plus an inherited saved positive decision is allowed.
5. Pi trusted with no resources and no saved decision is denied.
6. Pi trusted with a saved negative decision and no resources is denied.
7. An invalid or unreadable trust store denies and returns a warning.
8. `.pi/agents` alone is excluded without saved approval.
9. `.pi/agents` alone is included with saved approval.
10. Resources introduced after session start do not upgrade the captured
    permission.
11. Pi receives `--no-approve` for vacuous trust.
12. Claude and Codex receive their guarded configuration for vacuous trust.
13. Existing approved-project behavior remains unchanged across all backends.
14. `/agents` reports configuration permission accurately.

Preserve the existing test proving that execution does not re-read trust from
the tool-call context.

## Validation

Run:

```bash
npm test
npm run typecheck
npm run lint:check
```

Also perform these manual checks:

1. Start Pi in a temporary repository with only `.pi/agents`; verify the profile
   is excluded and `/agents` explains how to approve it.
2. Use `/trust` to save approval, restart, and verify the profile appears.
3. Start in a configuration-free repository, then add `.pi/extensions` during
   the session; verify a delegated Pi child still receives `--no-approve`.
4. Start in a repository containing a normal trust-gated resource, approve it,
   and verify Pi, Claude, and Codex retain their trusted-project behavior.

## Acceptance criteria

- Vacuous Pi trust is never translated into child project-config approval.
- A meaningful current-session trust decision still reaches every backend.
- Saved positive cwd or ancestor decisions enable extension-owned
  `.pi/agents`.
- Unknown and trust-store-error states fail closed.
- Permission cannot upgrade during a running parent session.
- `/agents` does not mislabel configuration permission as repository safety.
- README language does not describe project trust as a sandbox.
- All automated validation passes.

## Future Pi API improvement

The conservative fallback exists because `ctx.isProjectTrusted()` exposes only
a boolean. A future Pi API could return provenance, for example:

```ts
{
  trusted: boolean;
  reason: "override" | "extension" | "saved" | "default" | "prompt" | "not-required";
}
```

With that API, this extension could honor one-run `--approve` and
`defaultProjectTrust: "always"` even when no built-in resource existed, while
still rejecting `reason: "not-required"`. Until then, the saved-decision and
resource-presence rule is the fail-closed behavior.
