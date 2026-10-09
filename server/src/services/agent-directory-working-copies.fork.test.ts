import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as executionTargetTools from "@paperclipai/adapter-utils/execution-target";
import * as ssh from "@paperclipai/adapter-utils/ssh";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, authUsers, companyMemberships, principalPermissionGrants, heartbeatRuns, agentInstructionWorkingCopies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { agentInstructionWorkingCopyService } from "./agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "./agent-instructions.js";

// Fork: Paperclip never copies files for a run, so no run copies the agent folder: not into a box over
// SSH, not into a local working copy.
describe("no agent folder copy for any run", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let companyId: string, userId: string;
  const entryFile = "policy/INSTRUCTIONS.txt";
  const initial = "# Original\n";
  let spies: Record<"stage" | "restore" | "runtime" | "shell", ReturnType<typeof vi.spyOn>>;

  async function makeAgent(mountedBox: boolean) {
    const agentId = randomUUID();
    const root = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: {
      instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile, ...(mountedBox ? { mountedBox: true } : {}) } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), initial);
    return agentId;
  }
  async function newRun(agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    return runId;
  }
  // The SSH calls are spies, so the spec carries only what the upstream test does.
  const sshTarget = (): executionTargetTools.AdapterExecutionTarget => {
    const remoteCwd = path.join(home, `ssh-task-${randomUUID()}`);
    return { kind: "remote" as const, transport: "ssh" as const, environmentId: randomUUID(), remoteCwd,
      spec: { host: "unused.invalid", port: 22, username: "test", remoteCwd } } as unknown as executionTargetTools.AdapterExecutionTarget;
  };
  const rowsFor = (runId: string) => db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, runId));

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fork-agent-folder-copies-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("fork-agent-folder-copies-db-");
    db = createDb(database.connectionString);
    copies = agentInstructionWorkingCopyService(db);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) {
      const writable = async (dir: string) => {
        await fs.chmod(dir, 0o700);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
      };
      await writable(home);
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    companyId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fork copy tests", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    spies = {
      stage: vi.spyOn(ssh, "syncDirectoryToSsh").mockImplementation(async input => {
        await fs.mkdir(path.dirname(input.remoteDir), { recursive: true });
        await fs.cp(input.localDir, input.remoteDir, { recursive: true });
      }),
      restore: vi.spyOn(ssh, "restoreWorkspaceFromSshExecution").mockResolvedValue(undefined as never),
      runtime: vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime").mockResolvedValue({ assetDirs: {} } as never),
      shell: vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" } as never),
    };
  });
  afterEach(() => vi.restoreAllMocks());
  const noSpyCalled = () => {
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  };

  it("makes no copy for a mounted-box agent on an SSH target", async () => {
    const agentId = await makeAgent(true);
    const runId = await newRun(agentId);
    expect(await copies.prepare({ companyId, agentId, runId, cwd: home, target: sshTarget() })).toBeNull();
    noSpyCalled();
    expect(await rowsFor(runId)).toEqual([]);
  });

  it("stages nothing into the box after a run that saved native input", async () => {
    const agentId = await makeAgent(true);
    const runId = await newRun(agentId);
    const outcome = await copies.prepare({ companyId, agentId, runId, cwd: home, target: sshTarget(), legacy: true })
      .catch((error: unknown) => error);
    expect(spies.runtime).not.toHaveBeenCalled();
    expect(spies.stage).not.toHaveBeenCalled();
    expect(spies.restore).not.toHaveBeenCalled();
    expect(outcome).toBeNull();
  });

  it("makes no copy over SSH for an agent without a mounted box", async () => {
    const agentId = await makeAgent(false);
    const runId = await newRun(agentId);
    expect(await copies.prepare({ companyId, agentId, runId, cwd: home, target: sshTarget() })).toBeNull();
    noSpyCalled();
    expect(await rowsFor(runId)).toEqual([]);
  });

  for (const mountedBox of [true, false]) {
    it(`makes no local copy for an agent ${mountedBox ? "with" : "without"} a mounted box`, async () => {
      const agentId = await makeAgent(mountedBox);
      const runId = await newRun(agentId);
      expect(await copies.prepare({ companyId, agentId, runId, cwd: home })).toBeNull();
      expect(await rowsFor(runId)).toEqual([]);
      noSpyCalled();
    });
  }
});
