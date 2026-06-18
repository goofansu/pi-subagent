# Package Agent Discovery Design

## Goal

When users install a Pi package such as `pi install https://github.com/goofansu/pi-stuff`, `pi-subagent` should automatically discover Markdown agents in the installed package's `agents/` directory and register them for the `subagent` tool and `/agents` command.

## Current behavior

Pi packages conventionally expose `extensions/`, `skills/`, `prompts/`, and `themes/`. Packages may also contain `agents/`, but Pi core does not treat agents as a first-class package resource.

`pi-subagent` currently discovers agents from:

1. bundled `pi-subagent/agents/`
2. user `~/.pi/agent/agents/`
3. project `.pi/agents/`

This means installed package agents such as `~/.pi/agent/git/github.com/goofansu/pi-stuff/agents/` are cloned to disk but not loaded automatically.

## Design

Add package-agent discovery inside `pi-subagent`, not Pi core. `pi-subagent` will inspect installed Pi package roots and add each package's `agents/` directory as an agent config layer when that directory exists.

Agent precedence, from lowest to highest, will be:

1. bundled `pi-subagent/agents/`
2. installed package `agents/`
3. user `~/.pi/agent/agents/`
4. project `.pi/agents/`

If two installed packages define the same agent name, the package processed later wins. This matches the existing ordered-layer behavior where later layers override earlier layers.

## Source labels in `/agents`

`/agents` should display source badges that align with Pi's existing autocomplete badges:

- `[p]` project agents from `.pi/agents/`
- `[u]` user agents from `~/.pi/agent/agents/`
- `[t]` package agents from installed Pi packages
- bundled/default agents may keep the existing unprefixed/default treatment

Here `[t]` intentionally follows Pi's current display style for installed package skills in autocomplete. It means these agents came from an installed package/resource context rather than a direct user or project override.

## Package roots

The implementation should reuse Pi's package/settings model where possible instead of hard-coding repository names. It should work for globally installed packages under `~/.pi/agent` and project-installed packages under `.pi/` when those packages are available to the current session.

The concrete directories to support include git package installs such as:

- `~/.pi/agent/git/github.com/goofansu/pi-stuff/agents/`
- `~/.pi/agent/git/github.com/obra/superpowers/agents/`

The same discovery concept should also apply to npm and local path packages if their resolved package roots contain `agents/`.

## Error handling

Package agent files use the same parser and validation as other agents:

- missing `description` frontmatter is invalid
- missing prompt body is invalid
- invalid files are skipped
- skipped files are reported with the existing startup warning mechanism

Missing `agents/` directories are ignored silently.

## Testing

Add tests for:

- package agent layers are included between bundled/default and user/project layers
- installed package agents are loaded from package `agents/` directories
- user agents override package agents with the same name
- project agents override package agents with the same name
- later package layers override earlier package layers for duplicate names
- `/agents` source formatting renders package agents with `[t]`
- invalid package agent files are skipped and reported through diagnostics

## Non-goals

- Do not add `agents` as a first-class Pi core package resource type in this change.
- Do not copy or symlink package agents into `~/.pi/agent/agents/`.
- Do not change the existing agent Markdown format.
