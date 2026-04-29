/**
 * Backward-compat barrel export.
 *
 * Existing tests import from "../extensions/reflect.js".
 * This file re-exports the public API so tests continue to work
 * without updating every import statement.
 */

export { targetLabel } from "../src/commands/utils.js";
export * from "../src/config/index.js";
export * from "../src/edit/index.js";
export { collectContext } from "../src/evidence/collector.js";
export * from "../src/history/index.js";
export * from "../src/paths/resolver.js";
export * from "../src/reflection/index.js";
export * from "../src/session/index.js";
export * from "../src/types.js";
export * from "../src/utils/index.js";
