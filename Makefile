dev:
	pi --offline -np -nc -ns -ne -e extensions/subagent --tools agent_start,agent_await,agent_cancel,agent_result
