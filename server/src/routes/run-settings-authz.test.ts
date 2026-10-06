import express from "express";
import request from "supertest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectIssueWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import {
  RUN_SETTINGS_TEXT as T,
  assertAgentSettingsWrite,
  assertRunServesTask,
  assertTriageRecordWrite,
  bindRunSettings,
} from "./run-settings-authz.js";

type Row = Record<string, unknown>;
const companyId = "22222222-2222-4222-8222-222222222222";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [CEO, MAC, COS, WORKER, PEER] = [1, 2, 3, 4, 5].map(uid);
const [TASK_A, TASK_B, TASK_C, TASK_U, TASK_COS, TASK_MAC, TASK_CEO] = [11, 12, 13, 14, 15, 16, 17].map(uid);
const [RUN, P1, P2, W1] = [21, 31, 32, 41].map(uid);
const opus = { adapterConfig: { model: "claude-opus-5-5", effort: "high" } };
const settings = (adapterConfig: Row) => ({ assigneeAdapterOverrides: { adapterConfig } });

let state: Record<string, Row> = {};

function seed() {
  const agent = (id: string, role: string, reportsTo: string | null, adapterConfig: Row) =>
    ({ id, companyId, role, reportsTo, adapterType: "claude_local", adapterConfig });
  const box = { mountedBox: "box-1", engine: "cli" };
  const issue = (id: string, assigneeAgentId: string | null, extra: Row = {}) => ({
    id, companyId, status: "todo", assigneeAgentId, projectId: null, projectWorkspaceId: null,
    description: "The prompt.", assigneeAdapterOverrides: null, ...extra,
  });
  state = {
    [CEO]: agent(CEO, "ceo", null, { engine: "cli" }),
    [MAC]: agent(MAC, "mac-operator", CEO, { engine: "cli" }),
    [COS]: agent(COS, "chief-of-staff", CEO, box),
    [WORKER]: agent(WORKER, "engineer", COS, box),
    [PEER]: agent(PEER, "engineer", CEO, box),
    [TASK_A]: issue(TASK_A, WORKER, { projectId: P1, projectWorkspaceId: W1, assigneeAdapterOverrides: opus }),
    [TASK_B]: issue(TASK_B, WORKER, { assigneeAdapterOverrides: opus }),
    [TASK_C]: issue(TASK_C, WORKER),
    [TASK_U]: issue(TASK_U, null),
    [TASK_COS]: issue(TASK_COS, COS),
    [TASK_MAC]: issue(TASK_MAC, MAC),
    [TASK_CEO]: issue(TASK_CEO, CEO),
    [RUN]: { id: RUN, agentId: WORKER, contextSnapshot: { issueId: TASK_A } },
  };
}

// Every lookup of the fork's module is one row by id, or a company's agents; the ids are unique across tables.
const companyAgents = (id: string) => Object.values(state).filter((row) => row.companyId === id && "role" in row);
const dbStub = {
  select: () => ({
    from: () => ({
      // A thenable, as drizzle's query and upstream's route-test stand-ins are.
      where: (condition: SQL) => {
        const key = String(new PgDialect().sqlToQuery(condition).params[0]);
        const rows = key === companyId ? companyAgents(key) : state[key] ? [state[key]] : [];
        return { then: (ok: (value: Row[]) => unknown, ko?: (reason: unknown) => unknown) => Promise.resolve(rows).then(ok, ko) };
      },
    }),
  }),
};
const db = dbStub as never;
const agentsSvc = {
  getById: async (id: string) => state[id] ?? null,
  getConfigRevision: async (_: string, id: string) => state[id],
  list: async (id: string) => companyAgents(id),
};

const board = { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit" };
const agentKey = (agentId: string, runId: string | null = null) =>
  ({ type: "agent", agentId, companyId, source: "agent_key", ...(runId ? { runId } : {}) });
const worker = (runId: string | null = RUN) => agentKey(WORKER, runId);

type Check = (req: express.Request) => unknown;

// Each route calls the fork's hook where the hook line of routes/issues.ts or routes/agents.ts calls it.
function createApp(actor: Row) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: Row }).actor = actor;
    next();
  });
  const route = (check: Check) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try {
        await check(req);
        res.json(req.body ?? {});
      } catch (error) {
        next(error);
      }
    };
  const issueOf = (req: express.Request) => state[String(req.params.id)];
  const create = async (req: express.Request, body: Row) => {
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(body));
    await bindRunSettings(db, req, { body });
  };
  app.post("/api/companies/:companyId/issues", route((req) => create(req, req.body)));
  app.post("/api/issues/:id/children", route((req) => create(req, req.body)));
  app.post("/api/issues/:id/plan-split", route(async (req) => {
    for (const child of req.body.children as Row[]) await create(req, child);
  }));
  app.patch("/api/issues/:id", route(async (req) => {
    assertNoAgentHostWorkspaceCommandMutation(req, collectIssueWorkspaceCommandPaths(req.body));
    await bindRunSettings(db, req, { body: req.body, existing: issueOf(req) });
  }));
  app.post("/api/issues/:id/checkout", route((req) => assertRunServesTask(db, req, issueOf(req))));
  app.put("/api/issues/:id/documents/:key", route((req) => assertTriageRecordWrite(req, issueOf(req))));
  app.post(
    "/api/issues/:id/documents/:key/revisions/:revisionId/restore",
    route((req) => assertTriageRecordWrite(req, issueOf(req))),
  );
  const agentRoute = route((req) => assertAgentSettingsWrite(req, { id: String(req.params.id) }, agentsSvc));
  app.patch("/api/agents/:id", agentRoute);
  app.post("/api/agents/:id/config-revisions/:revisionId/rollback", agentRoute);
  app.put("/api/agents/:id/instructions-bundle/file", agentRoute);
  app.post("/api/agents/:id/skills/sync", agentRoute);
  app.post("/api/companies/:companyId/adapters/:type/test-environment", agentRoute);
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as { status?: number }).status ?? 500).json({ error: error.message });
  });
  return app;
}

const patch = (actor: Row, id: string, body: Row) => request(createApp(actor)).patch(`/api/issues/${id}`).send(body);
const createFor = (actor: Row, body: Row) =>
  request(createApp(actor)).post(`/api/companies/${companyId}/issues`).send({ title: "Task", status: "todo", ...body });
const patchAgent = (actor: Row, id: string, body: Row) => request(createApp(actor)).patch(`/api/agents/${id}`).send(body);

async function expectError(response: Promise<request.Response>, status: number, text: string) {
  const res = await response;
  expect(res.status).toBe(status);
  expect(res.body.error).toBe(text);
}

describe("run settings bound to the triage", () => {
  beforeEach(seed);

  it("refuses the assignee and a peer, and allows a manager above a box assignee and the board", async () => {
    await expectError(patch(worker(), TASK_B, settings({ model: "claude-sonnet-5-5" })), 403, T.own);
    await expectError(patch(agentKey(PEER), TASK_COS, settings({ model: "claude-sonnet-5-5" })), 403, T.manager);
    await expectError(createFor(agentKey(PEER), { assigneeAgentId: COS, ...settings(opus.adapterConfig) }), 403, T.manager);
    expect((await patch(agentKey(COS), TASK_C, settings({ model: "claude-sonnet-5-5" }))).status).toBe(200);
    expect((await patch(agentKey(CEO), TASK_C, settings({ model: "claude-sonnet-5-5" }))).status).toBe(200);
    expect((await createFor(agentKey(COS), { assigneeAgentId: WORKER, ...settings(opus.adapterConfig) })).status).toBe(200);
    expect((await patch(board, TASK_COS, settings({ model: "claude-sonnet-5-5" }))).status).toBe(200);
  });

  it("lets only the board set run settings on a task for the CEO or the Mac Operator", async () => {
    for (const task of [TASK_MAC, TASK_CEO]) {
      await expectError(patch(agentKey(CEO), task, settings({ model: "claude-sonnet-5-5" })), 403, T.mac);
      expect((await patch(board, task, settings({ model: "claude-sonnet-5-5" }))).status).toBe(200);
    }
  });

  it("lets an assignee set a project once on its own task and refuses a later move", async () => {
    expect((await patch(worker(), TASK_C, { projectId: P1, projectWorkspaceId: W1 })).status).toBe(200);
    state[TASK_C] = { ...state[TASK_C], projectId: P1, projectWorkspaceId: W1 };
    await expectError(patch(worker(), TASK_C, { projectId: P2 }), 403, T.folder);
    await expectError(patch(worker(), TASK_C, { executionWorkspaceId: uid(42) }), 403, T.folder);
    expect((await patch(worker(), TASK_C, { projectId: P1, title: "Same folder" })).status).toBe(200);
  });

  it("gives a self-made task, sub-task, plan child and taken task the settings and folder of the run's task", async () => {
    const asked = { assigneeAgentId: WORKER, ...settings({ model: "claude-fable-5-1", effort: "max" }) };
    const bound = { assigneeAdapterOverrides: opus, projectId: P1, projectWorkspaceId: W1 };
    const app = createApp(worker());
    const made = await createFor(worker(), asked);
    const child = await request(app).post(`/api/issues/${TASK_A}/children`).send({ title: "Child", ...asked });
    const split = await request(app).post(`/api/issues/${TASK_A}/plan-split`).send({ children: [{ title: "Part", ...asked }] });
    const taken = await patch(worker(), TASK_U, { assigneeAgentId: WORKER, ...settings({ model: "claude-haiku-4-5" }) });
    for (const res of [made, child, taken]) expect(res.body).toMatchObject(bound);
    expect(split.body.children[0]).toMatchObject(bound);
  });

  it("refuses a task given to oneself with no run header or in another project", async () => {
    await expectError(createFor(worker(null), { assigneeAgentId: WORKER }), 403, T.fromRun);
    await expectError(patch(worker(null), TASK_U, { assigneeAgentId: WORKER }), 403, T.fromRun);
    await expectError(createFor(worker(), { assigneeAgentId: WORKER, projectId: P2 }), 403, T.stay);
    state[TASK_U] = { ...state[TASK_U], projectId: P2 };
    await expectError(patch(worker(), TASK_U, { assigneeAgentId: WORKER }), 403, T.stay);
    await expectError(createFor(agentKey(PEER, RUN), { assigneeAgentId: PEER }), 403, T.fromRun);
  });

  it("keeps a self-made task out of another project's parent, execution workspace or inheritance", async () => {
    state[TASK_A] = { ...state[TASK_A], projectId: null, projectWorkspaceId: null };
    state[TASK_C] = { ...state[TASK_C], projectId: P2 };
    const mine = { title: "Child", assigneeAgentId: WORKER };
    await expectError(request(createApp(worker())).post(`/api/issues/${TASK_C}/children`).send(mine), 403, T.stay);
    for (const asked of [{ parentId: TASK_C }, { executionWorkspaceId: uid(42) }, { inheritExecutionWorkspaceFromIssueId: TASK_C }]) {
      await expectError(createFor(worker(), { ...mine, ...asked }), 403, T.stay);
    }
    expect((await createFor(worker(), { ...mine, parentId: TASK_A })).status).toBe(200);
  });

  it("binds a task an agent takes at checkout to the run's task", async () => {
    const checkout = (actor: Row) => request(createApp(actor)).post(`/api/issues/${TASK_U}/checkout`).send({});
    await expectError(checkout(worker(null)), 403, T.fromRun);
    await expectError(checkout(worker()), 403, T.stay);
    state[RUN] = { ...state[RUN], contextSnapshot: { issueId: TASK_C } };
    expect((await checkout(worker())).status).toBe(200);
    state[TASK_U] = { ...state[TASK_U], projectId: P2 };
    await expectError(checkout(worker()), 403, T.stay);
  });

  it("drops the asked run settings of a task given to oneself from a run that serves no task", async () => {
    state[RUN] = { ...state[RUN], contextSnapshot: {} };
    const made = await createFor(worker(), { assigneeAgentId: WORKER, ...settings({ model: "claude-fable-5-1" }) });
    expect(made.status).toBe(200);
    expect(made.body).not.toHaveProperty("assigneeAdapterOverrides");
  });

  it("refuses an agent that writes a key other than the four run settings", async () => {
    const command = { assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus-5-5", command: "sh" } } };
    await expectError(patch(agentKey(COS), TASK_C, command), 403, T.keys);
    await expectError(patch(agentKey(COS), TASK_C, { assigneeAdapterOverrides: { useProjectWorkspace: true } }), 403, T.keys);
    await expectError(createFor(agentKey(COS), { assigneeAgentId: WORKER, ...command }), 403, T.keys);
    const strategy = settings({ workspaceStrategy: { type: "git_worktree", provisionCommand: "sh" } });
    const upstream = await patch(agentKey(COS), TASK_C, strategy);
    expect(upstream.status).toBe(403);
    expect(upstream.body.error).toContain("host-executed workspace commands");
    expect(upstream.body.error).not.toContain("assigneeAdapterOverrides.adapterConfig.workspaceStrategy,");
    expect((await patch(board, TASK_C, { assigneeAdapterOverrides: { useProjectWorkspace: true } })).status).toBe(200);
  });

  it("lets no agent key but the CEO's change an agent, and only the board a Mac agent or a switch", async () => {
    const model = { adapterConfig: { model: "claude-sonnet-5-5" } };
    await expectError(patchAgent(worker(), PEER, model), 403, T.agent);
    await expectError(patchAgent(worker(), WORKER, model), 403, T.agent);
    await expectError(patchAgent(worker(), WORKER, { defaultEnvironmentId: uid(51) }), 403, T.agent);
    const rollback = request(createApp(worker())).post(`/api/agents/${WORKER}/config-revisions/${uid(52)}/rollback`).send({});
    await expectError(rollback, 403, T.agent);
    for (const key of ["dangerouslySkipPermissions", "chrome"]) {
      await expectError(patchAgent(agentKey(CEO), MAC, { adapterConfig: { [key]: true } }), 403, T.switches);
    }
    await expectError(patchAgent(agentKey(CEO), MAC, model), 403, T.macAgent);
    await expectError(patchAgent(agentKey(CEO), WORKER, { adapterConfig: { chrome: true } }), 403, T.switches);
    await expectError(patchAgent(agentKey(CEO), WORKER, { adapterConfig: { mountedBox: null } }), 403, T.macAgent);
    expect((await patchAgent(agentKey(CEO), WORKER, model)).status).toBe(200);
    expect((await patchAgent(board, MAC, { adapterConfig: { chrome: true } })).status).toBe(200);
    expect((await patchAgent(worker(), WORKER, { name: "Worker" })).status).toBe(200);
    const app = (actor: Row) => request(createApp(actor));
    await expectError(app(worker()).put(`/api/agents/${WORKER}/instructions-bundle/file`).send({}), 403, T.agent);
    await expectError(app(worker()).post(`/api/agents/${WORKER}/skills/sync`).send({ desiredSkills: [] }), 403, T.agent);
    await expectError(app(agentKey(CEO)).put(`/api/agents/${CEO}/instructions-bundle/file`).send({}), 403, T.macAgent);
    expect((await app(agentKey(CEO)).put(`/api/agents/${WORKER}/instructions-bundle/file`).send({})).status).toBe(200);
    const test = app(worker()).post(`/api/companies/${companyId}/adapters/claude_local/test-environment`);
    expect((await test.send({ agentId: WORKER, adapterConfig: { chrome: true } })).status).toBe(200);
    const rollbackTo = (adapterConfig: Row) => {
      state[uid(52)] = { afterConfig: { adapterConfig } };
      return app(agentKey(CEO)).post(`/api/agents/${WORKER}/config-revisions/${uid(52)}/rollback`).send({});
    };
    await expectError(rollbackTo({ mountedBox: "box-1", engine: "cli", chrome: true }), 403, T.switches);
    await expectError(rollbackTo({ engine: "cli" }), 403, T.macAgent);
    expect((await rollbackTo({ mountedBox: "box-1", engine: "cli", model: "claude-opus-5-5" })).status).toBe(200);
  });

  it("keeps upstream's rules in a company that runs no box agent", async () => {
    for (const id of [COS, WORKER, PEER]) state[id] = { ...state[id], adapterConfig: { engine: "cli" } };
    expect((await patchAgent(agentKey(CEO), MAC, { adapterConfig: { model: "claude-opus-5-5" } })).status).toBe(200);
    expect((await patchAgent(agentKey(PEER), WORKER, { adapterConfig: { model: "claude-opus-5-5" } })).status).toBe(200);
    expect((await createFor(worker(), { assigneeAgentId: WORKER, projectId: P2 })).status).toBe(200);
    expect((await patch(agentKey(CEO), TASK_MAC, settings({ model: "claude-opus-5-5" }))).status).toBe(200);
  });

  it("refuses the assignee's prompt and triage record writes, and a second task's checkout in the run", async () => {
    const app = createApp(worker());
    await expectError(patch(worker(), TASK_B, { description: "Another prompt." }), 403, T.prompt);
    await expectError(request(app).put(`/api/issues/${TASK_B}/documents/triage`).send({ body: "x" }), 403, T.prompt);
    const restore = request(app).post(`/api/issues/${TASK_B}/documents/Triage/revisions/${uid(53)}/restore`).send({});
    await expectError(restore, 403, T.prompt);
    expect((await request(app).put(`/api/issues/${TASK_B}/documents/plan`).send({ body: "x" })).status).toBe(200);
    expect((await request(app).put(`/api/issues/${TASK_C}/documents/triage`).send({ body: "x" })).status).toBe(200);
    await expectError(request(app).post(`/api/issues/${TASK_B}/checkout`).send({ agentId: WORKER }), 409, T.finish);
    await expectError(patch(worker(), TASK_B, { status: "in_progress" }), 409, T.finish);
    expect((await request(app).post(`/api/issues/${TASK_A}/checkout`).send({ agentId: WORKER })).status).toBe(200);
    expect((await patch(worker(), TASK_A, { status: "in_progress" })).status).toBe(200);
  });

  it("checks the model, the effort and the switches for every writer, the board too", async () => {
    await expectError(patch(board, TASK_C, settings({ model: "gpt-5" })), 422, T.model("gpt-5"));
    for (const [model, effort] of [["claude-opus-5-5", "turbo"], ["claude-haiku-4-5", "high"]]) {
      await expectError(patch(board, TASK_C, settings({ model, effort })), 422, T.effort(effort, model));
    }
    for (const effort of [{ effort: "" }, {}]) {
      expect((await patch(board, TASK_C, settings({ model: "claude-haiku-4-5", ...effort }))).status).toBe(200);
    }
    await expectError(patch(board, TASK_C, settings({ model: "claude-haiku-4-5", ultracode: true })), 422, T.haiku);
    expect((await patch(board, TASK_C, settings({ model: "claude-haiku-4-5", ultracode: false }))).status).toBe(200);
    const thinking = await patch(board, TASK_C, settings({ model: "claude-opus-5-5", thinking: "on" }));
    expect(thinking.status).toBe(200);
    expect(thinking.body.assigneeAdapterOverrides.adapterConfig.thinking).toBe("on");
    state[WORKER] = { ...state[WORKER], adapterConfig: { mountedBox: "box-1", engine: "sdk" } };
    await expectError(patch(board, TASK_C, settings({ model: "claude-opus-5-5", ultracode: true })), 422, T.engine);
    await expectError(patch(board, TASK_U, settings({ effort: "turbo" })), 422, T.effort("turbo", "claude-opus-5"));
    expect((await patch(board, TASK_U, settings({ ultracode: true }))).status).toBe(200);
    state[TASK_U] = { ...state[TASK_U], ...settings({ model: "claude-opus-5-5", ultracode: true }) };
    await expectError(patch(board, TASK_U, { assigneeAgentId: WORKER }), 422, T.engine);
    await expectError(patch(agentKey(COS), TASK_B, { assigneeAgentId: MAC }), 403, T.mac);
    const handed = await patch(agentKey(COS), TASK_COS, { assigneeAgentId: WORKER, ...settings({ model: "claude-sonnet-5-5" }) });
    expect(handed.status).toBe(200);
  });
});
