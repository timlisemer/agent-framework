import type { ProviderToolOutputBlock } from "./provider-contract.js";

export function outputBlocks(value: unknown): ProviderToolOutputBlock[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return textOutput(value);
  if (Array.isArray(value)) {
    const output: ProviderToolOutputBlock[] = [];
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

export function textOutput(text: string): ProviderToolOutputBlock[] {
  return text ? [{ type: "text", text }] : [];
}

export function textFromOutput(output: ProviderToolOutputBlock[]): string | null {
  return output.find((item) => item.type === "text")?.text ?? null;
}
