import { describe, expect, it } from "vitest";
import {
  analyzeBashCommand,
  hasActiveCommandOrProcessSubstitution,
  hasActiveFileRedirect,
  hasActiveInputRedirect,
  hasActiveOutputRedirect,
  hasActiveShellExpansion,
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

  it("preserves quoted xargs payload token boundaries", () => {
    const analysis = analyzeBashCommand("xargs cat 'unrelated; cat required.md'");
    const payloadInvocations = analysis.invocations.filter((invocation) =>
      invocation.source === "xargs-payload"
    );

    expect(payloadInvocations).toHaveLength(1);
    expect(payloadInvocations[0]).toMatchObject({
      executable: "cat",
      args: ["unrelated; cat required.md"],
    });
  });

  it("reports chain, background, redirect, and substitution facts", () => {
    const analysis = analyzeBashCommand("rg foo src && cat file &");

    expect(analysis.hasComplexOperator).toBe(true);
    expect(analysis.backgrounded).toBe(true);
    expect(hasActiveFileRedirect("rg foo > out.txt")).toBe(true);
    expect(hasActiveFileRedirect("rg foo > /dev/null")).toBe(false);
    expect(hasActiveFileRedirect("rg foo > /dev/shm/out.txt")).toBe(true);
    expect(hasActiveFileRedirect("rg foo > ''/tmp/out.txt")).toBe(true);
    expect(hasActiveFileRedirect("rg foo > '/tmp/'out.txt")).toBe(true);
    expect(hasActiveFileRedirect("rg foo > '/dev/'null")).toBe(false);
    expect(hasActiveFileRedirect('rg foo > "\\/dev/null"')).toBe(true);
    expect(hasActiveFileRedirect('rg foo > "/dev/\\null"')).toBe(true);
    expect(hasActiveFileRedirect('rg foo > "/dev/null"')).toBe(false);
    expect(hasActiveOutputRedirect("cat plan.md >&/dev/null")).toBe(true);
    expect(hasActiveOutputRedirect("cat plan.md 1>&-")).toBe(true);
    expect(hasActiveOutputRedirect("cat plan.md 1>&2")).toBe(true);
    expect(hasActiveInputRedirect("cat <plan.md")).toBe(true);
    expect(hasActiveInputRedirect("cat file.md<input.md")).toBe(true);
    expect(hasActiveInputRedirect("cat <<< data")).toBe(true);
    expect(hasActiveCommandOrProcessSubstitution('rg "$(pwd)" src')).toBe(true);
    expect(hasActiveShellExpansion("cat '$PLAN_FILE'")).toBe(false);
    expect(hasActiveShellExpansion('cat "$PLAN_FILE"')).toBe(true);
    expect(hasActiveShellExpansion("cat $PLAN_FILE")).toBe(true);
  });
});
