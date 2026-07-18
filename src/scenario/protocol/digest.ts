import { hashSha256 } from "../../utils/hash-utils.js";
import { canonicalJson } from "./canonical-json.js";
import type { JsonValue } from "./common.js";
import type { ScenarioCommand } from "./commands.js";

export function digestCanonicalJson(value: unknown): string {
  return `sha256:${hashSha256(canonicalJson(value))}`;
}

/** Digest a canonical scenario value with recursively sorted object keys. */
export function digestScenarioValue(value: JsonValue): string {
  return digestCanonicalJson(value);
}

/** Validate every digest-bearing canonical command payload. */
export function assertScenarioCommandDigests(
  command: ScenarioCommand,
  errorSuffix = "",
): void {
  const payload = command.payload as ScenarioCommand["payload"] & {
    content?: string;
    prompt?: string;
    contentDigest?: string;
    input?: JsonValue;
    inputDigest?: string;
  };
  if (payload.contentDigest !== undefined) {
    const content = payload.content ?? payload.prompt;
    if (content === undefined || payload.contentDigest !== digestScenarioValue(content)) {
      throw new Error(`${payload.type} content digest mismatch${errorSuffix}`);
    }
  }
  if (
    payload.inputDigest !== undefined &&
    (payload.input === undefined || payload.inputDigest !== digestScenarioValue(payload.input))
  ) {
    throw new Error(`${payload.type} input digest mismatch${errorSuffix}`);
  }
  const transcriptData = command.payload.type === "nativeTranscriptObserved"
    ? command.payload.data
    : undefined;
  for (const message of transcriptData?.messages ?? []) {
    if (message.contentDigest !== digestScenarioValue(message.content)) {
      throw new Error(`${payload.type} message digest mismatch${errorSuffix}: ${message.id}`);
    }
  }
  for (const tool of transcriptData?.tools ?? []) {
    if (tool.inputDigest !== digestScenarioValue(tool.input)) {
      throw new Error(`${payload.type} tool digest mismatch${errorSuffix}: ${tool.id}`);
    }
  }
  if (transcriptData?.digest !== undefined) {
    const { messages, tools, digest } = transcriptData;
    if (digest !== digestScenarioValue({ messages, tools })) {
      throw new Error(`${payload.type} transcript digest mismatch${errorSuffix}`);
    }
  }
}
