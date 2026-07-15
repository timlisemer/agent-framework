/**
 * A canonical action that a surface tool call has deterministically proven.
 *
 * Capability producers may be command- or adapter-specific, but workflow
 * prediction consumes every capability through the same generic matcher.
 * Inputs contain only facts established by the producer; requirement fields
 * not present here must not be treated as satisfied.
 */
export interface CanonicalToolCapability {
  /** Canonical tool/action name such as "Read", "Grep", or "mcp-check". */
  tool: string;
  /** Canonical input facts proven for this action. */
  input?: Record<string, unknown>;
}
