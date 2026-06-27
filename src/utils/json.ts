export function jsonBigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function jsonStringifyWithBigint(value: unknown): string {
  return JSON.stringify(value, jsonBigintReplacer) ?? "undefined";
}
