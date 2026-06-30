export function removeHookByName(settings: Record<string, unknown>, hookName: string): void {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return;
  delete (hooks as Record<string, unknown>)[hookName];
}
