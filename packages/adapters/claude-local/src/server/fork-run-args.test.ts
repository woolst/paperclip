import { describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import {
  FORK_AUTO_MEMORY_KEY,
  FORK_CLI_ONLY_KEYS,
  FORK_ENGINE_REFUSAL,
  FORK_RUN_REFUSED,
  FORK_SETTINGS_REFUSAL,
  FORK_THINKING_MODELS,
  forkEffortRule,
  forkReadsThinking,
  forkRefuseRun,
  forkRunEffort,
  forkRunRefusal,
  forkSettingsArgs,
  forkSettingsText,
} from "./fork-run-args.js";

const HAIKU = "claude-haiku-4-5";
const SONNET = "claude-sonnet-5-5";

function settingsOf(args: string[]): Record<string, unknown> {
  expect(args.filter((arg) => arg === "--settings")).toHaveLength(1);
  return JSON.parse(args[args.indexOf("--settings") + 1]) as Record<string, unknown>;
}

function recorder() {
  const lines: string[] = [];
  const onLog = async (_stream: "stdout" | "stderr", chunk: string) => {
    lines.push(chunk);
  };
  return { lines, onLog };
}

describe("fork --settings text", () => {
  it("every run has one --settings holding ultracode, absent sent as false", () => {
    const args = forkSettingsArgs({ model: SONNET });
    expect(args).toEqual(["--settings", '{"ultracode":false}']);
    expect(settingsOf(args)).toEqual({ ultracode: false });
  });

  it("the value is JSON text, never a file path, and holds no hooks key", () => {
    for (const config of [{}, { model: HAIKU }, { ultracode: true, thinking: true, autoMemory: false }]) {
      const value = forkSettingsArgs(config)[1];
      expect(value.startsWith("{")).toBe(true);
      expect(value).not.toContain("/");
      expect(settingsOf(forkSettingsArgs(config))).not.toHaveProperty("hooks");
      for (const entry of Object.values(JSON.parse(value) as Record<string, unknown>)) {
        expect(typeof entry).toBe("boolean");
      }
    }
  });

  it("ultracode: true gives \"ultracode\":true", () => {
    expect(forkSettingsText({ ultracode: true }, SONNET)).toBe('{"ultracode":true}');
    expect(forkSettingsText({ ultracode: false }, SONNET)).toBe('{"ultracode":false}');
  });

  it("on claude-haiku-4-5 it also holds alwaysThinkingEnabled, absent sent as false", () => {
    expect(forkSettingsArgs({ model: HAIKU })).toEqual([
      "--settings",
      '{"ultracode":false,"alwaysThinkingEnabled":false}',
    ]);
    expect(forkSettingsText({ thinking: false }, HAIKU)).toBe('{"ultracode":false,"alwaysThinkingEnabled":false}');
    expect(forkSettingsText({ thinking: true }, HAIKU)).toBe('{"ultracode":false,"alwaysThinkingEnabled":true}');
  });

  it("reads Haiku from its dated, Bedrock and environment ids", () => {
    expect(forkReadsThinking("claude-haiku-4-5-20251001")).toBe(true);
    expect(forkReadsThinking("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(true);
    expect(forkReadsThinking("claude-haiku-4-5@20251001")).toBe(true);
    expect(settingsOf(forkSettingsArgs({}, { ANTHROPIC_MODEL: HAIKU }))).toHaveProperty("alwaysThinkingEnabled", false);
  });

  it("a claude-sonnet-5-5 run with thinking: false sends no thinking key and runs", () => {
    const config = { model: SONNET, engine: "cli", thinking: false };
    expect(forkSettingsText(config, SONNET)).toBe('{"ultracode":false}');
    expect(forkRunRefusal(config, "cli")).toBeNull();
  });

  it("no thinking value is refused on any model on the command-line engine", () => {
    for (const model of [HAIKU, SONNET, "claude-fable-5-1", "claude-opus-5-5"]) {
      for (const thinking of [true, false, undefined]) {
        expect(forkRunRefusal({ model, thinking }, "cli")).toBeNull();
      }
    }
  });

  it("reads thinking on every model the checks record adds, and on no other", () => {
    for (const model of FORK_THINKING_MODELS) {
      expect(settingsOf(forkSettingsArgs({ model, thinking: true }))).toHaveProperty("alwaysThinkingEnabled", true);
    }
    for (const model of [SONNET, "claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-4-5", "claude-haiku-4-6"]) {
      expect(forkReadsThinking(model)).toBe(false);
    }
  });

  it("autoMemory: false adds the key K5 names; absent or true adds nothing", () => {
    expect(FORK_AUTO_MEMORY_KEY).toBe("autoMemoryEnabled");
    expect(forkSettingsText({ autoMemory: false }, SONNET)).toBe('{"ultracode":false,"autoMemoryEnabled":false}');
    expect(forkSettingsText({}, SONNET)).toBe('{"ultracode":false}');
    expect(forkSettingsText({ autoMemory: true }, SONNET)).toBe('{"ultracode":false}');
  });
});

describe("fork run refusals", () => {
  it("refuses every fork key on an engine other than cli, or with no engine set", () => {
    for (const key of FORK_CLI_ONLY_KEYS) {
      for (const engine of ["acp", "auto", undefined, null]) {
        expect(forkRunRefusal({ [key]: key === "boxMounts" || key === "pluginDirs" ? ["/a"] : true }, engine)).toBe(
          FORK_ENGINE_REFUSAL,
        );
      }
      expect(forkRunRefusal({ [key]: false }, "acp")).toBe(FORK_ENGINE_REFUSAL);
      expect(forkRunRefusal({ [key]: true }, "cli")).toBeNull();
    }
  });

  it("lets a run with no fork key start on any engine", () => {
    for (const engine of ["acp", undefined, "cli"]) {
      expect(forkRunRefusal({ model: SONNET, effort: "high" }, engine)).toBeNull();
      expect(forkRunRefusal({ ultracode: null, boxMounts: [], boxShareDir: " " }, engine)).toBeNull();
    }
  });

  it("refuses ultracode on claude-haiku-4-5, where it has no effect (card test T-U4)", () => {
    const text = "Ultracode is not allowed on claude-haiku-4-5.";
    expect(forkRunRefusal({ model: "claude-haiku-4-5", ultracode: true }, "cli")).toBe(text);
    expect(forkRunRefusal({ model: "claude-haiku-4-5-20251001", ultracode: true }, "cli")).toBe(text);
    expect(forkRunRefusal({ model: "claude-haiku-4-5", ultracode: false }, "cli")).toBeNull();
    expect(forkRunRefusal({ model: SONNET, ultracode: true }, "cli")).toBeNull();
  });

  it("ends a refused run with fork_run_refused, the text and one run-log line", async () => {
    const { lines, onLog } = recorder();
    const result = await forkRefuseRun({ config: { ultracode: true }, onLog }, "acp");
    expect(result).toEqual({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: FORK_RUN_REFUSED,
      errorMessage: FORK_ENGINE_REFUSAL,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    expect(result.errorCode).toBe("fork_run_refused");
    expect(lines).toEqual([`[paperclip] ${FORK_ENGINE_REFUSAL}\n`]);
  });

  it("refuses an agent with its own --settings in its extra arguments", async () => {
    for (const config of [
      { extraArgs: ["--settings", "{}"] },
      { extraArgs: ["--verbose", "--settings={\"ultracode\":true}"] },
      { args: ["--settings", "/tmp/s.json"] },
    ]) {
      expect(forkRunRefusal(config, "cli")).toBe(FORK_SETTINGS_REFUSAL);
      const { lines, onLog } = recorder();
      const result = await forkRefuseRun({ config, onLog }, "cli");
      expect(result.errorCode).toBe(FORK_RUN_REFUSED);
      expect(result.errorMessage).toBe(FORK_SETTINGS_REFUSAL);
      expect(lines).toHaveLength(1);
    }
    expect(forkRunRefusal({ extraArgs: ["--setting-sources", "user"] }, "cli")).toBeNull();
    expect(forkRunRefusal({ extraArgs: ["--verbose"], args: ["--settings", "{}"] }, "cli")).toBeNull();
  });

  it("execute() ends a refused run before any process starts", async () => {
    const { lines, onLog } = recorder();
    const onSpawn = vi.fn(async () => {});
    const result = await execute({
      runId: "run-fork-refused",
      agent: { id: "agent-1", companyId: "co-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: "/nonexistent/claude", extraArgs: ["--settings", "{}"] },
      context: {}, onLog, onSpawn,
    });
    expect(result).toMatchObject({ errorCode: FORK_RUN_REFUSED, errorMessage: FORK_SETTINGS_REFUSAL });
    expect(onSpawn).not.toHaveBeenCalled();
    expect(lines).toEqual([`[paperclip] ${FORK_SETTINGS_REFUSAL}\n`]);
  });
});

describe("fork effort rule (K5: U1 on, U2 off at high)", () => {
  it("sends the effort and the ultracode key together on a model with efforts", () => {
    expect(forkEffortRule("high", SONNET)).toEqual({ effort: "high", log: null });
    expect(forkSettingsText({ ultracode: true, effort: "high" }, SONNET)).toBe('{"ultracode":true}');
    expect(forkEffortRule("xhigh", "claude-opus-5-5")).toEqual({ effort: "xhigh", log: null });
  });

  it("a claude-haiku-4-5 task whose agent holds effort xhigh runs without --effort", async () => {
    const { lines, onLog } = recorder();
    expect(await forkRunEffort("xhigh", HAIKU, onLog)).toBe("");
    expect(lines).toEqual(["[paperclip] claude-haiku-4-5 takes no effort level; effort xhigh left out.\n"]);
  });

  it("an empty and an absent effort on claude-haiku-4-5 both leave --effort out, with no log line", async () => {
    for (const effort of ["", "  "]) {
      const { lines, onLog } = recorder();
      expect(await forkRunEffort(effort, HAIKU, onLog)).toBe("");
      expect(lines).toEqual([]);
    }
  });

  it("keeps the effort and writes no line on a model with efforts", async () => {
    const { lines, onLog } = recorder();
    expect(await forkRunEffort("medium", SONNET, onLog)).toBe("medium");
    expect(lines).toEqual([]);
  });
});
