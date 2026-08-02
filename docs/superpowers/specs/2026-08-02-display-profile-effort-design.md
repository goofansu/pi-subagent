# Display Profile Effort

## Goal

Show a subagent profile's explicitly configured reasoning effort in the run usage line. When the profile does not specify effort, show nothing.

## Design

Add an optional `effort` field to `SingleResult`. Copy `AgentConfig.effort` into the result when `runSubagent` creates it, before the first progress update. This makes the value available consistently in running, completed, and persisted results without requiring backend-specific reporting.

Extend usage formatting to accept the optional effort and append `effort:<level>` after the model. For example:

```text
1 turn ↑200k ↓1.9k R138k ctx:36k gpt-5.6-sol effort:high
```

The displayed value is the profile's configured effort, not a claim about a backend's effective or post-clamping effort. If the profile omits effort, the output remains unchanged.

## Compatibility

The result field is optional, so persisted results created by older versions remain valid and render without effort. All supported effort values use the existing validated `Effort` type.

## Testing

Add tests that verify:

- usage formatting appends an explicit effort after the model;
- usage formatting omits effort when absent;
- `runSubagent` exposes configured effort in its initial progress update and final result;
- a profile without effort leaves the result field absent;
- existing persisted results without effort remain compatible through the optional field.
