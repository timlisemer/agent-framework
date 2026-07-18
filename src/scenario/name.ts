import { z } from "zod";

export const scenarioNameSchema = z.string()
  .regex(/^[A-Za-z0-9._-]+$/, "must contain only letters, numbers, '.', '_', or '-'")
  .refine((name) => name !== "." && name !== "..", "must not be '.' or '..'");

export function isScenarioName(value: string): boolean {
  return scenarioNameSchema.safeParse(value).success;
}

export function requireScenarioName(value: string): string {
  const parsed = scenarioNameSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid scenario name: ${value}`);
  return parsed.data;
}

export function sanitizeScenarioName(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-");
  return isScenarioName(sanitized) ? sanitized : "scenario";
}
