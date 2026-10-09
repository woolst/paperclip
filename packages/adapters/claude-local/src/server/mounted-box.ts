// Fork box runs (fork commit 6): a run on an SSH box works in the box's mounted folder and
// copies nothing over SSH. Adapter config keys, read at every run:
// - mountedBox (true or absent); boxApiUrl (absent: http://127.0.0.1:3100);
// - boxMounts: the mount table; absent: <account home>/Library/Application Support/boxes/mounts.json,
//   the home from the account record, never HOME;
// - boxShareDir: the box folder of the read-only Paperclip share; absent: /opt/paperclip.
// Mount table: {"mounts": [{"mac": "<absolute Mac folder>", "box": "<absolute box folder>",
// "readOnly": true}]}; the longest matching Mac folder wins; readOnly is not read. A task with no
// project runs in /data/agent-homes/<agent id>. Nothing is copied: the instructions go inline, and each skill is a
// link to its own folder as the box sees it, under <instance>/box-share/bundles/<companyId>/<key>/, in the box
// <boxShareDir>/bundles/. A skill whose folder is in no box is left out and named in the run log.
// A refused run ends before any process starts, with error code fork_run_refused.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { PreparedAdapterExecutionTargetRuntime, readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runSshCommand } from "@paperclipai/adapter-utils/ssh";
import { asString, parseObject, resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { FORK_RUN_REFUSED, forkEffortRule, forkSettingsText } from "./fork-run-args.js";
import type { ClaudePromptBundle } from "./prompt-cache.js";

type Target = ReturnType<typeof readAdapterExecutionTarget>;
type SshSpec = Parameters<typeof runSshCommand>[0];
type McpServer = ReturnType<NonNullable<AdapterExecutionContext["runtimeMcp"]>["getServers"]>[number];
type RunLog = AdapterExecutionContext["onLog"];

export const BOX_AGENT_HOMES = "/data/agent-homes";
export const BOX_SHARE_DIR_DEFAULT = "/opt/paperclip";
export const BOX_API_URL_DEFAULT = "http://127.0.0.1:3100";
export const BOX_SSH_COMMAND_LIMIT = 120_000;

export const BOX_REFUSALS = {
  noEnvironment: "This agent runs in a box but has no box environment. Bind it to its box environment.",
  noConfigDir: "A box agent must set CLAUDE_CONFIG_DIR to /root/.claude in its environment values.",
  notMounted: (macFolder: string) => `This folder is not mounted in the box: ${macFolder}. Add it to the box mount table.`,
  notInBox: (boxFolder: string) => `This folder is not in the box yet: ${boxFolder}. The boxes are remade after each change to the mount table.`,
  badTable: (file: string) => `The box mount table cannot be read: ${file}.`,
  noShare: (folder: string) => `The Paperclip share cannot be written: ${folder}.`,
  tooLarge: (bytes: number) =>
    `This run's command is too large to pass over SSH (${bytes.toLocaleString("en-US")} bytes; the limit is 120,000).`,
};

export interface BoxMount {
  mac: string;
  box: string;
}

export interface BoxRun {
  plan: PreparedAdapterExecutionTargetRuntime;
  agentHome: string;
  apiUrl: string;
  /** The MCP config as JSON text for `--mcp-config`, or null when no server exists. */
  mcpText: string | null;
  /** Sets AGENT_HOME and PAPERCLIP_API_URL for the box, after upstream's workspace refresh. */
  applyEnv(env: Record<string, string>, loggedEnv: Record<string, string>): void;
  /** Turns the Mac's instruction file and folder into the box's in a run prompt's text; upstream names them there. */
  mapText(text: string): string;
}

async function refuse(onLog: RunLog, text: string): Promise<AdapterExecutionResult> {
  await onLog("stderr", `[paperclip] ${text}\n`);
  return {
    exitCode: 1, signal: null, timedOut: false, errorCode: FORK_RUN_REFUSED, errorMessage: text,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false);
}

/** The default mount table, under the home folder the account record gives. */
export function defaultBoxMountsPath(): string {
  return path.join(os.userInfo().homedir, "Library", "Application Support", "boxes", "mounts.json");
}

/** The rows of the mount table, or null when the file is missing or not of the format. */
export async function readBoxMounts(file: string): Promise<BoxMount[] | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
  const mounts = (parsed as { mounts?: unknown } | null)?.mounts;
  if (!Array.isArray(mounts)) return null;
  const rows: BoxMount[] = [];
  for (const row of mounts) {
    const { mac, box } = (row ?? {}) as { mac?: unknown; box?: unknown };
    if (typeof mac !== "string" || !path.isAbsolute(mac) || typeof box !== "string" || !box.startsWith("/")) return null;
    rows.push({ mac: path.resolve(mac), box: path.posix.normalize(box) });
  }
  return rows;
}

/** The box folder of a Mac folder by the longest matching row, or null when none matches. */
export function mapToBox(rows: BoxMount[], macFolder: string): string | null {
  const folder = path.resolve(macFolder);
  let best: BoxMount | null = null;
  for (const row of rows) {
    const prefix = row.mac.endsWith(path.sep) ? row.mac : `${row.mac}${path.sep}`;
    if (folder !== row.mac && !folder.startsWith(prefix)) continue;
    if (!best || row.mac.length > best.mac.length) best = row;
  }
  if (!best) return null;
  const rest = path.relative(best.mac, folder).split(path.sep).filter(Boolean);
  return path.posix.resolve(best.box, ...rest);
}

/** The MCP config text, built as writePaperclipClaudeMcpConfig builds its file. */
export function boxMcpText(servers: McpServer[]): string | null {
  if (servers.length === 0) return null;
  const usedNames = new Set<string>();
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    let name = server.name;
    if (usedNames.has(name)) name = `${name}-${server.connectionId.slice(0, 8)}`;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${server.name}-${server.connectionId.slice(0, 8)}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    mcpServers[name] = {
      type: "http",
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
    };
  }
  return JSON.stringify({ mcpServers });
}

/** Bytes of the `sh -c` argument as buildSshSpawnTarget builds it for this command. */
export function boxSshCommandBytes(input: {
  remoteCwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}): number {
  const envArgs = Object.entries(input.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  const parts = [shellQuote(input.command), ...input.args.map((arg) => shellQuote(arg))].join(" ");
  const remoteScript = [
    'if [ -f /etc/profile ]; then . /etc/profile >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.profile" ]; then . "$HOME/.profile" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile" >/dev/null 2>&1 || true; elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc" >/dev/null 2>&1 || true; fi',
    'if [ -f "$HOME/.zprofile" ]; then . "$HOME/.zprofile" >/dev/null 2>&1 || true; fi',
    `cd ${shellQuote(input.remoteCwd)}`,
    envArgs.length > 0 ? `exec env ${envArgs.join(" ")} ${parts}` : `exec ${parts}`,
  ].join(" && ");
  return Buffer.byteLength(`sh -c ${shellQuote(remoteScript)}`, "utf8");
}

/** The Mac folder of the Paperclip share, under the instance root as the prompt cache finds it. */
export function boxShareMacDir(env: NodeJS.ProcessEnv = process.env): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME), instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID), env,
  });
  return path.join(instanceRoot, "box-share");
}

/** A skill of the prompt bundle: its name and the box folder its link points at, or null when no box has it. */
export interface BoxSkillLink {
  name: string;
  macFolder: string;
  boxFolder: string | null;
}

/**
 * The skills of a prompt bundle (its .claude/skills links), each mapped to its folder in the box by its real path, so
 * a skill folder that is itself a link to a folder in no box is left out, never linked to a path that cannot resolve.
 */
export async function boxSkillLinks(sourceDir: string, rows: BoxMount[]): Promise<BoxSkillLink[]> {
  const home = path.join(sourceDir, ".claude", "skills");
  const names = (await fs.readdir(home).catch(() => [] as string[])).sort();
  const realRows = await Promise.all(rows.map(async (row) => ({ ...row, mac: await fs.realpath(row.mac).catch(() => row.mac) })));
  const links: BoxSkillLink[] = [];
  for (const name of names) {
    const entry = path.join(home, name);
    const macFolder = path.resolve(home, await fs.readlink(entry).catch(() => name));
    const real = await fs.realpath(entry).catch(() => null);
    links.push({ name, macFolder, boxFolder: real ? mapToBox(realRows, real) : null });
  }
  return links;
}

/** The bundle's key in the share: the prompt bundle's key and the links it holds. */
export function boxBundleKey(bundleKey: string, links: BoxSkillLink[]): string {
  const list = links.filter((link) => link.boxFolder).map((link) => `${link.name}\t${link.boxFolder}`).join("\n");
  return `${bundleKey}-${createHash("sha256").update(list).digest("hex").slice(0, 16)}`;
}

/**
 * Writes the box bundle as links: .claude/skills/<name> points at the skill's box folder. Nothing is copied. The
 * links are made in a folder beside the target, which is then renamed into place; a target that exists stays.
 * True when written.
 */
export async function linkBoxBundle(links: BoxSkillLink[], target: string): Promise<boolean> {
  if (await exists(target)) return false;
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.mkdir(path.join(temp, ".claude", "skills"), { recursive: true });
    for (const link of links) {
      if (link.boxFolder) await fs.symlink(link.boxFolder, path.join(temp, ".claude", "skills", link.name));
    }
    await fs.rename(temp, target);
    return true;
  } catch (err) {
    if (await exists(target)) return false;
    throw err;
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The run prompt's line that names the instruction file, with the Mac paths turned into the box's. */
export function boxInstructionsText(text: string, macFile: string, rows: BoxMount[]): string {
  if (!text || !macFile) return text;
  const boxFile = mapToBox(rows, macFile);
  if (!boxFile) {
    return `Agent instructions for this run are in the system prompt. Their folder on the Mac, ${path.dirname(macFile)}/, ` +
      "is in no box, so sibling instruction files cannot be read in this run.";
  }
  return text.split(macFile).join(boxFile).split(`${path.dirname(macFile)}/`).join(`${path.posix.dirname(boxFile)}/`);
}

/** One SSH probe: makes the agent-home folder and checks the mapped folder; makes no mapped folder. */
async function probeBox(spec: SshSpec, agentHome: string, boxFolder: string): Promise<boolean> {
  const script = boxFolder === agentHome
    ? `mkdir -p ${shellQuote(agentHome)} && echo box-folder-present`
    : `if [ -d ${shellQuote(boxFolder)} ]; then mkdir -p ${shellQuote(agentHome)} && echo box-folder-present; else echo box-folder-missing; fi`;
  const result = await runSshCommand(spec, script);
  const stdout = (result as { stdout?: unknown }).stdout;
  return typeof stdout === "string" && stdout.includes("box-folder-present");
}

/** The box plan of a mountedBox run, its refusal, or null when the agent is not a box agent. */
export async function forkMountedBox(input: {
  ctx: Pick<AdapterExecutionContext, "agent" | "config" | "context" | "onLog">;
  target: Target;
  cwd: string;
  command: string;
  env: Record<string, string>;
  extraArgs: string[];
  model: string;
  effort: string;
  promptBundle: ClaudePromptBundle;
  servers: McpServer[];
}): Promise<BoxRun | AdapterExecutionResult | null> {
  const { ctx, target, promptBundle } = input;
  const { config, onLog } = ctx;
  if (config.mountedBox !== true) return null;
  const spec = target?.kind === "remote" && target.transport === "ssh"
    ? (target as unknown as { spec?: SshSpec & { host?: string } }).spec
    : undefined;
  if (!spec) return refuse(onLog, BOX_REFUSALS.noEnvironment);
  if (!asString(parseObject(config.env).CLAUDE_CONFIG_DIR, "").trim()) {
    return refuse(onLog, BOX_REFUSALS.noConfigDir);
  }

  const agentHome = path.posix.join(BOX_AGENT_HOMES, ctx.agent.id);
  const workspace = parseObject(ctx.context.paperclipWorkspace);
  const macFolder = path.resolve(input.cwd);
  const shareDir = asString(config.boxShareDir, "").trim() || BOX_SHARE_DIR_DEFAULT;
  const file = asString(config.boxMounts, "").trim() || defaultBoxMountsPath();
  const table = await readBoxMounts(file);
  if (!table) return refuse(onLog, BOX_REFUSALS.badTable(file));
  const rows = [...table, { mac: boxShareMacDir(), box: path.posix.normalize(shareDir) }];
  let boxFolder = agentHome;
  if (asString(workspace.source, "") !== "agent_home") {
    const macHomes = [workspace.agentHome, workspace.agentHomeForPermissions].map((home) => asString(home, ""));
    if (macHomes.some((home) => home && path.resolve(home) === macFolder)) return refuse(onLog, BOX_REFUSALS.notMounted(macFolder));
    const mapped = mapToBox(table, macFolder);
    if (!mapped) return refuse(onLog, BOX_REFUSALS.notMounted(macFolder));
    boxFolder = mapped;
  }

  const apiUrl = asString(config.boxApiUrl, "").trim() || BOX_API_URL_DEFAULT;
  const links = await boxSkillLinks(promptBundle.rootDir, rows);
  const key = boxBundleKey(promptBundle.bundleKey, links);
  const boxBundle = path.posix.join(shareDir, "bundles", ctx.agent.companyId, key);
  const macBundle = path.join(boxShareMacDir(), "bundles", ctx.agent.companyId, key);
  const mcpText = boxMcpText(input.servers);
  const effort = forkEffortRule(input.effort, input.model).effort;
  const instructions = promptBundle.instructionsText ? ["--append-system-prompt", promptBundle.instructionsText] : [];
  const macInstructions = asString(config.instructionsFilePath, "").trim();
  const args = [
    "--print", "--output-format", "stream-json", "--verbose",
    ...(input.model ? ["--model", input.model] : []),
    ...(effort ? ["--effort", effort] : []),
    ...instructions,
    ...(mcpText ? ["--mcp-config", mcpText, "--strict-mcp-config"] : []),
    "--add-dir", boxBundle,
    ...input.extraArgs,
  ];
  const env = { ...input.env, AGENT_HOME: agentHome, PAPERCLIP_API_URL: apiUrl };
  const bytes = boxSshCommandBytes({ remoteCwd: boxFolder, command: input.command, args, env });
  if (bytes > BOX_SSH_COMMAND_LIMIT) return refuse(onLog, BOX_REFUSALS.tooLarge(bytes));

  if (!(await probeBox(spec, agentHome, boxFolder))) return refuse(onLog, BOX_REFUSALS.notInBox(boxFolder));
  try {
    await linkBoxBundle(links, macBundle);
  } catch {
    return refuse(onLog, BOX_REFUSALS.noShare(macBundle));
  }
  for (const link of links.filter((entry) => !entry.boxFolder)) {
    await onLog("stderr", `[paperclip] Warning: skill "${link.name}" is left out of this box run: its folder ${link.macFolder} is in no box.\n`);
  }

  const settings = JSON.parse(forkSettingsText(config, input.model)) as Record<string, boolean>;
  await onLog(
    "stdout",
    `[paperclip] Box run on ${spec.host ?? "the box"} in ${boxFolder} (Mac folder ${macFolder}), nothing copied: ` +
      `model ${input.model || "default"}, effort ${effort || "default"}, ` +
      `ultracode ${settings.ultracode ? "on" : "off"}, thinking ${settings.alwaysThinkingEnabled === false ? "off" : "on"}.\n`,
  );
  return {
    plan: {
      target: target as PreparedAdapterExecutionTargetRuntime["target"],
      workspaceRemoteDir: boxFolder, runtimeRootDir: null, assetDirs: { skills: boxBundle },
      additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null,
      restoreWorkspace: async () => undefined,
    },
    agentHome, apiUrl, mcpText,
    mapText: (text: string) => boxInstructionsText(text, macInstructions, rows),
    applyEnv(env: Record<string, string>, loggedEnv: Record<string, string>) {
      for (const record of [env, loggedEnv]) Object.assign(record, { AGENT_HOME: agentHome, PAPERCLIP_API_URL: apiUrl });
    },
  };
}
