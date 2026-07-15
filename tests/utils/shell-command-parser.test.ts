import { describe, expect, it } from "vitest";
import {
  analyzeXargsCommand,
  hasValidShellLexing,
  parseShellOptionArguments,
  parseShellOptionArgumentsDetailed,
  quoteShellToken,
  serializeShellCommandTokens,
  tokenizeShellSegment,
  xargsCommandTokens,
  xargsPrefixIsValid,
} from "../../src/utils/shell-command-parser.js";

describe("shell option argument parsing", () => {
  it("reports incomplete quotes and trailing escapes as invalid shell lexing", () => {
    expect(hasValidShellLexing("cat 'plan.md'")).toBe(true);
    expect(hasValidShellLexing('cat "plan.md"')).toBe(true);
    expect(hasValidShellLexing("cat 'plan.md")).toBe(false);
    expect(hasValidShellLexing('cat "plan.md')).toBe(false);
    expect(hasValidShellLexing("cat plan.md\\")).toBe(false);
  });

  it("preserves backslashes before ordinary characters inside double quotes", () => {
    expect(tokenizeShellSegment('cat "plan\\.md"'))
      .toEqual(["cat", "plan\\.md"]);
    expect(tokenizeShellSegment('cat "literal\\q"'))
      .toEqual(["cat", "literal\\q"]);
    expect(tokenizeShellSegment('cat "literal\\$name"'))
      .toEqual(["cat", "literal$name"]);
  });

  it("serializes structured tokens without losing shell boundaries", () => {
    const tokens = ["xargs", "cat", "name with spaces", "unrelated; cat required.md", "it's.txt", "", '1"0', "a\\b"];
    expect(tokenizeShellSegment(serializeShellCommandTokens(tokens))).toEqual(tokens);
    expect(serializeShellCommandTokens(
      ["cat", "name with spaces", "it's.txt", "a;b"],
    )).toBe("cat 'name with spaces' 'it'\\''s.txt' 'a;b'");
    expect(quoteShellToken('say "hi"', "win32")).toBe('"say ""hi"""');
  });

  it("removes separate, attached, inline, and clustered option values", () => {
    const oneValue = new Set(["-n", "--lines"]);
    expect(parseShellOptionArguments(["-n", "20", "file"], {
      optionsWithOneValue: oneValue,
    })).toEqual(["file"]);
    expect(parseShellOptionArguments(["-n20", "file"], {
      optionsWithOneValue: oneValue,
    })).toEqual(["file"]);
    expect(parseShellOptionArguments(["--lines=20", "file"], {
      optionsWithOneValue: oneValue,
    })).toEqual(["file"]);
    expect(parseShellOptionArguments(["-vn", "20", "file"], {
      optionsWithOneValue: oneValue,
    })).toEqual(["file"]);
  });

  it("preserves arguments after the option terminator", () => {
    expect(parseShellOptionArguments(["--", "-n", "file"], {
      optionsWithOneValue: new Set(["-n"]),
    })).toEqual(["-n", "file"]);
  });

  it("tracks active options without rescanning consumed values", () => {
    const trackedOptions = new Set(["-f", "-n", "--null-input"]);
    expect(parseShellOptionArgumentsDetailed(["-rn", "."], {
      trackedOptions,
    }).encounteredOptions).toContain("-n");
    expect(parseShellOptionArgumentsDetailed(["--", "-n"], {
      trackedOptions,
    }).encounteredOptions).not.toContain("-n");
    const parsed = parseShellOptionArgumentsDetailed(
      ["--arg", "name", "-f", "filter", "input.json"],
      {
        optionsWithTwoValues: new Set(["--arg"]),
        trackedOptions,
      },
    );
    expect(parsed.encounteredOptions).not.toContain("-f");
    expect(parsed.positionals).toEqual(["filter", "input.json"]);

    const attached = parseShellOptionArgumentsDetailed(
      ["-vfoo=f", "program", "input.awk"],
      {
        optionsWithOneValue: new Set(["-v"]),
        trackedOptions: new Set(["-f"]),
      },
    );
    expect(attached.encounteredOptions).not.toContain("-f");
    expect(attached.positionals).toEqual(["program", "input.awk"]);

    const malformedValuelessOption = parseShellOptionArgumentsDetailed(
      ["--quiet=garbage", "p", "plan.md"],
      { knownOptions: new Set(["--quiet"]) },
    );
    expect(malformedValuelessOption.unrecognizedOptions)
      .toContain("--quiet=garbage");
  });

  it("reports separate, attached, inline, and multi-argument option values", () => {
    const policy = {
      optionsWithOneValue: new Set(["-n", "--lines"]),
    };
    expect(parseShellOptionArgumentsDetailed(["-n", "0", "file"], policy).optionValues.get("-n"))
      .toEqual(["0"]);
    expect(parseShellOptionArgumentsDetailed(["-n20", "file"], policy).optionValues.get("-n"))
      .toEqual(["20"]);
    expect(parseShellOptionArgumentsDetailed(["--lines=30", "file"], policy).optionValues.get("--lines"))
      .toEqual(["30"]);
    expect(parseShellOptionArgumentsDetailed(["--arg", "name", "value", "file"], {
      optionsWithTwoValues: new Set(["--arg"]),
    }).optionValues.get("--arg")).toEqual(["name", "value"]);
    expect(parseShellOptionArgumentsDetailed(["file", "-n"], {
      optionsWithOneValue: new Set(["-n"]),
    }).incompleteOptions).toEqual(["-n"]);
  });

  it("rejects abbreviated, unknown, and malformed xargs prefixes", () => {
    for (const tokens of [
      ["xargs", "--no-run-if-e", "cat", "file"],
      ["xargs", "--repl={}", "cat", "file"],
      ["xargs", "--definitely-unknown", "cat", "file"],
      ["xargs", "-n", "nope", "cat", "file"],
      ["xargs", "--max-args=nope", "cat", "file"],
    ]) {
      expect(xargsPrefixIsValid(tokens), tokens.join(" ")).toBe(false);
      expect(xargsCommandTokens(tokens), tokens.join(" ")).toBeNull();
    }

    expect(xargsPrefixIsValid(["xargs", "-n", "2", "cat", "file"])).toBe(true);
    expect(xargsCommandTokens(["xargs", "-n2", "cat", "file"]))
      .toEqual(["cat", "file"]);
    expect(analyzeXargsCommand(["xargs", "--arg-file=/tmp/input", "cat"]).optionValues)
      .toEqual(new Map([["--arg-file", ["/tmp/input"]]]));
  });
});
