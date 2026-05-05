import type { CanonicalToolCall } from "../../src/adapter/types.js";
import { recognizeMcp } from "./recognize-mcp.js";

export function canonicalizeToolCall(rawName: string, rawInput: unknown): CanonicalToolCall {
  const mcp = recognizeMcp(rawName);
  if (mcp) return { toolName: `mcp-${mcp}`, toolInput: rawInput };
  return { toolName: rawName, toolInput: rawInput };
}
