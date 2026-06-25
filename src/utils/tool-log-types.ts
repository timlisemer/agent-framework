export interface ToolLogEntry {
  ts: number;
  tool: string;
  toolUseId?: string;
  batchPosition?: number;
  batchSize?: number;
  path?: string;
  paths?: string[];
  cmd?: string;
  status: string;
  gate: string;
  reason?: string;
  ms: number;
}
