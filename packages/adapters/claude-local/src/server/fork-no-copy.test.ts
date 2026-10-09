import { describe, expect, it } from "vitest";
import { buildRemoteClaudeConfigMaterializationCommand, prepareClaudeConfigSeed } from "./claude-config.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";
import { forkInstructionsBody, forkLoggedArgs } from "./fork-run-args.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Fork: no Claude settings are copied, and the prompt bundle holds no copy of the instructions.
describe("no Claude copy", () => {
  it("refuses the settings seed and its copy in a target", async () => {
    await expect(prepareClaudeConfigSeed(process.env, async () => {}, "c")).rejects.toThrow(/^Fork: Paperclip never copies files for a run \(the Claude settings seed is disabled\)\.$/);
    expect(() => buildRemoteClaudeConfigMaterializationCommand({ remoteClaudeConfigDir: "/a", remoteClaudeConfigSeedDir: "/b" }))
      .toThrow(/^Fork: Paperclip never copies files for a run \(the Claude settings copy in a target is disabled\)\.$/);
  });

  it("writes no instruction file into the prompt bundle and gives the text to pass inline", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "fork-prompt-bundle-"));
    const previous = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    try {
      const bundle = await prepareClaudePromptBundle({ companyId: "c", skills: [], instructionsContents: "Lead.\n", onLog: async () => {} });
      expect(bundle.instructionsFilePath).toBeNull();
      expect(bundle.instructionsText).toBe("Lead.\n");
      const files = (await fs.readdir(home, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
      expect(files).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previous;
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("keeps the instructions out of the logged command, by their size in their place", () => {
    expect(forkLoggedArgs(["--print", "--append-system-prompt", "Lead the company.", "--model", "m"]))
      .toEqual(["--print", "--append-system-prompt", "[agent instructions: 17 characters, read in place, not logged]", "--model", "m"]);
    expect(forkLoggedArgs(["--print", "--model", "m"])).toEqual(["--print", "--model", "m"]);
  });

  it("takes an in-place instruction file's body without its front matter", () => {
    expect(forkInstructionsBody("---\nname: CEO\nskills:\n  - paperclip\n---\n\nLead.\n")).toBe("Lead.\n");
    expect(forkInstructionsBody("---\r\nname: CEO\r\n---\r\nLead.\r\n")).toBe("Lead.\r\n");
    expect(forkInstructionsBody("Lead.\n---\nnot front matter\n---\n")).toBe("Lead.\n---\nnot front matter\n---\n");
    expect(forkInstructionsBody("No front matter.\n")).toBe("No front matter.\n");
  });
});
