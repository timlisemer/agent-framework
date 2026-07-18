import * as path from "path";
import { fileURLToPath } from "url";
import { buildScenarioProtocolArtifacts } from "../src/scenario/protocol/generated-artifacts.js";
import { synchronizeGeneratedFiles } from "./lib/generated-files.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const generatedFiles = new Map([...buildScenarioProtocolArtifacts()].map(([name, contents]) => [
  `src/scenario/protocol/generated/${name}`,
  contents,
]));

await synchronizeGeneratedFiles({
  root,
  files: generatedFiles,
  check: process.argv.includes("--check"),
  staleMessage: (stale) =>
    `Scenario protocol artifacts are stale: ${stale.join(", ")}`,
});
