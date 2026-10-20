import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { WorkerOutput } from "../../shared/dag.js";
import { splitHarnessWraps } from "../../shared/wrap.js";
import { taskStateDir } from "../task-state.js";
import { getDagSnapshot, type DagStoreOptions } from "./dag-store.js";

const MAX_BYTES = 256 * 1024;
const MAX_TEXT = 24_000;
const MAX_FILES = 4;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Never follow a worker path outside its configured store, including directory symlinks. */
async function checkedPath(root: string, segments: string[]): Promise<string> {
  const canonicalRoot = await realpath(root);
  let current = canonicalRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Worker output path is not a regular path");
  }
  const canonical = await realpath(current);
  const rel = relative(canonicalRoot, canonical);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new Error("Worker output is outside its store");
  return canonical;
}

function visibleText(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripVTControlCharacters(splitHarnessWraps(value).remaining)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
}

/** Bounded plain text only: no prompts, hidden context, reasoning, tool arguments or attachments. */
function messageText(raw: unknown): string[] {
  const entry = object(raw), message = object(entry?.message);
  if (entry?.type !== "message" || !message || message.display === false || message.audience === "model") return [];
  if (message.role !== "assistant" && message.role !== "toolResult") return [];
  const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (!Array.isArray(blocks)) return [];
  const lines: string[] = [];
  for (const rawBlock of blocks) {
    const block = object(rawBlock);
    if (!block || block.display === false || block.audience === "model") continue;
    if (block.type === "text") {
      const text = visibleText(block.text);
      if (text) lines.push(`${message.role === "toolResult" ? "Tool result: " : ""}${text}`);
    } else if (block.type === "toolCall" && typeof block.name === "string") {
      lines.push(`Tool: ${visibleText(block.name).slice(0, 128)}`);
    }
  }
  return lines;
}

export async function readWorkerOutput(options: DagStoreOptions & { sessionId: string; taskId: string }): Promise<WorkerOutput> {
  if (!/^st_[A-Za-z0-9_-]{1,253}$/.test(options.taskId)) throw new Error("Invalid worker ID");
  // Resolve the session and its full descendant tree BEFORE touching any worker output file.
  const snapshot = await getDagSnapshot(options);
  const task = snapshot.tasks.find(task => task.id === options.taskId);
  if (!task) throw new Error("Worker does not belong to this session");
  const store = options.taskStateDir ?? taskStateDir(options.cwd);
  const segments = ["children", options.taskId, "sessions", options.taskId];
  let names: string[] = [], warning: string | undefined, truncated = false;
  try {
    const directory = await checkedPath(store, segments);
    names = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).map(entry => entry.name).sort();
  } catch (error) {
    if (!missing(error)) warning = "Worker transcript could not be read.";
  }
  truncated = names.length > MAX_FILES;
  const lines: string[] = [];
  for (const name of names.slice(-MAX_FILES)) {
    try {
      const file = await checkedPath(store, [...segments, name]);
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("Worker output is not a file");
        const offset = Math.max(0, stat.size - MAX_BYTES);
        const bytes = Buffer.alloc(Math.min(MAX_BYTES, stat.size));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
        let tail = bytes.subarray(0, bytesRead).toString("utf8");
        if (offset > 0) { truncated = true; tail = tail.slice(tail.indexOf("\n") + 1); }
        // A writer may still be appending the final line. Never parse an incomplete JSON record.
        for (const line of tail.split("\n").slice(0, -1)) {
          if (!line.trim()) continue;
          try { lines.push(...messageText(JSON.parse(line))); }
          catch { warning = "Some worker transcript entries could not be read."; }
        }
      } finally { await handle.close(); }
    } catch { warning = "Worker transcript could not be read completely."; }
  }
  // Older/retained tasks may have only a final response after their child transcript is removed.
  const terminal = ["completed", "failed", "error", "cancelled", "interrupted", "lost"].includes(task.status ?? "");
  if ((!lines.length && !warning) || terminal) {
    try {
      const file = await checkedPath(store, ["tasks", `${options.taskId}.json`]);
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if ((await handle.stat()).size > MAX_BYTES) throw new Error("Oversized task record");
        const record = JSON.parse(await handle.readFile("utf8"));
        if (record.task_id !== options.taskId) throw new Error("Worker record changed");
        const final = visibleText(record.final_response);
        if (final && !lines.join("\n\n").slice(-MAX_TEXT).includes(final)) lines.push(final);
      } finally { await handle.close(); }
    } catch (error) { if (!missing(error)) warning = "Saved worker result could not be read."; }
  }
  const text = lines.join("\n\n");
  return { taskId: options.taskId, text: text.slice(-MAX_TEXT), truncated: truncated || text.length > MAX_TEXT,
    ...(warning ? { warning } : {}) };
}
