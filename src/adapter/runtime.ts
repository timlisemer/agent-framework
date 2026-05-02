/**
 * Adapter runtime helpers — thin wrappers used by adapter entry shells.
 *
 * Keeps adapter shell scripts minimal (~12 lines each) by centralizing
 * the stdin read and hook entry invocation pattern.
 *
 * @module adapter/runtime
 */

export { readStdinJson, exitAfterFlush, initHookProcess } from "../utils/hook-bootstrap.js";
