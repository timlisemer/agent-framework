import { createInterface } from "node:readline";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { z } from "zod";
import type { AiBackendMessage, AiClientMessage } from "../ai-protocol/index.js";
import { jsonStringifyWithBigint } from "../utils/json.js";

interface JsonlWritable {
  write(chunk: string): unknown;
}

const nullableString = z.string().nullable();
const sessionConfigSchema = z.object({
  model: nullableString,
  workingDir: nullableString,
  systemPrompt: nullableString,
  continuable: z.boolean().default(false),
  sdkRuntimeEnvironment: z.enum(["isolated", "user"]).default("isolated"),
  sdkRuntimeHome: z.enum(["native", "managedAstral"]).default("native"),
}).strict();
const sessionChoicesConfigSchema = z.object({
  sdkRuntimeHome: z.enum(["native", "managedAstral"]).default("native"),
  maxResults: z.number().int().positive().optional(),
}).strict();
const planStateSchema = z.object({
  mode: z.enum(["disabled", "planning", "awaitingApproval", "approved"]),
  planText: nullableString,
  approved: z.boolean(),
}).strict();
const toolDecisionSchema = z.object({
  toolCallId: z.string(),
  decision: z.enum(["approve", "deny"]),
  reason: nullableString,
}).strict();
const requestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("listSessionChoices"),
    requestId: z.string(),
    config: sessionChoicesConfigSchema,
  }).strict(),
  z.object({
    type: z.literal("startSession"),
    sessionId: z.string(),
    config: sessionConfigSchema,
  }).strict(),
  z.object({
    type: z.literal("resumeSession"),
    requestId: z.string(),
    sessionId: z.string(),
    resumeId: z.string(),
    config: sessionConfigSchema,
  }).strict(),
  z.object({
    type: z.literal("closeSession"),
    requestId: z.string(),
    sessionId: z.string(),
  }).strict(),
  z.object({
    type: z.literal("sendInput"),
    sessionId: z.string(),
    turnId: z.string(),
    input: z.string(),
  }).strict(),
  z.object({
    type: z.literal("submitToolDecision"),
    sessionId: z.string(),
    turnId: z.string(),
    decision: toolDecisionSchema,
  }).strict(),
  z.object({
    type: z.literal("setPlanState"),
    sessionId: z.string(),
    state: planStateSchema,
  }).strict(),
  z.object({
    type: z.literal("getSessionSnapshot"),
    sessionId: z.string(),
  }).strict(),
  z.object({
    type: z.literal("eventsSince"),
    sessionId: z.string(),
    afterSeq: z.number().int().nonnegative(),
  }).strict(),
]);

const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request"),
    request: requestSchema,
  }).strict(),
  z.object({
    type: z.literal("cancel"),
    sessionId: z.string(),
    turnId: z.string().nullable(),
  }).strict(),
]);

export function parseClientFrame(line: string): AiClientMessage {
  const parsed = JSON.parse(line) as unknown;
  return clientFrameSchema.parse(parsed) as AiClientMessage;
}

export function writeBackendFrame(frame: AiBackendMessage, stdout: JsonlWritable = processStdout): void {
  stdout.write(`${jsonStringifyWithBigint(frame)}\n`);
}

export async function readClientFrames(
  onFrame: (frame: AiClientMessage) => void | Promise<void>,
  input: NodeJS.ReadableStream = processStdin,
  onError?: (error: unknown) => void | Promise<void>
): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let frame: AiClientMessage;
    try {
      frame = parseClientFrame(line);
    } catch (error) {
      if (!onError) throw error;
      await onError(error);
      continue;
    }
    await onFrame(frame);
  }
}
