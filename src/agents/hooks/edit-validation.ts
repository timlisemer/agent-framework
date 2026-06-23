import { formatTextEditReplacements, type TextEditToolName } from "../../utils/edit-tools.js";

export type EditValidationToolInput = {
  content?: string;
  old_string?: string;
  new_string?: string;
  edits?: Array<{
    old_string?: string;
    new_string?: string;
  }>;
};

export function formatProposedEdit(
  toolName: TextEditToolName,
  toolInput: EditValidationToolInput,
): string {
  return formatTextEditReplacements(toolName, toolInput);
}
