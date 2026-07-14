// agent-framework-style-drift-ignore-file
/**
 * Quote Detection - Centralized utility for stripping quoted/pasted content.
 * @module quote-detection
 */

export function hasQuotedContent(text: string): boolean {
  return (
    /QUOTE\s*:/i.test(text) ||
    /^```/m.test(text) ||
    /^\s*[⎿✶✻●❯]\s/m.test(text) ||
    /^\s*>/m.test(text) ||
    /"[^"]*"/.test(text) ||
    /(?<!\w)'[^']*'/.test(text) ||
    /`[^`]*`/.test(text)
  );
}

export function stripQuotedAndPastedContent(text: string): string {
  if (!hasQuotedContent(text)) return text;
  let result = text;

  // Stage 1: Explicit quote markers
  result = result.replace(/QUOTE\s*:\s*"?([\s\S]*?)"?\s*QUOTE\s*END/gi, "");
  result = result.replace(/"""[\s\S]*?"""/g, "");
  result = result.replace(/'''[\s\S]*?'''/g, "");

  // Stage 2: Fenced code blocks
  result = result.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "");
  result = result.replace(/^```[^\n]*\n[\s\S]*$/gm, "");

  // Stage 3: CLI output marker lines with continuation
  const lines = result.split("\n");
  const kept: string[] = [];
  let inCliBlock = false;
  for (const line of lines) {
    if (/^\s*[⎿✶✻●❯]\s/.test(line)) {
      inCliBlock = true;
      continue;
    }
    if (inCliBlock && (/^\s{2,}\S/.test(line) || line.trim() === "")) {
      continue;
    }
    inCliBlock = false;
    kept.push(line);
  }
  result = kept.join("\n");

  // Stage 4: Indented blocks (3+ consecutive lines, 4+ spaces or tab)
  const lines2 = result.split("\n");
  const kept2: string[] = [];
  let indentedRun: string[] = [];
  for (const line of lines2) {
    if (/^(?: {4,}|\t)\S/.test(line)) {
      indentedRun.push(line);
    } else {
      if (indentedRun.length < 3) kept2.push(...indentedRun);
      indentedRun = [];
      kept2.push(line);
    }
  }
  if (indentedRun.length < 3) kept2.push(...indentedRun);
  result = kept2.join("\n");

  // Stage 5: Blockquote lines
  result = result.split("\n").filter((l) => !/^>\s/.test(l)).join("\n");

  // Stage 6: Inline quotes (lookbehind avoids contractions like don't)
  result = result.replace(/"[^"]*"/g, "");
  result = result.replace(/(?<!\w)'[^']*'/g, "");
  result = result.replace(/`[^`]*`/g, "");

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

export function stripQuotedContent(text: string): string {
  return stripQuotedAndPastedContent(text);
}
