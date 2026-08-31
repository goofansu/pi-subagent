// TODO(ticket 05): Temporary compatibility surface for the existing focused
// helper tests. Claude Attempt owns turn accounting; remove this re-export when
// those tests contract to the established Harness behavior seams.
export { createClaudeTurnCounter } from "./attempt.ts";
