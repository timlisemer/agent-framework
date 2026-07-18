import { z } from "zod";
import {
  hostContextSchema,
  planModeDetectionSchema,
} from "../adapter/types.js";
import { jsonValueSchema } from "../scenario/protocol/common.js";
import { priorErrorContextSchema } from "../utils/prior-error-context.js";

export const hostRuntimeContextSchema = z.object({
  adapter: z.string().min(1),
  nativeSessionId: z.string().min(1),
  transcriptPath: z.string().min(1),
  sessionDir: z.string().min(1),
  projectDir: z.string().min(1),
  workingDir: z.string().nullable(),
  permissionMode: z.string().nullable(),
  collaborationMode: z.string().nullable(),
  planMode: z.boolean(),
  planModeDetection: planModeDetectionSchema,
  host: hostContextSchema,
  preTool: z.object({
    rawToolName: z.string().min(1),
    rawToolInput: jsonValueSchema,
    outsideRootPath: z.string().nullable(),
    latestUserMessage: z.string(),
    latestUserLogicText: z.string(),
    recentUserMessages: z.array(z.string()),
    cachedSnippetSideTaskDischarged: z.boolean(),
    slashCommandAllowedTools: z.array(z.string()).nullable(),
    planExit: z.boolean(),
    batch: z.object({
      leaderId: z.string().min(1),
      position: z.number().int().nonnegative(),
      batchSize: z.number().int().positive(),
      allIds: z.array(z.string().min(1)),
      calls: z.array(z.object({
        toolCallId: z.string().min(1),
        name: z.string().min(1),
        input: jsonValueSchema,
        mayRequireContinuation: z.boolean(),
      }).strict()),
    }).strict().nullable(),
  }).strict().optional(),
  userPrompt: z.object({
    prompt: z.string(),
    workflowInvocation: z.string().nullable(),
    workflowInstructionText: z.string().nullable(),
    workflowOnly: z.boolean(),
    planExit: z.boolean(),
  }).strict().optional(),
  stop: z.object({
    lastAssistantMessage: z.string().nullable(),
    assistantTextCandidates: z.array(z.string()),
    latestAssistantText: z.string().nullable(),
    latestUserText: z.string().nullable(),
    priorErrorContext: z.array(priorErrorContextSchema),
    planExitText: z.string().nullable(),
    stopBlockDisabled: z.boolean(),
  }).strict().optional(),
  postTool: z.object({
    rawToolName: z.string().min(1),
    rawToolInput: jsonValueSchema,
  }).strict().optional(),
}).strict();

export type HostRuntimeContext = z.infer<typeof hostRuntimeContextSchema>;
