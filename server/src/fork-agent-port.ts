// Fork: the agent port. Paperclip in local_trusted mode treats every request
// without a key as the board with instance admin rights. A tunnel from a box
// to the board port would hand the board to the box. The agent port is a
// second listener on 127.0.0.1 where only a valid agent key gets through.
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NextFunction, Request, Response } from "express";
import { unauthorized } from "./errors.js";
import { logger } from "./middleware/logger.js";

export const FORK_AGENT_PORT = 3101;

const agentPortRequests = new WeakSet<object>();
const bearerHeader = /^bearer(?:\s|$)/i;
// Same pattern as the public MCP gateway bypass of the actor middleware; that
// route validates its own run-scoped bearer.
const publicMcpGatewayProtocolPath = /^\/mcp\/gateways\/gw_[a-f0-9]{32}\/?$/i;

export function createForkAgentPortServer(app: unknown): Server {
  const handle = app as RequestListener;
  return createServer((req: IncomingMessage, res) => {
    agentPortRequests.add(req);
    // Close routes mounted before the actor middleware too.
    if (!bearerHeader.test(req.headers.authorization ?? "")) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    handle(req, res);
  });
}

export function startForkAgentPort(app: unknown, boardServer: Server, port = FORK_AGENT_PORT): Server {
  const server = createForkAgentPortServer(app);
  // A board server that reports no address is a stand-in, not a listening server (upstream's startup
  // tests mock node:http): the agent port stays closed beside it.
  if (typeof boardServer.address !== "function") return server;
  // Box clients reuse connections through the tunnel, as browsers do on the board port.
  server.keepAliveTimeout = boardServer.keepAliveTimeout;
  server.headersTimeout = boardServer.headersTimeout;
  const boardAddress = boardServer.address();
  if (boardAddress && typeof boardAddress === "object" && boardAddress.port === port) {
    // detectPort moved the board here, or a worktree instance took source port + 1.
    logger.error({ port }, `The board listens on port ${port}, the agent port: a box tunnel to ${port} reaches the board ` +
      `with admin rights. Stop the tunnels, free port ${port} and restart Paperclip.`);
  }
  server.on("error", (err: Error) => {
    // The board keeps serving when the agent port cannot listen.
    logger.error({ err, port }, `Agent port 127.0.0.1:${port} is not listening: ${err.message}`);
  });
  server.listen(port, "127.0.0.1", () => {
    const bound = (server.address() as AddressInfo | null)?.port ?? port;
    logger.info(`Agent port listening on 127.0.0.1:${bound}; only agent keys are accepted`);
  });
  boardServer.once("close", () => {
    if (server.listening) server.close();
  });
  return server;
}

export function forkAgentPortNext(req: Request, _res: Response, next: NextFunction): NextFunction {
  if (!agentPortRequests.has(req)) return next;
  return ((err?: unknown) => {
    // An error, "route" or "router" passes on unchanged; null is no error.
    if (err) {
      next(err);
      return;
    }
    if (req.actor?.type === "agent") {
      next();
      return;
    }
    req.actor = { type: "none", source: "none" };
    if (publicMcpGatewayProtocolPath.test(req.path)) {
      next();
      return;
    }
    next(unauthorized());
  }) as NextFunction;
}
