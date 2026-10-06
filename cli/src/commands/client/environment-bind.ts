import type { Command } from "commander";
import { ApiRequestError } from "../../client/http.js";
import {
  addCommonClientOptions,
  apiPath,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface EnvironmentBindOptions extends BaseClientOptions {
  company?: string;
}

/** The fields of an agent row the bind reads. */
export interface BindAgent {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
  defaultEnvironmentId?: string | null;
}

/** The fields of an environment row the bind reads. */
export interface BindEnvironment {
  id: string;
  name: string;
  status?: string;
}

/** The two calls of the API client the bind makes; PaperclipApiClient fits it. */
export interface BindApi {
  get<T>(path: string): Promise<T | null>;
  patch<T>(path: string, body?: unknown): Promise<T | null>;
}

export interface BindReport {
  lines: string[];
  error?: string;
  bound: number;
  alreadyBound: number;
  failed: number;
  exitCode: 0 | 1 | 2;
}

function describeError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    return `API error ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function unreadable(error: string): BindReport {
  return { lines: [], error, bound: 0, alreadyBound: 0, failed: 0, exitCode: 2 };
}

/** The environment name an agent's metadata names, or null when it names none. */
export function namedEnvironment(agent: BindAgent): string | null {
  const metadata = agent.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).environment;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Binds each agent of the company to the environment its metadata names.
 * Reads the agents and the environments first; if either read fails, it
 * changes nothing and returns exit code 2. Sends only `defaultEnvironmentId`.
 */
export async function bindAgentEnvironments(api: BindApi, companyId: string): Promise<BindReport> {
  let agents: BindAgent[] | null;
  let environments: BindEnvironment[] | null;
  try {
    agents = await api.get<BindAgent[]>(apiPath`/api/companies/${companyId}/agents`);
    if (!Array.isArray(agents)) return unreadable("The agents list could not be read.");
    environments = await api.get<BindEnvironment[]>(apiPath`/api/companies/${companyId}/environments`);
    if (!Array.isArray(environments)) return unreadable("The environments list could not be read.");
  } catch (err) {
    return unreadable(describeError(err));
  }

  const report: BindReport = { lines: [], bound: 0, alreadyBound: 0, failed: 0, exitCode: 0 };
  for (const agent of agents) {
    const wanted = namedEnvironment(agent);
    if (wanted === null) continue;
    // The list holds archived rows too; an archived environment is never a target.
    const environment = environments.find((candidate) => candidate.name === wanted && candidate.status !== "archived");
    if (!environment) {
      report.lines.push(`${agent.name}: no environment named ${wanted} in this company.`);
      report.failed += 1;
      continue;
    }
    if (agent.defaultEnvironmentId === environment.id) {
      report.lines.push(`${agent.name}: already bound to ${wanted}.`);
      report.alreadyBound += 1;
      continue;
    }
    try {
      await api.patch(apiPath`/api/agents/${agent.id}`, { defaultEnvironmentId: environment.id });
      report.lines.push(`${agent.name}: bound to ${wanted}.`);
      report.bound += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      report.lines.push(`${agent.name}: refused: ${reason}.`);
      report.failed += 1;
    }
  }
  report.lines.push(`${report.bound} bound, ${report.alreadyBound} already bound, ${report.failed} failed.`);
  report.exitCode = report.failed > 0 ? 1 : 0;
  return report;
}

export function registerEnvironmentBind(environment: Command): void {
  addCommonClientOptions(
    environment
      .command("bind")
      .description("Bind each agent of a company to the environment its metadata names")
      .option("--company <companyId>", "Company ID")
      .action(async (opts: EnvironmentBindOptions) => {
        let report: BindReport;
        try {
          const ctx = resolveCommandContext({ ...opts, companyId: opts.company }, { requireCompany: true });
          report = await bindAgentEnvironments(ctx.api, ctx.companyId as string);
        } catch (err) {
          // The common resolver names --company-id, which this command calls --company.
          report = unreadable(describeError(err).replace("--company-id", "--company"));
        }
        if (report.error !== undefined) console.error(report.error);
        for (const line of report.lines) console.log(line);
        if (report.exitCode !== 0) process.exit(report.exitCode);
      }),
    { includeCompany: false },
  );
}
