.PHONY: check conformance dev release-gate smoke-claude smoke-pi

# The extension in isolation: every other extension disabled, only this entry
# point loaded, for checking the surface rather than for using it. `--offline`
# disables Pi's startup network calls, not inference, so Runs still reach a
# model. For *using* it, a plain `pi` is enough: the manifest names this entry
# point, so an installed package loads it.
dev:
	pi --offline -np -nc -ns -ne -e extensions/subagent/index.ts --tools agent_start,agent_resume,agent_wait,agent_result,agent_cancel,agent_steer

# The shared backend conformance suite: the two fake backends and both real
# adapters run exactly the same scenarios, and none of them skips one.
conformance:
	npm run test:conformance

# The opt-in live gates, one target per backend: a runtime gate over the
# adapter and a host gate through the surface a user has. All of them spend
# provider quota, all are in the release gate, and none is in `check`.
smoke-pi:
	npm run pi:smoke && npm run pi:host-smoke

smoke-claude:
	npm run claude:smoke && npm run claude:host-smoke

check:
	npm run check

release-gate:
	npm run release:check
