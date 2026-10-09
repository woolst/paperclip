// Fork: a company package is imported in place, and Paperclip keeps no copy of its files. Each agent's instructions
// stay in the package's folder (an external instructions bundle), and each skill stays in its own folder there (a
// local_path skill). The import names that folder on this Mac in source.localRoot; every file it sends must match the
// file there, byte for byte. An import whose package holds agents or skills without that folder is refused.
import fs from "node:fs/promises";
import path from "node:path";
import { unprocessable } from "./errors.js";

type FileEntry = string | { encoding: "base64"; data: string; contentType?: string | null };
type Rec = Record<string, unknown>;

export const IN_PLACE_TEXT = {
  noRoot: "Paperclip keeps no copy of a package's files: import the package from its folder on this Mac (source.localRoot).",
  badRoot: (root: string) => `The package folder must be an absolute folder on this Mac: ${root}.`,
  differs: (file: string) => `The package differs from its folder on this Mac: ${file}. Send the folder's files as they are.`,
  noEntry: (file: string) => `The agent's instruction file is not in the package folder: ${file}.`,
  agentSafe: "An in-place import is the board's: the agent-safe import route takes no package folder.",
  escapes: (file: string) => `A package file leads out of its folder through a symbolic link: ${file}.`,
};

function bytesOf(entry: FileEntry): Buffer {
  return typeof entry === "string" ? Buffer.from(entry, "utf8") : Buffer.from(entry.data, "base64");
}

/**
 * Whether a package holds agents or skills, which the import would otherwise write out as copies: by the parsed
 * manifest when there is one (an agent file may lie anywhere, e.g. a root AGENTS.md), else by the file names.
 */
export function packageHoldsAgentsOrSkills(files: Record<string, unknown>, manifest?: { agents?: unknown[]; skills?: unknown[] }): boolean {
  if ((manifest?.agents?.length ?? 0) > 0 || (manifest?.skills?.length ?? 0) > 0) return true;
  return Object.keys(files).some((file) => file.startsWith("agents/") || path.posix.basename(file).toLowerCase() === "skill.md"
    || path.posix.basename(file).toLowerCase() === "agents.md");
}

/**
 * The package's folder on this Mac, checked file by file, or null when the package holds no agent and no skill.
 * Refused: a package with agents or skills and no folder, a folder that is not absolute or not a folder, and a file
 * that differs from the folder's.
 */
export async function forkAssertInPlace(
  source: unknown, files: Record<string, unknown>, manifest?: { agents?: unknown[]; skills?: unknown[] }, mode?: string,
): Promise<string | null> {
  const given = source && typeof source === "object" ? (source as Rec) : {};
  const root = typeof given.localRoot === "string" ? given.localRoot : "";
  if (!root) {
    if (packageHoldsAgentsOrSkills(files, manifest)) throw unprocessable(IN_PLACE_TEXT.noRoot);
    return null;
  }
  if (mode === "agent_safe") throw unprocessable(IN_PLACE_TEXT.agentSafe);
  if (given.type !== "inline" || !path.isAbsolute(root) || !(await fs.stat(root).catch(() => null))?.isDirectory()) {
    throw unprocessable(IN_PLACE_TEXT.badRoot(root));
  }
  const real = await fs.realpath(root);
  const sent = (given.files ?? {}) as Record<string, FileEntry>;
  for (const [file, entry] of Object.entries(sent)) {
    const full = path.resolve(root, file);
    if (!full.startsWith(`${path.resolve(root)}${path.sep}`)) throw unprocessable(IN_PLACE_TEXT.differs(file));
    const target = await fs.realpath(full).catch(() => null);
    if (target && !target.startsWith(`${real}${path.sep}`)) throw unprocessable(IN_PLACE_TEXT.escapes(file));
    const onDisk = await fs.readFile(full).catch(() => null);
    if (!onDisk || !onDisk.equals(bytesOf(entry))) throw unprocessable(IN_PLACE_TEXT.differs(file));
  }
  return path.resolve(root);
}

/** Turns each skill read from the package into a local_path skill at its folder in the package. */
export function forkSkillsInPlace(
  skills: Array<{ packageDir?: string | null; sourceType: string; sourceLocator: string | null; sourceRef: string | null; metadata: Rec | null }>,
  localRoot: string | null | undefined,
): void {
  if (!localRoot) return;
  for (const skill of skills) {
    skill.sourceType = "local_path";
    skill.sourceLocator = path.resolve(localRoot, skill.packageDir ?? "");
    skill.sourceRef = null;
    skill.metadata = { ...(skill.metadata ?? {}), sourceKind: "local_path" };
  }
}

interface InstructionsService<A> {
  materializeManagedBundle(agent: A, files: Record<string, string>, options: Rec): Promise<{ adapterConfig: Rec }>;
  updateBundle(agent: A, input: { mode: "external"; rootPath: string; entryFile: string; clearLegacyPromptTemplate: boolean }): Promise<{ adapterConfig: Rec }>;
}

/**
 * The agent's instructions: in place, as an external bundle at the instruction file's folder in the package. Without
 * the package's folder the import has refused already (forkAssertInPlace); a managed bundle would be a copy.
 */
export async function forkInstructionsBundle<A>(
  localRoot: string | null,
  instructions: InstructionsService<A>,
  manifestPath: string,
  agent: A,
  files: Record<string, string>,
  options: Rec,
): Promise<{ adapterConfig: Rec }> {
  if (!localRoot) throw unprocessable(IN_PLACE_TEXT.noRoot);
  const file = path.resolve(localRoot, manifestPath);
  if (!file.startsWith(`${localRoot}${path.sep}`) || !(await fs.stat(file).catch(() => null))?.isFile()) {
    throw unprocessable(IN_PLACE_TEXT.noEntry(manifestPath));
  }
  return instructions.updateBundle(agent, {
    mode: "external", rootPath: path.dirname(file), entryFile: path.basename(file), clearLegacyPromptTemplate: true,
  });
}
