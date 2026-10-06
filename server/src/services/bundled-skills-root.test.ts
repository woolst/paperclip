import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companySkills, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";
import { isPaperclipSkillsRoot } from "./bundled-skills-root.js";
import { PAPERCLIP_CORE_SKILL_KEYS, companySkillService } from "./company-skills.js";

const forkSkillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills");
const tempDirs: string[] = [];

async function makeTemp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(dir: string, name: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n# ${name}\n`);
}

// A folder shaped as the owner's projects folder: its `skills` is the woolst repository.
async function makeProjectsFolder() {
  const projects = await makeTemp("fork-projects-");
  await writeSkill(path.join(projects, "skills", "plugins", "woolst", "skills", "record-hygiene"), "record-hygiene");
  return projects;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("isPaperclipSkillsRoot", () => {
  it("refuses a skills folder of another repository", async () => {
    const projects = await makeProjectsFolder();
    expect(isPaperclipSkillsRoot(path.join(projects, "skills"))).toBe(false);
  });

  it("takes the fork's own skills folder", () => {
    expect(isPaperclipSkillsRoot(forkSkillsDir)).toBe(true);
  });

  it("takes a published layout that holds the core skill alone", async () => {
    const published = await makeTemp("fork-published-");
    await writeSkill(path.join(published, "paperclip"), "paperclip");
    expect(isPaperclipSkillsRoot(published)).toBe(true);
  });

  it("refuses a folder that does not exist", () => {
    expect(isPaperclipSkillsRoot(path.join(os.tmpdir(), `fork-missing-${randomUUID()}`))).toBe(false);
  });

  it("refuses a core skill whose SKILL.md is a folder", async () => {
    const odd = await makeTemp("fork-odd-");
    await fs.mkdir(path.join(odd, "paperclip", "SKILL.md"), { recursive: true });
    expect(isPaperclipSkillsRoot(odd)).toBe(false);
  });

});

describe("the skill routes from a foreign working folder", () => {
  it("serve the Claude skills and the fork's skills, and no skill of the woolst folder", async () => {
    const claudeHome = await makeTemp("fork-claude-home-");
    await writeSkill(path.join(claudeHome, "skills", "my-skill"), "my-skill");
    const projects = await makeProjectsFolder();
    await writeSkill(path.join(projects, "skills", "woolst-only"), "woolst-only");
    const options = { deploymentMode: "local_trusted", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [] };
    const app = express();
    app.use((req, _res, next) => { (req as any).actor = { type: "board" }; next(); });
    app.use("/api", accessRoutes({} as any, options as any), errorHandler);
    vi.stubEnv("CLAUDE_HOME", claudeHome);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(projects);
    try {
      expect((await request(app).get("/api/skills/my-skill")).text).toContain("name: my-skill");
      expect((await request(app).get("/api/skills/woolst-only")).status).toBe(404);
      expect((await request(app).get("/api/skills/paperclip")).text).toContain("name: paperclip");
      const { body } = await request(app).get("/api/skills/available");
      const managed = body.skills.filter((skill: any) => skill.isPaperclipManaged).map((skill: any) => skill.name);
      expect(managed).toContain("paperclip");
      expect(managed.filter((name: string) => name === "woolst-only" || name === "plugins")).toEqual([]);
    } finally {
      cwd.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("bundled skills seeding from a foreign working folder", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipInstanceId: string | undefined;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bundled-skills-root-");
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    oldPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = await makeTemp("fork-paperclip-home-");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldPaperclipInstanceId;
    await tempDb?.cleanup();
  });

  it("skips the working folder's woolst skills and seeds the five core skills", async () => {
    const projects = await makeProjectsFolder();
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fork", issuePrefix: "FRK" });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(projects);
    try {
      await companySkillService(db).list(companyId);
    } finally {
      cwd.mockRestore();
    }
    const rows = await db.select().from(companySkills).where(eq(companySkills.companyId, companyId));
    const keys = rows.map((row) => row.key);
    expect(keys).toEqual(expect.arrayContaining([...PAPERCLIP_CORE_SKILL_KEYS]));
    expect(keys.filter((key) => key.includes("record-hygiene") || key.includes("woolst"))).toEqual([]);
  }, 60_000);
});
