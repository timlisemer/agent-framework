import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleScenarioTester } from "../../src/agents/mcp/scenario-tester.js";
import { materializeContractScenario } from "../../src/scenario/contract-cli.js";
import {
  cleanupTemporaryTestRoots,
  createTemporaryTestRoot,
} from "../helpers/temporary-root.js";

const roots: string[] = [];

afterEach(async () => {
  await cleanupTemporaryTestRoots(roots);
});

describe("raw run ID boundaries", () => {
  it("rejects traversal in the contract materializer before accessing the target", async () => {
    const temporaryDir = await createTemporaryTestRoot(roots, "contract-run-id-boundary-");
    const runtimeRoot = path.join(temporaryDir, "runtime");
    const victim = path.join(temporaryDir, "victim");
    await fs.mkdir(victim);
    await fs.writeFile(path.join(victim, "sentinel.txt"), "untouched", "utf8");

    await expect(materializeContractScenario(
      runtimeRoot,
      "../../victim",
      "unsafe-contract-run",
    )).rejects.toThrow("IDs must be path-safe protocol identifiers");
    expect(await fs.readFile(path.join(victim, "sentinel.txt"), "utf8")).toBe("untouched");
    await expect(fs.access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal in scenario_tester materialization before filesystem mutation", async () => {
    const temporaryDir = await createTemporaryTestRoot(roots, "tester-run-id-boundary-");
    const runtimeRoot = path.join(temporaryDir, "runtime");
    const victim = path.join(temporaryDir, "victim");
    await fs.mkdir(victim);
    await fs.writeFile(path.join(victim, "sentinel.txt"), "untouched", "utf8");

    await expect(handleScenarioTester({
      action: "materialize_scenario",
      run_id: "../../victim",
      runtime_root: runtimeRoot,
      scenario_name: "unsafe-tester-run",
    })).resolves.toContain("IDs must be path-safe protocol identifiers");
    expect(await fs.readFile(path.join(victim, "sentinel.txt"), "utf8")).toBe("untouched");
    await expect(fs.access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
