/**
 * File-mutating tool taxonomy shared by rules, drift detection, and slash
 * command repair workflows.
 */
export type TextEditToolName = "Edit" | "MultiEdit" | "Write";
export type ReplacementTextEditToolName = Exclude<TextEditToolName, "Write">;
export type TextEditReplacement = {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export const TEXT_EDIT_TOOL_NAMES: readonly TextEditToolName[] = [
  "Edit",
  "MultiEdit",
  "Write",
];

export const EDIT_TOOL_NAMES: readonly string[] = [
  ...TEXT_EDIT_TOOL_NAMES,
  "NotebookEdit",
];

export const TEXT_EDIT_TOOL_NAMES_DISPLAY = formatToolNameList(TEXT_EDIT_TOOL_NAMES);
export const EDIT_TOOL_NAMES_DISPLAY = formatToolNameList(EDIT_TOOL_NAMES);

export function isEditToolName(toolName: string): boolean {
  return EDIT_TOOL_NAMES.includes(toolName);
}

export function isTextEditToolName(toolName: string): toolName is TextEditToolName {
  return TEXT_EDIT_TOOL_NAMES.includes(toolName as TextEditToolName);
}

export function isReplacementTextEditToolName(toolName: string): toolName is ReplacementTextEditToolName {
  return toolName === "Edit" || toolName === "MultiEdit";
}

export function textEditReplacements(toolName: string, toolInput: unknown): TextEditReplacement[] | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const input = toolInput as Record<string, unknown>;
  if (toolName === "Edit") {
    return [{
      old_string: typeof input.old_string === "string" ? input.old_string : "",
      new_string: typeof input.new_string === "string" ? input.new_string : "",
      replace_all: input.replace_all === true,
    }];
  }
  if (toolName === "MultiEdit") {
    if (!Array.isArray(input.edits)) return null;
    const replacements = input.edits
      .filter((edit): edit is Record<string, unknown> => typeof edit === "object" && edit !== null)
      .map((edit) => ({
        old_string: typeof edit.old_string === "string" ? edit.old_string : "",
        new_string: typeof edit.new_string === "string" ? edit.new_string : "",
        replace_all: edit.replace_all === true,
      }));
    return replacements.length > 0 ? replacements : null;
  }
  return null;
}

export function applyTextEditReplacements(
  currentContent: string | null,
  toolName: string,
  toolInput: unknown,
): string | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const input = toolInput as Record<string, unknown>;
  if (toolName === "Write") return typeof input.content === "string" ? input.content : "";
  const replacements = textEditReplacements(toolName, toolInput);
  if (!replacements) return null;
  return replacements.reduce(
    (content, edit) => applyTextEditReplacement(content, edit),
    currentContent ?? "",
  );
}

export function formatTextEditReplacements(toolName: string, toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const input = toolInput as Record<string, unknown>;
  if (toolName === "Write") return typeof input.content === "string" ? input.content : "";
  const replacements = textEditReplacements(toolName, toolInput);
  if (!replacements) return "";
  if (toolName === "MultiEdit") {
    return replacements
      .map((edit, index) => [
        `edit ${index + 1}:`,
        `old_string: ${edit.old_string}`,
        `new_string: ${edit.new_string}`,
      ].join("\n"))
      .join("\n\n");
  }
  const [edit] = replacements;
  return edit ? `old_string: ${edit.old_string}\nnew_string: ${edit.new_string}` : "";
}

// Repair slash commands work on ordinary text-file edits. NotebookEdit is
// intentionally excluded because notebook cell edits need explicit user intent.
export const WRITE_REPAIR_TOOL_NAMES: readonly string[] = TEXT_EDIT_TOOL_NAMES;

function applyTextEditReplacement(content: string, edit: TextEditReplacement): string {
  if (!edit.replace_all || edit.old_string === "") {
    return content.replace(edit.old_string, edit.new_string);
  }
  return content.split(edit.old_string).join(edit.new_string);
}

function formatToolNameList(toolNames: readonly string[]): string {
  if (toolNames.length <= 1) return toolNames.join("");
  const last = toolNames[toolNames.length - 1] ?? "";
  if (toolNames.length === 2) return `${toolNames[0] ?? ""} or ${last}`;
  return `${toolNames.slice(0, -1).join(", ")}, or ${last}`;
}
