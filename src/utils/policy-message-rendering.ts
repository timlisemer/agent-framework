import { activeSpec } from "../adapter/spec.js";

export function renderCheckMcpAction(): string {
  return `You must run ${activeSpec().renderCheckMcpHint()}`;
}

export function renderGitWorkflowAlternative(): string {
  const spec = activeSpec();
  const commit = spec.renderWorkflowInvocation("commit");
  const push = spec.renderWorkflowInvocation("push");
  const quickpush = spec.renderWorkflowInvocation("quickpush");
  return `Use workflow tools (${commit}, ${push}, or ${quickpush})`;
}
