/**
 * Scenario validators — split from types.ts so src-side and test-side code
 * can import validators without pulling in the full type tree.
 *
 * Re-exports the canonical validateScenario and validateReasonMustExpectation
 * from types.ts for backward compatibility with callers that already import
 * from scenario-types.js.
 *
 * @module scenario/validate
 */

export { validateScenario, validateReasonMustExpectation } from "./types.js";
