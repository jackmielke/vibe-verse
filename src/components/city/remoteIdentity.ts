export function buildRemotePilot<T>(characterId: string, factory: (accent: undefined, designId: string) => T): T {
  return factory(undefined, characterId);
}

export function remoteName(incoming: unknown, previous = "pilot"): string {
  return typeof incoming === "string" && incoming.trim() ? incoming.trim().slice(0, 32) : previous;
}