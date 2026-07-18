import { z } from "zod";

export const runCapabilitiesSchema = z.object({
  conversationInput: z.boolean(),
  toolExecution: z.boolean(),
  interactiveToolDecisions: z.boolean(),
  planControl: z.boolean(),
  feedbackSubmission: z.boolean(),
  artifactRead: z.boolean(),
  fullStateInspection: z.boolean(),
  runCancellation: z.boolean(),
}).strict();

export type RunCapabilities = z.infer<typeof runCapabilitiesSchema>;

export const READ_ONLY_RUN_CAPABILITIES: RunCapabilities = {
  conversationInput: false,
  toolExecution: false,
  interactiveToolDecisions: false,
  planControl: false,
  feedbackSubmission: false,
  artifactRead: false,
  fullStateInspection: true,
  runCancellation: false,
};

export const FULL_RUN_CAPABILITIES: RunCapabilities = {
  conversationInput: true,
  toolExecution: true,
  interactiveToolDecisions: true,
  planControl: true,
  feedbackSubmission: true,
  artifactRead: true,
  fullStateInspection: true,
  runCancellation: true,
};

