import { describe, expect, it } from "vitest";
import { workflowStateChanges } from "../../src/effects/rule-pipeline-executor.js";
import { sessionWorkflowStateFromJson } from "../../src/effects/session-workflow.js";

describe("RulePipelineEffectExecutor workflow changes", () => {
  it("does not persist semantically equal workflow maps with different insertion order", () => {
    const initial = sessionWorkflowStateFromJson({
      driftReductionCredits: { "/first.ts": 1, "/second.ts": 2 },
    });
    const reordered = sessionWorkflowStateFromJson({
      driftReductionCredits: { "/second.ts": 2, "/first.ts": 1 },
    });

    expect(workflowStateChanges(initial, reordered, true)).toEqual([]);
  });
});
