// agent-framework-style-drift-ignore-file
import { describe, expect, it } from "vitest";
import { clipUtf8Bytes } from "../../src/utils/text-bounds.js";

describe("clipUtf8Bytes", () => {
  it("bounds bytes without splitting multibyte characters", () => {
    const clipped = clipUtf8Bytes("a😀ä".repeat(100), 80, "\ncut\n", 1);

    expect(Buffer.byteLength(clipped, "utf8")).toBeLessThanOrEqual(80);
    expect(clipped).toContain("\ncut\n");
    expect(clipped).not.toContain("�");
  });

  it("clips an oversized multibyte marker at a valid boundary", () => {
    const clipped = clipUtf8Bytes("source text", 7, "😀😀😀", 1);

    expect(Buffer.byteLength(clipped, "utf8")).toBeLessThanOrEqual(7);
    expect(clipped).not.toContain("�");
  });
});
