// Fork plugin folders (fork commit 8). Each item of the adapter key pluginDirs becomes one
// `--plugin-dir <path>`, read fresh at every run and never stored, with no fallback folder: an
// item that opens with "/" is a box folder and passes as it is; any other item is a plugin of the
// Mac's registry (checks record K2), mapped into the box on a box run. A refusal ends the run
// before launch with error code fork_run_refused, through forkRunRefusal (fork-run-args.ts).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import { BOX_REFUSALS, defaultBoxMountsPath, mapToBox, type BoxMount } from "./mounted-box.js";

/** The box folder of the Mac's plugin cache, mounted read-only in every box. */
export const BOX_PLUGIN_CACHE = "/root/.claude/plugins/cache";

export const PLUGIN_DIRS_REFUSAL = "Each plugin folder must be a plugin name or a box folder.";

export function pluginNotInstalled(name: string): string {
  return `The plugin ${name} is not installed on the Mac.`;
}

export type PluginDirs = { args: string[]; refusal: null } | { args: null; refusal: string };

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The mount table as readBoxMounts reads it, read synchronously as the callers of these flags are. */
export function readBoxMountsSync(file: string): BoxMount[] | null {
  const mounts = (readJson(file) as { mounts?: unknown } | null)?.mounts;
  if (!Array.isArray(mounts)) return null;
  const rows: BoxMount[] = [];
  for (const row of mounts) {
    const { mac, box } = (row ?? {}) as { mac?: unknown; box?: unknown };
    if (typeof mac !== "string" || !path.isAbsolute(mac) || typeof box !== "string" || !box.startsWith("/")) return null;
    rows.push({ mac: path.resolve(mac), box: path.posix.normalize(box) });
  }
  return rows;
}

/** The install folder of a plugin in the Mac's registry (checks record K2), or null. */
export function pluginInstallFolder(home: string, name: string): string | null {
  const registry = readJson(path.join(home, ".claude", "plugins", "installed_plugins.json")) as
    { version?: unknown; plugins?: unknown } | null;
  const plugins = registry?.version === 2 ? registry.plugins : null;
  if (!plugins || typeof plugins !== "object" || !Object.prototype.hasOwnProperty.call(plugins, name)) return null;
  const entries = (plugins as Record<string, unknown>)[name];
  if (!Array.isArray(entries)) return null;
  const entry = entries.find((one) => (one as { scope?: unknown } | null)?.scope === "user") as
    { installPath?: unknown } | undefined;
  const installPath = entry?.installPath;
  if (typeof installPath !== "string" || !path.isAbsolute(installPath)) return null;
  const folder = path.resolve(installPath);
  return isFile(path.join(folder, ".claude-plugin", "plugin.json")) ? folder : null;
}

/** The `--plugin-dir` flags of this config, or the refusal text of the first item that fails. */
export function forkPluginDirs(config: Record<string, unknown>): PluginDirs {
  const items: unknown[] = Array.isArray(config.pluginDirs) ? config.pluginDirs : [];
  if (!items.every((item) => typeof item === "string" && item.trim() !== "")) {
    return { args: null, refusal: PLUGIN_DIRS_REFUSAL };
  }
  const args: string[] = [];
  let home = "";
  for (const raw of items as string[]) {
    const item = raw.trim();
    if (item.startsWith("/")) {
      args.push("--plugin-dir", item);
      continue;
    }
    home ||= os.userInfo().homedir;
    const macFolder = pluginInstallFolder(home, item);
    if (!macFolder) return { args: null, refusal: pluginNotInstalled(raw) };
    if (config.mountedBox !== true) {
      args.push("--plugin-dir", macFolder);
      continue;
    }
    const cache = { mac: path.join(home, ".claude", "plugins", "cache"), box: BOX_PLUGIN_CACHE };
    let folder = mapToBox([cache], macFolder);
    if (!folder) {
      const file = asString(config.boxMounts, "").trim() || defaultBoxMountsPath();
      const rows = readBoxMountsSync(file);
      if (!rows) return { args: null, refusal: BOX_REFUSALS.badTable(file) };
      folder = mapToBox(rows, macFolder);
      if (!folder) return { args: null, refusal: BOX_REFUSALS.notMounted(macFolder) };
    }
    args.push("--plugin-dir", folder);
  }
  return { args, refusal: null };
}

/** The `--plugin-dir` flags. forkRunRefusal has refused the run before; a refusal here throws. */
export function forkPluginDirArgs(config: Record<string, unknown>): string[] {
  const answer = forkPluginDirs(config);
  if (answer.refusal !== null) throw new Error(answer.refusal);
  return answer.args;
}
