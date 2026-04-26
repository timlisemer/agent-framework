import { describe, it, expect } from "vitest";
import { decideNextWindowSize } from "../../src/utils/prediction-types.js";

describe("decideNextWindowSize", () => {
  it("clamps below 2", () => {
    const r = decideNextWindowSize({
      oldWindow: 2,
      oldStreak: 0,
      newStreak: 0,
      prevMood: "neutral",
      effectiveMood: "happy",
      contextSwitch: "no",
    });
    expect(r).toBeGreaterThanOrEqual(2);
  });

  it("clamps above 15", () => {
    const r = decideNextWindowSize({
      oldWindow: 14,
      oldStreak: 5,
      newStreak: 5,
      prevMood: "angry",
      effectiveMood: "angry",
      contextSwitch: "no",
    });
    expect(r).toBeLessThanOrEqual(15);
  });

  it("base step: angry mood adds 2", () => {
    const r = decideNextWindowSize({
      oldWindow: 5,
      oldStreak: 1,
      newStreak: 1,
      prevMood: "angry",
      effectiveMood: "angry",
      contextSwitch: "no",
    });
    expect(r).toBe(7);
  });

  it("base step: neutral with streak=0 decreases by 2", () => {
    const r = decideNextWindowSize({
      oldWindow: 8,
      oldStreak: 0,
      newStreak: 0,
      prevMood: "neutral",
      effectiveMood: "neutral",
      contextSwitch: "no",
    });
    expect(r).toBe(6);
  });

  it("happy with streak=0 decreases by 2 (clamped to 2)", () => {
    const r = decideNextWindowSize({
      oldWindow: 3,
      oldStreak: 0,
      newStreak: 0,
      prevMood: "happy",
      effectiveMood: "happy",
      contextSwitch: "no",
    });
    expect(r).toBe(2);
  });

  it("streak rising forces +2 even if base step did less", () => {
    const r = decideNextWindowSize({
      oldWindow: 4,
      oldStreak: 1,
      newStreak: 2,
      prevMood: "frustrated",
      effectiveMood: "frustrated",
      contextSwitch: "no",
    });
    expect(r).toBe(6);
  });

  it("mood SHIFT toward hostile applies max(CURRENT+2, 6)", () => {
    const r = decideNextWindowSize({
      oldWindow: 2,
      oldStreak: 0,
      newStreak: 1,
      prevMood: "neutral",
      effectiveMood: "angry",
      contextSwitch: "no",
    });
    // base step (angry): 2+2=4. shift: max(2+2, 6)=6. final: 6.
    expect(r).toBe(6);
  });

  it("mood SHIFT from hostile to calm also triggers (uses max(old+2,6))", () => {
    const r = decideNextWindowSize({
      oldWindow: 3,
      oldStreak: 1,
      newStreak: 0,
      prevMood: "angry",
      effectiveMood: "neutral",
      contextSwitch: "no",
    });
    // shift: max(3+2,6)=6
    expect(r).toBe(6);
  });

  it("context-switch caps to 3 (overrides growth)", () => {
    const r = decideNextWindowSize({
      oldWindow: 10,
      oldStreak: 1,
      newStreak: 2,
      prevMood: "angry",
      effectiveMood: "angry",
      contextSwitch: "yes",
    });
    expect(r).toBe(3);
  });

  it("no shift, no streak change, neutral mood with prior streak: keeps oldWindow", () => {
    const r = decideNextWindowSize({
      oldWindow: 6,
      oldStreak: 2,
      newStreak: 2,
      prevMood: "frustrated",
      effectiveMood: "frustrated",
      contextSwitch: "no",
    });
    // base step: frustrated → 6+2=8
    expect(r).toBe(8);
  });

  it("clamps result inside [2, 15] regardless of inputs", () => {
    for (const oldWindow of [2, 5, 15]) {
      for (const newStreak of [0, 5]) {
        const r = decideNextWindowSize({
          oldWindow,
          oldStreak: 0,
          newStreak,
          prevMood: "neutral",
          effectiveMood: "angry",
          contextSwitch: "no",
        });
        expect(r).toBeGreaterThanOrEqual(2);
        expect(r).toBeLessThanOrEqual(15);
      }
    }
  });
});
