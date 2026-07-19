import { z } from "zod";
import type { ScenarioCommandPayload } from "../scenario/protocol/commands.js";
import { idSchema, jsonValueSchema, sha256DigestSchema, toJsonValue, type JsonValue } from "../scenario/protocol/common.js";
import type { ScenarioEffectProjectionRecord } from "../scenario/protocol/effects.js";
import { isTerminalToolStatus, type ScenarioSnapshot } from "../scenario/protocol/snapshot.js";
import type {
  ScenarioCommandExtensionHandler,
  ScenarioCommandExtensionMutation,
  ScenarioCommandExtensionResult,
} from "../scenario/runtime/command-extension.js";
import type { PlannedScenarioEffect } from "../scenario/runtime/effects.js";
import {
  canonicalToolRequestedRecord,
  isIdenticalToolTerminalReplay,
  observedToolLifecycleRecords,
} from "../scenario/runtime/tool-lifecycle.js";
import { digestScenarioValue } from "../scenario/protocol/digest.js";
import { agentFrameworkStateChange } from "./state-slices.js";
import {
  HOOK_RULE_EFFECT_TYPE,
  hookRuleEffectParametersSchema,
  planToolPolicyEffect,
} from "./rule-pipeline-contract.js";

export const AGENT_FRAMEWORK_HOST_EXTENSION_ID = "agent-framework.host";

const toolIdentityFields = {
  toolCallId: idSchema,
  name: z.string().min(1),
  input: jsonValueSchema,
  inputDigest: sha256DigestSchema,
};

const preToolUseSchema = z.object({
  type: z.literal("hostPreToolUse"),
  workflow: jsonValueSchema,
  context: jsonValueSchema,
  ...toolIdentityFields,
  turnId: idSchema.nullable(),
  requiresUserDecision: z.boolean().default(false),
}).strict();

const userPromptSubmittedSchema = z.object({
  type: z.literal("hostUserPromptSubmitted"),
  workflow: jsonValueSchema,
  context: jsonValueSchema,
  messageId: idSchema,
  prompt: z.string(),
  contentDigest: sha256DigestSchema,
  observedMessageId: idSchema.optional(),
}).strict();

const stoppedSchema = z.object({
  type: z.literal("hostStopped"),
  workflow: jsonValueSchema,
  context: jsonValueSchema,
  lastAssistantMessage: z.string().nullable(),
}).strict();

const sessionStartedSchema = z.object({
  type: z.literal("hostSessionStarted"),
  source: z.enum(["startup", "resume", "compact", "clear"]),
  workflow: jsonValueSchema,
  context: jsonValueSchema,
}).strict();

const postToolUseSchema = z.object({
  type: z.literal("hostPostToolUse"),
  workflow: jsonValueSchema,
  context: jsonValueSchema,
  ...toolIdentityFields,
  outcome: z.enum(["completed", "failed", "cancelled"]),
  output: jsonValueSchema.optional(),
  error: z.string().nullable(),
  currentPlan: jsonValueSchema.optional(),
}).strict();

export const agentFrameworkHostCommandSchema = z.discriminatedUnion("type", [
  preToolUseSchema,
  userPromptSubmittedSchema,
  stoppedSchema,
  sessionStartedSchema,
  postToolUseSchema,
]);
export type AgentFrameworkHostCommand = z.infer<typeof agentFrameworkHostCommandSchema>;
export type AgentFrameworkHostCommandDigestInspection = {
  command: AgentFrameworkHostCommand;
  repairedCommand: AgentFrameworkHostCommand;
  digestField: "inputDigest" | "contentDigest" | null;
  expectedDigest: string | null;
  matches: boolean;
};
export type AgentFrameworkHostEvent =
  | "PreToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "SessionStart"
  | "PostToolUse";

export function agentFrameworkHostEvent(
  command: AgentFrameworkHostCommand,
): AgentFrameworkHostEvent {
  switch (command.type) {
    case "hostPreToolUse":
      return "PreToolUse";
    case "hostUserPromptSubmitted":
      return "UserPromptSubmit";
    case "hostStopped":
      return "Stop";
    case "hostSessionStarted":
      return "SessionStart";
    case "hostPostToolUse":
      return "PostToolUse";
  }
  return unreachableHostCommand(command);
}

export function agentFrameworkHostCommand(
  data: AgentFrameworkHostCommand,
): ScenarioCommandPayload {
  return {
    type: "extensionCommand",
    extensionId: AGENT_FRAMEWORK_HOST_EXTENSION_ID,
    data: toJsonValue(parseAgentFrameworkHostCommand(data)),
  };
}

export function agentFrameworkHostCommandData(
  payload: ScenarioCommandPayload,
): AgentFrameworkHostCommand | null {
  if (
    payload.type !== "extensionCommand" ||
    payload.extensionId !== AGENT_FRAMEWORK_HOST_EXTENSION_ID
  ) return null;
  return parseAgentFrameworkHostCommand(payload.data);
}

/** Digest only adapter-native immutable event data, excluding derived workflow and rule context. */
export function agentFrameworkHostCommandImmutableDigest(
  command: AgentFrameworkHostCommand,
): string {
  switch (command.type) {
    case "hostPreToolUse":
      return digestScenarioValue(toJsonValue({
        type: command.type,
        toolCallId: command.toolCallId,
        turnId: command.turnId,
        name: command.name,
        input: command.input,
        inputDigest: command.inputDigest,
        requiresUserDecision: command.requiresUserDecision,
      }));
    case "hostUserPromptSubmitted":
      return digestScenarioValue(toJsonValue({
        type: command.type,
        messageId: command.messageId,
        prompt: command.prompt,
        contentDigest: command.contentDigest,
        observedMessageId: command.observedMessageId ?? null,
      }));
    case "hostStopped":
      return digestScenarioValue(toJsonValue({
        type: command.type,
        lastAssistantMessage: command.lastAssistantMessage,
      }));
    case "hostSessionStarted":
      return digestScenarioValue(toJsonValue({ type: command.type, source: command.source }));
    case "hostPostToolUse":
      return digestScenarioValue(toJsonValue({
        type: command.type,
        toolCallId: command.toolCallId,
        name: command.name,
        input: command.input,
        inputDigest: command.inputDigest,
        outcome: command.outcome,
        output: command.output ?? null,
        error: command.error,
      }));
  }
  return unreachableHostCommand(command);
}

/** Inspect and repair host-command digests without duplicating command-specific digest rules. */
export function inspectAgentFrameworkHostCommandDigest(
  value: unknown,
): AgentFrameworkHostCommandDigestInspection {
  const command = agentFrameworkHostCommandSchema.parse(value);
  if (command.type === "hostPreToolUse" || command.type === "hostPostToolUse") {
    const expectedDigest = digestScenarioValue(command.input);
    return {
      command,
      repairedCommand: command.inputDigest === expectedDigest
        ? command
        : { ...command, inputDigest: expectedDigest },
      digestField: "inputDigest",
      expectedDigest,
      matches: command.inputDigest === expectedDigest,
    };
  }
  if (command.type === "hostUserPromptSubmitted") {
    const expectedDigest = digestScenarioValue(command.prompt);
    return {
      command,
      repairedCommand: command.contentDigest === expectedDigest
        ? command
        : { ...command, contentDigest: expectedDigest },
      digestField: "contentDigest",
      expectedDigest,
      matches: command.contentDigest === expectedDigest,
    };
  }
  return {
    command,
    repairedCommand: command,
    digestField: null,
    expectedDigest: null,
    matches: true,
  };
}

export const agentFrameworkHostExtensionHandler: ScenarioCommandExtensionHandler = {
  validate(command) {
    if (command.payload.extensionId !== AGENT_FRAMEWORK_HOST_EXTENSION_ID) return;
    parseAgentFrameworkHostCommand(command.payload.data);
  },
  project(command, snapshot) {
    if (command.payload.extensionId !== AGENT_FRAMEWORK_HOST_EXTENSION_ID) return null;
    const payload = parseAgentFrameworkHostCommand(command.payload.data);
    const event = agentFrameworkHostEvent(payload);
    switch (payload.type) {
      case "hostPreToolUse":
        return preToolUseResult(command, snapshot, payload, event);
      case "hostUserPromptSubmitted":
        return hookRuleResult(command, payload, event);
      case "hostStopped":
        return hookRuleResult(command, payload, event);
      case "hostSessionStarted":
        return sessionStartedResult(command, payload, event);
      case "hostPostToolUse":
        return postToolUseResult(command, snapshot, payload, event);
    }
  },
};

function parseAgentFrameworkHostCommand(value: unknown): AgentFrameworkHostCommand {
  const inspection = inspectAgentFrameworkHostCommandDigest(value);
  if (!inspection.matches) {
    const digestLabel = inspection.digestField === "inputDigest" ? "input digest" : "content digest";
    throw new Error(`${inspection.command.type} ${digestLabel} mismatch`);
  }
  return inspection.command;
}

type ExtensionCommand = Parameters<ScenarioCommandExtensionHandler["project"]>[0];

function preToolUseResult(
  command: ExtensionCommand,
  snapshot: ScenarioSnapshot,
  payload: z.infer<typeof preToolUseSchema>,
  event: AgentFrameworkHostEvent,
): ScenarioCommandExtensionResult {
  if (snapshot.toolCalls.some((tool) => tool.id === payload.toolCallId)) {
    throw new Error(`Tool call already exists: ${payload.toolCallId}`);
  }
  const effect = planToolPolicyEffect({
    commandId: command.commandId,
    originCommandType: "hostPreToolUse",
    toolCallId: payload.toolCallId,
    turnId: payload.turnId,
    name: payload.name,
    input: payload.input,
    requiresUserDecision: payload.requiresUserDecision,
  });
  return accepted([
    ...boundaryStateChanges(command, payload, event, "hostBoundary", "loaded"),
    record(extensionRecord(event, {
      toolCallId: payload.toolCallId,
      name: payload.name,
    }, { kind: "toolCall", id: payload.toolCallId })),
    record(effectRequested(effect)),
    record(canonicalToolRequestedRecord(payload)),
  ]);
}

function hookRuleResult(
  command: ExtensionCommand,
  payload: z.infer<typeof userPromptSubmittedSchema> | z.infer<typeof stoppedSchema>,
  event: AgentFrameworkHostEvent,
): ScenarioCommandExtensionResult {
  const parameters = hookRuleEffectParametersSchema.parse({ commandId: command.commandId, event });
  const effect: PlannedScenarioEffect = {
    effectId: `hook:${event}:${command.commandId}`,
    effectType: HOOK_RULE_EFFECT_TYPE,
    parameters: toJsonValue(parameters),
  };
  const mutations: ScenarioCommandExtensionMutation[] = [
    ...boundaryStateChanges(command, payload, event, "hostBoundary", "loaded"),
    record(effectRequested(effect)),
    record(extensionRecord(event, payload.type === "hostUserPromptSubmitted"
      ? { messageId: payload.observedMessageId ?? payload.messageId }
      : { lastAssistantMessage: payload.lastAssistantMessage })),
  ];
  if (payload.type === "hostUserPromptSubmitted" && payload.observedMessageId === undefined) {
    mutations.push(record({
      eventType: "message.userSubmitted",
      entityRef: { kind: "message", id: payload.messageId },
      visibility: "localSensitive",
      payload: {
        type: "userMessageSubmitted",
        messageId: payload.messageId,
        turnId: payload.messageId,
        content: payload.prompt,
        contentDigest: payload.contentDigest,
      },
    }));
  }
  return accepted(mutations);
}

function sessionStartedResult(
  command: ExtensionCommand,
  payload: z.infer<typeof sessionStartedSchema>,
  event: AgentFrameworkHostEvent,
): ScenarioCommandExtensionResult {
  return accepted([
    ...boundaryStateChanges(
      command,
      payload,
      event,
      payload.source === "compact" || payload.source === "clear"
        ? "hostLifecycleReset"
        : "hostBoundary",
      "loaded",
    ),
    record(extensionRecord(event, { source: payload.source })),
  ]);
}

function postToolUseResult(
  command: ExtensionCommand,
  snapshot: ScenarioSnapshot,
  payload: z.infer<typeof postToolUseSchema>,
  event: AgentFrameworkHostEvent,
): ScenarioCommandExtensionResult {
  const exact = snapshot.toolCalls.find((tool) => tool.id === payload.toolCallId);
  const identityMatches = exact ? [] : snapshot.toolCalls.filter((tool) =>
    !isTerminalToolStatus(tool.status) &&
    tool.name === payload.name &&
    tool.inputDigest === payload.inputDigest
  );
  if (identityMatches.length > 1) {
    throw new Error(`Host post-tool identity is ambiguous: ${payload.toolCallId}`);
  }
  const existing = exact ?? identityMatches[0];
  const canonicalToolCallId = existing?.id ?? payload.toolCallId;
  if (existing && (existing.name !== payload.name || existing.inputDigest !== payload.inputDigest)) {
    throw new Error(`Host post-tool identity changed: ${payload.toolCallId}`);
  }
  if (existing && isTerminalToolStatus(existing.status)) {
    if (!isIdenticalToolTerminalReplay(existing, {
      status: payload.outcome,
      ...(payload.output === undefined ? {} : { terminalOutput: payload.output }),
      error: payload.error,
    })) {
      throw new Error(`Tool call is already terminal: ${payload.toolCallId}`);
    }
  }
  return accepted([
    ...boundaryStateChanges(
      command,
      payload,
      event,
      "hostPostToolUse",
      "validated",
      payload.currentPlan,
    ),
    record(extensionRecord(event, {
      toolCallId: canonicalToolCallId,
      outcome: payload.outcome,
      ...(canonicalToolCallId === payload.toolCallId
        ? {}
        : { observedToolCallId: payload.toolCallId }),
    }, { kind: "toolCall", id: canonicalToolCallId })),
    ...(existing && isTerminalToolStatus(existing.status) ? [] : observedToolLifecycleRecords({
      tool: {
        toolCallId: canonicalToolCallId,
        turnId: existing?.turnId ?? null,
        name: payload.name,
        input: payload.input,
        inputDigest: payload.inputDigest,
      },
      existing,
      authorization: {
        policy: "allowed",
        final: "allowed",
        policyReason: "Observed native execution",
        finalReason: "Observed native execution",
        userUnavailable: "ifPending",
      },
      target: {
        status: payload.outcome,
        ...(payload.output === undefined ? {} : { terminalOutput: payload.output }),
        error: payload.error,
      },
    }).map(record)),
  ]);
}

function boundaryStateChanges(
  command: ExtensionCommand,
  payload: { workflow: JsonValue; context: JsonValue },
  event: AgentFrameworkHostEvent,
  workflowSource: string,
  workflowStatus: "loaded" | "validated",
  currentPlan?: JsonValue,
): ScenarioCommandExtensionMutation[] {
  return [
    stateChange(agentFrameworkStateChange({
      key: "session.workflow",
      schemaId: "agent-framework://state/session-workflow",
      status: workflowStatus,
      source: workflowSource,
      value: payload.workflow,
    })),
    stateChange(agentFrameworkStateChange({
      key: "host.context",
      schemaId: "agent-framework://state/host-runtime-context",
      source: `${command.source.adapter ?? command.source.kind}.${event}`,
      value: payload.context,
    })),
    ...(currentPlan === undefined
      ? []
      : [stateChange(agentFrameworkStateChange({
          key: "plan.current",
          schemaId: "agent-framework://state/current-plan",
          source: "hostPostToolUse",
          value: currentPlan,
        }))]),
  ];
}

function effectRequested(
  effect: PlannedScenarioEffect,
): ScenarioEffectProjectionRecord {
  return {
    eventType: "effect.requested",
    entityRef: { kind: "effect", id: effect.effectId },
    visibility: "localSensitive",
    payload: effect,
  };
}

function extensionRecord(
  event: string,
  details: Record<string, JsonValue>,
  entityRef?: { kind: string; id: string },
): ScenarioEffectProjectionRecord {
  return {
    eventType: "extension.observed",
    ...(entityRef === undefined ? {} : { entityRef }),
    visibility: "localSensitive",
    payload: { extensionId: AGENT_FRAMEWORK_HOST_EXTENSION_ID, event, ...details },
  };
}

function accepted(mutations: ScenarioCommandExtensionMutation[]): ScenarioCommandExtensionResult {
  return { mutations, terminalResult: { status: "accepted" } };
}

function record(recordValue: ScenarioEffectProjectionRecord): ScenarioCommandExtensionMutation {
  return { kind: "record", record: recordValue };
}

function stateChange(
  change: Extract<ScenarioCommandExtensionMutation, { kind: "stateChange" }>["change"],
): ScenarioCommandExtensionMutation {
  return { kind: "stateChange", change };
}

function unreachableHostCommand(command: never): never {
  throw new Error(`Unsupported Agent Framework host command: ${JSON.stringify(command)}`);
}
