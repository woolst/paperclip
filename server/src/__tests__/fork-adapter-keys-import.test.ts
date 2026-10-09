import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The fork's keys in a claude_local adapter config (fork C10). The import keeps
// unknown adapter keys today; an upstream change that drops one fails here.
const forkAdapterConfig = {
  engine: "cli",
  mountedBox: true,
  boxMounts: "/srv/boxes/mounts.json",
  boxShareDir: "/opt/paperclip",
  boxApiUrl: "http://127.0.0.1:3100",
  ultracode: true,
  thinking: false,
  autoMemory: false,
  pluginDirs: ["woolst@woolst-skills", "/root/.claude/plugins/cache/example"],
};

// The mocks of company-portability.test.ts, each method resolving to an empty list.
const mocks = (...names: string[]) => Object.fromEntries(names.map((name) => [name, vi.fn().mockResolvedValue([])]));

const companySvc = mocks("getById", "list", "create", "update");
const agentSvc = mocks("list", "create", "update");
const accessSvc = mocks("ensureMembership", "ensureRoleDefaultGrants", "listActiveUserMemberships", "copyActiveUserMemberships", "setPrincipalPermission");
const projectSvc = mocks("list", "create", "update", "createWorkspace", "listWorkspaces");
const issueSvc = mocks(
  "list", "listComments", "getById", "getByIdentifier", "create", "addComment", "listLabels", "createLabel",
  "getRelationSummaries", "listAttachments", "createAttachment", "importIssues", "archiveImportedInbox",
  "addImportedComments", "addImportedAttachments",
);
const documentSvc = mocks("listIssueDocuments", "upsertIssueDocument", "createIssueDocumentsForImport");
const workProductSvc = mocks("listForIssue", "createForIssue", "createManyForImport");
const routineSvc = mocks("list", "getDetail", "create", "createTrigger");
const companySkillSvc = mocks("list", "listFull", "readFile", "importPackageFiles");
const assetSvc = mocks("getById", "create");
const secretSvc = {
  ...mocks("create", "remove", "syncEnvBindingsForTarget"),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  normalizeEnvBindingsForPersistence: vi.fn(async (_companyId: string, env: Record<string, unknown>) => env),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config, secretKeys: new Set<string>() })),
};
const agentInstructionsSvc = {
  exportFiles: vi.fn(async () => ({ files: { "AGENTS.md": "You are BoxCoder." }, entryFile: "AGENTS.md", warnings: [] })),
  materializeManagedBundle: vi.fn(async (agent: { adapterConfig?: Record<string, unknown> }) => ({ bundle: null, adapterConfig: agent.adapterConfig ?? {} })),
  updateBundle: vi.fn(async (agent: { adapterConfig?: Record<string, unknown> }) => ({ bundle: null, adapterConfig: agent.adapterConfig ?? {} })),
};
const instanceSettingsSvc = { getExperimental: vi.fn(async () => ({ enableNativeRunner: false })) };
const managedAgentProfileSvc = mocks("requireQualified");
const remoteAgentProfileSvc = mocks("requireQualified");

vi.mock("../services/companies.js", () => ({ companyService: () => companySvc }));
vi.mock("../services/agents.js", () => ({ agentService: () => agentSvc }));
// Upstream creates an imported agent through the agent lifecycle; as in company-portability.test.ts, it lands on the agent create.
vi.mock("../services/agent-lifecycle.js", () => ({ createAgentLifecycle: () => ({ requestHire: (...args: unknown[]) => agentSvc.create(...args) }) }));
vi.mock("../services/access.js", () => ({ accessService: () => accessSvc }));
vi.mock("../services/projects.js", () => ({ projectService: () => projectSvc }));
vi.mock("../services/issues.js", () => ({ issueService: () => issueSvc }));
vi.mock("../services/documents.js", () => ({
  documentService: () => documentSvc,
  extractLegacyPlanBody: () => null,
  mapIssueDocumentRow: (row: unknown) => row,
  issueDocumentSelect: {},
}));
vi.mock("../services/work-products.js", () => ({ workProductService: () => workProductSvc, toIssueWorkProduct: (row: unknown) => row }));
vi.mock("../services/routines.js", () => ({ routineService: () => routineSvc }));
vi.mock("../services/company-skills.js", () => ({ companySkillService: () => companySkillSvc }));
vi.mock("../services/assets.js", () => ({ assetService: () => assetSvc }));
vi.mock("../services/secrets.js", () => ({ secretService: () => secretSvc }));
vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: () => agentInstructionsSvc,
  agentInstructionsBundleMode: (agent: { adapterConfig?: unknown }) => {
    const config = agent.adapterConfig as Record<string, unknown> | undefined;
    return config?.instructionsBundleMode === "external" ? "external" : "managed";
  },
}));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => instanceSettingsSvc }));
vi.mock("../services/managed-agent-profiles.js", () => ({ managedAgentProfileService: () => managedAgentProfileSvc }));
vi.mock("../services/remote-agent-profiles.js", () => ({ remoteAgentProfileService: () => remoteAgentProfileSvc }));
vi.mock("../routes/org-chart-svg.js", () => ({ renderOrgChartPng: vi.fn(async () => Buffer.from("png")) }));

const { companyPortabilityService } = await import("../services/company-portability.js");

type Files = Awaited<ReturnType<ReturnType<typeof companyPortabilityService>["exportBundle"]>>["files"];
const include = { company: true, agents: true, projects: false, issues: false };

// Exports one claude_local agent with the fork's adapter config.
async function exportForkAgent() {
  companySvc.getById.mockResolvedValue({
    id: "company-1", name: "Paperclip", description: null, issuePrefix: "PAP",
    logoAssetId: null, logoUrl: null, requireBoardApprovalForNewAgents: false,
  });
  companySvc.create.mockResolvedValue({ id: "company-imported", name: "Imported Paperclip", requireBoardApprovalForNewAgents: false });
  agentSvc.list.mockResolvedValue([{
    id: "agent-1", name: "BoxCoder", status: "idle", role: "engineer", title: "Software Engineer", icon: "code",
    reportsTo: null, capabilities: "Writes code", adapterType: "claude_local", adapterConfig: { ...forkAdapterConfig },
    runtimeConfig: {}, budgetMonthlyCents: 0, permissions: {}, metadata: null,
  }]);
  agentSvc.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({ id: "agent-imported", ...input }));
  agentSvc.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
  const portability = companyPortabilityService({} as any);
  const exported = await portability.exportBundle("company-1", { include });
  agentSvc.list.mockResolvedValue([]);
  return { portability, rootPath: exported.rootPath, files: exported.files };
}

// Writes the package to a folder, as it lies on the Mac; the import uses its files in place (fork: no copy).
async function packageFolder(files: Files): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fork-keys-import-")));
  for (const [file, entry] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), typeof entry === "string" ? Buffer.from(entry, "utf8") : Buffer.from(entry.data, "base64"));
  }
  return root;
}

// Imports the bundle and reads back the fork's keys of the config handed to the agent create.
async function importAndReadBack(portability: ReturnType<typeof companyPortabilityService>, rootPath: string, files: Files) {
  agentSvc.create.mockClear();
  const localRoot = await packageFolder(files);
  await portability.importBundle({
    source: { type: "inline", rootPath, files, localRoot },
    include,
    target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
    agents: "all",
    collisionStrategy: "rename",
  }, "user-1").finally(() => fs.rm(localRoot, { recursive: true, force: true }));
  expect(agentInstructionsSvc.materializeManagedBundle).not.toHaveBeenCalled();
  const created = agentSvc.create.mock.calls.find(([, input]) => input?.name === "BoxCoder");
  expect(created).toBeDefined();
  const config = (created?.[1]?.adapterConfig ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(forkAdapterConfig).map((key) => [key, config[key]]));
}

describe("fork adapter keys through export and import", () => {
  it("the import hands the agent create every fork key of the bundle, the false values included", async () => {
    const { portability, rootPath, files } = await exportForkAgent();
    // The bundle carries the false values, as the fork's export must write them.
    const extension = String(files[".paperclip.yaml"]);
    const withFalse = extension.includes("autoMemory: false") ? extension
      : extension.replace(/^(\s*)ultracode: true$/m, "$1ultracode: true\n$1thinking: false\n$1autoMemory: false");
    expect(withFalse).toContain("autoMemory: false");
    expect(await importAndReadBack(portability, rootPath, { ...files, ".paperclip.yaml": withFalse })).toStrictEqual(forkAdapterConfig);
  });

  // The real round trip. It fails while the export prunes false values
  // (company-portability.ts, dropFalseBooleans): an imported agent then runs with auto-memory on.
  it("the export and the import keep every fork key, the false values included", async () => {
    const { portability, rootPath, files } = await exportForkAgent();
    expect(await importAndReadBack(portability, rootPath, files)).toStrictEqual(forkAdapterConfig);
  });
});
