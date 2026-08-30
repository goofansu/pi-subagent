const PROVIDER_DIAGNOSTIC_LIMIT = 2_048;
const PROVIDER_DIAGNOSTIC_REDACTED = "[redacted]";

/**
 * Report only an adapter-owned category for provider-authored failures.
 *
 * Provider diagnostics are free-form, so no finite identifier pattern can
 * prove that arbitrary provider text is identity-free. The raw value remains
 * adapter-local; the category is useful at the public seam without leaking it.
 */
export function confineProviderDiagnostic(
  _value: unknown,
  category: string,
): string {
  const normalizedCategory = category.replace(/[\r\n]+/g, " ").trim();
  return `${normalizedCategory}: ${PROVIDER_DIAGNOSTIC_REDACTED}`.slice(
    0,
    PROVIDER_DIAGNOSTIC_LIMIT,
  );
}

/** Remember whether SDK stderr occurred without retaining provider text. */
export function createProviderDiagnosticCollector(): {
  append(value: unknown): void;
  confined(category: string): string;
} {
  let sawDiagnostic = false;
  return {
    append(value) {
      if (typeof value === "string") sawDiagnostic ||= value.length > 0;
      else sawDiagnostic ||= value !== undefined && value !== null;
    },
    confined(category) {
      return sawDiagnostic
        ? confineProviderDiagnostic(undefined, category)
        : "";
    },
  };
}
