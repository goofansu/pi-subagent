.PHONY: check dev-v1 dev-v2 fallback-status fallback-v1 fallback-v2 protocol-check release-gate smoke-codex smoke-v2-claude smoke-v2-codex smoke-v2-pi test-conformance test-v2-conformance

# v1 in isolation, for as long as v1 exists. The published extension is v2
# since the cutover; this is the frozen implementation, run deliberately.
dev-v1:
	pi --offline -np -nc -ns -ne -e extensions/subagent --tools agent_start,agent_wait,agent_cancel,agent_steer,agent_result

# v2 in isolation: every extension disabled, only the v2 entry point loaded.
# Since M5 the backends behind it are the real Pi and Claude adapters, so this
# runs real work against whatever Profiles the agent directory holds, on
# whichever backend each one names. `--offline` disables Pi's startup network
# calls, not inference, so Runs still reach a model.
# For using v2 rather than checking it, a plain `pi` is enough: the manifest
# names this entry point, so an installed package loads it.
dev-v2:
	pi --offline -np -nc -ns -ne -e extensions/subagent-v2/index.ts --tools agent_start,agent_resume,agent_wait,agent_result,agent_cancel,agent_steer

# The v1 fallback switch, which is the rollback the migration policy asks for.
# Since the cutover the manifest names v2, so plain `pi` already runs it and
# there is nothing to switch on for the ordinary case. `fallback-v1` disables
# the published extension and loads the frozen v1 entry point instead;
# `fallback-v2` reverses it. The two are never loaded together — they register
# the same six tool names. See the README's "Upgrading from 1.x".
fallback-v1:
	npm run fallback:v1:on

fallback-v2:
	npm run fallback:v1:off

fallback-status:
	npm run fallback:v1:status

test-conformance:
	npm run test:conformance

# The shared v2 backend conformance suite: the two fake backends and all three
# real adapters run exactly the same scenarios, and none of them skips one.
test-v2-conformance:
	npm run test:v2:conformance

protocol-check:
	npm run codex:protocol:check

smoke-codex:
	npm run codex:smoke

# The opt-in v2 live gates, one target per backend: a runtime gate over the
# adapter and a host gate through the surface a user has. All of them spend
# provider quota, all are in the release gate, and none is in `check`.
smoke-v2-pi:
	npm run v2:pi:smoke && npm run v2:pi:host-smoke

smoke-v2-claude:
	npm run v2:claude:smoke && npm run v2:claude:host-smoke

smoke-v2-codex:
	npm run v2:codex:smoke && npm run v2:codex:host-smoke

check:
	npm run check

release-gate:
	npm run release:check
