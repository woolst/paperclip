import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { forkNoCopyRun, NO_COPY_TEXT } from "./fork-no-copy.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

// A database stand-in that answers the project-workspace query with ROWS.
function dbWith(rows: Array<{ cwd: string | null; repoUrl: string | null; isPrimary?: boolean }>) {
  return { select: () => ({ from: () => ({ where: async () => rows }) }) } as never;
}

async function refusal(input: Parameters<typeof forkNoCopyRun>[1], db = dbWith([])) {
  return forkNoCopyRun(db, input).then(() => null, (error: unknown) => error as { name: string; message: string; resultJson: unknown });
}

const run = (over: Partial<Parameters<typeof forkNoCopyRun>[1]> = {}) => ({
  adapterType: "claude_local", config: {} as Record<string, unknown>, environmentDriver: "local",
  workspaceMode: null, projectId: null, ...over,
});

describe("the run guard: no run copies a file", () => {
  it("refuses every adapter but claude_local, process and http, in any company", async () => {
    for (const type of ["codex_local", "paperclip_runner", "gemini_local", "cursor", "acpx_local", "openclaw_gateway", "new_adapter"]) {
      const error = await refusal(run({ adapterType: type }));
      expect(error?.name).toBe("ConfigurationIncompleteFailure");
      expect(error?.message).toBe(NO_COPY_TEXT.adapter(type));
      expect(error?.resultJson).toEqual({ provider: "fork", reason: "fork_no_copy" });
    }
  });

  it("lets a command or an HTTP call run, which copies nothing, and leaves its config alone", async () => {
    for (const type of ["process", "http"]) {
      const config: Record<string, unknown> = {};
      expect(await refusal(run({ adapterType: type, environmentDriver: "ssh", config }))).toBeNull();
      expect(config).toEqual({});
    }
  });

  it("refuses an environment that copies to its target", async () => {
    for (const driver of ["sandbox", "kubernetes", "plugin"]) {
      expect((await refusal(run({ environmentDriver: driver })))?.message).toBe(NO_COPY_TEXT.driver(driver));
    }
  });

  it("puts every SSH run in its mounted box, whatever the agent or the task says", async () => {
    for (const mountedBox of [undefined, false, null, "true", 0]) {
      const config: Record<string, unknown> = { mountedBox };
      expect(await refusal(run({ environmentDriver: "ssh", config }))).toBeNull();
      expect(config.mountedBox).toBe(true);
    }
  });

  it("runs every run on the command-line engine, which copies no skill folder", async () => {
    for (const engine of [undefined, "acp", "cli"]) {
      const config: Record<string, unknown> = { engine };
      expect(await refusal(run({ config }))).toBeNull();
      expect(config.engine).toBe("cli");
    }
  });

  it("refuses an isolated workspace and a git worktree", async () => {
    expect((await refusal(run({ workspaceMode: "isolated_workspace" })))?.message).toBe(NO_COPY_TEXT.worktree);
    expect((await refusal(run({ config: { workspaceStrategy: { type: "git_worktree" } } })))?.message).toBe(NO_COPY_TEXT.worktree);
  });

  it("refuses a project whose repository Paperclip would clone", async () => {
    const two = dbWith([{ cwd: "/a", repoUrl: "https://example.test/a.git" }, { cwd: "/b", repoUrl: "https://example.test/b.git" }]);
    expect((await refusal(run({ projectId: "p" }), two))?.message).toBe(NO_COPY_TEXT.clone);
    const noFolder = dbWith([{ cwd: null, repoUrl: "https://example.test/a.git" }]);
    expect((await refusal(run({ projectId: "p" }), noFolder))?.message).toBe(NO_COPY_TEXT.clone);
    const inPlace = dbWith([{ cwd: "/a", repoUrl: "https://example.test/a.git" }, { cwd: "/notes", repoUrl: null }]);
    expect(await refusal(run({ projectId: "p" }), inPlace)).toBeNull();
  });

  it("follows the clone hook's rule: the primary workspace is the anchor, and any other repository is a clone", async () => {
    const sameRepoTwoWays = dbWith([{ cwd: "/a", repoUrl: "https://example.test/a.git", isPrimary: true }, { cwd: "/a2", repoUrl: "https://example.test/a/" }]);
    expect(await refusal(run({ projectId: "p", companyId: "c" }), sameRepoTwoWays)).toBeNull();
    const folderAnchor = dbWith([{ cwd: "/notes", repoUrl: null, isPrimary: true }, { cwd: "/a", repoUrl: "https://example.test/a.git" }]);
    expect((await refusal(run({ projectId: "p" }), folderAnchor))?.message).toBe(NO_COPY_TEXT.clone);
    const repoOnly = dbWith([{ cwd: "/__paperclip_repo_only__", repoUrl: "https://example.test/a.git", isPrimary: true }]);
    expect((await refusal(run({ projectId: "p" }), repoOnly))?.message).toBe(NO_COPY_TEXT.clone);
    const oneFolder = dbWith([{ cwd: "/Users/a/Projects/english-lessons", repoUrl: null, isPrimary: true }]);
    expect(await refusal(run({ projectId: "p" }), oneFolder)).toBeNull();
  });

  it("refuses a task still bound to a git worktree", async () => {
    expect((await refusal(run({ reusedStrategy: "git_worktree" })))?.message).toBe(NO_COPY_TEXT.reuse);
    expect(await refusal(run({ reusedStrategy: "project_primary" }))).toBeNull();
  });

  it("reads no company setting: the guard has no switch", async () => {
    const source = await fs.readFile(path.join(REPO, "server/src/fork-no-copy.ts"), "utf8");
    expect(source).not.toMatch(/process\.env|instanceSettings|experimental|getExperimental|companyRunsBoxes/);
  });
});

// Each upstream function that copies files starts with a line that throws, or returns before the copy. A rebase that
// moves code above the hook, or drops it, fails here.
const HOOKS: Array<[file: string, what: string, next: string]> = [
  ["packages/adapter-utils/src/acpx-engine/execute.ts", "a file copy in place of a link", "await fs.copyFile(source, target);"],
  ["packages/adapter-utils/src/acpx-engine/execute.ts", "a copied file", "if (await pathExists(target)) return;"],
  ["packages/adapter-utils/src/command-managed-runtime.ts", "prepareCommandManagedRuntime", "const timeoutMs = "],
  ["packages/adapter-utils/src/execution-target.ts", "startAdapterExecutionTargetPaperclipBridge", "const target = input.target;"],
  ["packages/adapter-utils/src/remote-managed-runtime.ts", "prepareRemoteManagedRuntime", "const baseWorkspaceRemoteDir = "],
  ["packages/adapter-utils/src/server-utils.ts", "materializePaperclipSkillCopy", "const sourceRoot = path.resolve(source);"],
  ["packages/adapter-utils/src/sandbox-managed-runtime.ts", "prepareSandboxManagedRuntime", "const workspaceRemoteDir = "],
  ["packages/adapter-utils/src/sandbox-managed-runtime.ts", "mirrorDirectory", "await fs.mkdir(targetDir, { recursive: true });"],
  ["packages/adapter-utils/src/sandbox-managed-runtime.ts", "createTarballFromDirectory", "const excludeArgs = "],
  ["packages/adapter-utils/src/ssh.ts", "syncDirectoryToSsh", "const auth = await createSshAuthArgs(input.spec);"],
  ["packages/adapter-utils/src/ssh.ts", "syncDirectoryFromSsh", "const auth = await createSshAuthArgs(input.spec);"],
  ["packages/adapter-utils/src/ssh.ts", "prepareWorkspaceForSshExecution", "const remoteDir = "],
  ["packages/adapter-utils/src/ssh.ts", "restoreWorkspaceFromSshExecution", "const remoteDir = "],
  ["packages/adapters/claude-local/src/server/claude-config.ts", "the Claude settings seed", "const sourceDir = "],
  ["packages/adapters/claude-local/src/server/claude-config.ts", "the Claude settings copy in a target", "return `mkdir -p "],
  ["packages/adapters/codex-local/src/server/codex-home.ts", "the seed of a managed Codex home", "const apiKey = "],
  ["packages/adapters/codex-local/src/server/device-login-export.ts", "a device login's credential copy", "const { sandboxAuthBytes, log } = input;"],
  ["packages/adapters/grok-local/src/server/grok-home.ts", "a copy of the Grok home", "const runIdPart = "],
  ["packages/adapters/opencode-local/src/server/runtime-config.ts", "a copy of the OpenCode settings", "const skipPermissions = "],
  ["server/src/routes/execution-workspaces.ts", "the repair of a development worktree, which reseeds it,", "type RepairPhase ="],
  ["server/src/services/agent-instructions.ts", "writing instructions into a new folder", "const exported = await exportFiles(agent);"],
  ["server/src/services/agent-instructions.ts", "a managed copy of an agent's instructions", "if (!db) throw unprocessable("],
  ["server/src/services/company-import-transfers.ts", "a package stored on the server for its import", "const target = partPathFor("],
  ["server/src/services/company-skills.ts", "a skill package written out for its audit", "const root = await fs.mkdtemp("],
  ["server/src/services/company-skills.ts", "a copy of a skill", "await ensureSkillInventoryCurrent(companyId);"],
  ["server/src/services/company-skills.ts", "a skill made from another skill", "const forkSource = input.forkedFromSkillId"],
  ["server/src/services/company-skills.ts", "a package skill written into the store", "const packageDir = "],
  ["server/src/services/company-skills.ts", "a catalog skill written into the store", "const catalogRoot = "],
  ["server/src/services/company-skills.ts", "a catalog snapshot written into the store", "const originsRoot = "],
  ["server/src/services/company-skills.ts", "a copy of a skill folder", "const { files } = await collectSkillFileBytes(sourceDir);"],
  ["server/src/services/company-skills.ts", "the per-run rewrite of a stored skill", "const runtimeRoot = "],
  ["server/src/services/company-skills.ts", "a skill version written as files", "const runtimeRoot = "],
  ["server/src/services/environment-run-orchestrator.ts", "a workspace provision command, which may copy,", "const realizedCwd ="],
  ["server/src/services/heartbeat/workspaces.ts", "the managed checkout's git clone", "const hasAdoptableGitDir = "],
  ["server/src/services/heartbeat/workspaces.ts", "a clone of the project's other repositories", "const root = path.join(input.cwd, PROJECT_REPOSITORIES_DIR);"],
  ["server/src/services/native-runtime/native-workspace-sync.ts", "the native workspace seed", "const target = input.target;"],
  ["server/src/services/native-runtime/native-workspace-sync.ts", "the native workspace sync back", "if (input.target.kind !== \"remote\""],
  ["server/src/services/native-runtime/runtime-context.ts", "a connector or runtime skill written out as a copy", "const sorted = "],
  ["server/src/services/runtime-skill-cache.ts", "the runtime cache of a stored skill", "if (await matches(spec))"],
  ["server/src/services/workspace-runtime.ts", "a git worktree", "const repoRoot = await resolveGitOwnerRepoRoot("],
  ["server/src/services/workspace-runtime.ts", "the reuse of a git worktree", "// Validate the base checkout"],
  ["server/src/services/workspace-runtime.ts", "the restore of a git worktree", "await fs.mkdir(path.dirname(worktreePath)"],
];
// The conditions a hook may hold: always, or the very case that copies.
const CONDITIONS = /^if \((!0|selected\.length > 0|input\.forkedFromSkillId|provisionCommand|existingFiles\.length === 0 \|\| !existingFiles\.includes\(nextEntryFile\))\) throw (new Error|unprocessable)\("Fork: Paperclip never copies files/;
const RETURNS: Array<[file: string, line: string, next: string]> = [
  ["server/src/services/agent-directory-working-copies.ts", "if (!0) return null; // fork: Paperclip never copies files for a run", "const [agent] = await db.select().from(agents)"],
  ["server/src/services/agent-directory-working-copies.ts", "if (!0) return row; // fork: no copy", "if (row.receipt?.retainedByRunId) return row;"],
  ["server/src/services/agent-instruction-working-copies.ts", "if (!0) return null; // fork: Paperclip never copies files for a run", "const existing = await get(input.companyId, input.runId);"],
  ["server/src/services/agent-instruction-working-copies.ts", "if (!0) return row; // fork: no copy", "if (isAgentDirectoryCopy(row)) return directories.collectStopped(row);"],
  ["server/src/services/agent-instruction-working-copies.ts", "if (!0) return 0; // fork: no copy", "const pending = await db.select().from(copies)"],
  ["server/src/services/agent-instruction-working-copies.ts", "if (!0) return 0; // fork: no copy", "const pending = await db.select({ copy: copies"],
  ["server/src/services/codex-auth-reconciliation.ts", "if (!0) return { scanned: 0, seeded: 0,", "const summary: CodexAuthReconciliationSummary = {"],
];
// The guard's rules where a path reaches an adapter or a registration outside a run.
const GUARDS: Array<[file: string, line: string]> = [
  ["server/src/routes/agents.ts", "if (!forkNoCopy.NO_COPY_ADAPTERS.has(type)) throw unprocessable(forkNoCopy.NO_COPY_TEXT.adapter(type)); // fork: no copy"],
  ["server/src/services/agent-environment-test.ts", "NO_COPY_ADAPTERS.has(providerAdapter)) throw unprocessable("],
  ["server/src/services/agent-environment-test.ts", "const ADAPTER_TEST_ALLOWED_ENVIRONMENT_DRIVERS = [\"local\", \"ssh\"]; // fork: no copy"],
  ["server/src/adapters/registry.ts", "if ([\"claude_local\", \"process\", \"http\"].includes(externalAdapter.type)) {"],
  ["server/src/adapters/registry.ts", "if ([\"claude_local\", \"process\", \"http\"].includes(adapter.type) && adaptersByType.has(adapter.type)) throw new Error("],
];

function nextLine(lines: string[], index: number): string {
  for (let i = index + 1; i < lines.length; i += 1) if (lines[i]!.trim()) return lines[i]!.trim();
  return "";
}

describe("the copy functions are disabled where they are defined", () => {
  for (const [file, what, next] of HOOKS) {
    it(`${file}: ${what}`, async () => {
      const lines = (await fs.readFile(path.join(REPO, file), "utf8")).split("\n");
      const index = lines.findIndex((line) => line.includes(`(${what} is disabled).`) && line.endsWith("// fork: no copy"));
      expect(index, `no hook for ${what}`).toBeGreaterThan(-1);
      expect(lines[index]!.trim()).toMatch(CONDITIONS);
      expect(nextLine(lines, index).startsWith(next), `${what}: the line after the hook is ${nextLine(lines, index)}`).toBe(true);
    });
  }
  for (const [file, line, next] of RETURNS) {
    it(`${file}: returns before the copy (${next.slice(0, 40)})`, async () => {
      const lines = (await fs.readFile(path.join(REPO, file), "utf8")).split("\n");
      const index = lines.findIndex((text, i) => text.trim().startsWith(line) && nextLine(lines, i).startsWith(next));
      expect(index, `no early return before ${next}`).toBeGreaterThan(-1);
    });
  }
  for (const [file, line] of GUARDS) {
    it(`${file}: ${line.slice(0, 60)}`, async () => {
      expect(await fs.readFile(path.join(REPO, file), "utf8")).toContain(line);
    });
  }
  it("holds no other hook and no hook that a setting can turn off", async () => {
    const files = [...new Set(HOOKS.map(([file]) => file))];
    let count = 0;
    for (const file of files) {
      for (const line of (await fs.readFile(path.join(REPO, file), "utf8")).split("\n")) {
        if (!/throw (new Error|unprocessable)\("Fork: Paperclip never copies files/.test(line)) continue;
        count += 1;
        expect(line.trim()).toMatch(CONDITIONS);
      }
    }
    expect(count).toBe(HOOKS.length);
  });
});
