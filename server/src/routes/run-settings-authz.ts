// Fork: a task's run settings are the triage's. Its agent cannot change them,
// and only the board or a manager above the assignee sets them (fork §1 C5).
import type { Request } from "express";
import { DEFAULT_CLAUDE_LOCAL_MODEL, claudeLocalReasoningEffortsForModel } from "@paperclipai/adapter-claude-local";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { forbidden, HttpError } from "../errors.js";

type Rec = Record<string, unknown>;
type Actor = { type?: string; agentId?: string | null; runId?: string | null };

const RUN_KEYS = ["model", "effort", "ultracode", "thinking"] as const;
const MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"];
const HAIKU = "claude-haiku-4-5";
const FOLDER_KEYS = ["projectId", "projectWorkspaceId", "executionWorkspaceId", "executionWorkspacePreference",
  "executionWorkspaceSettings"] as const;
const COMMAND_KEYS = ["provisionCommand", "runtimeProvisionCommand", "teardownCommand"];
const SWITCH_KEYS = ["dangerouslySkipPermissions", "chrome"];
const AGENT_CONFIG_KEYS = /^(adapterType|adapterConfig|runtimeConfig|defaultEnvironment\w*|instructions\w*)$/;
// Skills sync writes adapterConfig too; a test of an environment writes nothing.
const AGENT_CONFIG_PATHS = /(\/rollback|\/instructions|\/skills\/sync)/i;
const TEST_PATH = /\/test-environment$/;
const ROLLBACK_PATH = /\/config-revisions\/[^/]+\/rollback$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OWN_PATH = "assigneeAdapterOverrides.";
const UPSTREAM_PATH = "assigneeAdapterOverrides.adapterConfig.workspaceStrategy.";

export const RUN_SETTINGS_TEXT = {
  own: "An agent cannot change the run settings of its own task.",
  manager: "Only the board or a manager above the assignee sets a task's run settings.",
  mac: "Only the board sets the run settings of a task for an agent that runs on the Mac.",
  keys: "An agent may set only model, effort, ultracode and thinking in a task's run settings.",
  agent: "Only the board or the CEO changes an agent's settings, instructions or box.",
  macAgent: "Only the board changes an agent that runs on the Mac.",
  switches: "Only the board turns the permission skip or the browser on or off.",
  folder: "An agent cannot move its own task to another folder.",
  stay: "A task you give yourself stays in the folder of the task you are working on.",
  fromRun: "Give yourself a task only from a run.",
  prompt: "An agent cannot change the prompt or the triage record of its own task.",
  finish: "Finish this run; Paperclip wakes you for that task with its own settings.",
  engine: "Ultracode and thinking need the command-line engine.",
  haiku: "Ultracode is not allowed on claude-haiku-4-5.",
  model: (model: unknown) => `Model ${String(model)} is not one of ${MODELS.join(", ")}.`,
  effort: (effort: unknown, model: string) => `Effort ${String(effort)} is not offered for ${model}.`,
};

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : null;
}

function has(value: Rec, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function actorOf(req: Request): Actor {
  return req.actor as Actor;
}

function unprocessable(message: string) {
  return new HttpError(422, message);
}

/** The four run settings of an override object, in a fixed order, or null when none is set. */
export function pickRunSettings(overrides: unknown): Rec | null {
  const config = rec(rec(overrides)?.adapterConfig);
  if (!config) return null;
  const settings: Rec = {};
  for (const key of RUN_KEYS) {
    if (config[key] !== undefined && config[key] !== null && config[key] !== "") settings[key] = config[key];
  }
  return Object.keys(settings).length > 0 ? settings : null;
}

function changesSettings(body: Rec, existing: Rec | null) {
  return has(body, "assigneeAdapterOverrides")
    && !same(pickRunSettings(body.assigneeAdapterOverrides), pickRunSettings(existing?.assigneeAdapterOverrides));
}

/** Rule 3: the paths of every override key an agent may not write. */
export function collectRunSettingsKeyPaths(overrides: unknown): string[] {
  const value = rec(overrides);
  if (!value) return [];
  const paths = Object.keys(value).filter((key) => key !== "adapterConfig").map((key) => `${OWN_PATH}${key}`);
  const config = rec(value.adapterConfig) ?? {};
  for (const key of Object.keys(config)) {
    if ((RUN_KEYS as readonly string[]).includes(key)) continue;
    const strategy = key === "workspaceStrategy" ? rec(config[key]) : null;
    // Upstream already names the command paths of a workspace strategy.
    if (strategy && COMMAND_KEYS.some((command) => has(strategy, command))) continue;
    paths.push(`${OWN_PATH}adapterConfig.${key}`);
  }
  return paths;
}

/** Rule 3: refuses the fork's paths with its own text; returns upstream's paths for upstream's text. */
export function assertRunSettingsKeyPaths(paths: string[]): string[] {
  const upstream = paths.filter((path) => !path.startsWith(OWN_PATH) || path.startsWith(UPSTREAM_PATH));
  if (upstream.length === paths.length) return paths;
  if (upstream.length === 0) throw forbidden(RUN_SETTINGS_TEXT.keys);
  return upstream;
}

/** A database that cannot select is a test's stand-in: the fork reads nothing from it, so upstream's rules stand. */
function canRead(db: Db): boolean {
  return typeof (db as { select?: unknown }).select === "function";
}

// Each lookup is by primary key, so it needs no limit.
async function loadAgent(db: Db, id: unknown): Promise<Rec | null> {
  if (!canRead(db) || typeof id !== "string" || !UUID.test(id)) return null;
  const [row] = await db
    .select({ id: agents.id, companyId: agents.companyId, role: agents.role, reportsTo: agents.reportsTo,
      adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.id, id));
  return rec(row);
}

async function loadIssue(db: Db, id: string): Promise<Rec | null> {
  if (!canRead(db) || !UUID.test(id)) return null;
  const [row] = await db
    .select({ id: issues.id, companyId: issues.companyId, projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId, executionWorkspacePreference: issues.executionWorkspacePreference,
      executionWorkspaceSettings: issues.executionWorkspaceSettings, assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
    .from(issues)
    .where(eq(issues.id, id));
  return rec(row);
}

/** The task the request's run serves: undefined with no run of the caller's, null for a run with no task. */
async function runTaskId(db: Db, req: Request): Promise<string | null | undefined> {
  const { agentId, runId } = actorOf(req);
  if (!canRead(db) || typeof runId !== "string" || !UUID.test(runId)) return undefined;
  const [run] = await db
    .select({ agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId));
  if (!run || run.agentId !== agentId) return undefined;
  const context = rec(run.contextSnapshot);
  const taskId = context?.issueId ?? context?.taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

/** Rule 7: the task the request's run serves, null for a run with no task; no run of the caller's gets 403. */
async function runTask(db: Db, req: Request): Promise<Rec | null> {
  const taskId = await runTaskId(db, req);
  if (taskId === undefined) throw forbidden(RUN_SETTINGS_TEXT.fromRun);
  return taskId ? loadIssue(db, taskId) : null;
}

function hasBox(agent: unknown) {
  return Boolean(rec(rec(agent)?.adapterConfig)?.mountedBox);
}

/** The fork's rules hold in a company that runs box agents; a company with none keeps upstream's rules. */
async function companyRunsBoxes(db: Db, companyId: unknown): Promise<boolean> {
  if (!canRead(db) || typeof companyId !== "string" || !UUID.test(companyId)) return false;
  const rows = await db.select({ adapterConfig: agents.adapterConfig }).from(agents)
    .where(eq(agents.companyId, companyId));
  return rows.some(hasBox);
}

/** The company of an agent, read only when one of the fork's rules is about to act. */
async function agentRunsInBoxCompany(db: Db, agentId: unknown): Promise<boolean> {
  return companyRunsBoxes(db, (await loadAgent(db, agentId))?.companyId);
}

/** An agent with no box, in a company that runs box agents, runs on the Mac. */
async function runsOnMac(db: Db, agent: Rec | null) {
  return agent !== null && !hasBox(agent) && await companyRunsBoxes(db, agent.companyId);
}

/** Rules 1 and 2: a Mac agent's task takes the board alone; the assignee never; else a manager above it. */
async function assertManager(db: Db, actorId: string, assigneeId: unknown, ownTask: boolean) {
  const assignee = await loadAgent(db, assigneeId);
  if (await runsOnMac(db, assignee)) throw forbidden(RUN_SETTINGS_TEXT.mac);
  if (ownTask) throw forbidden(RUN_SETTINGS_TEXT.own);
  let next = assignee?.reportsTo;
  for (let depth = 0; typeof next === "string" && depth < 64; depth += 1) {
    if (next === actorId) return;
    next = (await loadAgent(db, next))?.reportsTo;
  }
  throw forbidden(RUN_SETTINGS_TEXT.manager);
}

/** Rule 7: a task an agent gives itself takes the run settings and folder of the run's task; a run with no task gives none. */
async function bindToRunTask(db: Db, req: Request, body: Rec, existing: Rec | null) {
  const task = await runTask(db, req);
  if (!task) { delete body.assigneeAdapterOverrides; return; }
  const asked: unknown[][] = [[has(body, "projectId") ? body.projectId : existing?.projectId, task.projectId],
    [body.inheritExecutionWorkspaceFromIssueId, task.id], ...FOLDER_KEYS.slice(1).map((key) => [body[key], task[key]])];
  // A new task with no project takes its parent's or plan source's (issues.ts:4868-4872, 12386).
  for (const id of existing ? [] : [body.parentId, req.params.id]) {
    const source = typeof id === "string" ? await loadIssue(db, id) : null;
    if (source) asked.push([source.projectId, task.projectId]);
  }
  if (asked.some(([value, bound]) => value != null && !same(value, bound))) throw forbidden(RUN_SETTINGS_TEXT.stay);
  body.projectId = task.projectId ?? null;
  body.projectWorkspaceId = task.projectWorkspaceId ?? null;
  const settings = pickRunSettings(task.assigneeAdapterOverrides);
  body.assigneeAdapterOverrides = settings ? { adapterConfig: settings } : null;
}

/** Rules 4 and 8: the folder and the prompt the assignee may not change on its own task; the refusal, or null. */
function assigneeWriteRefusal(body: Rec, existing: Rec) {
  const moved = FOLDER_KEYS.filter((key) => has(body, key) && !same(body[key], existing[key]));
  const firstProject = existing.projectId == null && body.projectId != null
    && moved.every((key) => key === "projectId" || key === "projectWorkspaceId");
  if (moved.length > 0 && !firstProject) return forbidden(RUN_SETTINGS_TEXT.folder);
  const prompt = has(body, "description") && !same(body.description, existing.description);
  if (prompt && pickRunSettings(existing.assigneeAdapterOverrides)) return forbidden(RUN_SETTINGS_TEXT.prompt);
  return null;
}

/** Rule 6, for every writer: the model, its effort, and the switches the engine takes. */
async function assertValidSettings(db: Db, overrides: unknown, assigneeId: unknown, taskCompanyId: unknown) {
  const settings = pickRunSettings(overrides);
  if (!settings) return;
  const assignee = await loadAgent(db, assigneeId);
  if (!(await companyRunsBoxes(db, assignee?.companyId ?? taskCompanyId))) return;
  const assigneeConfig = rec(assignee?.adapterConfig);
  if (settings.model !== undefined && !MODELS.includes(String(settings.model))) {
    throw unprocessable(RUN_SETTINGS_TEXT.model(settings.model));
  }
  // With no model named, the run takes the adapter's default (claude-local index.ts:1-22).
  const model = String(settings.model ?? assigneeConfig?.model ?? DEFAULT_CLAUDE_LOCAL_MODEL);
  const effort = settings.effort;
  if (effort !== undefined && !claudeLocalReasoningEffortsForModel(model).includes(String(effort))) {
    throw unprocessable(RUN_SETTINGS_TEXT.effort(effort, model));
  }
  if (settings.ultracode === true && model === HAIKU) throw unprocessable(RUN_SETTINGS_TEXT.haiku);
  const switches = settings.ultracode === true || (settings.thinking !== undefined && settings.thinking !== false);
  if (assignee && switches && assigneeConfig?.engine !== "cli") throw unprocessable(RUN_SETTINGS_TEXT.engine);
}

/** Rule 9: a task with run settings is worked only in a run that serves it. */
async function assertSameRun(db: Db, req: Request, task: Rec) {
  if (!pickRunSettings(task.assigneeAdapterOverrides)) return;
  const taskId = await runTaskId(db, req);
  if (taskId !== undefined && taskId !== task.id && await companyRunsBoxes(db, task.companyId)) {
    throw new HttpError(409, RUN_SETTINGS_TEXT.finish);
  }
}

/** The checkout hook: rule 7 when an agent key takes a task with no agent assignee, then rule 9. */
export async function assertRunServesTask(db: Db, req: Request, issue: object) {
  const task = issue as Rec;
  const actor = actorOf(req);
  if (actor.type !== "agent") return;
  // Rule 7 holds for a box agent in a company that runs box agents: its folders are the mounted ones.
  const caller = task.assigneeAgentId ? null : await loadAgent(db, actor.agentId);
  const boxed = hasBox(caller) && await companyRunsBoxes(db, caller?.companyId);
  const bound = boxed ? await runTask(db, req) : null;
  const runSettings = pickRunSettings(bound?.assigneeAdapterOverrides);
  if (bound && (!same(task.projectId, bound.projectId) || !same(pickRunSettings(task.assigneeAdapterOverrides), runSettings))) {
    throw forbidden(RUN_SETTINGS_TEXT.stay);
  }
  await assertSameRun(db, req, task);
}

/** The hook of the issue create, sub-task, plan split and update routes: rules 1, 2, 4, 6, 7, 8 and 9. */
export async function bindRunSettings(db: Db, req: Request, input: { body: object; existing?: object }) {
  const body = input.body as Rec;
  const existing = (input.existing ?? null) as Rec | null;
  const actor = actorOf(req);
  const agentId = actor.type === "agent" ? actor.agentId : null;
  const assigneeId = has(body, "assigneeAgentId") ? body.assigneeAgentId : existing?.assigneeAgentId ?? null;
  const reassigned = existing !== null && (assigneeId ?? null) !== (existing.assigneeAgentId ?? null);
  const overrides = () => (has(body, "assigneeAdapterOverrides") ? body.assigneeAdapterOverrides : existing?.assigneeAdapterOverrides);
  // Each rule reads the company only when it would act: a company with no box agent keeps upstream's rules.
  if (agentId) {
    if (assigneeId === agentId && !existing?.assigneeAgentId) {
      // Rule 7 holds for a box agent: its folders are the mounted ones.
      const caller = await loadAgent(db, agentId);
      if (hasBox(caller) && await companyRunsBoxes(db, caller?.companyId)) await bindToRunTask(db, req, body, existing);
    } else if (changesSettings(body, existing)) {
      // Rule 1 reads the assignee after the write, so a manager may hand its own task to a report with settings.
      if (await agentRunsInBoxCompany(db, agentId)) await assertManager(db, agentId, assigneeId, assigneeId === agentId);
    } else if (reassigned && pickRunSettings(overrides()) && await runsOnMac(db, await loadAgent(db, assigneeId))) {
      throw forbidden(RUN_SETTINGS_TEXT.mac);
    }
    const refusal = existing && existing.assigneeAgentId === agentId ? assigneeWriteRefusal(body, existing) : null;
    if (refusal && await agentRunsInBoxCompany(db, agentId)) throw refusal;
    if (existing && body.status === "in_progress" && existing.status !== "in_progress") {
      await assertSameRun(db, req, existing);
    }
  }
  // A new assignee is checked too: its engine decides ultracode and thinking.
  if (changesSettings(body, existing) || reassigned) {
    const parentId = typeof req.params.id === "string" ? req.params.id : null;
    const taskCompanyId = existing?.companyId ?? req.params.companyId ?? (parentId ? (await loadIssue(db, parentId))?.companyId : null);
    await assertValidSettings(db, overrides(), assigneeId, taskCompanyId);
  }
}

/** Rule 8: the assignee cannot write or restore the triage record of its own task. */
export function assertTriageRecordWrite(req: Request, issue: object) {
  const task = issue as Rec;
  const actor = actorOf(req);
  const key = String(req.params.key ?? "").trim().toLowerCase();
  const own = actor.type === "agent" && task.assigneeAgentId === actor.agentId;
  if (own && key === "triage" && pickRunSettings(task.assigneeAdapterOverrides)) throw forbidden(RUN_SETTINGS_TEXT.prompt);
}

/** Rule 5, at the start of every agent config route: the CEO's key alone, and never on a Mac agent or a switch. */
export async function assertAgentSettingsWrite(
  req: Request,
  target: { id: string },
  agentsSvc: {
    getById(id: string): Promise<unknown>;
    getConfigRevision?(id: string, revisionId: string): Promise<unknown>;
    list(companyId: string): Promise<unknown[]>;
  },
) {
  const actor = actorOf(req);
  if (actor.type !== "agent" || TEST_PATH.test(req.path)) return;
  const body = rec(req.body) ?? {};
  const touches = Object.keys(body).some((key) => AGENT_CONFIG_KEYS.test(key)) || AGENT_CONFIG_PATHS.test(req.path);
  if (!touches) return;
  const caller = rec(await agentsSvc.getById(String(actor.agentId)));
  // The company is read only when a refusal would follow: a company with no box agent keeps upstream's rules.
  const boxes = async () => typeof caller?.companyId === "string" && (await agentsSvc.list(caller.companyId)).some(hasBox);
  if (caller?.role !== "ceo") {
    if (await boxes()) throw forbidden(RUN_SETTINGS_TEXT.agent);
    return;
  }
  const agent = rec(await agentsSvc.getById(target.id));
  const existingConfig = rec(agent?.adapterConfig) ?? {};
  // A rollback replaces the config with the revision's: its switches and box stay as the board left them.
  const revision = ROLLBACK_PATH.test(req.path)
    ? rec(rec(await agentsSvc.getConfigRevision?.(target.id, String(req.params.revisionId)))?.afterConfig)
    : null;
  const config = rec(revision ? revision.adapterConfig : body.adapterConfig) ?? {};
  const replaces = revision !== null || body.replaceAdapterConfig === true
    || (body.adapterType !== undefined && body.adapterType !== agent?.adapterType);
  if (SWITCH_KEYS.some((key) => (replaces ? !same(config[key], existingConfig[key]) : has(config, key)))) {
    if (await boxes()) throw forbidden(RUN_SETTINGS_TEXT.switches);
    return;
  }
  const dropsBox = hasBox(agent) && (has(config, "mountedBox") || replaces) && !config.mountedBox;
  if (((agent !== null && !hasBox(agent)) || dropsBox) && await boxes()) throw forbidden(RUN_SETTINGS_TEXT.macAgent);
}
