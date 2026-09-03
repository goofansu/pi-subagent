.PHONY: check dev dev-v2 dogfood-status dogfood-v1 dogfood-v2 protocol-check release-gate smoke-codex smoke-v2-pi test-conformance test-v2-conformance

dev:
	pi --offline -np -nc -ns -ne -e extensions/subagent --tools agent_start,agent_wait,agent_cancel,agent_steer,agent_result

# v2 in isolation: every extension disabled, only the v2 entry point loaded.
# Since M4 the backend behind it is the real Pi adapter, so this runs real work
# against whatever Profiles the agent directory holds. `--offline` disables
# Pi's startup network calls, not inference, so Runs still reach a model.
# For using v2 rather than checking it, `dogfood-v2` is the daily driver.
dev-v2:
	pi --offline -np -nc -ns -ne -e extensions/subagent-v2/index.ts --tools agent_start,agent_resume,agent_wait,agent_result,agent_cancel,agent_steer

# The dogfood switch: v2 with the Pi backend, beside every other extension,
# and with this package's v1 extension disabled so the two cannot both
# register `agent_start`. After `dogfood-v2`, plain `pi` runs v2; `dogfood-v1`
# puts it back. See the README's "Running v2 as the daily driver".
dogfood-v2:
	npm run v2:dogfood:on

dogfood-v1:
	npm run v2:dogfood:off

dogfood-status:
	npm run v2:dogfood:status

test-conformance:
	npm run test:conformance

# The shared v2 backend conformance suite. Pointed at the two fake backends
# today; every real adapter from M4 onward runs the same scenarios.
test-v2-conformance:
	npm run test:v2:conformance

protocol-check:
	npm run codex:protocol:check

smoke-codex:
	npm run codex:smoke

# The two opt-in v2 live gates. Both spend provider quota, both are in the
# release gate, and neither is in `check`.
smoke-v2-pi:
	npm run v2:pi:smoke && npm run v2:pi:host-smoke

check:
	npm run check

release-gate:
	npm run release:check
