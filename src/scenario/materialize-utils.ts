import type { ScenarioBlock } from "./types.js";

export function assignScenarioToolUseIds(
  blocks: ScenarioBlock[],
  counter: { n: number },
): void {
  for (const block of blocks) {
    if (block.type === "tool_use" && !block.id) {
      counter.n += 1;
      block.id = `toolu_scenario_${counter.n}`;
    }
  }
}
