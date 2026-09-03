/**
 * The exact Effect version v2 is built against.
 *
 * The v2 roadmap pins Effect with no range operator so every developer and
 * every install compiles the same runtime. This constant is the value the
 * placeholder command reports; `index.test.ts` asserts it against both the
 * repository's declared dependency and the installed package, so the constant
 * cannot drift away from what is actually resolved.
 */
export const PINNED_EFFECT_VERSION = "4.0.0-rc.112";
