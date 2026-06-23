import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENTATION_WRAPPER_TARGETS,
  renderImplementationWrapper,
} from "../../adapters/shared/implementation-wrapper-template.js";
import { adapterSpecByName } from "../../src/adapter/spec.js";

describe("implementation wrapper contract", () => {
  it("materializes adapter wrappers from the shared implementation wrapper template", () => {
    for (const target of IMPLEMENTATION_WRAPPER_TARGETS) {
      const content = fs.readFileSync(path.join(process.cwd(), target.filePath), "utf-8");
      const mcpWireName = adapterSpecByName(target.adapter).mcpWireName(target.mcp);

      expect(content, target.filePath).toBe(renderImplementationWrapper(target, mcpWireName));
      if (target.adapter === "codex" && target.surface === "codex-agent") {
        expect(content, target.filePath).toContain("sandbox_mode = \"read-only\"");
      }
    }
  });
});
