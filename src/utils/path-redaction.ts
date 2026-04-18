/**
 * Redacts path-like tokens from a command string prior to scanning by regex
 * patterns whose semantics only concern the command verb (not its arguments).
 *
 * Note to future authors: the placeholder `<PATH>` is chosen because `<` and `>`
 * are non-word characters (preserving \b boundaries) and the literal `<PATH>`
 * appears in no BLACKLIST regex. If you add a pattern that matches `<` or `>`
 * or the substring `path` AND opts into redactPaths, this placeholder will
 * interfere — either tighten your regex to require surrounding whitespace or
 * change the placeholder globally.
 */

const PATH_EXTENSION = /\.[A-Za-z0-9]{1,8}(?:$|[:,;])/;
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/;

function isPathToken(tok: string): boolean {
  if (tok.length === 0) return false;
  if (tok.startsWith("-")) return false;               // CLI flag
  if (tok.includes("/")) return true;                  // rule 1
  if (tok.startsWith("~")) return true;                // rule 2
  if (tok.startsWith("@") && tok.length > 1) return true; // rule 3
  if (tok.includes("\\")) return true;                 // rule 4 (Windows)
  if (DRIVE_LETTER.test(tok)) return true;             // rule 4 (drive)
  if (PATH_EXTENSION.test(tok)) return true;           // rule 5
  if (tok.indexOf("-") > 0) return true;               // rule 6 (internal hyphen)
  return false;
}

export function redactPathTokens(input: string): string {
  if (input.length === 0) return input;
  // split on whitespace, preserving separators as odd-indexed chunks
  const parts = input.split(/(\s+)/);
  for (let i = 0; i < parts.length; i++) {
    // whitespace chunks pass through; token chunks get classified
    if (/^\s+$/.test(parts[i])) continue;
    if (isPathToken(parts[i])) parts[i] = "<PATH>";
  }
  return parts.join("");
}
