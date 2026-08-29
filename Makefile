.PHONY: check dev protocol-check release-gate smoke-codex test-conformance

dev:
	pi --offline -np -nc -ns -ne -e extensions/subagent --tools agent_start,agent_wait,agent_cancel,agent_steer,agent_result

test-conformance:
	npm run test:conformance

protocol-check:
	npm run codex:protocol:check

smoke-codex:
	npm run codex:smoke

check:
	npm run check

release-gate:
	npm run release:check
