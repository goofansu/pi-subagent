import { AsyncLocalStorage } from "node:async_hooks";

const CHILD_EXTENSION_LOAD_STORAGE = Symbol.for(
  "pi-subagent.pi-child-extension-load",
);

function childExtensionLoadStorage(): AsyncLocalStorage<boolean> {
  const host = globalThis as Record<PropertyKey, unknown>;
  const existing = host[CHILD_EXTENSION_LOAD_STORAGE];
  if (existing) return existing as AsyncLocalStorage<boolean>;

  const storage = new AsyncLocalStorage<boolean>();
  Object.defineProperty(host, CHILD_EXTENSION_LOAD_STORAGE, {
    value: storage,
    writable: false,
    configurable: false,
  });
  return storage;
}

/** Run Pi resource discovery in a context owned by an in-process child. */
export function withPiChildExtensionLoad<T>(load: () => T): T {
  return childExtensionLoadStorage().run(true, load);
}

/** True only in the asynchronous resource-load chain of an in-process child. */
export function isPiChildExtensionLoad(): boolean {
  return childExtensionLoadStorage().getStore() === true;
}
