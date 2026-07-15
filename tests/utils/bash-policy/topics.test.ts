import { describe, expect, it } from "vitest";
import { evaluateBashPolicy } from "../../../src/utils/bash-command-policy.js";
import { checkRoutedPolicyFindings } from "../../../src/utils/bash-policy/topics/check-routed.js";
import { fileWritePolicyFindings } from "../../../src/utils/bash-policy/topics/file-write.js";
import { findSedPolicyFindings } from "../../../src/utils/bash-policy/topics/find-sed.js";
import { gitPolicyFindings } from "../../../src/utils/bash-policy/topics/git.js";
import { runInstallRemotePolicyFindings } from "../../../src/utils/bash-policy/topics/run-install-remote.js";
import { scriptExecPolicyFindings } from "../../../src/utils/bash-policy/topics/script-exec.js";
import { matchPatternInCommand } from "../../../src/utils/bash-policy/registry.js";

describe("bash policy topics", () => {
  it("emits structured findings for each hard-deny topic", () => {
    expect(gitPolicyFindings("git push")[0]).toMatchObject({ topic: "git", name: "git write op (MCP)" });
    expect(fileWritePolicyFindings("tee out.txt")[0]).toMatchObject({ topic: "file-write", name: "tee file write" });
    expect(scriptExecPolicyFindings("node script.js", matchPatternInCommand)[0]).toMatchObject({ topic: "script-exec", name: "node" });
    expect(runInstallRemotePolicyFindings("npm install express", matchPatternInCommand)[0]).toMatchObject({ topic: "run-install-remote", name: "npm install" });
    expect(findSedPolicyFindings("sed -i 's/a/b/' file.txt")[0]).toMatchObject({ topic: "find-sed", name: "sed in-place edit" });
  });

  it("emits structured check-routed findings", () => {
    expect(checkRoutedPolicyFindings("npx --yes tsc --noEmit")[0]).toMatchObject({
      topic: "check-routed",
      kind: "route-to-check",
      name: "tsc",
      category: "type-check",
    });
  });

  it("keeps secondary findings within the same topic family", () => {
    expect(gitPolicyFindings("git push && git checkout main").map((finding) => finding.name)).toEqual([
      "git write op (MCP)",
      "git write op",
    ]);
    expect(scriptExecPolicyFindings("node script.js && python script.py", matchPatternInCommand).map((finding) => finding.name)).toEqual([
      "python",
      "node",
    ]);
    expect(fileWritePolicyFindings("echo hi > a && tee b").map((finding) => finding.name)).toEqual([
      "shell redirect",
      "echo redirect",
      "tee file write",
    ]);
  });

  it("emits deterministic file-write findings for command write forms", () => {
    expect(fileWritePolicyFindings("dd if=/tmp/in of=/tmp/out")[0]).toMatchObject({
      topic: "file-write",
      name: "dd file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("install /tmp/source /tmp/target")[0]).toMatchObject({
      topic: "file-write",
      name: "install file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("install -d /tmp/outdir")[0]).toMatchObject({
      topic: "file-write",
      name: "install file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("install -t /tmp/outdir /tmp/source")[0]).toMatchObject({
      topic: "file-write",
      name: "install file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("install -vtdest /tmp/source")[0]).toMatchObject({
      topic: "file-write",
      name: "install file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("install --target-directory=/tmp/outdir /tmp/source")[0]).toMatchObject({
      topic: "file-write",
      name: "install file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("cp /tmp/source /tmp/target")[0]).toMatchObject({
      topic: "file-write",
      name: "cp file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("cp -t /tmp/outdir /tmp/source")[0]).toMatchObject({
      topic: "file-write",
      name: "cp file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("cp -vtdest /tmp/source")[0]).toMatchObject({
      topic: "file-write",
      name: "cp file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("cp --target-directory=/tmp/outdir /tmp/source")[0]).toMatchObject({
      topic: "file-write",
      name: "cp file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("mv /tmp/source /tmp/target")[0]).toMatchObject({
      topic: "file-write",
      name: "mv file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("mv -t /tmp/outdir /tmp/source")[0]).toMatchObject({
      topic: "file-write",
      name: "mv file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("mv -vtdest /tmp/source")[0]).toMatchObject({
      topic: "file-write",
      name: "mv file write",
      category: "file-write",
    });
    expect(fileWritePolicyFindings("mv --target-directory=/tmp/outdir /tmp/source")[0]).toMatchObject({
      topic: "file-write",
      name: "mv file write",
      category: "file-write",
    });
  });

  it("emits background file-write before generic nested shell redirect findings", () => {
    expect(fileWritePolicyFindings("printf x > /tmp/out &").map((finding) => finding.name)).toEqual([
      "background shell file write",
      "shell redirect",
      "echo redirect",
    ]);
    expect(fileWritePolicyFindings("bash -lc 'printf x > /tmp/out' &").map((finding) => finding.name)).toEqual([
      "background shell file write",
      "shell redirect",
      "echo redirect",
    ]);
  });

  it("does not promote foreground writes after unrelated background segments", () => {
    expect(fileWritePolicyFindings("sleep 1 & printf x > /tmp/out").map((finding) => finding.name)).toEqual([
      "shell redirect",
      "echo redirect",
    ]);
  });

  it("preserves registry precedence with one terminal owner", () => {
    const result = evaluateBashPolicy("cd repo && npx tsc --noEmit");

    expect(result.terminal.ownerName).toBe("cd");
    expect(result.terminal.ownerTopic).toBe("read-only");
    expect(result.observations.filter((finding) => finding.role === "terminal-candidate")).toHaveLength(1);
    expect(result.observations.some((finding) => finding.topic === "check-routed" && finding.name === "tsc")).toBe(true);
  });

  it.each([
    ["find . -delete", "find destructive flag"],
    ["sed -i 's/a/b/' file.txt", "sed in-place edit"],
  ])("promotes destructive %s to find-sed terminal ownership", (command, ownerName) => {
    const result = evaluateBashPolicy(command);

    expect(result.terminal.ownerTopic).toBe("find-sed");
    expect(result.terminal.ownerName).toBe(ownerName);
    expect(result.terminal.riskClass).toBe("blocked");
    expect(result.observations.filter((finding) => finding.role === "terminal-candidate")).toHaveLength(1);
  });

  it("keeps read-only hard blocks ahead of find-sed ownership", () => {
    const result = evaluateBashPolicy("cd /tmp && find . -delete");

    expect(result.terminal.ownerTopic).toBe("read-only");
    expect(result.terminal.ownerName).toBe("cd");
    expect(result.terminal.riskClass).toBe("blocked");
  });

  it.each([
    "cat /tmp/runtime/auth.json",
    "grep token /tmp/runtime/auth.json",
    "grep -e token /tmp/runtime/auth.json",
    "rg token /tmp/runtime/auth.json",
    "rg -e token /tmp/runtime/auth.json",
    "rg --regexp=token /tmp/runtime/auth.json",
    "rg --files /tmp/runtime/auth.json",
    "rg --files -- /tmp/runtime/auth.json",
    "rg --files ~/.ssh",
    "rg -g auth.json token /tmp/runtime",
    "rg -gauth.json token /tmp/runtime",
    "rg --glob auth.json token /tmp/runtime",
    "grep --include=auth.json token /tmp/runtime/*",
    "xargs -a /tmp/runtime/auth.json cat",
    "xargs --arg-file /tmp/runtime/auth.json cat",
    "xargs --arg-file=/tmp/runtime/auth.json cat",
    "xargs -a .env.local cat",
    "nl /tmp/runtime/auth.json",
    "sort /tmp/runtime/auth.json",
    "cut -d: -f1 /tmp/runtime/auth.json",
    "diff /tmp/runtime/auth.json /tmp/runtime/auth-copy.json",
  ])("blocks read-only Bash access to provider auth files: %s", (command) => {
    const result = evaluateBashPolicy(command);

    expect(result.terminal.ownerTopic).toBe("read-only");
    expect(result.terminal.ownerName).toBe("read-only guard");
    expect(result.terminal.riskClass).toBe("blocked");
    expect(result.terminal.reason).toContain("sensitive path read blocked");
  });

  it("keeps nix eval as a direct hard block outside install/run policy", () => {
    const command = "nix eval .#checks.x86_64-linux";
    const result = evaluateBashPolicy(command);

    expect(runInstallRemotePolicyFindings(command, matchPatternInCommand)).toEqual([]);
    expect(result.terminal.ownerName).toBe("nix eval");
    expect(result.terminal.ownerTopic).toBe("read-only");
    expect(result.terminal.riskClass).toBe("blocked");
    expect(result.terminal.alternative).toBe("Use nix-eval-jobs instead");
    expect(result.terminal.workaroundCategory).toBeUndefined();
  });
});
