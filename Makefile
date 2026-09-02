.PHONY: check dev dev-v2 protocol-check release-gate smoke-codex test-conformance test-v2-conformance

dev:
	pi --offline -np -nc -ns -ne -e extensions/subagent --tools agent_start,agent_wait,agent_cancel,agent_steer,agent_result

# v2 is opted into per Pi process: every extension disabled, only the v2 entry
# point loaded. Since M3 this is a usable extension — six model tools, the
# agents command, the active widget, and two demo backends behind it — so the
# --tools list mirrors the v1 target's.
dev-v2:
	pi --offline -np -nc -ns -ne -e extensions/subagent-v2/index.ts --tools agent_start,agent_resume,agent_wait,agent_result,agent_cancel,agent_steer

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

check:
	npm run check

release-gate:
	npm run release:check
