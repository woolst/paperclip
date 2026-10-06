import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOX_PLUGIN_CACHE, PLUGIN_DIRS_REFUSAL, forkPluginDirArgs, readBoxMountsSync } from "./fork-plugin-dirs.js";
import { FORK_RUN_REFUSED, forkRefuseRun, forkRunRefusal, forkSettingsArgs } from "./fork-run-args.js";
import { BOX_REFUSALS, readBoxMounts } from "./mounted-box.js";

const NAME = "woolst@woolst-skills";
let root = "";
let home = "";

function plugin(folder: string, withManifest = true): string {
  fs.mkdirSync(path.join(folder, ".claude-plugin"), { recursive: true });
  if (withManifest) fs.writeFileSync(path.join(folder, ".claude-plugin", "plugin.json"), '{"name":"woolst"}');
  return folder;
}

function cached(version: string, withManifest = true): string {
  return plugin(path.join(home, ".claude", "plugins", "cache", "woolst-skills", "woolst", version), withManifest);
}

/** The registry in the layout of checks record K2; the entries of `first` come before the user install. */
function registry(owner: string, plugins: Record<string, string>, first: object[] = []): void {
  const file = path.join(owner, ".claude", "plugins", "installed_plugins.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entries = Object.fromEntries(Object.entries(plugins).map(([name, installPath]) => [name, [...first, {
    scope: "user", installPath, version: path.basename(installPath), installedAt: "2026-10-05T05:34:59.101Z",
    lastUpdated: "2026-10-05T05:34:59.101Z", gitCommitSha: "3a1333a1d458edf5ac34d1141f96e81826ef5879",
  }]]));
  fs.writeFileSync(file, JSON.stringify({ version: 2, plugins: entries }));
}

/** The default mount table under the account home. */
function mounts(rows: Array<{ mac: string; box: string }>): string {
  const file = path.join(home, "Library", "Application Support", "boxes", "mounts.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mounts: rows.map((row) => ({ ...row, readOnly: true })) }));
  return file;
}

const boxRun = { engine: "cli", mountedBox: true, pluginDirs: [NAME] };
const macRun = { engine: "cli", pluginDirs: [NAME] };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fork-plugin-dirs-"));
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  vi.spyOn(os, "userInfo").mockReturnValue({ uid: 501, gid: 20, username: "owner", homedir: home, shell: "/bin/zsh" });
  mounts([{ mac: path.join(root, "projects"), box: "/data/projects" }]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("fork plugin folders", () => {
  it("a box run maps the cached install to the box cache, ahead of any row; a run on the Mac takes it as it is", () => {
    const folder = cached("4.1.0");
    registry(home, { [NAME]: folder });
    expect(forkPluginDirArgs(boxRun)).toEqual(["--plugin-dir", "/root/.claude/plugins/cache/woolst-skills/woolst/4.1.0"]);
    expect(forkRunRefusal(boxRun, "cli")).toBeNull();
    mounts([{ mac: home, box: "/data/home" }]);
    expect(forkPluginDirArgs(boxRun)).toEqual(["--plugin-dir", `${BOX_PLUGIN_CACHE}/woolst-skills/woolst/4.1.0`]);
    expect(forkPluginDirArgs(macRun)).toEqual(["--plugin-dir", folder]);
  });

  it("reads the registry fresh, and takes the user install when another scope comes first", () => {
    registry(home, { [NAME]: cached("4.1.0") });
    expect(forkPluginDirArgs(boxRun)[1]).toBe(`${BOX_PLUGIN_CACHE}/woolst-skills/woolst/4.1.0`);
    registry(home, { [NAME]: cached("4.2.0") }, [{ scope: "project", projectPath: root, installPath: cached("4.0.0") }]);
    expect(forkPluginDirArgs(boxRun)[1]).toBe(`${BOX_PLUGIN_CACHE}/woolst-skills/woolst/4.2.0`);
    expect(forkPluginDirArgs(macRun)[1]).toBe(cached("4.2.0"));
  });

  it("refuses a plugin missing from the registry, without plugin.json, or with no registry", async () => {
    const text = "The plugin woolst@woolst-skills is not installed on the Mac.";
    const registryFile = path.join(home, ".claude", "plugins", "installed_plugins.json");
    for (const setup of [
      () => undefined,
      () => registry(home, { "other@woolst-skills": cached("4.1.0") }),
      () => registry(home, { [NAME]: cached("4.0.0", false) }),
      () => fs.writeFileSync(registryFile, '{"version":1,"plugins":{}}'),
    ]) {
      setup();
      for (const config of [boxRun, macRun]) {
        expect(forkRunRefusal(config, "cli")).toBe(text);
        expect(() => forkPluginDirArgs(config)).toThrow(text);
        const lines: string[] = [];
        const result = await forkRefuseRun({ config, onLog: async (_s, chunk) => void lines.push(chunk) }, "cli");
        expect(result).toMatchObject({ exitCode: 1, errorCode: FORK_RUN_REFUSED, errorMessage: text });
        expect(lines).toEqual([`[paperclip] ${text}\n`]);
      }
    }
    expect(forkRunRefusal({ ...macRun, pluginDirs: [`${NAME} `] }, "cli")).toBe(`The plugin ${NAME}  is not installed on the Mac.`);
  });

  it("on a box run, an install outside the cache needs a row of the mount table", async () => {
    const folder = plugin(path.join(root, "dev-plugins", "woolst"));
    registry(home, { [NAME]: folder });
    expect(forkRunRefusal(boxRun, "cli")).toBe(`This folder is not mounted in the box: ${folder}. Add it to the box mount table.`);
    const file = path.join(root, "missing.json");
    expect(forkRunRefusal({ ...boxRun, boxMounts: file }, "cli")).toBe(BOX_REFUSALS.badTable(file));
    expect(readBoxMountsSync(file)).toEqual(await readBoxMounts(file));
    const table = mounts([{ mac: path.join(root, "projects"), box: "/data/projects" }, { mac: root, box: "/data/root" },
      { mac: path.join(root, "dev-plugins"), box: "/data/plugins" }]);
    expect(readBoxMountsSync(table)).toEqual(await readBoxMounts(table));
    expect(forkPluginDirArgs(boxRun)).toEqual(["--plugin-dir", "/data/plugins/woolst"]);
    expect(forkPluginDirArgs(macRun)).toEqual(["--plugin-dir", folder]);
  });

  it("an absolute box folder passes as it is, with no registry and no read of the account", () => {
    vi.mocked(os.userInfo).mockImplementation(() => { throw new Error("no account record"); });
    for (const mountedBox of [true, false]) {
      const args = forkPluginDirArgs({ mountedBox, pluginDirs: ["/opt/plugins/one", " /opt/plugins/two "] });
      expect(args).toEqual(["--plugin-dir", "/opt/plugins/one", "--plugin-dir", "/opt/plugins/two"]);
    }
  });

  it("$HOME set to another folder with another registry changes nothing", () => {
    registry(home, { [NAME]: cached("4.1.0") });
    const other = path.join(root, "other-home");
    registry(other, { [NAME]: plugin(path.join(other, ".claude", "plugins", "cache", "woolst-skills", "woolst", "9.9.9")) });
    vi.stubEnv("HOME", other);
    expect(forkPluginDirArgs(boxRun)).toEqual(["--plugin-dir", `${BOX_PLUGIN_CACHE}/woolst-skills/woolst/4.1.0`]);
    expect(forkPluginDirArgs(macRun)).toEqual(["--plugin-dir", cached("4.1.0")]);
  });

  it("the run's arguments hold the flags before the extra arguments, and none when the list is empty", () => {
    const folder = cached("4.1.0");
    registry(home, { [NAME]: folder });
    const extraArgs = ["--verbose", "--max-turns", "3"];
    extraArgs.unshift(...forkSettingsArgs({ ...macRun, pluginDirs: [NAME, "/opt/plugins/one"] }));
    expect(extraArgs[0]).toBe("--settings");
    expect(extraArgs.slice(2)).toEqual(["--plugin-dir", folder, "--plugin-dir", "/opt/plugins/one", "--verbose", "--max-turns", "3"]);
    for (const config of [{}, { pluginDirs: [] }, { pluginDirs: null }, { mountedBox: true }]) {
      expect(forkSettingsArgs(config)).toHaveLength(2);
      expect(forkRunRefusal({ ...config, engine: "cli" }, "cli")).toBeNull();
    }
  });

  it("refuses a list item that is not a plugin name or a box folder", () => {
    for (const pluginDirs of [[NAME, 3], [" "], [NAME, null]]) {
      expect(forkRunRefusal({ engine: "cli", pluginDirs }, "cli")).toBe(PLUGIN_DIRS_REFUSAL);
      expect(() => forkSettingsArgs({ pluginDirs })).toThrow(PLUGIN_DIRS_REFUSAL);
    }
  });
});
