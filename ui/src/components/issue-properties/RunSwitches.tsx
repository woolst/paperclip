// Fork run switches of a Claude task (fork commit 11): Ultracode and, where the run reads it, Thinking.
// The run reads them from the task's `assigneeAdapterOverrides.adapterConfig` keys `ultracode` and
// `thinking`; an absent key runs as off, so a switch turned off removes its key.
// helpers.ts imports this file, so this file imports nothing from helpers.ts.

import { claudeLocalReasoningEffortsForModel, resolveClaudeModel } from "@paperclipai/adapter-claude-local";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { EFFORT_LABELS } from "../task-chat/composer-run-settings";

export type RunSwitchValues = { ultracode?: boolean; thinking?: boolean };

/** Mirrors FORK_THINKING_MODELS of the adapter's fork-run-args.ts: the models the run reads `thinking` on. */
const THINKING_MODELS: readonly string[] = ["claude-haiku-4-5"];

/** Mirrors FORK_NO_ULTRACODE_MODELS of fork-run-args.ts: ultracode has no effect there and the run refuses it. */
const NO_ULTRACODE_MODELS: readonly string[] = ["claude-haiku-4-5"];

const SWITCHES = [
  { key: "ultracode", label: "Ultracode" },
  { key: "thinking", label: "Thinking" },
] as const;

/**
 * The model id as fork-run-args.ts compares it: no `[1m]` suffix, no Bedrock or Vertex prefix.
 * No model is the model the run takes then (resolveClaudeModel), so it is not a case of its own.
 */
function modelId(model: unknown): string {
  return resolveClaudeModel(model).replace(/\[1m\]$/, "").replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, "");
}

/** The model is on the list, by its id alone or with a date suffix (`-20251001`, `@20251001`). */
function listed(model: unknown, known: readonly string[]): boolean {
  const id = modelId(model);
  return known.some((name) => {
    if (!id.startsWith(name)) return false;
    const rest = id.slice(name.length);
    return rest === "" || /^[-@]\d{8}(?:\D|$)/.test(rest);
  });
}

/** The effort buttons of a Claude task: none where the model has no effort list. */
export function claudeEffortOptions(model: unknown): readonly { value: string; label: string }[] {
  const efforts = claudeLocalReasoningEffortsForModel(modelId(model));
  if (efforts.length === 0) return [];
  return [
    { value: "", label: "Default" },
    ...efforts.map((value) => ({ value, label: EFFORT_LABELS[value] ?? value })),
  ];
}

export function thinkingSwitchShown(model: unknown): boolean {
  return listed(model, THINKING_MODELS);
}

export function ultracodeSwitchShown(model: unknown): boolean {
  return !listed(model, NO_ULTRACODE_MODELS);
}

/** The words the collapsed Model row adds for the switches that are on. */
export function runSwitchWords(adapterType: string | null | undefined, adapterConfig: Record<string, unknown>): string[] {
  if (adapterType !== "claude_local") return [];
  return SWITCHES.filter(({ key }) => adapterConfig[key] === true).map(({ label }) => label);
}

export function runSwitchesOn(values: RunSwitchValues): boolean {
  return values.ultracode === true || values.thinking === true;
}

/**
 * The config a model change keeps on a Claude task: the effort only where the new model lists it,
 * and ultracode only where it has effect. `thinking` stays. Other adapters keep their config.
 */
export function claudeConfigForModel<T extends Record<string, unknown>>(
  adapterType: string | null | undefined,
  config: T,
  model: unknown,
): T {
  if (adapterType !== "claude_local") return config;
  const next: Record<string, unknown> = { ...config };
  if (next.effort !== undefined && !claudeEffortOptions(model).some((option) => option.value === next.effort)) {
    delete next.effort;
  }
  if (!ultracodeSwitchShown(model)) delete next.ultracode;
  return next as T;
}

interface RunSwitchesProps {
  adapterType: string | null | undefined;
  model: unknown;
  values: Record<string, unknown>;
  onChange: (patch: RunSwitchValues) => void;
  part: "ultracode" | "thinking" | "both";
  compact?: boolean;
}

export function RunSwitches({ adapterType, model, values, onChange, part, compact = false }: RunSwitchesProps) {
  if (adapterType !== "claude_local") return null;
  const shown = SWITCHES.filter(({ key }) => (part === "both" || part === key)
    && (key === "ultracode" ? ultracodeSwitchShown(model) : thinkingSwitchShown(model)));
  if (shown.length === 0) return null;
  const rows = shown.map(({ key, label }) => (
    <div
      key={key}
      data-testid={`run-switch-${key}`}
      className={compact
        ? "flex items-center gap-1.5"
        : "flex w-full items-center justify-between rounded-md border border-border px-2 py-1.5"}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <ToggleSwitch
        aria-label={label}
        checked={values[key] === true}
        onCheckedChange={(next) => onChange(key === "ultracode"
          ? { ultracode: next ? true : undefined }
          : { thinking: next ? true : undefined })}
      />
    </div>
  ));
  return compact ? <div className="flex items-center gap-1.5">{rows}</div> : <>{rows}</>;
}
