import { describe, it, expect } from "vitest";
import { redactPathTokens } from "../../src/utils/path-redaction.js";

describe("redactPathTokens", () => {
  it("returns empty string for empty input", () => {
    expect(redactPathTokens("")).toBe("");
  });

  it("redacts trailing-slash directory token", () => {
    expect(redactPathTokens("ls test-harness/")).toBe("ls <PATH>");
  });

  it("redacts path with subdirectory", () => {
    expect(redactPathTokens("rm -rf test-harness/fixtures")).toBe("rm -rf <PATH>");
  });

  it("leaves bare alphanumeric verbs intact (cargo test)", () => {
    expect(redactPathTokens("cargo test")).toBe("cargo test");
  });

  it("redacts path while preserving bare test verb", () => {
    expect(redactPathTokens("cargo test test-harness/foo.ts")).toBe("cargo test <PATH>");
  });

  it("preserves redirect operator, redacts redirect target", () => {
    expect(redactPathTokens("echo hi > test-harness/out.log")).toBe("echo hi > <PATH>");
  });

  it("redacts ./-prefixed relative path", () => {
    expect(redactPathTokens("ls ./test-harness")).toBe("ls <PATH>");
  });

  it("redacts @-prefixed shorthand path", () => {
    expect(redactPathTokens("ls @test-harness/")).toBe("ls <PATH>");
  });

  it("redacts home-rooted path", () => {
    expect(redactPathTokens("cat ~/Coding/repo/test/file.md")).toBe("cat <PATH>");
  });

  it("redacts absolute path", () => {
    expect(redactPathTokens("stat /etc/passwd")).toBe("stat <PATH>");
  });

  it("redacts glob pattern token wholesale", () => {
    expect(redactPathTokens("glob test-harness/**/*.ts")).toBe("glob <PATH>");
  });

  it("redacts trailing path after shell chain", () => {
    expect(redactPathTokens("cargo run && test-harness/run.sh")).toBe("cargo run && <PATH>");
  });

  it("redacts env-var with hyphenated value and script path", () => {
    // NODE_OPTIONS=--inspect has an internal hyphen (rule 6) so gets redacted;
    // this is acceptable because verb-only patterns don't care about env values.
    expect(redactPathTokens("NODE_OPTIONS=--inspect node app.js")).toBe("<PATH> node <PATH>");
  });

  it("redacts hyphenated directory without trailing slash", () => {
    expect(redactPathTokens("ls test-harness")).toBe("ls <PATH>");
  });

  it("redacts extension-only filename", () => {
    expect(redactPathTokens("README.md")).toBe("<PATH>");
  });

  it("leaves plain word-only input unchanged", () => {
    expect(redactPathTokens("plain words no paths")).toBe("plain words no paths");
  });

  it("redacts Windows-style path with backslashes", () => {
    expect(redactPathTokens("C:\\Users\\foo\\bar.txt")).toBe("<PATH>");
  });

  it("preserves long CLI flags", () => {
    expect(redactPathTokens("--coverage")).toBe("--coverage");
  });

  it("preserves short CLI flags", () => {
    expect(redactPathTokens("-rf")).toBe("-rf");
  });

  it("leaves bare test word intact", () => {
    expect(redactPathTokens("test")).toBe("test");
  });
});
