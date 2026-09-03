/**
 * `BackendCatalog`: the M1 lookup function, for the life of the Session.
 *
 * There is deliberately nothing new here. M1 wrote the lookup rule as a pure
 * function of a list so that Profile validation was testable without a
 * runtime, and this lifts exactly that function into a service so the
 * supervisor can reach it. Anything the service did that the function did not
 * would be a rule the M1 tests no longer cover.
 */

import { Context, Effect, Layer } from "effect";
import {
  type BackendCatalog as CatalogFunction,
  createBackendCatalog,
} from "../backend/catalog.ts";
import type { Backend } from "../backend/contract.ts";

export class BackendCatalog extends Context.Service<
  BackendCatalog,
  CatalogFunction
>()("pi-subagent/runtime/BackendCatalog") {
  /** The backends this Session was built with. Reload is not a thing. */
  static layerOf(backends: readonly Backend[]): Layer.Layer<BackendCatalog> {
    return Layer.effect(
      BackendCatalog,
      Effect.sync(() => BackendCatalog.of(createBackendCatalog(backends))),
    );
  }
}
