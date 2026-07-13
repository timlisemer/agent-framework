import type { ProcessResult } from "./command.js";

export interface ParsedPorcelainStatusLine {
  indexStatus: string;
  workTreeStatus: string;
  path: string;
  oldPath?: string;
}

export function parsePorcelainStatusLine(line: string): ParsedPorcelainStatusLine | undefined {
  if (line.length < 4) return undefined;
  const indexStatus = line[0];
  const workTreeStatus = line[1];
  const payload = line.slice(3);
  if (!payload) return undefined;
  if (
    (indexStatus === "R" || workTreeStatus === "R" || indexStatus === "C" || workTreeStatus === "C")
    && payload.includes(" -> ")
  ) {
    const quotedRename = payload.match(/^("(?:\\.|[^"\\])*") -> ("(?:\\.|[^"\\])*")$/);
    if (quotedRename) {
      try {
        return {
          indexStatus,
          workTreeStatus,
          oldPath: JSON.parse(quotedRename[1]) as string,
          path: JSON.parse(quotedRename[2]) as string,
        };
      } catch {
        return undefined;
      }
    }
    const separator = payload.indexOf(" -> ");
    return {
      indexStatus,
      workTreeStatus,
      oldPath: payload.slice(0, separator),
      path: payload.slice(separator + " -> ".length),
    };
  }
  if (payload.startsWith('"')) {
    try {
      return { indexStatus, workTreeStatus, path: JSON.parse(payload) as string };
    } catch {
      return undefined;
    }
  }
  return { indexStatus, workTreeStatus, path: payload };
}

export function formatGitPathForContext(pathname: string): string {
  return /^[^\u0000-\u001f\u007f"\\]+$/.test(pathname) ? pathname : JSON.stringify(pathname);
}

/** Encode a path using the C-style quoting used by Git diff headers. */
export function quoteGitPath(pathname: string): string {
  if (/^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/.test(pathname)) return pathname;
  const escaped = [...Buffer.from(pathname, "utf8")].map((byte) => {
    if (byte === 34) return "\\\"";
    if (byte === 92) return "\\\\";
    if (byte === 9) return "\\t";
    if (byte === 10) return "\\n";
    if (byte === 13) return "\\r";
    if (byte >= 32 && byte <= 126) return String.fromCharCode(byte);
    return `\\${byte.toString(8).padStart(3, "0")}`;
  }).join("");
  return `"${escaped}"`;
}

/** Decode one complete Git C-quoted path, including octal UTF-8 byte escapes. */
export function decodeGitPath(encoded: string): string | undefined {
  if (!encoded.startsWith("\"")) return encoded;
  if (!encoded.endsWith("\"")) return undefined;
  const bytes: number[] = [];
  const appendText = (text: string) => bytes.push(...Buffer.from(text, "utf8"));
  for (let index = 1; index < encoded.length - 1; index += 1) {
    const character = encoded[index];
    if (character !== "\\") {
      const codePoint = encoded.codePointAt(index);
      if (codePoint === undefined) return undefined;
      appendText(String.fromCodePoint(codePoint));
      if (codePoint > 0xffff) index += 1;
      continue;
    }
    index += 1;
    if (index >= encoded.length - 1) return undefined;
    const escape = encoded[index];
    const simpleEscapes: Record<string, number> = {
      a: 7,
      b: 8,
      t: 9,
      n: 10,
      v: 11,
      f: 12,
      r: 13,
      "\"": 34,
      "\\": 92,
    };
    if (simpleEscapes[escape] !== undefined) {
      bytes.push(simpleEscapes[escape]);
      continue;
    }
    if (/[0-7]/.test(escape)) {
      let octal = escape;
      while (octal.length < 3 && index + 1 < encoded.length - 1 && /[0-7]/.test(encoded[index + 1])) {
        index += 1;
        octal += encoded[index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    return undefined;
  }
  return Buffer.from(bytes).toString("utf8");
}

export function formatUnifiedDiffPath(pathname: string, side: "a" | "b"): string {
  return quoteGitPath(`${side}/${pathname}`);
}

/** Parse a `+++` header and return its repository-relative destination path. */
export function parseUnifiedDiffDestination(line: string): string | undefined {
  if (!line.startsWith("+++ ")) return undefined;
  const decoded = decodeGitPath(line.slice(4));
  if (!decoded || decoded === "/dev/null" || !decoded.startsWith("b/")) return undefined;
  return decoded.slice(2);
}

const TRUNCATED_STDOUT_MARKER = "[agent-framework: stdout truncated after";

/** Reject incomplete bounded Git stdout before parsing it. */
export function assertCompleteGitOutput(
  result: Pick<
    ProcessResult,
    | "output"
    | "exitCode"
    | "stdoutTruncated"
    | "stdoutInvalidUtf8"
    | "stderrTruncated"
    | "stderrInvalidUtf8"
  >,
  description: string,
  requireTrailingNul: boolean,
): void {
  if (result.exitCode !== 0) {
    const diagnostic = result.output.trim() || "no diagnostic output";
    throw new Error(`${description} failed with exit code ${result.exitCode}: ${diagnostic}`);
  }
  if (
    result.stdoutTruncated
    || result.stdoutInvalidUtf8
    || result.stderrTruncated
    || result.stderrInvalidUtf8
    || result.output.includes(TRUNCATED_STDOUT_MARKER)
    || (requireTrailingNul && result.output.length > 0 && !result.output.endsWith("\0"))
  ) {
    throw new Error(`${description} output was truncated or contained invalid UTF-8; cannot build complete review context.`);
  }
}

export function splitGitNulRecords(output: string): string[] {
  return output.split("\0").filter((record) => record.length > 0);
}

/** Validate bounded Git output and parse its complete NUL-delimited records. */
export function parseCompleteGitNulRecords(
  result: Parameters<typeof assertCompleteGitOutput>[0],
  description: string,
): string[] {
  assertCompleteGitOutput(result, description, true);
  return splitGitNulRecords(result.output);
}

export function formatRenameStatus(code: string, oldPath: string, newPath: string): string {
  return `${code} ${JSON.stringify(oldPath)} -> ${JSON.stringify(newPath)}`;
}

export function formatPorcelainStatusZ(output: string): string {
  const records = splitGitNulRecords(output);
  const lines: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const pathname = record.slice(3);
    if (code.includes("R") || code.includes("C")) {
      const oldPath = records[index + 1];
      if (oldPath !== undefined) {
        lines.push(formatRenameStatus(code, oldPath, pathname));
        index += 1;
        continue;
      }
    }
    lines.push(`${code} ${formatGitPathForContext(pathname)}`);
  }
  return lines.join("\n");
}
