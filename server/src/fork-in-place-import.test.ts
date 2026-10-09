import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forkAssertInPlace, forkInstructionsBundle, forkSkillsInPlace, IN_PLACE_TEXT, packageHoldsAgentsOrSkills } from "./fork-in-place-import.js";

let root = "";
const files = {
  "COMPANY.md": "# Co\n",
  "agents/ceo/AGENTS.md": "---\nname: CEO\n---\nLead.\n",
  "skills/company/KUL/notes/SKILL.md": "---\nname: notes\n---\nNotes.\n",
};

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fork-in-place-")));
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text, "utf8");
  }
  await fs.writeFile(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function refusalOf(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => (error as Error).message);
}

describe("an import in place", () => {
  it("is refused without the package's folder when the package holds agents or skills", async () => {
    expect(packageHoldsAgentsOrSkills(files)).toBe(true);
    expect(await refusalOf(forkAssertInPlace({ type: "inline", files }, files))).toBe(IN_PLACE_TEXT.noRoot);
    expect(await refusalOf(forkAssertInPlace({ type: "github", url: "https://github.com/a/b" }, files))).toBe(IN_PLACE_TEXT.noRoot);
    const onlyCompany = { "COMPANY.md": "# Co\n" };
    expect(await forkAssertInPlace({ type: "inline", files: onlyCompany }, onlyCompany)).toBeNull();
  });

  it("is refused for a folder that is not an absolute folder, or for a source that is not inline", async () => {
    expect(await refusalOf(forkAssertInPlace({ type: "inline", files, localRoot: "relative/co" }, files))).toBe(IN_PLACE_TEXT.badRoot("relative/co"));
    const missing = path.join(root, "missing");
    expect(await refusalOf(forkAssertInPlace({ type: "inline", files, localRoot: missing }, files))).toBe(IN_PLACE_TEXT.badRoot(missing));
    expect(await refusalOf(forkAssertInPlace({ type: "github", url: "https://x", localRoot: root }, files))).toBe(IN_PLACE_TEXT.badRoot(root));
  });

  it("is refused when a sent file differs from the folder's, is missing there, or lies outside it", async () => {
    const changed = { ...files, "agents/ceo/AGENTS.md": "Lead differently.\n" };
    expect(await refusalOf(forkAssertInPlace({ type: "inline", files: changed, localRoot: root }, changed))).toBe(IN_PLACE_TEXT.differs("agents/ceo/AGENTS.md"));
    const extra = { ...files, "agents/cto/AGENTS.md": "New.\n" };
    expect(await refusalOf(forkAssertInPlace({ type: "inline", files: extra, localRoot: root }, extra))).toBe(IN_PLACE_TEXT.differs("agents/cto/AGENTS.md"));
    const outside = { ...files, "../escape.md": "x" };
    expect(await refusalOf(forkAssertInPlace({ type: "inline", files: outside, localRoot: root }, outside))).toBe(IN_PLACE_TEXT.differs("../escape.md"));
  });

  it("decides by the manifest that a package holds agents, wherever their files lie", async () => {
    const rootAgent = { "AGENTS.md": "Lead.\n" };
    expect(await refusalOf(forkAssertInPlace({ type: "inline", files: rootAgent }, rootAgent, { agents: [{ slug: "a" }] }))).toBe(IN_PLACE_TEXT.noRoot);
    const teamAgent = { "team/ceo/AGENTS.md": "Lead.\n" };
    expect(await refusalOf(forkAssertInPlace({ type: "inline", files: teamAgent }, teamAgent))).toBe(IN_PLACE_TEXT.noRoot);
  });

  it("is the board's: the agent-safe route takes no folder", async () => {
    expect(await refusalOf(forkAssertInPlace({ type: "inline", files, localRoot: root }, files, undefined, "agent_safe"))).toBe(IN_PLACE_TEXT.agentSafe);
  });

  it("is refused for a sent file that leads out of the folder through a link", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fork-in-place-out-")));
    try {
      await fs.writeFile(path.join(outside, "secret.md"), "x", "utf8");
      await fs.symlink(path.join(outside, "secret.md"), path.join(root, "linked.md"));
      const sent = { ...files, "linked.md": "x" };
      expect(await refusalOf(forkAssertInPlace({ type: "inline", files: sent, localRoot: root }, sent))).toBe(IN_PLACE_TEXT.escapes("linked.md"));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("gives the folder when every sent file matches it, text and base64 alike", async () => {
    const sent = { ...files, "logo.png": { encoding: "base64", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64") } };
    expect(await forkAssertInPlace({ type: "inline", files: sent, localRoot: `${root}/` }, sent)).toBe(root);
  });

  it("keeps each skill in its folder in the package", () => {
    const skills = [{ packageDir: "skills/company/KUL/notes", sourceType: "catalog", sourceLocator: null, sourceRef: "abc", metadata: { sourceKind: "catalog", a: 1 } }];
    forkSkillsInPlace(skills, root);
    expect(skills[0]).toEqual({ packageDir: "skills/company/KUL/notes", sourceType: "local_path", sourceLocator: path.join(root, "skills/company/KUL/notes"),
      sourceRef: null, metadata: { sourceKind: "local_path", a: 1 } });
    const untouched = [{ packageDir: "x", sourceType: "catalog", sourceLocator: null, sourceRef: null, metadata: null }];
    forkSkillsInPlace(untouched, null);
    expect(untouched[0]!.sourceType).toBe("catalog");
  });

  it("points the agent's instructions at its file in the package and writes nothing", async () => {
    const instructions = { materializeManagedBundle: vi.fn(), updateBundle: vi.fn(async () => ({ adapterConfig: { instructionsBundleMode: "external" } })) };
    const before = await fs.readdir(root, { recursive: true });
    const done = await forkInstructionsBundle(root, instructions, "agents/ceo/AGENTS.md", { id: "a" }, { "AGENTS.md": "Lead.\n" }, { replaceExisting: true });
    expect(done).toEqual({ adapterConfig: { instructionsBundleMode: "external" } });
    expect(instructions.updateBundle).toHaveBeenCalledWith({ id: "a" }, {
      mode: "external", rootPath: path.join(root, "agents", "ceo"), entryFile: "AGENTS.md", clearLegacyPromptTemplate: true });
    expect(instructions.materializeManagedBundle).not.toHaveBeenCalled();
    expect(await fs.readdir(root, { recursive: true })).toEqual(before);
    expect(await refusalOf(forkInstructionsBundle(root, instructions, "agents/cto/AGENTS.md", { id: "a" }, {}, {}))).toBe(IN_PLACE_TEXT.noEntry("agents/cto/AGENTS.md"));
    expect(await refusalOf(forkInstructionsBundle(root, instructions, "../outside/AGENTS.md", { id: "a" }, {}, {}))).toBe(IN_PLACE_TEXT.noEntry("../outside/AGENTS.md"));
  });

  it("writes no managed bundle without the package's folder", async () => {
    const instructions = { materializeManagedBundle: vi.fn(async () => ({ adapterConfig: {} })), updateBundle: vi.fn() };
    expect(await refusalOf(forkInstructionsBundle(null, instructions, "agents/ceo/AGENTS.md", { id: "a" }, { "AGENTS.md": "From the template.\n" }, {}))).toBe(IN_PLACE_TEXT.noRoot);
    expect(instructions.materializeManagedBundle).not.toHaveBeenCalled();
    expect(instructions.updateBundle).not.toHaveBeenCalled();
  });
});
