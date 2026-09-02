# Effect v4 compatibility spike (M0)

**Status:** Complete. The pinned version is viable; no incompatibility found.
**Date:** 2026-09-02
**Pinned version:** `effect@4.0.0-rc.112`, exact, no range operator.

## Why this spike exists

The v2 roadmap builds every runtime primitive on Effect from the first line of
code. The maintainer selected `4.0.0-rc.112`; this spike does not choose a
version. Its only job is to prove that the selected release candidate compiles
under this repository's TypeScript settings and runs under this repository's
test runner and loader, so that M1 and M2 start from a known-good foundation
rather than discovering a toolchain problem inside the first real lifecycle
module.

If the primitive set had failed to compile or run, the escalation path was an
ADR to the maintainer, not a unilateral version change. No escalation was
needed.

## Toolchain checked against

| Element             | Value                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| TypeScript          | `typescript@^5.8.3`, `module: NodeNext`, `moduleResolution: NodeNext`, `target: ES2022`, `strict: true`, `allowImportingTsExtensions: true` |
| v2 project file     | `tsconfig.v2.json` (v2 tree only), run by `npm run typecheck:v2`             |
| Repository project  | `tsconfig.json` (both trees plus `tools/`), run by `npm run typecheck`       |
| Test runner         | `node --test` on Node v24.15.0                                              |
| Loader              | `tsx@^4.19.3` through `node --import tsx`                                   |
| Test lane           | `npm run test:v2`, with `extensions/subagent-v2/suite-setup.ts`             |
| Dependency kind     | regular `dependencies` entry, because Pi installs package dependencies for extensions |

## Primitive set

The smoke test is `extensions/subagent-v2/effect-primitives.test.ts`. It covers
the initial primitive set named by the roadmap, one assertion per primitive:

| Primitive           | Module used                        | What the smoke test proves                                                   |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `Scope`             | `Scope`, `Effect.acquireRelease`   | A resource is acquired inside a scope and released when that scope closes.    |
| `Deferred`          | `Deferred`                         | A forked fiber completes a deferred and the parent observes the value.        |
| Bounded `Queue`     | `Queue.bounded`                    | Two messages are offered by one fiber and taken in order by another.          |
| `Fiber`             | `Effect.forkChild`, `Fiber.join`   | A forked child fiber is joined by its parent in every case above.             |
| `SubscriptionRef`   | `SubscriptionRef`, `Stream`        | A subscriber observes the replayed current value and both later changes.      |
| `Layer`             | `Context.Service`, `Layer.effect`  | One session-long service is built from a layer and used through the context.  |
| `TestClock`         | `effect/testing` `TestClock`       | A one-hour sleep completes after `TestClock.adjust`, with no real time spent. |

Only the core `effect` package is used. `TestClock` comes from the core
package's `effect/testing` entry point, so no Effect ecosystem package was
added. The roadmap's "avoid unstable packages" rule applies to those add-ons,
none of which M0 introduces.

## What compiled

`npm run typecheck:v2` and `npm run typecheck` both pass with the primitive set
imported. No `skipLibCheck` exception, `@ts-expect-error`, or `any` was needed
in the smoke test, and no compiler option was changed to accommodate Effect.
The package publishes its own `.d.ts` files under `NodeNext` resolution and
resolves correctly from `effect` and `effect/testing`.

## What ran

`npm run test:v2` runs the smoke test green under `node --test` with the `tsx`
loader. `Effect.runPromise` at the test boundary is the only place the smoke
test leaves Effect, which matches the roadmap's rule that `Effect.runPromise`
is allowed only at the Pi host boundary and necessary native callback bridges.

## Incompatibilities found

None with `4.0.0-rc.112` itself.

Two v4 API details cost time and are recorded so M1 does not rediscover them:

- The exit value for closing a scope by hand is `Exit.void`. There is no
  `Effect.exitVoid` in v4.
- `SubscriptionRef.changes` replays the current value and then emits changes,
  but a subscriber forked without a readiness handshake can miss changes
  published before its subscription attaches. The smoke test uses the
  documented pattern: the subscriber signals a `Deferred` from its first
  element, and the publisher awaits that deferred before the first change. A
  test written without the handshake hangs instead of failing, which is worth
  knowing before M2 writes observation plumbing on this primitive.

Neither is a defect in the pinned version. Nothing was worked around silently
and nothing needs to be escalated to the maintainer.

## How to rerun

```bash
npm run typecheck:v2
npm run test:v2
```

Both run offline and spend no provider quota. They are part of `npm run check`.
