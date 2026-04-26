import { describe, it, expect } from "vitest";
import { preClassifyMood } from "../../src/utils/sentiment-prefilter.js";

describe("preClassifyMood", () => {
  it("returns null hint and 0 interrupts for plain neutral message", () => {
    const r = preClassifyMood("please pick a next scenario to fix");
    expect(r.hint).toBeNull();
    expect(r.interruptCount).toBe(0);
  });

  it("classifies as angry when >= 2 [Request interrupted by user] entries present", () => {
    const msg =
      "first text [Request interrupted by user for tool use] middle\n[Request interrupted by user] more";
    const r = preClassifyMood(msg);
    expect(r.hint).toBe("angry");
    expect(r.interruptCount).toBeGreaterThanOrEqual(2);
  });

  it("does NOT promote to angry when only 1 interrupt", () => {
    const r = preClassifyMood("text [Request interrupted by user] more");
    expect(r.hint).toBeNull();
    expect(r.interruptCount).toBe(1);
  });

  it("classifies accusations as angry: 'you didn't'", () => {
    const r = preClassifyMood("you didn't follow the instructions");
    expect(r.hint).toBe("angry");
  });

  it("classifies accusations as angry: 'I told you'", () => {
    const r = preClassifyMood("I told you to stop doing that");
    expect(r.hint).toBe("angry");
  });

  it("classifies accusations as angry: 'why did you'", () => {
    const r = preClassifyMood("why did you change my code");
    expect(r.hint).toBe("angry");
  });

  it("classifies accusations as angry: 'you keep'", () => {
    const r = preClassifyMood("you keep making the same mistake");
    expect(r.hint).toBe("angry");
  });

  it("classifies broken-promise as angry: 'you promised you wouldn't'", () => {
    const r = preClassifyMood("you promised you wouldn't touch logic.ts");
    expect(r.hint).toBe("angry");
  });

  it("classifies apology demands as angry", () => {
    const r = preClassifyMood("apologize for breaking the build");
    expect(r.hint).toBe("angry");
  });

  it("classifies apology demands (alt spelling) as angry", () => {
    const r = preClassifyMood("apologise and fix this");
    expect(r.hint).toBe("angry");
  });

  it("classifies 'admit it' as angry", () => {
    const r = preClassifyMood("admit it, you ignored me");
    // Both apology-demand and accusation match; angry wins regardless.
    expect(r.hint).toBe("angry");
  });

  it("classifies second corrections as frustrated", () => {
    const r = preClassifyMood("as I said before, do not edit foo.ts");
    expect(r.hint).toBe("frustrated");
  });

  it("classifies 'I just told you' as frustrated", () => {
    const r = preClassifyMood("I just told you, use the MCP tool");
    expect(r.hint).toBe("frustrated");
  });

  it("does not flag mild emphasis phrases", () => {
    const r = preClassifyMood("make sure to use double quotes this time");
    expect(r.hint).toBeNull();
  });

  it("counts multiple interrupts even mixed with other signals", () => {
    const msg =
      "[Request interrupted by user for tool use]\nhmm\n[Request interrupted by user] again";
    const r = preClassifyMood(msg);
    expect(r.interruptCount).toBe(2);
    expect(r.hint).toBe("angry");
  });
});
