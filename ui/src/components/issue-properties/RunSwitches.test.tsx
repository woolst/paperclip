// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerRunSettingsPicker } from "../task-chat/ComposerRunSettingsPicker";
import { DEFAULT_COMPOSER_RUN_SETTINGS, mergeComposerRunSettings } from "../task-chat/composer-run-settings";
import { codexReasoningEffortOptions } from "../../lib/codex-reasoning-effort";
import { buildAssigneeAdapterOverrides } from "../../lib/issue-assignee-overrides";
import { rememberComposerEffort } from "../../lib/recent-composer-effort";
import { ISSUE_THINKING_EFFORT_OPTIONS, thinkingEffortOptionsFor } from "./helpers";
import { IssueProperties } from "./IssueProperties";
import {
  RunSwitches, claudeConfigForModel, claudeEffortOptions, runSwitchWords, runSwitchesOn, thinkingSwitchShown, ultracodeSwitchShown,
} from "./RunSwitches";

const agentsApi = vi.hoisted(() => ({ list: vi.fn(), adapterModels: vi.fn() }));
vi.mock("../../api/agents", () => ({ agentsApi }));
// The card's contexts and open popovers; its other services fail to fetch, which the card shows as loading.
const Pass = vi.hoisted(() => ({ children }: { children?: ReactNode }) => children);
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: () => undefined }) }));
vi.mock("@/components/ui/popover", () => ({ Popover: Pass, PopoverTrigger: Pass, PopoverContent: Pass, PopoverAnchor: Pass,
  PopoverHeader: Pass, PopoverTitle: Pass, PopoverDescription: Pass }));
vi.mock("@/lib/router", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()),
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  useCaseHref: () => (id: string) => id, useLocation: () => ({ hash: "", pathname: "/", search: "", state: null, key: "t" }) }));

globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function renderTree(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  flushSync(() => root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>));
}

async function toggle(key: "ultracode" | "thinking") {
  await act(async () => { container.querySelector<HTMLElement>(`[data-testid="run-switch-${key}"] button`)!.click(); });
}

async function clickButton(text: string) {
  const find = () => Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.includes(text));
  for (let attempt = 0; attempt < 20 && !find(); attempt += 1) await flush();
  await act(async () => { find()!.click(); });
}

/** The task card of a Claude task: the agent's model and the task's override config, null for none. */
async function renderCard(model: string, adapterConfig: Record<string, unknown> | null, models: { id: string; label: string }[] = []) {
  agentsApi.list.mockResolvedValue([{ id: "a1", name: "Claude", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: { model } }]);
  agentsApi.adapterModels.mockResolvedValue(models);
  const onUpdate = vi.fn();
  const issue = { id: "issue-1", companyId: "company-1", identifier: "PAP-1", title: "Task", status: "todo", priority: "medium", assigneeAgentId: "a1",
    assigneeAdapterOverrides: adapterConfig && { adapterConfig }, labels: [], labelIds: [], blockedBy: [], blocks: [], workMode: "standard",
    createdAt: new Date(), updatedAt: new Date() } as unknown as Issue;
  renderTree(<IssueProperties issue={issue} childIssues={[]} onUpdate={onUpdate} />);
  for (let attempt = 0; attempt < 20 && !container.textContent?.includes("Model lane"); attempt += 1) await flush();
  return onUpdate;
}
const override = (adapterConfig: Record<string, unknown>) => ({ assigneeAdapterOverrides: { adapterConfig } });

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  agentsApi.list.mockResolvedValue([]);
  agentsApi.adapterModels.mockResolvedValue([]);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  container.remove();
});

describe("run switch rules", () => {
  it("lists Claude efforts by model and leaves other adapters unchanged", () => {
    expect(claudeEffortOptions("claude-opus-5-5").map((option) => option.label))
      .toEqual(["Default", "Low", "Medium", "High", "Extra High", "Max"]);
    expect(claudeEffortOptions("claude-haiku-4-5")).toEqual([]);
    expect(thinkingEffortOptionsFor("claude_local", "claude-opus-5-5")).toEqual(claudeEffortOptions("claude-opus-5-5"));
    expect(thinkingEffortOptionsFor("claude_local", "claude-haiku-4-5")).toEqual([]);
    expect(thinkingEffortOptionsFor("codex_local", "gpt-5.4")).toEqual(codexReasoningEffortOptions("gpt-5.4"));
    expect(thinkingEffortOptionsFor("opencode_local", "x")).toEqual(ISSUE_THINKING_EFFORT_OPTIONS.opencode_local);
  });

  it("shows Thinking only where the run reads it and Ultracode only where it has effect", () => {
    for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "us.anthropic.claude-haiku-4-5"]) {
      expect(thinkingSwitchShown(model)).toBe(true);
      expect(ultracodeSwitchShown(model)).toBe(false);
    }
    expect(thinkingSwitchShown("claude-sonnet-5-5")).toBe(false);
    expect(ultracodeSwitchShown("claude-sonnet-5-5")).toBe(true);
    expect(ultracodeSwitchShown(undefined)).toBe(true);
  });

  it("names the switches that are on, for Claude only", () => {
    expect(runSwitchWords("claude_local", { ultracode: true, thinking: true })).toEqual(["Ultracode", "Thinking"]);
    expect(runSwitchWords("claude_local", { ultracode: false, thinking: "yes" })).toEqual([]);
    expect(runSwitchWords("codex_local", { ultracode: true })).toEqual([]);
    expect(runSwitchesOn({})).toBe(false);
    expect(runSwitchesOn({ thinking: true })).toBe(true);
  });

  it("(d) keeps on a model change only what the new model takes", () => {
    expect(claudeConfigForModel("claude_local", { effort: "xhigh", ultracode: true, chrome: true }, "claude-haiku-4-5"))
      .toEqual({ chrome: true });
    expect(claudeConfigForModel("claude_local", { thinking: false }, "claude-sonnet-5-5")).toEqual({ thinking: false });
    expect(claudeConfigForModel("claude_local", { effort: "xhigh", ultracode: true }, "claude-sonnet-5-5"))
      .toEqual({ effort: "xhigh", ultracode: true });
    expect(claudeConfigForModel("claude_local", { effort: "xhigh" }, "")).toEqual({ effort: "xhigh" });
    expect(claudeEffortOptions(undefined).map((option) => option.value)).toContain("max");
    const codex = { modelReasoningEffort: "xhigh" };
    expect(claudeConfigForModel("codex_local", codex, "claude-haiku-4-5")).toBe(codex);
  });

  it("(e) forces the custom lane in the dialog and keeps ultracode under a picker model", () => {
    const runSwitches = { ultracode: true };
    const built = buildAssigneeAdapterOverrides({ adapterType: "claude_local", lane: runSwitchesOn(runSwitches) ? "custom" : "primary",
      modelOverride: "", thinkingEffortOverride: "", chrome: false, runSwitches });
    expect(built).toEqual({ adapterConfig: { ultracode: true } });
    expect(mergeComposerRunSettings(built, "claude_local", { model: "claude-opus-5-5", effort: "high", fast: false }))
      .toEqual({ adapterConfig: { ultracode: true, model: "claude-opus-5-5", effort: "high" } });
    expect(buildAssigneeAdapterOverrides({ adapterType: "codex_local", lane: "custom", modelOverride: "", thinkingEffortOverride: "",
      chrome: false, runSwitches: { ultracode: true, thinking: true } })).toBeNull();
    expect(claudeConfigForModel("claude_local", { ultracode: true, thinking: true }, "claude-haiku-4-5")).toEqual({ thinking: true });
  });

  it("(a)(b)(c) keeps the switches through the chat box and clears all four on a reassignment", () => {
    const previous = { adapterConfig: { model: "claude-sonnet-5-5", thinking: true, ultracode: true } };
    expect(mergeComposerRunSettings(previous, "claude_local", { model: "claude-sonnet-5-5", effort: null, fast: false })).toEqual(previous);
    expect(mergeComposerRunSettings({ adapterConfig: { thinking: "high" } }, "pi_local", { model: null, effort: "low", fast: false }))
      .toEqual({ adapterConfig: { thinking: "low" } });
    expect(mergeComposerRunSettings({ adapterConfig: { thinking: true } }, "claude_local",
      { model: "claude-haiku-4-5", effort: null, fast: false })).toEqual({ adapterConfig: { thinking: true, model: "claude-haiku-4-5" } });
    expect(mergeComposerRunSettings({ adapterConfig: { ultracode: true } }, "claude_local",
      { model: "claude-haiku-4-5", effort: null, fast: false })).toEqual({ adapterConfig: { model: "claude-haiku-4-5" } });
    const all = { adapterConfig: { model: "claude-opus-5-5", effort: "max", ultracode: true, thinking: true } };
    expect(mergeComposerRunSettings(all, "claude_local", { model: "claude-sonnet-5-5", effort: null, fast: false }, true))
      .toEqual({ adapterConfig: { model: "claude-sonnet-5-5" } });
    expect(mergeComposerRunSettings(all, "claude_local", DEFAULT_COMPOSER_RUN_SETTINGS, true)).toBeNull();
  });
});

describe("RunSwitches", () => {
  it("draws nothing for other adapters and only the switches the model takes", async () => {
    renderTree(<RunSwitches part="both" adapterType="codex_local" model="claude-sonnet-5-5" values={{}} onChange={vi.fn()} />);
    expect(container.textContent).toBe("");
    flushSync(() => root!.unmount());
    const onChange = vi.fn();
    renderTree(<RunSwitches part="both" compact adapterType="claude_local" model="claude-sonnet-5-5" values={{ ultracode: true }} onChange={onChange} />);
    expect(container.querySelector('[data-testid="run-switch-thinking"]')).toBeNull();
    await toggle("ultracode");
    expect(onChange).toHaveBeenCalledWith({ ultracode: undefined });
  });

  it("puts Thinking on the card for claude-haiku-4-5 and no Ultracode there", async () => {
    const onChange = vi.fn();
    renderTree(<>
      <RunSwitches part="thinking" adapterType="claude_local" model="claude-haiku-4-5" values={{}} onChange={onChange} />
      <RunSwitches part="ultracode" adapterType="claude_local" model="claude-haiku-4-5" values={{}} onChange={onChange} />
    </>);
    expect(container.querySelector('[data-testid="run-switch-ultracode"]')).toBeNull();
    await toggle("thinking");
    expect(onChange).toHaveBeenCalledWith({ thinking: true });
  });

  it("(a) the chat box fills in the board's remembered effort on a Claude task, as upstream does", async () => {
    rememberComposerEffort("company-1", "high");
    const agent = { id: "a1", companyId: "company-1", name: "Claude", role: "engineer", adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-5-5" } } as unknown as Agent;
    const onSettingsChange = vi.fn();
    renderTree(<ComposerRunSettingsPicker companyId="company-1" assigneeValue="agent:a1" currentAssigneeValue="agent:a1"
      options={[{ id: "agent:a1", label: "Claude" }]} agents={new Map([[agent.id, agent]])} settings={null} overrides={null}
      onAssigneeChange={vi.fn()} onSettingsChange={onSettingsChange}
      modelOptionsOverride={[{ id: "claude-sonnet-5-5", label: "Sonnet" }]} />);
    await flush();
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ effort: "high" }));
  });
});

describe("RunSwitches on the task card", () => {
  it("reads Primary model with no override; writes, drops and names Ultracode on the Override lane; no Thinking on Sonnet", async () => {
    await renderCard("claude-sonnet-5-5", null);
    expect(container.textContent).toContain("Primary model");
    flushSync(() => root!.unmount());
    let onUpdate = await renderCard("claude-sonnet-5-5", { model: "claude-sonnet-5-5" });
    expect(container.querySelector('[data-testid="run-switch-thinking"]')).toBeNull();
    await toggle("ultracode");
    expect(onUpdate).toHaveBeenCalledWith(override({ model: "claude-sonnet-5-5", ultracode: true }));
    flushSync(() => root!.unmount());
    onUpdate = await renderCard("claude-sonnet-5-5", { model: "claude-sonnet-5-5", ultracode: true });
    expect(container.textContent).toContain("Override · claude-sonnet-5-5 · Ultracode");
    await toggle("ultracode");
    expect(onUpdate).toHaveBeenCalledWith(override({ model: "claude-sonnet-5-5" }));
  });
  it("puts Thinking in place of the effort buttons on claude-haiku-4-5", async () => {
    const onUpdate = await renderCard("claude-haiku-4-5", { model: "claude-haiku-4-5" });
    expect(container.querySelector('[data-testid="run-switch-ultracode"]')).toBeNull();
    expect(container.querySelector('[data-testid="run-switch-thinking"]')!.parentElement!.children).toHaveLength(1);
    await toggle("thinking");
    expect(onUpdate).toHaveBeenCalledWith(override({ model: "claude-haiku-4-5", thinking: true }));
  });
  it("(d) keeps no model key on Default model and drops effort and Ultracode on claude-haiku-4-5", async () => {
    const onUpdate = await renderCard("claude-sonnet-5-5", { model: "claude-opus-5-5", effort: "xhigh", ultracode: true }, [{ id: "claude-haiku-4-5", label: "Haiku" }]);
    await clickButton("Default model");
    expect(onUpdate).toHaveBeenLastCalledWith(override({ effort: "xhigh", ultracode: true }));
    await clickButton("Haiku");
    expect(onUpdate).toHaveBeenLastCalledWith(override({ model: "claude-haiku-4-5" }));
  });
});
