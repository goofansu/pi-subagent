/**
 * How the domain decodes.
 *
 * One constant, named once, because the exact-key-set rule *is* this option.
 * ADR-0024 says provider bookkeeping never crosses the boundary; with
 * `onExcessProperty: "error"` an unlisted key at any depth is a rejection
 * rather than a silent strip, which is the difference between a rule adapters
 * are trusted to honour and one the seam rejects them for breaking.
 *
 * Every decode in v2 that reads something a backend or a host handed us uses
 * this. A decode that used the default would quietly accept a provider wire
 * object as long as it happened to contain the right fields.
 */

export const EXACT_KEYS = { onExcessProperty: "error" } as const;
