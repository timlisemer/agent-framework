import * as fs from "fs/promises";
import { scenarioSnapshotSchema, type ScenarioSnapshot } from "../protocol/snapshot.js";
import { writeJsonAtomically } from "../../utils/file-io.js";
import { isMissingFileError } from "../../utils/filesystem-errors.js";

export async function readScenarioSnapshot(filePath: string): Promise<ScenarioSnapshot | null> {
  try {
    return scenarioSnapshotSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

export async function writeScenarioSnapshot(filePath: string, snapshot: ScenarioSnapshot): Promise<void> {
  await writeJsonAtomically(filePath, scenarioSnapshotSchema.parse(snapshot));
}
