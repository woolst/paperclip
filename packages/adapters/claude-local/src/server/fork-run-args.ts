// Fork switches of the command-line engine (fork commit 4): ultracode, thinking, auto-memory.
//
// Every command-line run, resumed runs included, carries one `--settings` flag whose value is
// JSON text on the command line, never a file, so no settings file in a box, a project or the
// host can switch these keys. The text holds no `hooks` key; each key is one value.
//
// Adapter config keys:
// - ultracode (boolean, optional): sent as "ultracode"; absent is sent as false. Always in the text.
// - thinking (boolean, optional): read only on FORK_THINKING_MODELS, sent there as
//   "alwaysThinkingEnabled", absent as false. On every other model it is not read and not refused.
// - autoMemory (false, optional): false sends "autoMemoryEnabled": false; absent sends nothing.
// - pluginDirs (list, optional): one `--plugin-dir` per item after the `--settings` pair, so before
//   the agent's extra arguments; its items and refusals are in fork-plugin-dirs.ts (fork commit 8).
//
// Refused before any process starts, with error code fork_run_refused:
// - any of FORK_CLI_ONLY_KEYS set while the engine is not "cli" (no engine means ACP);
// - `--settings` or `--settings=` in extraArgs or args on the command-line engine;
// - ultracode true on FORK_NO_ULTRACODE_MODELS, where the key has no effect (card test T-U4).
//
// Effort: `--effort` and the ultracode key are both sent (checks record K5: U1 on, U2 off at
// high). A model with no effort list (claude-haiku-4-5) gets no `--effort`; a set effort is
// left out with one run-log line.

import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asStringArray } from "@paperclipai/adapter-utils/server-utils";
import { claudeLocalReasoningEffortsForModel, resolveClaudeModel } from "../index.js";
import { forkPluginDirArgs, forkPluginDirs } from "./fork-plugin-dirs.js";

export const FORK_RUN_REFUSED = "fork_run_refused";

/** Models where `alwaysThinkingEnabled: false` turns thinking off (checks record, K5). */
export const FORK_THINKING_MODELS: readonly string[] = ["claude-haiku-4-5"];

/** Models where `"ultracode": true` has no effect (checks record, card test T-U4). */
export const FORK_NO_ULTRACODE_MODELS: readonly string[] = ["claude-haiku-4-5"];

/** The auto-memory settings key (checks record, K5). */
export const FORK_AUTO_MEMORY_KEY = "autoMemoryEnabled";

/** Config keys that need the command-line engine. */
export const FORK_CLI_ONLY_KEYS: readonly string[] = [
  "mountedBox", "boxMounts", "boxShareDir", "boxApiUrl", "ultracode", "thinking", "autoMemory", "pluginDirs",
];

export const FORK_ENGINE_REFUSAL =
  "Box runs, ultracode, thinking, auto-memory and plugin folders need the command-line engine. Set engine to cli.";

export const FORK_SETTINGS_REFUSAL =
  "Remove --settings from this agent's extra arguments; Paperclip sets ultracode, thinking and auto-memory itself.";

type RunLog = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

function normalizedModelId(model: string): string {
  return model
    .trim()
    .replace(/\[1m\]$/, "")
    .replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, "");
}

/** The model id itself, or the id with a date suffix (`-20251001`, `@20251001`). */
function sameModel(id: string, known: string): boolean {
  if (!id.startsWith(known)) return false;
  const rest = id.slice(known.length);
  return rest === "" || /^[-@]\d{8}(?:\D|$)/.test(rest);
}

/** Whether the `thinking` key is read on this model. */
export function forkReadsThinking(model: string): boolean {
  const id = normalizedModelId(model);
  return FORK_THINKING_MODELS.some((known) => sameModel(id, known));
}

function isSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function holdsSettingsFlag(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((arg) => {
    if (typeof arg !== "string") return false;
    const flag = arg.trim();
    return flag === "--settings" || flag.startsWith("--settings=");
  });
}

/** The refusal text for this run, or null when the run may start. */
export function forkRunRefusal(
  config: Record<string, unknown>,
  engine: string | null | undefined,
): string | null {
  if (engine !== "cli") {
    return FORK_CLI_ONLY_KEYS.some((key) => isSet(config[key])) ? FORK_ENGINE_REFUSAL : null;
  }
  // The run reads `args` only when `extraArgs` holds no string (execute.ts 344-348).
  const fromExtraArgs = asStringArray(config.extraArgs);
  if (holdsSettingsFlag(fromExtraArgs.length > 0 ? fromExtraArgs : config.args)) {
    return FORK_SETTINGS_REFUSAL;
  }
  if (config.ultracode === true) {
    const env = config.env && typeof config.env === "object" ? (config.env as Record<string, unknown>) : {};
    const id = normalizedModelId(resolveClaudeModel(config.model, env));
    const known = FORK_NO_ULTRACODE_MODELS.find((model) => sameModel(id, model));
    if (known) return `Ultracode is not allowed on ${known}.`;
  }
  return forkPluginDirs(config).refusal;
}

/** Ends a refused run: one run-log line, then the result in the shape of adapter_engine_unavailable. */
export async function forkRefuseRun(
  ctx: Pick<AdapterExecutionContext, "config" | "onLog">,
  engine: string | null | undefined,
): Promise<AdapterExecutionResult> {
  const text = forkRunRefusal(ctx.config, engine) ?? FORK_ENGINE_REFUSAL;
  await ctx.onLog("stderr", `[paperclip] ${text}\n`);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: FORK_RUN_REFUSED,
    errorMessage: text,
    resultJson: {
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    },
  };
}

/** The JSON text of the `--settings` flag for this config and model. */
export function forkSettingsText(config: Record<string, unknown>, model: string): string {
  const settings: Record<string, boolean> = { ultracode: config.ultracode === true };
  if (forkReadsThinking(model)) settings.alwaysThinkingEnabled = config.thinking === true;
  if (config.autoMemory === false) settings[FORK_AUTO_MEMORY_KEY] = false;
  return JSON.stringify(settings);
}

/** The `--settings` pair, then the `--plugin-dir` flags; the model is resolved as the run resolves it. */
export function forkSettingsArgs(
  config: Record<string, unknown>,
  env: Record<string, unknown> = {},
): string[] {
  return ["--settings", forkSettingsText(config, resolveClaudeModel(config.model, env)), ...forkPluginDirArgs(config)];
}

/** The effort to send on this model, and the run-log line when a set effort is left out. */
export function forkEffortRule(effort: string, model: string): { effort: string; log: string | null } {
  const wanted = effort.trim();
  if (!wanted) return { effort: "", log: null };
  if (claudeLocalReasoningEffortsForModel(model).length === 0) {
    return { effort: "", log: `[paperclip] ${model} takes no effort level; effort ${wanted} left out.\n` };
  }
  return { effort, log: null };
}

/** Applies forkEffortRule to the run's effort and writes its run-log line. */
export async function forkRunEffort(effort: string, model: string, onLog: RunLog): Promise<string> {
  const rule = forkEffortRule(effort, model);
  if (rule.log) await onLog("stderr", rule.log);
  return rule.effort;
}

/**
 * The command line as the run log keeps it (fork: no copy). The agent's instructions go to Claude inline, so the
 * argument after --append-system-prompt is the whole text; the log keeps its size in its place, never the text.
 */
export function forkLoggedArgs(args: string[]): string[] {
  return args.map((arg, i) => (i > 0 && args[i - 1] === "--append-system-prompt"
    ? `[agent instructions: ${arg.length} characters, read in place, not logged]` : arg));
}

/**
 * An instruction file's text without a leading YAML front matter block (fork: in-place instructions). A package's
 * AGENTS.md opens with its name, title, reporting line and skills, which the import read; the run takes the body.
 */
export function forkInstructionsBody(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length).replace(/^(?:\r?\n)+/, "") : text;
}
