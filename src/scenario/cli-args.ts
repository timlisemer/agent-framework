export function getOptionalArg(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export function getRequiredArg(args: readonly string[], name: string): string {
  const value = getOptionalArg(args, name);
  if (value !== undefined) return value;
  console.error(`Error: --${name} is required`);
  process.exit(2);
}
