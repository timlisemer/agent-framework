import { describe, expect, it } from "vitest";
import { applyTextEditReplacements } from "../../src/utils/edit-tools.js";

describe("edit tool helpers", () => {
  it("applies single Edit replacements by default", () => {
    expect(applyTextEditReplacements("a a", "Edit", {
      old_string: "a",
      new_string: "b",
    })).toBe("b a");
  });

  it("applies replace_all for Edit", () => {
    expect(applyTextEditReplacements("a a", "Edit", {
      old_string: "a",
      new_string: "b",
      replace_all: true,
    })).toBe("b b");
  });

  it("applies replace_all for individual MultiEdit entries", () => {
    expect(applyTextEditReplacements("a a c", "MultiEdit", {
      edits: [
        { old_string: "a", new_string: "b", replace_all: true },
        { old_string: "c", new_string: "d" },
      ],
    })).toBe("b b d");
  });
});
