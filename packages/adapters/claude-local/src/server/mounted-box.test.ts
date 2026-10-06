import fs from "node:fs/promises";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

// The fake box: it answers only the box probe and the `claude` command. Every other SSH, scp or
// tar call, a workspace sync, a copy back or a file bridge fails the test.
const fake = vi.hoisted(() => {
  const state = { boxFolders: new Set<string>(), probes: [] as string[], unexpected: [] as string[] };
  const CLAUDE = "/usr/local/bin/claude";
  const fail = (what: string) => vi.fn(async () => { state.unexpected.push(what); throw new Error(`a box run must not call ${what}`); });
  const stream = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
    JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
  ].join("\n");
  return {
    state,
    CLAUDE,
    runChildProcess: vi.fn(async (_runId: string, command: string, args: string[], _options?: unknown): Promise<RunProcessResult> => {
      const line = [command, ...args].join(" ");
      if (!line.includes(CLAUDE)) { state.unexpected.push(line); throw new Error(`unexpected process: ${line}`); }
      const stdout = line.includes("--version") ? "2.1.284 (Claude Code)\n" : stream;
      return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 123, startedAt: new Date().toISOString() };
    }),
    runSshCommand: vi.fn(async (_spec: unknown, script: string) => {
      state.probes.push(script);
      if (script.startsWith("mkdir -p ")) return { stdout: "box-folder-present\n", stderr: "" };
      const folder = /^if \[ -d '([^']+)' \]/.exec(script)?.[1];
      if (!folder) { state.unexpected.push(`ssh ${script}`); throw new Error(`unexpected ssh command: ${script}`); }
      return { stdout: state.boxFolders.has(folder) ? "box-folder-present\n" : "box-folder-missing\n", stderr: "" };
    }),
    fail,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => ({
  ...(await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils")),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://root@box-one:22/srv :: claude"),
  runChildProcess: fake.runChildProcess,
}));
vi.mock("@paperclipai/adapter-utils/ssh", async () => ({
  ...(await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>("@paperclipai/adapter-utils/ssh")),
  runSshCommand: fake.runSshCommand,
  prepareWorkspaceForSshExecution: fake.fail("prepareWorkspaceForSshExecution"),
  syncDirectoryToSsh: fake.fail("syncDirectoryToSsh"),
  restoreWorkspaceFromSshExecution: fake.fail("restoreWorkspaceFromSshExecution"),
}));
vi.mock("@paperclipai/adapter-utils/execution-target", async () => ({
  ...(await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>("@paperclipai/adapter-utils/execution-target")),
  startAdapterExecutionTargetPaperclipBridge: fake.fail("startAdapterExecutionTargetPaperclipBridge"),
}));

import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";
import { BOX_REFUSALS, boxBundleMacDir, defaultBoxMountsPath, mapToBox, writeBoxBundle } from "./mounted-box.js";

const TOKEN = "mcp-secret-token-4711";
const AGENT_HOME = "/data/agent-homes/agent-1";
let root = "";
let macRoot = "";
let projectDir = "";
let macAgentHome = "";
let mountsFile = "";

function boxTarget(host = "box-one") {
  const spec = { host, port: 22, username: "root", remoteCwd: "/srv", privateKey: null, knownHosts: null, strictHostKeyChecking: false };
  return { kind: "remote", transport: "ssh", remoteCwd: "/srv", spec };
}

async function boxRun(over: { config?: Record<string, unknown>; context?: Record<string, unknown>; target?: unknown } = {}) {
  const logs: string[] = [];
  const metas: Array<Record<string, unknown>> = [];
  const result = await execute({
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Box Coder", adapterType: "claude_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      engine: "cli", command: fake.CLAUDE, mountedBox: true, boxMounts: mountsFile, ultracode: true,
      instructionsFilePath: path.join(root, "AGENTS.md"), env: { CLAUDE_CONFIG_DIR: "/root/.claude" },
      boxApiUrl: "http://10.0.2.2:3100", ...over.config,
    },
    context: over.context ?? { paperclipWorkspace: { cwd: projectDir, source: "project_primary", agentHome: macAgentHome } },
    executionTarget: (over.target === undefined ? boxTarget() : over.target) as never,
    runtimeMcp: { getServers: () => [{ name: "linear", url: "https://mcp.example/linear", connectionId: "conn-12345678", token: TOKEN }] } as never,
    onLog: async (_stream: string, chunk: string) => { logs.push(chunk); },
    onMeta: async (meta: unknown) => { metas.push(meta as Record<string, unknown>); },
  } as never);
  const claudeCall = fake.runChildProcess.mock.calls.find((call) => call[2].includes("--print"));
  return { result, logs, metas, args: claudeCall?.[2] ?? [], options: claudeCall?.[3] as Record<string, unknown> | undefined };
}

function flag(args: string[], name: string): string {
  return args[args.indexOf(name) + 1] ?? "";
}

async function expectRefused(run: Awaited<ReturnType<typeof boxRun>>, text: string) {
  expect(run.result.errorCode).toBe("fork_run_refused");
  expect(run.result.errorMessage).toBe(text);
  expect(run.logs).toContain(`[paperclip] ${text}\n`);
  expect(fake.runChildProcess).not.toHaveBeenCalled();
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paperclip-box-"));
  vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
  macRoot = path.join(root, "mac");
  projectDir = path.join(macRoot, "projects", "alpha");
  macAgentHome = path.join(macRoot, "agent-home");
  mountsFile = path.join(root, "mounts.json");
  await mkdir(projectDir, { recursive: true });
  await mkdir(macAgentHome, { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "Work in the box.\n", "utf8");
  await writeFile(mountsFile, JSON.stringify({ mounts: [
    { mac: macRoot, box: "/srv/mac", readOnly: true },
    { mac: path.join(macRoot, "projects"), box: "/srv/projects", readOnly: true },
  ] }), "utf8");
  fake.state.boxFolders = new Set(["/srv/projects/alpha"]);
});

afterEach(async () => {
  expect(fake.state.unexpected).toEqual([]);
  fake.state.probes = [];
  fake.state.unexpected = [];
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetClaudeCliCapabilitiesCacheForTests();
  await rm(root, { recursive: true, force: true });
});

describe("mounted box runs", () => {
  it("runs in the mapped folder with the bundle from the share, the MCP text and the box API, copying nothing", async () => {
    const run = await boxRun();
    expect(run.result.errorCode ?? null).toBeNull();
    expect(fake.state.probes).toEqual([
      `if [ -d '/srv/projects/alpha' ]; then mkdir -p '${AGENT_HOME}' && echo box-folder-present; else echo box-folder-missing; fi`,
    ]);
    const bundle = flag(run.args, "--add-dir");
    expect(bundle).toMatch(/^\/opt\/paperclip\/bundles\/company-1\/[0-9a-f]{64}$/);
    expect(flag(run.args, "--append-system-prompt-file")).toBe(`${bundle}/agent-instructions.md`);
    expect(JSON.parse(flag(run.args, "--mcp-config"))).toEqual({ mcpServers: { linear: {
      type: "http", url: "https://mcp.example/linear", headers: { Authorization: `Bearer ${TOKEN}` } } } });
    expect(run.args).toContain("--strict-mcp-config");
    const meta = run.metas[0] as { cwd: string; env: Record<string, string> };
    expect(meta.cwd).toBe("/srv/projects/alpha");
    expect(meta.env).toMatchObject({ AGENT_HOME, PAPERCLIP_API_URL: "http://10.0.2.2:3100" });
    expect((run.options?.env as Record<string, string>)).toMatchObject({ AGENT_HOME, PAPERCLIP_API_URL: "http://10.0.2.2:3100" });
    const macBundle = boxBundleMacDir("company-1", path.posix.basename(bundle));
    const instructions = await readFile(path.join(macBundle, "agent-instructions.md"), "utf8");
    expect(instructions).toContain("Work in the box.");
    expect(instructions).not.toContain(path.join(root, "AGENTS.md"));
    const prompt = String(run.options?.stdin ?? "");
    expect(prompt).toContain(`loaded from ${bundle}/agent-instructions.md. Resolve any relative file references from ${bundle}/. `);
    expect(prompt).not.toContain(path.join(root, "AGENTS.md"));
    expect(run.logs.join("")).toContain(
      `[paperclip] Box run on box-one in /srv/projects/alpha (Mac folder ${projectDir}), nothing copied: model `,
    );
    expect(run.logs.join("")).toMatch(/nothing copied: model \S+, effort \S+, ultracode on, thinking (on|off)\.\n/);
    expect(run.logs.join("")).not.toContain("Syncing workspace");
  });

  it("masks the MCP bearer token in the logged command", async () => {
    const run = await boxRun();
    const logged = (run.metas[0] as { commandArgs: string[] }).commandArgs.join(" ");
    expect(logged).toContain(TOKEN);
    const redactionPath = fileURLToPath(new URL("../../../../../server/src/redaction.ts", import.meta.url));
    const { redactSensitiveText } = (await import(redactionPath)) as { redactSensitiveText: (text: string) => string };
    expect(redactSensitiveText(logged)).not.toContain(TOKEN);
  });

  it("runs a task with no project in the agent's box home, made by one mkdir probe", async () => {
    const run = await boxRun({ context: { paperclipWorkspace: { cwd: macAgentHome, source: "agent_home", agentHome: macAgentHome } } });
    expect(run.result.errorCode ?? null).toBeNull();
    expect(fake.state.probes).toEqual([`mkdir -p '${AGENT_HOME}' && echo box-folder-present`]);
    expect((run.metas[0] as { cwd: string }).cwd).toBe(AGENT_HOME);
  });

  it("takes the share folder and the mount table from the agent's config", async () => {
    const otherTable = path.join(root, "other-mounts.json");
    await writeFile(otherTable, JSON.stringify({ mounts: [{ mac: projectDir, box: "/work/alpha", readOnly: true }] }), "utf8");
    fake.state.boxFolders = new Set(["/work/alpha"]);
    const run = await boxRun({ config: { boxShareDir: "/mnt/share", boxMounts: otherTable } });
    expect(flag(run.args, "--add-dir")).toMatch(/^\/mnt\/share\/bundles\/company-1\//);
    expect((run.metas[0] as { cwd: string }).cwd).toBe("/work/alpha");
  });

  it("refuses a folder missing in the box and makes nothing", async () => {
    fake.state.boxFolders = new Set();
    const run = await boxRun();
    await expectRefused(run, BOX_REFUSALS.notInBox("/srv/projects/alpha"));
    expect(fake.state.probes[0]).toMatch(/^if \[ -d '\/srv\/projects\/alpha' \]/);
    await expect(lstat(path.dirname(path.dirname(boxBundleMacDir("company-1", "k"))))).rejects.toThrow();
  });

  it("refuses a project task that fell back to the agent's Mac home and never runs there", async () => {
    const run = await boxRun({ context: { paperclipWorkspace: { cwd: macAgentHome, source: "project_primary", agentHome: macAgentHome } } });
    await expectRefused(run, BOX_REFUSALS.notMounted(macAgentHome));
    vi.clearAllMocks();
    fake.state.boxFolders.add("/srv/mac/agent-home");
    const copy = { cwd: macAgentHome, source: "project_primary", agentHome: "/other", agentHomeForPermissions: macAgentHome };
    await expectRefused(await boxRun({ context: { paperclipWorkspace: copy } }), BOX_REFUSALS.notMounted(macAgentHome));
    expect(fake.state.probes).toEqual([]);
  });

  it("refuses a folder no row maps", async () => {
    const outside = path.join(root, "elsewhere");
    await mkdir(outside, { recursive: true });
    const run = await boxRun({ context: { paperclipWorkspace: { cwd: outside, source: "project_primary" } } });
    await expectRefused(run, BOX_REFUSALS.notMounted(outside));
  });

  it("refuses a missing or malformed mount table", async () => {
    const missing = path.join(root, "missing.json");
    await expectRefused(await boxRun({ config: { boxMounts: missing } }), BOX_REFUSALS.badTable(missing));
    vi.clearAllMocks();
    await writeFile(mountsFile, JSON.stringify({ mounts: [{ mac: "relative", box: "/srv" }] }), "utf8");
    await expectRefused(await boxRun(), BOX_REFUSALS.badTable(mountsFile));
  });

  it("refuses an agent with no box environment and one without CLAUDE_CONFIG_DIR", async () => {
    await expectRefused(await boxRun({ target: null }), BOX_REFUSALS.noEnvironment);
    vi.clearAllMocks();
    await expectRefused(await boxRun({ config: { env: {} } }), BOX_REFUSALS.noConfigDir);
    expect(fake.state.probes).toEqual([]);
  });

  it("refuses a command over 120,000 bytes before any process starts", async () => {
    const run = await boxRun({ config: { extraArgs: ["--append-system-prompt", "x".repeat(130_000)] } });
    expect(run.result.errorMessage).toMatch(/^This run's command is too large to pass over SSH \(1[0-9]{2},[0-9]{3} bytes; the limit is 120,000\)\.$/);
    await expectRefused(run, run.result.errorMessage ?? "");
    expect(fake.state.probes).toEqual([]);
  });

  it("refuses a share that cannot be written", async () => {
    const shareRoot = path.dirname(path.dirname(path.dirname(boxBundleMacDir("company-1", "k"))));
    await mkdir(path.dirname(shareRoot), { recursive: true });
    await writeFile(shareRoot, "not a folder", "utf8");
    const run = await boxRun();
    expect(run.result.errorMessage).toMatch(/^The Paperclip share cannot be written: /);
    expect(run.result.errorMessage).toContain(path.join(shareRoot, "bundles", "company-1"));
    await expectRefused(run, run.result.errorMessage ?? "");
  });

  // Settled on this Mac: a box run makes /data/agent-homes, which macOS's sealed system volume
  // refuses, so the local sshd fixture (startSshEnvLabFixture) cannot hold a box. The box check
  // after the restart covers the end-to-end run.
  it.skip("runs a box run end to end over the local sshd fixture (skipped: /data cannot be made on macOS)", () => {});
});

describe("box bundle and mount table", () => {
  it("writes a bundle once, beside and then renamed, with each link resolved to its files", async () => {
    const source = path.join(root, "cache", "bundle-key");
    const skill = path.join(root, "skills", "paperclip");
    await mkdir(path.join(source, ".claude", "skills"), { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "# Paperclip\n", "utf8");
    await writeFile(path.join(source, "agent-instructions.md"), "Instructions.\n", "utf8");
    await symlink(skill, path.join(source, ".claude", "skills", "paperclip"));
    const target = path.join(root, "share", "bundles", "company-1", "bundle-key");
    const rename = vi.spyOn(fs, "rename");
    expect(await writeBoxBundle(source, target)).toBe(true);
    expect(rename).toHaveBeenCalledTimes(1);
    const [from, to] = rename.mock.calls[0] as [string, string];
    expect(path.dirname(from)).toBe(path.dirname(target));
    expect(to).toBe(target);
    expect(await readdir(path.dirname(target))).toEqual(["bundle-key"]);
    const copied = path.join(target, ".claude", "skills", "paperclip");
    expect((await lstat(copied)).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(copied, "SKILL.md"), "utf8")).toBe("# Paperclip\n");
    await writeFile(path.join(target, "marker"), "kept", "utf8");
    expect(await writeBoxBundle(source, target)).toBe(false);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(target, "marker"), "utf8")).toBe("kept");
  });

  it("maps by the longest matching Mac folder, below folders included", () => {
    const rows = [{ mac: "/Users/a", box: "/srv/a" }, { mac: "/Users/a/projects", box: "/srv/p" }];
    expect(mapToBox(rows, "/Users/a/projects/x/y")).toBe("/srv/p/x/y");
    expect(mapToBox(rows, "/Users/a/notes")).toBe("/srv/a/notes");
    expect(mapToBox(rows, "/Users/a")).toBe("/srv/a");
    expect(mapToBox(rows, "/Users/ab")).toBeNull();
    expect(mapToBox([{ mac: "/Users/a", box: "/srv/a/" }], "/Users/a")).toBe("/srv/a");
  });

  it("finds the default mount table from the account record, never HOME", () => {
    vi.stubEnv("HOME", "/tmp/not-home");
    expect(defaultBoxMountsPath()).toBe(
      path.join(os.userInfo().homedir, "Library", "Application Support", "boxes", "mounts.json"),
    );
  });
});
