import * as fs from "fs";

/**
 * Transcript Writer - Synthetic Entry Injection
 *
 * Appends synthetic tool_result entries to the transcript file so that
 * hook outputs (like stop hook systemMessage) become visible to agents
 * reading the transcript.
 *
 * Without this, stop hook feedback is injected by Claude Code as system
 * messages and doesn't appear in transcripts - agents can't see previous
 * hook feedback.
 *
 * @module transcript-writer
 */

/**
 * Append a synthetic tool_result entry to the transcript.
 * Format matches Claude Code's JSONL structure.
 *
 * NOTE: We omit tool_use_id since this is a synthetic entry with no corresponding
 * tool_use block. The tool name is embedded in the content prefix instead.
 *
 * @param transcriptPath - Path to the transcript JSONL file
 * @param hookName - Name of the hook generating this message (e.g., "Stop")
 * @param message - The message content to inject
 */
export async function appendSyntheticToolResult(
  transcriptPath: string,
  hookName: string,
  message: string
): Promise<void> {
  const entry = {
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          // No tool_use_id - synthetic entry, no corresponding tool_use block
          content: `[${hookName} Hook Feedback]\n${message}`,
        },
      ],
    },
  };
  await fs.promises.appendFile(transcriptPath, JSON.stringify(entry) + "\n");
}
