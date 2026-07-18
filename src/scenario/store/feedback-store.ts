import { feedbackEntrySchema, type FeedbackEntry } from "../protocol/feedback.js";
import { appendValidatedJsonl, readValidatedJsonl, truncateFileIfPresent } from "../../utils/file-io.js";

export async function readFeedbackEntries(filePath: string): Promise<FeedbackEntry[]> {
  return (await readFeedbackStream(filePath)).entries;
}

export async function readFeedbackStream(filePath: string): Promise<{
  entries: FeedbackEntry[];
  validByteLength: number;
  hadPartialTail: boolean;
}> {
  const result = await readValidatedJsonl(filePath, feedbackEntrySchema);
  return {
    entries: result.values,
    validByteLength: result.validByteLength,
    hadPartialTail: result.hadPartialTail,
  };
}

export async function truncateFeedbackStream(filePath: string, byteLength: number): Promise<void> {
  await truncateFileIfPresent(filePath, byteLength);
}

export async function appendFeedbackEntry(filePath: string, entry: FeedbackEntry): Promise<void> {
  await appendValidatedJsonl(filePath, feedbackEntrySchema, [entry]);
}
