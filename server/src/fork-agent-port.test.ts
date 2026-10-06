import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApiKeys, agents, authUsers, boardApiKeys, heartbeatRuns } from "@paperclipai/db";
import { actorMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { logger } from "./middleware/logger.js";
import { createLocalAgentJwt } from "./agent-auth-jwt.js";
import { forbidden } from "./errors.js";
import { FORK_AGENT_PORT, createForkAgentPortServer, forkAgentPortNext, startForkAgentPort } from "./fork-agent-port.js";

const boardToken = "pcp_board_fork_agent_port_test";
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
// The stub ignores the where clause, so only the board key test holds a board key row.
function createDbState(input: { agentId: string; companyId: string; runId: string; userId: string }, boardKey = false) {
  const agentRow = { id: input.agentId, companyId: input.companyId, status: "active" };
  const runRow = { id: input.runId, companyId: input.companyId, agentId: input.agentId, responsibleUserId: input.userId,
    status: "running", contextSnapshot: {}, resultJson: {} };
  const boardKeyRow = { id: randomUUID(), userId: input.userId, name: "Board key", keyHash: hashToken(boardToken),
    lastUsedAt: null, revokedAt: null, expiresAt: null, createdAt: new Date() };
  const userRow = { id: input.userId, name: "Board user", email: "board@example.test" };
  const rows = new Map<unknown, unknown[]>([[boardApiKeys, boardKey ? [boardKeyRow] : []],[authUsers, [userRow]], [agentApiKeys, []],
    [agents, [agentRow]], [heartbeatRuns, [runRow]]]);
  return {
    select: () => ({ from: (table: unknown) => ({ where: () => Promise.resolve(rows.get(table) ?? []) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve([]) }),
  } as any;
}

function createApp(db: any) {
  const app = express();
  const runs = { early: 0, actor: 0 };
  app.use(express.json());
  // Mounted before the actor middleware, as the connection-intent routes are in app.ts.
  app.get("/early", (_req, res) => void res.json({ early: (runs.early += 1) > 0 }));
  app.use(actorMiddleware(db, { deploymentMode: "local_trusted", resolveSession: async () => null }));
  app.get("/actor", (req, res) => {
    runs.actor += 1;
    res.json(req.actor);
  });
  app.post("/mcp/gateways/:gatewayPublicId", (req, res) => {
    res.json({ reachedGatewayProtocol: true, actorType: req.actor.type });
  });
  app.use(errorHandler);
  return { app, runs };
}

describe("fork agent port", () => {
  const previousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const ids = { agentId: "", companyId: "", runId: "", userId: "" };
  let db: any;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "fork-agent-port-test-secret";
    Object.assign(ids, { agentId: randomUUID(), companyId: randomUUID(), runId: randomUUID(), userId: randomUUID() });
    db = createDbState(ids);
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousSecret;
    vi.restoreAllMocks();
  });

  it("refuses a request without a key before the app runs, routes before the actor middleware too", async () => {
    const { app, runs } = createApp(db);
    for (const path of ["/actor", "/early"]) {
      const res = await request(createForkAgentPortServer(app)).get(path);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    }
    expect(runs).toEqual({ early: 0, actor: 0 });
    expect((await request(app).get("/early")).status).toBe(200);
  });

  it("refuses a valid board API key that the board port accepts", async () => {
    const { app, runs } = createApp(createDbState(ids, true));
    const board = await request(app).get("/actor").set("Authorization", `Bearer ${boardToken}`);
    expect(board.body).toMatchObject({ type: "board", userId: ids.userId, source: "board_key" });
    const res = await request(createForkAgentPortServer(app)).get("/actor").set("Authorization", `Bearer ${boardToken}`);
    expect(res.status).toBe(401);
    expect(runs.actor).toBe(1);
  });

  it("turns a board actor from any path into 401 and passes errors on unchanged", async () => {
    const app = express();
    app.use((req, res, next) => {
      next = forkAgentPortNext(req, res, next);
      req.actor = { type: "board", userId: ids.userId, isInstanceAdmin: true, source: "board_key" } as never;
      if (req.path === "/fail") next(forbidden("kept")); else next();
    });
    app.get("/actor", (req, res) => res.json(req.actor));
    app.use(errorHandler);
    const agentPort = createForkAgentPortServer(app);
    expect((await request(agentPort).get("/actor").set("Authorization", "Bearer any")).status).toBe(401);
    expect((await request(agentPort).get("/fail").set("Authorization", "Bearer any")).status).toBe(403);
    expect((await request(app).get("/actor")).body).toMatchObject({ type: "board", userId: ids.userId });
  });

  it("lets a valid agent key through", async () => {
    const { app } = createApp(db);
    const token = createLocalAgentJwt(ids.agentId, ids.companyId, "claude_local", ids.runId)!;
    const res = await request(createForkAgentPortServer(app)).get("/actor").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "agent", agentId: ids.agentId, companyId: ids.companyId });
  });

  it("passes a public MCP gateway bearer to its route with no actor, never a lookalike", async () => {
    const agentPort = createForkAgentPortServer(createApp(db).app);
    const res = await request(agentPort).post(`/mcp/gateways/gw_${"a".repeat(32)}`)
      .set("Authorization", "Bearer pcgw_runtime_token").send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reachedGatewayProtocol: true, actorType: "none" });
    const lookalike = await request(agentPort).post("/mcp/gateways/not-a-public-id").set("Authorization", "Bearer pcgw_runtime_token");
    expect(lookalike.status).toBe(401);
  });

  it("keeps the board port as upstream", async () => {
    const res = await request(createApp(db).app).get("/actor");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "board", userId: "local-board" });
  });

  it("listens on 127.0.0.1 only, keeps the board's timeouts and closes with the board server", async () => {
    expect(FORK_AGENT_PORT).toBe(3101);
    const boardServer = createServer();
    Object.assign(boardServer, { keepAliveTimeout: 185_000, headersTimeout: 186_000 });
    await once(boardServer.listen(0, "127.0.0.1"), "listening");
    const agentServer = startForkAgentPort(createApp(db).app, boardServer, 0);
    await once(agentServer, "listening");
    expect((agentServer.address() as AddressInfo).address).toBe("127.0.0.1");
    expect([agentServer.keepAliveTimeout, agentServer.headersTimeout]).toEqual([185_000, 186_000]);
    await Promise.all([once(agentServer, "close"), boardServer.close()]);
    expect(agentServer.listening).toBe(false);
  });

  it("stays closed beside a stand-in board server that reports no address", () => {
    const standIn = { on: vi.fn(), once: vi.fn(), listen: vi.fn(), close: vi.fn() } as unknown as Server;
    const agentServer = startForkAgentPort(createApp(db).app, standIn, 0);
    expect(agentServer.listening).toBe(false);
    expect(standIn.listen).not.toHaveBeenCalled();
    expect(standIn.once).not.toHaveBeenCalled();
  });

  it("logs a port in use and does not throw; names the danger when the board holds it", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    const holder: Server = createServer();
    await once(holder.listen(0, "127.0.0.1"), "listening");
    const port = (holder.address() as AddressInfo).port;
    try {
      const boardServer = createServer();
      const agentServer = startForkAgentPort(createApp(db).app, boardServer, port);
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
      expect(error.mock.calls[0]![0]).toMatchObject({ port });
      expect(String(error.mock.calls[0]![1])).toContain(String(port));
      expect(agentServer.listening).toBe(false);
      expect(() => boardServer.emit("close")).not.toThrow();
      startForkAgentPort(createApp(db).app, holder, port);
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(3));
      expect(String(error.mock.calls[1]![1])).toMatch(/board listens on port \d+, the agent port/);
    } finally {
      holder.close();
    }
  });
});
