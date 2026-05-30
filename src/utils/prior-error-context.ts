export type PriorErrorSource =
  | "stop-feedback"
  | "plan-validation"
  | "tool-denial"
  | "tool-failure";

export interface PriorErrorContext {
  source: PriorErrorSource;
  provenance: ReadonlyArray<"transcript" | "tool-log">;
  gate?: string;
  tool?: string;
  toolUseId?: string;
  text: string;
  index?: number;
  ts?: number;
  isError?: boolean;
}
