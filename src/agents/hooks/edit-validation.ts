export type EditValidationToolInput = {
  content?: string;
  old_string?: string;
  new_string?: string;
};

export function formatProposedEdit(
  toolName: "Write" | "Edit",
  toolInput: EditValidationToolInput,
): string {
  return toolName === "Write"
    ? toolInput.content ?? ""
    : `old_string: ${toolInput.old_string ?? ""}\nnew_string: ${toolInput.new_string ?? ""}`;
}
