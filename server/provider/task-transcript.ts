import { open, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";
import { taskStateDir } from "../task-state.js";
import type { TaskRecord } from "./task-watch.js";
import { toolCallDetail, toolResultText } from "./tool-detail.js";
import { visibleTimelineItems } from "./text-wrap.js";

type Json = Record<string, unknown>;
const object = (x: unknown): Json | undefined => typeof x === "object" && x !== null && !Array.isArray(x) ? x as Json : undefined;
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** Only user-visible text; native context-injection blocks are not transcript output. */
function content(value: unknown): Json[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return Array.isArray(value) ? value.map(object).filter((x): x is Json => !!x && x.audience !== "model" && x.display !== false) : [];
}

class TranscriptFile {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private prefix = Buffer.alloc(0);
  private inode: number | undefined;
  private line = 0;
  readonly items = new Map<string, ProviderTimelineItem>();
  private calls = new Map<string, { name: string; args: unknown }>();

  constructor(private readonly key: string) {}

  async read(file: string): Promise<void> {
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      const prefix = Buffer.alloc(Math.min(128, stat.size));
      await handle.read(prefix, 0, prefix.length, 0);
      if (this.inode !== stat.ino || stat.size < this.offset || !prefix.subarray(0, this.prefix.length).equals(this.prefix)) {
        this.offset = 0; this.pending = Buffer.alloc(0); this.line = 0; this.items.clear(); this.calls.clear();
      }
      this.inode = stat.ino; this.prefix = prefix;
      while (this.offset < stat.size) {
        const buffer = Buffer.alloc(Math.min(65_536, stat.size - this.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const bytes = Buffer.concat([this.pending, buffer.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = bytes.indexOf(10, start); end >= 0; end = bytes.indexOf(10, start)) {
          this.line += 1;
          const line = bytes.subarray(start, end).toString("utf8"); start = end + 1;
          if (!line.trim()) continue;
          try { this.accept(JSON.parse(line)); }
          catch {
            const id = `${this.key}-invalid-${this.line}`;
            this.items.set(id, { type: "error", id, message: "A worker transcript entry could not be read." });
          }
        }
        this.pending = Buffer.from(bytes.subarray(start));
      }
    } finally { await handle.close(); }
  }

  private accept(raw: unknown): void {
    const entry = object(raw);
    const message = object(entry?.message);
    if (entry?.type !== "message" || !message || message.display === false) return;
    const blocks = content(message.content);
    const entryId = typeof entry.id === "string" ? entry.id : `line-${this.line}`;
    if (message.role === "assistant") {
      blocks.forEach((block, index) => {
        const id = `${this.key}-${entryId}-${index}`;
        if (block.type === "text" && typeof block.text === "string") {
          for (const item of visibleTimelineItems("assistant", id, block.text)) this.items.set(item.id, item);
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
          this.items.set(id, { type: "reasoning", id, text: block.thinking });
        } else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          this.calls.set(block.id, { name: block.name, args: block.arguments });
          const toolId = `${this.key}-tool-${block.id}`;
          this.items.set(toolId, { type: "tool_call", id: toolId, callId: toolId, name: block.name,
            detail: toolCallDetail(block.name, block.arguments), status: "running", error: null });
        }
      });
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const known = this.calls.get(message.toolCallId);
      const name = known?.name ?? (typeof message.toolName === "string" ? message.toolName : "tool");
      const output = toolResultText({ content: blocks });
      const id = `${this.key}-tool-${message.toolCallId}`;
      this.items.set(id, { type: "tool_call", id, callId: id, name, detail: toolCallDetail(name, known?.args, output),
        ...(message.isError === true ? { status: "failed" as const, error: output ?? "Tool call failed" } : { status: "completed" as const, error: null }) });
    }
  }
}

/** Reads persisted worker messages incrementally; never attaches to or prompts the worker. */
export class TaskTranscriptReader {
  private readonly files = new Map<string, TranscriptFile>();

  async read(cwd: string, record: TaskRecord, env: NodeJS.ProcessEnv): Promise<ProviderTimelineItem[]> {
    if (!/^st_[a-zA-Z0-9_-]+$/.test(record.task_id)) throw new Error("Invalid task id");
    const dir = join(taskStateDir(cwd, env), "children", record.task_id, "sessions", record.task_id);
    let entries: Dirent[];
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (!missing(error)) throw error; entries = []; }
    const items: ProviderTimelineItem[] = [];
    for (const entry of entries.filter(e => e.isFile() && e.name.endsWith(".jsonl")).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      let file = this.files.get(path);
      if (!file) { file = new TranscriptFile(`${record.task_id}-${entry.name}`); this.files.set(path, file); }
      try { await file.read(path); }
      catch (error) { if (!missing(error)) throw error; continue; }
      items.push(...file.items.values());
    }
    // Older/in-process workers may only have the persisted terminal response.
    if (items.length === 0 && typeof record.final_response === "string" && record.final_response.trim()) {
      items.push(...visibleTimelineItems("assistant", `${record.task_id}-final`, record.final_response));
    }
    return items;
  }
}
