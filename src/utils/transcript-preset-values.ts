import type { TranscriptReadOptions } from "./transcript.js";

/** Use Infinity to collect all messages of a type (scanner will exhaust transcript). */
const ALL = Infinity;

export const APPEAL_COUNTS: TranscriptReadOptions = {
  counts: { user: { count: ALL }, assistant: { count: 10 }, tool: { count: 3 } },
  includeFirstUserMessage: true,
};

export const PLAN_VALIDATE_COUNTS: TranscriptReadOptions = {
  counts: { user: { count: ALL }, assistant: { count: 10 }, tool: { count: 10 } },
  includeFirstUserMessage: true,
  toolOptions: {
    trim: false,
  },
};

export const VALIDATE_INTENT_COUNTS: TranscriptReadOptions = {
  counts: { user: { count: ALL }, assistant: { count: 5 } },
  includeFirstUserMessage: true,
};

export const FIRST_RESPONSE_STOP_COUNTS: TranscriptReadOptions = {
  counts: {
    user: { count: 3, maxStale: 5 },
    assistant: { count: 3 },
    tool: { count: 8 },
  },
};

export const QUESTION_VALIDATE_COUNTS: TranscriptReadOptions = {
  counts: { user: { count: ALL }, assistant: { count: 20 }, tool: { count: 15 } },
  includeFirstUserMessage: true,
  toolOptions: {
    trim: true,
    maxLines: 80,
    excludeToolNames: ["Task"],
  },
};
