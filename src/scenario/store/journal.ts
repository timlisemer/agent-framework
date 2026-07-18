import { scenarioRecordSchema, type ScenarioRecord } from "../protocol/records.js";
import { appendValidatedJsonl, readValidatedJsonl, truncateFileIfPresent } from "../../utils/file-io.js";

const scenarioRecordBatchSchema = scenarioRecordSchema.array().min(1);

export type JournalReadResult = {
  records: ScenarioRecord[];
  diagnostics: string[];
  validByteLength: number;
};

export async function readScenarioJournal(filePath: string): Promise<JournalReadResult> {
  const result = await readValidatedJsonl(filePath, scenarioRecordBatchSchema);
  const records = result.values.flat().map((parsed, index) => {
    const expectedSeq = index + 1;
    if (parsed.recordSeq !== expectedSeq) {
      throw new Error(`Journal sequence discontinuity at ${parsed.recordSeq}; expected ${expectedSeq}`);
    }
    return parsed;
  });
  return {
    records,
    diagnostics: result.hadPartialTail ? ["Ignored a final partial journal line"] : [],
    validByteLength: result.validByteLength,
  };
}

export async function truncateScenarioJournal(filePath: string, byteLength: number): Promise<void> {
  await truncateFileIfPresent(filePath, byteLength);
}

export async function appendScenarioRecords(filePath: string, records: readonly ScenarioRecord[]): Promise<void> {
  if (records.length === 0) return;
  await appendValidatedJsonl(filePath, scenarioRecordBatchSchema, [[...records]]);
}
