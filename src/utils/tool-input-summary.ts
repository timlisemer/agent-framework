/**
 * Summarize a tool call for LLM gate / appeal / error-acknowledge prompts.
 * Returns a conditional, per-tool representation containing only the fields
 * the judging LLM needs to decide alignment -- never raw file contents, raw
 * edit bodies, raw agent prompts, raw plan bodies, or raw option
 * descriptions. No truncation anywhere; strings that would be long are
 * summarized by {bytes, lines}.
 *
 * Output shape: `<ToolName>(key=value, key=value, ...)` -- call-like, not
 * JSON, so the LLM cannot pattern-match "incomplete JSON -> deny".
 *
 * Not for literal substring matching -- use `stringifyToolInput` from
 * prediction-types.ts for that.
 */

import { classifyBashCommand } from "./bash-command-policy.js";

type Dict = Record<string, unknown>;

function bytesAndLines(v: unknown): string {
  if (typeof v !== "string") return "non-string";
  if (v.length === 0) return "0 bytes / 0 lines";
  return `${v.length} bytes / ${v.split("\n").length} lines`;
}

function q(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

function kv(pairs: Array<[string, string | undefined]>): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export function summarizeToolInputForLlm(toolName: string, toolInput: unknown): string {
  const i = (toolInput ?? {}) as Dict;

  switch (toolName) {
    case "Bash": {
      const cmd = typeof i.command === "string" ? i.command : "";
      const classification = classifyBashCommand(cmd);
      return `Bash(${kv([
        ["command", q(cmd)],
        ["class", classification.riskClass],
        ["read_only", classification.readOnly ? "true" : "false"],
        ["prediction_identities", classification.predictionIdentities.join("|")],
        ["description", typeof i.description === "string" ? q(i.description) : undefined],
        ["timeout", typeof i.timeout === "number" ? String(i.timeout) : undefined],
        ["run_in_background", i.run_in_background === true ? "true" : undefined],
      ])})`;
    }
    case "Edit": {
      return `Edit(${kv([
        ["file_path", q(String(i.file_path ?? ""))],
        ["old_string", bytesAndLines(i.old_string)],
        ["new_string", bytesAndLines(i.new_string)],
        ["replace_all", i.replace_all === true ? "true" : undefined],
      ])})`;
    }
    case "MultiEdit": {
      const edits = Array.isArray(i.edits) ? i.edits as Dict[] : [];
      const per = edits.map((e, idx) =>
        `#${idx}:{old=${bytesAndLines(e.old_string)}, new=${bytesAndLines(e.new_string)}}`
      ).join(", ");
      return `MultiEdit(${kv([
        ["file_path", q(String(i.file_path ?? ""))],
        ["edits.length", String(edits.length)],
      ])}${per ? "; " + per : ""})`;
    }
    case "Write": {
      return `Write(${kv([
        ["file_path", q(String(i.file_path ?? ""))],
        ["content", bytesAndLines(i.content)],
      ])})`;
    }
    case "NotebookEdit": {
      return `NotebookEdit(${kv([
        ["notebook_path", q(String(i.notebook_path ?? ""))],
        ["cell_id", typeof i.cell_id === "string" ? q(i.cell_id) : undefined],
        ["cell_type", typeof i.cell_type === "string" ? q(i.cell_type) : undefined],
        ["edit_mode", typeof i.edit_mode === "string" ? q(i.edit_mode) : undefined],
        ["new_source", bytesAndLines(i.new_source)],
      ])})`;
    }
    case "Read": {
      return `Read(${kv([
        ["file_path", q(String(i.file_path ?? ""))],
        ["offset", typeof i.offset === "number" ? String(i.offset) : undefined],
        ["limit", typeof i.limit === "number" ? String(i.limit) : undefined],
        ["pages", typeof i.pages === "string" ? q(i.pages) : undefined],
      ])})`;
    }
    case "Glob": {
      return `Glob(${kv([
        ["pattern", typeof i.pattern === "string" ? q(i.pattern) : undefined],
        ["path", typeof i.path === "string" ? q(i.path) : undefined],
      ])})`;
    }
    case "Grep": {
      const scalarKeys = ["pattern", "path", "glob", "type", "output_mode", "head_limit",
                          "offset", "-i", "-n", "-A", "-B", "-C", "context", "multiline"];
      const pairs: Array<[string, string | undefined]> = scalarKeys.map((k) => {
        const v = i[k];
        if (v === undefined || v === null || v === "") return [k, undefined];
        return [k, typeof v === "string" ? q(v) : String(v)];
      });
      return `Grep(${kv(pairs)})`;
    }
    case "WebFetch": {
      return `WebFetch(${kv([
        ["url", q(String(i.url ?? ""))],
        ["prompt", bytesAndLines(i.prompt)],
      ])})`;
    }
    case "WebSearch": {
      return `WebSearch(${kv([
        ["query", q(String(i.query ?? ""))],
        ["allowed_domains", Array.isArray(i.allowed_domains) ? JSON.stringify(i.allowed_domains) : undefined],
        ["blocked_domains", Array.isArray(i.blocked_domains) ? JSON.stringify(i.blocked_domains) : undefined],
      ])})`;
    }
    case "Task":
    case "Agent": {
      return `${toolName}(${kv([
        ["subagent_type", typeof i.subagent_type === "string" ? q(i.subagent_type) : undefined],
        ["description", typeof i.description === "string" ? q(i.description) : undefined],
        ["prompt", bytesAndLines(i.prompt)],
      ])})`;
    }
    case "AskUserQuestion": {
      const qs = Array.isArray(i.questions) ? i.questions as Dict[] : [];
      const perQ = qs.map((qi, idx) => {
        const header = typeof qi.header === "string" ? qi.header : "";
        const question = typeof qi.question === "string" ? qi.question : "";
        const opts = Array.isArray(qi.options) ? qi.options as Dict[] : [];
        const labels = opts.map((o) => typeof o.label === "string" ? o.label : "").filter(Boolean).join(" | ");
        return `#${idx}:{header=${q(header)}, question=${q(question)}, options.length=${opts.length}${labels ? `, labels=${q(labels)}` : ""}}`;
      }).join(", ");
      return `AskUserQuestion(questions.length=${qs.length}${perQ ? "; " + perQ : ""})`;
    }
    case "TodoWrite": {
      const todos = Array.isArray(i.todos) ? i.todos as Dict[] : [];
      const hist: Record<string, number> = {};
      for (const t of todos) {
        const st = typeof t.status === "string" ? t.status : "unknown";
        hist[st] = (hist[st] ?? 0) + 1;
      }
      const histStr = Object.entries(hist).map(([k, v]) => `${k}=${v}`).join(", ");
      return `TodoWrite(todos.length=${todos.length}${histStr ? `, status={${histStr}}` : ""})`;
    }
    case "ExitPlanMode": {
      return `ExitPlanMode(plan=${bytesAndLines(i.plan)})`;
    }
    default: {
      if (toolName.startsWith("mcp__")) {
        const pairs: Array<[string, string | undefined]> = [];
        for (const [k, v] of Object.entries(i)) {
          if (v === null || v === undefined) continue;
          if (typeof v === "string") {
            pairs.push([k, v.length <= 300 ? q(v) : `{bytes: ${v.length}}`]);
          } else if (typeof v === "number" || typeof v === "boolean") {
            pairs.push([k, String(v)]);
          } else if (Array.isArray(v)) {
            pairs.push([k, `[${v.length}]`]);
          } else if (typeof v === "object") {
            pairs.push([k, "{object}"]);
          }
        }
        return `${toolName}(${kv(pairs)})`;
      }
      let raw: string;
      try { raw = JSON.stringify(toolInput); } catch { raw = "<unserializable>"; }
      return `${toolName}(${raw})`;
    }
  }
}

export function summarizeToolInputForUi(toolName: string, toolInput: unknown): {
  text: string;
  fields?: Record<string, string | number | boolean | null>;
} {
  const fields: Record<string, string | number | boolean | null> = {};
  if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
    for (const [key, value] of Object.entries(toolInput as Dict)) {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        fields[key] = value;
      }
    }
  }
  if (toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)) {
    const input = toolInput as Dict;
    if (toolName === "shell" && typeof input.command === "string") fields.command = input.command;
    if (toolName === "search" && typeof input.query === "string") fields.query = input.query;
    if (toolName === "runtime_item") {
      if (typeof input.itemType === "string") fields.itemType = input.itemType;
      if (typeof input.status === "string") fields.status = input.status;
    }
    if (toolName === "file_edit") {
      if (typeof input.path === "string") fields.path = input.path;
      if (typeof input.file_path === "string") fields.file_path = input.file_path;
      if (typeof input.files === "string") fields.files = input.files;
      if (typeof input.changeCount === "number") fields.changeCount = input.changeCount;
      if (Array.isArray(input.changes)) fields.changeCount = input.changes.length;
    }
    if (toolName === "mcp_tool" || toolName.startsWith("mcp__")) {
      if (typeof input.server === "string") fields.server = input.server;
      if (typeof input.tool === "string") fields.tool = input.tool;
      const args = input.arguments;
      if (args && typeof args === "object" && !Array.isArray(args)) {
        for (const [key, value] of Object.entries(args as Dict)) {
          if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            fields[key] = value;
          } else if (Array.isArray(value)) {
            fields[key] = value.length;
          }
        }
      }
    }
  }
  return {
    text: summarizeToolInputForLlm(toolName, toolInput),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}
