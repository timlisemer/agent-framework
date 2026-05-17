export type PlanContentComparison =
  | { equal: true }
  | { equal: false; rawDiff: string; tooLong: boolean };

const MAX_RAW_DIFF_LENGTH = 4000;

function normalizePlanContent(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

function renderRawDiff(extractedContent: string, fileContent: string): string {
  const extractedLines = extractedContent.split(/\r?\n/);
  const fileLines = fileContent.split(/\r?\n/);
  const max = Math.max(extractedLines.length, fileLines.length);
  const chunks: string[] = [];

  for (let i = 0; i < max; i += 1) {
    if (extractedLines[i] === fileLines[i]) continue;
    chunks.push(`@@ line ${i + 1} @@`);
    chunks.push(`extracted: ${extractedLines[i] ?? "<missing>"}`);
    chunks.push(`file: ${fileLines[i] ?? "<missing>"}`);
    if (chunks.join("\n").length > MAX_RAW_DIFF_LENGTH) {
      break;
    }
  }

  return chunks.join("\n");
}

export function comparePlanContent(
  extractedContent: string,
  fileContent: string,
): PlanContentComparison {
  if (normalizePlanContent(extractedContent) === normalizePlanContent(fileContent)) {
    return { equal: true };
  }

  const rawDiff = renderRawDiff(extractedContent, fileContent);
  if (rawDiff.length > MAX_RAW_DIFF_LENGTH) {
    return { equal: false, rawDiff: rawDiff.slice(0, MAX_RAW_DIFF_LENGTH), tooLong: true };
  }
  return { equal: false, rawDiff, tooLong: false };
}
