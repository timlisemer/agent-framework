/**
 * Adapter contract — provider-agnostic hook output interface.
 *
 * Each adapter (claude, codex, …) implements AdapterEncoder to translate
 * framework decisions into the provider's expected stdout shape.
 *
 * @module adapter/types
 */

export type EventName =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "UserPromptSubmit"
  | "SessionStart"
  | "PostToolUseFailure"
  | "SubagentStart"
  | "SubagentStop";

/** Provider-specific stdout shapes. Stdin is JSON in every adapter we
 *  anticipate (Claude / Codex / Gemini all use newline-delimited JSON over
 *  stdio); structural typing handles the (zero) divergence. */
export interface AdapterEncoder {
  readonly name: string;           // "claude", "codex", ...
  encodePreToolUseAllow(): EncodedOutput;
  encodePreToolUseDeny(reason: string): EncodedOutput;
  encodeStopBlock(reason: string): EncodedOutput;
  encodeStopPass(): EncodedOutput;
  encodeOk(event: EventName): EncodedOutput;          // exit-code-only events
  encodeError(event: EventName, message: string): EncodedOutput;
}

export interface EncodedOutput { stdout: string; exitCode: number; }
