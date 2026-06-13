import { describe, expect, it } from "vitest";
import {
  analyzeBashCommand,
  hasActiveCommandOrProcessSubstitution,
  hasActiveFileRedirect,
  nestedPayloadCommands,
  wrappedExecutableInvocation,
} from "../../../src/utils/bash-policy/analysis.js";
import { tokenizeShellSegment } from "../../../src/utils/shell-command-parser.js";

describe("bash policy analysis", () => {
  it("unwraps supported executable wrappers", () => {
    const invocation = wrappedExecutableInvocation(tokenizeShellSegment("sudo -u root nice -n 5 git status --short"));

    expect(invocation?.executable).toBe("git");
    expect(invocation?.args).toEqual(["status", "--short"]);
    expect(invocation?.wrapperChain).toContain("sudo");
    expect(invocation?.wrapperChain).toContain("nice");
  });

  it("materializes shell payload invocations", () => {
    const analysis = analyzeBashCommand('bash -lc "npx tsc --noEmit"');

    expect(nestedPayloadCommands(analysis)).toContain("npx tsc --noEmit");
    expect(analysis.invocations.some((i) => i.source === "shell-payload" && i.executable === "npx")).toBe(true);
  });

  it("materializes eval payload invocations", () => {
    const analysis = analyzeBashCommand("eval 'git push'");

    expect(analysis.invocations.some((i) => i.source === "eval-payload" && i.executable === "git")).toBe(true);
  });

  it("materializes xargs payload invocations", () => {
    const analysis = analyzeBashCommand("xargs sed -i 's/a/b/'");

    expect(analysis.invocations.some((i) => i.source === "xargs-payload" && i.executable === "sed")).toBe(true);
  });

  it("reports chain, background, redirect, and substitution facts", () => {
    const analysis = analyzeBashCommand("rg foo src && cat file &");

    expect(analysis.hasComplexOperator).toBe(true);
    expect(analysis.backgrounded).toBe(true);
    expect(hasActiveFileRedirect("rg foo > out.txt")).toBe(true);
    expect(hasActiveFileRedirect("rg foo > /dev/null")).toBe(false);
    expect(hasActiveCommandOrProcessSubstitution('rg "$(pwd)" src')).toBe(true);
  });
});
