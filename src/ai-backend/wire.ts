import { createInterface } from "node:readline";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { z } from "zod";
import type { AiBackendMessage, AiClientMessage } from "../ai-protocol/index.js";

interface JsonlWritable {
  write(chunk: string): unknown;
}

const nullableString = z.string().nullable();
const sessionConfigSchema = z.object({
  provider: nullableString,
  model: nullableString,
  workingDir: nullableString,
  systemPrompt: nullableString,
}).strict();
const planStateSchema = z.object({
  mode: z.enum(["disabled", "planning", "awaitingApproval", "approved"]),
  planText: nullableString,
  approved: z.boolean(),
}).strict();
const toolDecisionSchema = z.object({
  toolCallId: z.string(),
  providerToolCallId: z.string(),
  approve: z.boolean(),
  reason: nullableString,
}).strict();
const requestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("startSession"),
    sessionId: z.string(),
    config: sessionConfigSchema,
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
  clientFrameSchema.parse(parsed);
  return parsed as AiClientMessage;
}

export function writeBackendFrame(frame: AiBackendMessage, stdout: JsonlWritable = processStdout): void {
  stdout.write(`${JSON.stringify(frame, jsonReplacer)}\n`);
}

export async function readClientFrames(
  onFrame: (frame: AiClientMessage) => void | Promise<void>,
  input = processStdin
): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    await onFrame(parseClientFrame(line));
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}
