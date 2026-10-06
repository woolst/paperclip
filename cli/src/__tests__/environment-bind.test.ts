import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEnvironmentBind } from "../commands/client/environment-bind.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const BASE = "http://localhost:3100";
const ENVIRONMENTS = [
  { id: "env-old-local", name: "Local", driver: "local", status: "archived" },
  { id: "env-local", name: "Local", driver: "local", status: "active" },
  { id: "env-box1", name: "Box One SSH", driver: "ssh", status: "active" },
];

type StubAgent = { id: string; name: string; metadata: Record<string, unknown> | null; defaultEnvironmentId: string | null };

function company(): StubAgent[] {
  return [
    { id: "a-ceo", name: "CEO", metadata: { environment: "Local" }, defaultEnvironmentId: null },
    { id: "a-mac", name: "Mac Operator", metadata: { environment: "Local" }, defaultEnvironmentId: null },
    { id: "a-box", name: "Box Engineer", metadata: { environment: "Box One SSH" }, defaultEnvironmentId: null },
    { id: "a-none", name: "Helper", metadata: { role: "helper" }, defaultEnvironmentId: null },
    { id: "a-blank", name: "Blank", metadata: { environment: "" }, defaultEnvironmentId: null },
    { id: "a-null", name: "Bare", metadata: null, defaultEnvironmentId: null },
  ];
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
type StubFailure = { agentsStatus?: number; envStatus?: number; envBody?: unknown };

function stubApi(agents: StubAgent[], opts: StubFailure & { refuse?: Record<string, string> } = {}) {
  const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === `${BASE}/api/companies/${COMPANY_ID}/agents`) {
      return Promise.resolve(opts.agentsStatus ? json({ error: "Forbidden" }, opts.agentsStatus) : json(agents));
    }
    if (method === "GET" && url === `${BASE}/api/companies/${COMPANY_ID}/environments`) {
      return Promise.resolve(opts.envStatus ? json({ error: "Forbidden" }, opts.envStatus) : json(opts.envBody ?? ENVIRONMENTS));
    }
    if (method === "PATCH" && url.startsWith(`${BASE}/api/agents/`)) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      patches.push({ url, body });
      const id = url.slice(`${BASE}/api/agents/`.length);
      const reason = opts.refuse?.[id];
      if (reason) return Promise.resolve(json({ error: reason }, 422));
      const agent = agents.find((candidate) => candidate.id === id);
      if (agent) agent.defaultEnvironmentId = String(body.defaultEnvironmentId);
      return Promise.resolve(json(agent ?? {}));
    }
    return Promise.resolve(json({ error: "Not found" }, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return patches;
}

async function run(): Promise<{ lines: string[]; exitCode: number }> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerEnvironmentBind(program.command("environment"));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const args = ["environment", "bind", "--company", COMPANY_ID, "--api-base", BASE, "--api-key", "board-token"];
  await program.parseAsync(args, { from: "user" });
  const lines = log.mock.calls.map((call) => String(call[0]));
  const exitCode = exit.mock.calls.length > 0 ? Number(exit.mock.calls[0]?.[0]) : 0;
  [log, exit].forEach((spy) => spy.mockRestore());
  return { lines, exitCode };
}

describe("environment bind", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => (vi.unstubAllGlobals(), vi.restoreAllMocks()));

  it("binds each agent whose metadata names an environment, then a second run changes nothing", async () => {
    const agents = company();
    const patches = stubApi(agents);

    const first = await run();
    expect(first.lines).toEqual([
      "CEO: bound to Local.",
      "Mac Operator: bound to Local.",
      "Box Engineer: bound to Box One SSH.",
      "3 bound, 0 already bound, 0 failed.",
    ]);
    expect(first.exitCode).toBe(0);
    expect(patches).toEqual([
      { url: `${BASE}/api/agents/a-ceo`, body: { defaultEnvironmentId: "env-local" } },
      { url: `${BASE}/api/agents/a-mac`, body: { defaultEnvironmentId: "env-local" } },
      { url: `${BASE}/api/agents/a-box`, body: { defaultEnvironmentId: "env-box1" } },
    ]);
    for (const patch of patches) expect(Object.keys(patch.body)).toEqual(["defaultEnvironmentId"]);

    const second = await run();
    expect(second.lines).toEqual([
      "CEO: already bound to Local.",
      "Mac Operator: already bound to Local.",
      "Box Engineer: already bound to Box One SSH.",
      "0 bound, 3 already bound, 0 failed.",
    ]);
    expect(second.exitCode).toBe(0);
    expect(patches).toHaveLength(3);
  });

  it("reports a missing environment and a refusal as failed and exits 1", async () => {
    const agents = company();
    agents[1]!.metadata = { environment: "Box Two SSH" };
    const reason = "Environment driver ssh is not allowed for this adapter";
    const patches = stubApi(agents, { refuse: { "a-box": reason } });

    const result = await run();
    expect(result.lines).toEqual([
      "CEO: bound to Local.",
      "Mac Operator: no environment named Box Two SSH in this company.",
      `Box Engineer: refused: ${reason}.`,
      "1 bound, 0 already bound, 2 failed.",
    ]);
    expect(result.exitCode).toBe(1);
    expect(patches.map((patch) => patch.url)).toEqual([`${BASE}/api/agents/a-ceo`, `${BASE}/api/agents/a-box`]);
  });

  it.each<[string, StubFailure, string]>([
    ["agents list fails", { agentsStatus: 403 }, "Forbidden"],
    ["environments list fails", { envStatus: 403 }, "Forbidden"],
    ["environments read is not a list", { envBody: { rows: [] } }, "The environments list could not be read."],
  ])("exits 2 with nothing changed when the %s", async (_case, failure, message) => {
    const patches = stubApi(company(), failure);

    const result = await run();
    expect(result.lines).toEqual([]);
    expect(result.exitCode).toBe(2);
    expect(patches).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(message));
  });
});
