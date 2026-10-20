import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { createHash } from "node:crypto";
import type { ProviderEvent, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

import { taskStateDir } from "../task-state";

/**
 * `task()` runs, surfaced as the child sessions Paseo already knows how to draw.
 *
 * OmO records every spawned task under `<cwd>/.omo/senpi-task/tasks/st_*.json`
 * with the parent session it belongs to, but nothing read those files, so a
 * subagent run left only a flat tool-call row: no status, no link, and nothing
 * at all once the row scrolled away. A provider may announce a child session by
 * emitting `session.opened` with `parentSessionId`; the daemon turns that into
 * the `provider_subagent` upserts behind the subagent panel and the agent
 * tracks, and `session.turn` on that child carries its status.
 *
 * Everything below the file read is a pure decision, so the interesting part -
 * what a record means the first time it is seen, and what a status change means
 * afterwards - is tested without a clock or a disk.
 */

export const TASKS_DIR_SEGMENTS = [".omo", "senpi-task", "tasks"] as const;

export interface TaskRecord {
  task_id: string;
  status?: string;
  parent_session_id?: string;
  root_session_id?: string;
  task_summary?: string;
  description?: string;
  category?: string;
  model?: string;
  /** Native run boundary; fallback/reattach epochs within a run are not new turns. */
  run_start_epoch?: number;
  started_at?: string;
  terminal_at?: string;
  final_response?: string;
}

/** What the watcher already told the host about one task. */
export interface TaskState {
  status: string;
  opened: boolean;
  closed: boolean;
  epoch?: number;
  /** Only used for older records without native run boundaries. */
  legacyRevival?: number;
  /** Last published item fingerprints; unchanged polls produce no timeline events. */
  transcript?: Record<string, string>;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "complete",
  "done",
  "error",
  "failed",
  "cancelled",
  "canceled",
  "interrupted",
  "lost",
]);

export function isTerminalTask(record: TaskRecord): boolean {
  if (typeof record.terminal_at === "string" && record.terminal_at.length > 0) return true;
  return TERMINAL_STATUSES.has((record.status ?? "").toLowerCase());
}

function taskRunEpoch(record: TaskRecord): number | undefined {
  const epoch = record.run_start_epoch;
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : undefined;
}

/** A native revive changes run_start_epoch; fallback/reattach alone does not. */
export function taskHasResumed(record: TaskRecord, previous: TaskState | undefined): boolean {
  if (!previous) return false;
  const epoch = taskRunEpoch(record);
  return epoch !== undefined ? epoch > (previous.epoch ?? 0)
    : previous.epoch === undefined && previous.closed && !isTerminalTask(record);
}

function failed(record: TaskRecord): boolean {
  const status = (record.status ?? "").toLowerCase();
  return status === "error" || status === "failed" || status === "lost";
}

function canceled(record: TaskRecord): boolean {
  return ["cancelled", "canceled", "interrupted"].includes((record.status ?? "").toLowerCase());
}

/** The line the child's own timeline opens with: what was asked, and of whom. */
export function taskSummaryLine(record: TaskRecord): string {
  const parts: string[] = [];
  const headline = record.task_summary ?? record.description;
  if (headline) parts.push(headline);
  const attributes: string[] = [];
  if (record.category) attributes.push(record.category);
  if (record.model) attributes.push(record.model);
  if (attributes.length > 0) parts.push(`(${attributes.join(" · ")})`);
  return parts.length > 0 ? parts.join(" ") : record.task_id;
}

export function taskTitle(record: TaskRecord): string {
  return record.description ?? record.task_summary ?? record.task_id;
}

export interface ChildEventInput {
  record: TaskRecord;
  /** Session id the host knows this provider by, which the child hangs under. */
  parentSessionId: string;
  cwd: string;
  previous: TaskState | undefined;
  transcript?: readonly ProviderTimelineItem[];
}

export interface ChildEventResult {
  events: ProviderEvent[];
  state: TaskState;
}

/**
 * The events one record produces, given what was already published for it.
 *
 * A task first seen in a terminal state still opens before it closes: the panel
 * row is how the run is reachable at all, and a run that finished while nobody
 * was watching is exactly the one worth keeping.
 */
export function taskChildEvents({ record, parentSessionId, cwd, previous, transcript = [] }: ChildEventInput): ChildEventResult {
  const epoch = taskRunEpoch(record);
  // Ignore a stale snapshot instead of settling a newer resumed turn with it.
  if (epoch !== undefined && previous?.epoch !== undefined && epoch < previous.epoch) {
    return { events: [], state: previous };
  }
  const legacyRevival = previous?.closed === true && !isTerminalTask(record)
    && epoch === undefined && previous.epoch === undefined;
  const reopen = taskHasResumed(record, previous);
  const revival = (previous?.legacyRevival ?? 0) + (legacyRevival ? 1 : 0);
  const suffix = epoch !== undefined && epoch > 0 ? `-${epoch}` : revival > 0 ? `-legacy-${revival}` : "";
  const status = (record.status ?? "running").toLowerCase();
  const sessionId = record.task_id;
  const events: ProviderEvent[] = [];
  const state: TaskState = {
    status,
    opened: previous?.opened ?? false,
    closed: reopen ? false : previous?.closed ?? false,
    ...(epoch === undefined ? {} : { epoch }),
    ...(revival > 0 ? { legacyRevival: revival } : {}),
    ...(previous?.transcript ? { transcript: { ...previous.transcript } } : {}),
  };

  // Reannounce the child on each new run. Paseo uses session.opened to publish
  // a running upsert, which also makes a previously archived row visible again.
  if (state.closed) return { events, state };
  // A whole settlement/revival can occur between scans. Release the old host
  // projection before reusing the same child ID; this does not stop native work.
  if (reopen && previous?.opened && !previous.closed) events.push({ type: "session.closed", sessionId });
  if (!state.opened || reopen) {
    events.push({
      type: "session.opened",
      sessionId,
      parentSessionId,
      capabilities: [],
      restoration: "core",
      title: taskTitle(record),
      description: taskSummaryLine(record),
      cwd,
    });
    if (!state.opened) events.push({
      type: "timeline.item",
      sessionId,
      item: { type: "assistant_message", id: `${sessionId}-summary`, text: taskSummaryLine(record) },
    });
    events.push({ type: "session.turn", sessionId, turnId: `${sessionId}-run${suffix}`, state: "started" });
    state.opened = true;
  }

  for (const item of transcript) {
    const fingerprint = createHash("sha256").update(JSON.stringify(item)).digest("hex");
    if (state.transcript?.[item.id] === fingerprint) continue;
    state.transcript ??= {};
    state.transcript[item.id] = fingerprint;
    events.push({ type: "timeline.item", sessionId, item });
  }

  if (state.closed || !isTerminalTask(record)) return { events, state };

  events.push({
    type: "timeline.item",
    sessionId,
    item: {
      type: "assistant_message",
      id: `${sessionId}-result${suffix}`,
      text: failed(record) ? `Task failed (${status})` : `Task ${status}`,
    },
  });
  events.push({
    type: "session.turn",
    sessionId,
    turnId: `${sessionId}-run${suffix}`,
    state: failed(record) ? "failed" : canceled(record) ? "canceled" : "completed",
    ...(failed(record) ? { error: { message: `Task ${status}` } } : {}),
  });
  events.push({ type: "session.closed", sessionId });
  state.closed = true;
  return { events, state };
}

/** Same tree as the background-work readers: `PASEO_OMO_TASK_STATE_DIR` applies here too. */
export function tasksDirectory(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(taskStateDir(cwd, env), "tasks");
}

/** Reads the task records this OmO session spawned. Missing directory = none. */
export async function readTaskRecords(
  cwd: string,
  omoSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskRecord[]> {
  const dir = tasksDirectory(cwd, env);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: TaskRecord[] = [];
  for (const name of names) {
    if (!name.startsWith("st_") || !name.endsWith(".json")) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as TaskRecord;
      if (typeof record.task_id !== "string" || record.task_id.length === 0) continue;
      // Only this session's children: the directory is shared by every session
      // that has ever run in this project.
      if (record.parent_session_id !== omoSessionId) continue;
      records.push(record);
    } catch (error) {
      // A removed record is harmless. A torn/unreadable record is unknown work,
      // so the parent must retain its last state and retry instead of completing.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Cannot read OmO task record ${name}`, { cause: error });
    }
  }
  return records;
}
