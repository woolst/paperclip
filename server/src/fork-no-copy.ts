// Fork: Paperclip never copies files for a run. Every run works in the one real folder: on the Mac, or in a box
// through its mounts. The upstream functions that would copy are disabled where they are defined (each says
// "fork: no copy"); this guard refuses, before anything starts, every run that would reach one of them, and names
// what to change. It reads no company setting: it holds for every run.
import { projectWorkspaces, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { ConfigurationIncompleteFailure } from "./services/heartbeat/run-preparation.js";

type Rec = Record<string, unknown>;

/** The adapters Paperclip copies no file for: Claude through its mounts, a command in the folder, an HTTP call. */
export const NO_COPY_ADAPTERS = new Set(["claude_local", "process", "http"]);

export const NO_COPY_TEXT = {
  adapter: (type: string) =>
    `Paperclip never copies files for a run, and the ${type} adapter copies them; claude_local, process and http run here.`,
  driver: (driver: string) =>
    `A run works on the Mac or in a box through its mounts; an environment of the ${driver} driver copies files to its target.`,
  worktree: "A run works in the project's own folder: an isolated workspace or a git worktree is a second copy of the project.",
  clone: "A run works in the project's own folder: this project has a repository that Paperclip would clone for the run.",
  reuse: "A run works in the project's own folder: this task is bound to a git worktree, a second copy of the project.",
};

/** A repository's identity as the clone hook compares it (heartbeat/workspaces.ts prepareProjectRepositoryWorkspaces). */
function identity(url: string): string {
  return url.trim().replace(/\.git\/?$/, "").replace(/\/$/, "");
}

/** The folder Paperclip writes for a workspace with a repository and no folder of its own. */
const REPO_ONLY_CWD = "/__paperclip_repo_only__";

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function refuse(message: string): never {
  throw new ConfigurationIncompleteFailure(message, { provider: "fork", reason: "fork_no_copy" });
}

/**
 * The run guard, once the run's config is merged. A Claude run over SSH always works in its mounted folder, and every
 * Claude run uses the command-line engine (the ACP engine copies skill folders): both are set on the run's config,
 * whatever the agent or the task says. A run that would copy files is refused with one line.
 */
export async function forkNoCopyRun(db: Db, input: {
  adapterType: string;
  config: Rec;
  environmentDriver: string | null | undefined;
  workspaceMode: string | null | undefined;
  projectId: string | null | undefined;
  reusedStrategy?: string | null;
  companyId?: string | null;
}): Promise<void> {
  if (!NO_COPY_ADAPTERS.has(input.adapterType)) refuse(NO_COPY_TEXT.adapter(input.adapterType));
  const driver = input.environmentDriver || "local";
  if (driver !== "local" && driver !== "ssh") refuse(NO_COPY_TEXT.driver(driver));
  if (input.adapterType === "claude_local") {
    if (driver === "ssh") input.config.mountedBox = true;
    input.config.engine = "cli";
  }
  if (input.workspaceMode === "isolated_workspace" || rec(input.config.workspaceStrategy)?.type === "git_worktree") {
    refuse(NO_COPY_TEXT.worktree);
  }
  if (input.reusedStrategy === "git_worktree") refuse(NO_COPY_TEXT.reuse);
  if (!input.projectId || typeof (db as { select?: unknown }).select !== "function") return;
  // The clone hook's own rule: the run's anchor is the project's primary workspace; every other repository that
  // differs from the anchor's would be cloned, and a primary repository with no folder would be checked out.
  const where = input.companyId
    ? and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId))
    : eq(projectWorkspaces.projectId, input.projectId);
  const rows = await db.select({ cwd: projectWorkspaces.cwd, repoUrl: projectWorkspaces.repoUrl, isPrimary: projectWorkspaces.isPrimary })
    .from(projectWorkspaces).where(where);
  const primary = rows.find((row) => row.isPrimary) ?? rows[0];
  if (primary?.repoUrl && (!primary.cwd || primary.cwd === REPO_ONLY_CWD)) refuse(NO_COPY_TEXT.clone);
  const anchor = primary?.repoUrl ? identity(primary.repoUrl) : null;
  if (rows.some((row) => typeof row.repoUrl === "string" && row.repoUrl.length > 0 && identity(row.repoUrl) !== anchor)) {
    refuse(NO_COPY_TEXT.clone);
  }
}
