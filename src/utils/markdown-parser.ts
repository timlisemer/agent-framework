/**
 * Generic markdown section extraction utilities.
 */

/**
 * Finds a `## {heading}` section in markdown content and returns its body,
 * trimmed. Returns an empty string if the section is not found.
 */
export function readMarkdownSection(content: string, heading: string): string {
  const lines = content.split("\n");
  const marker = `## ${heading}`;
  let inside = false;
  const collected: string[] = [];

  for (const line of lines) {
    if (!inside) {
      if (line.trim() === marker) {
        inside = true;
      }
      continue;
    }

    if (line.startsWith("## ")) {
      break;
    }

    collected.push(line);
  }

  return collected.join("\n").trim();
}
