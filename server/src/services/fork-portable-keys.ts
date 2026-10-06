// Fork (commit 3): the company export keeps the false values of the fork's adapter keys.
//
// The export prunes default-like values with `dropFalseBooleans`, so `thinking: false` and
// `autoMemory: false` would never reach the package, and an imported agent would run with
// thinking or auto-memory on. One hook line after that prune puts them back.

export const FORK_FALSE_KEPT_KEYS = ["ultracode", "thinking", "autoMemory"] as const;

/** Copies each fork key whose value is false in `source` into `portable`, and returns `portable`. */
export function keepForkFalseKeys(
  source: unknown,
  portable: Record<string, unknown>,
): Record<string, unknown> {
  if (!source || typeof source !== "object") return portable;
  const config = source as Record<string, unknown>;
  for (const key of FORK_FALSE_KEPT_KEYS) {
    if (config[key] === false) portable[key] = false;
  }
  return portable;
}
