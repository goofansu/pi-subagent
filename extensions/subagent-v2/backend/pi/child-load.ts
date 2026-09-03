/**
 * The child-load discriminator: "is this resource load a child's?"
 *
 * Pi initializes an extension's factory while the resource loader discovers
 * resources, and the loader's `extensionsOverride` is applied only *after*
 * that. So filtering this package out of a child's extension list is not on
 * its own enough: by the time the filter runs, the child has already asked
 * this module's entry point to register itself.
 *
 * The answer, ported from v1 unchanged in behaviour, is an
 * `AsyncLocalStorage` flag scoped to the asynchronous load chain the adapter
 * owns. Anything the child loads inside {@link withChildResourceLoad} can ask
 * {@link isChildResourceLoad} and stay inert; a parent's own reload runs
 * outside the scope and reattaches normally.
 *
 * The storage is keyed by a **global symbol shared with v1**. That is not an
 * import — the two trees stay independent — but it means a v1 parent loading a
 * child and a v2 parent loading a child set the same flag, so whichever entry
 * point the child reaches reads a true answer. Two private symbols would give
 * each implementation a discriminator that only worked against itself, which
 * is exactly the case that matters during the migration.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Shared with v1 on purpose. See the module comment. */
const CHILD_RESOURCE_LOAD_STORAGE = Symbol.for(
  "pi-subagent.pi-child-extension-load",
);

function storage(): AsyncLocalStorage<boolean> {
  const host = globalThis as Record<PropertyKey, unknown>;
  const existing = host[CHILD_RESOURCE_LOAD_STORAGE];
  if (existing) return existing as AsyncLocalStorage<boolean>;

  const created = new AsyncLocalStorage<boolean>();
  Object.defineProperty(host, CHILD_RESOURCE_LOAD_STORAGE, {
    value: created,
    writable: false,
    configurable: false,
  });
  return created;
}

/** Run a child's resource discovery in a context its extensions can detect. */
export function withChildResourceLoad<T>(load: () => T): T {
  return storage().run(true, load);
}

/** True only inside the asynchronous resource-load chain of a Pi child. */
export function isChildResourceLoad(): boolean {
  return storage().getStore() === true;
}
