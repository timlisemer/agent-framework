import * as path from "path";
import type { CanonicalMcp, HostContext } from "../../src/adapter/types.js";
import { readFirstUtf8File } from "../../src/utils/file-io.js";
import { adapterRoot } from "../../src/utils/paths.js";

export function readAdapterWorkflowInstructionText(input: {
  adapterName: string;
  bundledConfigDir: string;
  relativePath: string;
  host: HostContext;
  recognizeMcp: (raw: string) => CanonicalMcp | null;
}): string | null {
  const text = readFirstUtf8File([
    path.join(adapterRoot(input.adapterName), input.bundledConfigDir, input.relativePath),
    path.join(input.host.configRoot, input.relativePath),
  ]);
  return text ? canonicalizeAdapterMcpWireNames(text, input.recognizeMcp) : null;
}

function canonicalizeAdapterMcpWireNames(
  text: string,
  recognizeMcp: (raw: string) => CanonicalMcp | null,
): string {
  return text.replace(/\bmcp[^\s`"'|,.)]+/g, (token) => {
    const canonical = recognizeMcp(token);
    return canonical ? `mcp-${canonical}` : token;
  });
}
