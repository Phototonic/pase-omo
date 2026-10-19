import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";

import {
  applyOmoUpdateRpc,
  omoUpdateStatusRpc,
  OMO_PACKAGE,
  type ApplyOmoUpdateInput,
  type ApplyOmoUpdatePayload,
  type OmoUpdateJob,
  type OmoUpdateStatusPayload,
} from "../../shared/update.js";
import { resolveOmoLaunch } from "./omo-cli.js";
import { omoSessionRegistry, type OmoSessionRegistry } from "./session-registry.js";

const REGISTRY_URL = `https://registry.npmjs.org/${OMO_PACKAGE}`;
const REGISTRY_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const PINNED_UPDATE_NOTICE = "OmO updates are disabled for this pinned isolated trial. Use the trial's documented local update procedure.";

function updatesDisabled(): boolean {
  return process.env.PASEO_OMO_DISABLE_UPDATE === "1";
}

function requireUpdatesEnabled(): void {
  if (updatesDisabled()) throw new Error(PINNED_UPDATE_NOTICE);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Where the launched CLI's own package manifest lives.
 *
 * The launch is `<runtime> <entry>` for a script install and a bare executable
 * otherwise, so the search starts at the entry when there is one and walks up
 * until a manifest names the package. A launcher shim on PATH has no manifest
 * above it, which is why the Bun global install is tried as well.
 */
function manifestCandidates(): string[] {
  const candidates: string[] = [];
  try {
    const launch = resolveOmoLaunch();
    let directory = dirname(launch.base[0] ?? launch.command);
    for (let depth = 0; depth < 5; depth += 1) {
      candidates.push(join(directory, "package.json"));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // An unresolvable CLI is reported by the caller through the version being null.
  }
  return candidates;
}

/** Version of the OmO the daemon would launch, or null when no manifest names it. */
export async function installedOmoVersion(): Promise<string | null> {
  // The official standalone binary has no package.json. Ask the same executable
  // the provider launches, rather than reporting an unrelated global package.
  try {
    const launch = resolveOmoLaunch();
    const version = await new Promise<string | null>((resolve) => {
      const child = spawn(launch.command, [...launch.base, "--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-4096); });
      const timer = setTimeout(() => { child.kill(); resolve(null); }, 10_000);
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0 ? output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null : null); });
    });
    if (version !== null) return version;
  } catch { /* Fall back to the launched script's manifest for older CLIs. */ }
  for (const candidate of manifestCandidates()) {
    try {
      const manifest = JSON.parse(await readFile(candidate, "utf8")) as { name?: unknown; version?: unknown };
      if (manifest.name !== OMO_PACKAGE || typeof manifest.version !== "string") continue;
      return manifest.version;
    } catch {
      continue;
    }
  }
  return null;
}

/** Newest version on OmO's release channel. Throws when the registry is unreachable. */
export async function availableOmoVersion(installedVersion?: string | null): Promise<string> {
  const channel = installedVersion?.includes("-") ? "beta" : "latest";
  const response = await fetch(REGISTRY_URL, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry answered ${response.status}`);
  const payload = (await response.json()) as { "dist-tags"?: Record<string, unknown> };
  const version = payload["dist-tags"]?.[channel];
  if (typeof version !== "string") throw new Error(`npm registry has no ${channel} tag for ${OMO_PACKAGE}`);
  return version;
}

/**
 * Delegate installation ownership, channel choice and checksum verification
 * to the exact CLI the provider launches. Supports native and package installs.
 */
export function installCommand(): { command: string; args: string[] } {
  requireUpdatesEnabled();
  const launch = resolveOmoLaunch();
  return { command: launch.command, args: [...launch.base, "update"] };
}

/** Semver ordering, including stable promotion; never offer a downgrade. */
export function isNewerVersion(available: string, installed: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  const a = parse(available), b = parse(installed);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i]);
  if (a[4] === undefined || b[4] === undefined) return a[4] === undefined && b[4] !== undefined;
  const left = a[4].split("."), right = b[4].split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i], y = right[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x !== undefined;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) > Number(y);
    if (xn !== yn) return !xn;
    return x > y;
  }
  return false;
}

export function installCommandLine(): string {
  try {
    const { command, args } = installCommand();
    return [command, ...args].join(" ");
  } catch (error) {
    return describe(error);
  }
}

/** Runs the install, rejecting with the child's own output when it fails. */
async function runInstall(): Promise<void> {
  const { command, args } = installCommand();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-4096);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${[command, ...args].join(" ")} exited with code ${code ?? "null"}: ${output.trim()}`));
    });
  });
}

/**
 * The newest apply run. Module state on purpose: the button that starts a job
 * and the status calls that follow it are separate RPCs, and the daemon holds
 * one plugin instance for all of them.
 */
let currentJob: OmoUpdateJob | null = null;
let runningJob: Promise<void> | null = null;

/** The job a caller can see, or null before the first one. */
export function omoUpdateJob(): OmoUpdateJob | null {
  return currentJob === null ? null : { ...currentJob, failures: [...currentJob.failures] };
}

/** Settles when the running job finishes; immediate when nothing is running. */
export async function awaitOmoUpdateJob(): Promise<void> {
  await runningJob;
}

/** Test seam: forgets the last job so one test cannot see another's result. */
export function resetOmoUpdateJob(): void {
  currentJob = null;
  runningJob = null;
}

const ACTIVE_PHASES: ReadonlySet<OmoUpdateJob["phase"]> = new Set([
  "suspending",
  "installing",
  "resuming",
]);

export function isOmoUpdateJobRunning(job: OmoUpdateJob | null): boolean {
  return job !== null && ACTIVE_PHASES.has(job.phase);
}

export async function omoUpdateStatus(
  _input: Record<string, never>,
  _context: unknown,
  registry: OmoSessionRegistry = omoSessionRegistry,
): Promise<OmoUpdateStatusPayload> {
  const installedVersion = await installedOmoVersion();
  let availableVersion: string | null = null;
  let error: string | null = null;
  try {
    if (updatesDisabled()) error = PINNED_UPDATE_NOTICE;
    else availableVersion = await availableOmoVersion(installedVersion);
  } catch (failure) {
    error = describe(failure);
  }
  return {
    installedVersion,
    availableVersion,
    updateAvailable:
      installedVersion !== null && availableVersion !== null && isNewerVersion(availableVersion, installedVersion),
    liveSessions: registry.list().length,
    installCommand: installCommandLine(),
    error,
    job: omoUpdateJob(),
  };
}

/**
 * Stop every OmO session, optionally replace the CLI, then bring the sessions
 * back on the same session files.
 *
 * The order is what makes an update safe: a child still running would keep the
 * old code loaded and race the installer over the files it replaces. Resume runs
 * for every suspended session even when the install failed, so a failed update
 * never leaves a session without a process.
 */
export interface ApplyOmoUpdateDeps {
  registry?: OmoSessionRegistry;
  /** Replaces the installed CLI. Injected so the order around it can be tested. */
  runInstall?: () => Promise<void>;
  readVersion?: () => Promise<string | null>;
}

export async function runOmoUpdateJob(
  input: ApplyOmoUpdateInput,
  job: OmoUpdateJob,
  deps: ApplyOmoUpdateDeps = {},
): Promise<void> {
  if (input.install) requireUpdatesEnabled();
  const registry = deps.registry ?? omoSessionRegistry;
  const install = deps.runInstall ?? runInstall;
  const readVersion = deps.readVersion ?? installedOmoVersion;
  const sessions = registry.list();
  job.total = sessions.length;

  const suspended = [];
  for (const session of sessions) {
    try {
      await session.suspend();
      suspended.push(session);
      job.suspended += 1;
    } catch (error) {
      job.failures.push(`${session.sessionId}: could not be stopped — ${describe(error)}`);
    }
  }

  if (input.install) {
    job.phase = "installing";
    try {
      await install();
    } catch (error) {
      job.installError = describe(error);
    }
  }

  job.phase = "resuming";
  for (const session of suspended) {
    try {
      await session.resume();
      job.resumed += 1;
    } catch (error) {
      job.failures.push(`${session.sessionId}: could not be resumed — ${describe(error)}`);
    }
  }

  try {
    job.version = await readVersion();
  } catch {
    job.version = null;
  }
  job.phase = job.installError !== null || job.failures.length > 0 ? "failed" : "done";
  job.finishedAt = new Date().toISOString();
}

/**
 * Starts the job and returns at once.
 *
 * Waiting here is what produced `Plugin RPC timed out` on a working update: the
 * daemon gives a plugin handler 30 seconds, and a global install alone can take
 * longer than that. The button starts the work and watches `update.status`.
 */
export async function applyOmoUpdate(
  input: ApplyOmoUpdateInput,
  _context: unknown,
  deps: ApplyOmoUpdateDeps = {},
): Promise<ApplyOmoUpdatePayload> {
  if (input.install) requireUpdatesEnabled();
  if (isOmoUpdateJobRunning(currentJob) && currentJob !== null) {
    return { started: false, alreadyRunning: true, job: omoUpdateJob() as OmoUpdateJob };
  }

  const job: OmoUpdateJob = {
    phase: "suspending",
    install: input.install,
    total: 0,
    suspended: 0,
    resumed: 0,
    failures: [],
    installError: null,
    version: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  currentJob = job;
  runningJob = runOmoUpdateJob(input, job, deps).catch((error: unknown) => {
    // A throw here is a defect rather than a session failure, but the button
    // still has to stop saying "working".
    job.failures.push(`update job failed — ${describe(error)}`);
    job.phase = "failed";
    job.finishedAt = new Date().toISOString();
  });

  return { started: true, alreadyRunning: false, job: omoUpdateJob() as OmoUpdateJob };
}

/** Entry-point wiring: registers both update RPC contracts. */
export function registerUpdateHandlers(plugin: Pick<PluginServerContext, "handle">): PluginCleanup {
  plugin.handle(omoUpdateStatusRpc, omoUpdateStatus);
  plugin.handle(applyOmoUpdateRpc, applyOmoUpdate);
  return () => {};
}
