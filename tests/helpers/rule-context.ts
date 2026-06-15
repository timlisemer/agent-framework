import * as os from "os";
import * as path from "path";
import type { RuleContext } from "../../src/rules/types.js";
import { CacheManager } from "../../src/utils/cache-manager.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";

export function makeRuleContext(overrides: Partial<RuleContext> = {}): RuleContext {
  const tempDir = os.tmpdir();
  const stateManager = new CacheManager({
    filePath: path.join(tempDir, "agent-framework-test-state.json"),
    defaultData: sessionStateDefaults,
  });
  return {
    toolName: "Bash",
    toolInput: {},
    toolUseId: "toolu_test",
    projectDir: tempDir,
    transcriptPath: path.join(tempDir, "transcript.jsonl"),
    sessionDir: tempDir,
    sessionId: "test-session",
    state: sessionStateDefaults(),
    stateManager,
    planMode: false,
    planModeCtx: { active: false, contextString: "" },
    ...overrides,
  };
}
