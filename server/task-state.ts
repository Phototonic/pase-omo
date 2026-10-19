import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";

/**
 * The OmO task-state tree has two readers inside this plugin: the snapshot RPCs
 * (`server/dag`) and the timeline publisher (`server/chat`). They were separate
 * plugins before the merge and disagreed — the snapshot side honoured
 * `PASEO_OMO_TASK_STATE_DIR` while the publisher hardcoded the workspace path,
 * so with the override set one reader saw runs the other could not. Both now
 * resolve the directory here.
 */

/** An override is only an override when it names something. */
function named(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** OmO accepts a native overlay on its global and project JSONC configuration. */
function configuredStore(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const errors: ParseError[] = [];
  const config: unknown = parse(readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`Cannot resolve OmO task store: invalid configuration ${file}`);
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const base = record(config), native = record(base["[native]"]);
  const value = record(native.task).state_dir ?? record(base.task).state_dir;
  return typeof value === "string" ? named(value) : undefined;
}

function nativeTaskStateDir(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  // Project configuration takes precedence over the user's global configuration.
  for (let folder = resolve(cwd);;) {
    for (const name of ["omo.jsonc", "omo.json"]) {
      const value = configuredStore(join(folder, ".omo", name));
      if (value) return value;
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  const home = named(env.HOME) ?? named(env.USERPROFILE);
  const agent = named(env.OMO_CODING_AGENT_DIR) ?? named(env.SENPI_CODING_AGENT_DIR) ?? named(env.PI_CODING_AGENT_DIR);
  const global = agent ? dirname(resolve(agent)) : home ? join(home, ".omo") : undefined;
  if (global) for (const name of ["omo.jsonc", "omo.json"]) {
    const value = configuredStore(join(global, name));
    if (value) return value;
  }
  return undefined;
}

/** Explicit integration overrides win; regular installs use OmO's own configuration. */
export function taskStateDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = named(env.PASEO_OMO_TASK_STATE_DIR) ?? named(env.OMO_HERDR_DAG_TASK_STATE_DIR);
  const configured = override ?? nativeTaskStateDir(cwd, env);
  const home = named(env.HOME) ?? named(env.USERPROFILE);
  const expanded = configured?.startsWith("~/") && home ? join(home, configured.slice(2)) : configured;
  return expanded ? resolve(cwd, expanded) : join(resolve(cwd), ".omo", "senpi-task");
}

/** Directory holding one JSON file per DAG run. */
export function dagRunsDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(taskStateDir(cwd, env), "dag", "runs");
}
