import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Codex dotcodex AGENTS.md", () => {
  it("matches the planning contract used by the temporary global Codex workaround", () => {
    const root = process.cwd();
    const plans = fs.readFileSync(path.join(root, "PLANS.md"), "utf-8");
    const agents = fs.readFileSync(
      path.join(root, "adapters/codex/dotcodex/AGENTS.md"),
      "utf-8",
    );

    expect(agents).toBe(plans);
  });
});
