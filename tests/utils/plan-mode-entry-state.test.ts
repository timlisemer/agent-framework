import { describe, expect, it } from "vitest";
import {
  derivePlanModeTransition,
  parsePlanModeStoredState,
} from "../../src/utils/plan-mode-entry-state.js";

describe("plan-mode transition state", () => {
  it("derives entry, continuation, and exit from canonical prior state", () => {
    const entered = derivePlanModeTransition({
      source: "UserPromptSubmit",
      detection: { active: true, mode: "plan", source: "hook-permission-mode" },
      previous: null,
    });
    const continued = derivePlanModeTransition({
      source: "UserPromptSubmit",
      detection: { active: true, mode: "plan", source: "hook-permission-mode" },
      previous: entered.current,
    });
    const exited = derivePlanModeTransition({
      source: "UserPromptSubmit",
      detection: { active: false, mode: "default", source: "hook-permission-mode" },
      previous: continued.current,
    });

    expect(entered).toMatchObject({ active: true, entered: true, exited: false });
    expect(continued).toMatchObject({ active: true, entered: false, exited: false });
    expect(exited).toMatchObject({ active: false, entered: false, exited: true });
  });

  it("normalizes canonical state and rejects invalid values", () => {
    expect(parsePlanModeStoredState({ active: true })).toMatchObject({
      active: true,
      mode: null,
      detection_source: "none",
      deliveredPlansMdHash: null,
    });
    expect(parsePlanModeStoredState({ active: "yes" })).toBeNull();
    expect(parsePlanModeStoredState(null)).toBeNull();
  });
});
