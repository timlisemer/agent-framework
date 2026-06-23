import {
  runImplementationValidatorOnly,
  runImplementationWorkflow,
  type ImplementationWorkflowInput,
  type ImplementationWorkflowOptions,
} from "./implementation-workflow.js";

export async function runImplementAgent(
  input: ImplementationWorkflowInput,
  options: ImplementationWorkflowOptions = {},
): Promise<string> {
  return runImplementationWorkflow(input, options);
}

export async function runValidateImplementationAgent(
  input: ImplementationWorkflowInput,
  options: ImplementationWorkflowOptions = {},
): Promise<string> {
  return runImplementationValidatorOnly(input, options);
}
