import type { AiToolOutputBlock } from "../ai-protocol/index.js";

export function outputBlocks(value: unknown): AiToolOutputBlock[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return textOutput(value);
  if (Array.isArray(value)) {
    const output: AiToolOutputBlock[] = [];
    for (const item of value) {
      if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
        output.push({ type: "text", text: item.text });
      } else {
        output.push({ type: "json", value: item });
      }
    }
    return output;
  }
  return [{ type: "json", value }];
}

export function textOutput(text: string): AiToolOutputBlock[] {
  return text ? [{ type: "text", text }] : [];
}

export function textFromOutput(output: AiToolOutputBlock[]): string | null {
  return output.find((item) => item.type === "text")?.text ?? null;
}

export function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

export function trimmedStringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  if (typeof field !== "string") return null;
  const trimmed = field.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function errorMessage(value: unknown): string {
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return value.message;
  }
  return typeof value === "string" ? value : "Runtime error";
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function optionalNumber(value: number | undefined): number | null {
  return value === undefined ? null : value;
}
